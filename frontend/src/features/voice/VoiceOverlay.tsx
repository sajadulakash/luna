import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useVoiceStore, type VoiceState } from '../../stores/voiceStore';

/**
 * The voice surface: a large orb over a blurred console.
 *
 * The orb is held to talk. The microphone is muted between holds, so a room
 * with other people in it reaches nothing — which is the point: a voice
 * detector cannot tell your voice from theirs, and a button can.
 *
 * The orb reads amplitude from the store: the microphone's while listening,
 * Luna's while speaking.
 */

interface VoiceOverlayProps {
  /** Hangs up and leaves voice. */
  onClose: () => void;
  onHoldStart: () => void;
  onHoldEnd: () => void;
}

const STATUS: Record<VoiceState, string> = {
  idle: '',
  connecting: 'Connecting…',
  listening: 'Hold the circle to talk',
  capturing: 'Listening — keep holding',
  thinking: 'Thinking',
  speaking: 'Luna is speaking — hold to interrupt',
};

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduced(query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  return reduced;
}

export function VoiceOverlay({ onClose, onHoldStart, onHoldEnd }: VoiceOverlayProps) {
  const state = useVoiceStore((s) => s.state);
  const amplitude = useVoiceStore((s) => s.amplitude);
  const lunaTranscript = useVoiceStore((s) => s.lunaTranscript);
  const userTranscript = useVoiceStore((s) => s.userTranscript);
  const error = useVoiceStore((s) => s.error);
  const reducedMotion = useReducedMotion();

  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const live = state === 'capturing' || state === 'speaking';
  const scale = reducedMotion || !live ? 1 : 1 + Math.min(amplitude, 1) * 0.22;

  const fill = (() => {
    switch (state) {
      case 'speaking':
        return 'bg-free';
      case 'capturing':
      case 'thinking':
        return 'bg-accent';
      default:
        return 'bg-transparent border-2 border-accent';
    }
  })();

  const ringColor = state === 'speaking' ? 'border-free' : 'border-accent';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Talking to Luna"
      className="voice-scrim fixed inset-0 z-40 flex flex-col px-safe motion-safe:animate-luna-fade"
    >
      <div className="flex justify-end pt-safe">
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="End the call with Luna"
          className="tap flex items-center justify-center px-16 text-muted transition-colors duration-150 ease-out hover:text-ink"
        >
          <X size={22} aria-hidden="true" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-32 px-24">
        <div className="relative flex h-orb w-orb items-center justify-center">
          {/* Rings travel outward while someone is making sound. Under reduced
              motion they are not rendered at all. */}
          {live && !reducedMotion
            ? [0, 1].map((index) => (
                <span
                  key={index}
                  aria-hidden="true"
                  className={`absolute h-orb w-orb rounded-pill border-2 ${ringColor} motion-safe:animate-luna-ring`}
                  style={{ animationDelay: `${index * 1.3}s` }}
                />
              ))
            : null}

          <button
            type="button"
            aria-label="Hold to talk to Luna"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              onHoldStart();
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              onHoldEnd();
            }}
            onPointerCancel={onHoldEnd}
            onContextMenu={(event) => event.preventDefault()}
            className={[
              'relative flex h-orb w-orb touch-none select-none items-center justify-center rounded-pill',
              'transition-colors duration-250 ease-out',
              fill,
              (state === 'listening' || state === 'connecting') && !reducedMotion
                ? 'motion-safe:animate-luna-breathe'
                : '',
            ].join(' ')}
            style={{
              transform: `scale(${scale})`,
              transitionProperty: 'background-color, border-color, transform',
            }}
          />

          {/* thinking: a slow arc around the orb. */}
          {state === 'thinking' && !reducedMotion ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute h-orb w-orb rounded-pill border-2 border-transparent border-t-accent motion-safe:animate-luna-spin"
              style={{ transform: 'scale(1.15)' }}
            />
          ) : null}
        </div>

        <div
          className="flex min-h-64 max-w-chat flex-col items-center gap-8"
          aria-live="polite"
        >
          {error ? (
            <p role="alert" className="text-center text-15 text-busy">
              {error}
            </p>
          ) : (
            <>
              <p className="text-13 text-faint">{STATUS[state]}</p>

              {/* What she is saying, as she says it. Falls back to the last
                  thing heard so the screen isn't blank between turns. */}
              {lunaTranscript ? (
                <p className="text-center text-20 text-ink">{lunaTranscript}</p>
              ) : userTranscript ? (
                <p className="text-center text-17 text-muted">“{userTranscript}”</p>
              ) : null}
            </>
          )}
        </div>
      </div>

      <div className="pb-safe" />
    </div>
  );
}
