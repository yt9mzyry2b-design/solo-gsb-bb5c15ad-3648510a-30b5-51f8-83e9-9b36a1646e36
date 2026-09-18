import { createContext, useContext } from 'react';
import type { AppStore } from './store';
import type { Highlighter } from './highlighter';

/** 正文批注标记点击 -> 侧栏批注面板聚焦的自定义事件名 */
export const ANN_FOCUS_EVENT = 'clause:annotation-focus';

export const StoreContext = createContext<{ store: AppStore; highlighter: Highlighter } | null>(
  null,
);

export function useApp(): { store: AppStore; highlighter: Highlighter } {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('StoreContext 未初始化');
  return ctx;
}
