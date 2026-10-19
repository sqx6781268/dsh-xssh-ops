/**
 * 命令编辑框（计划 5.6 / R3）。
 *
 * 定位：**常用通道**。命令先在本地编辑、回车才发送，发送后由宿主写命令台账
 * （谁、何时、发了什么、对应哪段输出）。终端直接敲字仍然是**备用通道** —— 特殊
 * 字符、快捷键、TUI 交互都走它，本组件绝不拦截或改写终端输入（计划 Q2 已定）。
 *
 * 两个形态（原型实测定型）：
 *   - **单行 / 多行** 两态；上沿是拖动把手，拖高改高度（30–300 px）。
 *   - 拖到最矮**自动切单行**；把手双击也能切换。多行里 `Shift+Enter` 换行。
 *
 * 危险命令不在这里判断：宿主用与智能体同一条 `assessShellCommand` 策略，返回
 * `blocked` 并弹出确认卡片 —— UI 只负责把结果如实显示出来，不自己造一套规则。
 */
import * as React from "react";
import { t } from "../i18n/core.js";
import { matchesShortcut, parseShortcut } from "./shortcut-actions.js";
const { useCallback, useEffect, useRef, useState } = React;

const MIN_HEIGHT = 30;
const MAX_HEIGHT = 300;
/** 低于这个高度就认为用户想用单行（原型实测：拖到 30 自动切单行）。 */
const SINGLE_LINE_THRESHOLD = 60;
const DEFAULT_HEIGHT = 92;

/** 候选列表的公共前缀（Tab 补全多候选时先补到这里）。 */
function commonPrefixOf(values) {
  if (values.length === 0) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < value.length && prefix[index] === value[index]) index += 1;
    prefix = prefix.slice(0, index);
  }
  return prefix;
}

