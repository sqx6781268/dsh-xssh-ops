/**
 * 命令台账视图（计划 5.6 / R4，日志页签的子视图）。
 *
 * 呈现是**命令优先**（2026-10-17 决策，原型实测命令占 477/499 px ≈ 96%）：
 *   - 命令正文独占整行；
 *   - 时间缩成 `HH:MM`，来源/状态/行区间挤进一行小字，行区间靠右；
 *   - **命令 ID 默认隐藏，悬停或选中才淡入** —— ID 是给智能体引用用的，人看命令时
 *     它只是噪声，但需要复制时必须拿得到；
 *   - **右键菜单**可复制 命令 / ID / 行区间 / 整行 / 该命令的输出正文。
 *
 * 输出正文不在台账里存，按行区间去行日志取（计划 R5：结果压缩为行号）。
 */
import * as React from "react";
import { formatLineNumber } from "../line-number.js";
import { t } from "../i18n/core.js";
const { useCallback, useEffect, useRef, useState } = React;

const POLL_MS = 1500;
const ROW_LIMIT = 200;

/** 状态 → 显示文案与颜色。颜色只用语义，不用来装饰。 */
// i18n-identifier-start
// label 是稳定标识（同时用于查表），显示时才经 t()，所以这里不要求就地包 t()。
const STATUS_STYLE = {
  running: { color: "#e8c07a", label: "运行中" },
  sent: { color: "#8fb4e8", label: "已发送" },
  done: { color: "#7fc08a", label: "完成" },
  unknown: { color: "#8b93a1", label: "未知" },
  blocked: { color: "#e88a8a", label: "已拦截" },
  "failed-to-send": { color: "#e88a8a", label: "发送失败" },
  interactive: { color: "#c79ae8", label: "交互中" }
};
// i18n-identifier-end

/**
 * 命令耗时文案（用户 2026-10-24）：把台账的 firstOutputMs / durationMs 变成
 * 一眼能读的字符串。语义分开写，避免把「闭口等待」误当成执行时间：
 *   firstOutputMs = 命令发出 → 首字节输出（响应延迟）
 *   durationMs    = 命令发出 → 最后一块输出（纯执行时间，不含空闲闭口）
 * @param {object} record 台账记录
 * @returns {{label: string, title: string}|null} 无输出或没有耗时数据时返回 null（不编造 0）
 */
function timingLabel(record) {
  const first = typeof record.firstOutputMs === "number" ? record.firstOutputMs : null;
  const total = typeof record.durationMs === "number" ? record.durationMs : null;
  if (first === null && total === null) return null;
  const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);
  const parts = [];
  if (first !== null) parts.push(`↵${fmt(first)}`);
  if (total !== null && (first === null || total !== first)) parts.push(`Σ${fmt(total)}`);
  const label = parts.join(" / ");
  const title = [
    first !== null ? t(`发出→首字节 ${fmt(first)}`) : null,
    total !== null ? t(`发出→最后一块 ${fmt(total)}`) : null,
    record.closedAt ? t(`台账闭口 ${new Date(record.closedAt).toLocaleTimeString()}`) : null
  ].filter(Boolean).join("\n");
  return { label, title };
}

/** `HH:MM`（本地时区）——完整日期在 title 里，避免窄边栏被时间吃掉宽度。 */
function shortTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function rangeLabel(record) {
  if (record.endLine === null) return t("运行中");
  if (record.endLine < record.startLine) return t("（无输出）");
  return `${formatLineNumber(record.startLine)}–${formatLineNumber(record.endLine)}`;
}

