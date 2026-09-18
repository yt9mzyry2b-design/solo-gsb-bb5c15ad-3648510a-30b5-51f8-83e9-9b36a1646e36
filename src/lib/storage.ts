import type { PersistedState } from '../../shared/model';

const LS_KEY = 'clause-reference-validator:v1';

/** localStorage 持久化（主）；服务器文件存储为可选镜像 */
export const localStore = {
  load(): PersistedState | null {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PersistedState;
      if (!parsed.doc || !Array.isArray(parsed.doc.root)) return null;
      return parsed;
    } catch {
      return null;
    }
  },
  save(state: PersistedState): void {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch {
      // 存储空间不足等情况下静默失败，界面仍可使用
    }
  },
  clear(): void {
    localStorage.removeItem(LS_KEY);
  },
};

/** 服务器侧文件存储镜像（失败时降级为仅本地浏览器存储） */
export const serverStore = {
  async load(): Promise<PersistedState | null> {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) return null;
      const data = (await res.json()) as { state: PersistedState | null };
      return data.state;
    } catch {
      return null;
    }
  },
  async save(state: PersistedState): Promise<boolean> {
    try {
      const res = await fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
