import { useCallback, useEffect, useRef } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';

/**
 * Speech recognition, with the four gotchas from §9 handled.
 *
 * The recogniser is a browser object with a life of its own, so it is kept in
 * refs and never in React state — re-rendering must not be able to construct a
 * second instance.
 */

/** Armed with no onresult and no onend for this long means it died silently. */
const WATCHDOG_MS = 10_000;

/**
 * Restart backoff.
 *
 * Chrome ends recognition on its own and we restart from `onend` — but when
 * the speech service is unreachable it ends *immediately*, and restarting
 * synchronously inside the handler recurses until the stack overflows. So a
 * restart is always deferred, and repeated instant failures back off.
 */
const RESTART_MIN_MS = 250;
const RESTART_MAX_MS = 8_000;
/** A session shorter than this never really started. */
const SESSION_TOO_SHORT_MS = 1_000;
/** Give up after this many consecutive instant failures. */
const MAX_RAPID_RESTARTS = 6;
/**
 * Give up after this many consecutive sessions that ran while the owner was
 * holding the orb and produced nothing at all.
 *
 * A session with no results is normally just silence, which is why `no-speech`
 * is ignored. But a run of them *during* a held press means the recogniser is
 * receiving no audio — starved by another consumer of the microphone, or a
 * denied input — and cycling silently forever is the worst possible response.
 */
const MAX_FRUITLESS_SESSIONS = 3;

export function isSpeechRecognitionSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition);
}

export type VoiceAvailability = 'ok' | 'unsupported' | 'insecure';

/**
 * Whether voice can run at all, decided before anything is offered.
 *
 * Both the microphone and the Web Speech API require a secure context. On a
 * phone that means a real certificate: `localhost` is exempt, a LAN address
 * over plain HTTP is not. Without this check the failure only surfaces after
 * a tap, as a recogniser that starts and immediately dies — which reads as a
 * glitch rather than as the configuration problem it is.
 */
export function voiceAvailability(): VoiceAvailability {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (!isSpeechRecognitionSupported()) return 'unsupported';
  return 'ok';
}

export interface SpeechRecognitionCallbacks {
  /** A complete request captured during one press. Send it. */
  onUtterance: (text: string) => void;
}

