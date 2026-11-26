import { describe, expect, it } from 'vitest';
import type { PageTextModel, ShowOp } from '../engine';
import { analyzePage, findGutters } from '../layout';
import { buildJob, type Job } from '../translatePdf';

let nextId = 1;
function makeOp(text: string, x: number, y: number, extra: Partial<ShowOp> = {}): ShowOp {
  const size = extra.size ?? 10;
  const index = extra.index ?? nextId++;
  return {
    index,
    owner: '',
    opIndex: index,
    id: `#${index}`,
    x,
    y,
    width: extra.width ?? Math.max(4, text.length * size * 0.45),
    size,
    rotated: false,
    fontRes: 'F1',
    baseFont: 'Times-Roman',
    text,
    op: 'Tj',
    tfSize: size,
    state: { Tc: 0, Tw: 0, Tz: 100, Ts: 0, Tr: 0, fill: [0, 0, 0] },
    trm: [size, 0, 0, size, x, y],
    raw: `(${text})`,
    ...extra,
  };
}

function makeModel(ops: ShowOp[]): PageTextModel {
  return {
    pageIndex: 0,
    rotate: 0,
    view: [0, 0, 612, 792],
    ops,
    rules: [],
    graphics: [],
    formUses: {},
  };
}

/**
 * Synthesizes an IEEE Transactions (TASE) first page:
 * - Centered 2-line 22pt title spanning the full page
 * - Centered 11pt author line spanning the full page
 * - Left column [48..300]: 9pt bold Abstract + Note to Practitioners + 8pt footnotes
 * - Right column [312..564] (12pt IEEE gutter!): 9pt bold continuation + centered small-caps "I. Introduction"
 *   + 28pt drop-cap "P" on line 2's baseline + small-caps "ETROLEUM" + 2 indented lines + full-width body lines
 *   (including one right-col line at the EXACT same baseline as a left-col Abstract line!)
 * - Full-width copyright + IEEE Xplore watermark at the bottom (6 full-width lines crossing the gutter)
 */
