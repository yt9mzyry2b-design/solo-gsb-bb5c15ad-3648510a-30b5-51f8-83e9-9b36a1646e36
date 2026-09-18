import { parseDocument } from '../src/lib/parser';
import { analyze } from '../src/lib/analyzer';
import { applyStructuralChange } from '../src/lib/rewriter';
import { scanReferences } from '../src/lib/scanner';
import { parseOrdinal, formatChinese } from '../src/lib/numeral';
import { diffDocuments, diffText, MAX_LCS_CHARS } from '../src/lib/diff';
import { createSnapshot, sanitizeSnapshots } from '../src/lib/snapshot';
import { cloneTree, renumberAll } from '../src/lib/tree';
import {
  createAnnotation,
  relocateAnnotations,
  sanitizeAnnotations,
  findAll,
} from '../src/lib/annotations';
import {
  applyUsageReplace,
  createUsageRule,
  normalizeRule,
  sanitizeUsageRules,
  scanUsage,
  scanUsageText,
  verifyUsageHits,
} from '../src/lib/usage';
import { assert } from 'node:console';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`✗ ${name} ${extra}`);
  }
}

// ---- 数字解析 ----
check('中文 一', parseOrdinal('一')?.value === 1);
check('中文 十', parseOrdinal('十')?.value === 10);
check('中文 二十三', parseOrdinal('二十三')?.value === 23);
check('中文 一百零五', parseOrdinal('一百零五')?.value === 105);
check('阿拉伯 12', parseOrdinal('12')?.value === 12);
check('全角 １２', parseOrdinal('１２')?.value === 12);
check('零非法', parseOrdinal('零') === null);
check('格式 23→二十三', formatChinese(23) === '二十三', formatChinese(23));
check('格式 105→一百零五', formatChinese(105) === '一百零五', formatChinese(105));
check('格式 10→十', formatChinese(10) === '十', formatChinese(10));

// ---- 扫描器 ----
const spans = scanReferences(
  '依第五条第二款第（一）项及本条第三款、前款第（二）项、前项、后条、第十二条规定。',
);
const raws = spans.map((s) => s.raw);
check('绝对条款项', raws.includes('第五条第二款第（一）项'), JSON.stringify(raws));
check('本条', raws.includes('本条第三款'), JSON.stringify(raws));
check('前款', raws.some((r) => r.startsWith('前款')), JSON.stringify(raws));
check('前项', raws.includes('前项'), JSON.stringify(raws));
check('后条', raws.includes('后条'), JSON.stringify(raws));
check('第十二条', raws.includes('第十二条'), JSON.stringify(raws));

// ---- 解析 ----
const text = `测试办法

第一条【目的】
为了测试，适用第三条和第四条第一款的规定。

第二条【范围】
本法适用范围如下：
（一）情形一，参见第三条第二款；
（二）情形二，参见前款和第五条。

第三条【程序一】
第一款内容。
本条第二款引用第四条，本条第三款引用第六条造成循环。

第四条【程序二】
本条援引第三条形成循环。
另引用不存在的第二十条。

第五条【附则】
最后一条引用前条。`;

const { doc } = parseDocument(text);
check('解析出 5 条', doc.root.length === 5, String(doc.root.length));
check('标题', doc.title === '测试办法', doc.title);
// 第三条：第一段“第一款内容。”结束后换行，第二段为“本条第二款…循环。”
check('第三条有 2 款', doc.root[2].children.length === 2, String(doc.root[2].children.length));
check('第二条有 1 款 2 项', doc.root[1].children.length === 1 && doc.root[1].children[0].children.length === 2);

let a = analyze(doc, { confirmed: {} });
check('存在断链(第二十条)', a.issues.some((i) => i.type === 'broken' && i.message.includes('二十')), JSON.stringify(a.issues.map(i=>i.message)));
check('存在循环(三<->四)', a.issues.some((i) => i.type === 'cycle'), JSON.stringify(a.issues.map(i=>i.type)));
const okRef = a.occurrences.find((o) => o.span.raw === '第三条');
check('"第三条" 唯一定位', okRef?.resolution.status === 'ok' && okRef.resolution.targetId === doc.root[2].id);
const paraRef = a.occurrences.find((o) => o.span.raw === '第四条第一款');
check('"第四条第一款" 定位到款', paraRef?.resolution.status === 'ok' && paraRef.resolution.targetId === doc.root[3].children[0].id);
check('边数量>0', a.edges.length > 5, String(a.edges.length));

