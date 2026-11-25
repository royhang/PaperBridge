import { ProviderError } from './types';

export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let line = '';
  let skipLF = false;
  let event: string | undefined;
  let data: string[] = [];
  let done = false;

  function dispatch() {
    const message = data.length
      ? { ...(event ? { event } : {}), data: data.join('\n') }
      : undefined;
    event = undefined;
    data = [];
    return message;
  }

  function readLine(value: string) {
    if (value === '') return dispatch();
    if (value.startsWith(':')) return;

    const colon = value.indexOf(':');
    const field = colon === -1 ? value : value.slice(0, colon);
    const content = colon === -1 ? '' : value.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = content;
    if (field === 'data') data.push(content);
  }

  function cancel() {
    void reader.cancel().catch(() => {});
  }

  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (!done) {
      signal?.throwIfAborted();
      const result = await reader.read();
      signal?.throwIfAborted();
      done = result.done;
      let chunk = decoder.decode(result.value, { stream: !done });
      if (!chunk) continue;

      if (skipLF && chunk.startsWith('\n')) chunk = chunk.slice(1);
      if (!chunk) {
        skipLF = false;
        continue;
      }
      skipLF = chunk.endsWith('\r');

      const lines = chunk.split(/\r\n|\r|\n/);
      lines[0] = line + lines[0];
      line = lines.pop()!;
      for (const completeLine of lines) {
        signal?.throwIfAborted();
        const message = readLine(completeLine);
        if (message) yield message;
      }
    }

    signal?.throwIfAborted();
    if (line) readLine(line);
    const message = dispatch();
    if (message) yield message;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!done) cancel();
    reader.releaseLock();
  }
}

export async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return;

  const text = await res.text();
  const body = text.slice(0, 2000);
  let detail = body.trim();
  try {
    const json = JSON.parse(text);
    if (typeof json?.error?.message === 'string' && json.error.message.trim()) {
      detail = json.error.message.trim().slice(0, 2000);
    }
  } catch {
    // Some endpoints return plain text on error.
  }

  const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
  throw new ProviderError(detail ? `${status}: ${detail}` : status, res.status, body);
}
