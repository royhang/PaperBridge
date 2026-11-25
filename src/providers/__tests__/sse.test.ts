import { describe, expect, it, vi } from 'vitest';
import { ensureOk, parseSSE } from '../sse';
import { ProviderError } from '../types';

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe('parseSSE', () => {
  it.each([1, 2, 7, 1024])('parses SSE with %i-byte chunks', async (size) => {
    const bytes = new TextEncoder().encode(
      '\ufeff: heartbeat\r\nevent: ping\r\n\r\n'
      + 'event: token\r\ndata: 你🙂\r\n: comment\r\ndata:  second: part\r\n\r\n'
      + 'id: 7\rretry: 1000\rdata\r\r'
      + 'event: \ndata: before EOF\n\nevent: final\ndata: last',
    );
    const chunks: Uint8Array[] = [];
    for (let index = 0; index < bytes.length; index += size) {
      chunks.push(bytes.slice(index, index + size));
    }

    await expect(collect(parseSSE(byteStream(chunks)))).resolves.toEqual([
      { event: 'token', data: '你🙂\n second: part' },
      { data: '' },
      { data: 'before EOF' },
      { event: 'final', data: 'last' },
    ]);
  });

  it('dispatches a data field at EOF after one line ending', async () => {
    const bytes = new TextEncoder().encode('data: end\r');
    await expect(collect(parseSSE(byteStream([bytes])))).resolves.toEqual([{ data: 'end' }]);
  });

  it('cancels the reader on early iterator exit', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: first\n\n'));
      },
      cancel,
    });

    for await (const event of parseSSE(body)) {
      expect(event.data).toBe('first');
      break;
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('interrupts a pending read on abort', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    const reading = collect(parseSSE(body, controller.signal));

    controller.abort();
    await expect(reading).rejects.toBe(controller.signal.reason);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});

describe('ensureOk', () => {
  it('leaves a successful response body readable', async () => {
    const response = new Response('success');
    await ensureOk(response);
    await expect(response.text()).resolves.toBe('success');
  });

  it('extracts a JSON error and retains only 2000 characters of the body', async () => {
    const body = JSON.stringify({ padding: 'x'.repeat(2100), error: { message: 'Rate limit reached' } });
    const failure = ensureOk(new Response(body, { status: 429, statusText: 'Too Many Requests' }));
    await expect(failure).rejects.toBeInstanceOf(ProviderError);
    await expect(failure).rejects.toMatchObject({
      status: 429,
      message: 'HTTP 429 Too Many Requests: Rate limit reached',
      body: body.slice(0, 2000),
    });
  });

  it('includes a plain-text error body', async () => {
    await expect(ensureOk(new Response('Service unavailable', { status: 503 }))).rejects.toMatchObject({
      status: 503,
      message: 'HTTP 503: Service unavailable',
      body: 'Service unavailable',
    });
  });
});
