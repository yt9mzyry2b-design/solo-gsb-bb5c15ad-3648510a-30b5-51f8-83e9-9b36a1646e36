import { useSyncExternalStore } from 'react';
import type {
  Annotation,
  ClauseDocument,
  ClauseNode,
  DocSnapshot,
  ExportBundle,
  PersistedState,
} from '../../shared/model';
import { analyze } from './analyzer';
import type { Analysis } from '../../shared/model';
import { parseDocument } from './parser';
import {
  cloneTree,
  findArticleOf,
  findNode,
  newArticle,
  newItem,
  newParagraph,
  renumberAll,
  touch,
} from './tree';

import { applyStructuralChange } from './rewriter';
import { localStore, serverStore } from './storage';
import { createSnapshot, sanitizeSnapshots } from './snapshot';
import {
  createAnnotation as makeAnnotation,
  relocateAnnotations,
  sanitizeAnnotations,
  ANCHOR_CTX,
} from './annotations';
import {
  createTermRule,
  replaceTermHits,
  sanitizeTermRules,
  scanTerms,
} from './terminology';
import type { TermHit, TermRule } from '../../shared/model';
import { sampleTermRules } from './sample';
import { uid } from './uid';

/** 撤销/重做历史承载正文、确认记录、批注与规范用语规则；快照独立于历史，不参与撤销 */
interface DocState {
  doc: ClauseDocument;
  confirmed: Record<string, string>;
  annotations: Annotation[];
  termRules: TermRule[];
}

interface Snapshot {
  doc: ClauseDocument;
  confirmed: Record<string, string>;
  annotations: Annotation[];
  termRules: TermRule[];
  snapshots: DocSnapshot[];
  analysis: Analysis;
  /** 当前规范用语规则对当前正文的实时扫描结果（重叠消解后的命中） */
  termHits: TermHit[];
  canUndo: boolean;
  canRedo: boolean;
}

const MAX_HISTORY = 100;

export class AppStore {
  private past: DocState[] = [];
  private future: DocState[] = [];
  private docState: DocState;
  private snapshots: DocSnapshot[] = [];
  private analysis: Analysis;
  /** 当前规范用语命中（随 docState 实时重算，不进入撤销历史） */
  private termHits: TermHit[] = [];
  /** 当前连续文本编辑突发的起始状态（用于合并撤销） */
  private coalesceBaseline: DocState | null = null;
  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  lastRewriteInfo: { rewritten: number; skipped: number } | null = null;
  /** 最近一次结构操作导致新转入待复核的批注数（供通知条提示） */
  lastAnnotationReviewCount = 0;
  /** 最近一次批量规范替换结果（供界面提示，无操作时为 null） */
  lastTermReplace: { replaced: number; stale: number } | null = null;

