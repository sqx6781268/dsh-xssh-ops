/**
 * 远程文件编辑器（用户 2026-10-19）：优先 Monaco（懒加载），加载失败回退到
 * 纯文本 textarea。语言可受控（language prop），切换时用 setModelLanguage 即时
 * 重新高亮；自动换行与行号通过 updateOptions 生效，不重建编辑器。
 */
import * as React from "react";
import { t } from "../i18n/core.js";
import { languageForPath, loadMonaco } from "./monaco-loader.js";
const { useEffect, useRef, useState } = React;

const FALLBACK_STYLE = {
  flex: 1,
  minHeight: 0,
  width: "100%",
  resize: "none",
  fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
  fontSize: 12,
  lineHeight: 1.5,
  padding: 8,
  borderRadius: 6,
  border: "1px solid var(--dsw-alias-border-l4, #2a303a)",
  background: "var(--dsw-alias-bg-layer-1, #101418)",
  color: "var(--dsw-alias-label-primary, #d7dbe2)",
  outline: "none"
};

export function CodeEditor({ path, value, onChange, onReady, theme = "dark", wordWrap = false, lineNumbers = true, language = null }) {
  const hostRef = useRef(null);
  const editorRef = useRef(null);
  const modelRef = useRef(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const [monaco, setMonaco] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    loadMonaco()
      .then((api) => { if (alive) setMonaco(api); })
      .catch((cause) => { if (alive) setError(cause?.message ?? String(cause)); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!monaco || !hostRef.current) return undefined;
    const model = monaco.editor.createModel(String(value ?? ""), language ?? languageForPath(path));
    const editor = monaco.editor.create(hostRef.current, {
      model,
      theme: theme === "light" ? "vs" : "vs-dark",
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      renderWhitespace: "selection",
      wordWrap: wordWrap ? "on" : "off",
      lineNumbers: lineNumbers ? "on" : "off",
      tabSize: 2
    });
    editorRef.current = editor;
    modelRef.current = model;
    const subscription = editor.onDidChangeModelContent(() => {
      changeRef.current?.(editor.getValue());
    });
    onReady?.(editor, monaco);
    return () => {
      subscription.dispose();
      editorRef.current = null;
      modelRef.current = null;
      editor.dispose();
      model.dispose();
    };
  }, [monaco, path, theme]);

  // 语言切换：改 model 的语言，Monaco 会按新语言重新高亮（用户 2026-10-19）。
  useEffect(() => {
    const model = modelRef.current;
    if (!monaco || !model) return;
    const next = language ?? languageForPath(path);
    try { monaco.editor.setModelLanguage(model, next); } catch { /* 忽略 */ }
  }, [monaco, language, path]);

  // 换行/行号开关：updateOptions 即时生效，不重建编辑器。
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.updateOptions({ wordWrap: wordWrap ? "on" : "off", lineNumbers: lineNumbers ? "on" : "off" });
  }, [monaco, wordWrap, lineNumbers]);

  if (error !== null) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 11, color: "#f0c36d" }}>{t(`Monaco 编辑器加载失败，已回退纯文本：${error}`)}</div>
        <textarea value={value} onChange={(event) => onChange?.(event.target.value)} spellCheck={false} style={FALLBACK_STYLE} />
      </div>
    );
  }

  if (monaco === null) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--dsw-alias-label-secondary, #9aa3af)" }}>
        {t("编辑器加载中…")}
      </div>
    );
  }

  return (
    <div
      ref={hostRef}
      style={{ flex: 1, minHeight: 0, overflow: "hidden", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l4, #2a303a)" }}
    />
  );
}
