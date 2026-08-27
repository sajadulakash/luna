import { create } from 'zustand';

/**
 * The voice state machine.
 *
 * Every piece of voice UI reads from this store and nothing keeps its own
 * copy. The store holds no browser objects — no MediaRecorder, no Audio, no
 * AnalyserNode — so the whole machine is unit-testable with no microphone
 * involved. The hooks own those objects and drive the machine from outside.
 */

export type VoiceState =
  | 'idle'        // mic off. hold-to-talk mode, or voice disabled.
  | 'armed'       // mic is ready for held speech.
  | 'capturing'   // accumulating the current held request.
  | 'thinking'    // sent, waiting on the stream.
  | 'speaking';   // playing Luna's audio.

export type VoiceEvent =
  | 'ARM'
  | 'DISARM'
  | 'WAKE_WORD'
  | 'SILENCE_2S'
  | 'FIRST_AUDIO'
  | 'ERROR'
  | 'AUDIO_END'
  | 'BARGE_IN'
  | 'RELEASE';

export type MicPermission = 'unknown' | 'granted' | 'denied';

/**
 * Voice-state transitions.
 *
 * An event that is not listed for the current state is ignored rather than
 * throwing — recognition fires callbacks in orders the machine doesn't expect
 * (a stray result arriving after DISARM, say), and dropping those is correct.
 */
const TRANSITIONS: Record<VoiceState, Partial<Record<VoiceEvent, VoiceState>>> = {
  idle: { ARM: 'armed' },
  armed: { WAKE_WORD: 'capturing', DISARM: 'idle' },
  capturing: { SILENCE_2S: 'thinking', RELEASE: 'armed', DISARM: 'idle' },
  thinking: { FIRST_AUDIO: 'speaking', ERROR: 'armed' },
  speaking: { AUDIO_END: 'armed', BARGE_IN: 'capturing' },
};

/** Pure transition. Returns null when the event is not legal in that state. */
export function transition(state: VoiceState, event: VoiceEvent): VoiceState | null {
  return TRANSITIONS[state][event] ?? null;
}

export function canTransition(state: VoiceState, event: VoiceEvent): boolean {
  return transition(state, event) !== null;
}

interface VoiceStoreState {
  state: VoiceState;

  /** False on Safari and Firefox — chat still works, voice is hidden. */
  supported: boolean;
  permission: MicPermission;

  /** True while the spacebar (or the orb) is held in hold-to-talk mode. */
  holding: boolean;

  /** Live, uncommitted transcript — shown greyed in the composer. */
  interim: string;
  /** The speech captured during the current press. */
  captured: string;

  /** 0–1, from an AnalyserNode. Drives the orb's scale. */
  amplitude: number;

  error: string | null;

  dispatch: (event: VoiceEvent) => boolean;
  setSupported: (supported: boolean) => void;
  setPermission: (permission: MicPermission) => void;
  setHolding: (holding: boolean) => void;
  setInterim: (text: string) => void;
  appendCaptured: (text: string) => void;
  clearCaptured: () => void;
  setAmplitude: (amplitude: number) => void;
  setError: (message: string | null) => void;
  /**
   * Hard stop outside the normal table: drops straight to idle from any state.
   * Backs the "turn voice off" control, which has to work even mid-reply.
   * Ordinary flow uses dispatch('DISARM').
   */
  reset: () => void;
}

const INITIAL = {
  state: 'idle' as VoiceState,
  supported: false,
  permission: 'unknown' as MicPermission,
  holding: false,
  interim: '',
  captured: '',
  amplitude: 0,
  error: null as string | null,
};

export const useVoiceStore = create<VoiceStoreState>((set, get) => ({
  ...INITIAL,

  dispatch: (event) => {
    const next = transition(get().state, event);
    if (next === null) return false;

    set((prev) => ({
      state: next,
      // Leaving capturing for any reason clears the live transcript: it has
      // either been committed to a message or abandoned.
      interim: next === 'capturing' || prev.state !== 'capturing' ? prev.interim : '',
      // Amplitude is meaningless in states that don't listen or speak.
      amplitude: next === 'capturing' || next === 'speaking' ? prev.amplitude : 0,
      error: event === 'ERROR' ? prev.error : null,
    }));

    return true;
  },

  setSupported: (supported) => set({ supported }),
  setPermission: (permission) => set({ permission }),
  setHolding: (holding) => set({ holding }),
  setInterim: (interim) => set({ interim }),

  appendCaptured: (text) =>
    set((prev) => ({
      captured: prev.captured ? `${prev.captured} ${text}`.trim() : text.trim(),
    })),

  clearCaptured: () => set({ captured: '', interim: '' }),
  setAmplitude: (amplitude) =>
    set((prev) => (prev.amplitude === amplitude ? prev : { amplitude })),
  setError: (error) => set({ error }),

  reset: () =>
    set({ state: 'idle', interim: '', captured: '', amplitude: 0 }),
}));

/** Exposed for tests: returns the store to its initial values. */
export function resetVoiceStore(): void {
  useVoiceStore.setState({ ...INITIAL });
}

// Test hook: lets the browser harness drive the machine without a microphone.
// Dev only — `import.meta.env.DEV` is statically false in a production build,
// so this block is dropped entirely by the bundler.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __voice: typeof useVoiceStore }).__voice = useVoiceStore;
}
