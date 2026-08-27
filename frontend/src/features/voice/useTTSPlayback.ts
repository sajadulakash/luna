import { useCallback, useEffect, useRef } from 'react';
import { API_BASE_URL } from '../../lib/env';
import { useVoiceStore } from '../../stores/voiceStore';

/**
 * TTS playback and barge-in (§9).
 *
 * `POST /api/voice/tts` returns audio/mpeg. Provider streams are collected
 * into one complete Blob before playback: arbitrary MP3 network chunks are not
 * valid MediaSource segments and fail silently in several browsers.
 *
 * Barge-in is the point of this hook. `stop()` must be synchronous: it pauses
 * the element and drops the buffer in the same tick it is called, so an
 * interruption is audible inside 200ms.
 */

export function useTTSPlayback() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  /** A media element can only ever be connected to one source node. */
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);

  const getAudio = useCallback((): HTMLAudioElement => {
    if (!audioRef.current) {
      const el = new Audio();
      el.preload = 'auto';
      el.crossOrigin = 'use-credentials';
      audioRef.current = el;
    }
    return audioRef.current;
  }, []);

  const releaseUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const stopMeter = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    useVoiceStore.getState().setAmplitude(0);
  }, []);

  /** Drives the orb's pulse from the audio actually coming out. */
  const startMeter = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;

    const data = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      analyser.getByteTimeDomainData(data);

      let sum = 0;
      for (const sample of data) {
        const centred = (sample - 128) / 128;
        sum += centred * centred;
      }
      const rms = Math.sqrt(sum / data.length);

      useVoiceStore.getState().setAmplitude(Math.min(1, rms * 3));
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, []);

  /**
   * Stops playback immediately.
   *
   * Called on barge-in, on disarm and on unmount. Everything it does is
   * synchronous — no awaits before the pause.
   */
  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    const el = audioRef.current;
    if (el) {
      el.pause();
      // Dropping the source as well as pausing: a paused element with a live
      // MediaSource still holds the decoded buffer.
      el.removeAttribute('src');
      el.load();
    }

    releaseUrl();
    stopMeter();
  }, [releaseUrl, stopMeter]);

  /**
   * Unlocks audio on a user gesture.
   *
   * Mobile browsers refuse programmatic playback until the page has played
   * something from within a real interaction, so this is called from the tap
   * that arms the mic.
   */
  const prime = useCallback(() => {
    const el = getAudio();

    if (!audioCtxRef.current) {
      const Ctor = window.AudioContext;
      if (Ctor) {
        const ctx = new Ctor();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;

        try {
          const source = ctx.createMediaElementSource(el);
          source.connect(analyser);
          analyser.connect(ctx.destination);
          sourceRef.current = source;
          analyserRef.current = analyser;
          audioCtxRef.current = ctx;
        } catch {
          // Already connected, or the context was refused. Playback still
          // works; only the amplitude meter is lost.
          void ctx.close();
        }
      }
    }

    void audioCtxRef.current?.resume();
  }, [getAudio]);

  /** Streams `text` as speech. Resolves when playback ends or is interrupted. */
  const speak = useCallback(
    async (text: string, token: string | null): Promise<void> => {
      stop();

      const controller = new AbortController();
      abortRef.current = controller;

      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (token) headers.set('Authorization', `Bearer ${token}`);

      const res = await fetch(`${API_BASE_URL}/api/voice/tts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text }),
        credentials: 'include',
        signal: controller.signal,
      });

      if (!res.ok || !res.body) throw new Error(`TTS failed: ${res.status}`);

      const el = getAudio();
      const store = useVoiceStore.getState();

      const onFirstAudio = () => {
        if (useVoiceStore.getState().state === 'thinking') {
          store.dispatch('FIRST_AUDIO');
        }
        void audioCtxRef.current?.resume();
        startMeter();
      };

      const blob = await res.blob();
      if (controller.signal.aborted) return;
      if (blob.size === 0) throw new Error('The voice response was empty.');

      releaseUrl();
      objectUrlRef.current = URL.createObjectURL(blob);
      el.src = objectUrlRef.current;
      await el.play();
      onFirstAudio();

      await waitForEnd(el, controller.signal);
      stopMeter();
    },
    [getAudio, releaseUrl, startMeter, stop, stopMeter],
  );

  useEffect(() => {
    return () => {
      stop();
      sourceRef.current?.disconnect();
      analyserRef.current?.disconnect();
      void audioCtxRef.current?.close();
      audioCtxRef.current = null;
    };
  }, [stop]);

  return { speak, stop, prime };
}

function waitForEnd(el: HTMLAudioElement, signal: AbortSignal): Promise<void> {
  if (el.ended || el.paused) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const finish = () => {
      el.removeEventListener('ended', finish);
      el.removeEventListener('error', finish);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    el.addEventListener('ended', finish);
    el.addEventListener('error', finish);
    signal.addEventListener('abort', finish);
  });
}