// ---- 原子改写：把第三条移动到末尾（3->5, 4->3, 5->4） ----
const root = doc.root.map((n) => n);
const result = applyStructuralChange(doc, a, (r) => {
  const third = r.splice(2, 1)[0];
  r.push(third);
});
check('改写数量 > 0', result.rewritten > 0, String(result.rewritten));
const a2 = analyze(result.doc, { confirmed: {} });
const texts = JSON.stringify(result.doc);
check('原"第三条"被改写', !texts.includes('适用第三条和'), texts.match(/适用第[^，。]*/)?.[0] ?? '');
check('指向移动条的引用变为第五条', texts.includes('适用第五条'), texts.match(/适用第[^，。]*/)?.[0] ?? '');
// 循环引用应依然存在（三/四换了编号但文本都改写后仍互指）
check('改写后仍检出循环', a2.issues.some((i) => i.type === 'cycle'), JSON.stringify(a2.issues.map(i=>i.type)));
// 断链依然存在
check('断链保留', a2.issues.some((i) => i.type === 'broken'));
// 移动后新位置条
check('移动后原第三条位于第 5 位', result.doc.root[4].id === doc.root[2].id);

// ---- 自引用检测 ----
const selfText = `第一条
本款就是本款。`;
const selfDoc = parseDocument(selfText).doc;
const selfAnalysis = analyze(selfDoc, { confirmed: {} });
check(
  '自引用检出（本项/本款自指）',
  selfAnalysis.issues.some((i) => i.type === 'self'),
  JSON.stringify(selfAnalysis.issues.map((i) => i.message)),
);

// 条内绝对回指本条 → 自引用；相对“本条”不算
const absSelf = parseDocument(`第五条
本条规定按第五条执行。`).doc;
absSelf.root[0].ordinal = 5;
const absSelfA = analyze(absSelf, { confirmed: {} });
const selfCount = absSelfA.issues.filter((i) => i.type === 'self').length;
check('绝对回指本条计 1 次自引用，本条相对引用不计', selfCount === 1, String(selfCount));

// ---- 歧义：同序号条 ----
const amb = parseDocument(`第八条
参见第八条。

第八条之一
补充规定。`).doc;
// parser 不生成后缀，手工标记
amb.root[1].suffix = '一';
const ambA = analyze(amb, { confirmed: {} });
check('同序号歧义', ambA.issues.some((i) => i.type === 'ambiguous'), JSON.stringify(ambA.issues.map(i=>i.message)));

