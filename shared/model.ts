// 共享数据模型：前端状态、分析结果、导入导出均使用这些类型

export type NodeKind = 'article' | 'paragraph' | 'item';

export interface ClauseNode {
  id: string;
  kind: NodeKind;
  /** 结构序号（从 1 开始，始终等于其在同级中的位置） */
  ordinal: number;
  /** 条序号后缀原文，如 “之一”“之二” */
  suffix?: string;
  /** 条标题行中编号之后的文字，如【立法目的】 */
  title?: string;
  /** 正文（不含“第X条”“（一）”等编号前缀） */
  text: string;
  children: ClauseNode[];
}

export interface ClauseDocument {
  id: string;
  title: string;
  /** 顶层节点：条 */
  root: ClauseNode[];
  updatedAt: number;
}

export type NumStyle = 'arabic' | 'chinese';
export type RefKind =
  | 'absolute' // 第X条[之Y][第N款][第M项 / （M）]
  | 'this' // 本条[第N款][第M项]
  | 'prevArticle' // 前条 / 上条[链]
  | 'nextArticle' // 后条 / 下条[链]
  | 'prevParagraph' // 前款[第M项]
  | 'prevItem' // 前项
  | 'thisParagraph' // 本款[第M项]
  | 'thisItem' // 本项
  | 'bareItem'; // （M）

export interface RefSpan {
  start: number;
  end: number;
  raw: string;
  kind: RefKind;
  articleNum?: number;
  articleSuffix?: string;
  paragraphNum?: number;
  itemNum?: number;
  /** 项编号的书写形式 */
  itemParenForm?: boolean;
  articleStyle?: NumStyle;
  paragraphStyle?: NumStyle;
  itemStyle?: NumStyle;
}

export type RefStatus = 'ok' | 'broken' | 'ambiguous';

export interface RefResolution {
  status: RefStatus;
  /** 唯一定位时的目标节点 id */
  targetId?: string;
  /** 歧义时的候选节点 id 列表 */
  candidates?: string[];
  /** 唯一定位时的规范引用文字 */
  canonical?: string;
  /** 不可解析原因 / 歧义说明 */
  reason?: string;
  /** 已由用户确认的歧义引用：保留原始候选与原因，便于复核或撤销 */
  ambiguity?: {
    candidates: string[];
    reason?: string;
  };
}

export interface RefOccurrence {
  /** nodeId + 偏移构成的稳定 id */
  key: string;
  nodeId: string;
  span: RefSpan;
  resolution: RefResolution;
  /** 同节点内同原文的第几次出现（用于确认签名） */
  occurrenceIndex: number;
  /** 确认映射使用的签名 */
  signature: string;
}

export type IssueType = 'broken' | 'self' | 'cycle' | 'ambiguous';

export interface Issue {
  key: string;
  type: IssueType;
  sourceNodeId: string;
  /** 源句在正文中的字符区间 */
  sentenceStart: number;
  sentenceEnd: number;
  /** 引用 span 区间（cycle 类问题可能没有单一 span） */
  refStart?: number;
  refEnd?: number;
  refKey?: string;
  targetNodeId?: string;
  message: string;
  /** 循环路径上的节点 id */
  cycleNodeIds?: string[];
  /** 歧义已被用户确认时的目标 id（问题转为“已确认”状态，仍可撤销） */
  confirmedTargetId?: string;
}

export interface Analysis {
  nodes: Record<string, ClauseNode>;
  articles: ClauseNode[];
  /** nodeId -> 结构位置信息 */
  placement: Record<string, NodePlacement>;
  occurrences: RefOccurrence[];
  byNode: Record<string, RefOccurrence[]>;
  issues: Issue[];
  /** 条级引用边（用于关系视图） */
  edges: ArticleEdge[];
}

export interface NodePlacement {
  article: ClauseNode;
  articleIndex: number;
  paragraph?: ClauseNode;
  paragraphIndex: number; // 该条下第几段（条头为第 0 段，正文段从 1 开始）
  item?: ClauseNode;
  itemIndex: number; // 该段下第几项（从 1 开始）
}

export interface ArticleEdge {
  sourceArticleId: string;
  targetArticleId: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: RefKind;
  status: RefStatus;
  refKey: string;
}

