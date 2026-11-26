import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/db';
import { parseCnkiFileName, parseEndNote, parseGb7714, parseNoteExpress, parseReferences, parseRIS, parseRefWorks } from '../cnki';
import { importReferencesText, saveConnectorItem } from '../service';

describe('CNKI & Chinese reference parsers', () => {
  beforeEach(async () => {
    await db.docs.clear();
    await db.collections.clear();
  });

  it('parses CNKI standard PDF filenames (标题_第一作者.pdf)', () => {
    expect(parseCnkiFileName('变与不变：从“全面从严治党”到“持之以恒推进全面从严治党”的辩证逻辑_徐凯翔.pdf')).toEqual({
      title: '变与不变：从“全面从严治党”到“持之以恒推进全面从严治党”的辩证逻辑',
      author: '徐凯翔',
    });
    expect(parseCnkiFileName('类ChatGPT人工智能背景下国家安全情报工作的机遇_李锋_2023 (1).pdf')).toEqual({
      title: '类ChatGPT人工智能背景下国家安全情报工作的机遇',
      author: '李锋',
      year: 2023,
    });
    expect(parseCnkiFileName('1706.03762.pdf')).toEqual({});
  });

  it('parses CNKI GB/T 7714 citations (journal & thesis)', () => {
    const text = `
[1] 徐凯翔, 王永贵. 变与不变：从“全面从严治党”到“持之以恒推进全面从严治党”的辩证逻辑[J]. 西北工业大学学报(社会科学版), 2026(06): 42-49.
[2] 张三. 基于大语言模型的学术检索研究[D]. 清华大学, 2024.
`;
    const items = parseGb7714(text);
    expect(items).toHaveLength(2);
    expect(items[0].meta).toMatchObject({
      title: '变与不变：从“全面从严治党”到“持之以恒推进全面从严治党”的辩证逻辑',
      venue: '西北工业大学学报(社会科学版)',
      year: 2026,
      issue: '06',
      pages: '42-49',
      type: 'article',
    });
    expect(items[0].meta.authors).toEqual([
      { family: '徐', given: '凯翔' },
      { family: '王', given: '永贵' },
    ]);
    expect(items[1].meta).toMatchObject({
      title: '基于大语言模型的学术检索研究',
      publisher: '清华大学',
      year: 2024,
      type: 'thesis',
    });
  });

  it('parses NoteExpress, RIS, EndNote (.enw), and RefWorks with keywords as tags', () => {
    const ne = parseNoteExpress(`
{Reference Type}: Journal Article
{Title}: 类ChatGPT人工智能背景下国家安全情报工作的机遇、挑战和应对
{Author}: 李锋
{Journal}: 情报理论与实践
{Year}: 2024
{Issue}: 01
{Pages}: 12-19
{Keywords}: 情报; 国家安全; 人工智能; ChatGPT
{Abstract}: 摘要内容测试。
`);
    expect(ne).toHaveLength(1);
    expect(ne[0].meta.venue).toBe('情报理论与实践');
    expect(ne[0].tags).toEqual(['情报', '国家安全', '人工智能', 'ChatGPT']);

    const ris = parseRIS(`
TY  - JOUR
TI  - 中文测试论文标题研究
AU  - 王小明
JF  - 计算机学报
PY  - 2025
VL  - 48
IS  - 2
SP  - 100
EP  - 115
KW  - 大模型
KW  - 知识图谱
DO  - 10.11897/SP.J.1016.2025.00100
ER  -
`);
    expect(ris).toHaveLength(1);
    expect(ris[0].meta).toMatchObject({ venue: '计算机学报', volume: '48', issue: '2', pages: '100-115', doi: '10.11897/SP.J.1016.2025.00100' });
    expect(ris[0].tags).toEqual(['大模型', '知识图谱']);

    const enw = parseEndNote(`
%0 Journal Article
%T 端到端学术文献翻译评测
%A 陈思
%J 中文信息学报
%D 2025
%V 39
%N 3
%P 55-64
%K 机器翻译; 学术论文
`);
    expect(enw).toHaveLength(1);
    expect(enw[0].meta.venue).toBe('中文信息学报');
    expect(enw[0].tags).toEqual(['机器翻译', '学术论文']);

    const rw = parseRefWorks(`
RT Journal Article
T1 知识增强的文献综述生成方法
A1 赵六
JF 软件学报
YR 2025
VO 36
IS 4
SP 1200
OP 1218
K1 综述生成;大语言模型
`);
    expect(rw).toHaveLength(1);
    expect(rw[0].meta.pages).toBe('1200-1218');
    expect(rw[0].tags).toEqual(['综述生成', '大语言模型']);

    expect(parseReferences('@article{k, title={Test}, author={A, B}, year={2025}}')).toHaveLength(1);
  });

  it('imports CNKI references and merges connector saves without duplicating', async () => {
    const res = await importReferencesText(
      '[1] 李锋. 类ChatGPT人工智能背景下国家安全情报工作的机遇、挑战和应对[J]. 情报理论与实践, 2024(01): 12-19.',
      'col-ai',
    );
    expect(res.added).toBe(1);
    const saved = await saveConnectorItem({
      meta: {
        title: '类ChatGPT人工智能背景下国家安全情报工作的机遇、挑战和应对',
        authors: [{ family: '李', given: '锋' }],
        venue: '情报理论与实践',
        year: 2024,
        abstract: '补全的摘要',
        type: 'article',
      },
      tags: ['ChatGPT', '国家安全'],
      collectionId: 'col-ai',
    });
    expect(saved.duplicate).toBe(true);
    expect(saved.docId).toBe(res.docIds[0]);
    const doc = await db.docs.get(saved.docId);
    expect(doc?.meta.abstract).toBe('补全的摘要');
    expect(doc?.tags).toEqual(['ChatGPT', '国家安全']);
  });
});