// ---- 版本对比：节点差异（新增 / 删除 / 修改 / 移动，移动且修改同时保留） ----
{
  const base = parseDocument(`比较法

第一条【一】
初始正文，引用第三条。

第二条【二】
第二条内容。

第三条【三】
第三条内容。`).doc;
  renumberAll(base.root);
  const baseA = analyze(base, { confirmed: {} });

  // 修改版：第一条改正文（条头）并移动到末尾（同一节点同时移动+修改）；删除第二条；末尾新增一条
  const root2 = cloneTree(base.root);
  root2[0].text = '修改后的条头正文。';
  const first = root2.shift()!; // 移除第一条
  root2.shift(); // 移除第二条 → 余下 [第三条]
  root2.push(first); // [第三条, 第一条]
  root2.push({ id: 'art-new', kind: 'article', ordinal: 0, text: '', children: [
    { id: 'par-new', kind: 'paragraph', ordinal: 1, text: '新增条内容。', children: [] },
  ] });
  renumberAll(root2);
  const modified: typeof base = { ...base, root: root2, updatedAt: base.updatedAt + 1 };
  const modA = analyze(modified, { confirmed: {} });

  const d = diffDocuments(baseA, modA, base, modified);

  const firstArticle = d.entries.get(base.root[0].id)!;
  check('移动的条标记 moved', firstArticle.moved === true, JSON.stringify(firstArticle));
  check('移动且改正文同时标记 contentModified', firstArticle.contentModified === true);
  check('同一节点保留两类变化', firstArticle.moved && firstArticle.contentModified);
  check('移动的款（留位同序）无差异条目', d.entries.get(base.root[0].children[0].id) === undefined);
  const secondEntry = d.entries.get(base.root[1].id)!;
  check('删除的条标记 removed', secondEntry.removed === true);
  check('新增的条标记 added', d.entries.get('art-new')?.added === true);
  check('新增条下的款也标记 added', d.entries.get('par-new')?.added === true);
  check('计数：删除 1', d.counts.removed === 1, String(d.counts.removed));
  check('计数：新增 2（条+款）', d.counts.added === 2, String(d.counts.added));
  check('计数：正文修改 1', d.counts.modified === 1, String(d.counts.modified));
  // 顺序变为 [三, 一, 新增]：条级移动 2（三、一），其余条的款随同级 ordinal 变化亦计移动
  check('计数：位置移动 ≥ 3（含随父重排的款）', d.counts.moved >= 3, String(d.counts.moved));

  // 仅移动不改正文：不应标记 contentModified
  const root3 = cloneTree(base.root);
  const movedFirst = root3.shift()!;
  root3.push(movedFirst);
  renumberAll(root3);
  const movedDoc = { ...base, root: root3 };
  const d3 = diffDocuments(baseA, analyze(movedDoc, { confirmed: {} }), base, movedDoc);
  const e3 = d3.entries.get(base.root[0].id)!;
  check('只移动未改正文：moved=true、contentModified=false', e3.moved && !e3.contentModified, JSON.stringify(e3));

  // 新增条的子孙也应标记为 added
  const withChild = cloneTree(base.root);
  withChild.push({
    id: 'art-c',
    kind: 'article',
    ordinal: 0,
    text: '',
    children: [
      { id: 'par-c', kind: 'paragraph', ordinal: 1, text: '新款', children: [
        { id: 'itm-c', kind: 'item', ordinal: 1, text: '新项', children: [] },
      ] },
    ],
  });
  renumberAll(withChild);
  const docChild = { ...base, root: withChild };
  const dChild = diffDocuments(baseA, analyze(docChild, { confirmed: {} }), base, docChild);
  check('新增条下的款也标记 added', dChild.entries.get('par-c')?.added === true);
  check('新增条下的项也标记 added', dChild.entries.get('itm-c')?.added === true);
}

// ---- 版本对比：引用差异按 源节点ID+原文+同文序次 对齐 ----
{
  const refDoc = parseDocument(`引用法

第一条
见第三条。

第二条
保留。

第三条
被引用的条。`).doc;
  renumberAll(refDoc.root);
  const refA = analyze(refDoc, { confirmed: {} });
  const firstParaId = refDoc.root[0].children[0].id;

  // 把第三条移到最前且不原子改写文本：原“第三条”（原文不变）解析到不同稳定节点 → 目标变化
  const rootB = cloneTree(refDoc.root);
  const third = rootB.splice(2, 1)[0];
  rootB.unshift(third); // [三, 一, 二]
  renumberAll(rootB);
  const docB = { ...refDoc, root: rootB };
  const aB = analyze(docB, { confirmed: {} });
  const d = diffDocuments(refA, aB, refDoc, docB);
  check(
    '原文不变但解析目标改变 → 目标变化 1 条',
    d.refRetargeted.length === 1 && d.refRetargeted[0].raw === '第三条',
    JSON.stringify(d.refRetargeted.map((r) => [r.raw, r.oldTargetId, r.newTargetId])),
  );
  check('目标变化项记录源节点稳定 ID', d.refRetargeted[0].nodeId === firstParaId);

  // 直接改正文：把引用改成“第二条”
  const rootC = cloneTree(refDoc.root);
  rootC[0].children[0].text = '见第二条。';
  const docC = { ...refDoc, root: rootC };
  const dC = diffDocuments(refA, analyze(docC, { confirmed: {} }), refDoc, docC);
  check('引用移除 1（第三条）', dC.refRemoved.length === 1 && dC.refRemoved[0].raw === '第三条', JSON.stringify(dC.refRemoved.map((r) => r.raw)));
  check('引用新增 1（第二条）', dC.refAdded.length === 1 && dC.refAdded[0].raw === '第二条', JSON.stringify(dC.refAdded.map((r) => r.raw)));

  // 同文序次：同节点两条相同原文，删去第二次出现应只标记第二次移除
  const dupDoc = parseDocument(`重复法

第一条
两次引用：见第三条；再次见第三条。

第二条
中间条。

第三条
目标条。`).doc;
  renumberAll(dupDoc.root);
  const dupA = analyze(dupDoc, { confirmed: {} });
  const rootD = cloneTree(dupDoc.root);
  rootD[0].children[0].text = '两次引用：见第三条。';
  const dupDoc2 = { ...dupDoc, root: rootD };
  const dD = diffDocuments(dupA, analyze(dupDoc2, { confirmed: {} }), dupDoc, dupDoc2);
  check('同文序次对齐：移除第二次出现', dD.refRemoved.length === 1 && dD.refRemoved[0].occurrenceIndex === 2, String(dD.refRemoved[0]?.occurrenceIndex));
  check('同文序次对齐：第一次出现保留（非新增）', dD.refAdded.length === 0, String(dD.refAdded.length));
}

