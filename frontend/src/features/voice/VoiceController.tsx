import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useVoiceCapture, voiceAvailability } from './useVoiceCapture';
import { useTTSPlayback } from './useTTSPlayback';

/**
 * Wires the hooks to the store. Renders nothing.
 *
 * All the browser objects — the microphone, the recorder, the audio element —
 * hang off this component, so the store stays a pure state machine and the UI
 * stays a pure function of it.
 */

export interface VoiceControllerHandle {
  /** Turn voice on or off. Backs the composer orb's tap. */
  toggle: () => void;
  /** Speak Luna's reply. Called when the final assistant message lands. */
  speak: (text: string) => void;
  startHold: () => void;
  endHold: () => void;
}

interface VoiceControllerProps {
  /** A complete request captured during one press. Send it to the chat. */
  onUtterance: (text: string) => void;
  /** The owner's access token, for the speech requests. */
  token: string | null;
  /** True while a reply is streaming. */
  streaming: boolean;
}

export const VoiceController = forwardRef<VoiceControllerHandle, VoiceControllerProps>(
  function VoiceController({ onUtterance, token, streaming }, ref) {
    const tts = useTTSPlayback();
    const capture = useVoiceCapture({ onUtterance, token });

    const ttsRef = useRef(tts);
    ttsRef.current = tts;
    const captureRef = useRef(capture);
    captureRef.current = capture;

    // --- Support detection ---------------------------------------------------

    useEffect(() => {
      const availability = voiceAvailability();
      const store = useVoiceStore.getState();

      store.setSupported(availability === 'ok');

      if (availability === 'insecure') {
        store.setError(
          'Voice needs a secure connection. Open this over HTTPS, or on ' +
            'localhost, and the microphone will work. Chat works either way.',
        );
      } else if (availability === 'unsupported') {
        store.setError('This browser cannot record audio. Chat still works.');
      }
    }, []);

    // The microphone is never taken on page load. It is asked for on the tap
    // that turns voice on, which is both less alarming and the only thing
    // mobile browsers will honour — a getUserMedia outside a user gesture is
    // refused, and used to leave the machine armed with nothing behind it.

    // --- Barge-in ------------------------------------------------------------

    useEffect(() => {
      let previous = useVoiceStore.getState().state;

      return useVoiceStore.subscribe((state) => {
        const current = state.state;
        if (current === previous) return;

        const from = previous;
        // Committed before the side effects below, not after: stopping
        // playback writes to the store, which re-enters this subscriber. With
        // a stale marker that recursion never terminates.
        previous = current;

        // Any exit from speaking silences her — speaking → capturing is the
        // interruption proper, and it must be audible within a frame.
        if (from === 'speaking' || current === 'idle') {
          ttsRef.current.stop();
        }
      });
    }, []);

    // --- Stream failures put the machine back to waiting ----------------------

    const wasStreaming = useRef(streaming);
    useEffect(() => {
      const store = useVoiceStore.getState();

      if (wasStreaming.current && !streaming && store.state === 'thinking') {
        // The stream finished without producing audio — an error, or a reply
        // that arrived while voice wasn't the input. Go back to listening.
        store.dispatch('ERROR');
      }

      wasStreaming.current = streaming;
    }, [streaming]);

    // --- Imperative surface ---------------------------------------------------

    const toggle = useCallback(() => {
      const store = useVoiceStore.getState();

      if (store.state === 'idle') {
        // Unlock audio inside the tap: mobile browsers refuse programmatic
        // playback otherwise.
        ttsRef.current.prime();
        store.setError(null);
        store.dispatch('ARM');
        // Warm the microphone now so the first press records instantly rather
        // than clipping its opening word.
        void captureRef.current.acquire();
        return;
      }

      captureRef.current.release();
      ttsRef.current.stop();
      store.reset();
    }, []);

    const speak = useCallback(
      (text: string) => {
        const store = useVoiceStore.getState();
        // Only speak when the turn came from voice.
        if (store.state !== 'thinking') return;

        ttsRef.current.speak(text, token).catch((cause: unknown) => {
          const current = useVoiceStore.getState();
          current.setError(
            cause instanceof Error
              ? cause.message
              : "I couldn't play Luna's voice response.",
          );
          current.dispatch('ERROR');
        });
      },
      [token],
    );

    const startHold = useCallback(() => {
      ttsRef.current.prime();

      // Read through a getter rather than a snapshot: every dispatch replaces
      // the state object, so a value captured before one reports the old state.
      const store = () => useVoiceStore.getState();
      store().setHolding(true);

      if (store().state === 'idle') {
        store().dispatch('ARM');
      } else if (store().state === 'speaking') {
        store().dispatch('BARGE_IN');
      }

      // The press is what starts a turn, so the orb goes live on the press.
      if (store().state === 'armed') {
        store().dispatch('WAKE_WORD');
      }

      // Not while thinking: a press during a reply is not a new recording.
      if (store().state === 'capturing') {
        void captureRef.current.startRecording();
      }
    }, []);

    const endHold = useCallback(() => {
      const store = useVoiceStore.getState();
      store.setHolding(false);
      if (store.state === 'capturing') captureRef.current.stopRecording();
    }, []);

    useImperativeHandle(
      ref,
      () => ({ toggle, speak, startHold, endHold }),
      [endHold, speak, startHold, toggle],
    );

    // --- Spacebar hold-to-talk ------------------------------------------------

    useEffect(() => {
      const isTyping = (target: EventTarget | null) =>
        target instanceof HTMLElement &&
        (target.tagName === 'TEXTAREA' ||
          target.tagName === 'INPUT' ||
          target.isContentEditable);

      const onKeyDown = (event: KeyboardEvent) => {
        if (event.code !== 'Space' || event.repeat) return;
        if (isTyping(event.target)) return;

        event.preventDefault();
        startHold();
      };

      const onKeyUp = (event: KeyboardEvent) => {
        if (event.code !== 'Space') return;
        if (isTyping(event.target)) return;

        event.preventDefault();
        endHold();
      };

      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);

      return () => {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
      };
    }, [endHold, startHold]);

    // --- Teardown -------------------------------------------------------------

    useEffect(() => {
      return () => {
        captureRef.current.release();
        ttsRef.current.stop();
        useVoiceStore.getState().reset();
      };
    }, []);

    return null;
  },
);
