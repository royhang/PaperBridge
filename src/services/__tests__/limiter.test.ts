import { describe, expect, it } from 'vitest';
import { createLimiter } from '../limiter';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('bulk request limiter', () => {
  it('never runs more than the cap at once and keeps the slots busy', async () => {
    const lim = createLimiter(() => 3);
    let running = 0;
    let peak = 0;
    const job = () =>
      lim.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
      });
    await Promise.all(Array.from({ length: 10 }, job));
    expect(peak).toBe(3);
    expect(lim.active).toBe(0);
  });

  it('serves urgent requests first, then the others in order', async () => {
    const lim = createLimiter(() => 1);
    const first = await lim.acquire();
    const order: string[] = [];
    const a = lim.run(async () => void order.push('a'));
    const b = lim.run(async () => void order.push('b'));
    const repair = lim.run(async () => void order.push('repair'), true);
    first();
    await Promise.all([a, b, repair]);
    expect(order).toEqual(['repair', 'a', 'b']);
  });

  it('drops a waiter whose request is cancelled', async () => {
    const lim = createLimiter(() => 1);
    const hold = await lim.acquire();
    const ctrl = new AbortController();
    const waiting = lim.acquire(false, ctrl.signal);
    ctrl.abort();
    await expect(waiting).rejects.toBeDefined();
    expect(lim.waiting).toBe(0);
    hold();
    hold(); // releasing twice frees one slot only
    expect(lim.active).toBe(0);
  });

  it('releases the slot when the request fails', async () => {
    const lim = createLimiter(() => 1);
    await expect(lim.run(async () => Promise.reject(new Error('429')))).rejects.toThrow('429');
    let ran = false;
    await lim.run(async () => void (ran = true));
    expect(ran).toBe(true);
  });

  it('follows a changed setting and survives a missing one', async () => {
    let cap = 1;
    const lim = createLimiter(() => cap);
    const h1 = await lim.acquire();
    let second = false;
    void lim.acquire().then(() => (second = true));
    await tick();
    expect(second).toBe(false);
    cap = 2;
    h1();
    await tick();
    expect(second).toBe(true);
    const broken = createLimiter(() => undefined as unknown as number);
    await broken.run(async () => undefined);
  });
});
