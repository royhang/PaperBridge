import { describe, expect, it } from 'vitest';
import { buildPaperContext, extractReferencedPages, rankPagesBm25, tokenize, type PageText } from '../bm25';

describe('Zero-dependency bilingual BM25 long-PDF retriever', () => {
  it('tokenizes mixed English technical identifiers and Chinese bigrams', () => {
    const toks = tokenize('基于 PPO 算法的炼油厂调度问题 (CPLEX baseline)');
    expect(toks).toContain('ppo');
    expect(toks).toContain('cplex');
    expect(toks).toContain('baseline');
    expect(toks).toContain('炼油');
    expect(toks).toContain('调度');
  });

  it('extracts explicitly mentioned page numbers in Chinese and English', () => {
    expect(extractReferencedPages('请解释第 87 页的表 3 和 p.102 以及 page 5', 120)).toEqual([87, 102, 5]);
    expect(extractReferencedPages('第 999 页超出范围', 100)).toEqual([]);
  });

  it('returns untouched full text for normal papers (<= fullLimit) to preserve Prompt Caching', () => {
    const pages: PageText[] = Array.from({ length: 12 }, (_, i) => ({
      page: i + 1,
      text: `Page ${i + 1} content about transformer attention mechanisms.`,
    }));
    const res = buildPaperContext(pages, { query: '总结全文', currentPage: 1 });
    expect(res.mode).toBe('full');
    expect(res.selectedPages).toHaveLength(12);
    expect(res.context).toContain('[p.12]');
  });

  it('switches to local BM25 on 120-page PDFs and retrieves needle pages from the back half', () => {
    const filler = 'Generic background discussion on industrial optimization and control theory. '.repeat(30);
    const pages: PageText[] = Array.from({ length: 120 }, (_, i) => ({
      page: i + 1,
      text:
        i === 0
          ? 'Dissertation Title: Large-Scale Refinery Scheduling. Abstract: We study scheduling.'
          : i === 86
            ? 'Table 5 experimental comparison: CPLEX solver took 3600 seconds while our PPO-Refinery agent finished in 14.2 seconds with 9.8% higher profit. 炼油调度求解时间对比实验。'
            : i === 104
              ? 'Appendix B: Hyperparameter sensitivity for learning rate alpha = 3e-4 and clipping epsilon = 0.2.'
              : filler,
    }));

    const ranked = rankPagesBm25(pages, 'CPLEX 和 PPO-Refinery 的炼油调度求解时间对比是多少秒？');
    expect(ranked[0].page).toBe(87);

    const res = buildPaperContext(pages, {
      query: 'CPLEX 和 PPO-Refinery 的炼油调度求解时间对比是多少秒？另外第 105 页的超参数是什么？',
      currentPage: 12,
      fullLimit: 120_000,
      ragBudget: 35_000,
    });
    expect(res.mode).toBe('bm25');
    expect(res.totalPages).toBe(120);
    // Front matter (p.1), current reading page (p.12), BM25 top hit (p.87), and explicit page ref (p.105) are all included!
    expect(res.selectedPages).toContain(1);
    expect(res.selectedPages).toContain(12);
    expect(res.selectedPages).toContain(87);
    expect(res.selectedPages).toContain(105);
    expect(res.context).toContain('14.2 seconds');
    expect(res.context).toContain('3e-4');
    expect(res.usedChars).toBeLessThan(res.totalChars * 0.25);
  });
});