export function CommandLedger({ api, sessionId, visible = true, onJump }) {
  const [commands, setCommands] = useState([]);
  const [error, setError] = useState(null);
  const [menu, setMenu] = useState(null);
  const [toast, setToast] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const rootRef = useRef(null);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      const result = await api.listCommands({ sessionId, limit: ROW_LIMIT });
      if (result?.ok === false) {
        setError(result.error?.message ?? t("读取命令台账失败"));
        return;
      }
      setCommands(result?.value?.commands ?? result?.commands ?? []);
      setError(null);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    }
  }, [api, sessionId]);

  useEffect(() => {
    if (!visible) return undefined;
    void load();
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [visible, load]);

  // 右键菜单 / 提示条：点别处即关。
  useEffect(() => {
    if (menu === null) return undefined;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  useEffect(() => {
    if (toast === null) return undefined;
    const timer = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(timer);
  }, [toast]);

  const copy = useCallback(async (label, value) => {
    const text = String(value ?? "");
    try {
      await navigator.clipboard.writeText(text);
      setToast(t(`已复制${label}`));
    } catch {
      setToast(t("复制失败（浏览器拒绝了剪贴板权限）"));
    }
  }, []);

  /** 「该命令的输出」按行区间去行日志取正文 —— 台账不存正文。 */
  const copyOutput = useCallback(async (record) => {
    if (record.endLine === null) { setToast(t("这条命令还没结束，暂无输出区间")); return; }
    if (record.endLine < record.startLine) { setToast(t("这条命令没有输出")); return; }
    try {
      const result = await api.readTerminalLines(record.sessionId ?? sessionId, {
        fromLine: record.startLine,
        toLine: record.endLine
      });
      const value = result?.value ?? result;
      if (result?.ok === false) { setToast(result.error?.message ?? t("读取输出失败")); return; }
      if (value?.evicted === true) {
        setToast(t("更早的行已被淘汰，只能复制还剩的部分"));
      }
      // `value.text` 是带行号前缀的显示形态（`0001 │ 内容`）；复制要的是纯输出，
      // 用 lines 的 text 逐行拼接（用户 2026-10-18 反馈复制出来的内容不对）。
      const plain = Array.isArray(value?.lines)
        ? value.lines.map((line) => line.text).join("\n")
        : (value?.text ?? "");
      await copy(t("输出"), plain);
    } catch (cause) {
      setToast(cause?.message ?? String(cause));
    }
  }, [api, sessionId, copy]);

  const styles = {
    root: { display: "flex", flex: 1, minHeight: 0, flexDirection: "column", background: "var(--dsh-xssh-ops-bg, #101418)", color: "var(--dsh-xssh-ops-text, #d7dbe2)" },
    bar: { display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderBottom: "1px solid var(--dsh-xssh-ops-border, #1f242c)", fontSize: 11, color: "var(--dsh-xssh-ops-muted, #8b93a1)" },
    list: { flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 6px 8px" },
    card: { padding: "6px 8px", marginBottom: 4, borderRadius: 7, border: "1px solid var(--dsh-xssh-ops-border, #2d3540)", background: "var(--dsh-xssh-ops-surface, #161b21)" },
    cardSelected: { borderColor: "#2d6cdf" },
    command: { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 12, lineHeight: "17px", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--dsh-xssh-ops-text, #d7dbe2)" },
    meta: { display: "flex", alignItems: "center", gap: 6, marginTop: 3, fontSize: 10, color: "var(--dsh-xssh-ops-muted, #8b93a1)" },
    // 耗时（用户 2026-10-24）：等宽字体便于竖排比对，颜色区别于普通元信息。
    timing: { fontFamily: "ui-monospace, Consolas, monospace", color: "var(--dsh-xssh-ops-timing, #9ecb8f)", cursor: "help" },
    idText: { fontFamily: "ui-monospace, Consolas, monospace", opacity: 0, transition: "opacity .12s ease", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    idVisible: { opacity: 1 },
    spacer: { flex: 1, minWidth: 4 },
    rangeLink: { background: "transparent", border: 0, padding: 0, cursor: "pointer", color: "#8fb4e8", fontSize: 10, textDecoration: "underline dotted" },
    banner: { margin: "6px 8px 0", padding: "5px 8px", fontSize: 11, borderRadius: 5, border: "1px solid #7a3b3b", background: "rgba(122,59,59,.18)", color: "#f0b4b4" },
    empty: { margin: "auto", fontSize: 12, color: "var(--dsh-xssh-ops-muted, #8b93a1)", textAlign: "center" },
    toast: { position: "fixed", left: "50%", bottom: 24, transform: "translateX(-50%)", zIndex: 90, padding: "6px 10px", borderRadius: 6, background: "rgba(43,47,54,.96)", color: "#fff", fontSize: 12, border: "1px solid rgba(0,0,0,.25)" },
    menu: { position: "fixed", zIndex: 95, minWidth: 168, padding: 4, borderRadius: 7, background: "#2b2f36", border: "1px solid rgba(0,0,0,.3)", boxShadow: "0 8px 24px rgba(0,0,0,.3)" },
    menuItem: { display: "block", width: "100%", padding: "5px 8px", background: "transparent", border: 0, color: "#e6e8eb", fontSize: 12, textAlign: "left", borderRadius: 4, cursor: "pointer" }
  };

  const menuItems = menu === null ? [] : [
    { label: t("复制命令"), run: () => copy(t("命令"), menu.record.text) },
    { label: t("复制命令 ID"), run: () => copy(t("命令 ID"), menu.record.commandId) },
    { label: t("复制行区间"), run: () => copy(t("行区间"), rangeLabel(menu.record)) },
    {
      label: t("复制整行"),
      run: () => copy(t("整行"), `${menu.record.text}\n${shortTime(menu.record.issuedAt)} · ${menu.record.source} · ${rangeLabel(menu.record)}`)
    },
    { label: t("复制该命令输出"), run: () => void copyOutput(menu.record) }
  ];

  return (
    <div style={styles.root} ref={rootRef}>
      <div style={styles.bar}>
        <span>{commands.length > 0 ? t(`${commands.length} 条命令`) : t("命令台账")}</span>
        <span style={styles.spacer} />
        <span>{t("右键查看可复制项")}</span>
      </div>

      {error !== null && <div style={styles.banner}>{error}</div>}

      <div style={styles.list}>
        {commands.length === 0 && <div style={styles.empty}>{t("还没有命令记录")}</div>}
        {commands.map((record) => {
          const status = STATUS_STYLE[record.status] ?? STATUS_STYLE.unknown;
          const selected = record.commandId === selectedId;
          // 只算一次：耗时文案每次都要 t() 与本地时间格式化，重复调用会让条件、title、
          // 正文落在不同的秒上（用户 2026-10-24）。
          const timing = timingLabel(record);
          return (
            <div
              key={record.commandId}
              style={selected ? { ...styles.card, ...styles.cardSelected } : styles.card}
              onClick={() => { setSelectedId(record.commandId); onJump?.(record); }}
              onContextMenu={(event) => {
                event.preventDefault();
                setSelectedId(record.commandId);
                setMenu({ x: event.clientX, y: event.clientY, record });
              }}
              title={new Date(record.issuedAt).toLocaleString()}
            >
              <div style={styles.command}>{record.text}</div>
              <div style={styles.meta}>
                <span>{shortTime(record.issuedAt)}</span>
                <span>·</span>
                <span>{record.source}</span>
                <span>·</span>
                <span style={{ color: status.color }}>{t(status.label)}</span>
                {record.exitCode !== null && <span>· exit {record.exitCode}</span>}
                {timing !== null && (
                  <span title={timing.title} style={styles.timing}>· {timing.label}</span>
                )}
                {record.truncated === true && <span>· {t("区间已被淘汰")}</span>}
                <span
                  style={selected ? { ...styles.idText, ...styles.idVisible } : styles.idText}
                  title={record.commandId}
                >
                  {record.commandId}
                </span>
                <span style={styles.spacer} />
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); onJump?.(record); }}
                  title={t("跳到行号视图的这段输出")}
                  style={styles.rangeLink}
                >{rangeLabel(record)}</button>
              </div>
            </div>
          );
        })}
      </div>

      {menu !== null && (
        <div
          style={{ ...styles.menu, left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 190) }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {menuItems.map((item) => (
            <button
              key={item.label}
              type="button"
              style={styles.menuItem}
              onClick={() => { setMenu(null); item.run(); }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {toast !== null && <div style={styles.toast}>{toast}</div>}
    </div>
  );
}
