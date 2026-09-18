import { useApp } from '../lib/context';
import { useHighlighter } from '../lib/highlighter';
import type { RefOccurrence } from '../../shared/model';

const STATUS_TITLE: Record<string, string> = {
  ok: '引用有效 → 点击跳转到目标',
  broken: '断链',
  ambiguous: '歧义引用',
};

export function RefInline({
  occurrence,
  highlight,
  annotationCovered = false,
  annotationActive = false,
}: {
  occurrence: RefOccurrence;
  highlight?: boolean;
  annotationCovered?: boolean;
  annotationActive?: boolean;
}) {
  const { store, highlighter } = useApp();
  const hl = useHighlighter(highlighter);
  const { resolution, span } = occurrence;
  const { analysis } = store.getSnapshot();

  const targetId = resolution.targetId ?? null;
  const targetArticle = targetId ? analysis.placement[targetId]?.article.id : null;
  const sourceArticle = analysis.placement[occurrence.nodeId]?.article.id;
  const nodeSelf = resolution.status === 'ok' && targetId === occurrence.nodeId;
  const articleSelf =
    resolution.status === 'ok' &&
    span.kind === 'absolute' &&
    targetArticle !== undefined &&
    targetArticle === sourceArticle;
  const selfRef = nodeSelf || articleSelf;

  const statusClass =
    resolution.status === 'broken'
      ? 'ref-broken'
      : resolution.status === 'ambiguous'
        ? 'ref-ambiguous'
        : selfRef
          ? 'ref-self'
          : resolution.ambiguity
            ? 'ref-confirmed'
            : 'ref-ok';

  const active = hl.hoverRefKey === occurrence.key || hl.activeRefKey === occurrence.key;

  const title =
    resolution.status === 'broken'
      ? `断链：${resolution.reason ?? '目标不存在'}`
      : resolution.status === 'ambiguous'
        ? `歧义：${resolution.reason ?? '存在多个候选，需在右侧确认'}`
        : selfRef
          ? '自引用'
          : resolution.ambiguity
            ? `已确认的歧义引用 → ${resolution.canonical ?? ''}`
            : STATUS_TITLE.ok;

  return (
    <button
      type="button"
      className={`ref-chip ${statusClass} ${active ? 'ref-active' : ''} ${highlight ? 'ref-in-sentence' : ''} ${annotationCovered ? 'ref-has-ann' : ''} ${annotationActive ? 'ref-ann-active' : ''}`}
      title={title}
      onMouseEnter={() => highlighter.hoverRef(occurrence.key, targetId)}
      onMouseLeave={() => highlighter.hoverRef(null, null)}
      onFocus={() => highlighter.hoverRef(occurrence.key, targetId)}
      onBlur={() => highlighter.hoverRef(null, null)}
      onClick={(e) => {
        e.stopPropagation();
        if (targetId && resolution.status === 'ok') {
          highlighter.jumpTo(targetId);
        }
      }}
    >
      {span.raw}
    </button>
  );
}
