import { useRef, useState } from 'react';
import { useApp } from '../lib/context';
import type { ExportBundle } from '../../shared/model';
import { sampleDocument } from '../lib/sample';

const PASTE_PLACEHOLDER = `示例法（节选）

第一条【立法目的】
为了规范条款引用活动，制定本法。本法所称条款引用，适用第三条至第五条的规定。

第二条【适用范围】
本法适用于规范性文件的起草与审查。
具体程序依照前款规定执行：
（一）起草阶段应当标注全部交叉引用；
（二）发现引用错误的，按照第五条第二款第（一）项处理。

第三条【引用格式】
引用本条其他款的，可以简写为“本条第X款”；引用前一款的，可以简写为“前款”。`;

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { store } = useApp();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const doPasteImport = () => {
    if (!text.trim()) {
      setError('请先粘贴条款文本');
      return;
    }
    store.importPastedText(text);
    onClose();
  };

  const onFile = async (file: File) => {
    setError(null);
    try {
      const parsed = JSON.parse(await file.text()) as ExportBundle;
      if (!parsed.document || !Array.isArray(parsed.document.root)) {
        setError('JSON 结构不合法：缺少 document.root');
        return;
      }
      store.importJson(parsed);
      onClose();
    } catch (e) {
      setError(`JSON 解析失败：${(e as Error).message}`);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="导入条款">
        <div className="modal-head">
          <h2>粘贴 / 导入条款</h2>
          <button className="close-x" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <p className="modal-hint">
          粘贴含“第X条”“（一）”等编号的中文条款文本，系统会自动解析为
          <strong> 条 → 款 → 项 </strong>层级。空行用于分款，解析不会改写你的原文编号以外的内容。
        </p>
        <textarea
          className="paste-area"
          placeholder={PASTE_PLACEHOLDER}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions">
          <label className="file-btn">
            选择 JSON 文件
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
            />
          </label>
          <button className="link-btn" onClick={() => {
            store.replaceWithSample(sampleDocument());
            onClose();
          }}>
            载入内置示例
          </button>
          <div className="spacer" />
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={doPasteImport}>解析并替换当前文档</button>
        </div>
      </div>
    </div>
  );
}
