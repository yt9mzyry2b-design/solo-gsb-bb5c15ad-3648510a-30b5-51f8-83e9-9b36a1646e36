import type {
  ClauseDocument,
  ClauseNode,
  UsageRule,
} from '../../shared/model';
import { uid } from './uid';

/** 规范用语命中：扫描快照中的一条记录（key 在一次扫描内稳定） */
export interface UsageHit {
  /** 扫描快照内的稳定 id：节点 + 起点 + 规则 + 变体 */
  key: string;
  nodeId: string;
  start: number;
  end: number;
  /** 命中的禁用变体原文 */
  match: string;
  /** 替换目标规范词 */
  preferred: string;
  ruleId: string;
  ruleIndex: number;
  /** 变体在规则内的序号（供展示与排序） */
  variantIndex: number;
}

export interface UsageScanResult {
  hits: UsageHit[];
}

function walk(nodes: ClauseNode[], fn: (n: ClauseNode) => void): void {
  for (const n of nodes) {
    fn(n);
    walk(n.children, fn);
  }
}

/** 规整单条规则：规范词与变体去空白、变体去重、丢弃空变体/与规范词相同的变体 */
export function normalizeRule(rule: UsageRule): UsageRule {
  const preferred = rule.preferred;
  const seen = new Set<string>();
  const variants: string[] = [];
  for (const v of rule.variants) {
    if (!v || v === preferred) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    variants.push(v);
  }
  return { ...rule, preferred, variants };
}

export function createUsageRule(preferred: string, variants: string[], now = Date.now()): UsageRule {
  return normalizeRule({
    id: uid('usr'),
    preferred,
    variants,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * 扫描单个节点文本。
 * 重叠消解优先级：起点靠前 > 变体（规则）较长 > 规则顺序靠前；同规则内变体顺序靠前。
 * 采用按起点贪心：每一步从当前光标选优先级最高的候选，选中后跳过与其重叠的候选。
 */
export function scanUsageText(text: string, rules: UsageRule[]): UsageHit[] {
  if (!text) return [];
  const active = rules
    .map((rule, ruleIndex) => ({ rule, ruleIndex }))
    .filter(({ rule }) => rule.enabled !== false && rule.preferred);

  // 收集全部候选：{起点, 长度, 规则序, 变体序}
  const candidates: UsageHit[] = [];
  for (const { rule, ruleIndex } of active) {
    rule.variants.forEach((variant, variantIndex) => {
      if (!variant) return;
      let from = 0;
      for (;;) {
        const start = text.indexOf(variant, from);
        if (start < 0) break;
        candidates.push({
          key: '',
          nodeId: '',
          start,
          end: start + variant.length,
          match: variant,
          preferred: rule.preferred,
          ruleId: rule.id,
          ruleIndex,
          variantIndex,
        });
        from = start + 1;
      }
    });
  }
  // 起点靠前 → 较长优先 → 规则顺序靠前 → 变体顺序靠前
  candidates.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.end !== b.end) return b.end - a.end;
    if (a.ruleIndex !== b.ruleIndex) return a.ruleIndex - b.ruleIndex;
    return a.variantIndex - b.variantIndex;
  });

  const chosen: UsageHit[] = [];
  let cursor = 0;
  for (const c of candidates) {
    if (c.start < cursor) continue; // 与已选命中重叠：起点贪心已保证高优先级者先入选
    chosen.push(c);
    cursor = c.end;
  }
  return chosen;
}

/**
 * 扫描整篇文档（随规则与正文实时调用）。
 * 命中按文档顺序（条 → 款 → 项的深度优先顺序）排列。
 */
export function scanUsage(doc: ClauseDocument, rules: UsageRule[]): UsageScanResult {
  const hits: UsageHit[] = [];
  walk(doc.root, (node) => {
    const local = scanUsageText(node.text, rules);
    local.forEach((h, i) => {
      hits.push({
        ...h,
        nodeId: node.id,
        key: `${node.id}:${h.start}:${h.ruleId}:${encodeURIComponent(h.match)}:${i}`,
      });
    });
  });
  return { hits };
}

/** 单节点视角的扫描（供正文高亮使用，key 与全文扫描一致） */
export function scanUsageNode(node: ClauseNode, rules: UsageRule[]): UsageHit[] {
  return scanUsageText(node.text, rules).map((h, i) => ({
    ...h,
    nodeId: node.id,
    key: `${node.id}:${h.start}:${h.ruleId}:${encodeURIComponent(h.match)}:${i}`,
  }));
}

