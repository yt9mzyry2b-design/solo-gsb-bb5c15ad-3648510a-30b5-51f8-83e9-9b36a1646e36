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
  scanTerms,
  replaceTermHits,
  sanitizeTermRules,
  effectiveVariants,
  isHitCurrent,
} from '../src/lib/terminology';
import { AppStore } from '../src/lib/store';
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

// ---- 规范用语：规则规整 ----
{
  check('旧数据缺 termRules → 空规则', sanitizeTermRules(undefined).length === 0);
  check('非法规则项被过滤', sanitizeTermRules([null, 42, {}, { canonical: '  ' }]).length === 0);
  const rules = sanitizeTermRules([
    { canonical: ' 依照 ', variants: [' 按照 ', '按照', '依照', ''] },
    { canonical: '应当' },
  ]);
  check('合法规则保留并 trim', rules.length === 2 && rules[0].canonical === '依照');
  check('变体去重且剔除与规范词相同者', rules[0].variants.length === 1 && rules[0].variants[0] === '按照', JSON.stringify(rules[0].variants));
  check('缺省 id 自动补全', Boolean(rules[1].id));
  check('effectiveVariants 剔除与规范词相同者', effectiveVariants({ id: 'r', canonical: '甲', variants: ['甲', '乙', '乙'], createdAt: 0 }).join(',') === '乙');
}

// ---- 规范用语：扫描、重叠消解与批量替换（纯函数） ----
{
  const d = parseDocument(`术语法

第一条
按照规定应该公开，按照程序应该回避。

第二条
按照后条办理。`).doc;
  renumberAll(d.root);
  const n1 = d.root[0].children[0].id;
  const n2 = d.root[1].children[0].id;

  const rules = sanitizeTermRules([
    { id: 'r1', canonical: '依照', variants: ['按照'] },
    { id: 'r2', canonical: '应当', variants: ['应该'] },
    // 与「按照」同起点的长变体，用于验证长变体优先
    { id: 'r3', canonical: '依规', variants: ['按照规'] },
  ]);
  const hits = scanTerms(d, rules);
  // 第一条：按照规(长) 应该 按照 应该；第二条：按照
  check('扫描命中数（长变体优先，且不递归）', hits.length === 5, String(hits.length));
  const longHit = hits.find((h) => h.variant === '按照规');
  check('同起点长变体胜出', Boolean(longHit) && longHit!.nodeId === n1, JSON.stringify(hits.map(h => h.variant)));
  check('长变体胜出后短变体「按照」不在该处命中', !hits.some((h) => h.nodeId === n1 && h.variant === '按照' && h.start === 0));
  check('命中文档顺序：第一条先于第二条', hits[0].nodeId === n1 && hits[hits.length - 1].nodeId === n2);
  // 起点靠前消解重叠：长变体 [0,3) 覆盖后，规则 r1 在 0 处的「按照」被跳过
  check('命中两两互不交叠', hits.every((h, i) => i === 0 || hits[i - 1].nodeId !== h.nodeId || h.start >= hits[i - 1].end));

  // 规则顺序消解：同起点、同长度、不同规则时顺序靠前的优先
  const dTie = parseDocument(`平手法

第一条
甲乙同字。`).doc;
  renumberAll(dTie.root);
  const tieRules = sanitizeTermRules([
    { id: 'ta', canonical: 'A', variants: ['甲乙'] },
    { id: 'tb', canonical: 'B', variants: ['甲乙'] },
  ]);
  const tieHits = scanTerms(dTie, tieRules);
  check('同长同起点：规则顺序靠前者胜出', tieHits.length === 1 && tieHits[0].ruleId === 'ta', JSON.stringify(tieHits));

  // 批量替换：仅替换勾选命中（取除长命中外的其余 4 处），单遍、按节点从后向前
  const chosen = hits.filter((h) => h.variant !== '按照规');
  const clone = JSON.parse(JSON.stringify(d)) as typeof d;
  const r = replaceTermHits(clone, chosen);
  check('批量替换全部成功', r.replaced === 4 && r.stale === 0, `${r.replaced}/${r.stale}`);
  const newText1 = clone.root[0].children[0].text;
  const newText2 = clone.root[1].children[0].text;
  check('替换结果正确', newText1 === '按照规定应当公开，依照程序应当回避。', newText1);
  check('长变体未被勾选时原样保留', newText1.startsWith('按照规'));
  check('第二条替换', newText2 === '依照后条办理。', newText2);
  // 不递归：替换后出现的规范词即便等于某条规则的变体也不会二次处理（这里变体均不含规范词，另做专项）
  const dRec = parseDocument(`递归法

第一条
甲乙。`).doc;
  renumberAll(dRec.root);
  // 规则：把「甲」替换成「甲乙」——若递归会再次命中，单遍实现只替换一次
  const recHits = scanTerms(dRec, sanitizeTermRules([{ id: 'rr', canonical: '甲乙', variants: ['甲'] }]));
  const recClone = JSON.parse(JSON.stringify(dRec)) as typeof dRec;
  const recR = replaceTermHits(recClone, recHits);
  check('替换不递归处理新生成文字', recR.replaced === 1 && recClone.root[0].children[0].text === '甲乙乙。', recClone.root[0].children[0].text);

  // 整批拒绝：任一命中区间已变化（原文不符）则整批不动
  const staleDoc = JSON.parse(JSON.stringify(d)) as typeof d;
  staleDoc.root[0].children[0].text = '正文已经被人改写过，与快照不一致。';
  const staleR = replaceTermHits(staleDoc, chosen);
  check('区间已变化：整批拒绝（stale>0，replaced=0）', staleR.stale > 0 && staleR.replaced === 0, `${staleR.replaced}/${staleR.stale}`);
  check('整批拒绝时正文完全不动', staleDoc.root[0].children[0].text === '正文已经被人改写过，与快照不一致。');

  // 节点删除 → 失效
  check('节点删除判定为失效', !isHitCurrent(undefined, chosen[0]));
}

