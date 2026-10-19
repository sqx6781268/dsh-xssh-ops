/**
 * 后台任务视图（M4，日志页签的第三段）
 *
 * 与命令台账的关系：**一条后台任务也是一条命令**（同一个 commandId），但这里看的是
 * 「任务」这个侧面 —— 落点、状态、退出码、产物路径。
 *
 * 三件必须如实呈现的事（都不是装饰）：
 *   1. **落点**（remote-tmp / remote-home / local）与 **降级标记**：它决定"结果留在
 *      哪、断线会不会丢"，用户与智能体都靠它判断，所以放在卡片最显眼的位置，
 *      降级时用警示色 + 把告警文本原样列出来。
 *   2. **状态语义**：`missing`（产物已不在）与 `degraded-aborted`（降级通道启动失败）
 *      必须与 `done` 区分显示 —— 把"找不到"显示成"已完成"是最误导人的一种。
 *   3. **操作可逆**：删除要二次确认（删的是远端目录/本地文件），读取输出按行号。
 */
import * as React from "react";
import { formatLineNumber } from "../line-number.js";
import { t } from "../i18n/core.js";
const { useCallback, useEffect, useRef, useState } = React;

const POLL_MS = 2000;
const ROW_LIMIT = 50;
const READ_TAIL_LINES = 200;

/** 状态 → 文案与颜色。键是稳定标识（host 侧同值），标 i18n-identifier 供显示时翻译。 */
// i18n-identifier-start
const STATE_STYLE = {
  running: { color: "#e8c07a", label: "运行中", glyph: "▶" },
  done: { color: "#7fc08a", label: "已完成", glyph: "✓" },
  missing: { color: "#8b93a1", label: "产物已不在", glyph: "?" },
  "degraded-aborted": { color: "#e88a8a", label: "启动失败", glyph: "✕" },
  expired: { color: "#8b93a1", label: "已过期清理", glyph: "⌫" },
  deleted: { color: "#8b93a1", label: "已删除", glyph: "⌫" }
};
/** 未知状态兜底：与上表同属「稳定标识 + 显示时翻译」，所以一起放进标识范围。 */
const UNKNOWN_STATE = { color: "#8b93a1", label: "未知", glyph: "?" };
// i18n-identifier-end

