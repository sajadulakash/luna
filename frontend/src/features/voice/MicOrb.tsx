import { useEffect, useState } from 'react';
import { useVoiceStore, type VoiceState } from '../../stores/voiceStore';

/**
 * The orb beside the composer: one circle, five states, no text labels.
 *
 * This is the way in to voice, and a live indicator of it — when the mic is
 * armed but no turn is running, this is all that is on screen, so the owner
 * can see at a glance that Luna is listening without anything covering the
 * console. Tapping it opens the voice surface, where a turn actually happens.
 *
 * Under prefers-reduced-motion every pulse is replaced with a static colour
 * change — the state stays readable without anything moving.
 */

interface MicOrbProps {
  /** Opens the voice surface, arming the mic first if it is off. */
  onToggle: () => void;
  disabled?: boolean;
}

const LABELS: Record<VoiceState, string> = {
  idle: 'Talk to Luna',
  armed: 'Ready. Hold the orb to talk.',
  capturing: 'Listening',
  thinking: 'Luna is thinking',
  speaking: 'Luna is speaking',
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

export function MicOrb({ onToggle, disabled = false }: MicOrbProps) {
  const state = useVoiceStore((s) => s.state);
  const amplitude = useVoiceStore((s) => s.amplitude);
  const reducedMotion = useReducedMotion();

  // capturing and speaking scale with the audio actually present. Clamped so
  // a loud room can't make the orb jump around.
  const scale =
    reducedMotion || (state !== 'capturing' && state !== 'speaking')
      ? 1
      : 1 + Math.min(amplitude, 1) * 0.18;

  const fill = (() => {
    switch (state) {
      case 'idle':
        return 'bg-transparent border-2 border-faint';
      case 'armed':
        return `bg-transparent border-2 border-accent ${
          reducedMotion ? '' : 'motion-safe:animate-luna-breathe'
        }`;
      case 'capturing':
      case 'thinking':
        return 'bg-accent border-2 border-accent';
      case 'speaking':
        return `bg-free border-2 border-free ${
          reducedMotion ? '' : 'motion-safe:animate-luna-breathe'
        }`;
    }
  })();

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      aria-label={LABELS[state]}
      aria-pressed={state !== 'idle'}
      className={[
        'tap relative flex shrink-0 items-center justify-center rounded-pill',
        'transition-transform duration-150 ease-out',
        disabled ? 'cursor-not-allowed opacity-50' : '',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={[
          'block h-32 w-32 rounded-pill',
          'transition-colors duration-150 ease-out',
          fill,
        ].join(' ')}
        style={{ transform: `scale(${scale})` }}
      />
    </button>
  );
}