function buildIeeeFirstPage(headingSmallCapsText: string): { model: PageTextModel; dropCapOp: ShowOp } {
  const ops: ShowOp[] = [];
  const bold = { baseFont: 'Times-Bold', size: 9 };

  // Full-width centered title (2 lines, nearly equal width) & authors
  ops.push(makeOp('A Reinforcement Learning Based Large-Scale', 92, 735, { size: 22, width: 428 }));
  ops.push(makeOp('Refinery Production Scheduling Algorithm', 102, 710, { size: 22, width: 408 }));
  ops.push(makeOp('Yuandong Chen, Jinliang Ding, Senior Member, IEEE, and Qingda Chen, Member, IEEE', 112, 682, { size: 11, width: 388 }));

  // Left column [48..300]: Abstract (9pt bold, pitch 10.5pt)
  const abstractLines = [
    'Abstract—Refinery production scheduling is a mixed-integer',
    'programming problem, which exists the issue of combina-',
    'torial explosion. Thus, solving a large-scale refinery production',
    'scheduling problem is time-consuming. This article proposes an',
    'approximate solution framework based on reinforcement learning',
    '(RL) for large-scale long-time refinery production scheduling',
    'problems to rapidly obtain a satisfactory solution. In the pro-',
    'posed algorithm, the Proximal Policy Optimization algorithm',
    'is used to process the continuous action. To address the cold',
    'start issue of RL in refinery scheduling problem, we present',
    'an initialization method for the actor of agent, which utilizes',
    'the operation knowledge of tractable small-scale problems to',
    'initialize the actor network, and the agent is trained in the',
    'environment of large-scale problems. Hence, the convergence',
    'of the RL algorithm is greatly accelerated. In addition, the',
    'product flowrate concept is used to express the state, making', // y = 650 - 15*10.5 = 492.5 -> exact match with right col!
    'the scheduling agent scalable in terms of scheduling horizon.',
    'Experimental studies show, to large-scale refinery scheduling',
    'problems, the proposed algorithm can obtain better solutions',
    'than that of the CPLEX solver and the existing evolutionary',
    'algorithm in a much shorter solving time of the two methods.',
  ];
  abstractLines.forEach((line, i) => {
    const y = 650 - i * 10.5;
    ops.push(makeOp(line, 48, y, { ...bold, width: i === abstractLines.length - 1 ? 235 : 252 }));
  });

  // Left column footnotes (8pt, pitch 9.2pt — different pitch from right column)
  for (let i = 0; i < 14; i++) {
    ops.push(makeOp(`Manuscript received 27 June 2023; footnote detail line ${i + 1} for IEEE TASE.`, 48, 330 - i * 9.2, { size: 8, width: 252 }));
  }

  // Right column [312..564]: top continuation + Index Terms
  ops.push(makeOp('more and more things will be integrated into one model, leading', 312, 650, { ...bold, width: 252 }));
  ops.push(makeOp('to the traditional solver cannot meet the application needs.', 312, 639.5, { ...bold, width: 240 }));
  ops.push(makeOp('Index Terms—Large-scale optimization, reinforcement learn-', 312, 618, { ...bold, width: 252 }));
  ops.push(makeOp('ing, refinery, scheduling.', 312, 607.5, { ...bold, width: 115 }));

  // Right column: centered small-caps "I. INTRODUCTION" / "I. Introduction" (non-bold, 10pt cap + 7.8pt small caps)
  ops.push(makeOp('I.', 398, 578, { size: 10, width: 9 }));
  ops.push(makeOp('I', 413, 578, { size: 10, width: 4 }));
  ops.push(makeOp(headingSmallCapsText, 417, 578, { size: 7.8, width: 61 }));

  // Right column: Drop-cap "P" (28pt, baseline sits on line 2 = 550.5!) + Line 1 (562.5) + Line 2 (550.5) + Line 3+
  const dropCapOp = makeOp('P', 312, 550.5, { size: 28, width: 18 });
  ops.push(dropCapOp);
  // Line 1 (indented right of P): small-caps "ETROLEUM" (7.8pt) + regular body text (10pt)
  ops.push(makeOp('ETROLEUM', 333, 562.5, { size: 7.8, width: 44 }));
  ops.push(makeOp('refinery industry plays a key role in the', 380, 562.5, { size: 10, width: 184 }));
  // Line 2 (indented right of P, exact same baseline as drop-cap P!)
  ops.push(makeOp('national economy, which provides the main produc-', 333, 550.5, { size: 10, width: 231 }));
  // Lines 3..8 (full right-column width [312..564], pitch 12pt; Line 6 at 502.5 is within 0.5pt of Abstract line 15 at 503.0!)
  const introBody: [number, string][] = [
    [538.5, 'tion energy and supplies a wide range of daily necessities.'],
    [526.5, 'The petroleum refinery system is very complex, involving'],
    [514.5, 'multi-kind material flows and different stages (i.e. crude oil'],
    [502.5, 'processing, component processing, blending, and distribution'], // collides vertically (0.5pt) with Abstract!
    [490.5, 'process), bearing interaction of quality and energy, and uti-'],
    [478.5, 'lizing multi-quality components and multi-level energies [1].'],
  ];
  for (const [y, text] of introBody) {
    ops.push(makeOp(text, 312, y, { size: 10, width: 252 }));
  }
  // Additional right column lines so column density matches a real page
  for (let i = 0; i < 16; i++) {
    ops.push(makeOp(`Furthermore, discrete-time modeling handles scheduling horizon step ${i + 1}.`, 312, 445 - i * 12, { size: 10, width: 252 }));
  }

  // Bottom full-width IEEE copyright + Xplore watermark (3 more lines crossing the gutter -> 6 total)
  ops.push(makeOp('1545-5955 © 2023 IEEE. Personal use is permitted, but republication/redistribution requires IEEE permission.', 90, 55, { size: 7.5, width: 430 }));
  ops.push(makeOp('See https://www.ieee.org/publications/rights/index.html for more information.', 155, 45, { size: 7.5, width: 300 }));
  ops.push(makeOp('Authorized licensed use limited to: East China Univ of Science and Tech. Restrictions apply.', 110, 30, { size: 7.5, width: 390 }));

  return { model: makeModel(ops), dropCapOp };
}

