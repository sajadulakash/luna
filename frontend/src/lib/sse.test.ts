import { describe, expect, it, vi } from 'vitest';
import { consumeSseStream, parseFrame, splitFrames } from './sse';

/**
 * The parser is the piece most likely to be quietly wrong: chunk boundaries
 * fall wherever the network puts them, and a single bad frame must not take
 * the conversation down with it.
 */

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]) {
  const events: Array<{ event: string; data: unknown }> = [];
  await consumeSseStream(streamOf(chunks), (event, data) =>
    events.push({ event, data }),
  );
  return events;
}

describe('splitFrames', () => {
  it('keeps the incomplete tail out of the frame list', () => {
    const { frames, rest } = splitFrames(
      'event: token\ndata: {"text":"a"}\n\nevent: token\ndata: {"te',
    );

    expect(frames).toEqual(['event: token\ndata: {"text":"a"}']);
    expect(rest).toBe('event: token\ndata: {"te');
  });

  it('returns no frames when nothing is complete yet', () => {
    const { frames, rest } = splitFrames('event: tok');
    expect(frames).toEqual([]);
    expect(rest).toBe('event: tok');
  });

  it('normalises CRLF line endings', () => {
    const { frames } = splitFrames('event: done\r\ndata: {}\r\n\r\n');
    expect(frames).toEqual(['event: done\ndata: {}']);
  });
});

describe('parseFrame', () => {
  it('reads the event name and the JSON payload', () => {
    expect(parseFrame('event: token\ndata: {"text":"Tuesday "}')).toEqual({
      event: 'token',
      data: { text: 'Tuesday ' },
    });
  });

  it('defaults to the "message" event when none is named', () => {
    expect(parseFrame('data: {"id":"msg_1"}')).toEqual({
      event: 'message',
      data: { id: 'msg_1' },
    });
  });

  it('joins multi-line data fields', () => {
    expect(parseFrame('event: message\ndata: {"a":1,\ndata: "b":2}')).toEqual({
      event: 'message',
      data: { a: 1, b: 2 },
    });
  });

  it('returns null for a frame with no data field', () => {
    expect(parseFrame('event: token')).toBeNull();
  });

  it('returns null for malformed JSON rather than throwing', () => {
    expect(parseFrame('event: token\ndata: {"text":')).toBeNull();
  });

  it('ignores comment lines used as keep-alives', () => {
    expect(parseFrame(': keep-alive\nevent: done\ndata: {}')).toEqual({
      event: 'done',
      data: {},
    });
  });
});

describe('consumeSseStream', () => {
  it('emits every frame of a well-formed stream in order', async () => {
    const events = await collect([
      'event: token\ndata: {"text":"Tues"}\n\n',
      'event: token\ndata: {"text":"day"}\n\n',
      'event: done\ndata: {}\n\n',
    ]);

    expect(events).toEqual([
      { event: 'token', data: { text: 'Tues' } },
      { event: 'token', data: { text: 'day' } },
      { event: 'done', data: {} },
    ]);
  });

  it('reassembles a frame split across chunks', async () => {
    const events = await collect([
      'event: tok',
      'en\ndata: {"te',
      'xt":"Tuesday "}\n',
      '\nevent: done\ndata: {}\n\n',
    ]);

    expect(events).toEqual([
      { event: 'token', data: { text: 'Tuesday ' } },
      { event: 'done', data: {} },
    ]);
  });

  it('reassembles a multi-byte character split across chunks', async () => {
    // "—" is three bytes in UTF-8. Split it down the middle.
    const encoder = new TextEncoder();
    const payload = encoder.encode('event: token\ndata: {"text":"—"}\n\n');
    const cut = payload.indexOf(0xe2) + 1;

    const events: Array<{ event: string; data: unknown }> = [];
    await consumeSseStream(
      new ReadableStream({
        start(controller) {
          controller.enqueue(payload.slice(0, cut));
          controller.enqueue(payload.slice(cut));
          controller.close();
        },
      }),
      (event, data) => events.push({ event, data }),
    );

    expect(events).toEqual([{ event: 'token', data: { text: '—' } }]);
  });

  it('skips a malformed frame and keeps going', async () => {
    const events = await collect([
      'event: token\ndata: {"text":"a"}\n\n',
      'event: token\ndata: not json\n\n',
      'event: token\ndata: {"text":"b"}\n\n',
    ]);

    expect(events).toEqual([
      { event: 'token', data: { text: 'a' } },
      { event: 'token', data: { text: 'b' } },
    ]);
  });

  it('emits a trailing frame that arrives without a final blank line', async () => {
    const events = await collect(['event: done\ndata: {}']);
    expect(events).toEqual([{ event: 'done', data: {} }]);
  });

  it('emits nothing for an empty stream', async () => {
    const onEvent = vi.fn();
    await consumeSseStream(streamOf([]), onEvent);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('handles several frames arriving in a single chunk', async () => {
    const events = await collect([
      'event: conflict\ndata: {"reason":"booked"}\n\nevent: token\ndata: {"text":"x"}\n\nevent: done\ndata: {}\n\n',
    ]);

    expect(events.map((e) => e.event)).toEqual(['conflict', 'token', 'done']);
  });
});
