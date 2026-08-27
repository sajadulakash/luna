import { API_BASE_URL } from '../lib/env';
import { ApiRequestError, NetworkError } from './client';

/**
 * Speech to text.
 *
 * The recording is posted to our own backend, which forwards it to the
 * transcription model. It deliberately does not go straight to the provider:
 * that would put the API key in the browser.
 */

export interface TranscribeOptions {
  blob: Blob;
  /** Extension matters — the provider picks its decoder from it. */
  filename: string;
  token: string | null;
  signal?: AbortSignal;
}

export async function transcribeAudio({
  blob,
  filename,
  token,
  signal,
}: TranscribeOptions): Promise<string> {
  const form = new FormData();
  form.append('file', blob, filename);

  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  // No Content-Type: the browser has to set the multipart boundary itself.

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/voice/stt`, {
      method: 'POST',
      headers,
      body: form,
      credentials: 'include',
      signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new NetworkError("I couldn't reach the server to transcribe that.");
  }

  if (!res.ok) {
    let message = `Transcription failed (${res.status}).`;
    let code = 'transcription_failed';
    try {
      const body = await res.json();
      if (typeof body?.message === 'string') message = body.message;
      if (typeof body?.error === 'string') code = body.error;
    } catch {
      // Non-JSON error body. Keep the generic message.
    }
    throw new ApiRequestError(res.status, code, message);
  }

  const body = await res.json();
  return typeof body?.text === 'string' ? body.text.trim() : '';
}
