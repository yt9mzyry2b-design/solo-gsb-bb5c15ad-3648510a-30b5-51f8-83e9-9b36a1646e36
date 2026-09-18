import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../lib/context';
import type { UsageRule } from '../../shared/model';
import { labelOfNode } from '../lib/labels';
import type { UsageHit } from '../lib/usage';

const CTX = 10;

export function UsagePanel() {
  const { store } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const { doc, analysis, usageRules } = store.getSnapshot();

  // 规则与正文任一变化即重新扫描（扫描快照仅保存于渲染周期）
  const hits = useMemo(() => store.getUsageHits(), [store, doc, usageRules]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rejectNotice, setRejectNotice] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  // 正文/规则变化后清理已失效的勾选（仍保留在当前快照中的才有效）
  const liveKeys = useMemo(() => new Set(hits.map((h) => h.key)), [hits]);
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((k) => liveKeys.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [liveKeys]);

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const allSelected = hits.length > 0 && selected.size === hits.length;
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(hits.map((h) => h.key)));
  };

  const apply = () => {
    const keys = [...selected];
    if (keys.length === 0) return;
    const result = store.applyUsageReplace(keys);
    if (result.rejected) {
      // 勾选集合会随最新扫描自动剔除已失效项；这里提示失败数量
      setRejectNotice(result.staleKeys.length);
    } else {
      setSelected(new Set());
      setRejectNotice(null);
    }
  };

  // 按规则聚合命中数
  const countByRule = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of hits) m.set(h.ruleId, (m.get(h.ruleId) ?? 0) + 1);
    return m;
  }, [hits]);

  return (
    <div className="usage-panel">
      <div className="usage-rules-section">
        <div className="usage-section-head">
          <span>规范词规则（{usageRules.length}）</span>
          <button className="small" onClick={() => setAdding(true)} disabled={adding}>
            + 新规则
          </button>
        </div>
        <div className="usage-rule-list">
          {usageRules.length === 0 && !adding && (
            <div className="usage-empty-rules">
              尚无规则。点击「+ 新规则」，维护“规范词 + 禁用变体”。
            </div>
          )}
          {usageRules.map((rule, i) => (
            <RuleEditor
              key={rule.id}
              rule={rule}
              index={i}
              total={usageRules.length}
              hitCount={countByRule.get(rule.id) ?? 0}
            />
          ))}
          {adding && (
            <NewRuleForm
              onCancel={() => setAdding(false)}
              onSubmit={(preferred, variants) => {
                const id = store.addUsageRule(preferred, variants);
                if (id) setAdding(false);
              }}
            />
          )}
        </div>
      </div>

      <div className="usage-hits-section">
        <div className="usage-hits-toolbar">
          <label className="usage-select-all">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={hits.length === 0} />
            全选
          </label>
          <span className="usage-hit-count">命中 {hits.length} · 已选 {selected.size}</span>
          <button
            className="small primary"
            disabled={selected.size === 0}
            onClick={apply}
            title="提交前逐项核对节点 ID 与原文区间；任一已变化则整批拒绝"
          >
            批量替换（{selected.size}）
          </button>
        </div>
        {rejectNotice !== null && rejectNotice > 0 && (
          <div className="usage-reject-banner">
            ⚠ 正文在扫描后已变化（{rejectNotice} 项核对失败），整批未替换。请重新勾选后提交。
            <button className="link-btn" onClick={() => setRejectNotice(null)}>
              知道了
            </button>
          </div>
        )}
        <div className="issue-list usage-hit-list">
          {hits.length === 0 && (
            <div className="empty-hint">
              {usageRules.some((r) => r.enabled !== false)
                ? '✓ 当前正文未命中任何禁用变体。'
                : '所有规则均已停用；启用后即可扫描。'}
            </div>
          )}
          {hits.map((hit) => (
            <UsageHitRow
              key={hit.key}
              hit={hit}
              nodeLabel={labelOfNode(analysis, hit.nodeId)}
              contextText={
                analysis.nodes[hit.nodeId]?.text ?? ''
              }
              checked={selected.has(hit.key)}
              onToggle={() => toggle(hit.key)}
            />
          ))}
        </div>
      </div>

      <div className="panel-footer">
        重叠按“起点靠前 → 变体较长 → 规则顺序靠前”消解；替换仅处理扫描快照中的已选命中，整批可撤销。
      </div>
    </div>
  );
}

function parseVariantText(raw: string): string[] {
  return raw
    .split(/[、,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function NewRuleForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (preferred: string, variants: string[]) => void;
  onCancel: () => void;
}) {
  const [preferred, setPreferred] = useState('');
  const [variantText, setVariantText] = useState('');
  const variants = parseVariantText(variantText);
  const canSubmit = preferred.trim().length > 0 && variants.length > 0;

  const submit = () => {
    if (canSubmit) onSubmit(preferred.trim(), variants);
  };

  return (
    <div className="usage-rule-row usage-rule-new">
      <div className="usage-rule-edit">
        <input
          className="usage-preferred-input"
          autoFocus
          value={preferred}
          placeholder="规范词（替换目标）"
          onChange={(e) => setPreferred(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            }
            if (e.key === 'Escape') onCancel();
          }}
        />
        <input
          className="usage-variant-input"
          value={variantText}
          placeholder="禁用变体，多个用顿号或逗号分隔"
          onChange={(e) => setVariantText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            }
            if (e.key === 'Escape') onCancel();
          }}
        />
        <div className="usage-rule-edit-actions">
          <button className="small" onClick={onCancel}>
            取消
          </button>
          <button className="small primary" disabled={!canSubmit} onClick={submit}>
            添加
          </button>
        </div>
      </div>
    </div>
  );
}