// ---- 规范用语：AppStore 扫描快照、批量替换原子性、撤销/重做与持久化 ----
{
  const d = parseDocument(`商店法

第一条
按照规定办理。

第二条
再次按照办理。`).doc;
  renumberAll(d.root);
  const rules = sanitizeTermRules([{ id: 'k1', canonical: '依照', variants: ['按照'] }]);
  const store = new AppStore({ doc: d, confirmed: {}, annotations: [], termRules: rules });
  const snap0 = store.getSnapshot();
  check('Store 实时给出命中', snap0.termHits.length === 2, String(snap0.termHits.length));

  // 仅勾选第一条的命中：替换只处理已选命中，另一处保留
  const firstHit = snap0.termHits.find((h) => h.nodeId === d.root[0].children[0].id)!;
  const res = store.replaceSelectedTerms([firstHit.key]);
  check('Store 替换返回成功', res.replaced === 1 && res.stale === 0, JSON.stringify(res));
  const snap1 = store.getSnapshot();
  check('已选命中被替换', snap1.doc.root[0].children[0].text === '依照规定办理。');
  check('未选命中保留且重新扫描仍可见', snap1.doc.root[1].children[0].text === '再次按照办理。' && snap1.termHits.length === 1);
  check('替换是一步：撤销恢复原文', (store.undo(), store.getSnapshot().doc.root[0].children[0].text === '按照规定办理。'));
  check('撤销后命中恢复为 2 处', store.getSnapshot().termHits.length === 2);
  check('重做再次替换', (store.redo(), store.getSnapshot().doc.root[0].children[0].text === '依照规定办理。'));

  // 过期快照：撤销回旧正文拿到扫描命中后，删除其中一个命中节点，再用旧快照尝试替换 → 整批拒绝
  store.undo();
  const nowStale = store.getSnapshot().termHits; // 旧正文「按照」两处
  const secondNodeId = d.root[1].children[0].id;
  store.deleteNode(secondNodeId); // 结构性分歧：旧快照中第二条的命中已无对应节点
  const rejected = store.replaceSelectedTerms(nowStale.map((h) => h.key));
  check('Store 检测过期快照并整批拒绝', rejected.replaced === 0 && rejected.stale >= 1, JSON.stringify(rejected));
  check('拒绝后第一条正文未被改动', store.getSnapshot().doc.root[0].children[0].text === '按照规定办理。');
  check('规则随状态持久化（currentPersisted 含 termRules）', JSON.stringify(store.getSnapshot().termRules).includes('依照'));

  // 规则增删改进入撤销历史
  const beforeRules = store.getSnapshot().termRules.length;
  const newId = store.addTermRule();
  check('新增规则', store.getSnapshot().termRules.length === beforeRules + 1);
  store.updateTermRule(newId, { canonical: '可以', variants: ['可'] });
  store.undo();
  // updateTermRule 与 addTermRule 之间因合并窗口（测试中同步执行，窗口内）可能合并为一步
  const afterUndo = store.getSnapshot().termRules;
  check('规则编辑可撤销', afterUndo.length === beforeRules || !afterUndo.some((r) => r.canonical === '可以'), JSON.stringify(afterUndo.map(r => r.canonical)));

  // 导出 JSON 带规则；旧导入缺字段按空规则加载且不报错
  const exported = store.exportJson();
  check('导出包含 termRules', Array.isArray(exported.termRules) && exported.termRules!.length >= 1);
  const store2 = new AppStore({ doc: d, confirmed: {}, annotations: [] });
  check('旧数据缺 termRules 按空规则加载（0 命中）', store2.getSnapshot().termHits.length === 0 && store2.getSnapshot().termRules.length === 0);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
