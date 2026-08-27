/**
 * SSE parsing.
 *
 * `EventSource` will not work for Luna's chat: it is GET-only and cannot send
 * an `Authorization` header. So the response body is read as a stream and the
 * frames are parsed here.
 *
 * Kept separate from the transport (api/chat.ts) so it can be unit-tested
 * against partial frames, malformed frames, and chunk boundaries that fall in
 * the middle of a field — all of which happen in production.
 */

export interface SseFrame {
  event: string;
  data: unknown;
}

export type SseEventHandler = (event: string, data: unknown) => void;

/**
 * Splits a buffer into complete frames plus the incomplete tail.
 *
 * Frames are separated by a blank line. A chunk from the network can end
 * anywhere — mid-word, mid-field, between the two newlines of a separator —
 * so whatever follows the last separator is returned as `rest` and carried
 * into the next chunk.
 */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  // Normalise CRLF: some proxies rewrite line endings, and a stray \r left on
  // the end of a data line ends up inside the JSON we try to parse.
  const normalised = buffer.replace(/\r\n/g, '\n');
  const parts = normalised.split('\n\n');
  const rest = parts.pop() ?? '';
  return { frames: parts, rest };
}

/**
 * Parses one frame's text into an event name and its decoded data.
 *
 * Returns null for frames that carry no data, and for frames whose data is not
 * valid JSON — a malformed frame is skipped, it never kills the stream.
 */
export function parseFrame(frame: string): SseFrame | null {
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;            // comment / keep-alive
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) return null;

  try {
    return { event, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}

/**
 * Consumes a byte stream and calls `onEvent` for every well-formed frame.
 *
 * Decoding is streaming-aware (`{ stream: true }`) so a multi-byte character
 * split across two chunks is reassembled rather than mangled — Luna's replies
 * contain em dashes and curly quotes, both multi-byte in UTF-8.
 */
export async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: SseEventHandler,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const { frames, rest } = splitFrames(buffer);
      buffer = rest;

      for (const frame of frames) {
        const parsed = parseFrame(frame);
        if (parsed) onEvent(parsed.event, parsed.data);
      }
    }

    // A stream that ends without a trailing blank line still has one usable
    // frame left in the buffer.
    buffer += decoder.decode();
    const tail = parseFrame(buffer);
    if (tail) onEvent(tail.event, tail.data);
  } finally {
    reader.releaseLock();
  }
}