// ---- 快照：只读、旧数据缺省为空列表 ----
{
  const s = parseDocument(`快照法

第一条
内容。`).doc;
  renumberAll(s.root);
  const snap = createSnapshot(s, {}, '一审稿');
  check('快照名称保留', snap.name === '一审稿');
  check('快照与正文脱离引用（深拷贝）', snap.doc.root[0] !== s.root[0]);
  let froze = false;
  try {
    'use strict';
    (snap as unknown as { name: string }).name = 'x';
    froze = snap.name === '一审稿';
  } catch {
    froze = true;
  }
  check('快照只读（冻结）', froze);
  check('旧数据缺少 snapshots → 空列表', sanitizeSnapshots(undefined).length === 0);
  check('非法快照项被过滤', sanitizeSnapshots([{ name: 'x' }, null, 42]).length === 0);
  check(
    '合法快照项保留',
    sanitizeSnapshots([{ id: 'q', name: 'q', createdAt: 1, doc: s, confirmed: {} }]).length === 1,
  );
}

// ---- 正文逐字差异 ----
{
  const segs = diffText('适用第三条规定', '适用第五条规定');
  const rebuilt = segs
    .filter((s) => s.type !== 'del')
    .map((s) => s.text)
    .join('');
  const added = segs.filter((s) => s.type === 'add').map((s) => s.text).join('');
  const removed = segs.filter((s) => s.type === 'del').map((s) => s.text).join('');
  check('逐字差异拼回新文本（same+add）', rebuilt === '适用第五条规定', rebuilt);
  check('逐字差异：删除“三”', removed === '三', removed);
  check('逐字差异：新增“五”', added === '五', added);
  check('相同文本只有 same', diffText('abc', 'abc').length === 1 && diffText('abc', 'abc')[0].type === 'same');
  // 长文本退化策略不抛错
  const long = '字'.repeat(MAX_LCS_CHARS + 10);
  const segsLong = diffText(long, long + '尾');
  check('超长文本退化为整段差异', segsLong.some((s) => s.type === 'add'));
}

// ---- 审阅批注：创建锚点 ----
{
  const d = parseDocument(`批注法

第一条【目的】
为了规范批注活动，制定本办法。

第二条【程序】
起草、审查与公布，均适用本办法。`).doc;
  renumberAll(d.root);
  const firstTextNode = d.root[0].children[0];
  const q = '制定本办法';
  const pos = firstTextNode.text.indexOf(q);
  const ann = createAnnotation(firstTextNode.id, pos, pos + q.length, firstTextNode.text, '措辞待斟酌');
  check('批注创建：状态锚定', ann.status === 'anchored');
  check('批注创建：记录引用片段', ann.quote === q);
  check('批注创建：前文锚点非空', ann.prefix.length > 0);
  check('批注创建：后文锚点为句末标点', ann.suffix === '。');
  check('片段查找：唯一', findAll(firstTextNode.text, q).length === 1);
  check('片段查找：多处', findAll('aaa', 'a').length === 3);
}

// ---- 审阅批注：正文未变时位置不动 ----
{
  const d = parseDocument(`批注法

第一条
为了规范批注活动，制定本办法。`).doc;
  renumberAll(d.root);
  const n = d.root[0].children[0];
  const q = '规范批注';
  const pos = n.text.indexOf(q);
  const ann = createAnnotation(n.id, pos, pos + q.length, n.text, 'x');
  const r = relocateAnnotations([ann], d);
  check('正文未变：批注保持锚定', r.annotations[0].status === 'anchored' && r.annotations[0].start === pos);
  check('正文未变：无新增待复核', r.reviewIds.length === 0);
}