  constructor(initial: PersistedState) {
    this.snapshots = sanitizeSnapshots(initial.snapshots);
    const annotations = sanitizeAnnotations(initial.annotations);
    const termRules = sanitizeTermRules(initial.termRules);
    const doc = initial.doc;
    // 加载时按当前正文校正一次位置（导入的 JSON / 旧数据可能已与正文不同步）
    const relocated = relocateAnnotations(annotations, doc).annotations;
    this.docState = { doc, confirmed: initial.confirmed, annotations: relocated, termRules };
    this.analysis = analyze(doc, { confirmed: initial.confirmed });
    this.termHits = scanTerms(doc, termRules);
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  getSnapshot = (): Snapshot => ({
    doc: this.docState.doc,
    confirmed: this.docState.confirmed,
    annotations: this.docState.annotations,
    termRules: this.docState.termRules,
    snapshots: this.snapshots,
    analysis: this.analysis,
    termHits: this.termHits,
    canUndo: this.past.length > 0,
    canRedo: this.future.length > 0,
  });

  /** 当前完整持久化状态（正文 + 确认 + 批注 + 快照） */
  private currentPersisted(): PersistedState {
    return { ...this.docState, snapshots: this.snapshots };
  }

  /** 提交新状态：重新分析、批注自动重定位、裁剪过期确认、规范用语重扫、压入历史、持久化 */
  private commit(
    next: DocState,
    options: { coalesce?: boolean; structural?: boolean } = {},
  ): void {
    const analysis = analyze(next.doc, { confirmed: next.confirmed });
    // 批注按调整后的正文/结构自动重定位
    const relocated = relocateAnnotations(next.annotations, next.doc);
    const annotations = relocated.annotations;
    // 裁剪：确认记录必须仍对应一个“歧义已消失/仍歧义”的 occurrence，且目标存在
    const valid = new Set(
      analysis.occurrences
        .filter((o) => o.signature && next.confirmed[o.signature])
        .map((o) => o.signature),
    );
    const confirmed: Record<string, string> = {};
    for (const [sig, target] of Object.entries(next.confirmed)) {
      if (valid.has(sig) && analysis.nodes[target]) confirmed[sig] = target;
    }
    next = { confirmed, doc: touch(next.doc), annotations, termRules: next.termRules };
    // 规范用语命中随正文 / 规则实时重扫
    const termHits = scanTerms(next.doc, next.termRules);

    if (options.coalesce) {
      if (this.coalesceBaseline) {
        // 同一编辑突发内：不压栈，栈顶保持为突发前基线
      } else {
        this.coalesceBaseline = this.docState;
        this.past.push(this.docState);
      }
    } else {
      this.coalesceBaseline = null;
      this.editCoalesceUntil = 0;
      this.ruleCoalesceUntil = 0;
      this.past.push(this.docState);
      if (this.past.length > MAX_HISTORY) this.past.shift();
    }
    this.future = [];
    this.docState = next;
    this.analysis = analysis;
    this.termHits = termHits;
    this.lastAnnotationReviewCount = options.structural ? relocated.reviewIds.length : 0;
    this.scheduleSave();
    this.emit();
  }

  private scheduleSave(): void {
    localStore.save(this.currentPersisted());
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void serverStore.save(this.currentPersisted());
    }, 600);
  }

  // ---------- 历史 ----------

  undo(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.docState);
    this.docState = prev;
    this.analysis = analyze(prev.doc, { confirmed: prev.confirmed });
    this.termHits = scanTerms(prev.doc, prev.termRules);
    this.coalesceBaseline = null;
    this.editCoalesceUntil = 0;
    this.ruleCoalesceUntil = 0;
    this.lastAnnotationReviewCount = 0;
    this.lastTermReplace = null;
    this.scheduleSave();
    this.emit();
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.docState);
    this.docState = next;
    this.analysis = analyze(next.doc, { confirmed: next.confirmed });
    this.termHits = scanTerms(next.doc, next.termRules);
    this.coalesceBaseline = null;
    this.editCoalesceUntil = 0;
    this.ruleCoalesceUntil = 0;
    this.lastAnnotationReviewCount = 0;
    this.lastTermReplace = null;
    this.scheduleSave();
    this.emit();
  }

  // ---------- 文档内容编辑（带 600ms 合并窗口） ----------

  private editCoalesceUntil = 0;
  /** 规范用语规则连续编辑的合并窗口截止时间 */
  private ruleCoalesceUntil = 0;

  updateNodeText(nodeId: string, text: string): void {
    const root = cloneTree(this.docState.doc.root);
    const found = findNode(root, nodeId);
    if (!found) return;
    found.node.text = text;
    const now = Date.now();
    const coalesce = now < this.editCoalesceUntil;
    this.editCoalesceUntil = now + 800;
    this.commit(
      { ...this.docState, doc: { ...this.docState.doc, root } },
      { coalesce },
    );
  }

  updateArticleMeta(articleId: string, patch: { title?: string; suffix?: string }): void {
    const root = cloneTree(this.docState.doc.root);
    const found = findNode(root, articleId);
    if (!found || found.node.kind !== 'article') return;
    if ('title' in patch) found.node.title = patch.title?.trim() || undefined;
    if ('suffix' in patch) found.node.suffix = patch.suffix?.trim() || undefined;
    this.commit({ ...this.docState, doc: { ...this.docState.doc, root } });
  }

  renameTitle(title: string): void {
    this.commit({ ...this.docState, doc: { ...this.docState.doc, title } }, { coalesce: false });
  }

  // ---------- 结构操作（触发原子引用改写） ----------

  private structural(label: string, mutator: (root: ClauseNode[]) => void): void {
    void label;
    const result = applyStructuralChange(this.docState.doc, this.analysis, mutator);
    this.lastRewriteInfo = {
      rewritten: result.rewritten,
      skipped: result.skipped.length,
    };
    this.commit({ ...this.docState, doc: result.doc }, { structural: true });
  }

  /** 同级内移动（拖拽排序）。toIndex 为删除源节点后的目标下标 */
  reorderSibling(nodeId: string, toIndex: number): void {
    this.structural('reorder', (root) => {
      const found = findNode(root, nodeId);
      if (!found) return;
      const [node] = found.parent.splice(found.index, 1);
      const clamped = Math.max(0, Math.min(toIndex, found.parent.length));
      found.parent.splice(clamped, 0, node);
    });
  }

  /** 跨父级移动（拖拽到另一条/款） */
  moveNode(nodeId: string, targetParentId: string, toIndex: number): void {
    this.structural('move', (root) => {
      const src = findNode(root, nodeId);
      let targetParent: ClauseNode[];
      if (targetParentId === '__root__') {
        targetParent = root;
      } else {
        const tp = findNode(root, targetParentId);
        if (!tp) return;
        targetParent = tp.node.kind === 'article' ? tp.node.children : tp.node.children;
      }
      if (!src) return;
      // 不允许把节点移动进自身后代
      if (findNode(src.node.children, targetParentId)) return;
      const node = src.node;
      // 层级兼容：只允许同 kind 平级移动
      const sample = targetParent[0];
      if (sample && sample.kind !== node.kind) return;
      src.parent.splice(src.index, 1);
      const clamped = Math.max(0, Math.min(toIndex, targetParent.length));
      targetParent.splice(clamped, 0, node);
    });
  }

  /** 手动改编号（仅条）：与同序号条交换位置 */
  renumberArticle(articleId: string, newOrdinal: number): void {
    if (!Number.isInteger(newOrdinal) || newOrdinal < 1) return;
    this.structural('renumber', (root) => {
      const found = findNode(root, articleId);
      if (!found) return;
      const target = root[newOrdinal - 1];
      if (!target || target.id === articleId) return;
      const [node] = root.splice(found.index, 1);
      root.splice(newOrdinal - 1, 0, node);
    });
  }

  deleteNode(nodeId: string): void {
    this.structural('delete', (root) => {
      const found = findNode(root, nodeId);
      if (!found) return;
      found.parent.splice(found.index, 1);
    });
  }

  addArticle(afterId?: string): string {
    const id = uid('art');
    this.structural('add-article', (root) => {
      const node = newArticle('');
      node.id = id;
      const idx = afterId ? root.findIndex((a) => a.id === afterId) + 1 : root.length;
      root.splice(idx, 0, node);
    });
    return id;
  }

  addParagraph(articleId: string): void {
    this.structural('add-paragraph', (root) => {
      const a = findNode(root, articleId);
      if (!a) return;
      a.node.children.push(newParagraph(''));
    });
  }

  addItem(paragraphNodeId: string): void {
    this.structural('add-item', (root) => {
      const p = findNode(root, paragraphNodeId);
      if (!p) return;
      p.node.children.push(newItem(''));
    });
  }

  // ---------- 粘贴导入 / JSON 导入导出 ----------

  importPastedText(raw: string): void {
    const { doc } = parseDocument(raw, this.docState.doc.title);
    // 粘贴替换正文是全新文档，旧快照与批注不再有对齐意义；规范用语规则是用户词表，予以保留
    this.snapshots = [];
    this.commit({ doc, confirmed: {}, annotations: [], termRules: this.docState.termRules });
  }

  importJson(bundle: ExportBundle | PersistedState): void {
    const rawDoc = 'document' in bundle ? bundle.document : bundle.doc;
    const doc: ClauseDocument = {
      id: rawDoc.id || uid('doc'),
      title: typeof rawDoc.title === 'string' ? rawDoc.title : '未命名条款集',
      root: Array.isArray(rawDoc.root) ? rawDoc.root : [],
      updatedAt: Date.now(),
    };
    const confirmed = bundle.confirmed ?? {};
    // 快照随 JSON 导入；旧文件缺少 snapshots 时按空列表加载
    this.snapshots = sanitizeSnapshots(bundle.snapshots);
    // 批注随 JSON 导入并按导入后的正文重定位；旧文件缺少 annotations 时为空
    const annotations = sanitizeAnnotations(bundle.annotations);
    // 规范用语规则随 JSON 导入；旧文件缺少 termRules 时按空规则加载
    const termRules = sanitizeTermRules(bundle.termRules);
    renumberAll(doc.root);
    this.commit({ doc: touch(doc), confirmed, annotations, termRules });
  }

  exportJson(): ExportBundle {
    return {
      app: 'clause-reference-validator',
      version: 1,
      document: this.docState.doc,
      confirmed: this.docState.confirmed,
      snapshots: this.snapshots,
      annotations: this.docState.annotations,
      termRules: this.docState.termRules,
      exportedAt: new Date().toISOString(),
    };
  }

  replaceWithSample(doc: ClauseDocument): void {
    this.snapshots = [];
    // 内置示例自带示例规则（见 sampleTermRules），同时保留用户已维护的词表
    this.commit({
      doc,
      confirmed: {},
      annotations: [],
      termRules: [...sampleTermRules(), ...this.docState.termRules],
    });
  }

  // ---------- 版本快照（只读；创建/删除不进入正文撤销历史） ----------

  /** 保存当前文档为命名快照，返回新快照 id；批注与规范用语规则随快照一并冻结 */
  saveSnapshot(name: string): string {
    const trimmed = name.trim();
    const snapshot = createSnapshot(
      this.docState.doc,
      this.docState.confirmed,
      trimmed || defaultSnapshotName(this.snapshots.length),
      this.docState.annotations,
      this.docState.termRules,
    );
    this.snapshots = [...this.snapshots, snapshot];
    this.scheduleSave();
    this.emit();
    return snapshot.id;
  }

  /** 删除快照：不影响正文、确认记录与撤销历史 */
  deleteSnapshot(snapshotId: string): void {
    if (!this.snapshots.some((s) => s.id === snapshotId)) return;
    this.snapshots = this.snapshots.filter((s) => s.id !== snapshotId);
    this.scheduleSave();
    this.emit();
  }

  // ---------- 歧义确认 ----------

  confirmAmbiguous(signature: string, targetId: string): void {
    this.commit({
      ...this.docState,
      confirmed: { ...this.docState.confirmed, [signature]: targetId },
    });
  }

  clearConfirmation(signature: string): void {
    const confirmed = { ...this.docState.confirmed };
    delete confirmed[signature];
    this.commit({ ...this.docState, confirmed });
  }

  // ---------- 审阅批注 ----------

  /** 在指定节点的正文片段上创建批注，返回新批注 id */
  addAnnotation(nodeId: string, start: number, end: number, content: string): string | null {
    const node = findNode(this.docState.doc.root, nodeId)?.node;
    if (!node) return null;
    const s = Math.min(start, end);
    const e = Math.max(start, end);
    if (!node.text || s < 0 || e <= s || e > node.text.length) return null;
    const annotation = makeAnnotation(nodeId, s, e, node.text, content.trim());
    this.commit({ ...this.docState, annotations: [...this.docState.annotations, annotation] });
    return annotation.id;
  }

  /** 编辑批注正文；若同时重选片段则更新锚点并重新锚定 */
  updateAnnotation(
    annotationId: string,
    patch: { content?: string; nodeId?: string; start?: number; end?: number },
  ): void {
    const current = this.docState.annotations.find((a) => a.id === annotationId);
    if (!current) return;
    let next: Annotation = { ...current, content: current.content, updatedAt: Date.now() };
    if (typeof patch.content === 'string') next.content = patch.content;
    if (
      patch.nodeId !== undefined &&
      patch.start !== undefined &&
      patch.end !== undefined
    ) {
      const node = findNode(this.docState.doc.root, patch.nodeId)?.node;
      if (node && patch.nodeId !== current.nodeId) {
        // 跨节点重选：以新片段重建锚点
        const rebuilt = makeAnnotation(
          patch.nodeId,
          patch.start,
          patch.end,
          node.text,
          next.content,
          next.updatedAt,
        );
        next = { ...rebuilt, id: current.id, createdAt: current.createdAt };
      } else if (node) {
        const s = Math.min(patch.start, patch.end);
        const e = Math.max(patch.start, patch.end);
        if (s >= 0 && e > s && e <= node.text.length) {
          next.nodeId = patch.nodeId;
          next.start = s;
          next.end = e;
          next.quote = node.text.slice(s, e);
          next.prefix = node.text.slice(Math.max(0, s - ANCHOR_CTX), s);
          next.suffix = node.text.slice(e, e + ANCHOR_CTX);
          next.status = 'anchored';
          next.reason = undefined;
          next.candidates = undefined;
        }
      }
    }
    this.commit({
      ...this.docState,
      annotations: this.docState.annotations.map((a) => (a.id === annotationId ? next : a)),
    });
  }

  deleteAnnotation(annotationId: string): void {
    if (!this.docState.annotations.some((a) => a.id === annotationId)) return;
    this.commit({
      ...this.docState,
      annotations: this.docState.annotations.filter((a) => a.id !== annotationId),
    });
  }

  /** 在候选中确认一个位置，批注重新锚定（正文或结构再次调整后仍继续尝试重定位） */
  resolveAnnotation(annotationId: string, nodeId: string, start: number, end: number): void {
    const current = this.docState.annotations.find((a) => a.id === annotationId);
    if (!current) return;
    const node = findNode(this.docState.doc.root, nodeId)?.node;
    if (!node) return;
    const s = Math.min(start, end);
    const e = Math.max(start, end);
    if (s < 0 || e <= s || e > node.text.length) return;
    // quote 保持创建时原文；若确认位置的当前文字不同则以当前文字更新片段锚点
    const currentText = node.text.slice(s, e);
    const next: Annotation = {
      ...current,
      nodeId,
      start: s,
      end: e,
      quote: currentText || current.quote,
      prefix: node.text.slice(Math.max(0, s - ANCHOR_CTX), s),
      suffix: node.text.slice(e, e + ANCHOR_CTX),
      status: 'anchored',
      reason: undefined,
      candidates: undefined,
      updatedAt: Date.now(),
    };
    this.commit({
      ...this.docState,
      annotations: this.docState.annotations.map((a) => (a.id === annotationId ? next : a)),
    });
  }

  // ---------- 派生查询 ----------

  targetOfRef(refKey: string): string | null {
    const occ = this.analysis.occurrences.find((o) => o.key === refKey);
    return occ?.resolution.targetId ?? null;
  }

  articleOf(nodeId: string): ClauseNode | null {
    return findArticleOf(this.docState.doc.root, nodeId);
  }

  // ---------- 规范用语规则 ----------

  /** 新增一条空规则，返回其 id */
  addTermRule(): string {
    const rule = createTermRule();
    this.commit({ ...this.docState, termRules: [...this.docState.termRules, rule] });
    return rule.id;
  }

  /**
   * 更新规则规范词/变体；连续输入按一个撤销步合并。
   * trim=true（失焦 / 回车）时规整空白与重复变体；输入过程中保留原文以免打断光标。
   */
  updateTermRule(
    ruleId: string,
    patch: { canonical?: string; variants?: string[] },
    trim = false,
  ): void {
    const now = Date.now();
    const coalesce = now < this.ruleCoalesceUntil;
    this.ruleCoalesceUntil = now + 800;
    const termRules = this.docState.termRules.map((r) =>
      r.id === ruleId
        ? {
            ...r,
            ...(patch.canonical !== undefined
              ? { canonical: trim ? patch.canonical.trim() : patch.canonical }
              : {}),
            ...(patch.variants !== undefined
              ? {
                  variants: trim
                    ? patch.variants
                        .map((v) => v.trim())
                        .filter((v, i, arr) => v && arr.indexOf(v) === i)
                    : patch.variants,
                }
              : {}),
          }
        : r,
    );
    this.commit({ ...this.docState, termRules }, { coalesce });
  }

  deleteTermRule(ruleId: string): void {
    if (!this.docState.termRules.some((r) => r.id === ruleId)) return;
    this.commit({
      ...this.docState,
      termRules: this.docState.termRules.filter((r) => r.id !== ruleId),
    });
  }

  /** 上移 / 下移规则（规则顺序是同长同起点命中的消解优先级） */
  moveTermRule(ruleId: string, dir: -1 | 1): void {
    const idx = this.docState.termRules.findIndex((r) => r.id === ruleId);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= this.docState.termRules.length) return;
    const termRules = [...this.docState.termRules];
    [termRules[idx], termRules[target]] = [termRules[target], termRules[idx]];
    this.commit({ ...this.docState, termRules });
  }

  /**
   * 批量替换：仅处理扫描快照中的已勾选命中。
   * 提交前逐项核对节点 ID 与原文区间；任一项已变化（含已不在当前扫描快照中）
   * 则整批拒绝（不改正文），全部有效时按节点从后向前单遍替换，
   * 作为一步支持整体撤销/重做。
   * 返回实际替换数；被拒绝时返回 0 并记录失效命中数供界面提示。
   */
  replaceSelectedTerms(selectedKeys: string[]): { replaced: number; stale: number } {
    const byKey = new Map(this.termHits.map((h) => [h.key, h]));
    // 调用方传入的是扫描快照中的 key：当前快照中找不到同样视为“已变化”，计入失效而非静默丢弃
    const chosen: TermHit[] = [];
    let stale = 0;
    const seen = new Set<string>();
    for (const key of selectedKeys) {
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = byKey.get(key);
      if (hit) chosen.push(hit);
      else stale++;
    }
    if (chosen.length === 0 && stale === 0) return { replaced: 0, stale: 0 };
    if (stale > 0) {
      this.lastTermReplace = { replaced: 0, stale };
      this.emit();
      return { replaced: 0, stale };
    }
    const root = cloneTree(this.docState.doc.root);
    const result = replaceTermHits({ ...this.docState.doc, root }, chosen);
    this.lastTermReplace = { replaced: result.replaced, stale: result.stale };
    if (result.stale > 0) {
      // 整批拒绝：不提交历史，仅触发提示
      this.emit();
      return { replaced: 0, stale: result.stale };
    }
    this.commit({ ...this.docState, doc: result.doc });
    return { replaced: result.replaced, stale: 0 };
  }
}

function defaultSnapshotName(existing: number): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `快照 ${existing + 1}（${stamp}）`;
}

import.meta.hot?.accept();

export function useStore(store: AppStore): Snapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

export async function bootstrapStore(): Promise<AppStore> {
  // 优先本地浏览器存储；首次使用时尝试加载服务器端文件（跨浏览器共享）
  const local = localStore.load();
  if (local) return new AppStore(local);
  const remote = await serverStore.load();
  if (remote) return new AppStore(remote);
  const { sampleDocument, sampleTermRules } = await import('./sample');
  return new AppStore({
    doc: sampleDocument(),
    confirmed: {},
    annotations: [],
    termRules: sampleTermRules(),
  });
}