/** 批量替换前对快照命中逐项核对的结果 */
export interface UsageReplaceVerification {
  ok: boolean;
  /** 未通过核对的命中 key（节点不存在 / 原文区间已变化） */
  staleKeys: string[];
}

/** 提交前逐项核对：节点必须仍存在，且 [start,end) 区间原文仍等于命中变体；任一不通过整批拒绝 */
export function verifyUsageHits(
  root: ClauseNode[],
  hits: UsageHit[],
  selectedKeys: string[],
): UsageReplaceVerification {
  const byId = new Map<string, ClauseNode>();
  walk(root, (n) => byId.set(n.id, n));
  const byKey = new Map(hits.map((h) => [h.key, h]));
  const staleKeys: string[] = [];
  for (const key of selectedKeys) {
    const h = byKey.get(key);
    if (!h) {
      staleKeys.push(key);
      continue;
    }
    const node = byId.get(h.nodeId);
    if (!node) {
      staleKeys.push(key);
      continue;
    }
    if (h.start < 0 || h.end <= h.start || h.end > node.text.length) {
      staleKeys.push(key);
      continue;
    }
    if (node.text.slice(h.start, h.end) !== h.match) {
      staleKeys.push(key);
      continue;
    }
  }
  return { ok: staleKeys.length === 0, staleKeys };
}

export interface UsageReplaceResult {
  /** 实际替换数 */
  applied: number;
  /** 核对失败、整批拒绝时为 true（文档未做任何修改） */
  rejected: boolean;
  staleKeys: string[];
}

/**
 * 按扫描快照中的已选命中执行替换：
 * 核对任一失败则整批拒绝；通过后按节点从后向前替换，单步完成，
 * 仅替换快照命中，不递归处理替换新生成的文字。
 */
export function applyUsageReplace(
  root: ClauseNode[],
  hits: UsageHit[],
  selectedKeys: string[],
): { root: ClauseNode[]; result: UsageReplaceResult } {
  const verification = verifyUsageHits(root, hits, selectedKeys);
  if (!verification.ok) {
    return {
      root,
      result: { applied: 0, rejected: true, staleKeys: verification.staleKeys },
    };
  }
  if (selectedKeys.length === 0) {
    return { root, result: { applied: 0, rejected: false, staleKeys: [] } };
  }

  const byKey = new Map(hits.map((h) => [h.key, h]));
  const selected = selectedKeys.map((k) => byKey.get(k)!).filter(Boolean);
  // 按节点分组
  const byNode = new Map<string, UsageHit[]>();
  for (const h of selected) {
    const list = byNode.get(h.nodeId) ?? [];
    list.push(h);
    byNode.set(h.nodeId, list);
  }

  const nodeById = new Map<string, ClauseNode>();
  walk(root, (n) => nodeById.set(n.id, n));

  // 从后向前替换：逐节点、节点内按起点倒序，避免偏移变化
  const nodeOrder = [...nodeById.keys()];
  for (let ni = nodeOrder.length - 1; ni >= 0; ni--) {
    const node = nodeById.get(nodeOrder[ni])!;
    const list = byNode.get(node.id);
    if (!list) continue;
    const sorted = [...list].sort((a, b) => b.start - a.start);
    let text = node.text;
    for (const h of sorted) {
      text = text.slice(0, h.start) + h.preferred + text.slice(h.end);
    }
    node.text = text;
  }

  return {
    root,
    result: { applied: selected.length, rejected: false, staleKeys: [] },
  };
}

/**
 * 规整外部数据（旧持久化 / 导入 JSON）中的规范用语规则。
 * 旧数据缺少该字段时按空规则加载；丢弃规范词为空或无有效变体的条目。
 */
export function sanitizeUsageRules(value: unknown): UsageRule[] {
  if (!Array.isArray(value)) return [];
  const now = Date.now();
  const out: UsageRule[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Partial<UsageRule>;
    const preferred = typeof r.preferred === 'string' ? r.preferred : '';
    if (!preferred) continue;
    if (!Array.isArray(r.variants)) continue;
    const variants = r.variants.filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (variants.length === 0) continue;
    out.push(
      normalizeRule({
        id: typeof r.id === 'string' && r.id ? r.id : uid('usr'),
        preferred,
        variants,
        enabled: r.enabled === false ? false : true,
        createdAt: typeof r.createdAt === 'number' ? r.createdAt : now,
        updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : now,
      }),
    );
  }
  return out;
}