// ---- 审阅批注：片段在节点内偏移移动（前文插入）自动跟随 ----
{
  const d0 = parseDocument(`批注法

第一条
为了规范批注活动，制定本办法。`).doc;
  renumberAll(d0.root);
  const n = d0.root[0].children[0];
  const q = '制定本办法';
  const ann = createAnnotation(n.id, n.text.indexOf(q), n.text.indexOf(q) + q.length, n.text, 'x');
  const d = parseDocument(`批注法

第一条
【新增前缀】为了规范批注活动，制定本办法。`).doc;
  renumberAll(d.root);
  d.root[0].id = d0.root[0].id;
  d.root[0].children[0].id = n.id;
  const r = relocateAnnotations([ann], d);
  const nn = d.root[0].children[0];
  check('前文插入：批注自动跟随新偏移', r.annotations[0].status === 'anchored' && r.annotations[0].start === nn.text.indexOf(q), String(r.annotations[0].start));
}

// ---- 审阅批注：多处匹配标为待复核并保留候选 ----
{
  const d = parseDocument(`批注法

第一条
同意、同意、同意。`).doc;
  renumberAll(d.root);
  const n = d.root[0].children[0];
  const ann = createAnnotation(n.id, 0, 2, n.text, 'x');
  const r = relocateAnnotations([ann], d);
  check('多处匹配：待复核', r.annotations[0].status === 'review');
  check('多处匹配：原因 multi-in-node', r.annotations[0].reason === 'multi-in-node');
  check('多处匹配：保留 3 个候选', (r.annotations[0].candidates?.length ?? 0) === 3, String(r.annotations[0].candidates?.length));
}

// ---- 审阅批注：节点删除后全文唯一匹配自动重锚 ----
{
  const d0 = parseDocument(`批注法

第一条
甲条款内容。

第二条
乙条款内容。`).doc;
  renumberAll(d0.root);
  const q = '乙条款内容';
  const ann = createAnnotation(d0.root[1].children[0].id, 0, q.length, q, 'x');
  // 删除第二条，把其正文并入第三条
  const d = parseDocument(`批注法

第一条
甲条款内容。

第三条
乙条款内容。`).doc;
  renumberAll(d.root);
  d.root[0].id = d0.root[0].id;
  d.root[0].children[0].id = d0.root[0].children[0].id;
  const r = relocateAnnotations([ann], d);
  check('节点删除+全文唯一：自动锚到新节点', r.annotations[0].status === 'anchored' && r.annotations[0].nodeId === d.root[1].children[0].id, r.annotations[0].nodeId);
}

// ---- 审阅批注：节点删除且片段消失 → node-missing 待复核 ----
{
  const d0 = parseDocument(`批注法

第一条
甲条款内容。

第二条
乙条款内容。`).doc;
  renumberAll(d0.root);
  const q = '乙条款内容';
  const ann = createAnnotation(d0.root[1].children[0].id, 0, q.length, q, 'x');
  const d = parseDocument(`批注法

第一条
甲条款内容。

第二条
完全不同的新文字。`).doc;
  renumberAll(d.root);
  d.root[0].id = d0.root[0].id;
  d.root[0].children[0].id = d0.root[0].children[0].id;
  d.root[1].id = d0.root[1].id;
  d.root[1].children[0].id = d0.root[1].children[0].id; // 节点 id 保留但文字已改
  const r1 = relocateAnnotations([ann], d);
  check('节点在但片段缺失：missing', r1.annotations[0].status === 'review' && r1.annotations[0].reason === 'missing', r1.annotations[0].reason ?? '');

  const d2 = parseDocument(`批注法

第一条
甲条款内容。`).doc;
  renumberAll(d2.root);
  d2.root[0].id = d0.root[0].id;
  d2.root[0].children[0].id = d0.root[0].children[0].id;
  const r2 = relocateAnnotations([ann], d2);
  check('节点删除且找不到：node-missing', r2.annotations[0].status === 'review' && r2.annotations[0].reason === 'node-missing', r2.annotations[0].reason ?? '');
}

