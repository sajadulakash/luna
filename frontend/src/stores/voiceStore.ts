import { create } from 'zustand';

/**
 * The voice state machine.
 *
 * Voice is one speech-to-speech model on the other end of a WebRTC
 * connection, so most of what this machine used to do is now done for us: the
 * model decides when a turn has ended, and interrupting it is just talking.
 * What is left is describing, for the UI, which of five things is happening.
 *
 * The store holds no browser objects — no RTCPeerConnection, no MediaStream,
 * no Audio — so the whole machine is unit-testable with no microphone
 * involved. The session hook owns those and drives the machine from outside.
 */

export type VoiceState =
  | 'idle'         // no session
  | 'connecting'   // negotiating the connection, asking for the mic
  | 'listening'    // session live, nobody talking
  | 'capturing'    // the user is speaking
  | 'thinking'     // their turn ended, Luna is working on a reply
  | 'speaking';    // Luna is talking

export type VoiceEvent =
  | 'CONNECT'
  | 'READY'
  | 'SPEECH_STARTED'
  | 'SPEECH_STOPPED'
  | 'RESPONSE_STARTED'
  | 'FIRST_AUDIO'
  | 'AUDIO_END'
  | 'ERROR'
  | 'DISCONNECT';

export type MicPermission = 'unknown' | 'granted' | 'denied';

/**
 * Voice-state transitions.
 *
 * An event that is not listed for the current state is ignored rather than
 * throwing. The realtime connection delivers events in orders the UI doesn't
 * expect — audio finishing after the user has already started talking over
 * it, say — and dropping those is correct.
 *
 * SPEECH_STARTED is legal from thinking and speaking as well as listening,
 * and that single fact is barge-in: interrupting Luna is not a special
 * gesture, it is just speaking while she happens to be talking.
 */
const TRANSITIONS: Record<VoiceState, Partial<Record<VoiceEvent, VoiceState>>> = {
  idle: { CONNECT: 'connecting' },
  connecting: { READY: 'listening', ERROR: 'idle', DISCONNECT: 'idle' },
  listening: {
    SPEECH_STARTED: 'capturing',
    RESPONSE_STARTED: 'thinking',
    ERROR: 'idle',
    DISCONNECT: 'idle',
  },
  capturing: {
    SPEECH_STOPPED: 'thinking',
    RESPONSE_STARTED: 'thinking',
    ERROR: 'listening',
    DISCONNECT: 'idle',
  },
  thinking: {
    FIRST_AUDIO: 'speaking',
    SPEECH_STARTED: 'capturing',
    AUDIO_END: 'listening',
    ERROR: 'listening',
    DISCONNECT: 'idle',
  },
  speaking: {
    AUDIO_END: 'listening',
    SPEECH_STARTED: 'capturing',
    ERROR: 'listening',
    DISCONNECT: 'idle',
  },
};

/** Pure transition. Returns null when the event is not legal in that state. */
export function transition(state: VoiceState, event: VoiceEvent): VoiceState | null {
  return TRANSITIONS[state][event] ?? null;
}

export function canTransition(state: VoiceState, event: VoiceEvent): boolean {
  return transition(state, event) !== null;
}

/** The states in which the connection is up and Luna is in the conversation. */
export function isLive(state: VoiceState): boolean {
  return state !== 'idle' && state !== 'connecting';
}

interface VoiceStoreState {
  state: VoiceState;

  /** False without WebRTC, a microphone, or a secure context. */
  supported: boolean;
  permission: MicPermission;

  /** Luna's reply as she says it, streamed a phrase at a time. */
  lunaTranscript: string;
  /** The caller's last finished utterance, as the model heard it. */
  userTranscript: string;

  /** 0–1. The microphone's level while listening, Luna's while speaking. */
  amplitude: number;

  error: string | null;

  dispatch: (event: VoiceEvent) => boolean;
  setSupported: (supported: boolean) => void;
  setPermission: (permission: MicPermission) => void;
  setLunaTranscript: (text: string) => void;
  appendLunaTranscript: (text: string) => void;
  setUserTranscript: (text: string) => void;
  setAmplitude: (amplitude: number) => void;
  setError: (message: string | null) => void;
  /**
   * Hard stop outside the normal table: drops straight to idle from any
   * state. Backs "hang up", which has to work mid-sentence.
   */
  reset: () => void;
}

const INITIAL = {
  state: 'idle' as VoiceState,
  supported: false,
  permission: 'unknown' as MicPermission,
  lunaTranscript: '',
  userTranscript: '',
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
      // A new user turn clears the last exchange from the overlay: what is on
      // screen should be this turn, not the previous one lingering behind it.
      lunaTranscript:
        event === 'SPEECH_STARTED' ? '' : prev.lunaTranscript,
      // Amplitude is meaningless in states that neither listen nor speak.
      amplitude:
        next === 'capturing' || next === 'speaking' || next === 'listening'
          ? prev.amplitude
          : 0,
      error: event === 'ERROR' ? prev.error : null,
    }));

    return true;
  },

  setSupported: (supported) => set({ supported }),
  setPermission: (permission) => set({ permission }),
  setLunaTranscript: (lunaTranscript) => set({ lunaTranscript }),
  appendLunaTranscript: (text) =>
    set((prev) => ({ lunaTranscript: prev.lunaTranscript + text })),
  setUserTranscript: (userTranscript) => set({ userTranscript }),
  setAmplitude: (amplitude) =>
    set((prev) => (prev.amplitude === amplitude ? prev : { amplitude })),
  setError: (error) => set({ error }),

  reset: () =>
    set({ state: 'idle', lunaTranscript: '', userTranscript: '', amplitude: 0 }),
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