function RuleEditor({
  rule,
  index,
  total,
  hitCount,
}: {
  rule: UsageRule;
  index: number;
  total: number;
  hitCount: number;
}) {
  const { store } = useApp();
  const [preferredDraft, setPreferredDraft] = useState(rule.preferred);
  const [variantDraft, setVariantDraft] = useState(rule.variants.join('、'));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setPreferredDraft(rule.preferred);
    setVariantDraft(rule.variants.join('、'));
  }, [rule.id, rule.preferred, rule.variants]);

  const enabled = rule.enabled !== false;

  const save = () => {
    const variants = parseVariantText(variantDraft);
    const preferred = preferredDraft.trim();
    if (preferred && variants.length > 0) {
      store.updateUsageRule(rule.id, { preferred, variants });
      setEditing(false);
    }
  };

  const remove = () => {
    if (confirm('确定删除该规范用语规则？此操作可通过撤销恢复。')) {
      store.deleteUsageRule(rule.id);
    }
  };

  return (
    <div className={`usage-rule-row ${enabled ? '' : 'is-disabled'} ${hitCount > 0 ? 'has-hits' : ''}`}>
      <label className="usage-rule-toggle" title={enabled ? '停用该规则' : '启用该规则'}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => store.updateUsageRule(rule.id, { enabled: e.target.checked })}
        />
      </label>
      {editing ? (
        <div className="usage-rule-edit">
          <input
            className="usage-preferred-input"
            value={preferredDraft}
            placeholder="规范词"
            onChange={(e) => setPreferredDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                save();
              }
              if (e.key === 'Escape') {
                setPreferredDraft(rule.preferred);
                setVariantDraft(rule.variants.join('、'));
                setEditing(false);
              }
            }}
          />
          <input
            className="usage-variant-input"
            value={variantDraft}
            placeholder="禁用变体，多个用顿号或逗号分隔"
            onChange={(e) => setVariantDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                save();
              }
              if (e.key === 'Escape') {
                setPreferredDraft(rule.preferred);
                setVariantDraft(rule.variants.join('、'));
                setEditing(false);
              }
            }}
          />
          <div className="usage-rule-edit-actions">
            <button
              className="small"
              onClick={() => {
                setPreferredDraft(rule.preferred);
                setVariantDraft(rule.variants.join('、'));
                setEditing(false);
              }}
            >
              取消
            </button>
            <button
              className="small primary"
              disabled={!preferredDraft.trim() || parseVariantText(variantDraft).length === 0}
              onClick={save}
            >
              保存
            </button>
          </div>
        </div>
      ) : (
        <div className="usage-rule-view" onClick={() => setEditing(true)} title="点击编辑规则">
          <span className="usage-preferred">{rule.preferred}</span>
          <span className="usage-arrow">⇐</span>
          <span className="usage-variants" title={rule.variants.join('、')}>
            {rule.variants.join('、')}
          </span>
          {hitCount > 0 && <span className="usage-rule-hit-badge">{hitCount}</span>}
        </div>
      )}
      <div className="usage-rule-actions">
        <button
          className="link-btn subtle"
          title="上移（提高重叠消解优先级）"
          disabled={index === 0}
          onClick={() => store.moveUsageRule(rule.id, index - 1)}
        >
          ↑
        </button>
        <button
          className="link-btn subtle"
          title="下移"
          disabled={index === total - 1}
          onClick={() => store.moveUsageRule(rule.id, index + 1)}
        >
          ↓
        </button>
        <button className="link-btn subtle" title="编辑" onClick={() => setEditing(true)}>
          编辑
        </button>
        <button className="link-btn subtle" title="删除" onClick={remove}>
          删除
        </button>
      </div>
    </div>
  );
}

function UsageHitRow({
  hit,
  nodeLabel,
  contextText,
  checked,
  onToggle,
}: {
  hit: UsageHit;
  nodeLabel: string;
  contextText: string;
  checked: boolean;
  onToggle: () => void;
}) {
  const { highlighter } = useApp();

  const before = contextText.slice(Math.max(0, hit.start - CTX), hit.start);
  const after = contextText.slice(hit.end, hit.end + CTX);

  const jump = () => {
    highlighter.jumpToUsage(hit.key, hit.nodeId, { start: hit.start, end: hit.end });
  };

  return (
    <div className={`issue-row usage-hit-row ${checked ? 'is-checked' : ''}`}>
      <div className="usage-hit-head">
        <label className="usage-hit-check" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={checked} onChange={onToggle} />
        </label>
        <span className="issue-source-label">{nodeLabel}</span>
      </div>
      <button className="issue-sentence usage-hit-context" onClick={jump} title="跳到正文命中位置">
        {before ? `…${before}` : ''}
        <mark className="usage-hit-mark">{hit.match}</mark>
        <span className="usage-hit-replace">→ {hit.preferred}</span>
        {after ? `${after}…` : ''}
      </button>
    </div>
  );
}
