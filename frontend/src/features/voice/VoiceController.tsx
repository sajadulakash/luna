import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import {
  isSpeechRecognitionSupported,
  useSpeechRecognition,
  voiceAvailability,
} from './useSpeechRecognition';
import { useTTSPlayback } from './useTTSPlayback';
import { useMicLevel } from './useMicLevel';

/**
 * Wires the hooks to the store. Renders nothing.
 *
 * All the browser objects — recognition, audio element, analyser — hang off
 * this component, so the store stays a pure state machine and the UI stays a
 * pure function of it.
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
  /** The owner's access token, for the TTS request. */
  token: string | null;
  /** True while a reply is streaming. */
  streaming: boolean;
}

export const VoiceController = forwardRef<VoiceControllerHandle, VoiceControllerProps>(
  function VoiceController({ onUtterance, token, streaming }, ref) {
    const tts = useTTSPlayback();
    const recognition = useSpeechRecognition({ onUtterance });
    const micLevel = useMicLevel();

    const ttsRef = useRef(tts);
    ttsRef.current = tts;

    const micLevelRef = useRef(micLevel);
    micLevelRef.current = micLevel;

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
        store.setError('Voice needs Chrome or Edge. Chat works everywhere.');
      }
    }, []);

    // --- Arm on load when permission is already granted -----------------------

    useEffect(() => {
      if (!isSpeechRecognitionSupported()) return;

      let cancelled = false;

      const armIfPermitted = async () => {
        const permissions = navigator.permissions;
        if (!permissions?.query) return;

        try {
          // The microphone permission name isn't in TypeScript's union yet.
          const status = await permissions.query({
            name: 'microphone' as PermissionName,
          });
          if (cancelled) return;

          useVoiceStore
            .getState()
            .setPermission(status.state === 'granted' ? 'granted' : 'unknown');

          if (status.state === 'granted') {
            useVoiceStore.getState().dispatch('ARM');
            recognition.start();
          }
        } catch {
          // Firefox rejects the query outright. The owner can still tap to arm.
        }
      };

      void armIfPermitted();

      return () => {
        cancelled = true;
      };
      // Runs once. `recognition.start` is stable across renders.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // --- Microphone level ----------------------------------------------------

    useEffect(() => {
      let previous = useVoiceStore.getState().state;

      const sync = (state: typeof previous) => {
        if (state === 'idle') micLevelRef.current.stop();
        else void micLevelRef.current.start();
      };

      sync(previous);

      return useVoiceStore.subscribe((s) => {
        if (s.state === previous) return;
        previous = s.state;
        sync(s.state);
      });
    }, []);

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
        recognition.arm();
        return;
      }

      recognition.stop();
      ttsRef.current.stop();
      micLevelRef.current.stop();
      store.reset();
    }, [recognition]);

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

      // Every press, not only the ones that arm from idle: the machine can
      // read as armed with a dead recogniser behind it, because the start on
      // load happens outside a user gesture and mobile browsers refuse those.
      recognition.arm();

      // The press is what starts a turn, so the orb goes live on the press
      // rather than on the first recognised word. Chrome can take a second to
      // produce one, and a press with no speech would otherwise never show
      // anything at all.
      if (store().state === 'armed') {
        store().dispatch('WAKE_WORD');
      }
    }, [recognition]);

    const endHold = useCallback(() => {
      const store = useVoiceStore.getState();
      store.setHolding(false);
      if (store.state === 'capturing') recognition.commitUtterance();
    }, [recognition]);

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
        recognition.stop();
        ttsRef.current.stop();
        micLevelRef.current.stop();
        useVoiceStore.getState().reset();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return null;
  },
);