// ---- 审阅批注：归一化（空白/标点差异）匹配 ----
{
  const d0 = parseDocument(`批注法

第一条
引用第五条第二款的规定。`).doc;
  renumberAll(d0.root);
  const n0 = d0.root[0].children[0];
  const q = '第五条第二款';
  const ann = createAnnotation(n0.id, n0.text.indexOf(q), n0.text.indexOf(q) + q.length, n0.text, 'x');
  // 正文在引用片段中间插入了顿号；归一化（剥离标点）后应唯一重锚
  const d = parseDocument(`批注法

第一条
引用第五条、第二款的规定。`).doc;
  renumberAll(d.root);
  d.root[0].id = d0.root[0].id;
  d.root[0].children[0].id = n0.id;
  const r = relocateAnnotations([ann], d);
  check('归一化匹配：标点差异自动重锚', r.annotations[0].status === 'anchored', r.annotations[0].reason ?? 'anchored');
  const relit = d.root[0].children[0].text.slice(r.annotations[0].start, r.annotations[0].end);
  check('归一化匹配：定位覆盖当前文字', relit === '第五条、第二款', relit);
}

// ---- 审阅批注：全文多处匹配 → multi-match + 候选按前后文排序 ----
{
  const d0 = parseDocument(`批注法

第一条
前置文字目标片段后缀文字。`).doc;
  renumberAll(d0.root);
  const n0 = d0.root[0].children[0];
  const q = '目标片段';
  const ann = createAnnotation(n0.id, n0.text.indexOf(q), n0.text.indexOf(q) + q.length, n0.text, 'x');
  const d = parseDocument(`批注法

第一条
无关内容。

第二条
另外一处目标片段在这里。

第三条
前置文字目标片段后缀文字。`).doc;
  renumberAll(d.root);
  d.root[2].children[0].text = '前置文字目标片段后缀文字。'; // 与原前后文一致
  const r = relocateAnnotations([ann], d);
  check('全文多处：multi-match 待复核', r.annotations[0].status === 'review' && r.annotations[0].reason === 'multi-match', r.annotations[0].reason ?? '');
  const cands = r.annotations[0].candidates ?? [];
  check('全文多处：保留候选', cands.length === 2, String(cands.length));
  check('候选排序：前后文最相似者居首', cands[0]?.nodeId === d.root[2].children[0].id, cands[0]?.nodeId ?? '');
}

// ---- 审阅批注：外部数据规整 ----
{
  check('空/非法批注列表 → 空', sanitizeAnnotations(undefined).length === 0);
  check('非法项过滤', sanitizeAnnotations([null, 42, { nodeId: 'x' }, { nodeId: 'x', quote: '', content: '' }]).length === 0);
  const cleaned = sanitizeAnnotations([
    { id: 'a1', nodeId: 'n1', start: 0, end: 3, quote: 'abc', content: 'ok', status: 'review' },
    { nodeId: 'n2', quote: 'd', content: 'ok' }, // 缺 id 自动补
  ]);
  check('合法批注保留', cleaned.length === 2 && cleaned[0].status === 'review');
  check('缺省 id / 时间戳自动补全', Boolean(cleaned[1].id) && typeof cleaned[1].createdAt === 'number');
  check('非法状态回退 anchored', sanitizeAnnotations([{ nodeId: 'n', quote: 'a', content: 'c', status: 'weird' }])[0].status === 'anchored');
}

// ---- 审阅批注：快照携带批注并只读 ----
{
  const d = parseDocument(`快照批注法

第一条
快照正文。`).doc;
  renumberAll(d.root);
  const anns = sanitizeAnnotations([
    { id: 'an1', nodeId: d.root[0].children[0].id, start: 0, end: 2, quote: '快照', content: '留痕' },
  ]);
  const snap = createSnapshot(d, {}, '带批注稿', anns);
  check('快照携带批注', Array.isArray(snap.annotations) && snap.annotations!.length === 1);
  let froze = false;
  try {
    'use strict';
    (snap.annotations as unknown[]).push?.({} as never);
  } catch {
    froze = true;
  }
  check('快照批注只读冻结', froze);
  const loaded = sanitizeSnapshots([
    { id: 's', name: 's', createdAt: 1, doc: d, confirmed: {}, annotations: [{ nodeId: 'x', quote: 'q', content: 'c' }] },
  ]);
  check('快照导入时规整批注', (loaded[0].annotations?.length ?? 0) === 1);
}

