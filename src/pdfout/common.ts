/** Lightweight helpers shared by the reader and the PDF pipeline (no pdf-lib import here). */

export const PLACEHOLDER_RULE =
  'The text contains placeholders like {v0}, {v1} that stand for formulas or symbols. Keep every placeholder exactly once and unchanged, placed where the formula belongs in the translated sentence. Tags like <s1>…</s1> mark bold or coloured words: keep each tag pair around the corresponding translated words. Keep all numbers, citation marks such as [12], model and dataset names unchanged. A text may be a fragment that starts or ends in the middle of a sentence (the paragraph continues in another column or page): translate every word of it, including the unfinished end, without completing or dropping it.';

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

/** Retry transient failures (network blips, 429/5xx) with backoff; auth/config errors fail fast. */
export async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal, onRetry?: (attempt: number) => void, tries = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
      const transient = /network|fetch|timeout|timed out|ECONN|socket|429|rate|5\d\d|overload|busy|temporar/i.test(msg) && !/40[134]/.test(msg);
      // Rate limits (429 / concurrency caps) clear up slowly: allow more, longer, jittered waits.
      const limited = /429|rate|concurren|too many/i.test(msg);
      if (signal?.aborted || (e as Error)?.name === 'AbortError' || !transient || attempt >= (limited ? tries * 2 : tries)) throw e;
      onRetry?.(attempt);
      const wait = Math.min(limited ? 30_000 : 12_000, 1500 * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, wait * (0.75 + Math.random() * 0.5)));
      throwIfAborted(signal);
    }
  }
}
