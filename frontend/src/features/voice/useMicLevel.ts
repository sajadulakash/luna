import { useCallback, useEffect, useRef } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';

/**
 * Microphone loudness, for the orb.
 *
 * Speech recognition tells us *what* was said but never how loudly, so the
 * level comes from a separate `getUserMedia` stream feeding an AnalyserNode.
 *
 * Desktop browsers mix two consumers of one microphone happily. Mobile ones
 * do not: the second stream starves the recogniser, which then starts, hears
 * silence, times out with `no-speech` and restarts — forever, and without
 * ever raising an error, because an empty session is indistinguishable from
 * someone choosing not to speak. So the meter is a desktop-only enhancement.
 * A pulsing orb is not worth trading working speech input for.
 *
 * Only ever reads the signal. Nothing here is recorded or sent anywhere.
 */

/**
 * Whether a second microphone consumer is safe here.
 *
 * A coarse pointer is a proxy for "mobile browser", not the cause — the real
 * constraint is exclusive microphone access. It is the same heuristic the
 * composer uses to decide whether a hardware keyboard is present.
 */
function canShareMicrophone(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return !window.matchMedia('(pointer: coarse)').matches;
}
export function useMicLevel() {
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const startingRef = useRef(false);

  const stop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;

    startingRef.current = false;
    useVoiceStore.getState().setAmplitude(0);
  }, []);

  const start = useCallback(async () => {
    if (streamRef.current || startingRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia) return;
    // The recogniser gets the microphone to itself where it has to.
    if (!canShareMicrophone()) return;

    startingRef.current = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const Ctor = window.AudioContext;
      if (!Ctor) return;

      const ctx = new Ctor();
      ctxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      // Deliberately not connected to ctx.destination — that would feed the
      // microphone straight back out of the speakers.

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
    } catch {
      // Permission denied, or no input device. The recogniser reports the
      // real error; the meter just stays flat.
      stop();
    } finally {
      startingRef.current = false;
    }
  }, [stop]);

  useEffect(() => stop, [stop]);

  return { start, stop };
}
