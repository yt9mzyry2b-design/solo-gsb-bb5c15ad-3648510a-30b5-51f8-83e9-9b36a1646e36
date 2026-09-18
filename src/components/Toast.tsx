import { useEffect, useRef, useState } from 'react';
import { useApp } from '../lib/context';

interface ToastData {
  id: number;
  text: string;
  kind: 'info' | 'warn';
}

let seq = 0;

/** 监听结构操作后的原子改写结果与规范用语批量替换结果，弹出提示（文本编辑不提示） */
export function ToastHost() {
  const { store } = useApp();
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const lastInfo = useRef<{ rewritten: number; skipped: number; review: number; doc: unknown } | null>(null);
  const lastUsage = useRef<{ applied: number; rejected: boolean; stale: number; nonce: number } | null>(null);

  const pushToast = (text: string, kind: ToastData['kind']) => {
    const id = ++seq;
    setToasts((t) => [...t.slice(-2), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  };

  useEffect(() => {
    return store.subscribe(() => {
      // 规范用语批量替换结果（整批拒绝时文档无变化，不会触发结构操作提示）
      const usage = store.lastUsageReplace;
      const usageNonce = store.lastUsageReplaceNonce;
      if (usage && (!lastUsage.current || lastUsage.current.nonce !== usageNonce)) {
        lastUsage.current = {
          applied: usage.applied,
          rejected: usage.rejected,
          stale: usage.staleKeys.length,
          nonce: usageNonce,
        };
        if (usage.rejected) {
          pushToast(
            `规范用语替换被整批拒绝：${usage.staleKeys.length} 项命中的节点或原文已变化，请重新勾选`,
            'warn',
          );
        } else if (usage.applied > 0) {
          pushToast(`已批量替换 ${usage.applied} 处规范用语（可整体撤销）`, 'info');
        }
      }

      const snap = store.getSnapshot();
      const info = store.lastRewriteInfo;
      if (!info) return;
      const review = store.lastAnnotationReviewCount;
      const prev = lastInfo.current;
      // 仅在结构操作真正产生改写信息且文档引用身份变化时提示，避免文本编辑刷屏
      const isNewStructuralOp =
        !prev ||
        prev.rewritten !== info.rewritten ||
        prev.skipped !== info.skipped ||
        prev.review !== review;
      if (
        !isNewStructuralOp ||
        (info.rewritten === 0 && info.skipped === 0 && review === 0)
      ) {
        lastInfo.current = { ...info, review, doc: snap.doc };
        return;
      }
      lastInfo.current = { ...info, review, doc: snap.doc };
      const parts: string[] = [];
      if (info.rewritten > 0) {
        parts.push(`已原子更新 ${info.rewritten} 处可唯一定位的引用`);
      }
      if (info.skipped) {
        parts.push(`${info.skipped} 处歧义/断链未自动改写`);
      }
      if (review > 0) {
        parts.push(`${review} 条批注待复核（见右侧审阅批注）`);
      }
      const text =
        parts.length > 0
          ? parts.join('；')
          : `${info.skipped} 处引用无法唯一定位，未自动改写（见右侧问题列表）`;
      pushToast(text, info.skipped || review ? 'warn' : 'info');
    });
  }, [store]);

  return (
    <>
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'warn' ? 'toast-warn' : ''}`}>
          {t.text}
        </div>
      ))}
    </>
  );
}
