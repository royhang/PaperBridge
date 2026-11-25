// @vitest-environment node
import { describe, expect, it } from 'vitest';

describe('escape layering (logic)', () => {
  it('dialogs beat panels regardless of mount order; newest wins within a level', () => {
    type E = { level: number; seq: number; name: string };
    const pick = (s: E[]) => s.reduce((a, b) => (b.level > a.level || (b.level === a.level && b.seq > a.seq) ? b : a)).name;
    expect(pick([{ level: 10, seq: 1, name: 'dialog' }, { level: 0, seq: 2, name: 'panel' }])).toBe('dialog');
    expect(pick([{ level: 10, seq: 1, name: 'd1' }, { level: 10, seq: 3, name: 'd2' }, { level: 0, seq: 4, name: 'p' }])).toBe('d2');
  });
});
