import { beforeEach, describe, expect, it } from 'vitest';
import {
  canTransition,
  resetVoiceStore,
  transition,
  useVoiceStore,
  type VoiceEvent,
  type VoiceState,
} from './voiceStore';

/**
 * Every transition in §9, with no microphone involved. The machine is a pure
 * function precisely so this file never needs to touch a browser API.
 */

const ALL_STATES: VoiceState[] = ['idle', 'armed', 'capturing', 'thinking', 'speaking'];

const ALL_EVENTS: VoiceEvent[] = [
  'ARM',
  'DISARM',
  'WAKE_WORD',
  'SILENCE_2S',
  'FIRST_AUDIO',
  'ERROR',
  'AUDIO_END',
  'BARGE_IN',
  'RELEASE',
];

/** The table from the brief, transcribed independently of the implementation. */
const SPEC: Array<[VoiceState, VoiceEvent, VoiceState]> = [
  ['idle', 'ARM', 'armed'],
  ['armed', 'WAKE_WORD', 'capturing'],
  ['armed', 'DISARM', 'idle'],
  ['capturing', 'SILENCE_2S', 'thinking'],
  ['capturing', 'RELEASE', 'armed'],
  ['capturing', 'DISARM', 'idle'],
  ['thinking', 'FIRST_AUDIO', 'speaking'],
  ['thinking', 'ERROR', 'armed'],
  ['speaking', 'AUDIO_END', 'armed'],
  ['speaking', 'BARGE_IN', 'capturing'],
];

describe('transition', () => {
  it.each(SPEC)('%s --%s--> %s', (from, event, to) => {
    expect(transition(from, event)).toBe(to);
  });

  it('has exactly the transitions the brief specifies', () => {
    const legal = ALL_STATES.flatMap((state) =>
      ALL_EVENTS.filter((event) => canTransition(state, event)).map(
        (event) => `${state}:${event}`,
      ),
    );

    expect(legal.sort()).toEqual(
      SPEC.map(([from, event]) => `${from}:${event}`).sort(),
    );
  });

  it('returns null for an event that is not legal in the current state', () => {
    expect(transition('idle', 'BARGE_IN')).toBeNull();
    expect(transition('armed', 'AUDIO_END')).toBeNull();
    expect(transition('speaking', 'ARM')).toBeNull();
    expect(transition('thinking', 'WAKE_WORD')).toBeNull();
  });
});

describe('the store', () => {
  beforeEach(() => {
    resetVoiceStore();
  });

  it('starts idle', () => {
    expect(useVoiceStore.getState().state).toBe('idle');
  });

  it('reports whether a dispatch was applied', () => {
    const { dispatch } = useVoiceStore.getState();

    expect(dispatch('ARM')).toBe(true);
    expect(useVoiceStore.getState().state).toBe('armed');

    expect(useVoiceStore.getState().dispatch('AUDIO_END')).toBe(false);
    expect(useVoiceStore.getState().state).toBe('armed');
  });

  it('walks a full turn: idle → armed → capturing → thinking → speaking → armed', () => {
    const steps: VoiceEvent[] = [
      'ARM',
      'WAKE_WORD',
      'SILENCE_2S',
      'FIRST_AUDIO',
      'AUDIO_END',
    ];

    const seen: VoiceState[] = [];
    for (const event of steps) {
      useVoiceStore.getState().dispatch(event);
      seen.push(useVoiceStore.getState().state);
    }

    expect(seen).toEqual(['armed', 'capturing', 'thinking', 'speaking', 'armed']);
  });

  it('returns to armed when a press is released without speech', () => {
    const store = () => useVoiceStore.getState();
    store().dispatch('ARM');
    store().dispatch('WAKE_WORD');

    // Never through idle: that would tear down and re-acquire the microphone.
    expect(store().dispatch('RELEASE')).toBe(true);
    expect(store().state).toBe('armed');
  });

  it('returns to capturing on barge-in', () => {
    const store = () => useVoiceStore.getState();
    store().dispatch('ARM');
    store().dispatch('WAKE_WORD');
    store().dispatch('SILENCE_2S');
    store().dispatch('FIRST_AUDIO');

    expect(store().state).toBe('speaking');
    expect(store().dispatch('BARGE_IN')).toBe(true);
    expect(store().state).toBe('capturing');
  });

  it('goes back to armed when the turn errors', () => {
    const store = () => useVoiceStore.getState();
    store().dispatch('ARM');
    store().dispatch('WAKE_WORD');
    store().dispatch('SILENCE_2S');

    store().dispatch('ERROR');
    expect(store().state).toBe('armed');
  });

  it('clears the interim transcript when it leaves capturing', () => {
    const store = () => useVoiceStore.getState();
    store().dispatch('ARM');
    store().dispatch('WAKE_WORD');
    store().setInterim('what does Tuesday look like');

    store().dispatch('SILENCE_2S');
    expect(store().interim).toBe('');
  });

  it('zeroes the amplitude in states that neither listen nor speak', () => {
    const store = () => useVoiceStore.getState();
    store().dispatch('ARM');
    store().dispatch('WAKE_WORD');
    store().setAmplitude(0.8);

    store().dispatch('SILENCE_2S');
    expect(store().amplitude).toBe(0);
  });

  it('accumulates captured speech across final results', () => {
    const store = () => useVoiceStore.getState();
    store().appendCaptured('what does');
    store().appendCaptured('Tuesday look like');

    expect(store().captured).toBe('what does Tuesday look like');
  });

  it('reset drops to idle from any state, including mid-reply', () => {
    for (const state of ALL_STATES) {
      resetVoiceStore();
      useVoiceStore.setState({ state, interim: 'x', captured: 'y', amplitude: 0.5 });

      useVoiceStore.getState().reset();

      expect(useVoiceStore.getState().state).toBe('idle');
      expect(useVoiceStore.getState().interim).toBe('');
      expect(useVoiceStore.getState().captured).toBe('');
      expect(useVoiceStore.getState().amplitude).toBe(0);
    }
  });
});