/** 批注锚定状态：anchored 已唯一定位；review 片段缺失或多处匹配，需人工复核 */
export type AnnotationStatus = 'anchored' | 'review';

/** 重定位时保留的候选位置（按前后文相似度降序） */
export interface AnnotationCandidate {
  nodeId: string;
  start: number;
  end: number;
  /** 与批注前后文锚点的相似度评分（公共前缀+后缀长度） */
  score: number;
}

/** 待复核原因 */
export type AnnotationReviewReason =
  | 'multi-in-node' // 片段在原节点出现多处
  | 'multi-match' // 片段在全文多处匹配
  | 'missing' // 节点仍在但片段缺失
  | 'node-missing'; // 原节点已删除且未找到片段

/**
 * 审阅批注：锚定到稳定节点 ID 上的正文片段。
 * start/end 为当前定位（review 时取评分最高的候选，仅供参考）；
 * quote 为创建时的原文片段，prefix/suffix 为前后文锚点。
 */
export interface Annotation {
  id: string;
  nodeId: string;
  start: number;
  end: number;
  /** 引用片段原文（创建后不变） */
  quote: string;
  /** 片段前文锚点 */
  prefix: string;
  /** 片段后文锚点 */
  suffix: string;
  /** 批注正文 */
  content: string;
  status: AnnotationStatus;
  reason?: AnnotationReviewReason;
  /** review 时保留的候选位置 */
  candidates?: AnnotationCandidate[];
  createdAt: number;
  updatedAt: number;
}

/**
 * 规范用语规则：canonical 为规范词，variants 为该规则下的全部禁用变体。
 * 变体命中后可批量替换为 canonical；同一文档内按规则数组顺序参与重叠消解。
 */
export interface TermRule {
  id: string;
  /** 规范词（替换目标） */
  canonical: string;
  /** 禁用变体（匹配原文） */
  variants: string[];
  /** 规则顺序（数组下标即优先级，仅用于展示） */
  createdAt: number;
}

/**
 * 规范用语扫描命中：一次禁用变体在某节点正文中的出现。
 * start/end 对应当前快照正文偏移；相邻命中经重叠消解后互不交叠。
 */
export interface TermHit {
  /** nodeId:start:end:ruleId 构成的稳定 id */
  key: string;
  ruleId: string;
  /** 规则顺序下标（同一位置被多个规则命中时，顺序靠前的优先） */
  ruleIndex: number;
  canonical: string;
  /** 命中的禁用变体原文 */
  variant: string;
  nodeId: string;
  start: number;
  end: number;
  /** 扫描快照时刻该节点的完整正文（替换提交前据此核对节点原文是否已变化） */
  nodeText: string;
}

/** 命名版本快照：保存时刻的文档、歧义确认、批注与规范用语规则（只读，不随后续编辑变化） */
export interface DocSnapshot {
  id: string;
  name: string;
  createdAt: number;
  doc: ClauseDocument;
  /** 保存时刻的歧义确认记录 */
  confirmed: Record<string, string>;
  /** 保存时刻的审阅批注；旧数据缺少该字段时按空列表加载 */
  annotations?: Annotation[];
  /** 保存时刻的规范用语规则；旧数据缺少该字段时按空列表加载 */
  termRules?: TermRule[];
}

/** 持久化状态（同时用于本地文件与浏览器缓存） */
export interface PersistedState {
  doc: ClauseDocument;
  /** 歧义引用确认：signature -> targetId */
  confirmed: Record<string, string>;
  /** 命名版本快照；旧数据缺少该字段时按空列表加载 */
  snapshots?: DocSnapshot[];
  /** 审阅批注；旧数据缺少该字段时按空列表加载 */
  annotations?: Annotation[];
  /** 规范用语规则；旧数据缺少该字段时按空规则加载 */
  termRules?: TermRule[];
}

export interface ExportBundle {
  app: 'clause-reference-validator';
  version: 1;
  document: ClauseDocument;
  confirmed: Record<string, string>;
  /** 命名版本快照随 JSON 一并导出，导入时恢复 */
  snapshots?: DocSnapshot[];
  /** 审阅批注随 JSON 一并导出，导入时恢复并尝试重定位 */
  annotations?: Annotation[];
  /** 规范用语规则随 JSON 一并导出；旧文件缺少该字段时按空规则加载 */
  termRules?: TermRule[];
  exportedAt: string;
}
