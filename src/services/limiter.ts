/**
 * One cap on concurrent bulk translation requests (full-text batches, their per-paragraph fallbacks, repair
 * retries, PDF export): together they never exceed the user's "并发数", which is what the API allows (more only
 * earns 429s and long back-offs). Urgent requests — retries a page is waiting for before it can be drawn —
 * take the next free slot ahead of queued batches.
 */
type Waiter = { urgent: boolean; go: () => void };

export function createLimiter(limit: () => number) {
  let active = 0;
  const waiting: Waiter[] = [];
  const pump = () => {
    // a missing / broken setting must not stall every request
    const cap = Math.max(1, Math.floor(limit()) || 3);
    while (waiting.length && active < cap) {
      const i = waiting.findIndex((w) => w.urgent);
      const [w] = waiting.splice(i >= 0 ? i : 0, 1);
      active++;
      w.go();
    }
  };
  /** Resolves with a release function once a slot is free; rejects if `signal` aborts while waiting. */
  const acquire = (urgent = false, signal?: AbortSignal): Promise<() => void> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active--;
        pump();
      };
      const w: Waiter = {
        urgent,
        go: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(release);
        },
      };
      const onAbort = () => {
        const i = waiting.indexOf(w);
        if (i >= 0) waiting.splice(i, 1);
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      waiting.push(w);
      pump();
    });
  const run = async <T>(fn: () => Promise<T>, urgent = false, signal?: AbortSignal): Promise<T> => {
    const release = await acquire(urgent, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  };
  return { acquire, run, get active() { return active; }, get waiting() { return waiting.length; } };
}
