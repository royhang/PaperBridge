import { describe, expect, it } from 'vitest';
import { buildBatchUserMessage, parseBatchReply, segmentStream } from '../translate';

describe('batch <seg> protocol', () => {
  it('builds numbered segments', () => {
    expect(buildBatchUserMessage(['a', 'b'])).toContain('<seg id="1">a</seg>\n<seg id="2">b</seg>');
  });
  it('parses replies in any order and with surrounding chatter', () => {
    expect(parseBatchReply('Sure!\n<seg id="2">乙</seg>\n<seg id=1> 甲 </seg>', 2)).toEqual(['甲', '乙']);
  });
  it('rejects missing, duplicate, empty or out-of-range ids', () => {
    expect(parseBatchReply('<seg id="1">甲</seg>', 2)).toBeNull();
    expect(parseBatchReply('<seg id="1"></seg><seg id="1">甲</seg>', 2)).toBeNull();
    expect(parseBatchReply('<seg id="1">甲</seg><seg id="1">乙</seg>', 2)).toBeNull();
    expect(parseBatchReply('<seg id="1">甲</seg><seg id="3">乙</seg>', 2)).toBeNull();
  });
});

describe('streaming <seg> replies', () => {
  it('emits each segment once, as soon as it is closed', () => {
    const got: [number, string][] = [];
    const feed = segmentStream(3, (i, t) => got.push([i, t]));
    const reply = '<seg id="1">甲</seg>\n<seg id="2">乙乙</seg>\n<seg id="3">丙</seg>';
    for (let n = 1; n <= reply.length; n++) feed(reply.slice(0, n));
    expect(got).toEqual([[0, '甲'], [1, '乙乙'], [2, '丙']]);
  });
  it('waits for the closing tag and skips junk ids or empty segments', () => {
    const got: [number, string][] = [];
    const feed = segmentStream(2, (i, t) => got.push([i, t]));
    feed('<seg id="1">半句');
    expect(got).toEqual([]);
    feed('<seg id="1">半句</seg><seg id="5">x</seg><seg id="2"> </seg>');
    expect(got).toEqual([[0, '半句']]);
  });
});