function shortTime(iso) {
  if (typeof iso !== "string" || iso === "") return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** 落点的人话：用户最关心「结果在哪、会不会丢」。 */
// i18n-identifier-start
const LOCATION_LABEL = {
  "remote-tmp": "远端临时目录",
  "remote-home": "远端家目录",
  local: "本地（降级）"
};
// i18n-identifier-end

export function TaskList({ api, connectionId = undefined, visible = true }) {
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(null);
  /** 展开查看输出的任务 → 其行号正文。 */
  const [output, setOutput] = useState(null);
  const targetRef = useRef(null);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      const result = await api.taskList({ connectionId, limit: ROW_LIMIT });
      if (result?.ok === false) { setError(result.error?.message ?? t("读取后台任务失败")); return; }
      setTasks(result?.value?.tasks ?? result?.tasks ?? []);
      setError(null);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    }
  }, [api, connectionId]);

  useEffect(() => {
    if (!visible) return undefined;
    void load();
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [visible, load]);

  useEffect(() => {
    if (toast === null) return undefined;
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  /** 展开/收起某任务的输出（按行号读，与终端行号视图同一套渲染）。 */
  const toggleOutput = useCallback(async (task) => {
    if (output !== null && output.taskId === task.taskId) { setOutput(null); return; }
    setBusy(task.taskId);
    try {
      const result = await api.taskRead(task.taskId, { stream: "both", tailLines: READ_TAIL_LINES });
      if (result?.ok === false) { setToast(result.error?.message ?? t("读取输出失败")); return; }
      const value = result?.value ?? result;
      setOutput({ taskId: task.taskId, value });
      requestAnimationFrame(() => targetRef.current?.scrollIntoView({ block: "nearest" }));
    } catch (cause) {
      setToast(cause?.message ?? String(cause));
    } finally {
      setBusy(null);
    }
  }, [api, output]);

  const remove = useCallback(async (task) => {
    // 删除是不可逆的（删远端目录 / 本地文件），必须二次确认。
    if (!window.confirm(t(`删除任务 ${task.taskId} 的产物？远端目录或本地文件都会被清掉。`))) return;
    setBusy(task.taskId);
    try {
      const result = await api.taskDelete(task.taskId);
      if (result?.ok === false) { setToast(result.error?.message ?? t("删除失败")); return; }
      setToast(t("已删除任务产物"));
      if (output !== null && output.taskId === task.taskId) setOutput(null);
      await load();
    } catch (cause) {
      setToast(cause?.message ?? String(cause));
    } finally {
      setBusy(null);
    }
  }, [api, output, load]);

  const styles = {
    root: { display: "flex", flex: 1, minHeight: 0, flexDirection: "column", background: "var(--dsh-xssh-ops-bg, #101418)", color: "var(--dsh-xssh-ops-text, #d7dbe2)" },
    bar: { display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderBottom: "1px solid var(--dsh-xssh-ops-border, #1f242c)", fontSize: 11, color: "var(--dsh-xssh-ops-muted, #8b93a1)" },
    list: { flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 6px 8px" },
    card: { padding: "7px 8px", marginBottom: 4, borderRadius: 7, border: "1px solid var(--dsh-xssh-ops-border, #2d3540)", background: "var(--dsh-xssh-ops-surface, #161b21)" },
    cardDegraded: { borderColor: "#7a3b3b", background: "rgba(122,59,59,.10)" },
    head: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--dsh-xssh-ops-muted, #8b93a1)" },
    command: { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 12, lineHeight: "17px", whiteSpace: "pre-wrap", wordBreak: "break-all", marginTop: 3 },
    warnLine: { marginTop: 4, padding: "4px 6px", borderRadius: 5, fontSize: 11, lineHeight: "16px", border: "1px solid #7a3b3b", background: "rgba(122,59,59,.18)", color: "#f0b4b4" },
    actions: { display: "flex", gap: 6, marginTop: 6 },
    btn: { padding: "2px 8px", fontSize: 11, borderRadius: 4, cursor: "pointer", background: "transparent", color: "var(--dsh-xssh-ops-text, #d7dbe2)", border: "1px solid var(--dsh-xssh-ops-border, #3a414b)" },
    btnDanger: { borderColor: "#7a3b3b", color: "#f0b4b4" },
    out: { marginTop: 6, maxHeight: 220, overflowY: "auto", padding: "5px 7px", borderRadius: 5, background: "var(--dsh-xssh-ops-input, #101418)", border: "1px solid var(--dsh-xssh-ops-border, #2d3540)", fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 11, lineHeight: "16px", whiteSpace: "pre-wrap", wordBreak: "break-all" },
    outLine: { display: "flex", gap: 6 },
    outNum: { flex: "none", color: "var(--dsh-xssh-ops-muted, #8b93a1)", userSelect: "none" },
    outErr: { color: "#e8b0b0" },
    banner: { margin: "6px 8px 0", padding: "5px 8px", fontSize: 11, borderRadius: 5, border: "1px solid #7a3b3b", background: "rgba(122,59,59,.18)", color: "#f0b4b4" },
    empty: { margin: "auto", fontSize: 12, color: "var(--dsh-xssh-ops-muted, #8b93a1)", textAlign: "center" },
    toast: { position: "fixed", left: "50%", bottom: 24, transform: "translateX(-50%)", zIndex: 90, padding: "6px 10px", borderRadius: 6, background: "rgba(43,47,54,.96)", color: "#fff", fontSize: 12, border: "1px solid rgba(0,0,0,.25)" }
  };

  return (
    <div style={styles.root}>
      <div style={styles.bar}>
        <span>{tasks.length > 0 ? t(`${tasks.length} 个后台任务`) : t("后台任务")}</span>
        <span style={{ flex: 1 }} />
        <span>{t("落点决定结果在哪；降级任务断线即中断")}</span>
      </div>

      {error !== null && <div style={styles.banner}>{error}</div>}

      <div style={styles.list}>
        {tasks.length === 0 && <div style={styles.empty}>{t("还没有后台任务")}</div>}
        {tasks.map((task) => {
          const state = STATE_STYLE[task.state] ?? UNKNOWN_STATE;
          const expanded = output !== null && output.taskId === task.taskId;
          return (
            <div key={task.taskId} ref={expanded ? targetRef : null} style={task.degraded ? { ...styles.card, ...styles.cardDegraded } : styles.card}>
              <div style={styles.head}>
                <span>{shortTime(task.startedAt)}</span>
                <span>·</span>
                <span style={{ color: state.color }}>{state.glyph} {t(state.label)}</span>
                <span>·</span>
                <span title={t("任务产物的落点")}>{t(LOCATION_LABEL[task.location] ?? task.location)}</span>
                {task.degraded && <span style={{ color: "#e88a8a" }}>· {t("已降级")}</span>}
                <span style={{ flex: 1 }} />
                {task.exitCode !== null && <span>exit {task.exitCode}</span>}
                <span style={{ marginLeft: 6 }}>{formatBytes(task.outBytes)}</span>
              </div>
              <div style={styles.command}>{task.label !== "" ? `${task.label}  ` : ""}{task.command}</div>
              {task.degraded && task.warnings.length > 0 && (
                <div style={styles.warnLine}>{task.warnings.join(" ")}</div>
              )}
              <div style={styles.actions}>
                <button type="button" style={styles.btn} disabled={busy === task.taskId} onClick={() => void toggleOutput(task)}>
                  {expanded ? t("收起输出") : t("查看输出")}
                </button>
                <button type="button" style={styles.btn} onClick={() => void api.taskStatus(task.taskId).then(() => load())}>{t("刷新状态")}</button>
                <button type="button" style={{ ...styles.btn, ...styles.btnDanger }} disabled={busy === task.taskId} onClick={() => void remove(task)}>{t("删除产物")}</button>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: "var(--dsh-xssh-ops-muted, #8b93a1)" }} title={t(task.remoteDir ?? task.localDir ?? "")}>
                  {task.taskId}
                </span>
              </div>
              {expanded && (
                <div style={styles.out}>
                  {output.value?.lines?.length > 0
                    ? output.value.lines.map((entry) => (
                        <div key={`${entry.stream}-${entry.line}`} style={styles.outLine}>
                          <span style={styles.outNum}>{formatLineNumber(entry.line)}</span>
                          <span style={styles.outErr && entry.stream === "err" ? styles.outErr : undefined}>{entry.text}</span>
                        </div>
                      ))
                    : <span style={{ color: "var(--dsh-xssh-ops-muted, #8b93a1)" }}>{t("暂无输出")}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {toast !== null && <div style={styles.toast}>{toast}</div>}
    </div>
  );
}
