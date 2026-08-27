import { useCallback, useEffect, useRef } from 'react';
import { transcribeAudio } from '../../api/voice';
import { useVoiceStore } from '../../stores/voiceStore';

/**
 * Recording, metering and transcription — one microphone, one owner.
 *
 * This replaces the browser's own `SpeechRecognition`, which was Chrome and
 * Edge only, depended on a reachable Google speech service, and could not
 * share the microphone on mobile: a second `getUserMedia` for the orb's level
 * meter starved it, so it heard silence and restarted forever.
 *
 * Here the stream is acquired once and used for both jobs. `MediaRecorder`
 * works in every current browser, so voice runs on Safari and Firefox too, and
 * the audio is transcribed by a real model server-side.
 *
 * The trade is that there is no live partial transcript any more: the words
 * arrive once, when the recording is transcribed, rather than growing as you
 * speak.
 */

/** Below this a recording is a stray tap, not speech. */
const MIN_RECORDING_BYTES = 1_200;

/** Ordered by preference. Safari only does mp4; everything else does webm. */
const FORMATS: Array<{ mimeType: string; extension: string }> = [
  { mimeType: 'audio/webm;codecs=opus', extension: 'webm' },
  { mimeType: 'audio/webm', extension: 'webm' },
  { mimeType: 'audio/mp4', extension: 'mp4' },
  { mimeType: 'audio/ogg;codecs=opus', extension: 'ogg' },
];

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
  if (typeof MediaRecorder === 'undefined') return 'unsupported';
  return 'ok';
}

function pickFormat(): { mimeType: string; extension: string } {
  for (const format of FORMATS) {
    if (MediaRecorder.isTypeSupported(format.mimeType)) return format;
  }
  // Let the browser choose, and guess the extension. Rare.
  return { mimeType: '', extension: 'webm' };
}

export interface VoiceCaptureOptions {
  /** A finished utterance, transcribed. Send it. */
  onUtterance: (text: string) => void;
  /** The owner's access token, for the transcription request. */
  token: string | null;
}

export function useVoiceCapture({ onUtterance, token }: VoiceCaptureOptions) {
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const acquiringRef = useRef<Promise<MediaStream | null> | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;
  const tokenRef = useRef(token);
  tokenRef.current = token;

  // --- Level meter, from the recording stream itself -----------------------

  const stopMeter = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    useVoiceStore.getState().setAmplitude(0);
  }, []);

  const startMeter = useCallback((stream: MediaStream) => {
    if (rafRef.current !== null) return;

    const Ctor = window.AudioContext;
    if (!Ctor) return;

    const ctx = ctxRef.current ?? new Ctor();
    ctxRef.current = ctx;
    void ctx.resume();

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    // Not connected to ctx.destination — that would echo the microphone
    // straight back out of the speakers.

    const data = new Uint8Array(analyser.frequencyBinCount);
    let smoothed = 0;

    const tick = () => {
      analyser.getByteTimeDomainData(data);

      let sum = 0;
      for (const sample of data) {
        const centred = (sample - 128) / 128;
        sum += centred * centred;
      }
      const rms = Math.sqrt(sum / data.length);
      // Smoothed, or the orb jitters on every consonant.
      smoothed = smoothed * 0.75 + Math.min(1, rms * 4) * 0.25;

      const state = useVoiceStore.getState();
      // While Luna is speaking, playback owns the amplitude.
      if (state.state === 'armed' || state.state === 'capturing') {
        state.setAmplitude(smoothed);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, []);

  // --- Microphone ----------------------------------------------------------

  /**
   * Gets the microphone, once.
   *
   * Held open between presses rather than re-acquired each time: acquisition
   * costs a few hundred milliseconds on a phone, long enough to clip the first
   * word off every request.
   */
  const acquire = useCallback(async (): Promise<MediaStream | null> => {
    if (streamRef.current?.active) return streamRef.current;
    if (acquiringRef.current) return acquiringRef.current;

    const pending = (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        useVoiceStore.getState().setPermission('granted');
        startMeter(stream);
        return stream;
      } catch {
        const store = useVoiceStore.getState();
        store.setPermission('denied');
        store.setError(
          'I need microphone access to listen. You can still type to me.',
        );
        store.reset();
        return null;
      } finally {
        acquiringRef.current = null;
      }
    })();

    acquiringRef.current = pending;
    return pending;
  }, [startMeter]);

  const release = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      try {
        recorder.stop();
      } catch {
        // Already stopped.
      }
    }
    chunksRef.current = [];

    stopMeter();
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, [stopMeter]);

  // --- Transcription -------------------------------------------------------

  const handleRecording = useCallback(async (blob: Blob, extension: string) => {
    const store = useVoiceStore.getState();

    // Too small to be speech — a stray tap. Back to ready without spending a
    // transcription on it.
    if (blob.size < MIN_RECORDING_BYTES) {
      store.dispatch('RELEASE');
      return;
    }

    // capturing -> thinking. Fails if something already moved the machine on.
    if (!store.dispatch('SILENCE_2S')) return;

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const text = await transcribeAudio({
        blob,
        filename: `speech.${extension}`,
        token: tokenRef.current,
        signal: controller.signal,
      });

      if (controller.signal.aborted) return;

      if (!text) {
        // Heard, but nothing intelligible in it.
        useVoiceStore.getState().dispatch('ERROR');
        return;
      }

      const current = useVoiceStore.getState();
      current.clearCaptured();
      current.appendCaptured(text);
      onUtteranceRef.current(text);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      const current = useVoiceStore.getState();
      current.setError(
        cause instanceof Error ? cause.message : "I couldn't make that out.",
      );
      current.dispatch('ERROR');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  // --- Recording -----------------------------------------------------------

  const startRecording = useCallback(async () => {
    const stream = await acquire();
    if (!stream) return;

    startMeter(stream);
    if (recorderRef.current && recorderRef.current.state === 'recording') return;

    const format = pickFormat();
    const recorder = format.mimeType
      ? new MediaRecorder(stream, { mimeType: format.mimeType })
      : new MediaRecorder(stream);

    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, {
        type: format.mimeType || 'audio/webm',
      });
      chunksRef.current = [];
      void handleRecording(blob, format.extension);
    };

    recorderRef.current = recorder;
    try {
      recorder.start();
    } catch {
      recorderRef.current = null;
      const store = useVoiceStore.getState();
      store.setError("I couldn't start recording. You can still type to me.");
      store.reset();
    }
  }, [acquire, handleRecording, startMeter]);

  /** Ends the recording. Transcription follows from the recorder's onstop. */
  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder || recorder.state === 'inactive') {
      useVoiceStore.getState().dispatch('RELEASE');
      return;
    }
    try {
      recorder.stop();
    } catch {
      useVoiceStore.getState().dispatch('RELEASE');
    }
  }, []);

  useEffect(() => release, [release]);

  return { acquire, startRecording, stopRecording, release };
}
