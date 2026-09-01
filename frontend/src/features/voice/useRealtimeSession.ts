import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../../api/meetings';
import { viewerZone } from '../../lib/datetime';
import {
  createRealtimeSession,
  exchangeRealtimeSdp,
  runRealtimeTool,
  saveRealtimeTranscript,
} from '../../api/voice';
import { isLive, useVoiceStore } from '../../stores/voiceStore';

/**
 * One live voice conversation, over WebRTC.
 *
 * This replaces the old record-upload-transcribe-reply-synthesise pipeline
 * entirely. There is no MediaRecorder, no audio upload and no MP3 playback,
 * because there are no longer three models taking turns: one model hears the
 * microphone and speaks back over the same connection, the way ChatGPT's
 * voice mode does.
 *
 * What that buys, and why it is worth the WebRTC machinery: the model hears
 * tone and pacing rather than a transcript of them, it decides when a turn has
 * ended instead of us guessing from a silence timer, and interrupting it is
 * simply talking — no button to hold, no round-trip to notice.
 *
 * WebRTC rather than a WebSocket because the browser's own audio stack then
 * handles capture, jitter buffering, echo cancellation and playback. Over a
 * WebSocket all of that would be ours to write, badly.
 */

/** OpenAI streams events over a data channel with this exact name. */
const EVENT_CHANNEL = 'oai-events';

/**
 * How long the microphone stays live after the button is released.
 *
 * Audio travels over RTP and the commit that ends the turn travels over the
 * data channel — two different transports, with no ordering between them. Cut
 * the microphone the instant the button comes up and the commit can overtake
 * the last packets of your own sentence, clipping the final word. This is the
 * grace period that lets the audio land first.
 */
const RELEASE_TAIL_MS = 250;

/** Shorter than this is a mis-tap, and committing it errors on an empty buffer. */
const MIN_HOLD_MS = 200;

export type VoiceAvailability = 'ok' | 'unsupported' | 'insecure';

/**
 * Whether voice can run at all, decided before anything is offered.
 *
 * The microphone needs a secure context. `localhost` is exempt; a LAN address
 * over plain HTTP is not, which is the usual reason this fails on a phone.
 */
export function voiceAvailability(): VoiceAvailability {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  if (typeof RTCPeerConnection === 'undefined') return 'unsupported';
  return 'ok';
}

export interface RealtimeSessionOptions {
  /** The owner's access token, for the three authorised calls. */
  token: string | null;
  /** A finished turn, once it has been written down. Appends it to the chat. */
  onTurn?: (role: 'user' | 'assistant', content: string) => void;
}