// ---- 规范用语审校：扫描 ----
{
  const rules = [
    { ...createUsageRule('依照', ['按照', '按着']) },
    { ...createUsageRule('作出', ['做出']) },
  ];
  const hits = scanUsageText('按照规定，按着流程，做出决定，再按照一次。', rules);
  check('扫描：命中数 4', hits.length === 4, String(hits.length));
  check('扫描：首个命中为“按照”', hits[0].match === '按照' && hits[0].start === 0, hits[0]?.match);
  check('扫描：记录规范词', hits[0].preferred === '依照');
  check('扫描：记录规则序', hits[2].ruleId === rules[1].id && hits[2].ruleIndex === 1, String(hits[2].ruleIndex));
  check('扫描：重叠不重复输出', hits.every((h, i) => i === 0 || h.start >= hits[i - 1].end));
}

// ---- 规范用语审校：重叠消解优先级（起点靠前 > 较长 > 规则顺序） ----
{
  // 同起点：较长变体优先
  const r1 = createUsageRule('甲', ['AB']);
  const r2 = createUsageRule('乙', ['ABC']);
  let h = scanUsageText('ABC', [r1, r2]);
  check('重叠：同起点较长优先', h.length === 1 && h[0].match === 'ABC' && h[0].ruleId === r2.id, JSON.stringify(h.map(x=>x.match)));

  // 同起点同长度：规则顺序靠前优先
  const r3 = createUsageRule('丙', ['XY']);
  const r4 = createUsageRule('丁', ['XY']);
  h = scanUsageText('XY', [r3, r4]);
  check('重叠：同长度规则顺序优先', h.length === 1 && h[0].ruleId === r3.id);

  // 起点靠前优先：先选靠前起点的短串，跨越它的长串被排除
  const r5 = createUsageRule('长', ['ABC']);
  const r6 = createUsageRule('短', ['AB']);
  // 构造：位置 0 有 'AB'，位置 1 有 'BC'？需要起点靠前情形——文本 'ABBC'?
  // 用文本 'XABC'：r? 起点 1 的 'ABC' 是唯一长串。改为 'ABC' 中 'AB'@0 vs 'ABC'@0 同起点，已覆盖。
  // 起点不同：'AABC'：'AB'@1（r6 规则在前），'ABC'@1 同起点。再用 'ABCAB'：
  const text = 'ABCAB';
  const hh = scanUsageText(text, [r5, r6]); // r5='ABC'@0, r6='AB'@0 与 @3
  // 同起点取长：ABC@0；之后 AB@3
  check('重叠：同起点取长后后续不重叠命中保留', hh.length === 2 && hh[0].match === 'ABC' && hh[1].start === 3, JSON.stringify(hh.map(x=>[x.match,x.start])));

  // 起点靠前：规则 rLong='BCD'@1 与 rShort@0='AB'，'AB' 起点 0 应优先，'BCD' 与其重叠被排除
  const rShort2 = createUsageRule('短', ['AB']);
  const rLong2 = createUsageRule('长', ['BCD']);
  const h2 = scanUsageText('ABCD', [rLong2, rShort2]);
  check('重叠：起点靠前优先于长度', h2.length === 1 && h2[0].match === 'AB' && h2[0].start === 0, JSON.stringify(h2.map(x=>[x.match,x.start])));
}

// ---- 规范用语审校：停用规则不扫描、规则规整去重 ----
{
  const r = createUsageRule('依照', ['按照', '按照', '依照', '', '按着']);
  check('规整：变体去重、去空、去与规范词相同', r.variants.join('|') === '按照|按着', r.variants.join('|'));
  const disabled = { ...r, enabled: false };
  check('停用规则无命中', scanUsageText('按照', [disabled]).length === 0);
  check('空规范词 / 无变体规则被规整过滤', sanitizeUsageRules([
    { preferred: '', variants: ['x'] },
    { preferred: 'a', variants: [] },
    null, 42,
  ]).length === 0);
  check('旧数据缺字段 → 空规则', sanitizeUsageRules(undefined).length === 0);
  const loaded = sanitizeUsageRules([{ id: 'u1', preferred: '依照', variants: ['按照'] }]);
  check('合法规则保留并补全时间戳/enabled', loaded.length === 1 && loaded[0].enabled !== false && typeof loaded[0].createdAt === 'number');
}

// ---- 规范用语审校：全文扫描按文档顺序 ----
{
  const d = parseDocument(`用语法

第一条
按照甲规定。

第二条
依照乙，按着丙。`).doc;
  renumberAll(d.root);
  const rules = [createUsageRule('依照', ['按照', '按着'])];
  const { hits } = scanUsage(d, rules);
  check('全文扫描：跨节点 2 处命中', hits.length === 2, String(hits.length));
  check('全文扫描：先条后款的文档顺序', hits[0].nodeId === d.root[0].children[0].id && hits[1].nodeId === d.root[1].children[0].id);
  check('全文扫描：key 稳定且唯一', new Set(hits.map((x) => x.key)).size === 2);
}

