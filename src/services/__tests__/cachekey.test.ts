import { describe, expect, it } from 'vitest';
import { cacheKey } from '../translate';

type Snap = Parameters<typeof cacheKey>[0];
const base = {
  cfg: { id: 'x', name: 'X', kind: 'openai', apiKey: 'k', model: 'm' },
  provider: {},
  from: 'auto',
  to: 'zh',
  template: 'Translate {{from}} to {{to}}.{{context}}',
  glossary: [],
  title: 'arXiv 1706.03762',
  extra: '',
} as unknown as Snap;

describe('cacheKey', () => {
  it('survives a document rename (title only feeds the prompt context)', async () => {
    expect(await cacheKey({ ...base, title: 'Attention Is All You Need' }, 'hello')).toBe(await cacheKey(base, 'hello'));
  });
  it('still separates models, languages and extra rules', async () => {
    const k = await cacheKey(base, 'hello');
    expect(await cacheKey({ ...base, to: 'ja' } as Snap, 'hello')).not.toBe(k);
    expect(await cacheKey({ ...base, extra: 'keep {v0}' }, 'hello')).not.toBe(k);
    expect(await cacheKey({ ...base, cfg: { ...base.cfg, model: 'n' } }, 'hello')).not.toBe(k);
  });
});