export function useRealtimeSession({ token, onTurn }: RealtimeSessionOptions) {
  const queryClient = useQueryClient();

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const remoteAnalyserRef = useRef<AnalyserNode | null>(null);

  /** Luna's transcript for the turn being spoken, accumulated from deltas. */
  const replyRef = useRef('');
  /** Guards against a stop() racing an in-flight connect. */
  const generationRef = useRef(0);

  /** When the current hold began, for rejecting mis-taps. */
  const holdStartRef = useRef(0);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tokenRef = useRef(token);
  tokenRef.current = token;
  const onTurnRef = useRef(onTurn);
  onTurnRef.current = onTurn;

  // --- Level metering ------------------------------------------------------

  const stopMeter = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    useVoiceStore.getState().setAmplitude(0);
  }, []);

  /**
   * Drives the orb from whichever side of the call is making sound.
   *
   * One loop reading two analysers rather than two loops: while Luna speaks
   * the microphone is still open (it has to be, or she could not be
   * interrupted), so both are live at once and the state decides which one
   * the orb is showing.
   */
  const startMeter = useCallback(() => {
    if (rafRef.current !== null) return;

    const read = (
      analyser: AnalyserNode | null,
      data: Uint8Array<ArrayBuffer>,
    ): number => {
      if (!analyser) return 0;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const sample of data) {
        const centred = (sample - 128) / 128;
        sum += centred * centred;
      }
      return Math.sqrt(sum / data.length);
    };

    const buffer = new Uint8Array(256);
    let smoothed = 0;

    const tick = () => {
      const store = useVoiceStore.getState();
      const source =
        store.state === 'speaking' ? remoteAnalyserRef.current : micAnalyserRef.current;
      const gain = store.state === 'speaking' ? 3 : 4;

      const level = Math.min(1, read(source, buffer) * gain);
      // Smoothed, or the orb jitters on every consonant.
      smoothed = smoothed * 0.75 + level * 0.25;
      store.setAmplitude(smoothed);

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, []);

  // --- Sending -------------------------------------------------------------

  const send = useCallback((event: Record<string, unknown>) => {
    const channel = channelRef.current;
    if (channel?.readyState === 'open') channel.send(JSON.stringify(event));
  }, []);

  // --- Teardown ------------------------------------------------------------

  const stop = useCallback(() => {
    generationRef.current += 1;

    if (releaseTimerRef.current !== null) clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = null;

    stopMeter();

    channelRef.current?.close();
    channelRef.current = null;

    pcRef.current?.getSenders().forEach((sender) => sender.track?.stop());
    pcRef.current?.close();
    pcRef.current = null;

    micRef.current?.getTracks().forEach((track) => track.stop());
    micRef.current = null;

    const el = audioRef.current;
    if (el) {
      el.pause();
      el.srcObject = null;
    }

    micAnalyserRef.current = null;
    remoteAnalyserRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;

    replyRef.current = '';
    useVoiceStore.getState().reset();
  }, [stopMeter]);

  // --- Turns ---------------------------------------------------------------

  /** Persists a finished turn and puts it in the chat, best effort. */
  const commitTurn = useCallback(
    (role: 'user' | 'assistant', content: string) => {
      const text = content.trim();
      if (!text) return;

      saveRealtimeTranscript(role, text, tokenRef.current)
        .then(() => onTurnRef.current?.(role, text))
        .catch(() => {
          // A transcript that failed to save is not worth interrupting a live
          // conversation over — show it in the chat anyway, unsaved.
          onTurnRef.current?.(role, text);
        });
    },
    [],
  );

  /**
   * Runs a tool the model asked for and hands back the result.
   *
   * The reply is not resumed automatically after a tool call, so the explicit
   * `response.create` is what makes Luna say what she found. Without it she
   * runs the tool and then sits in silence.
   */
  const handleToolCall = useCallback(
    async (callId: string, name: string, argumentsJson: string) => {
      let payload: unknown;

      try {
        const { result, calendar_changed } = await runRealtimeTool(
          name,
          argumentsJson,
          viewerZone(),
          tokenRef.current,
        );
        payload = result;
        if (calendar_changed) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.allMeetings });
        }
      } catch (cause) {
        // Handed to the model rather than thrown: she can then say what went
        // wrong, instead of the conversation dying mid-sentence.
        payload = {
          ok: false,
          error: cause instanceof Error ? cause.message : 'That did not work.',
        };
      }

      send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify(payload),
        },
      });
      send({ type: 'response.create' });
    },
    [queryClient, send],
  );

  // --- Push to talk --------------------------------------------------------

  /**
   * Opens the microphone for as long as the button is held.
   *
   * Pressing while Luna is speaking cancels her mid-sentence — the button is
   * how you interrupt, now that nothing is listening for you to do it by
   * talking over her.
   */
  const startTalking = useCallback(() => {
    const store = useVoiceStore.getState();
    if (!isLive(store.state)) return;

    if (releaseTimerRef.current !== null) {
      clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }

    if (store.state === 'speaking' || store.state === 'thinking') {
      send({ type: 'response.cancel' });
    }

    // Drop whatever silence accumulated since the last turn, so the commit
    // carries your sentence and nothing else.
    send({ type: 'input_audio_buffer.clear' });

    const track = micRef.current?.getAudioTracks()[0];
    if (track) track.enabled = true;

    holdStartRef.current = performance.now();
    store.dispatch('SPEECH_STARTED');
  }, [send]);

  /** Closes the microphone and hands the turn over. */
  const stopTalking = useCallback(() => {
    const store = useVoiceStore.getState();
    if (store.state !== 'capturing') return;

    const held = performance.now() - holdStartRef.current;

    const finish = () => {
      releaseTimerRef.current = null;
      const track = micRef.current?.getAudioTracks()[0];
      if (track) track.enabled = false;

      if (held < MIN_HOLD_MS) {
        // A mis-tap. Throw it away rather than committing a buffer too short
        // for the API to accept.
        send({ type: 'input_audio_buffer.clear' });
        useVoiceStore.getState().dispatch('ERROR');
        return;
      }

      send({ type: 'input_audio_buffer.commit' });
      send({ type: 'response.create' });
      useVoiceStore.getState().dispatch('SPEECH_STOPPED');
    };

    releaseTimerRef.current = setTimeout(finish, RELEASE_TAIL_MS);
  }, [send]);

  // --- Incoming events -----------------------------------------------------

  const handleEvent = useCallback(
    (event: Record<string, unknown>) => {
      const store = useVoiceStore.getState();
      const type = typeof event.type === 'string' ? event.type : '';

      switch (type) {
        // The user started talking. From `speaking` this is barge-in: the
        // model stops itself, so nothing here has to silence her.
        case 'input_audio_buffer.speech_started':
          store.dispatch('SPEECH_STARTED');
          break;

        case 'input_audio_buffer.speech_stopped':
          store.dispatch('SPEECH_STOPPED');
          break;

        // What the model heard, in text, once the turn closed.
        case 'conversation.item.input_audio_transcription.completed': {
          const text = typeof event.transcript === 'string' ? event.transcript : '';
          if (text.trim()) {
            store.setUserTranscript(text.trim());
            commitTurn('user', text);
          }
          break;
        }

        case 'response.created':
          store.dispatch('RESPONSE_STARTED');
          break;

        // Luna's words, arriving as she says them.
        case 'response.output_audio_transcript.delta': {
          const delta = typeof event.delta === 'string' ? event.delta : '';
          if (delta) {
            // The first audio and the first transcript land together, so this
            // doubles as the cue that she has started speaking.
            store.dispatch('FIRST_AUDIO');
            replyRef.current += delta;
            store.appendLunaTranscript(delta);
          }
          break;
        }

        case 'response.output_audio_transcript.done': {
          const text = typeof event.transcript === 'string' ? event.transcript : '';
          replyRef.current = text || replyRef.current;
          break;
        }

        case 'response.function_call_arguments.done': {
          const callId = typeof event.call_id === 'string' ? event.call_id : '';
          const name = typeof event.name === 'string' ? event.name : '';
          const args = typeof event.arguments === 'string' ? event.arguments : '{}';
          if (callId && name) void handleToolCall(callId, name, args);
          break;
        }

        case 'response.done': {
          const spoken = replyRef.current;
          replyRef.current = '';
          if (spoken.trim()) commitTurn('assistant', spoken);
          // A response that only called a tool produces no audio; the reply
          // proper arrives in the next response, so don't drop out of the
          // turn on that one.
          if (spoken.trim()) store.dispatch('AUDIO_END');
          break;
        }

        case 'error': {
          const detail = event.error;
          const message =
            typeof detail === 'object' &&
            detail !== null &&
            typeof (detail as { message?: unknown }).message === 'string'
              ? (detail as { message: string }).message
              : 'Something went wrong on the voice connection.';
          store.setError(message);
          store.dispatch('ERROR');
          break;
        }
      }
    },
    [commitTurn, handleToolCall],
  );

  // --- Connect -------------------------------------------------------------

  const start = useCallback(async () => {
    const store = useVoiceStore.getState();
    if (store.state !== 'idle') return;

    store.setError(null);
    store.dispatch('CONNECT');

    const generation = ++generationRef.current;
    const live = () => generationRef.current === generation;

    try {
      // 1. The microphone, from inside the tap that asked for it. Mobile
      //    browsers refuse getUserMedia outside a user gesture.
      let mic: MediaStream;
      try {
        mic = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch {
        const s = useVoiceStore.getState();
        s.setPermission('denied');
        s.setError('I need microphone access to talk. You can still type to me.');
        s.dispatch('ERROR');
        return;
      }
      if (!live()) {
        mic.getTracks().forEach((t) => t.stop());
        return;
      }
      micRef.current = mic;
      useVoiceStore.getState().setPermission('granted');

      // 2. A session, configured entirely on our server.
      const session = await createRealtimeSession(viewerZone(), tokenRef.current);
      if (!live()) return;

      // 3. The peer connection.
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const track = mic.getAudioTracks()[0]!;
      // Muted until the button is held. The connection is open the whole time,
      // but a muted track transmits silence — so a room full of other people
      // talking reaches nothing and costs nothing.
      track.enabled = false;
      pc.addTrack(track, mic);

      // Luna's voice, played through a detached element. Not appended to the
      // document: it needs no controls and nothing should be able to style it.
      const el = audioRef.current ?? new Audio();
      el.autoplay = true;
      audioRef.current = el;

      pc.ontrack = (event) => {
        const [remote] = event.streams;
        if (!remote) return;
        el.srcObject = remote;
        void el.play().catch(() => {
          useVoiceStore
            .getState()
            .setError('Tap once more to let Luna play sound.');
        });

        // Metering taps both directions once the far side is attached.
        const Ctor = window.AudioContext;
        if (!Ctor) return;
        const ctx = ctxRef.current ?? new Ctor();
        ctxRef.current = ctx;
        void ctx.resume();

        const makeAnalyser = (stream: MediaStream) => {
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          ctx.createMediaStreamSource(stream).connect(analyser);
          // Never connected to ctx.destination: the element is already
          // playing this, and echoing it would double it.
          return analyser;
        };

        remoteAnalyserRef.current = makeAnalyser(remote);
        if (micRef.current) micAnalyserRef.current = makeAnalyser(micRef.current);
        startMeter();
      };

      pc.onconnectionstatechange = () => {
        if (!live()) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          const s = useVoiceStore.getState();
          s.setError('The voice connection dropped.');
          s.dispatch('ERROR');
          stop();
        }
      };

      // 4. The event channel, opened before the offer so it is negotiated
      //    into it.
      const channel = pc.createDataChannel(EVENT_CHANNEL);
      channelRef.current = channel;

      channel.onopen = () => {
        if (!live()) return;
        useVoiceStore.getState().dispatch('READY');

        // She speaks first. Connecting to silence gives no sign the line is
        // even open, and leaves you talking into a void wondering.
        send({
          type: 'response.create',
          response: { instructions: session.greeting },
        });
      };
      channel.onmessage = (message) => {
        if (!live()) return;
        try {
          handleEvent(JSON.parse(message.data as string));
        } catch {
          // A frame we can't parse is not worth ending a call over.
        }
      };

      // 5. Offer, exchange, answer.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const answer = await exchangeRealtimeSdp(offer.sdp ?? '', session.client_secret);
      if (!live()) return;

      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    } catch (cause) {
      if (!live()) return;
      const s = useVoiceStore.getState();
      s.setError(
        cause instanceof Error ? cause.message : "I couldn't start voice mode.",
      );
      s.dispatch('ERROR');
      stop();
    }
  }, [handleEvent, send, startMeter, stop]);

  useEffect(() => stop, [stop]);

  return { start, stop, startTalking, stopTalking };
}