// ---- 规范用语审校：提交前核对（节点 ID 与原文区间） ----
{
  const d = parseDocument(`核对法

第一条
按照规定执行。`).doc;
  renumberAll(d.root);
  const node = d.root[0].children[0];
  const rules = [createUsageRule('依照', ['按照'])];
  const { hits } = scanUsage(d, rules);

  // 未改动：核对通过
  const ok = verifyUsageHits(d.root, hits, [hits[0].key]);
  check('核对：原文未变通过', ok.ok && ok.staleKeys.length === 0);

  // 正文变化导致区间文字不同：核对失败
  const d2 = parseDocument(`核对法

第一条
新文本按照规定执行。`).doc;
  renumberAll(d2.root);
  d2.root[0].id = d.root[0].id;
  d2.root[0].children[0].id = node.id;
  const bad = verifyUsageHits(d2.root, hits, [hits[0].key]);
  check('核对：原文区间变化整批不通过', !bad.ok && bad.staleKeys.length === 1);

  // 节点删除：核对失败
  const d3 = parseDocument(`核对法

第二条
无关内容。`).doc;
  renumberAll(d3.root);
  const badNode = verifyUsageHits(d3.root, hits, [hits[0].key]);
  check('核对：节点消失不通过', !badNode.ok);
}

// ---- 规范用语审校：批量替换（后向前、单步、不递归） ----
{
  const d = parseDocument(`替换法

第一条
按照甲和按照乙。

第二条
按着流程。`).doc;
  renumberAll(d.root);
  const rules = [createUsageRule('依照', ['按照', '按着'])];
  const { hits } = scanUsage(d, rules);
  check('替换前：3 处命中', hits.length === 3, String(hits.length));

  const { root, result } = applyUsageReplace(d.root, hits, hits.map((h) => h.key));
  check('替换：全部应用', result.applied === 3 && !result.rejected, String(result.applied));
  const t1 = d.root[0].children[0].text;
  const t2 = d.root[1].children[0].text;
  check('替换：条内两处均替换', t1 === '依照甲和依照乙。', t1);
  check('替换：跨节点替换', t2 === '依照流程。', t2);
  check('替换：不递归处理新文字（规范词不会再触发）', !t1.includes('按照') && !t2.includes('按着'));

  // 部分勾选：只替换已选
  const d2 = parseDocument(`替换法

第一条
按照甲和按照乙。`).doc;
  renumberAll(d2.root);
  const scan2 = scanUsage(d2, rules);
  applyUsageReplace(d2.root, scan2.hits, [scan2.hits[1].key]);
  check('替换：仅处理已选命中', d2.root[0].children[0].text === '按照甲和依照乙。', d2.root[0].children[0].text);

  // 任一项失效整批拒绝，文档不变
  const d3 = parseDocument(`替换法

第一条
按照规定。`).doc;
  renumberAll(d3.root);
  const stale = scanUsage(d3, rules);
  const staleNodeId = d3.root[0].children[0].id;
  const changed = parseDocument(`替换法

第一条
依照明示。`).doc; // 区间文字已被手工改掉
  renumberAll(changed.root);
  changed.root[0].id = d3.root[0].id;
  changed.root[0].children[0].id = staleNodeId;
  const r3 = applyUsageReplace(changed.root, stale.hits, [stale.hits[0].key]);
  check('替换：核对失败整批拒绝且文档不变', r3.result.rejected && changed.root[0].children[0].text === '依照明示。');

  // 不递归：规范词若是另一规则的变体，替换新生成的文字不再被处理（同一批次内）
  const chainedRules = [createUsageRule('B', ['A']), createUsageRule('C', ['B'])];
  const d4 = parseDocument(`链法

第一条
A 文字。`).doc;
  renumberAll(d4.root);
  const scan4 = scanUsage(d4, chainedRules);
  applyUsageReplace(d4.root, scan4.hits, scan4.hits.map((h) => h.key));
  check('替换：不递归链式改写（A→B 而非直接到 C）', d4.root[0].children[0].text.startsWith('B '), d4.root[0].children[0].text);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