describe('IEEE 2-column first page layout', () => {
  it('detects the 12pt gutter despite full-width title/authors/footer and unaligned column pitches', () => {
    const { model } = buildIeeeFirstPage('ntroduction');
    const gutters = findGutters(model.ops);
    expect(gutters.length).toBeGreaterThanOrEqual(1);
    expect(gutters.some(([g0, g1]) => g0 >= 299 && g1 <= 313 && g1 - g0 >= 8)).toBe(true);
  });

  it('keeps Abstract and Introduction strictly separated across the gutter, folds drop-cap P, protects heading and authors', () => {
    for (const scText of ['NTRODUCTION', 'ntroduction']) {
      const { model, dropCapOp } = buildIeeeFirstPage(scText);
      const layout = analyzePage(model, { pageIndex: 0 });

      // 1. Title is classified as title (not overshadowed by 28pt drop-cap P) and centered across the page
      const title = layout.blocks.find((b) => b.kind === 'title');
      expect(title, scText).toBeDefined();
      expect(title!.align).toBe('center');
      expect(title!.lines.map((l) => l.text).join(' ')).toContain('Reinforcement Learning');

      // 2. Authors are kept untranslated as 'author'
      const authors = layout.blocks.find((b) => b.kind === 'author');
      expect(authors, scText).toBeDefined();
      expect(authors!.translate).toBe(false);
      expect(authors!.lines[0].text).toContain('Yuandong Chen');

      // 3. Abstract stays intact in the left column (no stolen "product flowrate..." line)
      const abstract = layout.blocks.find((b) => b.lines[0].text.startsWith('Abstract—'));
      expect(abstract, scText).toBeDefined();
      const abstractText = abstract!.lines.map((l) => l.text).join(' ');
      expect(abstractText).toContain('product flowrate concept is used to express the state, making');
      expect(abstractText).toContain('the scheduling agent scalable');
      expect(abstractText).not.toContain('processing, component processing');
      expect(abstract!.box.x1).toBeLessThanOrEqual(305);

      // 4. "I. INTRODUCTION" / "I. Introduction" is its own centered heading block with zero formula placeholders
      const heading = layout.blocks.find((b) => b.kind === 'heading' && /^I\.\s+I/i.test(b.lines[0].text));
      expect(heading, scText).toBeDefined();
      expect(heading!.lines).toHaveLength(1);
      expect(heading!.align).toBe('center');
      const headingJob = buildJob(heading!) as Job;
      expect(typeof headingJob).toBe('object');
      expect(headingJob.formulas).toHaveLength(0);
      expect(headingJob.source).toBe(`I. I${scText}`);

      // 5. Drop-cap "P" folds into ONE clean right-column body paragraph starting with "PETROLEUM refinery..."
      const intro = layout.blocks.find((b) => b.kind === 'body' && b.lines[0].text.startsWith('PETROLEUM refinery'));
      expect(intro, scText).toBeDefined();
      expect(intro!.box.x0).toBeCloseTo(312, 0);
      expect(intro!.size).toBe(10);
      expect(intro!.ops).toContain(dropCapOp);
      const introJob = buildJob(intro!) as Job;
      expect(typeof introJob).toBe('object');
      expect(introJob.formulas).toHaveLength(0);
      expect(introJob.source).toMatch(/^PETROLEUM refinery industry plays a key role in the national economy, which provides the main production energy/);
      expect(introJob.source).toContain('processing, component processing, blending, and distribution');
      expect(introJob.source).not.toContain('product flowrate');
    }
  });

  it('inserts a space for article drop-cap "A" before a regular lowercase word', () => {
    const ops: ShowOp[] = [
      makeOp('A', 72, 688, { size: 26, width: 18 }),
      makeOp('novel reinforcement learning method is proposed', 96, 700, { size: 10, width: 220 }),
      makeOp('for solving large-scale industrial scheduling', 96, 688, { size: 10, width: 220 }),
      makeOp('problems efficiently under strict time budgets.', 72, 676, { size: 10, width: 244 }),
    ];
    const layout = analyzePage(makeModel(ops), { pageIndex: 1 });
    expect(layout.blocks).toHaveLength(1);
    const job = buildJob(layout.blocks[0]) as Job;
    expect(job.source).toBe('A novel reinforcement learning method is proposed for solving large-scale industrial scheduling problems efficiently under strict time budgets.');
  });

  it('does not detect false gutters on a single-column page', () => {
    const ops: ShowOp[] = [];
    for (let i = 0; i < 30; i++) {
      ops.push(makeOp(`This is a standard single-column academic paper line number ${i + 1} with normal width.`, 72, 720 - i * 14, { size: 10, width: 468 }));
    }
    expect(findGutters(ops)).toEqual([]);
  });
});
