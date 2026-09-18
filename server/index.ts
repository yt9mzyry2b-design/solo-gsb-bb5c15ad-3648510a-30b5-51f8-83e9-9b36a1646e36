import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExportBundle, PersistedState } from '../shared/model';

// ESM 运行（tsx 开发 / esbuild 打包均为 ESM）
const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
// 容器内可写目录优先，其次用户主目录
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.env.HOME ?? process.cwd(), '.clause-reference-validator');
const DATA_FILE = path.join(DATA_DIR, 'state.json');

const app = express();
app.use(express.json({ limit: '10mb' }));

function isPersistedState(v: unknown): v is PersistedState {
  if (!v || typeof v !== 'object') return false;
  const doc = (v as PersistedState).doc;
  return Boolean(doc && Array.isArray(doc.root) && typeof doc.title === 'string');
}

async function readState(): Promise<PersistedState | null> {
  try {
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw) as PersistedState;
    return isPersistedState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeState(state: PersistedState): Promise<void> {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state), 'utf8');
  await fsp.rename(tmp, DATA_FILE);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'clause-reference-validator' });
});

app.get('/api/state', async (_req, res) => {
  const state = await readState();
  res.json({ state });
});

app.put('/api/state', async (req, res) => {
  const body = req.body as PersistedState;
  if (!isPersistedState(body)) {
    res.status(400).json({ error: '数据格式不合法：需要 { doc: { title, root }, confirmed }' });
    return;
  }
  try {
    await writeState(body);
    res.json({ ok: true, savedAt: Date.now() });
  } catch (err) {
    res.status(500).json({ error: `保存失败：${(err as Error).message}` });
  }
});

app.post('/api/validate', (req, res) => {
  const bundle = req.body as ExportBundle;
  if (!bundle || !bundle.document || !Array.isArray(bundle.document.root)) {
    res.status(400).json({ error: '导入文件缺少 document.root' });
    return;
  }
  res.json({ ok: true, title: bundle.document.title, rootCount: bundle.document.root.length });
});

// 生产模式托管前端构建产物（dist-server/index.cjs → 同级 ../dist）
const distDir = path.resolve(here, '../dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      res.sendFile(path.join(distDir, 'index.html'));
    } else {
      next();
    }
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`条款引用校验台已启动： http://localhost:${PORT}`);
  console.log(`本地数据文件：${DATA_FILE}`);
});
