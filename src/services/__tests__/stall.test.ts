import { describe, expect, it, vi } from 'vitest';
import { StallError, stallGuard } from '../translate';
import { withRetry } from '../../pdfout/common';

const hang = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));

describe('stallGuard', () => {
  it('turns a hung request into a retryable StallError', async () => {
    vi.useFakeTimers();
    const p = stallGuard(undefined, 1000, 500).run(hang);
    const check = expect(p).rejects.toBeInstanceOf(StallError);
    await vi.advanceTimersByTimeAsync(1001);
    await check;
    // withRetry treats it as transient
    let n = 0;
    const r = withRetry(async () => {
      if (++n === 1) throw new StallError(90);
      return 'ok';
    });
    await vi.runAllTimersAsync();
    await expect(r).resolves.toBe('ok');
    vi.useRealTimers();
  });

  it('keeps streaming requests alive while data arrives, and honours user aborts', async () => {
    vi.useFakeTimers();
    const g = stallGuard(undefined, 1000, 500);
    const p = g.run(async (signal) => {
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 400));
        if (signal.aborted) throw new Error('aborted');
        g.tick();
      }
      return 'done';
    });
    await vi.advanceTimersByTimeAsync(2500);
    await expect(p).resolves.toBe('done');

    const user = new AbortController();
    const q = stallGuard(user.signal, 1000, 500).run(hang);
    const check = expect(q).rejects.toMatchObject({ name: 'AbortError' });
    user.abort();
    await check;
    vi.useRealTimers();
  });
});
