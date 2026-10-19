/**
 * 只读行号视图（计划 5.3 / M1）。
 *
 * 为什么要有它：终端是「屏幕」，一行提示符可能被重画几十次，而智能体与命令台账
 * 需要的是**行号**——「这条命令的输出是第 812–847 行」。所以这里渲染的是宿主端
 * 行号行日志（`src/line-journal.js`）提交后的行，行号单调、永不复用。
 *
 * 三条使用约束：
 *   1. **只读**：不提供任何写回终端的入口，输入仍旧走终端页签（Q1 已定）。
 *   2. **不谎报历史**：`truncated`/`evicted` 为真时必须显式告警——2000 行 / 512 KiB
 *      双上限会淘汰旧行，让用户以为「前面没内容」比丢内容更糟。
 *   3. **跳转时不自动刷新**：否则用户正在看的区间会被每秒的 tail 刷新拽走。
 */
import * as React from "react";
import { formatLineNumber, LINE_NUMBER_SEPARATOR } from "../line-number.js";
import { t } from "../i18n/core.js";
const { useCallback, useEffect, useMemo, useRef, useState } = React;

/** 可选窗口大小（tailLines）。默认 300：够看，又不至于每秒搬运 2000 行。 */
const WINDOW_CHOICES = [100, 300, 1000, 2000];
const DEFAULT_WINDOW = 300;
const POLL_MS = 1200;

