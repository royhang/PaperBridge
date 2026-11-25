import { describe, expect, it } from 'vitest';
import { csvCell, parseDelimited, parseGlossary } from '../csv';

describe('csv', () => {
  it('round-trips quoted cells', () => {
    const rows = [['Washington, DC', '华盛顿特区', 'has "quotes"'], ['a\nb', 'x', '']];
    const text = rows.map((r) => r.map(csvCell).join(',')).join('\n');
    expect(parseDelimited(text)).toEqual(rows);
  });
  it('handles CRLF, BOM, header and comments', () => {
    const g = parseGlossary('﻿source,target,note\r\n# comment\r\nattention,注意力\r\n"key, value",键值,note, with comma\r\n');
    expect(g).toEqual([
      { source: 'attention', target: '注意力', note: undefined },
      { source: 'key, value', target: '键值', note: 'note, with comma' },
    ]);
  });
  it('detects TSV', () => {
    expect(parseGlossary('token\t词元\nembedding\t嵌入')).toEqual([
      { source: 'token', target: '词元', note: undefined },
      { source: 'embedding', target: '嵌入', note: undefined },
    ]);
  });
});
