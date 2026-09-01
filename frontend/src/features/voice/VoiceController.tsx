import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useRealtimeSession, voiceAvailability } from './useRealtimeSession';

/**
 * Wires the realtime session to the store. Renders nothing.
 *
 * Much thinner than it was: with one model on both ends of the call, there is
 * no recorder to drive, no playback to interrupt and no turn-taking to
 * arbitrate. Starting and stopping the conversation is the whole surface.
 */

export interface VoiceControllerHandle {
  /** Start a conversation, or hang up. Backs the orb's tap. */
  toggle: () => void;
  /** Hang up. */
  stop: () => void;
  /** Press: open the microphone. */
  startTalking: () => void;
  /** Release: close it and hand the turn to Luna. */
  stopTalking: () => void;
}

interface VoiceControllerProps {
  /** The owner's access token, for the session, tool and transcript calls. */
  token: string | null;
  /** A finished spoken turn, for the chat transcript. */
  onTurn: (role: 'user' | 'assistant', content: string) => void;
}

export const VoiceController = forwardRef<VoiceControllerHandle, VoiceControllerProps>(
  function VoiceController({ token, onTurn }, ref) {
    const session = useRealtimeSession({ token, onTurn });

    const sessionRef = useRef(session);
    sessionRef.current = session;

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
        store.setError('This browser cannot run voice calls. Chat still works.');
      }

    }, []);

    // --- Imperative surface --------------------------------------------------

    const toggle = useCallback(() => {
      if (useVoiceStore.getState().state === 'idle') {
        void sessionRef.current.start();
      } else {
        sessionRef.current.stop();
      }
    }, []);

    const stop = useCallback(() => {
      sessionRef.current.stop();
    }, []);

    const startTalking = useCallback(() => {
      sessionRef.current.startTalking();
    }, []);

    const stopTalking = useCallback(() => {
      sessionRef.current.stopTalking();
    }, []);

    useImperativeHandle(
      ref,
      () => ({ toggle, stop, startTalking, stopTalking }),
      [startTalking, stop, stopTalking, toggle],
    );

    // --- Spacebar hold-to-talk ----------------------------------------------

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
        startTalking();
      };

      const onKeyUp = (event: KeyboardEvent) => {
        if (event.code !== 'Space') return;
        if (isTyping(event.target)) return;
        event.preventDefault();
        stopTalking();
      };

      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      return () => {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
      };
    }, [startTalking, stopTalking]);

    // --- Teardown ------------------------------------------------------------

    useEffect(() => {
      return () => sessionRef.current.stop();
    }, []);

    return null;
  },
);
