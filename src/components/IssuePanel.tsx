import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../lib/context';
import type { Issue, IssueType, RefOccurrence } from '../../shared/model';
import { labelOfNode } from '../lib/labels';

const TYPE_META: Record<IssueType, { label: string; cls: string; icon: string }> = {
  broken: { label: '断链', cls: 'it-broken', icon: '⛓' },
  self: { label: '自引用', cls: 'it-self', icon: '↺' },
  cycle: { label: '循环引用', cls: 'it-cycle', icon: '🔄' },
  ambiguous: { label: '歧义引用', cls: 'it-ambiguous', icon: '❓' },
};

const ORDER: IssueType[] = ['broken', 'cycle', 'self', 'ambiguous'];

export function IssuePanel() {
  const { store } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const { analysis } = store.getSnapshot();
  const [filter, setFilter] = useState<IssueType | 'all'>('all');

  const groups = useMemo(() => {
    const map = new Map<IssueType, Issue[]>();
    for (const issue of analysis.issues) {
      const list = map.get(issue.type) ?? [];
      list.push(issue);
      map.set(issue.type, list);
    }
    return map;
  }, [analysis]);

  const visible =
    filter === 'all'
      ? analysis.issues
      : groups.get(filter) ?? [];

  const counts = ORDER.map((t) => [t, groups.get(t)?.length ?? 0] as const);

  return (
    <div className="issue-panel">
      <div className="issue-filters">
        <button
          className={filter === 'all' ? 'active' : ''}
          onClick={() => setFilter('all')}
        >
          全部 {analysis.issues.length}
        </button>
        {counts.map(([t, n]) => (
          <button
            key={t}
            className={`${TYPE_META[t].cls} ${filter === t ? 'active' : ''}`}
            disabled={n === 0}
            onClick={() => setFilter(t)}
          >
            {TYPE_META[t].icon} {TYPE_META[t].label} {n}
          </button>
        ))}
      </div>

      <div className="issue-list">
        {visible.length === 0 && (
          <div className="empty-hint">
            {analysis.issues.length === 0
              ? '✓ 全部引用均可唯一定位，且不存在自引用或循环。'
              : '该类别下暂无问题。'}
          </div>
        )}
        {visible.map((issue) => (
          <IssueRow key={issue.key} issue={issue} />
        ))}
      </div>

      <div className="panel-footer">
        点击问题可跳到源句；悬停正文引用可在关系视图中联动高亮。
      </div>
    </div>
  );
}

function IssueRow({ issue }: { issue: Issue }) {
  const { store, highlighter } = useApp();
  const { analysis } = store.getSnapshot();
  const meta = TYPE_META[issue.type];
  const sourceNode = analysis.nodes[issue.sourceNodeId];
  const refOcc: RefOccurrence | undefined = issue.refKey
    ? analysis.occurrences.find((o) => o.key === issue.refKey)
    : undefined;

  const sentenceText = sourceNode
    ? sourceNode.text.slice(issue.sentenceStart, issue.sentenceEnd).trim()
    : '';

  const jumpSource = () => {
    highlighter.jumpTo(
      issue.sourceNodeId,
      { start: issue.sentenceStart, end: issue.sentenceEnd },
      issue.refKey,
    );
  };
  const jumpTarget = () => {
    if (issue.targetNodeId) highlighter.jumpTo(issue.targetNodeId);
  };

  return (
    <div className={`issue-row ${meta.cls} ${issue.confirmedTargetId ? 'is-confirmed' : ''}`}>
      <div className="issue-row-head">
        <span className="issue-type-tag">
          {meta.icon} {issue.confirmedTargetId ? `${meta.label}（已确认）` : meta.label}
        </span>
        <span className="issue-source-label">
          {labelOfNode(analysis, issue.sourceNodeId)}
        </span>
      </div>
      <button className="issue-sentence" onClick={jumpSource} title="跳到源句">
        “{sentenceText.length > 60 ? sentenceText.slice(0, 60) + '…' : sentenceText}”
      </button>
      <div className="issue-message">{issue.message}</div>

      {issue.type === 'ambiguous' && refOcc && (
        <CandidatePicker occurrence={refOcc} />
      )}

      {issue.targetNodeId && issue.type !== 'ambiguous' && (
        <button className="link-btn" onClick={jumpTarget}>
          → 定位目标：{labelOfNode(analysis, issue.targetNodeId)}
        </button>
      )}
      {issue.cycleNodeIds && (
        <div className="cycle-chain">
          {issue.cycleNodeIds.map((id, i) => (
            <span key={id}>
              <button className="link-btn" onClick={() => highlighter.jumpTo(id)}>
                {labelOfNode(analysis, id)}
              </button>
              {i < issue.cycleNodeIds!.length - 1 ? ' → ' : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CandidatePicker({ occurrence }: { occurrence: RefOccurrence }) {
  const { store, highlighter } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const { analysis, confirmed } = store.getSnapshot();
  const candidates =
    occurrence.resolution.candidates ?? occurrence.resolution.ambiguity?.candidates ?? [];
  const chosen =
    occurrence.resolution.ambiguity
      ? occurrence.resolution.targetId
      : confirmed[occurrence.signature];

  return (
    <div className="candidate-box">
      <div className="candidate-title">
        {chosen
          ? `已确认目标为 ${chosen ? labelOfNode(analysis, chosen) : ''}，可撤销后重新选择：`
          : `存在 ${candidates.length} 个候选，系统不会自动改写，请确认目标：`}
      </div>
      {candidates.map((id) => (
        <label key={id} className={`candidate-item ${chosen === id ? 'chosen' : ''}`}>
          <input
            type="radio"
            name={`cand-${occurrence.key}`}
            checked={chosen === id}
            onChange={() => store.confirmAmbiguous(occurrence.signature, id)}
          />
          <button
            type="button"
            className="link-btn"
            onClick={(e) => {
              e.preventDefault();
              highlighter.jumpTo(id);
            }}
          >
            {labelOfNode(analysis, id)}
          </button>
        </label>
      ))}
      {chosen && (
        <div className="candidate-actions">
          <button
            className="link-btn"
            onClick={() => highlighter.jumpTo(chosen)}
          >
            → 跳到已确认目标
          </button>
          <button
            className="link-btn subtle"
            onClick={() => store.clearConfirmation(occurrence.signature)}
          >
            撤销确认（恢复为歧义）
          </button>
        </div>
      )}
    </div>
  );
}
