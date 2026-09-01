import { beforeEach, describe, expect, it } from 'vitest';
import {
  canTransition,
  isLive,
  resetVoiceStore,
  transition,
  useVoiceStore,
  type VoiceEvent,
  type VoiceState,
} from './voiceStore';

/**
 * Every transition in the voice machine, with no microphone and no network.
 * The machine is a pure function precisely so this file never needs to touch a
 * browser API.
 */

const ALL_STATES: VoiceState[] = [
  'idle',
  'connecting',
  'listening',
  'capturing',
  'thinking',
  'speaking',
];

const ALL_EVENTS: VoiceEvent[] = [
  'CONNECT',
  'READY',
  'SPEECH_STARTED',
  'SPEECH_STOPPED',
  'RESPONSE_STARTED',
  'FIRST_AUDIO',
  'AUDIO_END',
  'ERROR',
  'DISCONNECT',
];

/** The intended table, written out independently of the implementation. */
const SPEC: Array<[VoiceState, VoiceEvent, VoiceState]> = [
  ['idle', 'CONNECT', 'connecting'],

  ['connecting', 'READY', 'listening'],
  ['connecting', 'ERROR', 'idle'],
  ['connecting', 'DISCONNECT', 'idle'],

  ['listening', 'SPEECH_STARTED', 'capturing'],
  ['listening', 'RESPONSE_STARTED', 'thinking'],
  ['listening', 'ERROR', 'idle'],
  ['listening', 'DISCONNECT', 'idle'],

  ['capturing', 'SPEECH_STOPPED', 'thinking'],
  ['capturing', 'RESPONSE_STARTED', 'thinking'],
  ['capturing', 'ERROR', 'listening'],
  ['capturing', 'DISCONNECT', 'idle'],

  ['thinking', 'FIRST_AUDIO', 'speaking'],
  ['thinking', 'SPEECH_STARTED', 'capturing'],
  ['thinking', 'AUDIO_END', 'listening'],
  ['thinking', 'ERROR', 'listening'],
  ['thinking', 'DISCONNECT', 'idle'],

  ['speaking', 'AUDIO_END', 'listening'],
  ['speaking', 'SPEECH_STARTED', 'capturing'],
  ['speaking', 'ERROR', 'listening'],
  ['speaking', 'DISCONNECT', 'idle'],
];

describe('transition', () => {
  it.each(SPEC)('%s --%s--> %s', (from, event, to) => {
    expect(transition(from, event)).toBe(to);
  });

  it('has exactly the transitions specified and no others', () => {
    const legal = ALL_STATES.flatMap((state) =>
      ALL_EVENTS.filter((event) => canTransition(state, event)).map(
        (event) => `${state}:${event}`,
      ),
    );

    expect(legal.sort()).toEqual(SPEC.map(([f, e]) => `${f}:${e}`).sort());
  });

  it('returns null for an event that is not legal in the current state', () => {
    expect(transition('idle', 'AUDIO_END')).toBeNull();
    expect(transition('idle', 'SPEECH_STARTED')).toBeNull();
    expect(transition('connecting', 'SPEECH_STARTED')).toBeNull();
    expect(transition('listening', 'FIRST_AUDIO')).toBeNull();
  });

  it('treats a call as live only once it is connected', () => {
    expect(ALL_STATES.filter(isLive)).toEqual([
      'listening',
      'capturing',
      'thinking',
      'speaking',
    ]);
  });
});

describe('the store', () => {
  beforeEach(() => {
    resetVoiceStore();
  });

  const store = () => useVoiceStore.getState();

  it('starts idle', () => {
    expect(store().state).toBe('idle');
  });

  it('reports whether a dispatch was applied', () => {
    expect(store().dispatch('CONNECT')).toBe(true);
    expect(store().state).toBe('connecting');

    expect(store().dispatch('AUDIO_END')).toBe(false);
    expect(store().state).toBe('connecting');
  });

  it('walks a full turn: idle → connecting → listening → capturing → thinking → speaking → listening', () => {
    const steps: VoiceEvent[] = [
      'CONNECT',
      'READY',
      'SPEECH_STARTED',
      'SPEECH_STOPPED',
      'FIRST_AUDIO',
      'AUDIO_END',
    ];

    const seen: VoiceState[] = [];
    for (const event of steps) {
      store().dispatch(event);
      seen.push(store().state);
    }

    expect(seen).toEqual([
      'connecting',
      'listening',
      'capturing',
      'thinking',
      'speaking',
      'listening',
    ]);
  });

  it('lets the user interrupt Luna mid-sentence just by speaking', () => {
    store().dispatch('CONNECT');
    store().dispatch('READY');
    store().dispatch('SPEECH_STARTED');
    store().dispatch('SPEECH_STOPPED');
    store().dispatch('FIRST_AUDIO');
    expect(store().state).toBe('speaking');

    // Barge-in is not its own gesture — it is SPEECH_STARTED arriving while
    // she happens to be talking. Never via idle: that would drop the call.
    expect(store().dispatch('SPEECH_STARTED')).toBe(true);
    expect(store().state).toBe('capturing');
  });

  it('interrupts her before she has made a sound, too', () => {
    store().dispatch('CONNECT');
    store().dispatch('READY');
    store().dispatch('SPEECH_STARTED');
    store().dispatch('SPEECH_STOPPED');
    expect(store().state).toBe('thinking');

    expect(store().dispatch('SPEECH_STARTED')).toBe(true);
    expect(store().state).toBe('capturing');
  });

  it('keeps the call open when a single turn errors', () => {
    store().dispatch('CONNECT');
    store().dispatch('READY');
    store().dispatch('SPEECH_STARTED');
    store().dispatch('SPEECH_STOPPED');

    store().dispatch('ERROR');
    expect(store().state).toBe('listening');
  });

  it('drops the call when connecting itself fails', () => {
    store().dispatch('CONNECT');
    store().dispatch('ERROR');
    expect(store().state).toBe('idle');
  });

  it("clears the last reply when a new turn starts", () => {
    store().dispatch('CONNECT');
    store().dispatch('READY');
    store().appendLunaTranscript('You have two meetings tomorrow.');

    store().dispatch('SPEECH_STARTED');
    expect(store().lunaTranscript).toBe('');
  });

  it('accumulates the reply as it is spoken', () => {
    store().appendLunaTranscript('You have ');
    store().appendLunaTranscript('two meetings.');
    expect(store().lunaTranscript).toBe('You have two meetings.');
  });

  it('zeroes the amplitude in states that neither listen nor speak', () => {
    store().dispatch('CONNECT');
    store().dispatch('READY');
    store().dispatch('SPEECH_STARTED');
    store().setAmplitude(0.8);

    store().dispatch('SPEECH_STOPPED');
    expect(store().amplitude).toBe(0);
  });

  it('reset drops to idle from any state, including mid-sentence', () => {
    for (const state of ALL_STATES) {
      resetVoiceStore();
      useVoiceStore.setState({
        state,
        lunaTranscript: 'x',
        userTranscript: 'y',
        amplitude: 0.5,
      });

      store().reset();

      expect(store().state).toBe('idle');
      expect(store().lunaTranscript).toBe('');
      expect(store().userTranscript).toBe('');
      expect(store().amplitude).toBe(0);
    }
  });
});