export function useSpeechRecognition({ onUtterance }: SpeechRecognitionCallbacks) {
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const watchdogTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Guards against restarting a recogniser we are deliberately tearing down. */
  const wantRunning = useRef(false);
  const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rapidRestarts = useRef(0);
  const startedAt = useRef(0);
  /** The last non-benign error code, so a give-up can name what went wrong. */
  const lastError = useRef<string | null>(null);
  /** Whether the owner has actually asked for the microphone yet. */
  const gestured = useRef(false);
  /** Whether the current session has produced any result at all. */
  const sawResult = useRef(false);
  /** Consecutive held sessions that ended without hearing a thing. */
  const fruitless = useRef(0);

  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;

  const clearTimers = useCallback(() => {
    if (watchdogTimer.current) clearTimeout(watchdogTimer.current);
    if (restartTimer.current) clearTimeout(restartTimer.current);
    watchdogTimer.current = null;
    restartTimer.current = null;
  }, []);

  /**
   * Tears down the current instance.
   *
   * Never run two instances: stop and null the old one before constructing a
   * new one, or you get duplicated transcripts that are miserable to debug.
   */
  const teardown = useCallback(() => {
    wantRunning.current = false;
    clearTimers();

    const instance = recognitionRef.current;
    recognitionRef.current = null;

    if (instance) {
      instance.onresult = null;
      instance.onerror = null;
      instance.onend = null;
      instance.onstart = null;
      try {
        instance.abort();
      } catch {
        // Already dead. Nothing to do.
      }
    }
  }, [clearTimers]);

  /** Fires the accumulated request and moves the machine on. */
  const commitUtterance = useCallback(() => {
    const store = useVoiceStore.getState();
    const text = [store.captured, store.interim].filter(Boolean).join(' ').trim();

    store.clearCaptured();

    if (!text) {
      // Released without capturing speech. Back to ready rather than sending
      // an empty turn — and without passing through idle, which would tear
      // down and re-acquire the microphone on every silent press.
      store.dispatch('RELEASE');
      return;
    }

    if (store.dispatch('SILENCE_2S')) {
      onUtteranceRef.current(text);
    }
  }, []);

  const armWatchdog = useCallback(() => {
    if (watchdogTimer.current) clearTimeout(watchdogTimer.current);
    watchdogTimer.current = setTimeout(() => {
      // It dies silently. Tear it down and start a fresh instance.
      if (useVoiceStore.getState().state === 'idle') return;
      teardown();
      startRef.current?.();
    }, WATCHDOG_MS);
  }, [teardown]);

  /**
   * Queues another attempt, backing off while attempts keep failing instantly.
   *
   * Never restarts synchronously: a recogniser that dies the moment it starts
   * would recurse until the stack overflows.
   */
  const scheduleRestart = useCallback(() => {
    if (!wantRunning.current) return;
    if (useVoiceStore.getState().state === 'idle') return;

    if (fruitless.current >= MAX_FRUITLESS_SESSIONS) {
      const store = useVoiceStore.getState();
      store.setError(
        "The microphone is open but no sound is reaching me. Something else " +
          'may be using it. You can still type to me.',
      );
      teardown();
      store.reset();
      return;
    }

    if (rapidRestarts.current > MAX_RAPID_RESTARTS) {
      // It is not coming back — no speech service, no microphone, or a
      // browser refusing to start one. Drop to idle and say so rather than
      // spinning silently behind a listening indicator.
      const store = useVoiceStore.getState();
      if (gestured.current) {
        store.setError(
          lastError.current
            ? `The microphone didn't start (${lastError.current}). You can still type to me.`
            : "The microphone didn't start. You can still type to me.",
        );
      }
      teardown();
      store.reset();
      return;
    }

    const delay = Math.min(
      RESTART_MAX_MS,
      RESTART_MIN_MS * 2 ** Math.max(0, rapidRestarts.current - 1),
    );

    if (restartTimer.current) clearTimeout(restartTimer.current);
    restartTimer.current = setTimeout(() => {
      restartTimer.current = null;
      if (!wantRunning.current) return;
      if (useVoiceStore.getState().state === 'idle') return;
      startRef.current?.();
    }, delay);
  }, [teardown]);

  const handleTranscript = useCallback(
    (text: string, isFinal: boolean) => {
      const store = useVoiceStore.getState();
      const { state, holding } = store;

      if (state === 'idle') return;

      // Voice is push-to-talk. Speech heard while the orb or spacebar is not
      // held is discarded in the browser and never reaches the API.
      if (!holding) return;

      if (state === 'speaking') {
        // Barge-in. Any speech while held stops the audio immediately.
        if (text.trim().length > 0) {
          store.dispatch('BARGE_IN');
          store.setInterim(text);
        }
        return;
      }

      if (state === 'armed') {
        store.dispatch('WAKE_WORD');
        if (isFinal) {
          store.appendCaptured(text);
          store.setInterim('');
        } else {
          store.setInterim(text);
        }
        return;
      }

      if (state === 'capturing') {
        if (isFinal) {
          store.appendCaptured(text);
          store.setInterim('');
        } else {
          store.setInterim(text);
        }
      }
    },
    [],
  );

  const start = useCallback(() => {
    if (!isSpeechRecognitionSupported()) return;
    if (recognitionRef.current) return;

    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      startedAt.current = Date.now();
      useVoiceStore.getState().setPermission('granted');
      armWatchdog();
    };

    recognition.onresult = (event) => {
      // A result proves the session is healthy, so the backoff resets.
      rapidRestarts.current = 0;
      lastError.current = null;
      sawResult.current = true;
      fruitless.current = 0;
      armWatchdog();

      // Only the results from this callback's index onward are new.
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result) continue;
        const alternative = result[0];
        if (!alternative) continue;
        handleTranscript(alternative.transcript, result.isFinal);
      }
    };

    recognition.onerror = (event) => {
      // `no-speech` is normal — someone was quiet. Ignore it.
      if (event.error === 'no-speech' || event.error === 'aborted') return;

      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        const store = useVoiceStore.getState();
        store.setPermission('denied');
        store.setError(
          'I need microphone access to listen. You can still type to me.',
        );
        teardown();
        store.reset();
        return;
      }

      // network, audio-capture and friends: let onend restart us. The code is
      // kept so that if the restarts do run out, the message can name it.
      lastError.current = event.error;
      useVoiceStore.getState().setError(null);
    };

    recognition.onend = () => {
      // It stops on its own after a stretch of silence. Restart it whenever
      // the machine isn't idle — but never synchronously from inside this
      // handler, or a recogniser that ends instantly recurses forever.
      recognitionRef.current = null;
      if (!wantRunning.current) return;
      if (useVoiceStore.getState().state === 'idle') return;

      const lasted = Date.now() - startedAt.current;
      rapidRestarts.current = lasted < SESSION_TOO_SHORT_MS ? rapidRestarts.current + 1 : 0;

      // Only while capturing: outside a held press, hearing nothing is just
      // someone not talking, which is the normal armed state.
      if (!sawResult.current && useVoiceStore.getState().state === 'capturing') {
        fruitless.current += 1;
      }

      scheduleRestart();
    };

    recognitionRef.current = recognition;
    wantRunning.current = true;
    sawResult.current = false;

    try {
      recognition.start();
      armWatchdog();
    } catch (cause) {
      // Chrome throws when start() races a previous instance's teardown, and
      // mobile browsers throw when it is called outside a user gesture.
      // Neither fires onend, so without this the recogniser is dead for good:
      // no instance, no watchdog, nothing left to restart it, and no error on
      // screen — the orb sits there saying it is listening to nothing.
      recognitionRef.current = null;
      lastError.current = cause instanceof Error ? cause.name : 'start failed';
      rapidRestarts.current += 1;
      scheduleRestart();
    }
  }, [armWatchdog, handleTranscript, scheduleRestart]);

  // `start` refers to itself through this ref so the watchdog can restart it
  // without a circular useCallback dependency.
  const startRef = useRef<(() => void) | null>(null);
  startRef.current = start;

  /**
   * Starts the recogniser from a user gesture, and re-asserts it on every
   * press.
   *
   * `start` alone is not enough. The arm-on-load path runs outside a gesture,
   * which mobile browsers refuse — leaving the machine reading as `armed`
   * with no live recogniser behind it, so a press that only checks the state
   * would never try again. The backoff is cleared too: a press is fresh
   * intent, and the attempts that failed before it were the ungestured ones.
   */
  const arm = useCallback(() => {
    gestured.current = true;
    rapidRestarts.current = 0;
    fruitless.current = 0;
    lastError.current = null;

    if (restartTimer.current) {
      clearTimeout(restartTimer.current);
      restartTimer.current = null;
    }

    // No-ops when an instance is already live.
    start();
  }, [start]);

  const stop = useCallback(() => {
    teardown();
  }, [teardown]);

  useEffect(() => teardown, [teardown]);

  return { start, arm, stop, commitUtterance };
}
