import type { RefSpan, NumStyle } from '../../shared/model';
import { parseOrdinal } from './numeral';

const NUM = '0-9０-９零一二三四五六七八九十百千万两〇'; // 〇(U+3007) 放在末尾，避免被当作字符范围端点
const N = `[${NUM}]`;
const G = '[\\s　]*';

/** 项的两种写法拆成两个独立可选组：第M项 / （M），避免二选一组导致回溯失效 */
function itemAbs(p: string): string {
  return (
    `(?:${G}第(?<${p}Item>${N}+)${G}项)?` +
    `(?:${G}(?<${p}ItemP>第?（(?<${p}ItemPn>${N}+)）项?))?`
  );
}

/**
 * 总正则按优先级排列：
 * 绝对引用 → 本条链 → 前/后条链 → 前款 → 前项/本项/本款 → 裸（X）
 */
const REF_SOURCE =
  // 1) 第X条[之Y][【条名】][第N款][第M项/（M）]
  `第(?<aNum>${N}+)${G}条` +
  `(?:${G}之${G}(?<aSuf>${N}+))?` +
  `(?:${G}[【\\[](?<aName>[^】\\]]+)[】\\]])?` +
  `(?:${G}第(?<aPar>${N}+)${G}款)?` +
  itemAbs('a') +
  `|` +
  // 2) 本条[第N款][第M项/（M）]
  `本条(?:${G}第(?<tPar>${N}+)${G}款)?` +
  itemAbs('t') +
  `|` +
  // 3) 前条/上条/后条/下条（可叠用，如“后后条”）
  `(?<chain>(?:前|上|后|下)条|(?:[前上后下]){2,}?条)` +
  `(?:${G}第(?<cPar>${N}+)${G}款)?` +
  itemAbs('c') +
  `|` +
  // 4) 前款[第M项/（M）]
  `前款` +
  itemAbs('pp') +
  `|` +
  // 5) 前项 / 本项 / 本款[第M项]
  `前项|本项|本款(?:${G}第(?<tpItem>${N}+)${G}项)?` +
  `|` +
  // 6) 裸（X）
  `（(?<bItem>${N}+)）`;

interface Pn {
  value: number;
  style: NumStyle;
}

function pickNum(g: RegExpNamedGroups, ...keys: string[]): Pn | null {
  for (const k of keys) {
    const raw = g[k];
    if (raw !== undefined) {
      const parsed = parseOrdinal(raw);
      if (parsed) return parsed;
    }
  }
  return null;
}

type RegExpNamedGroups = Record<string, string | undefined>;

const SUFFIX_WORDS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function suffixWord(value: number): string {
  return SUFFIX_WORDS[value - 1] ?? String(value);
}

/** 扫描一段正文中的全部交叉引用 span（按起始位置升序、互不嵌套） */
export function scanReferences(text: string): RefSpan[] {
  const re = new RegExp(REF_SOURCE, 'gu');
  const spans: RefSpan[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) continue;
    const g: RegExpNamedGroups = m.groups ?? {};
    const head = m[0];
    let span: RefSpan | null = null;

    if (g['aNum'] !== undefined) {
      const a = parseOrdinal(g['aNum']!);
      if (!a) continue;
      const suf = g['aSuf'] !== undefined ? parseOrdinal(g['aSuf']!) : null;
      const p = pickNum(g, 'aPar');
      const it = pickNum(g, 'aItem', 'aItemPn');
      span = {
        start: m.index,
        end: m.index + head.length,
        raw: head,
        kind: 'absolute',
        articleNum: a.value,
        articleStyle: a.style,
        ...(suf ? { articleSuffix: suffixWord(suf.value) } : {}),
        ...(p ? { paragraphNum: p.value, paragraphStyle: p.style } : {}),
        ...(it ? { itemNum: it.value, itemStyle: it.style, itemParenForm: g['aItemP'] !== undefined } : {}),
      };
    } else if (head.startsWith('本条')) {
      const p = pickNum(g, 'tPar');
      const it = pickNum(g, 'tItem', 'tItemPn');
      span = {
        start: m.index,
        end: m.index + head.length,
        raw: head,
        kind: 'this',
        ...(p ? { paragraphNum: p.value, paragraphStyle: p.style } : {}),
        ...(it ? { itemNum: it.value, itemStyle: it.style, itemParenForm: g['tItemP'] !== undefined } : {}),
      };
    } else if (g['chain'] !== undefined) {
      const chain = g['chain']!;
      const first = chain[0];
      const dir = first === '前' || first === '上' ? -1 : 1;
      const p = pickNum(g, 'cPar');
      const it = pickNum(g, 'cItem', 'cItemPn');
      span = {
        start: m.index,
        end: m.index + head.length,
        raw: head,
        kind: dir === -1 ? 'prevArticle' : 'nextArticle',
        articleNum: chain.length - 1,
        ...(p ? { paragraphNum: p.value, paragraphStyle: p.style } : {}),
        ...(it ? { itemNum: it.value, itemStyle: it.style, itemParenForm: g['cItemP'] !== undefined } : {}),
      };
    } else if (head.startsWith('前款')) {
      const it = pickNum(g, 'ppItem', 'ppItemPn');
      span = {
        start: m.index,
        end: m.index + head.length,
        raw: head,
        kind: 'prevParagraph',
        ...(it ? { itemNum: it.value, itemStyle: it.style, itemParenForm: g['ppItemP'] !== undefined } : {}),
      };
    } else if (head.startsWith('前项')) {
      span = { start: m.index, end: m.index + head.length, raw: head, kind: 'prevItem' };
    } else if (head.startsWith('本项')) {
      span = { start: m.index, end: m.index + head.length, raw: head, kind: 'thisItem' };
    } else if (head.startsWith('本款')) {
      const it = pickNum(g, 'tpItem');
      span = {
        start: m.index,
        end: m.index + head.length,
        raw: head,
        kind: 'thisParagraph',
        ...(it ? { itemNum: it.value, itemStyle: it.style } : {}),
      };
    } else if (g['bItem'] !== undefined) {
      const it = parseOrdinal(g['bItem']!);
      if (it) {
        span = {
          start: m.index,
          end: m.index + head.length,
          raw: head,
          kind: 'bareItem',
          itemNum: it.value,
          itemStyle: it.style,
          itemParenForm: true,
        };
      }
    }

    if (span) {
      const covered = spans.some((s) => span!.start >= s.start && span!.end <= s.end);
      if (!covered) spans.push(span);
    }
  }
  return spans;
}