export function LinesView({ api, sessionId, visible = true, jumpRequest = null }) {
  const [windowSize, setWindowSize] = useState(DEFAULT_WINDOW);
  const [entries, setEntries] = useState([]);
  const [meta, setMeta] = useState(null);
  const [jumpInput, setJumpInput] = useState("");
  const [jumpLine, setJumpLine] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef(null);
  const targetRef = useRef(null);
  // 跳转模式下停止 tail 自动刷新，避免把用户正在读的区间拽走。
  const pinnedRef = useRef(false);

  const applyResult = useCallback((value, { keepJump = false } = {}) => {
    setEntries(Array.isArray(value?.lines) ? value.lines : []);
    setMeta(value ?? null);
    setError(null);
    if (!keepJump) setJumpLine(null);
  }, []);

  const loadTail = useCallback(async () => {
    if (!api || !sessionId) return;
    setBusy(true);
    try {
      const result = await api.readTerminalLines(sessionId, { tailLines: windowSize });
      if (result?.ok === false) {
        setError(result.error?.message ?? t("读取行号失败"));
        return;
      }
      pinnedRef.current = false;
      applyResult(result?.value ?? result);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  }, [api, sessionId, windowSize, applyResult]);

  const jumpTo = useCallback(async (target) => {
    if (!api || !sessionId || !Number.isFinite(target) || target < 1) return;
    setBusy(true);
    try {
      const result = await api.readTerminalLines(sessionId, {
        fromLine: target,
        toLine: target + windowSize - 1
      });
      if (result?.ok === false) {
        setError(result.error?.message ?? t("读取行号失败"));
        return;
      }
      const value = result?.value ?? result;
      // 目标行已被淘汰：宿主会返回空区间 + firstLine，必须说清楚而不是显示空白。
      if (Array.isArray(value?.lines) && value.lines.length === 0) {
        pinnedRef.current = true;
        applyResult(value);
        setJumpLine(null);
        setNotice(t(`第 ${target} 行已被淘汰（当前最早可读第 ${value.firstLine} 行）`));
        return;
      }
      pinnedRef.current = true;
      applyResult(value, { keepJump: true });
      setNotice(null);
      setJumpLine(target);
      // 等这一帧渲染完再滚，否则目标行还没进 DOM。
      requestAnimationFrame(() => {
        if (targetRef.current) targetRef.current.scrollIntoView({ block: "center" });
        else if (listRef.current) listRef.current.scrollTop = 0;
      });
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  }, [api, sessionId, windowSize, applyResult]);

  // 可见时的轻量轮询。跳转中不刷新（见文件头第 3 条）。
  useEffect(() => {
    if (!visible) return undefined;
    void loadTail();
    const timer = setInterval(() => {
      if (!pinnedRef.current) void loadTail();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [visible, loadTail]);

  // 外部跳转（命令台账点击「行区间」/ 卡片）：定位到指定行并停止 tail 刷新。
  useEffect(() => {
    if (jumpRequest === null || jumpRequest === undefined) return;
    const target = Number(jumpRequest.line);
    if (Number.isFinite(target) && target >= 1) void jumpTo(target);
  }, [jumpRequest, jumpTo]);

  const rangeLabel = useMemo(() => {
    if (meta === null || entries.length === 0) return t("（无输出）");
    return t(`第 ${meta.fromLine}–${meta.toLine} 行 · 保留区 ${meta.firstLine}–${meta.lastLine} · 共 ${meta.totalLines} 行`);
  }, [meta, entries.length]);

  const styles = {
    root: { display: "flex", flex: 1, minHeight: 0, flexDirection: "column", background: "var(--dsh-xssh-ops-bg, #101418)", color: "var(--dsh-xssh-ops-text, #d7dbe2)" },
    bar: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--dsh-xssh-ops-border, #1f242c)" },
    meta: { flex: "1 1 160px", minWidth: 0, fontSize: 11, color: "var(--dsh-xssh-ops-muted, #8b93a1)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
    input: { width: 76, padding: "3px 6px", fontSize: 12, borderRadius: 4, background: "var(--dsh-xssh-ops-input, #101418)", color: "var(--dsh-xssh-ops-text, #d7dbe2)", border: "1px solid var(--dsh-xssh-ops-border, #3a414b)", outline: "none" },
    select: { padding: "3px 4px", fontSize: 12, borderRadius: 4, background: "var(--dsh-xssh-ops-input, #101418)", color: "var(--dsh-xssh-ops-text, #d7dbe2)", border: "1px solid var(--dsh-xssh-ops-border, #3a414b)" },
    button: { padding: "3px 8px", fontSize: 12, borderRadius: 4, cursor: "pointer", background: "transparent", color: "var(--dsh-xssh-ops-text, #d7dbe2)", border: "1px solid var(--dsh-xssh-ops-border, #3a414b)" },
    banner: { margin: "6px 8px 0", padding: "5px 8px", fontSize: 11, borderRadius: 5, border: "1px solid #7a3b3b", background: "rgba(122,59,59,.18)", color: "#f0b4b4" },
    notice: { margin: "6px 8px 0", padding: "5px 8px", fontSize: 11, borderRadius: 5, border: "1px solid #6b5a2a", background: "rgba(107,90,42,.18)", color: "#e8d08a" },
    list: { flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 0", fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 12, lineHeight: "17px" },
    row: { display: "flex", gap: 0, padding: "0 8px", whiteSpace: "pre-wrap", wordBreak: "break-all" },
    rowHit: { background: "rgba(45,108,223,.22)" },
    num: { flex: "none", color: "var(--dsh-xssh-ops-muted, #8b93a1)", userSelect: "none", textAlign: "right" },
    sep: { flex: "none", color: "var(--dsh-xssh-ops-border, #3a414b)", userSelect: "none", whiteSpace: "pre" },
    text: { minWidth: 0 }
  };

  return (
    <div style={styles.root}>
      <div style={styles.bar}>
        <span style={styles.meta} title={rangeLabel}>{rangeLabel}</span>
        <input
          style={styles.input}
          value={jumpInput}
          onChange={(event) => setJumpInput(event.target.value.replace(/[^0-9]/g, ""))}
          onKeyDown={(event) => { if (event.key === "Enter") void jumpTo(Number(jumpInput)); }}
          placeholder={t("行号")}
          aria-label={t("跳转到行号")}
        />
        <button type="button" style={styles.button} onClick={() => void jumpTo(Number(jumpInput))} disabled={jumpInput === ""}>{t("跳转")}</button>
        <select style={styles.select} value={windowSize} onChange={(event) => setWindowSize(Number(event.target.value))} aria-label={t("窗口行数")}>
          {WINDOW_CHOICES.map((size) => <option key={size} value={size}>{t(`${size} 行`)}</option>)}
        </select>
        <button type="button" style={styles.button} onClick={() => void loadTail()} disabled={busy}>{busy ? t("读取中…") : t("回到末尾")}</button>
      </div>

      {error !== null && <div style={styles.banner}>{error}</div>}
      {notice !== null && <div style={styles.notice}>{notice}</div>}
      {meta?.evicted === true && entries.length > 0 && (
        <div style={styles.banner}>
          {t(`更早的行已被淘汰：当前最早可读第 ${meta.firstLine} 行（保留 ${meta.totalLines} 行 / 上限 2000 行、512 KiB）`)}
        </div>
      )}
      {meta?.truncated === true && meta?.evicted !== true && (
        <div style={styles.notice}>{t("本次返回被上限截断，可用「跳转」按行号继续读取。")}</div>
      )}

      <div style={styles.list} ref={listRef}>
        {entries.length === 0 && <div style={{ ...styles.row, color: "var(--dsh-xssh-ops-muted, #8b93a1)" }}>{t("暂无输出")}</div>}
        {entries.map((entry) => {
          const hit = jumpLine !== null && entry.line === jumpLine;
          return (
            <div key={entry.line} ref={hit ? targetRef : null} style={hit ? { ...styles.row, ...styles.rowHit } : styles.row}>
              <span style={styles.num}>{formatLineNumber(entry.line)}</span>
              <span style={styles.sep}>{LINE_NUMBER_SEPARATOR}</span>
              <span style={styles.text}>{entry.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