export function CommandInput({ api, sessionId, connectionId = null, disabled = false, groups = [], targets = [], insertRequest = null, sendRule = null, broadcastRequest = null, broadcastHintDismissed = false }) {
  const [text, setText] = useState("");
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [singleLine, setSingleLine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  // Tab 补全（用户 2026-10-18）：候选来自远端真实文件/命令，多候选列在编辑框下方。
  const [completions, setCompletions] = useState(null);
  const [completing, setCompleting] = useState(false);
  const reset = useCallback(() => {
    setText("");
    setHistoryIndex(-1);
  }, []);

  // 批量发送（用户 2026-10-17 要求）：编辑好命令后整体发给多个会话。
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastGroup, setBroadcastGroup] = useState("");
  useEffect(() => { setHintDismissed(broadcastHintDismissed === true); }, [broadcastHintDismissed]);
  const [broadcastBusy, setBroadcastBusy] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState(null);
  // 批量发送：分组模式标记 / 说明卡片是否已被「已知晓」关闭（用户 2026-10-19）。
  const [broadcastMode, setBroadcastMode] = useState("all");
  const [hintDismissed, setHintDismissed] = useState(broadcastHintDismissed === true);
  const [ackChecked, setAckChecked] = useState(false);
  const dragRef = useRef(null);
  const inputRef = useRef(null);

  const usable = disabled !== true && typeof sessionId === "string" && sessionId !== "";


  // 批量发送目标：全部已连接会话，或指定分组内的会话。
  const broadcastTargets = broadcastMode === "group"
    ? targets.filter((target) => target.groupId === broadcastGroup)
    : targets;

  // 弹窗说明/原因（用户 2026-10-19）：目标为空时必须说清为什么，不能静默。
  const broadcastHint = (() => {
    if (broadcastTargets.length > 0) return t("将把当前编辑框里的命令发送给以上每个会话（各自记台账）。");
    if (broadcastMode === "group") {
      if (groups.length === 0) return t("还没有分组：请到「设置 → XSSH 工具 → 服务器与凭据」创建分组，把服务器加进去后再试。");
      if (broadcastGroup === "") return t("请选择一个分组。");
      const name = groups.find((group) => group.groupId === broadcastGroup)?.name ?? broadcastGroup;
      return t(`分组「${name}」里没有已连接的服务器：先在终端里连接该分组的服务器，再发送。`);
    }
    return t("当前没有已连接的服务器：先连接服务器再发送。");
  })();
  const acknowledgeBroadcast = () => {
    if (ackChecked && !hintDismissed) {
      setHintDismissed(true);
      void api.keepAliveSave({ broadcastHintDismissed: true }).catch(() => {});
    }
  };

  const runBroadcastRef = useRef(null);
  const runBroadcast = useCallback(async () => {
    const command = text;
    if (command.trim() === "" || broadcastBusy) return;
    acknowledgeBroadcast();
    const list = broadcastTargets;
    if (list.length === 0) {
      setBroadcastResult({ ok: 0, failed: 0, messages: [t("没有符合条件的已连接会话")] });
      return;
    }
    setBroadcastBusy(true);
    setBroadcastResult(null);
    let ok = 0;
    const messages = [];
    for (const target of list) {
      try {
        // 与单发同一通道：sendCommand 负责危险命令拦截与台账记录，每个会话独立记。
        const result = await api.sendCommand({ sessionId: target.sessionId, text: command, pressEnter: true, source: "user-broadcast" });
        const value = result?.value ?? result;
        if (result?.ok === false) {
          messages.push(`${target.label}: ${result.error?.message ?? t("失败")}`);
        } else if (value?.blocked === true) {
          messages.push(`${target.label}: ${t("已拦截（需在面板确认）")}`);
        } else {
          ok += 1;
        }
      } catch (error) {
        messages.push(`${target.label}: ${error.message}`);
      }
    }
    setBroadcastBusy(false);
    setBroadcastResult({ ok, failed: list.length - ok, messages });
    if (ok === list.length && messages.length === 0) {
      setBroadcastOpen(false);
      reset();
    }
  }, [text, broadcastTargets, broadcastBusy, api, reset]);
  runBroadcastRef.current = runBroadcast;

  const send = useCallback(async () => {
    const command = text;
    if (command.trim() === "" || !usable || busy) return;
    setBusy(true);
    setError(null);
    try {
      // 多行命令照原样发送（含换行）：远端 shell 会逐行执行，台账记的是整段。
      const result = await api.sendCommand({ sessionId, text: command, pressEnter: true, source: "user-editbox" });
      if (result?.ok === false) {
        setError(result.error?.message ?? t("发送失败"));
        return;
      }
      const value = result?.value ?? result;
      if (value?.blocked === true) {
        // 危险命令：宿主已弹确认卡片，这里只说清楚「没有发出去」。
        setNotice(t(`⚠️ 已拦截（${value.reason ?? ""}）：命令没有发送，请在面板确认卡片里决定是否执行。`));
        return;
      }
      setNotice(null);
      setHistory((previous) => [...previous, command].slice(-100));
      reset();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  }, [api, sessionId, text, usable, busy, reset]);

  // Tab 补全（用户 2026-10-18，方案 D：先补公共前缀 + 可键盘选择面板）。
  // 命令列表在连接后预取并本地过滤（零延迟）；路径仍按远端真实目录查询。
  const [completionIndex, setCompletionIndex] = useState(0);
  const [commandCache, setCommandCache] = useState(null);

  useEffect(() => {
    if (typeof connectionId !== "string" || connectionId === "") { setCommandCache(null); return undefined; }
    let alive = true;
    api.completeCommand({ connectionId, kind: "command", prefix: "" })
      .then((result) => {
        const value = result?.value ?? result;
        if (alive && Array.isArray(value?.candidates)) setCommandCache(value.candidates);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [api, connectionId]);

  const applyCompletion = useCallback((value, wordStart, cursor) => {
    setText((current) => current.slice(0, wordStart) + value + current.slice(cursor));
    setCompletions(null);
    setCompletionIndex(0);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      const pos = wordStart + value.length;
      el?.setSelectionRange?.(pos, pos);
    });
  }, []);

  const openCompletions = useCallback((list, wordStart, cursor, prefix) => {
    setCompletions({ items: list, all: list, wordStart, cursor, prefix });
    setCompletionIndex(0);
  }, []);

  const completeWord = useCallback(async () => {
    if (typeof connectionId !== "string" || connectionId === "" || completing) return;
    const el = inputRef.current;
    const cursor = el?.selectionStart ?? text.length;
    const before = text.slice(0, cursor);
    const match = /(?:^|[\s;|&])([^\s;|&]*)$/.exec(before);
    const word = match ? match[1] : "";
    const wordStart = cursor - word.length;
    const lineBefore = before.slice(0, wordStart).trim();
    const pathLike = word.includes("/") || word === "." || word === ".."
      || word.startsWith("./") || word.startsWith("../") || word.startsWith("~/");
    const kind = pathLike ? "path" : (lineBefore === "" ? "command" : "path");
    let list;
    if (kind === "command" && Array.isArray(commandCache)) {
      // 预取命中：本地前缀过滤，不等待网络。
      list = commandCache.filter((item) => item.startsWith(word));
    } else {
      setCompleting(true);
      try {
        const result = await api.completeCommand({ connectionId, kind, prefix: word });
        const value = result?.value ?? result;
        if (result?.ok === false || !Array.isArray(value?.candidates)) return;
        list = value.candidates;
      } catch {
        // 补全失败保持静默：Tab 不应把编辑框搞乱。
        return;
      } finally {
        setCompleting(false);
      }
    }
    // 相对目录下 `ls` 输出 "./x"；原词不带 ./ 时去掉前缀，替换才不改变语义。
    if (!word.startsWith("./")) list = list.map((item) => (item.startsWith("./") ? item.slice(2) : item));
    if (list.length === 0) { setCompletions(null); return; }
    if (list.length === 1) { applyCompletion(list[0], wordStart, cursor); return; }
    const common = commonPrefixOf(list);
    if (common.length > word.length) {
      // bash 习惯：先补公共前缀；同时把面板打开，接着就能用方向键选。
      const nextText = text.slice(0, wordStart) + common + text.slice(cursor);
      const pos = wordStart + common.length;
      setText(nextText);
      requestAnimationFrame(() => inputRef.current?.setSelectionRange?.(pos, pos));
      openCompletions(list, wordStart, pos, common);
      return;
    }
    openCompletions(list, wordStart, cursor, word);
  }, [connectionId, completing, text, api, applyCompletion, commandCache, openCompletions]);

  const onKeyDown = useCallback((event) => {
    // 发送规则（用户 2026-10-18）：默认 Enter 发送 / Shift+Enter 换行。
    const sendKeys = parseShortcut(sendRule?.send ?? "Enter");
    const newlineKeys = parseShortcut(sendRule?.newline ?? "Shift+Enter");
    // 补全面板打开时：↑/↓ 移动、Enter 插入、Tab 循环、Esc 关闭（面板优先）。
    if (completions !== null && completions.items.length > 0) {
      const count = completions.items.length;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCompletionIndex((index) => (index + 1) % count);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCompletionIndex((index) => (index - 1 + count) % count);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        setCompletionIndex((index) => (index + 1) % count);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        applyCompletion(completions.items[completionIndex] ?? completions.items[0], completions.wordStart, completions.cursor);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setCompletions(null);
        return;
      }
    }
    if (event.key === "Tab") {
      event.preventDefault();
      void completeWord();
      return;
    }
    if (event.key === "Escape" && completions !== null) {
      event.preventDefault();
      setCompletions(null);
      return;
    }
    if (matchesShortcut(event, sendKeys)) {
      event.preventDefault();
      void send();
      return;
    }
    if (matchesShortcut(event, newlineKeys)) {
      if (singleLine) {
        // 单行输入没有换行可言，按规则仍是"换行键"时不发送。
        event.preventDefault();
        return;
      }
      if (event.key !== "Enter") {
        event.preventDefault();
        setText((current) => `${current}\n`);
      }
      // Enter 系列交给 textarea 自己的默认换行。
      return;
    }
    if (event.key === "ArrowUp" && history.length > 0) {
      // 只在「非空行首」时让历史接管，避免抢掉多行编辑里的普通光标移动。
      event.preventDefault();
      const next = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setText(history[next]);
      return;
    }
    if (event.key === "ArrowDown" && historyIndex >= 0) {
      event.preventDefault();
      const next = historyIndex + 1;
      if (next >= history.length) { setHistoryIndex(-1); setText(""); return; }
      setHistoryIndex(next);
      setText(history[next]);
    }
  }, [send, singleLine, history, historyIndex, sendRule, completeWord, completions, completionIndex, applyCompletion]);

  // 快捷键「全部连接发送 / 分组发送」→ 打开对应的批量发送弹窗（用户 2026-10-18）。
  useEffect(() => {
    if (broadcastRequest === null || broadcastRequest === undefined) return;
    if (broadcastRequest.mode !== "group" && hintDismissed && targets.length > 0 && text.trim() !== "") {
      void runBroadcastRef.current?.();
      return;
    }
    setBroadcastMode(broadcastRequest.mode === "group" ? "group" : "all");
    setBroadcastGroup(broadcastRequest.mode === "group" ? (groups[0]?.groupId ?? "") : "");
    setBroadcastResult(null);
    setBroadcastOpen(true);
    // groups 只用于分组模式的默认值，取触发时的快照即可。
  }, [broadcastRequest]);

  // 拖动把手：向上拖变高。拖到阈值以下自动切单行（原型行为）。
  const onHandleDown = useCallback((event) => {
    event.preventDefault();
    dragRef.current = { startY: event.clientY, startHeight: height };
    const onMove = (moveEvent) => {
      const drag = dragRef.current;
      if (drag === null) return;
      const next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, drag.startHeight - (moveEvent.clientY - drag.startY)));
      if (next <= SINGLE_LINE_THRESHOLD) {
        setSingleLine(true);
        setHeight(MIN_HEIGHT);
      } else {
        setSingleLine(false);
        setHeight(next);
      }
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      inputRef.current?.focus();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [height]);

  const toggleSingleLine = useCallback(() => {
    setSingleLine((previous) => {
      const next = !previous;
      setHeight(next ? MIN_HEIGHT : DEFAULT_HEIGHT);
      return next;
    });
  }, []);

  useEffect(() => {
    // 切会话时清空草稿：把 A 会话的命令发到 B 会话是最不该发生的事。
    reset();
    setNotice(null);
    setError(null);
  }, [sessionId, reset]);

  // 终端右键「复制到编辑框」等入口：把外部给的文本写进草稿（用户 2026-10-18）。
  useEffect(() => {
    if (insertRequest === null || insertRequest === undefined) return;
    const text = String(insertRequest.text ?? "");
    if (text === "") return;
    // mode="replace"：拦截命令要独占编辑框，避免与旧草稿拼在一起（用户 2026-10-19）。
    setText((current) => (insertRequest.mode === "replace" ? text : (current.trim() === "" ? text : `${current}\n${text}`)));
    setHistoryIndex(-1);
    inputRef.current?.focus();
  }, [insertRequest]);

  const styles = {
    root: { flex: "none", borderTop: "1px solid var(--dsh-xssh-ops-border, #1f242c)", background: "var(--dsh-xssh-ops-bg, #101418)" },
    handle: { height: 6, cursor: "ns-resize", background: "transparent" },
    handleBar: { width: 36, height: 3, margin: "0 auto", borderRadius: 2, background: "var(--dsh-xssh-ops-border, #3a414b)" },
    row: { display: "flex", alignItems: "flex-end", gap: 6, padding: "2px 8px 8px" },
    input: { flex: 1, minWidth: 0, resize: "none", boxSizing: "border-box", padding: "6px 8px", fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", lineHeight: "18px", background: "var(--dsh-xssh-ops-input, #101418)", color: "var(--dsh-xssh-ops-text, #d7dbe2)", border: "1px solid var(--dsh-xssh-ops-border, #3a414b)", borderRadius: 6, outline: "none" },
    single: { height: MIN_HEIGHT, lineHeight: "18px", padding: "5px 8px" },
    send: { flex: "none", padding: "5px 10px", fontSize: 12, borderRadius: 5, cursor: usable ? "pointer" : "not-allowed", background: "var(--dsw-alias-button-primary-fill, #2d6cdf)", color: "var(--dsw-alias-label-primary-foreground, #fff)", border: 0, opacity: usable && !busy ? 1 : 0.5 },
    sendCol: { flex: "none", display: "flex", flexDirection: "column", gap: 4, alignItems: "stretch", minWidth: 80 },
    // 三个发送入口用颜色区分（用户 2026-10-18）：全部连接=绿、分组发送=紫、发送=主色。
    batchAll: { padding: "4px 8px", fontSize: 11, borderRadius: 5, cursor: "pointer", background: "rgba(46,160,67,.16)", color: "#7fd1a0", border: "1px solid #2ea043", opacity: usable && !busy ? 1 : 0.5 },
    batchOverlay: { position: "fixed", inset: 0, zIndex: 90, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.45)" },
    batchDialog: { width: "min(440px, calc(100vw - 32px))", maxHeight: "70vh", overflow: "auto", display: "flex", flexDirection: "column", gap: 10, padding: 14, borderRadius: 12, background: "var(--dsh-xssh-ops-surface, #161b21)", border: "1px solid var(--dsh-xssh-ops-border, #3a414b)", boxShadow: "0 12px 32px rgba(0,0,0,.4)", color: "var(--dsh-xssh-ops-text, #d7dbe2)" },
    batchTitle: { fontSize: 13, fontWeight: 650 },
    batchList: { display: "flex", flexDirection: "column", gap: 4, maxHeight: 160, overflow: "auto", fontSize: 12 },
    batchActions: { display: "flex", justifyContent: "flex-end", gap: 8 },
    batchBtn: { padding: "4px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer", background: "transparent", border: "1px solid var(--dsh-xssh-ops-border, #3a414b)", color: "inherit" },
    batchHintCard: { display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--dsh-xssh-ops-border, #3a414b)", background: "rgba(127,127,127,.08)", fontSize: 12, lineHeight: 1.6 },
    batchHintCheck: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", opacity: 0.9 },
    batchGroup: { padding: "4px 8px", fontSize: 11, borderRadius: 5, cursor: "pointer", background: "rgba(130,80,223,.16)", color: "#c3a6ff", border: "1px solid #8250df", opacity: usable && !busy ? 1 : 0.5 },
    hint: { fontSize: 11, color: "var(--dsh-xssh-ops-muted, #8b93a1)", padding: "0 8px 6px" },
    completionBar: { display: "flex", flexWrap: "wrap", gap: 4, padding: "0 8px 6px", alignItems: "center" },
    completionItem: { padding: "1px 7px", fontSize: 11, borderRadius: 4, cursor: "pointer", background: "var(--dsh-xssh-ops-surface, #161b21)", color: "var(--dsh-xssh-ops-text, #d7dbe2)", border: "1px solid var(--dsh-xssh-ops-border, #3a414b)" },
    completionItemActive: { background: "rgba(45,108,223,.28)", border: "1px solid #2d6cdf" },
    completionHint: { fontSize: 11, color: "var(--dsh-xssh-ops-muted, #8b93a1)" },
    notice: { margin: "0 8px 6px", padding: "5px 8px", fontSize: 11, borderRadius: 5, border: "1px solid #7a3b3b", background: "rgba(122,59,59,.18)", color: "#f0b4b4" },
    error: { margin: "0 8px 6px", padding: "5px 8px", fontSize: 11, borderRadius: 5, border: "1px solid #7a3b3b", background: "rgba(122,59,59,.18)", color: "#f0b4b4" }
  };

  const common = {
    value: text,
    onChange: (event) => {
      const next = event.target.value;
      setText(next);
      // 面板打开时继续输入 = 过滤候选（zsh 菜单习惯）；词变短或换词就关面板。
      if (completions === null) return;
      const cursor = event.target.selectionStart ?? next.length;
      const before = next.slice(0, cursor);
      const match = /(?:^|[\s;|&])([^\s;|&]*)$/.exec(before);
      const word = match ? match[1] : "";
      if (!word.startsWith(completions.prefix)) { setCompletions(null); return; }
      const filtered = completions.all.filter((item) => item.startsWith(word));
      if (filtered.length === 0) { setCompletions(null); return; }
      setCompletions({ ...completions, items: filtered, wordStart: cursor - word.length, cursor, prefix: word });
      setCompletionIndex(0);
    },
    onKeyDown,
    disabled: !usable,
    spellCheck: false,
    "data-role": "command-editor",
    placeholder: usable ? t("输入命令，回车发送（Shift+Enter 换行）") : t("请先打开终端"),
    title: t("命令编辑框：回车发送并记入命令台账")
  };

  return (
    <div style={styles.root}>
      <div
        style={styles.handle}
        onMouseDown={onHandleDown}
        onDoubleClick={toggleSingleLine}
        title={t("拖动改高度；拖到最矮或双击切换单行")}
        role="separator"
        aria-label={t("拖动改高度")}
      >
        <div style={styles.handleBar} />
      </div>
      {notice !== null && <div style={styles.notice}>{notice}</div>}
      {error !== null && <div style={styles.error}>{error}</div>}
      <div style={styles.row}>
        {singleLine
          ? <input ref={inputRef} {...common} style={{ ...styles.input, ...styles.single }} />
          : <textarea ref={inputRef} {...common} style={{ ...styles.input, height }} />}
        {/* 批量发送入口挪到发送按钮上方（用户 2026-10-18）：右列纵排、三色区分。 */}
        <div style={styles.sendCol}>
          {usable && targets.length > 0 && (
            <>
              <button type="button" style={styles.batchAll} disabled={busy || text.trim() === ""}
                title={t("向所有已连接的服务器发送当前命令")}
                onClick={() => {
                  // 已勾选「已知晓，以后不提示」：不再弹说明框，直接发送（用户 2026-10-19）。
                  if (hintDismissed && targets.length > 0 && text.trim() !== "") { void runBroadcast(); return; }
                  setBroadcastMode("all"); setBroadcastGroup(""); setBroadcastResult(null); setAckChecked(false); setBroadcastOpen(true);
                }}>
                {t("全部连接")}
              </button>
              <button type="button" style={styles.batchGroup} disabled={busy || text.trim() === ""}
                title={t("向指定分组内已连接的服务器批量发送当前命令")}
                onClick={() => { setBroadcastMode("group"); setBroadcastGroup(groups[0]?.groupId ?? ""); setBroadcastResult(null); setAckChecked(false); setBroadcastOpen(true); }}>
                {t("分组发送")}
              </button>
            </>
          )}
          <button type="button" style={styles.send} onClick={() => void send()} disabled={!usable || busy}>
            {busy ? t("发送中…") : t("发送")}
          </button>
        </div>
      </div>
      {completing && (
        <div style={styles.completionBar}><span style={styles.completionHint}>{t("补全查询中…")}</span></div>
      )}
      {completions !== null && completions.items.length > 0 && (
        <div style={styles.completionBar}>
          {completions.items.slice(0, 30).map((item, index) => (
            <button
              key={item}
              type="button"
              style={index === completionIndex ? { ...styles.completionItem, ...styles.completionItemActive } : styles.completionItem}
              title={item}
              onMouseEnter={() => setCompletionIndex(index)}
              onClick={() => applyCompletion(item, completions.wordStart, completions.cursor)}
            >{item}</button>
          ))}
          <span style={styles.completionHint}>{t("↑/↓ 选择 · Enter 插入 · Esc 关闭")}</span>
        </div>
      )}
      <div style={styles.hint}>
        {singleLine ? t("单行模式（双击把手切回多行）") : t("多行模式")} · {t("↑/↓ 历史命令")} · {t("Tab 补全")}
      </div>
      {broadcastOpen && (
        <div style={styles.batchOverlay} onClick={() => { if (!broadcastBusy) { setBroadcastOpen(false); setAckChecked(false); } }}>
          <div style={styles.batchDialog} onClick={(event) => event.stopPropagation()}>
            <div style={styles.batchTitle}>{t("批量发送")}</div>
            {broadcastMode === "group" && (
              <select value={broadcastGroup} onChange={(event) => setBroadcastGroup(event.target.value)} style={{ fontSize: 12, padding: "4px 6px" }}>
                {groups.length === 0 && <option value="">（还没有分组）</option>}
                {groups.map((group) => <option key={group.groupId} value={group.groupId}>{group.name}</option>)}
              </select>
            )}
            <div style={styles.batchList}>
              {broadcastTargets.length === 0
                ? t("没有符合条件的已连接会话")
                : broadcastTargets.map((target) => <div key={target.sessionId}>{target.label}</div>)}
            </div>
            {/* 方形圆角的提示窗（用户 2026-10-19）：说明可在「已知晓，以后不提示」后关闭；
                目标为空时的原因始终显示，避免再次静默。 */}
            {(broadcastTargets.length === 0 || !hintDismissed) && (
              <div style={styles.batchHintCard}>
                <div>{broadcastHint}</div>
                {broadcastTargets.length > 0 && !hintDismissed && (
                  <label style={styles.batchHintCheck}>
                    <input type="checkbox" checked={ackChecked} onChange={(event) => setAckChecked(event.target.checked)} />
                    {t("已知晓，以后不提示")}
                  </label>
                )}
              </div>
            )}
            {broadcastResult !== null && (
              <div style={{ fontSize: 12 }}>
                {t(`成功 ${broadcastResult.ok} · 失败 ${broadcastResult.failed}`)}
                {broadcastResult.messages.map((message, index) => <div key={index} style={{ opacity: 0.85 }}>{message}</div>)}
              </div>
            )}
            <div style={styles.batchActions}>
              <button type="button" style={{ ...styles.batchBtn, opacity: 1 }} disabled={broadcastBusy} onClick={() => { setBroadcastOpen(false); setAckChecked(false); }}>{t("取消")}</button>
              <button type="button" style={styles.send} disabled={broadcastBusy || broadcastTargets.length === 0} onClick={() => void runBroadcast()}>{broadcastBusy ? t("发送中…") : t("发送")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
