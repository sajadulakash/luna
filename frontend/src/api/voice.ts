import { API_BASE_URL } from '../lib/env';
import { apiFetch } from './client';
import type { ChatMessage } from './types';

/**
 * Voice mode.
 *
 * Luna's voice is one speech-to-speech model, not a transcribe-think-speak
 * relay: the browser holds a WebRTC connection straight to OpenAI and audio
 * flows both ways continuously. That is what makes it feel like a
 * conversation rather than a walkie-talkie.
 *
 * Three things still come through our backend, because all three need
 * authority the browser doesn't have: the key that opens the session, the
 * tools the model asks to run, and the transcript that gets written down.
 */

export interface RealtimeSession {
  /** Short-lived, single-session key. Never the real API key. */
  client_secret: string;
  expires_at: number;
  model: string;
  /**
   * What Luna should open with, chosen server-side for this wake.
   *
   * Server-side because every wake is a fresh session with no memory of the
   * last: asked to vary its own greeting, the model returns the same sentence
   * every time. The server has both a clock and the previous answer's absence.
   */
  greeting: string;
}

/** Mints a session, already configured server-side with Luna's prompt and tools. */
export function createRealtimeSession(
  timezone: string,
  token: string | null,
): Promise<RealtimeSession> {
  return apiFetch<RealtimeSession>('/api/voice/realtime/session', {
    method: 'POST',
    body: { timezone },
    token,
  });
}

export interface RealtimeToolResult {
  result: unknown;
  /** True when the tool wrote to the calendar, so the UI can refresh. */
  calendar_changed: boolean;
}

/**
 * Runs a tool the model asked for.
 *
 * The model asks the *browser* to call the tool, and the browser deliberately
 * cannot: it has no database and no right to one. It relays the request here,
 * where the actor is the authenticated user rather than whatever the model
 * named.
 */
export function runRealtimeTool(
  name: string,
  argumentsJson: string,
  timezone: string,
  token: string | null,
): Promise<RealtimeToolResult> {
  return apiFetch<RealtimeToolResult>('/api/voice/realtime/tool', {
    method: 'POST',
    body: { name, arguments: argumentsJson, timezone },
    token,
  });
}

/** Writes a finished spoken turn into the same history the text chat reads. */
export function saveRealtimeTranscript(
  role: 'user' | 'assistant',
  content: string,
  token: string | null,
): Promise<ChatMessage> {
  return apiFetch<ChatMessage>('/api/voice/realtime/transcript', {
    method: 'POST',
    body: { role, content },
    token,
  });
}

/**
 * Opens the WebRTC call by exchanging SDP with OpenAI.
 *
 * This is the one request in the app that does not go to our own backend —
 * it cannot, because the audio path is browser-to-OpenAI by design. It is
 * authorised by the ephemeral secret minted above, which expires in minutes
 * and can only open the session our server already described.
 */
export async function exchangeRealtimeSdp(
  offerSdp: string,
  clientSecret: string,
): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      'Content-Type': 'application/sdp',
    },
    body: offerSdp,
  });

  if (!res.ok) {
    throw new Error(
      `Luna couldn't open the voice connection (${res.status}).`,
    );
  }

  return res.text();
}

// Re-exported so callers don't reach past this module for the base URL.
export { API_BASE_URL };
