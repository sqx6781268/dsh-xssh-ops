/**
 * The SSH workspace: connection toolbar, inner tabs (terminal / files /
 * tunnels / logs) and the dialogs. It is the shared INNER
 * content rendered by one host:
 *
 * - `SshSidebarBody.jsx` — a body of the official right-Sidebar tab
 *   (`sidebar.right.pane.tab`), which owns width, split and fullscreen.
 *
 * The workspace itself owns no outer geometry. Terminals are keep-alive:
 * unmounting a view (tab switch, sidebar collapse, chat switch) never
 * disposes the xterm instance, so remounting restores the full scrollback
 * while the host replays output buffered in the meantime.
 */
import * as React from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { isMacPlatform, runFind, searchResultLabel, searchShortcutLabel, searchShortcutMatches } from "./terminal-search.js";
import { XTERM_CSS } from "./xterm-css.js";
import { useSshUi, sshUiSetActiveConnection, sshUiSetBusy, sshUiSetConnections, sshUiSetError, sshUiAnnounceAgentConnections } from "./store.js";
import { IconRobot16 } from "./IconRobot16.jsx";
import { SshFiles } from "./SshFiles.jsx";
import { SshIde } from "./SshIde.jsx";
import { SshTunnels } from "./SshTunnels.jsx";
import { SshLogs } from "./SshLogs.jsx";
import { LinesView } from "./LinesView.jsx";
import { CommandInput } from "./CommandInput.jsx";
import { CommandLedger } from "./CommandLedger.jsx";
import { TaskList } from "./TaskList.jsx";
import { DegradedBanner } from "./DegradedBanner.jsx";
import { privateKeyProblem } from "./pemkey.js";
import { ResourceEditor } from "./SshResources.jsx";
import { insertIntoComposer } from "./chat-bridge.js";
import { matchesShortcut } from "./shortcut-actions.js";
import { createTerminalPool } from "./terminal-pool.js";
import { expandHome, parsePromptCwd as parsePromptPath } from "./prompt-cwd.js";
import { patchDomRendererWidthCache } from "./dom-width-cache.js";
import { applyTerminalTheme, createTerminalThemeWatcher, getTerminalTheme } from "./terminal-theme.js";
import {
  DEFAULT_VIEW_ID,
  adoptIntoView,
  claimPendingOpens,
  closeInView,
  forgetView,
  openInView,
  paneOpenRequestsRevision,
  reconcileViews,
  resolvePaneActiveConnection,
  selectInView,
  subscribePaneSessions,
  viewSession
} from "./pane-selection.js";
import { t } from "../i18n/core.js";
import { useLanguage } from "./locale.js";

const { useCallback, useEffect, useRef, useState, useSyncExternalStore, Component } = React;

/** Error boundary so a crash in one tab (Files/Tunnels) never closes the panel. */
class TabErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error("[dsh-xssh-ops] tab crashed:", error);
  }
  render() {
    if (this.state.error) {
      return React.createElement("div", {
        style: { margin: "auto", padding: 16, fontSize: 12, color: "#f85149", textAlign: "center" }
      }, t(`此页签出错：${this.state.error?.message ?? String(this.state.error)}`));
    }
    return this.props.children;
  }
}

let stylesInjected = false;

/**
 * Workspace button visuals that need real pseudo-classes (hover/active on the
 * add-server button) and therefore cannot live in inline style objects. Kept
 * class-scoped and plugin-prefixed; only colors/borders live here — geometry
 * stays with the inline styles so the two cannot drift.
 */
const PANEL_CSS = `
.dsh-xssh-ops-add-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1px solid rgba(45, 108, 223, 0.55);
  background: rgba(45, 108, 223, 0.14);
  color: #7fb0f5;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 550;
  line-height: 1;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.dsh-xssh-ops-add-btn:hover {
  background: #2d6cdf;
  border-color: #2d6cdf;
  color: #fff;
}
.dsh-xssh-ops-add-btn:active {
  background: #255cba;
  border-color: #255cba;
  color: #fff;
}
`;

/**
 * Inject the xterm stylesheet and the workspace button styles once. Neither
 * carries outer-geometry rules: outer geometry (placement, width, split)
 * belongs to the Sidebar host.
 */
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = XTERM_CSS + PANEL_CSS;
  document.head.appendChild(style);
  ensureTerminalThemeWatcher();
}

/**
 * Keep-alive pool for this workspace's terminals, keyed by host SSH session
 * id. The official Sidebar draws only the ACTIVE tab's body, so switching to
 * the Files tab (or closing the SSH tab, or switching chats) unmounts every
 * XtermView; the pool keeps each xterm instance — and with it the scrollback —
 * alive across those unmounts. Host-side, output written while no view is
 * attached accumulates in the session buffer and is replayed on re-attach.
 */
const terminalPool = createTerminalPool({
  create: () => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      // 保留 5000 行回滚历史（用户 2026-10-20 确认的既定值）。曾经为了绕开
      // 「改字号卡 3 秒」把它降到 500，但根因最终定位到外部插件（@linxin666/dsh-web-all
      // 的 `:has()` 根视口锁），与本插件无关，故恢复原值。
      scrollback: 5000,
      // The search addon's match HIGHLIGHTS are gated behind this flag; the
      // search itself still works, but without it every find throws
      // "proposed API" and the reader sees no matches at all.
      allowProposedApi: true,
      // Some remote commands produce LF-only text. Treat it as a normal
      // terminal newline so rows do not continue at the previous column.
      convertEol: true,
      theme: getTerminalTheme()
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // One SearchAddon per terminal: it searches the live scrollback (the
    // session's own history), so a view can be attached and detached freely.
    const search = new SearchAddon();
    term.loadAddon(search);
    return { term, fit, search };
  },
  max: 8
});

// 终端字体选项（用户 2026-10-19）：常见等宽字体 + 系统 monospace 兜底。
const TERMINAL_FONT_CHOICES = [
  { label: "Menlo / Monaco", family: 'Menlo, Monaco, "Courier New", monospace' },
  { label: "Consolas", family: 'Consolas, "Courier New", monospace' },
  { label: "Cascadia Mono", family: '"Cascadia Mono", Consolas, monospace' },
  { label: "JetBrains Mono", family: '"JetBrains Mono", Consolas, monospace' },
  { label: "Fira Code", family: '"Fira Code", Consolas, monospace' },
  { label: "monospace", family: "monospace" }
];
const DEFAULT_TERMINAL_FONT = { family: TERMINAL_FONT_CHOICES[0].family, size: 13 };
// 字号/字体本地缓存（用户 2026-10-20）：调整只写这里并作用于终端，不再更新 SshPanel
// 的 state —— 否则每次调整都会重渲染整个面板（含 Monaco / 文件 / 日志页签），实测
// 单次约 3 秒。面板重新挂载时从这里恢复。
const TERMINAL_FONT_STORAGE_KEY = "xssh-ops:terminal:font";
function readStoredTerminalFont() {
  try {
    const raw = globalThis.localStorage?.getItem(TERMINAL_FONT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const family = typeof parsed.family === "string" && parsed.family !== "" ? parsed.family : DEFAULT_TERMINAL_FONT.family;
    const size = Number(parsed.size);
    if (!Number.isFinite(size) || size < 8 || size > 28) return null;
    return { family, size };
  } catch { return null; }
}

let stopTerminalThemeWatcher = null;

function ensureTerminalThemeWatcher() {
  if (stopTerminalThemeWatcher !== null || typeof document === "undefined") return;
  stopTerminalThemeWatcher = createTerminalThemeWatcher({
    apply: (theme) => {
      applyWorkspaceTheme(theme);
      terminalPool.forEachTerm((term) => applyTerminalTheme(term, theme));
    }
  });
}

function applyWorkspaceTheme(theme) {
  const light = theme.background === "#f7f8fa";
  const colors = light
    ? { bg: "#f7f8fa", surface: "#ffffff", input: "#ffffff", border: "#d9dee7", text: "#1d2128", muted: "#667085", tab: "#eef1f5" }
    : { bg: "#101418", surface: "#161b21", input: "#101418", border: "#3a414b", text: "#d7dbe2", muted: "#8b93a1", tab: "#1a1f26" };
  for (const [name, value] of Object.entries(colors)) document.documentElement.style.setProperty(`--dsh-xssh-ops-${name}`, value);
  // 背景图遮罩要跟着主题走（用户 2026-10-18）：浅色主题用白遮罩压淡图片，
  // 深色主题用黑遮罩；只广播一个轻量事件，XtermView 不用自己观察 DOM。
  try { globalThis.dispatchEvent?.(new CustomEvent("xssh-theme-changed", { detail: { light } })); } catch { /* 忽略 */ }
}

/** One xterm view bound to one host session via long-poll reads / stream push. */
function XtermView({ api, sessionId, connectionId, onInsertDraft, onReady, mouse = null, background = null, lightTheme = false, customPrompts = [], font = null, onFontChange, onOpenFileToken = null, fileLinksEnabled = true, onCwdChange = null, wheelZoom = true }) {
  const containerRef = useRef(null);
  const searchInputRef = useRef(null);
  /** The pooled entry (terminal + addons) this mount attached to. */
  const entryRef = useRef(null);
  const onReadyRef = useRef(onReady);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  const [closed, setClosed] = useState(() => terminalPool.get(sessionId)?.closed ?? false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState(null);
  // 右键菜单（用户 2026-10-18）：有选区给 添加到对话/解释/复制/复制到编辑框，
  // 无选区给 粘贴/全选。菜单是终端自己的，不弹浏览器默认菜单。
  const [menu, setMenu] = useState(null);
  // 选区右键菜单里的「自定义提示词」二级列表（用户 2026-10-19）。
  const [menuSubmenu, setMenuSubmenu] = useState(null);
  // 字体控制（用户 2026-10-19）：A 选字体、+/- 调字号，与搜索按钮同一风格。
  const [fontMenuOpen, setFontMenuOpen] = useState(false);
  // 字体菜单里「字号」的显示值（applyFont 不更新面板 state，菜单自己同步）。
  const [menuFontSize, setMenuFontSize] = useState(DEFAULT_TERMINAL_FONT.size);
  // 连点 +/- 时 React state 尚未回传，用 ref 记住刚刚生效的值，保证累计正确。
  const fontValueRef = useRef(font);
  fontValueRef.current = font ?? fontValueRef.current;
  const fontPersistTimer = useRef(null);
  const applyFont = (next) => {
    const value = { family: next.family ?? DEFAULT_TERMINAL_FONT.family, size: next.size ?? DEFAULT_TERMINAL_FONT.size };
    fontValueRef.current = value;
    // 本地缓存：字号变化不经过 React state（见 changeTerminalFont 的说明），
    // 面板重新挂载时靠它恢复。
    try { globalThis.localStorage?.setItem(TERMINAL_FONT_STORAGE_KEY, JSON.stringify(value)); } catch { /* 忽略 */ }
    // 只即时更新**当前可见**终端：其它池化终端在下一次挂载时按 font 值应用（mount 里
    // 已有这段赋值）。此前每次调整都对池里所有终端逐台重排（xterm 字号变化会重新测量
    // 字符并重绘），滚轮/连点 +/- 时的卡顿主要来自这里。
    const __fontT0 = (globalThis.performance?.now?.() ?? Date.now());
    try {
      const term = entryRef.current?.term;
      if (term !== undefined && term !== null) {
        // 只赋真正变化的选项：xterm 的每个 options setter 都会触发一次完整的
        // 尺寸重算/重排，fontFamily 不变时再赋值等于白做一次（桌面实测两次
        // 赋值合计 2.8s）。
        try {
          if (term.options.fontSize !== value.size) term.options.fontSize = value.size;
        } catch { /* 忽略个别终端的异常 */ }
        try {
          if (term.options.fontFamily !== value.family) term.options.fontFamily = value.family;
        } catch { /* 同上 */ }
        // 字号变化后补一次（幂等）：若渲染器在别处被重建过，这里能重新挂上 canvas 测宽。
        try { patchDomRendererWidthCache(term); } catch { /* 忽略 */ }
      }
    } finally {
      const __fontDt = (globalThis.performance?.now?.() ?? Date.now()) - __fontT0;
      if (__fontDt > 50) console.warn(`[xssh-font] set options ${__fontDt.toFixed(0)}ms`);
    }
    // 持久化 + 尺寸适配都防抖：连续滚轮/连点只在停下来后 fit 一次并写一次设置。
    // （每次 fontSize 变化后立刻 fit 会向远端发 PTY resize，shell 收到 SIGWINCH
    // 重绘提示符，连续调整时会明显卡顿。）
    if (fontPersistTimer.current !== null) clearTimeout(fontPersistTimer.current);
    fontPersistTimer.current = setTimeout(() => {
      fontPersistTimer.current = null;
      const __fitT0 = (globalThis.performance?.now?.() ?? Date.now());
      try { entryRef.current?.fit?.fit?.(); } catch { /* 忽略 */ }
      const __fitDt = (globalThis.performance?.now?.() ?? Date.now()) - __fitT0;
      if (__fitDt > 50) console.warn(`[xssh-font] fit ${__fitDt.toFixed(0)}ms`);
      onFontChange?.(fontValueRef.current);
    }, 200);
  };
  const adjustFontSize = (delta) => {
    const current = Number(fontValueRef.current?.size ?? DEFAULT_TERMINAL_FONT.size);
    const next = Math.min(28, Math.max(8, current + delta));
    if (next === current) return;
    applyFont({ family: fontValueRef.current?.family ?? DEFAULT_TERMINAL_FONT.family, size: next });
  };
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (toast === null) return undefined;
    const timer = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(timer);
  }, [toast]);

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
    ensureStyles();
    const container = containerRef.current;
    if (!container) return undefined;
    // 提示符 cwd 解析（用户 2026-10-19/20）：`user@host:/path# ` 或 `~`。
    // 定义在挂载之前，首次重放（池复用）时也能解析一次当前目录。
    // 当前目录的最新值（同步 ref）：文件链接解析绝对路径时用，避免读到
    // React state 的旧值（提示符解析与链接点击可能同帧发生）。
    const currentCwdRef = { current: null };
    const onCwdChangeRef = { current: onCwdChange };
    // 远端 home：`~` 不能硬编码成 /root（非 root 用户、home 不在 /root 的机器会全错）。
    // 连上后取一次并缓存；取不到就宁可不跳，也不拼一个错的路径。
    // 关键（用户 2026-10-21 复现「其他目录点文件不跳」）：home 必须**提前预热**。
    // 之前是惰性的——第一次解析 `~/x` 时 home 还是 null，expandHome 返回 null，
    // 绝对路径直接丢掉；而 provideLinks 只在鼠标悬停时跑一次，于是那次点击必然失败。
    // 现在连上就预取，并在拿到 home 后把当前目录重解析一次（回填 cwd）。
    const homeRef = { current: null };
    let homePending = false;
    const homeWaiters = [];
    const ensureHome = (onReady) => {
      if (typeof onReady === "function") {
        if (homeRef.current !== null) onReady(homeRef.current);
        else homeWaiters.push(onReady);
      }
      if (homeRef.current !== null || homePending) return;
      homePending = true;
      void api.sftpHome(connectionId)
        .then((value) => {
          if (value && typeof value.home === "string" && value.home.startsWith("/")) {
            homeRef.current = value.home;
          }
        })
        .catch(() => { /* 忽略：下次解析会重试 */ })
        .finally(() => {
          homePending = false;
          const pendingWaiters = homeWaiters.splice(0, homeWaiters.length);
          for (const waiter of pendingWaiters) { try { waiter(homeRef.current); } catch { /* 忽略 */ } }
        });
    };
    const parsePromptCwd = (text) => {
      const parsed = parsePromptPath(text);
      if (parsed === null) return null;
      if (parsed.startsWith("/")) return parsed;
      // 相对 home 的路径：home 已就绪就立刻展开；否则等 home 到位再回填一次，
      // 避免「第一次解析刚好在 home 就绪前」把这次结果永久丢掉。
      if (homeRef.current === null) {
        ensureHome((home) => {
          const expanded = expandHome(parsed, home);
          if (expanded !== null) {
            currentCwdRef.current = expanded;
            onCwdChangeRef.current?.(expanded);
          }
        });
        return null;
      }
      return expandHome(parsed, homeRef.current);
    };
    // 连上就预热远端 home（不等到遇到 `~` 才取），否则第一次解析必然失败。
    ensureHome();
    const owner = { sessionId };
    const entry = terminalPool.acquire(sessionId, owner);
    entryRef.current = entry;
    const term = entry.term;
    const fit = entry.fit;
    // 排障钩子（用户 2026-10-20）：localStorage xssh-ops:debug=1 时暴露当前终端实例，
    // 便于在 Console 里分段测量字号重排（set options / resize / refresh）。
    try {
      if (globalThis.localStorage?.getItem("xssh-ops:debug") === "1") globalThis.__xsshTerm = term;
    } catch { /* 忽略 */ }
    // 终端背景图（用户 2026-10-18）：开启时画布背景透明，让容器上的背景层透出来。
    // 应用字体设置（用户 2026-10-19）：池终端每次挂载都按当前设置校正。
    const mountedFont = readStoredTerminalFont() ?? font;
    try {
      term.options.fontFamily = mountedFont?.family ?? DEFAULT_TERMINAL_FONT.family;
      term.options.fontSize = Number(mountedFont?.size ?? DEFAULT_TERMINAL_FONT.size);
    } catch { /* 忽略 */ }
    const bgEnabled = background?.enabled === true
      && typeof background.dataUrl === "string" && background.dataUrl !== "";
    term.__xsshTransparentBg = bgEnabled;
    applyTerminalTheme(term, getTerminalTheme());
    // 把终端的选区/全选能力暴露给面板级快捷键（用户 2026-10-18）。
    onReadyRef.current?.(sessionId, {
      getSelection: () => entry.term.getSelection?.() ?? "",
      selectAll: () => entry.term.selectAll?.(),
      focus: () => entry.term.focus?.()
    });

    // (Re)attach: a pooled terminal keeps its DOM element — move it into this
    // mount's container instead of opening it a second time. xterm's open()
    // early-returns once opened, so the re-parent plus a full refresh is what
    // actually redraws it at the new size.
    if (entry.reused && term.element) {
      if (term.element.parentElement !== container) container.appendChild(term.element);
      try { term.refresh(0, Math.max(0, term.rows - 1)); } catch {}
    } else {
      term.open(container);
    }
    // 让 DOM 渲染器改用 canvas 量字符宽度（用户 2026-10-24）。
    // 原实现用 offsetWidth，每个未命中字符触发一次强制布局；本机单次布局约 95.7ms
    // （页面 266 个样式表 / 13023 条规则），改一次字号要 4–11 秒。补丁后实测 8ms。
    // 幂等，内部有等宽字体校准，失败时静默保持 xterm 原行为。
    try {
      patchDomRendererWidthCache(term, {
        log: globalThis.localStorage?.getItem("xssh-ops:debug") === "1"
          ? (...args) => console.info(...args)
          : null
      });
    } catch { /* 补丁失败不影响终端使用 */ }

    // 池复用/首次挂载时缓冲区里可能已有提示符：立刻解析一次当前目录。
    // 否则刚打开面板时 terminalCwd 是 null，点 ~ 里的文件名会打不开（用户 2026-10-20）。
    try {
      const buffer = term.buffer.active;
      const line = buffer.getLine(buffer.baseY + buffer.cursorY);
      const cwd = parsePromptCwd(line?.translateToString(true) ?? "");
      if (cwd !== null) { currentCwdRef.current = cwd; onCwdChangeRef.current?.(cwd); }
    } catch { /* 忽略 */ }

    let alive = true;
    let writing = false;
    let pendingInput = "";
    const MAX_PENDING_INPUT = 64 * 1024;

    const flushInput = () => {
      if (!alive || writing || pendingInput.length === 0) return;
      const data = pendingInput;
      pendingInput = "";
      writing = true;
      api.write(sessionId, data).catch(() => {}).finally(() => {
        writing = false;
        flushInput();
      });
    };

    const onData = (data) => {
      // A stalled transport gets one bounded buffer, rather than an unbounded
      // promise chain. Input after close is discarded and never replayed.
      if (!alive) return;
      if (pendingInput.length + data.length > MAX_PENDING_INPUT) return;
      pendingInput += data;
      flushInput();
    };
    const inputSubscription = term.onData(onData);

    // Ctrl + 滚轮 / 触控板捏合缩放字号（用户 2026-10-20，设置页可关）。浏览器里
    // 捏合就是带 ctrlKey 的 wheel 事件；累积判步，避免捏合连发的小 delta 逐事件跳档；
    // 捕获阶段拦截，终端视口不滚动、页面不缩放。
    let wheelAccum = 0;
    const onWheel = (event) => {
      if (!wheelZoom || !event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      wheelAccum += event.deltaY;
      const step = wheelAccum >= 50 ? 1 : wheelAccum <= -50 ? -1 : 0;
      if (step === 0) return;
      wheelAccum = 0;
      adjustFontSize(step);
    };
    container.addEventListener("wheel", onWheel, { passive: false, capture: true });

    // Ctrl + 滚轮缩放已移除（用户 2026-10-20：先观察 + / - 按钮是否仍卡）。

    // Search runs over this terminal's live scrollback via the addon; the
    // pane only adds the bar, the count and the keyboard path. Ctrl/Cmd+F is
    // caught before xterm sees it (and before the browser's own find opens).
    const search = entry.search;
    const resultsSubscription = search?.onDidChangeResults?.((value) => {
      if (alive) setSearchResults(value);
    });
    const isMac = isMacPlatform(globalThis.navigator?.platform ?? globalThis.navigator?.userAgent);
    const onKeyDown = (event) => {
      if (!searchShortcutMatches(event, isMac)) return;
      event.preventDefault();
      event.stopPropagation();
      setSearchOpen(true);
      setTimeout(() => searchInputRef.current?.focus(), 0);
    };
    container.addEventListener("keydown", onKeyDown, true);

    // ── 鼠标与选择（用户 2026-10-18，参照 Windows Terminal 的鼠标/选择页）──
    // 这些行为都挂在本次挂载上，卸载即解绑；xterm 实例本身是池化共享的。
    if (mouse?.doubleClickSeparator !== undefined) {
      try { term.options.wordSeparator = mouse.doubleClickSeparator; } catch { /* 不支持的版本忽略 */ }
    }
    // 复制格式化：制表符/行尾空白/末尾换行三个开关。
    const formatCopy = (text) => {
      let out = text;
      if (mouse?.copyTabsAsSpaces === true) out = out.replaceAll("\t", "    ");
      if (mouse?.copyTrimTrailingWhitespace === true) out = out.split("\n").map((line) => line.replace(/\s+$/u, "")).join("\n");
      if (mouse?.copyIncludeTrailingNewline === true && out.includes("\n") && !out.endsWith("\n")) out += "\n";
      return out;
    };
    // 框选自动复制（核心需求）：选区变化 120ms 后写入剪贴板，避免拖动过程中狂写。
    let copyTimer = null;
    const selectionSubscription = term.onSelectionChange(() => {
      if (mouse?.autoCopySelection !== true) return;
      if (copyTimer !== null) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copyTimer = null;
        const text = term.getSelection?.() ?? "";
        if (text === "") return;
        try { navigator.clipboard?.writeText?.(formatCopy(text)).catch(() => {}); } catch { /* 忽略权限错误 */ }
      }, 120);
    });
    // 中键粘贴。
    const pasteClipboardIntoTerminal = () => {
      try {
        navigator.clipboard?.readText?.().then((text) => {
          if (text !== "") api.write(sessionId, text).catch(() => {});
        }).catch(() => {});
      } catch { /* 忽略 */ }
    };
    const onMouseDown = (event) => {
      if (event.button === 1 && mouse?.middleClickPaste === true) {
        event.preventDefault();
        pasteClipboardIntoTerminal();
      }
    };
    container.addEventListener("mousedown", onMouseDown);

    // URL 超链接：按配置的前缀扫描行文本，Ctrl+单击（可关）后浏览器打开。
    let linkDisposable = null;
    if (mouse?.urlLinks === true && typeof term.registerLinkProvider === "function") {
      const prefixes = String(mouse.urlPrefixes ?? "").split(/\s+/).filter(Boolean);
      if (prefixes.length > 0) {
        const pattern = new RegExp(
          `(?:${prefixes.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[^\\s"'<>]+`,
          "g"
        );
        linkDisposable = term.registerLinkProvider({
          provideLinks(y, callback) {
            const line = term.buffer.active.getLine(y - 1);
            if (line === undefined) { callback(undefined); return; }
            const text = line.translateToString(true);
            const links = [];
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(text)) !== null) {
              const start = match.index + 1;
              const url = match[0];
              links.push({
                range: { start: { x: start, y }, end: { x: start + url.length - 1, y } },
                text: url,
                decorations: { underline: true, pointerCursor: true },
                activate: (event) => {
                  if (mouse?.ctrlClickOpenLink === true && !event?.ctrlKey) return;
                  try { globalThis.open?.(url, "_blank", "noopener"); } catch { /* 忽略 */ }
                }
              });
            }
            callback(links.length > 0 ? links : undefined);
          }
        });
      }
    }

    // 文件链接（用户 2026-10-19）：ls 输出里带已知后缀的文件名加下划线，
    // 点击后交给文件页签打开预览/编辑器。与 URL 链接互不影响。
    // currentCwdRef 供链接解析拼绝对路径（提示符解析是异步到达的，用 ref 取最新值）。
    let fileLinkDisposable = null;
    if (fileLinksEnabled && typeof term.registerLinkProvider === "function") {
      const FILE_PATTERN = /([^\s/|<>":]+?\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif|tiff|mp4|mkv|avi|mov|wmv|flv|webm|m4v|mp3|wav|flac|aac|ogg|m4a|opus|pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|zip|rar|7z|tar|tgz|gz|bz2|xz|txt|nfo|md|markdown|sh|bash|zsh|py|js|mjs|ts|tsx|jsx|json|ya?ml|xml|html?|css|scss|less|log|csv|tsv|conf|ini|cfg|toml|env|sql|go|java|c|h|cpp|rs|rb|php|db|sqlite|bin|exe|so|dll|ttf|otf|woff2?))/gi;
      fileLinkDisposable = term.registerLinkProvider({
        provideLinks(y, callback) {
          const line = term.buffer.active.getLine(y - 1);
          if (line === undefined) { callback(undefined); return; }
          const text = line.translateToString(true);
          const links = [];
          FILE_PATTERN.lastIndex = 0;
          let match;
          while ((match = FILE_PATTERN.exec(text)) !== null) {
            const name = match[1];
            const start = match.index + 1;
            // 绝对路径（用户 2026-10-20）：终端里点文件名时，把「当前目录 + 文件名」
            // 拼成绝对路径传给文件页签，避免文件页签目录与终端不同步时报
            // 「某某目录无此文件」。链接本身可能是绝对路径（/root/x.png）或
            // 相对路径（./x.png、sub/x.png），三种都归一化。
            // 解析绝对路径：优先链接自身是绝对路径；否则用当前目录拼。
            // 注意要在 **activate 时**再算一次（用户 2026-10-21）——provideLinks 只在
            // 鼠标悬停时跑，悬停那一刻 cwd 可能还没解析出来（或 home 还没预热完），
            // 若此时把 null 烤进闭包，这次点击就永久拿不到绝对路径。
            const resolveAbsolutePath = () => {
              if (name.startsWith("/")) return name;
              let cwd = currentCwdRef.current;
              if (!cwd) {
                try {
                  const buffer = term.buffer.active;
                  const cursorLine = buffer.getLine(buffer.baseY + buffer.cursorY);
                  const parsed = parsePromptCwd(cursorLine?.translateToString(true) ?? "");
                  if (parsed !== null) { currentCwdRef.current = parsed; cwd = parsed; }
                } catch { /* 忽略：拿不到就退化为按名字搜索 */ }
              }
              if (!cwd) return null;
              const cleaned = name.replace(/^\.\//, "");
              return `${cwd === "/" ? "" : cwd}/${cleaned}`;
            };
            links.push({
              range: { start: { x: start, y }, end: { x: start + name.length - 1, y } },
              text: name,
              decorations: { underline: true, pointerCursor: true },
              // 把该终端**自己**的 cwd 一起交出去（多终端时不能依赖面板级状态）。
              activate: () => onOpenFileToken?.(name, resolveAbsolutePath(), currentCwdRef.current)
            });
          }
          callback(links.length > 0 ? links : undefined);
        }
      });
    }

    // 终端右键：拦截浏览器默认菜单，行为由配置决定（菜单/粘贴/不处理）。
    const onContextMenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (mouse?.rightClick === "none") return;
      if (mouse?.rightClick === "paste") {
        pasteClipboardIntoTerminal();
        return;
      }
      const selection = entry.term.getSelection?.() ?? "";
      setMenuSubmenu(null);
      setMenu({ x: event.clientX, y: event.clientY, selection });
    };
    container.addEventListener("contextmenu", onContextMenu);

    const controller = new AbortController();
    const NO_SESSION_NOTICE = t(`\r\n\x1b[31m[终端会话已失效：DSH 服务已重启或该连接已关闭。请到 设置 → XSSH 工具 重新连接]\x1b[0m\r\n`);
    const EXIT_NOTICE = `\r\n\x1b[90m[session exited]\x1b[0m\r\n`;
    const markClosed = () => {
      // The closed flag belongs to the session, not this mount: a remount
      // (tab switch back, sidebar reopen) must not reset it.
      terminalPool.setClosed(sessionId, true);
      setClosed(true);
    };
    // 提示符 cwd 解析（用户 2026-10-19）：`user@host:/path# ` 或 `~`；
    // 供「文件」页签跟随终端当前目录，以及文件名链接的路径解析。
    const showItem = ({ data, exit, startOffset, offset }) => {
      const fresh = entry.consume(data ?? "", startOffset, offset);
      if (fresh) {
        term.write(fresh);
        const cwd = parsePromptCwd(fresh);
        if (cwd !== null) { currentCwdRef.current = cwd; onCwdChangeRef.current?.(cwd); }
      }
      if (exit !== null) {
        markClosed();
        term.write(EXIT_NOTICE);
        return true;
      }
      return false;
    };

    const backoff = async (steps) => {
      await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 500 * 2 ** steps)));
    };

    // Preferred path: host push over the Gateway WebSocket mux (typert
    // mode:'stream'). The keepalive heartbeat resets the error backoff, so a
    // quiet-but-alive terminal never degrades into retries.
    const streamLoop = async () => {
      let errorBackoff = 0;
      while (alive) {
        const stream = await api.streamTerminal(sessionId, controller.signal, entry.offset);
        if (!stream) return false;
        try {
          for await (const item of stream) {
            if (!alive) return true;
            errorBackoff = 0;
            if (showItem(item)) return true;
          }
          // Generator ended without an exit item: the mux dropped the stream
          // (host reload, network blip). Back off, then resubscribe — output
          // written meanwhile is buffered host-side and delivered on attach.
        } catch (error) {
          if (!alive) return true;
          if (error?.code === "no-session") {
            // The host restarted or the connection was closed server-side.
            // Without this notice the pane freezes on stale output and it
            // looks like agent commands stopped being echoed.
            markClosed();
            term.write(NO_SESSION_NOTICE);
            return true;
          }
        }
        if (!alive) return true;
        await backoff(errorBackoff++);
      }
      return true;
    };

    // Fallback path: the original 300ms long-poll, kept for hosts/carriers
    // without the stream mux.
    const pollLoop = async () => {
      let errorBackoff = 0;
      while (alive) {
        try {
          const { data, exit, startOffset, offset } = await api.read(sessionId, 300, entry.offset);
          if (!alive) return;
          errorBackoff = 0;
          if (showItem({ data, exit, startOffset, offset })) return;
        } catch (error) {
          if (!alive) return;
          if (error?.code === "no-session") {
            markClosed();
            term.write(NO_SESSION_NOTICE);
            return;
          }
          // Back off so a dead transport cannot become a tight retry loop.
          await backoff(errorBackoff++);
        }
      }
    };

    const loop = async () => {
      const handled = await streamLoop();
      if (handled || !alive) return;
      await pollLoop();
    };
    loop();

    // Refit whenever the container gets a new box: sidebar drag-resize,
    // fullscreen switch, tab re-activation, server-tab switch — and the first
    // observe after a remount, which is what restores correct dimensions when
    // the terminal returns while the sidebar changed size while hidden.
    let lastCols = 0;
    let lastRows = 0;
    const fitNow = () => {
      if (!alive) return;
      try {
        fit.fit();
        if (term.cols > 0 && term.rows > 0 && (term.cols !== lastCols || term.rows !== lastRows)) {
          lastCols = term.cols;
          lastRows = term.rows;
          api.resize(sessionId, term.cols, term.rows).catch(() => {});
        }
      } catch {}
    };
    const raf = requestAnimationFrame(fitNow);
    const resizeObserver = new ResizeObserver(fitNow);
    resizeObserver.observe(container);

    return () => {
      alive = false;
      controller.abort();
      cancelAnimationFrame(raf);
      pendingInput = "";
      container.removeEventListener("keydown", onKeyDown, true);
      container.removeEventListener("contextmenu", onContextMenu);
      container.removeEventListener("wheel", onWheel, true);
      container.removeEventListener("mousedown", onMouseDown);
      selectionSubscription?.dispose?.();
      linkDisposable?.dispose?.();
      fileLinkDisposable?.dispose?.();
      if (copyTimer !== null) clearTimeout(copyTimer);
      resultsSubscription?.dispose?.();
      search?.clearDecorations?.();
      entryRef.current = null;
      onReadyRef.current?.(sessionId, null);
      setSearchOpen(false);
      resizeObserver.disconnect();
      inputSubscription.dispose();
      // Detach only — the pooled terminal (and its scrollback) survives this
      // unmount. Connections are host-side and are not touched here either.
      terminalPool.release(sessionId, owner);
    };
  }, [sessionId, connectionId, api, mouse, background]);

  // 字号/字体变化只更新选项，不重建上面的挂载 effect（否则每次调整都会重新
  // acquire、重放缓冲、全屏 refresh —— 这正是 +/- 与滚轮卡顿的主因）。
  useEffect(() => {
    const term = entryRef.current?.term;
    if (term === undefined || term === null) return;
    const value = readStoredTerminalFont() ?? font;
    try {
      term.options.fontFamily = value?.family ?? DEFAULT_TERMINAL_FONT.family;
      term.options.fontSize = Number(value?.size ?? DEFAULT_TERMINAL_FONT.size);
    } catch { /* 忽略 */ }
  }, [font]);

  const runSearch = (backwards) => {
    const search = entryRef.current?.search;
    if (search === undefined || query.trim() === "") return;
    runFind(search, query, { backwards, warn: console.warn });
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchResults(null);
    entryRef.current?.search?.clearDecorations?.();
    containerRef.current?.parentElement?.querySelector("textarea")?.focus?.();
  };

  // 右键菜单动作：复制 / 复制到编辑框 / 添加到对话 / 解释 / 粘贴 / 全选。
  const menuSelection = menu?.selection ?? "";
  const copyToClipboard = async (text, message) => {
    try {
      await navigator.clipboard.writeText(text);
      setToast(message);
    } catch {
      setToast(t("复制失败（浏览器拒绝了剪贴板权限）"));
    }
  };
  const pasteIntoTerminal = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text !== "") await api.write(sessionId, text);
      setToast(t("已粘贴到终端"));
    } catch {
      setToast(t("无法读取剪贴板"));
    }
  };
  const sendSelectionToChat = (mode) => {
    const payload = mode === "explain"
      ? `${t("请解释下面这段终端输出：")}\n\n${menuSelection}`
      : menuSelection;
    if (insertIntoComposer(payload)) setToast(t("已添加到对话输入框"));
    else void copyToClipboard(menuSelection, t("已复制（未能写入对话输入框，可手动粘贴）"));
  };
  // 自定义提示词：提示词 + 选区一起送进对话输入框（与快捷键动作同一条路径）。
  const runCustomPrompt = (template) => {
    const text = String(template ?? "").trim();
    if (text === "") return;
    const body = text.includes("{selection}") ? text.split("{selection}").join(menuSelection) : `${text}

${menuSelection}`;
    if (insertIntoComposer(body)) setToast(t("已添加到对话输入框"));
    else void copyToClipboard(menuSelection, t("已复制（未能写入对话输入框，可手动粘贴）"));
    setMenu(null);
    setMenuSubmenu(null);
  };
  const menuItems = menu === null ? [] : (menuSelection.trim() === ""
    ? [
        { label: t("粘贴"), run: () => void pasteIntoTerminal() },
        { label: t("全选"), run: () => { entryRef.current?.term?.selectAll?.(); } },
        { label: t("自定义提示词"), submenu: "prompts" }
      ]
    : [
        { label: t("添加到对话"), run: () => sendSelectionToChat("add") },
        { label: t("解释"), run: () => sendSelectionToChat("explain") },
        { label: t("复制"), run: () => void copyToClipboard(menuSelection, t("已复制")) },
        { label: t("复制到编辑框"), run: () => { onInsertDraft?.(menuSelection); setToast(t("已复制到编辑框")); } },
        { label: t("自定义提示词"), submenu: "prompts" }
      ]);

  const bgEnabled = background?.enabled === true
    && (background?.images?.length > 0 || (typeof background.dataUrl === "string" && background.dataUrl !== ""));
  // 多图层背景（用户 2026-10-19）：每层独立位置/遮罩/模糊/缩放，数组顺序即层级
  //（后面的层渲染在上）；旧版单图在 host 归一化时已迁移成一层。
  const bgImages = (Array.isArray(background?.images) ? background.images : []).filter((image) => image?.dataUrl);
  if (bgImages.length === 0 && background?.dataUrl) bgImages.push({ ...background, id: "legacy" });
  const placementFor = (image) => {
    const scale = Math.min(Math.max(Number(image.scale ?? 100), 10), 400);
    const x = Math.min(Math.max(Number(image.positionX ?? 50), 0), 100);
    const sizeByWidth = `${scale}% auto`;
    if (image.stretch === true) return { backgroundSize: `${scale}% ${scale}%`, backgroundRepeat: "no-repeat", backgroundPosition: `${x}% 50%` };
    switch (image.position) {
      // 「居中缩放」= contain（整图按比例放进终端，四周留空）；
      // 「居中裁剪」= cover（按原图与终端大小裁掉多余部分）。旧值 center 按缩放处理。
      case "center":
      case "center-zoom": return { backgroundSize: "contain", backgroundRepeat: "no-repeat", backgroundPosition: "50% 50%" };
      case "center-crop": return { backgroundSize: "cover", backgroundRepeat: "no-repeat", backgroundPosition: "50% 50%" };
      case "tile": return { backgroundSize: sizeByWidth, backgroundRepeat: "repeat", backgroundPosition: `${x}% 0%` };
      case "top-left": return { backgroundSize: sizeByWidth, backgroundRepeat: "no-repeat", backgroundPosition: "0% 0%" };
      case "top-center": return { backgroundSize: sizeByWidth, backgroundRepeat: "no-repeat", backgroundPosition: "50% 0%" };
      case "top-right": return { backgroundSize: sizeByWidth, backgroundRepeat: "no-repeat", backgroundPosition: "100% 0%" };
      case "left-center": return { backgroundSize: sizeByWidth, backgroundRepeat: "no-repeat", backgroundPosition: "0% 50%" };
      case "right-center": return { backgroundSize: sizeByWidth, backgroundRepeat: "no-repeat", backgroundPosition: "100% 50%" };
      case "bottom-left": return { backgroundSize: sizeByWidth, backgroundRepeat: "no-repeat", backgroundPosition: "0% 100%" };
      case "bottom-center": return { backgroundSize: sizeByWidth, backgroundRepeat: "no-repeat", backgroundPosition: "50% 100%" };
      case "bottom-right": return { backgroundSize: sizeByWidth, backgroundRepeat: "no-repeat", backgroundPosition: "100% 100%" };
      default: return { backgroundSize: sizeByWidth, backgroundRepeat: "no-repeat", backgroundPosition: `${x}% 50%` };
    }
  };
  return (
    <div style={{ ...panelStyles.xtermHost, position: "relative" }}>
      {bgEnabled && bgImages.map((image, index) => (
        <div key={image.id ?? index} aria-hidden="true" style={{ position: "absolute", inset: 0, zIndex: index }}>
          <div
            style={{
              position: "absolute", inset: 0,
              backgroundImage: `url(${image.dataUrl})`,
              ...placementFor(image),
              filter: Number(image.blur ?? 0) > 0 ? `blur(${Number(image.blur)}px)` : undefined,
              // 提升为独立合成层：模糊结果会被缓存，终端 canvas 重绘（输出、滚动、
              // 字号变化）时合成器不必每帧重算 blur —— 多层背景 + blur 时这是主要的
              // 掉帧来源（用户 2026-10-20 反馈刷新/缩放慢）。缩放只做模糊边缘补偿，
              // 避免 filter 后边缘露白。
              transform: `translateZ(0)${Number(image.blur ?? 0) > 0 ? " scale(1.02)" : ""}`,
              willChange: Number(image.blur ?? 0) > 0 ? "filter" : undefined
            }}
          />
          <div
            style={{ position: "absolute", inset: 0, background: `rgba(${lightTheme ? "255, 255, 255" : "0, 0, 0"}, ${Math.min(Math.max(Number(image.maskOpacity ?? 60), 0), 100) / 100})` }}
          />
        </div>
      ))}
      <div style={{ ...panelStyles.xtermWrap, position: "relative", zIndex: 1, background: bgEnabled ? "transparent" : undefined }} ref={containerRef} data-closed={closed || undefined} />
      <div style={panelStyles.fontControls}>
        <button type="button" style={panelStyles.fontBtn} onClick={() => {
            if (!fontMenuOpen) setMenuFontSize(Number(fontValueRef.current?.size ?? DEFAULT_TERMINAL_FONT.size));
            setFontMenuOpen((value) => !value);
          }} title={t("选择字体")} aria-label={t("选择字体")}>A</button>
        <button type="button" style={panelStyles.fontBtn} onClick={() => adjustFontSize(1)} title={t("增大字号")} aria-label={t("增大字号")}>+</button>
        <button type="button" style={panelStyles.fontBtn} onClick={() => adjustFontSize(-1)} title={t("减小字号")} aria-label={t("减小字号")}>−</button>
      </div>
      {fontMenuOpen && (
        <div style={panelStyles.fontMenu}>
          {TERMINAL_FONT_CHOICES.map((choice) => (
            <button
              key={choice.label}
              type="button"
              style={{ ...panelStyles.fontMenuItem, ...(font?.family === choice.family ? panelStyles.fontMenuItemActive : {}) }}
              onClick={() => { applyFont({ family: choice.family, size: font?.size ?? DEFAULT_TERMINAL_FONT.size }); setFontMenuOpen(false); }}
            >{choice.label}</button>
          ))}
          <div style={panelStyles.fontMenuDivider} />
          <div style={panelStyles.fontMenuRow}>
            <span style={panelStyles.fontMenuLabel}>{t("字号")}</span>
            <button
              type="button"
              style={panelStyles.fontBtn}
              title={t("减小字号")}
              onClick={() => { const next = Math.max(8, menuFontSize - 1); setMenuFontSize(next); applyFont({ family: fontValueRef.current?.family ?? DEFAULT_TERMINAL_FONT.family, size: next }); }}
            >−</button>
            <input
              type="number" min={8} max={28} step={1}
              value={menuFontSize}
              aria-label={t("字号")}
              style={panelStyles.fontSizeInput}
              onChange={(event) => {
                const raw = Number(event.target.value);
                if (!Number.isFinite(raw)) return;
                const next = Math.min(28, Math.max(8, Math.round(raw)));
                setMenuFontSize(next);
                applyFont({ family: fontValueRef.current?.family ?? DEFAULT_TERMINAL_FONT.family, size: next });
              }}
            />
            <button
              type="button"
              style={panelStyles.fontBtn}
              title={t("增大字号")}
              onClick={() => { const next = Math.min(28, menuFontSize + 1); setMenuFontSize(next); applyFont({ family: fontValueRef.current?.family ?? DEFAULT_TERMINAL_FONT.family, size: next }); }}
            >+</button>
          </div>
          <button
            type="button"
            style={panelStyles.fontMenuItem}
            onClick={() => { applyFont(DEFAULT_TERMINAL_FONT); setMenuFontSize(DEFAULT_TERMINAL_FONT.size); setFontMenuOpen(false); }}
          >{t("恢复默认（13px）")}</button>
        </div>
      )}
      {/* The shortcut alone is not discoverable: this button is the visible
          entry point, and its tooltip teaches the keyboard path. */}
      {!searchOpen && (
        <button
          type="button"
          onClick={() => {
            setSearchOpen(true);
            setTimeout(() => searchInputRef.current?.focus(), 0);
          }}
          style={panelStyles.searchOpenBtn}
          title={t(`在终端里查找（${searchShortcutLabel(isMacPlatform(globalThis.navigator?.platform ?? globalThis.navigator?.userAgent))}）`)}
          aria-label={t("在终端里查找")}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10 10L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
      {searchOpen && (
        <div style={panelStyles.searchBar}>
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              const text = event.target.value.trim();
              const search = entryRef.current?.search;
              if (text !== "" && search !== undefined) runFind(search, text, { warn: console.warn });
              else {
                setSearchResults(null);
                entryRef.current?.search?.clearDecorations?.();
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); runSearch(event.shiftKey); }
              else if (event.key === "Escape") { event.preventDefault(); closeSearch(); }
            }}
            placeholder={t("在终端里查找…")}
            aria-label={t("在终端里查找")}
            style={panelStyles.searchInput}
          />
          <span style={panelStyles.searchCount} aria-live="polite">{searchResultLabel(searchResults, query)}</span>
          <button type="button" onClick={() => runSearch(true)} style={panelStyles.searchBtn} title={t("上一个匹配 (Shift+Enter)")}>↑</button>
          <button type="button" onClick={() => runSearch(false)} style={panelStyles.searchBtn} title={t("下一个匹配 (Enter)")}>↓</button>
          <button type="button" onClick={closeSearch} style={panelStyles.searchBtn} title={t("关闭 (Esc)")}>×</button>
        </div>
      )}
      {menu !== null && (
        <div
          style={{ ...panelStyles.termMenu, left: Math.min(menu.x, window.innerWidth - 180), top: Math.min(menu.y, window.innerHeight - 170) }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {menuItems.map((item) => (
            item.submenu === undefined
              ? <button key={item.label} type="button" style={panelStyles.termMenuItem} onClick={() => { setMenu(null); item.run(); }}>{item.label}</button>
              : <button key={item.label} type="button" style={panelStyles.termMenuItem} onClick={() => setMenuSubmenu(menuSubmenu === item.submenu ? null : item.submenu)}>{item.label} ▸</button>
          ))}
          {menuSubmenu === "prompts" && (
            <div style={{ borderTop: "1px solid rgba(255,255,255,.12)", marginTop: 4, paddingTop: 4, maxWidth: 240 }}>
              {(customPrompts ?? []).length === 0 ? (
                <div style={{ ...panelStyles.termMenuItem, opacity: 0.45, cursor: "default" }}>{t("待创建")}</div>
              ) : (customPrompts ?? []).map((prompt) => (
                <button
                  key={prompt.id}
                  type="button"
                  title={prompt.prompt}
                  style={{ ...panelStyles.termMenuItem, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  onClick={() => runCustomPrompt(prompt.prompt)}
                >{prompt.title || t("未命名")}</button>
              ))}
            </div>
          )}
        </div>
      )}
      {toast !== null && <div style={panelStyles.termToast}>{toast}</div>}
    </div>
  );
}

function ConnectDialog({ api, credentials, onClose, onConnected, onEditResource }) {
  const [form, setForm] = useState({
    name: "",
    host: "",
    port: "22",
    username: "root",
    authKind: "password",
    credentialId: "",
    password: "",
    privateKey: "",
    passphrase: ""
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [keyFileName, setKeyFileName] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [sharedCredentials, setSharedCredentials] = useState([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  // Off by default: joining a live connection makes this pane share that
  // connection's single shell, so both panes would mirror each other and the
  // operator could not work in them independently. Opting in is for deliberately
  // watching the agent in the same shell.
  const [reuseExisting, setReuseExisting] = useState(false);
  const keyFileInputRef = useRef(null);
  const [showProxyJump, setShowProxyJump] = useState(false);
  const [proxyJumps, setProxyJumps] = useState([]);
  // Upstream SOCKS5 for a TEMPORARY connection. Saved resources carry their
  // own proxy, so this is only sent on the inline api.connect path.
  const [showProxy, setShowProxy] = useState(false);
  const [proxy, setProxy] = useState({ host: "", port: "1080", username: "", password: "" });
  const setProxyField = (key) => (event) => setProxy((p) => ({ ...p, [key]: event.target.value }));

  useEffect(() => {
    let alive = true;
    Promise.all([api.profileList(), api.credentialList?.() ?? { credentials: [] }]).then(([profileResult, credentialResult]) => {
      if (!alive) return;
      setProfiles(profileResult.profiles);
      setSharedCredentials(credentialResult.credentials ?? []);
    }).catch(() => {});
    return () => { alive = false; };
  }, [api]);

  const set = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }));

  const addProxyJump = () => setProxyJumps((hops) => [...hops, { profileId: "" }]);
  const removeProxyJump = (index) => {
    setProxyJumps((hops) => hops.filter((_, i) => i !== index));
  };
  const updateProxyJump = (index, key, value) => {
    setProxyJumps((hops) => hops.map((hop, i) => i === index ? { ...hop, [key]: value } : hop));
  };

  const submit = async () => {
    // Temporary connections carry the key inline: reject a truncated or
    // empty-shell paste up front instead of surfacing it as a bare auth
    // failure 20 seconds later. Saved profiles keep their keys server-side.
    if (proxyJumps.some((hop) => !hop.profileId)) {
      setError(t("请选择每台跳板服务器"));
      return;
    }
    if (!selectedProfileId && !form.credentialId) {
      for (const secret of [form.privateKey]) {
        const problem = privateKeyProblem(secret, form.passphrase);
        if (problem) {
          setError(problem);
          return;
        }
      }
    }
    setBusy(true);
    setError(null);
    sshUiSetError(null);
    setStatus(t("正在连接服务器，最多需要 20 秒…"));
    try {
      const connection = selectedProfileId
        ? await api.profileConnect({ profileId: selectedProfileId, readyTimeout: 15000, retries: 0, reuseExisting: reuseExisting && proxyJumps.length === 0, ...(proxyJumps.length > 0 ? { proxyJumpProfileIds: proxyJumps.map((hop) => hop.profileId) } : {}) })
        : await api.connect({
            host: form.host.trim(),
            port: Number(form.port) || 22,
            username: form.username.trim(),
            ...(form.credentialId
              ? { credentialId: form.credentialId }
              : { auth: form.authKind === "password"
                ? { kind: "password", password: form.password }
                : { kind: "key", privateKey: form.privateKey, ...(form.passphrase ? { passphrase: form.passphrase } : {}) } }),
            name: form.name.trim() || undefined,
            ...(proxyJumps.length > 0 ? { proxyJumpProfileIds: proxyJumps.map((hop) => hop.profileId) } : {}),
            // Inline SOCKS5 for the temporary connection (an empty proxy host
            // means "dial directly"); a username without a password is fine
            // for a no-auth proxy that still wants an identifier.
            ...(proxy.host.trim() ? {
              proxy: {
                type: "socks5",
                host: proxy.host.trim(),
                port: Number(proxy.port) || 1080,
                ...(proxy.username.trim() ? { username: proxy.username.trim() } : {}),
                ...(proxy.password ? { password: proxy.password } : {})
              }
            } : {})
          });
      // The service returns a live connection, but it is not useful to the
      // panel until it becomes the active record.  Without this, a successful
      // connect looked exactly like "No connections" to the user.
      onConnected?.(connection.connectionId);
      await refreshConnections(api);
      // The panel is a terminal, not merely a connection list: open the PTY
      // immediately so a successful connection is ready to use at once.
      try {
        await api.openSession(connection.connectionId, 100, 30);
        await refreshConnections(api);
      } catch (sessionError) {
        sshUiSetError(t(`已连接，但无法自动打开终端（可稍等几秒后点「打开终端」重试）：${sessionError?.message ?? String(sessionError)}`));
      }
      setStatus(null);
      onClose();
    } catch (err) {
      const message = err?.message ?? String(err);
      setError(message);
      sshUiSetError(message);
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  /** Save the temporary form as a durable SSH resource, then connect via it. */
  const submitSaveAndConnect = async () => {
    if (!credentials) {
      setError(t("当前 DSH 未提供凭据服务，不能安全保存 SSH 认证信息"));
      return;
    }
    if (!form.name.trim() || !form.host.trim() || !form.username.trim()) {
      setError(t("请填写名称、主机和用户名（名称会用于保存的资源）"));
      return;
    }
    if (proxyJumps.some((hop) => !hop.profileId)) {
      setError(t("请选择每台跳板服务器"));
      return;
    }
    if (form.authKind === "key") {
      const problem = privateKeyProblem(form.privateKey, form.passphrase);
      if (problem) {
        setError(problem);
        return;
      }
    }
    setBusy(true);
    setError(null);
    sshUiSetError(null);
    setStatus(t("正在保存并连接…"));
    try {
      // Persist the SOCKS5 proxy coordinates when given; the password is
      // written to its own credential ref below, not into the profile record.
      const proxyCoordinates = proxy.host.trim()
        ? {
            type: "socks5",
            host: proxy.host.trim(),
            port: Number(proxy.port) || 1080,
            ...(proxy.username.trim() ? { username: proxy.username.trim() } : {})
          }
        : undefined;
      const saved = await api.profileSave({
        name: form.name.trim(),
        host: form.host.trim(),
        port: Number(form.port) || 22,
        username: form.username.trim(),
        authKind: form.authKind,
        hostKeyMode: "accept-new",
        groupId: null,
        proxyJump: proxyJumps.map((hop) => ({ profileId: hop.profileId })),
        ...(proxyCoordinates ? { proxy: proxyCoordinates } : {})
      });
      const primaryRef = form.authKind === "password" ? saved.credentialRefs.password : saved.credentialRefs.privateKey;
      const secret = form.authKind === "password" ? form.password : form.privateKey;
      if (secret) {
        const response = await credentials.set(primaryRef, secret);
        if (response && !response.ok) throw new Error(response.error?.message ?? t("无法保存凭据"));
      }
      if (form.authKind === "key" && form.passphrase) {
        const response = await credentials.set(saved.credentialRefs.passphrase, form.passphrase);
        if (response && !response.ok) throw new Error(response.error?.message ?? t("无法保存私钥口令"));
      }
      if (proxy.password && saved.credentialRefs?.proxyPassword) {
        const response = await credentials.set(saved.credentialRefs.proxyPassword, proxy.password);
        if (response && !response.ok) throw new Error(response.error?.message ?? t("无法保存代理凭据"));
      }
      // profileSave returns { profile: { profileId, ... }, credentialRefs }.
      const profileId = saved?.profile?.profileId;
      if (!profileId) throw new Error(t("保存资源后未能取得 profileId"));
      const connection = await api.profileConnect({ profileId, readyTimeout: 15000, retries: 0 });
      onConnected?.(connection.connectionId);
      await refreshConnections(api);
      try {
        await api.openSession(connection.connectionId, 100, 30);
        await refreshConnections(api);
      } catch (sessionError) {
        sshUiSetError(t(`已连接，但无法自动打开终端（可稍等几秒后点「打开终端」重试）：${sessionError?.message ?? String(sessionError)}`));
      }
      setStatus(null);
      onClose();
    } catch (cause) {
      const message = cause?.message ?? String(cause);
      setError(message);
      sshUiSetError(message);
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const importPrivateKey = async (event) => {
    const file = event.target.files?.[0];
    // Reset first so importing the same file again still triggers change.
    event.target.value = "";
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setError(t("私钥文件不能超过 1 MB"));
      return;
    }
    try {
      const privateKey = await file.text();
      if (!privateKey.trim()) throw new Error(t("所选私钥文件为空"));
      setForm((current) => ({ ...current, privateKey }));
      setKeyFileName(file.name);
      setError(null);
    } catch (err) {
      setError(err?.message ?? t("无法读取私钥文件"));
    }
  };

  const selectProfile = (event) => {
    const id = event.target.value;
    setSelectedProfileId(id);
    setError(null);
  };

  return (
    <div style={panelStyles.dialogBackdrop} onClick={busy ? undefined : onClose}>
      <div style={panelStyles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={panelStyles.dialogTitle}>{t("连接服务器")}</div>
        {profiles.length > 0 && (
          <div style={panelStyles.savedProfileRow}>
            <label style={{ ...panelStyles.field, flex: 1 }}>
              <span>{t("已保存的服务器（单选连接）")}</span>
              <select value={selectedProfileId} onChange={selectProfile} style={panelStyles.input}>
                <option value="">{t("选择一台服务器…")}</option>
                {profiles.map((profile) => (
                  <option key={profile.profileId} value={profile.profileId}>
                    {profile.name || profile.host} — {profile.username}@{profile.host}:{profile.port}
                  </option>
                ))}
              </select>
            </label>
            {selectedProfileId && (
              <label style={panelStyles.reuseToggle} title={t("默认各自一条独立通道；勾选后本栏将加入已打开的那条连接，与另一栏共用同一个终端")}>
                <input type="checkbox" checked={reuseExisting} onChange={(event) => setReuseExisting(event.target.checked)} />
                <span>{t("复用已打开的连接")}</span>
              </label>
            )}
            {selectedProfileId && (
              <button type="button" style={panelStyles.input}
                title={t("打开该服务器资源的完整编辑器（含高级选项）")}
                onClick={() => { onEditResource?.(profiles.find((profile) => profile.profileId === selectedProfileId)); }}>
                {t("编辑此资源")}
              </button>
            )}
          </div>
        )}
        {!selectedProfileId && <><div style={panelStyles.temporaryTitle}>{t("临时连接（不会保存）")}</div><div style={panelStyles.formRow}>
          <label style={panelStyles.field}>
            <span>{t("名称（可选）")}</span>
            <input value={form.name} onChange={set("name")} placeholder="my-server" style={panelStyles.input} />
          </label>
          <label style={panelStyles.field}>
            <span>{t("主机")}</span>
            <input value={form.host} onChange={set("host")} placeholder="192.168.1.100" style={panelStyles.input} />
          </label>
        </div><div style={panelStyles.formRow}>
          <label style={panelStyles.field}>
            <span>{t("端口")}</span>
            <input value={form.port} onChange={set("port")} style={panelStyles.input} />
          </label>
          <label style={panelStyles.field}>
            <span>{t("用户名")}</span>
            <input value={form.username} onChange={set("username")} style={panelStyles.input} />
          </label>
        </div><div style={panelStyles.formRow}>
          <label style={panelStyles.field}>
            <span>{t("认证方式")}</span>
            <select value={form.authKind} onChange={(event) => setForm((current) => ({ ...current, authKind: event.target.value, credentialId: "" }))} style={panelStyles.input}>
              <option value="password">{t("密码")}</option>
              <option value="key">{t("私钥")}</option>
            </select>
          </label>
          <label style={panelStyles.field}>
            <span>{t("复用共享凭据（可选）")}</span>
            <select value={form.credentialId} onChange={set("credentialId")} style={panelStyles.input}>
              <option value="">{t(`不复用，临时输入${form.authKind === "password" ? t("密码") : t("私钥")}`)}</option>
              {sharedCredentials.filter((credential) => credential.authKind === form.authKind && credential.credentialConfigured).map((credential) => <option key={credential.credentialId} value={credential.credentialId}>{credential.name}</option>)}
            </select>
          </label>
        </div>
        {!form.credentialId && (form.authKind === "password" ? (
          <label style={panelStyles.field}>
            <span>{t("密码")}</span>
            <input type="password" value={form.password} onChange={set("password")} style={panelStyles.input} />
          </label>
        ) : (
          <>
            <label style={panelStyles.field}>
              <span>{t("私钥文件（PEM / .key，粘贴或导入）")}</span>
              <textarea value={form.privateKey} onChange={set("privateKey")} rows={4} style={{ ...panelStyles.input, fontFamily: "monospace" }} />
            </label>
            <div style={panelStyles.keyImportRow}>
              <input
                ref={keyFileInputRef}
                type="file"
                accept=".pem,.key,.rsa,.ed25519,.txt,application/x-pem-file,application/x-pkcs8,text/plain"
                onChange={importPrivateKey}
                style={panelStyles.hiddenFileInput}
              />
              <button type="button" onClick={() => keyFileInputRef.current?.click()} style={panelStyles.btnSecondary}>{t("导入 PEM / 私钥文件")}</button>
              <span style={panelStyles.keyImportHint}>{keyFileName ? t(`已导入：${keyFileName}`) : t("不会保存到本机")}</span>
            </div>
            <label style={panelStyles.field}>
              <span>{t("私钥口令")}</span>
              <input type="password" value={form.passphrase} onChange={set("passphrase")} style={panelStyles.input} />
            </label>
          </>
        ))}</>}
        {(
          <div style={panelStyles.proxyJumpSection}>
            <button type="button" onClick={() => setShowProxyJump(!showProxyJump)} style={panelStyles.proxyJumpToggle}>{t(`${showProxyJump ? "▼" : "▶"} 跳板机（ProxyJump）${selectedProfileId ? t(" · 留空沿用已保存配置") : ""}`)}</button>
            {showProxyJump && (
              <div style={panelStyles.proxyJumpList}>
                {proxyJumps.map((hop, index) => (
                  <div key={index} style={panelStyles.proxyJumpRow}>
                    <select value={hop.profileId} onChange={(e) => updateProxyJump(index, "profileId", e.target.value)} style={panelStyles.input}>
                      <option value="">{t("选择已保存服务器")}</option>
                      {profiles.map((profile) => <option key={profile.profileId} value={profile.profileId}>{profile.name} · {profile.username}@{profile.host}:{profile.port}</option>)}
                    </select>
                    <button type="button" onClick={() => removeProxyJump(index)} style={panelStyles.btnSmall}>✕</button>
                  </div>
                ))}
                <button type="button" onClick={addProxyJump} style={panelStyles.btnSecondary}>{t("＋ 添加跳板")}</button>
              </div>
            )}
          </div>
        )}
        {!selectedProfileId && (
          <div style={panelStyles.proxyJumpSection}>
            <button type="button" onClick={() => setShowProxy(!showProxy)} style={panelStyles.proxyJumpToggle}>{t(`${showProxy ? "▼" : "▶"} 代理（SOCKS5）`)}</button>
            {showProxy && (
              <div style={panelStyles.proxyJumpList}>
                <input value={proxy.host} onChange={setProxyField("host")} placeholder={t("代理主机，如 192.168.10.4（留空直连）")} style={panelStyles.input} autoComplete="off" />
                <div style={{ display: "flex", gap: 8 }}>
                  <input value={proxy.port} onChange={setProxyField("port")} inputMode="numeric" placeholder={t("端口 1080")} style={{ ...panelStyles.input, flex: "0 0 110px" }} />
                  <input value={proxy.username} onChange={setProxyField("username")} placeholder={t("代理用户名（可选）")} style={{ ...panelStyles.input, flex: 1 }} autoComplete="off" />
                </div>
                <input type="password" value={proxy.password} onChange={setProxyField("password")} placeholder={t("代理密码（无需认证可留空）")} style={panelStyles.input} autoComplete="new-password" />
                <small style={panelStyles.keyImportHint}>{t("标准 SOCKS5 代理只填代理地址，目标仍是上方服务器；仅转发代理机本机端口的代理，才需把服务器主机填 127.0.0.1、端口填代理机转发端口。")}</small>
              </div>
            )}
          </div>
        )}
        {status && <div style={panelStyles.dialogStatus} role="status" aria-live="polite">{status}</div>}
        {error && <div style={panelStyles.dialogError} role="alert">{error}</div>}
        <div style={panelStyles.dialogActions}>
          <button onClick={onClose} disabled={busy} style={panelStyles.btnSecondary}>{t("取消")}</button>
          {!selectedProfileId && (
            <button
              onClick={submitSaveAndConnect}
              disabled={busy || !form.host.trim()}
              style={panelStyles.btnSecondary}
              title={t("保存为 SSH 资源并连接（名称、主机、认证信息存入本机 DSH 凭据库）")}
            >
              {busy ? t("保存中…") : t("保存并连接")}
            </button>
          )}
          <button onClick={submit} disabled={busy || (!selectedProfileId && !form.host.trim())} style={panelStyles.btnPrimary}>
            {busy ? t("连接中…") : selectedProfileId ? t("连接并打开") : t("临时连接")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Mirror the host's connection list and its current binding. The active
 * connection is host state, not a client guess: it is what the agent's
 * connection-less tool calls target, and a page reload must not invent a value
 * for it. The badge reads this field, so it always reports the host's truth.
 */
async function refreshConnections(api) {
  try {
    const { connections, activeConnectionId } = await api.list();
    sshUiSetConnections(connections);
    sshUiSetActiveConnection(activeConnectionId ?? null);
    // The panel's own poll is the fast path for agent-connected servers while
    // the SSH surface is open; the plugin-root poll covers the closed case.
    sshUiAnnounceAgentConnections(connections);
  } catch (error) {
    sshUiSetError(t(`无法刷新 SSH 连接列表：${error?.message ?? String(error)}`));
  }
}

function PendingConfirmations({ confirmations, busyId, onApprove, onCancel, onCopy, alwaysExpand = false }) {
  const [expandedId, setExpandedId] = useState(null);
  const prevIdsRef = useRef(null);

  // Cards collapse to a one-line command so several can be reviewed without
  // scrolling inside the block. The polling loop replaces the array every
  // second with equal content, so only react when the id list actually
  // changes (mount / new item / handled item): expand the newest command.
  useEffect(() => {
    const ids = confirmations.map((item) => item.confirmationId);
    const previous = prevIdsRef.current;
    prevIdsRef.current = ids;
    if (previous !== null && previous.length === ids.length && ids.every((id, i) => id === previous[i])) return;
    setExpandedId(ids.length > 0 ? ids[ids.length - 1] : null);
  }, [confirmations]);

  if (confirmations.length === 0) {
    return <div style={panelStyles.emptyState}>{t("暂无待确认的危险操作。")}</div>;
  }
  return (
    <div style={panelStyles.pendingList}>
      {confirmations.map((item) => {
        const expanded = alwaysExpand || item.confirmationId === expandedId;
        return (
          <section key={item.confirmationId} style={panelStyles.pendingCard}>
            <div style={panelStyles.pendingHead}>
              <span style={panelStyles.pendingBadge} aria-hidden="true">⚠</span>
              <button
                type="button"
                style={{ ...panelStyles.pendingToggle, cursor: alwaysExpand ? "default" : "pointer" }}
                title={expanded ? item.command : t(`${item.command}（点击展开完整信息）`)}
                onClick={() => {
                  if (!alwaysExpand) setExpandedId(expanded ? null : item.confirmationId);
                }}
              >
                {item.command}
              </button>
              <span style={panelStyles.pendingHostTag}>{item.name || item.host}</span>
            </div>
            {expanded && (
              <>
                <div style={panelStyles.pendingMeta}>{t(`来源：Agent · ${new Date(item.createdAt).toLocaleString()}`)}</div>
                <div style={panelStyles.pendingReason}>{t(`风险：${item.reason}`)}</div>
                <pre style={panelStyles.pendingCommand}>{item.command}</pre>
              </>
            )}
            <div style={panelStyles.pendingActions}>
              {expanded && (
                <button type="button" style={panelStyles.btnSecondary} onClick={() => onCopy(item.command)}>{t("复制命令")}</button>
              )}
              <button type="button" style={panelStyles.btnDanger} disabled={busyId === item.confirmationId} onClick={() => onApprove(item.confirmationId)}>
                {busyId === item.confirmationId ? t("处理中…") : t("执行")}
              </button>
              <button type="button" style={panelStyles.btnSecondary} disabled={busyId === item.confirmationId} onClick={() => onCancel(item.confirmationId)}>{t("撤销")}</button>
            </div>
          </section>
        );
      })}
    </div>
  );
}


function BatchDialog({ api, task, onDone }) {
  const [profiles, setProfiles] = useState([]);
  const [selected, setSelected] = useState({});
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.profileList().then((v) => setProfiles(v.profiles || [])).catch(() => {});
  }, [api]);

  const run = async () => {
    const ids = Object.keys(selected).filter((id) => selected[id]);
    if (ids.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.batchRun(task.batchId, ids);
      setResults(r.results);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  // Escape defers the dialog like the confirmation modal does — but never
  // while a run is in flight, which would drop the results mid-execution.
  useEffect(() => {
    if (busy) return;
    const onKey = (event) => {
      if (event.key === "Escape") onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onDone]);

  return (
    <div style={panelStyles.dialogBackdrop} onClick={busy ? undefined : onDone}>
      <div style={{ ...panelStyles.dialog, width: 480 }} onClick={(e) => e.stopPropagation()}>
        <div style={panelStyles.dialogTitle}>{t("批量执行")}</div>
        {task.dangerous && (
          <div style={{ fontSize: 12, color: "#ffb86b", background: "rgba(255,184,107,.12)", border: "1px solid #4a3520", borderRadius: 6, padding: "7px 8px" }}>{t(`⚠️ 危险命令：${task.reason}。确认将对勾选的全部服务器执行。`)}</div>
        )}
        <pre style={panelStyles.pendingCommand}>{task.command}</pre>
        <div style={panelStyles.batchTitle}>{t("目标服务器（每次手动勾选）")}</div>
        <div style={panelStyles.batchList}>
          {profiles.map((p) => (
            <label key={p.profileId} style={panelStyles.batchItem}>
              <input type="checkbox" checked={!!selected[p.profileId]}
                onChange={() => setSelected((s) => ({ ...s, [p.profileId]: !s[p.profileId] }))} />
              <span>{p.name || p.host} — {p.username}@{p.host}:{p.port}</span>
            </label>
          ))}
        </div>
        {error && <div style={panelStyles.dialogError}>{error}</div>}
        {results && (
          <div style={{ maxHeight: 300, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
            {results.map((r, i) => (
              <div key={i} style={{ padding: "6px 8px", background: "#101418", borderRadius: 6, border: `1px solid ${r.ok ? "#3fb950" : "#f85149"}` }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: r.ok ? "#3fb950" : "#f85149" }}>{r.name || r.host}</div>
                <pre style={{ fontSize: 11, color: "#d7dbe2", margin: "4px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{r.error || r.stdout || t("(无输出)")}</pre>
              </div>
            ))}
          </div>
        )}
        <div style={panelStyles.dialogActions}>
          <button type="button" style={panelStyles.btnSecondary} disabled={busy} onClick={() => { api.batchCancel(task.batchId).catch(() => {}); onDone(); }}>{t("取消")}</button>
          <button
            type="button"
            style={panelStyles.btnPrimary}
            // The task is consumed by the first run; results === null guards
            // against a second click that could only ever error out.
            disabled={busy || results !== null || !Object.values(selected).some(Boolean)}
            onClick={run}
          >
            {busy ? t("执行中…") : t(`执行（${Object.values(selected).filter(Boolean).length} 台）`)}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SshPanel({ api, credentials, viewId = DEFAULT_VIEW_ID, viewSignal }) {
  // Repaint on language change; child tabs re-render with this root.
  useLanguage();
  const ui = useSshUi();
  const [dialogOpen, setDialogOpen] = useState(false);
  // 「编辑此资源」：完整编辑器直接在侧栏内挂载，不依赖设置页是否打开
  // （设置页树的认领者只在设置面板挂载时存在，侧栏按钮曾因此静默失效）。
  const [editorProfile, setEditorProfile] = useState(null);
  const [editorData, setEditorData] = useState({ groups: [], sharedCredentials: [], proxyLibrary: [] });
  // 终端右键「复制到编辑框」→ 编辑框草稿；命令台账点击行区间 → 行号视图定位。
  const [draftInsert, setDraftInsert] = useState(null);
  const [lineJump, setLineJump] = useState(null);
  // 可配置快捷键（用户 2026-10-18）：配置存在宿主设置里，挂载与窗口聚焦时刷新。
  const [shortcuts, setShortcuts] = useState([]);
  const [sendRule, setSendRule] = useState({ send: "Enter", newline: "Shift+Enter" });
  const [mouseOptions, setMouseOptions] = useState(null);
  // 当前是否浅色主题（背景图遮罩颜色用；用户 2026-10-18）。
  const [lightTheme, setLightTheme] = useState(() => getTerminalTheme().background === "#f7f8fa");
  const [terminalBackground, setTerminalBackground] = useState(null);
  const [customPrompts, setCustomPrompts] = useState([]);
  // 终端字体与字号（用户 2026-10-19）。
  const [terminalFont, setTerminalFont] = useState(null);
  const [broadcastRequest, setBroadcastRequest] = useState(null);
  // 字体改动立即生效、防抖保存（用户 2026-10-19）：字号连点不必每次都写库。
  const fontSaveTimerRef = useRef(null);
  const changeTerminalFont = useCallback((next) => {
    // 不 setTerminalFont(next)：字号调整只作用于终端 + 本地缓存 + 防抖保存设置。
    // 更新这个 state 会让整个面板（含 Monaco/文件/日志）重渲染，实测约 3 秒。
    if (fontSaveTimerRef.current !== null) clearTimeout(fontSaveTimerRef.current);
    fontSaveTimerRef.current = setTimeout(() => {
      fontSaveTimerRef.current = null;
      const __saveT0 = (globalThis.performance?.now?.() ?? Date.now());
      void api.keepAliveSave({ terminalFont: next }).then(() => {
        const __saveDt = (globalThis.performance?.now?.() ?? Date.now()) - __saveT0;
        if (__saveDt > 100) console.warn(`[xssh-font] keepAliveSave ${__saveDt.toFixed(0)}ms`);
      }).catch(() => {});
    }, 1500);
  }, [api]);
  useEffect(() => {
    const onTheme = (event) => setLightTheme(event?.detail?.light === true);
    window.addEventListener("xssh-theme-changed", onTheme);
    return () => window.removeEventListener("xssh-theme-changed", onTheme);
  }, []);
  const xtermApisRef = useRef(new Map());
  const [tab, setTab] = useState("terminal");
  // 终端页签内的两种视图：xterm 屏幕 / 只读行号视图（计划 5.3）。终端保持挂载
  // （keep-alive），所以来回切换不会丢终端缓冲。
  const [terminalView, setTerminalView] = useState("terminal");
  // 日志页签的子视图：命令台账（命令语义）与会话日志（原始流）。
  const [logView, setLogView] = useState("ledger");
  const [batchTask, setBatchTask] = useState(null);
  const [pendingBatchCount, setPendingBatchCount] = useState(0);
  // Batch ids already surfaced this panel session. Dismissing the dialog (e.g.
  // clicking the backdrop) must not re-pop it on the next poll tick; only a
  // brand-new task auto-opens. Handled tasks are gone from the server, and the
  // leftover count stays visible in the inline notice for manual re-open.
  const seenBatchIdsRef = useRef(new Set());
  const [pendingConfirmations, setPendingConfirmations] = useState([]);
  const [pendingBusy, setPendingBusy] = useState(null);
  const [pendingModalOpen, setPendingModalOpen] = useState(false);
  // Confirmation ids this panel session has already surfaced. Only a brand-new
  // id re-opens the interruptive popup, so deferring one is not undone by the
  // next poll tick.
  const seenPendingIdsRef = useRef(null);
  /** Whether this mount already offered to adopt the live host connections. */
  const adoptedRef = useRef(false);

  // The workspace runs its data loops for exactly as long as it is mounted:
  // the host (the SSH tab being the Sidebar's active tab in an expanded
  // panel) decides visibility, and unmounting never touches the
  // host-side connections. Style injection rides the first effect too, so the
  // empty-state add button is styled before any terminal exists.
  useEffect(() => {
    ensureStyles();
    refreshConnections(api);
    const timer = setInterval(() => refreshConnections(api), 5000);
    return () => clearInterval(timer);
  }, [api]);


  const refreshPendingConfirmations = async () => {
    try {
      const { confirmations } = await api.pendingConfirmationList();
      setPendingConfirmations(confirmations);
      // Dangerous commands must come to the operator, not wait to be found:
      // anything never shown before pops the confirmation modal. On remount
      // (panel reopened) items still unhandled also pop up again.
      const seen = seenPendingIdsRef.current;
      if (seen === null) {
        seenPendingIdsRef.current = new Set(confirmations.map((c) => c.confirmationId));
        if (confirmations.length > 0) setPendingModalOpen(true);
      } else if (confirmations.some((c) => !seen.has(c.confirmationId))) {
        for (const c of confirmations) {
          seen.add(c.confirmationId);
          // 拦截的命令放进命令编辑框，带逐行注释方便人工判断（用户 2026-10-19）。
          if (c.annotated) setDraftInsert({ text: c.annotated, nonce: Date.now(), mode: "replace" });
        }
        setPendingModalOpen(true);
      }
    } catch (error) {
      sshUiSetError(t(`无法刷新待确认队列：${error?.message ?? String(error)}`));
    }
  };

  useEffect(() => {
    refreshPendingConfirmations();
    const timer = setInterval(refreshPendingConfirmations, 1000);
    return () => clearInterval(timer);
  }, [api]);

  const refreshBatchTasks = async () => {
    try {
      const { tasks } = await api.batchTaskList();
      setPendingBatchCount(tasks.length);
      if (tasks.length > 0) {
        const unseen = tasks.find((t) => !seenBatchIdsRef.current.has(t.batchId));
        if (unseen) {
          seenBatchIdsRef.current.add(unseen.batchId);
          setBatchTask((current) => current ?? unseen);
        }
      }
    } catch {}
  };

  const openBatchTask = async () => {
    try {
      const { tasks } = await api.batchTaskList();
      if (tasks.length > 0) {
        seenBatchIdsRef.current.add(tasks[0].batchId);
        setBatchTask(tasks[0]);
      }
    } catch {}
  };

  useEffect(() => {
    refreshBatchTasks();
    const timer = setInterval(refreshBatchTasks, 1000);
    return () => clearInterval(timer);
  }, [api]);


  // Every queued command handled → no reason to keep the popup up.
  useEffect(() => {
    if (pendingModalOpen && pendingConfirmations.length === 0) setPendingModalOpen(false);
  }, [pendingModalOpen, pendingConfirmations]);

  useEffect(() => {
    if (!pendingModalOpen) return;
    const onKey = (event) => {
      if (event.key === "Escape") setPendingModalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingModalOpen]);

  // Split panes are sibling trees over one connection list, and the dock kit
  // remounts this body when the layout root turns into a split. Which servers
  // this pane shows therefore lives in the shared pane store, keyed by the
  // host's tab id, so a split carries the pane's servers across the remount.
  const view = useSyncExternalStore(subscribePaneSessions, () => viewSession(viewId));
  const paneConnections = ui.connections.filter((connection) => view.connectionIds.includes(connection.connectionId));
  // 多会话分屏与临时重命名（用户 2026-10-19）：右键服务器标签设置排列方式；
  // 重命名只存在本次会话里，关闭标签或重开连接后恢复资源名。
  const [splitMode, setSplitMode] = useState("single"); // single | vertical | horizontal | tile
  const [tabNames, setTabNames] = useState({});
  const [tabMenu, setTabMenu] = useState(null);
  const [renameDraft, setRenameDraft] = useState(null);
  // 批量发送需要：分组列表（分组发送目标）与各服务器所属分组（过滤）。
  const [groups, setGroups] = useState([]);
  const [paneProfiles, setPaneProfiles] = useState([]);
  // 「批量发送说明已读」标记（用户 2026-10-19）。
  const [broadcastHintDismissed, setBroadcastHintDismissed] = useState(false);
  // 文件页签的「编辑」→ 编辑器页签（用户 2026-10-19）。
  const [idePendingPath, setIdePendingPath] = useState(null);
  // 终端里点击文件名 → 文件页签打开（用户 2026-10-19）：
  // 带上终端当时的 cwd，文件页签先切到该目录再找文件（用户 2026-10-20 反馈不跳目录）。
  const [pendingFile, setPendingFile] = useState(null);
  // 终端文件名识别开关（设置页可关，用户 2026-10-19），默认开。
  const [terminalFileLinks, setTerminalFileLinks] = useState(true);
  // 文件页签跟随终端路径（用户 2026-10-19）；关掉时终端文件名识别失效。
  const [filesFollowTerminal, setFilesFollowTerminal] = useState(true);
  // Ctrl+滚轮/捏合缩放字号开关（用户 2026-10-20；设置页可关）。
  const [wheelZoomEnabled, setWheelZoomEnabled] = useState(true);
  // 每个终端会话各自的当前目录（用户 2026-10-21）。
  // 之前是全局面板状态，多终端时互相覆盖：在第二个终端点文件会拿到第一个终端的旧目录，
  // 于是报「没找到 xxx（已尝试：<另一个终端的目录>）」。
  const [cwdBySession, setCwdBySession] = useState({});
  const rememberCwd = (sessionId, cwd) => {
    if (typeof sessionId !== "string" || typeof cwd !== "string") return;
    setCwdBySession((current) => (current[sessionId] === cwd ? current : { ...current, [sessionId]: cwd }));
  };
  useEffect(() => {
    const refresh = () => {
      api.groupList?.().then((v) => setGroups(v.groups ?? [])).catch(() => {});
      api.profileList?.().then((v) => setPaneProfiles(v.profiles ?? [])).catch(() => {});
    };
    refresh();
    // 设置页保存（新建分组/改分组归属）或窗口重新聚焦时刷新：
    // 只在挂载时拉一次会让「刚建的分组」在面板里看不到，分组发送按钮就像失灵一样。
    const onSettings = () => refresh();
    window.addEventListener("xssh-settings-changed", onSettings);
    window.addEventListener("focus", onSettings);
    return () => {
      window.removeEventListener("xssh-settings-changed", onSettings);
      window.removeEventListener("focus", onSettings);
    };
  }, [api]);
  // 「编辑此资源」：先把编辑器需要的分组 / 共享凭据 / 代理库拉齐，再在侧栏内
  // 打开完整编辑器（不依赖设置页是否已经挂在设置面板里）。
  const openResourceEditor = async (profile) => {
    if (!profile) return;
    setDialogOpen(false);
    try {
      const [groupResult, credentialResult, keepAlive] = await Promise.all([
        api.groupList?.(),
        api.credentialList?.(),
        api.keepAliveGet?.()
      ]);
      const keepAliveValue = keepAlive?.value ?? keepAlive;
      setEditorData({
        groups: groupResult?.groups ?? [],
        sharedCredentials: credentialResult?.credentials ?? [],
        proxyLibrary: Array.isArray(keepAliveValue?.proxyLibrary) ? keepAliveValue.proxyLibrary : []
      });
    } catch { /* 编辑器仍可打开；跳板机与共享凭据列表退化为空 */ }
    setEditorProfile(profile);
  };
  const resolvedActiveConnectionId = resolvePaneActiveConnection(paneConnections, view.activeConnectionId);
  const active = paneConnections.find((c) => c.connectionId === resolvedActiveConnectionId);
  // 行号视图只看当前活动连接的第一个会话（与终端面板用的是同一个会话）。
  const activeSessionId = active?.sessions?.[0] ?? null;
  // 当前激活终端的目录（必须在 activeSessionId 之后派生：TDZ 会直接崩掉整个面板）。
  const terminalCwd = activeSessionId === null ? null : (cwdBySession[activeSessionId] ?? null);

  // 快捷键与发送规则（用户 2026-10-18）：挂载时拉一次，窗口重新聚焦再拉一次，
  // 这样设置页改完回到面板就生效。
  useEffect(() => {
    let alive = true;
    const load = () => {
      api.keepAliveGet?.().then((result) => {
        const value = result?.value ?? result;
        if (!alive) return;
        setShortcuts(Array.isArray(value?.shortcuts) ? value.shortcuts : []);
        if (value?.sendRule) setSendRule(value.sendRule);
        if (value?.mouse) setMouseOptions(value.mouse);
        if (value?.terminalBackground) setTerminalBackground(value.terminalBackground);
        if (Array.isArray(value?.customPrompts)) setCustomPrompts(value.customPrompts);
        if (value?.terminalFont) setTerminalFont(value.terminalFont);
        if (typeof value?.broadcastHintDismissed === "boolean") setBroadcastHintDismissed(value.broadcastHintDismissed);
        if (typeof value?.terminalFileLinks === "boolean") setTerminalFileLinks(value.terminalFileLinks);
        if (typeof value?.filesFollowTerminal === "boolean") setFilesFollowTerminal(value.filesFollowTerminal);
        if (typeof value?.wheelZoomEnabled === "boolean") setWheelZoomEnabled(value.wheelZoomEnabled);
      }).catch(() => {});
    };
    load();
    window.addEventListener("focus", load);
    window.addEventListener("xssh-shortcuts-changed", load);
    // 连接设置页保存（背景图/保活等）也要让面板立刻刷新（用户 2026-10-18）。
    window.addEventListener("xssh-settings-changed", load);
    return () => {
      alive = false;
      window.removeEventListener("focus", load);
      window.removeEventListener("xssh-shortcuts-changed", load);
      window.removeEventListener("xssh-settings-changed", load);
    };
  }, [api]);

  // 执行一条可配置快捷键（动作表见 shortcut-actions.js）。
  const runShortcutAction = useCallback(async (action, prompt) => {
    const termApi = xtermApisRef.current.get(activeSessionId) ?? null;
    const selection = termApi?.getSelection?.() ?? "";
    switch (action) {
      case "broadcast-all":
        setBroadcastRequest({ mode: "all", nonce: Date.now() });
        break;
      case "broadcast-group":
        setBroadcastRequest({ mode: "group", nonce: Date.now() });
        break;
      case "copy-selection":
        if (selection !== "") { try { await navigator.clipboard.writeText(selection); } catch { /* 浏览器拒绝则忽略 */ } }
        break;
      case "paste": {
        try {
          const text = await navigator.clipboard.readText();
          if (text !== "" && activeSessionId !== null) await api.write(activeSessionId, text);
        } catch { /* 读不到剪贴板就什么也不做 */ }
        break;
      }
      case "add-to-chat":
        if (selection !== "") insertIntoComposer(selection);
        break;
      case "explain":
        if (selection !== "") insertIntoComposer(`${t("请解释下面这段终端输出：")}\n\n${selection}`);
        break;
      case "copy-to-editor":
        if (selection !== "") setDraftInsert({ text: selection, nonce: Date.now() });
        break;
      case "select-all":
        termApi?.selectAll?.();
        break;
      case "focus-editor": {
        const editor = document.querySelector('[data-role="command-editor"]');
        editor?.focus?.();
        break;
      }
      case "custom-prompt": {
        const template = String(prompt ?? "").trim() !== "" ? String(prompt) : t("请根据框选内容执行：");
        const body = template.includes("{selection}") ? template.split("{selection}").join(selection) : `${template}\n\n${selection}`;
        if (body.trim() !== "") insertIntoComposer(body);
        break;
      }
      default:
        break;
    }
  }, [api, activeSessionId]);

  // 面板级快捷键：捕获阶段处理，编辑框里的普通字母不会被吞（只拦带修饰键的组合）。
  const onPanelKeyDown = useCallback((event) => {
    if (shortcuts.length === 0) return;
    const tag = event.target?.tagName;
    const inEditor = tag === "TEXTAREA" || tag === "INPUT" || event.target?.isContentEditable === true;
    for (const item of shortcuts) {
      if (!matchesShortcut(event, item.keys)) continue;
      // 编辑框里只放过带修饰键的组合与功能键（F1–F12）：普通字母/回车不能当快捷键，
      // 否则会把输入吞掉；此前 F 键也被一并拦掉，表现为「配了快捷键按下去没反应」。
      if (inEditor && !event.ctrlKey && !event.altKey && !event.metaKey && !/^F\d{1,2}$/.test(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      void runShortcutAction(item.action, item.prompt);
      return;
    }
  }, [shortcuts, runShortcutAction]);

  useEffect(() => {
    reconcileViews(ui.connections);
  }, [ui.connections]);

  // Host-side sessions outlive a page reload; without adopting them into the
  // first pane to mount they would be invisible zombies no pane can disconnect.
  // One attempt per mount only: re-adopting on every poll would hand back a
  // server the operator just closed, which is the one thing a close must not do.
  useEffect(() => {
    if (adoptedRef.current || ui.connections.length === 0) return;
    adoptedRef.current = true;
    adoptIntoView(viewId, ui.connections);
  }, [ui.connections, viewId]);

  // A surface that owns no pane (the resources page) queues what it connected.
  // The first pane to render claims it, so an operator-initiated connect lands
  // in exactly one pane — not none, and not mirrored into every pane. This
  // subscribes to the queue's revision rather than the view snapshot, which is
  // identity-stable and would not re-render for a queue-only change.
  const paneOpenRequests = useSyncExternalStore(subscribePaneSessions, paneOpenRequestsRevision);
  useEffect(() => {
    for (const connectionId of claimPendingOpens()) openInView(viewId, connectionId);
  }, [paneOpenRequests, viewId]);

  // The host aborts this signal when the tab record disappears (or the plugin
  // unloads). Release the view's references so another pane's later close is
  // still recognized as the last one — closing a view never disconnects.
  useEffect(() => {
    if (viewSignal === undefined) return;
    const onAbort = () => forgetView(viewId);
    viewSignal.addEventListener("abort", onAbort);
    return () => viewSignal.removeEventListener("abort", onAbort);
  }, [viewSignal, viewId]);

  const openConnectionInPane = (connectionId) => {
    openInView(viewId, connectionId);
  };

  /**
   * Hand the agent this pane's connection. Panes are independent, so the agent
   * needs one answer to "which server am I working on"; the operator's click is
   * that answer. Clicking the already-bound pane is a no-op rather than a fresh
   * round trip.
   *
   * The report comes back from the host, not from a local guess: writing the
   * badge optimistically made a failed switch look applied for one poll tick and
   * then flip back, which reads as the agent wandering off on its own.
   */
  const bindAgent = (connectionId) => {
    if (connectionId === null || connectionId === ui.activeConnectionId) return;
    api.selectConnection(connectionId)
      .then(() => refreshConnections(api))
      .catch((error) => {
        const message = error?.message ?? String(error);
        // A missing route means the running host half predates this build:
        // client code reloads with the page, host code only with a restart.
        // Say so instead of leaving a bare transport error to decode.
        sshUiSetError(/404|not mounted|not-mounted/i.test(message)
          ? t("切换 Agent 目标失败：宿主端仍是旧版本（没有 selectConnection 接口），重启 dsh web / DSH.app 后即可生效")
          : t(`切换 Agent 目标失败：${message}`));
      });
  };


  const openSession = async () => {
    if (!active) return;
    sshUiSetBusy(true);
    sshUiSetError(null);
    try {
      await api.openSession(active.connectionId, 100, 30);
      await refreshConnections(api);
    } catch (err) {
      sshUiSetError(err?.message ?? String(err));
    } finally {
      sshUiSetBusy(false);
    }
  };


  // The host verifies a single idle POSIX shell and an empty input line.
  // Never append a command to an operator draft or a foreground program.
  const cdFromFiles = async (dir) => {
    const sessionId = active?.sessions?.[0];
    if (!sessionId || !dir) return sshUiSetError(t("请先打开当前服务器的终端，再使用 cd"));
    try {
      await api.changeDirectory(sessionId, dir);
      setTab("terminal");
    } catch (error) {
      sshUiSetError(t(`cd 失败：${error?.message ?? String(error)}`));
    }
  };

  /**
   * Hide one server tab from this pane. The host session is disconnected only
   * when no pane shows it any more, so a server open in both panes survives
   * closing it in one of them.
   */
  const closePaneTab = async (connectionId) => {
    if (!closeInView(viewId, connectionId)) return;
    try {
      await api.disconnect(connectionId);
      await refreshConnections(api);
    } catch (error) {
      // The server-side session remains alive when disconnect fails, so put the
      // local tab back rather than pretending it was released.
      openInView(viewId, connectionId);
      sshUiSetError(t(`断开服务器失败：${error?.message ?? String(error)}`));
    }
  };

  const actOnPending = async (confirmationId, action) => {
    setPendingBusy(confirmationId);
    sshUiSetError(null);
    try {
      if (action === "approve") await api.pendingConfirmationApprove(confirmationId);
      else await api.pendingConfirmationCancel(confirmationId);
    } catch (error) {
      sshUiSetError(error?.message ?? String(error));
    } finally {
      await refreshPendingConfirmations();
      setPendingBusy(null);
    }
  };

  const copyPendingCommand = async (command) => {
    try {
      await navigator.clipboard.writeText(command);
    } catch (error) {
      sshUiSetError(t(`复制命令失败：${error?.message ?? String(error)}`));
    }
  };

  return (
    <div style={panelStyles.workspace} onKeyDownCapture={onPanelKeyDown}>
      <div style={panelStyles.serverTabs}>
        {paneConnections.map((conn) => {
          const isActive = conn.connectionId === resolvedActiveConnectionId;
          const isAgentTarget = conn.connectionId === ui.activeConnectionId;
          return (
            <div
              key={conn.connectionId}
              style={{ ...panelStyles.serverTab, ...(isActive ? panelStyles.serverTabActive : {}), ...(isAgentTarget ? panelStyles.serverTabAgent : {}) }}
              onContextMenu={(event) => {
                event.preventDefault();
                setTabMenu({ x: event.clientX, y: event.clientY, connectionId: conn.connectionId });
              }}
            >
              <button
                type="button"
                style={panelStyles.serverTabLabel}
                onClick={() => {
                  selectInView(viewId, conn.connectionId);
                  bindAgent(conn.connectionId);
                }}
                title={`${conn.username}@${conn.host}:${conn.port}${isAgentTarget ? t("（Agent 正在使用此连接）") : ""}`}
              >
                {tabNames[conn.connectionId] ?? conn.name ?? `${conn.username}@${conn.host}`}
              </button>
              {isAgentTarget && (
                <span
                  style={panelStyles.agentBadge}
                  data-dsh-xssh-ops-agent-target="true"
                  role="img"
                  title={t("Agent 的 xssh_exec / sftp_* / tunnel_* 默认作用于此连接；点击其他栏可切换")}
                  aria-label={t("Agent 正在使用此连接")}
                >
                  <IconRobot16 size={15} />
                </span>
              )}
              <button
                type="button"
                style={panelStyles.serverTabClose}
                onClick={() => closePaneTab(conn.connectionId)}
                title={t("关闭此栏标签（两栏都关闭后断开服务器）")}
                aria-label={t(`关闭此栏的 ${conn.name || conn.host} 标签`)}
              >
                ×
              </button>
            </div>
          );
        })}
        {paneConnections.length === 0 && <span style={panelStyles.connEmpty}>{t("还没有连接。")}</span>}
        <button
          type="button"
          className="dsh-xssh-ops-add-btn"
          style={paneConnections.length === 0 ? panelStyles.serverTabAddLabeled : panelStyles.serverTabAdd}
          onClick={() => setDialogOpen(true)}
          title={t("连接服务器")}
          aria-label={t("连接新服务器")}
        >
          {paneConnections.length === 0 ? t("＋ 连接服务器") : t("＋")}
        </button>
      </div>

      {tabMenu !== null && (
        <>
          <div style={panelStyles.menuScrim} onMouseDown={() => setTabMenu(null)} />
          <div style={{ ...panelStyles.tabMenu, left: Math.min(tabMenu.x, window.innerWidth - 190), top: Math.min(tabMenu.y, window.innerHeight - 210) }}>
            <button
              type="button"
              style={panelStyles.tabMenuItem}
              onClick={() => {
                const target = paneConnections.find((c) => c.connectionId === tabMenu.connectionId);
                setRenameDraft({ connectionId: tabMenu.connectionId, value: tabNames[tabMenu.connectionId] ?? target?.name ?? "" });
                setTabMenu(null);
              }}
            >{t("重命名")}</button>
            <div style={panelStyles.tabMenuDivider} />
            <button type="button" style={panelStyles.tabMenuItem} onClick={() => { setSplitMode("vertical"); setTabMenu(null); }}>{t("垂直排列")}</button>
            <button type="button" style={panelStyles.tabMenuItem} onClick={() => { setSplitMode("horizontal"); setTabMenu(null); }}>{t("横向排列")}</button>
            <button type="button" style={panelStyles.tabMenuItem} onClick={() => { setSplitMode("tile"); setTabMenu(null); }}>{t("瓷砖排列")}</button>
            <div style={panelStyles.tabMenuDivider} />
            <button type="button" style={panelStyles.tabMenuItem} onClick={() => { setSplitMode("single"); setTabMenu(null); }}>{t("单窗格显示")}</button>
          </div>
        </>
      )}
      {renameDraft !== null && (
        <div style={panelStyles.renameOverlay} onMouseDown={() => setRenameDraft(null)}>
          <div style={panelStyles.renameDialog} onMouseDown={(event) => event.stopPropagation()}>
            <div style={panelStyles.renameTitle}>{t("重命名标签（仅本次会话）")}</div>
            <input
              autoFocus
              value={renameDraft.value}
              onChange={(event) => setRenameDraft({ ...renameDraft, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  const next = renameDraft.value.trim();
                  setTabNames((previous) => {
                    const copy = { ...previous };
                    if (next === "") delete copy[renameDraft.connectionId];
                    else copy[renameDraft.connectionId] = next;
                    return copy;
                  });
                  setRenameDraft(null);
                } else if (event.key === "Escape") {
                  setRenameDraft(null);
                }
              }}
              style={panelStyles.renameInput}
            />
            <div style={panelStyles.renameActions}>
              <button type="button" style={panelStyles.renameBtn} onClick={() => setRenameDraft(null)}>{t("取消")}</button>
              <button
                type="button"
                style={{ ...panelStyles.renameBtn, ...panelStyles.renameBtnPrimary }}
                onClick={() => {
                  const next = renameDraft.value.trim();
                  setTabNames((previous) => {
                    const copy = { ...previous };
                    if (next === "") delete copy[renameDraft.connectionId];
                    else copy[renameDraft.connectionId] = next;
                    return copy;
                  });
                  setRenameDraft(null);
                }}
              >{t("确定")}</button>
            </div>
          </div>
        </div>
      )}

      {ui.error && <div style={panelStyles.error}>{ui.error}</div>}

      {/* 降级告警条（计划 5.5.5 三处告警的第三处）：**不可关闭** —— 降级意味着
          结果不留远端、断线即中断，是必须知道的状态，不是可点掉的提示。 */}
      <DegradedBanner api={api} visible={tab !== null} />

      <div style={panelStyles.tabs}>
        {[
          ["terminal", t("终端")],
          ["files", t("文件")],
          ["ide", t("编辑器")],
          ["tunnels", t("转发")]
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            disabled={!active && key !== "terminal"}
            style={{
              ...panelStyles.tab,
              ...(tab === key ? panelStyles.tabActive : {})
            }}
          >
            {label}
          </button>
        ))}
        <button
          onClick={() => setTab("logs")}
          style={{
            ...panelStyles.tab,
            ...(tab === "logs" ? panelStyles.tabActive : {})
          }}
          title={t("已录制的会话日志（可搜索、下载）")}
        >{t("日志")}</button>
      </div>

      {!batchTask && pendingBatchCount > 0 && (
        <div style={panelStyles.batchNotice} onClick={openBatchTask}>{t(`⚡ ${pendingBatchCount} 个批量任务待处理，点击打开`)}</div>
      )}

      <div style={panelStyles.body}>
        <TabErrorBoundary key="terminal">
          <div style={{ ...panelStyles.tabPane, display: tab === "terminal" ? "flex" : "none" }}>
            {pendingConfirmations.length > 0 && !pendingModalOpen && (
              <div style={panelStyles.pendingInline}>
                <div style={panelStyles.pendingInlineTitle}>{t("待确认操作（在此执行或撤销）")}</div>
                <PendingConfirmations
                  confirmations={pendingConfirmations}
                  busyId={pendingBusy}
                  onApprove={(id) => actOnPending(id, "approve")}
                  onCancel={(id) => actOnPending(id, "cancel")}
                  onCopy={copyPendingCommand}
                />
              </div>
            )}
            {activeSessionId !== null && (
              <div style={panelStyles.viewBar}>
                <button
                  type="button"
                  style={terminalView === "terminal" ? panelStyles.viewTabActive : panelStyles.viewTab}
                  onClick={() => setTerminalView("terminal")}
                >
                  {t("终端")}
                </button>
                <button
                  type="button"
                  style={terminalView === "lines" ? panelStyles.viewTabActive : panelStyles.viewTab}
                  onClick={() => setTerminalView("lines")}
                  title={t("只读行号视图：按行号读取输出，供智能体与命令台账使用")}
                >
                  {t("行号")}
                </button>
              </div>
            )}
            {terminalView === "lines" && activeSessionId !== null && (
              <LinesView
                api={api}
                sessionId={activeSessionId}
                visible={tab === "terminal" && terminalView === "lines"}
                jumpRequest={lineJump}
              />
            )}
            {paneConnections.length > 0 ? (
              <div style={splitMode === "vertical"
                ? { display: "flex", flexDirection: "row", flex: 1, minHeight: 0, minWidth: 0, gap: 2 }
                : splitMode === "tile"
                  ? { display: "grid", gridTemplateColumns: `repeat(${Math.max(1, Math.ceil(Math.sqrt(paneConnections.length)))}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.max(1, Math.ceil(paneConnections.length / Math.max(1, Math.ceil(Math.sqrt(paneConnections.length)))))}, minmax(0, 1fr))`, flex: 1, minHeight: 0, gap: 2 }
                  : { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, minWidth: 0, gap: 2 }}>
              {paneConnections.map((conn) => {
                const sessionId = conn.sessions?.[0] ?? null;
                const isActive = conn.connectionId === resolvedActiveConnectionId;
                return (
                  <div
                    key={conn.connectionId}
                    style={{
                      ...panelStyles.terminalPaneWrap,
                      display: (terminalView === "terminal" && (splitMode === "single" ? isActive : true)) ? "flex" : "none",
                      ...(splitMode === "single" ? {} : { border: isActive ? "1px solid var(--dsh-xssh-ops-accent, #2d6cdf)" : "1px solid var(--dsh-xssh-ops-border, #1f242c)", borderRadius: 4, minWidth: 0, minHeight: 0 })
                    }}
                    // Clicking into a pane is the operator saying "work here":
                    // a text-selection click hits this too, which is why
                    // bindAgent is idempotent for the already-bound pane.
                    onMouseDown={() => bindAgent(conn.connectionId)}
                  >
                    {sessionId ? (
                      <XtermView api={api} sessionId={sessionId} connectionId={conn.connectionId}
                        mouse={mouseOptions}
                        background={terminalBackground}
                        customPrompts={customPrompts}
                        font={terminalFont}
                        onFontChange={changeTerminalFont}
                        fileLinksEnabled={terminalFileLinks && filesFollowTerminal}
                        wheelZoom={wheelZoomEnabled}
                        onCwdChange={(cwd) => rememberCwd(sessionId, cwd)}
                        onOpenFileToken={(name, absolutePath, ownCwd) => {
                          setTab("files");
                          setPendingFile({ name, path: absolutePath, cwd: ownCwd ?? cwdBySession[sessionId] ?? null, sessionId });
                        }}
                        lightTheme={lightTheme}
                        onInsertDraft={(text) => setDraftInsert({ text, nonce: Date.now() })}
                        onReady={(sid, termApi) => {
                          if (termApi === null) xtermApisRef.current.delete(sid);
                          else xtermApisRef.current.set(sid, termApi);
                        }} />
                    ) : (
                      <div style={panelStyles.emptyState}>
                        {t("会话已关闭")}
                        {isActive && (
                          <button onClick={openSession} disabled={ui.busy} style={{ ...panelStyles.btnTiny, marginTop: 8 }}>
                            {ui.busy ? t("忙…") : t("打开终端")}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              </div>
            ) : (
              <div style={panelStyles.emptyState}>{t("未连接")}</div>
            )}
            {/* 命令编辑框：终端页签的固定底栏（计划 5.6）。行号视图下也能发命令，
                因为它是「常用通道」，不该切回终端视图才能用。 */}
            <CommandInput api={api} sessionId={activeSessionId} disabled={activeSessionId === null}
              connectionId={resolvedActiveConnectionId}
              groups={groups}
              insertRequest={draftInsert}
              sendRule={sendRule}
              broadcastRequest={broadcastRequest}
              targets={paneConnections.flatMap((c) => (c.sessions ?? []).map((sessionId) => ({ sessionId, label: c.name ?? c.host ?? c.connectionId, groupId: paneProfiles.find((p) => p.profileId === c.profileId)?.groupId ?? "" })))}
              broadcastHintDismissed={broadcastHintDismissed} />
          </div>
        </TabErrorBoundary>
        {active && (
          <>
            <TabErrorBoundary key="files">
              <div style={{ ...panelStyles.tabPane, display: tab === "files" ? "flex" : "none" }}>
                <SshFiles
                  api={api}
                  connectionId={active.connectionId}
                  onEditFile={(path) => { setTab("ide"); setIdePendingPath(path); }}
                  followPath={filesFollowTerminal ? terminalCwd : null}
                  pendingFile={pendingFile}
                  onPendingConsumed={() => setPendingFile(null)}
                  onCd={cdFromFiles}
                  initialPath={ui.projectTarget?.connectionId === active.connectionId ? ui.projectTarget.path : "/"}
                />
              </div>
            </TabErrorBoundary>
            <TabErrorBoundary key="tunnels">
              <div style={{ ...panelStyles.tabPane, display: tab === "ide" ? "flex" : "none" }}>
                <SshIde api={api} connectionId={resolvedActiveConnectionId} lightTheme={lightTheme} pendingPath={idePendingPath} onPendingConsumed={() => setIdePendingPath(null)} />
              </div>
              <div style={{ ...panelStyles.tabPane, display: tab === "tunnels" ? "flex" : "none" }}>
                <SshTunnels api={api} connectionId={active.connectionId} />
              </div>
            </TabErrorBoundary>
          </>
        )}
        <TabErrorBoundary key="logs">
          <div style={{ ...panelStyles.tabPane, display: tab === "logs" ? "flex" : "none" }}>
            {/* 日志页签三个子视图：命令台账（命令语义，默认）、后台任务（M4 的任务侧面）、
                会话日志（原始流，排查 TUI 问题时唯一的证据，见 9-Q9）。 */}
            <div style={panelStyles.viewBar}>
              <button
                type="button"
                style={logView === "ledger" ? panelStyles.viewTabActive : panelStyles.viewTab}
                onClick={() => setLogView("ledger")}
              >
                {t("命令台账")}
              </button>
              <button
                type="button"
                style={logView === "tasks" ? panelStyles.viewTabActive : panelStyles.viewTab}
                onClick={() => setLogView("tasks")}
              >
                {t("后台任务")}
              </button>
              <button
                type="button"
                style={logView === "sessions" ? panelStyles.viewTabActive : panelStyles.viewTab}
                onClick={() => setLogView("sessions")}
              >
                {t("会话日志")}
              </button>
              {logView === "ledger" && <span style={panelStyles.viewNote}>{t("不含 login-script / 保活")}</span>}
              {logView === "tasks" && <span style={panelStyles.viewNote}>{t("落点 / 状态 / 产物")}</span>}
            </div>
            {logView === "ledger" && <CommandLedger api={api} sessionId={activeSessionId} visible={tab === "logs" && logView === "ledger"}
              onJump={(record) => {
                if (record === null || record === undefined || record.startLine === null || record.startLine === undefined) return;
                setTab("terminal");
                setTerminalView("lines");
                setLineJump({ line: record.startLine, nonce: Date.now() });
              }} />}
            {logView === "tasks" && <TaskList api={api} connectionId={resolvedActiveConnectionId} visible={tab === "logs" && logView === "tasks"} />}
            {logView === "sessions" && <SshLogs api={api} />}
          </div>
        </TabErrorBoundary>
      </div>

      {pendingModalOpen && pendingConfirmations.length > 0 && (
        <div
          style={panelStyles.pendingModalBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label={t("危险操作确认")}
          onClick={() => setPendingModalOpen(false)}
        >
          <div style={panelStyles.pendingModal} onClick={(e) => e.stopPropagation()}>
            <div style={panelStyles.pendingModalTitle}>{t("⚠️ 检测到危险命令等待确认")}</div>
            <div style={panelStyles.pendingModalHint}>{t("以下命令由 Agent 发起且尚未执行，只有点击「执行」才会发送到服务器。")}</div>
            <PendingConfirmations
              confirmations={pendingConfirmations}
              busyId={pendingBusy}
              onApprove={(id) => actOnPending(id, "approve")}
              onCancel={(id) => actOnPending(id, "cancel")}
              onCopy={copyPendingCommand}
              alwaysExpand
            />
            <div style={panelStyles.dialogActions}>
              <button type="button" style={panelStyles.btnSecondary} onClick={() => setPendingModalOpen(false)}>{t("稍后在面板中处理")}</button>
            </div>
          </div>
        </div>
      )}

      {dialogOpen && <ConnectDialog api={api} credentials={credentials} onConnected={openConnectionInPane} onEditResource={openResourceEditor} onClose={() => setDialogOpen(false)} />}

      {editorProfile && (
        <ResourceEditor
          initial={editorProfile}
          groups={editorData.groups}
          profiles={paneProfiles}
          sharedCredentials={editorData.sharedCredentials}
          proxyLibrary={editorData.proxyLibrary}
          credentials={credentials}
          api={api}
          onClose={() => setEditorProfile(null)}
          onSaved={() => {
            setEditorProfile(null);
            api.profileList?.().then((v) => setPaneProfiles(v.profiles ?? [])).catch(() => {});
          }}
        />
      )}

      {batchTask && <BatchDialog api={api} task={batchTask} onDone={() => setBatchTask(null)} />}
    </div>
  );
}

const panelStyles = {
  /** The workspace fill: fits the official Sidebar's tab body (block parent
   * with a definite height). */
  workspace: {
    boxSizing: "border-box",
    flex: "1 1 auto",
    height: "100%",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    background: "var(--dsh-xssh-ops-bg, #101418)",
    fontFamily: "var(--dsw-font-family, system-ui, sans-serif)",
    color: "var(--dsh-xssh-ops-text, #d7dbe2)"
  },
  btnSmall: {
    background: "transparent",
    border: "1px solid var(--dsh-xssh-ops-border, #3a414b)",
    color: "var(--dsh-xssh-ops-text, #d7dbe2)",
    borderRadius: 6,
    width: 26,
    height: 26,
    cursor: "pointer",
    fontSize: 14,
    lineHeight: 1
  },
  btnTiny: {
    background: "transparent",
    border: "1px solid #3a414b",
    color: "#d7dbe2",
    borderRadius: 6,
    padding: "2px 8px",
    fontSize: 12,
    cursor: "pointer"
  },
  serverTabs: {
    display: "flex",
    gap: 2,
    padding: "6px 8px 0",
    borderBottom: "1px solid var(--dsh-xssh-ops-border, #1f242c)",
    flex: "none",
    alignItems: "center",
    flexWrap: "wrap",
    maxHeight: 120,
    overflowY: "auto"
  },
  serverTab: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    border: "1px solid var(--dsh-xssh-ops-border, #3a414b)",
    borderBottom: "none",
    borderRadius: "6px 6px 0 0",
    background: "var(--dsh-xssh-ops-tab, #1a1f26)",
    color: "var(--dsh-xssh-ops-muted, #8b93a1)",
    overflow: "hidden",
    flex: "none",
    maxWidth: 190
  },
  serverTabActive: {
    background: "var(--dsh-xssh-ops-bg, #101418)",
    color: "var(--dsh-xssh-ops-text, #d7dbe2)",
    borderBottom: "2px solid #2d6cdf"
  },
  /**
   * The connection the agent's connection-less tool calls resolve to.
   *
   * RoyalBlue3, picked by the operator. It sits close to the active-tab
   * underline (#2d6cdf), so the tab outline is only half the signal — the solid
   * chip with the robot glyph is what actually separates "the agent is here"
   * from "this tab is selected".
   *
   * Solid fill with white ink: royal blue is dark enough for a white glyph
   * (~5.8:1), and a chip that carries its own fill reads the same on both
   * Sidebar themes.
   */
  serverTabAgent: {
    borderColor: "#3a5fcd",
    boxShadow: "inset 0 0 0 1px rgba(58, 95, 205, .9)"
  },
  agentBadge: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
    marginRight: 2,
    padding: "2px 4px",
    borderRadius: 999,
    background: "#3a5fcd",
    border: "1px solid #3a5fcd",
    color: "#ffffff",
    cursor: "default"
  },
  serverTabLabel: {
    background: "transparent",
    border: "none",
    color: "inherit",
    fontSize: 12,
    padding: "6px 8px",
    cursor: "pointer",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: 1,
    minWidth: 0,
    textAlign: "left"
  },
  serverTabClose: {
    background: "transparent",
    border: "none",
    color: "inherit",
    fontSize: 14,
    lineHeight: 1,
    padding: "0 7px 0 2px",
    cursor: "pointer",
    opacity: 0.8
  },
  // Add-server button. Colors/border/hover live in the injected
  // .dsh-xssh-ops-add-btn class; these inline styles carry only geometry.
  serverTabAdd: {
    width: 24,
    height: 24,
    fontSize: 14,
    flex: "none"
  },
  serverTabAddLabeled: {
    height: 24,
    padding: "0 10px",
    fontSize: 12,
    flex: "none"
  },
  connEmpty: { fontSize: 12, color: "#8b93a1", flex: "none", alignSelf: "center" },
  error: {
    padding: "6px 12px",
    fontSize: 12,
    color: "#f85149",
    background: "rgba(248,81,73,.1)",
    borderBottom: "1px solid rgba(248,81,73,.3)",
    flex: "none"
  },
  body: { flex: 1, minHeight: 0, padding: 8, display: "flex", flexDirection: "column" },
  menuScrim: { position: "fixed", inset: 0, zIndex: 96, background: "transparent" },
  tabMenu: { position: "fixed", zIndex: 97, minWidth: 150, padding: 4, borderRadius: 8, background: "#2b2f36", border: "1px solid rgba(0,0,0,.35)", boxShadow: "0 8px 24px rgba(0,0,0,.35)" },
  tabMenuItem: { display: "block", width: "100%", padding: "6px 9px", background: "transparent", border: 0, color: "#e6e8eb", fontSize: 12, textAlign: "left", borderRadius: 4, cursor: "pointer" },
  tabMenuDivider: { height: 1, margin: "4px 6px", background: "rgba(255,255,255,.12)" },
  renameOverlay: { position: "fixed", inset: 0, zIndex: 98, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.4)" },
  renameDialog: { width: "min(360px, calc(100vw - 32px))", display: "flex", flexDirection: "column", gap: 10, padding: 14, borderRadius: 12, background: "var(--dsh-xssh-ops-surface, #161b21)", border: "1px solid var(--dsh-xssh-ops-border, #3a414b)", boxShadow: "0 12px 32px rgba(0,0,0,.4)" },
  renameTitle: { fontSize: 13, fontWeight: 650, color: "var(--dsh-xssh-ops-text, #d7dbe2)" },
  renameInput: { padding: "6px 8px", fontSize: 13, borderRadius: 6, border: "1px solid var(--dsh-xssh-ops-border, #3a414b)", background: "rgba(135,135,135,.08)", color: "inherit" },
  renameActions: { display: "flex", justifyContent: "flex-end", gap: 8 },
  renameBtn: { padding: "5px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer", background: "transparent", border: "1px solid var(--dsh-xssh-ops-border, #3a414b)", color: "inherit" },
  renameBtnPrimary: { background: "rgba(45,108,223,.2)", borderColor: "#2d6cdf" },
  tabPane: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
  terminalPaneWrap: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
  tabs: {
    display: "flex", gap: 4, padding: "0 8px", borderBottom: "1px solid var(--dsh-xssh-ops-border, #1f242c)",
    flex: "none", alignItems: "center"
  },
  tab: {
    background: "transparent", border: "none", color: "var(--dsh-xssh-ops-muted, #8b93a1)",
    padding: "6px 12px", fontSize: 12, cursor: "pointer",
    borderBottom: "2px solid transparent"
  },
  tabActive: { color: "var(--dsh-xssh-ops-text, #d7dbe2)", borderBottomColor: "#2d6cdf" },
  // 终端页签内的「终端 / 行号」视图切换条。
  viewBar: { display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderBottom: "1px solid var(--dsh-xssh-ops-border, #1f242c)", flex: "none" },
  viewTab: { padding: "2px 8px", fontSize: 12, borderRadius: 4, cursor: "pointer", background: "transparent", color: "var(--dsh-xssh-ops-muted, #8b93a1)", border: "1px solid transparent" },
  viewTabActive: { padding: "2px 8px", fontSize: 12, borderRadius: 4, cursor: "pointer", background: "rgba(45,108,223,.18)", color: "var(--dsh-xssh-ops-text, #d7dbe2)", border: "1px solid #2d6cdf" },
  viewNote: { fontSize: 11, color: "var(--dsh-xssh-ops-muted, #8b93a1)" },
  emptyState: { margin: "auto", fontSize: 12, color: "var(--dsh-xssh-ops-muted, #8b93a1)", textAlign: "center" },
  // 注意：不要给终端容器加 `contain: layout paint`（用户 2026-10-20 实测）：xterm 改字号
  // 时会反复测量容器尺寸，容器成为独立布局根后每次测量都要重算其内部布局，web 端口实测
  // 从 247ms 恶化到 3858ms；移除后恢复。overflow: hidden 已足够限制绘制范围。
  xtermWrap: { flex: 1, minWidth: 0, overflow: "hidden" },
  xtermHost: { position: "relative", display: "flex", flex: 1, minWidth: 0, minHeight: 0 },
  // 终端右键菜单与提示条（用户 2026-10-18）。
  termMenu: { position: "fixed", zIndex: 96, minWidth: 150, padding: 4, borderRadius: 7, background: "#2b2f36", border: "1px solid rgba(0,0,0,.3)", boxShadow: "0 8px 24px rgba(0,0,0,.3)" },
  termMenuItem: { display: "block", width: "100%", padding: "5px 8px", background: "transparent", border: 0, color: "#e6e8eb", fontSize: 12, textAlign: "left", borderRadius: 4, cursor: "pointer" },
  termToast: { position: "absolute", left: "50%", bottom: 16, transform: "translateX(-50%)", zIndex: 97, padding: "5px 10px", borderRadius: 6, background: "rgba(43,47,54,.96)", color: "#fff", fontSize: 12, border: "1px solid rgba(0,0,0,.25)" },
  fontControls: { position: "absolute", top: 6, right: 40, zIndex: 5, display: "inline-flex", gap: 4 },
  fontBtn: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, borderRadius: 4, cursor: "pointer", background: "var(--dsh-xssh-ops-surface, #161b21)", border: "1px solid var(--dsh-xssh-ops-border, #3a414b)", color: "var(--dsh-xssh-ops-muted, #8b93a1)" },
  fontMenu: { position: "absolute", top: 34, right: 40, zIndex: 8, minWidth: 170, padding: 4, borderRadius: 6, background: "var(--dsh-xssh-ops-surface, #161b21)", border: "1px solid var(--dsh-xssh-ops-border, #3a414b)", boxShadow: "0 6px 18px rgba(0,0,0,.3)" },
  fontMenuItem: { display: "block", width: "100%", padding: "5px 8px", background: "transparent", border: 0, color: "var(--dsh-xssh-ops-text, #d7dbe2)", fontSize: 12, textAlign: "left", borderRadius: 4, cursor: "pointer" },
  fontMenuItemActive: { background: "rgba(45,108,223,.25)" },
  fontMenuDivider: { height: 1, margin: "4px 6px", background: "var(--dsh-xssh-ops-border, #3a414b)" },
  // 字体菜单里的「字号」行（用户 2026-10-20：显示当前字号并可直接设置）。
  fontMenuRow: { display: "flex", alignItems: "center", gap: 6, padding: "6px 8px" },
  fontMenuLabel: { flex: 1, fontSize: 12, color: "var(--dsh-xssh-ops-muted, #8b93a1)" },
  fontSizeInput: { width: 52, padding: "3px 6px", borderRadius: 5, border: "1px solid var(--dsh-xssh-ops-border, #3a414b)", background: "var(--dsh-xssh-ops-surface, #161b21)", color: "inherit", fontSize: 12 },
  searchOpenBtn: {
    position: "absolute", top: 6, right: 10, zIndex: 5, display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: 22, height: 22, padding: 0, borderRadius: 4, cursor: "pointer",
    background: "var(--dsh-xssh-ops-surface, #161b21)", border: "1px solid var(--dsh-xssh-ops-border, #3a414b)",
    color: "var(--dsh-xssh-ops-muted, #8b93a1)"
  },
  searchBar: {
    position: "absolute", top: 6, right: 10, zIndex: 5, display: "flex", alignItems: "center", gap: 4,
    padding: "3px 6px", borderRadius: 6,
    background: "var(--dsh-xssh-ops-surface, #161b21)", border: "1px solid var(--dsh-xssh-ops-border, #3a414b)"
  },
  searchInput: {
    width: 150, background: "var(--dsh-xssh-ops-input, #101418)", border: "1px solid var(--dsh-xssh-ops-border, #3a414b)",
    borderRadius: 4, color: "var(--dsh-xssh-ops-text, #d7dbe2)", padding: "2px 6px", fontSize: 12, outline: "none"
  },
  searchCount: { fontSize: 11, color: "var(--dsh-xssh-ops-muted, #8b93a1)", minWidth: 34, textAlign: "center" },
  searchBtn: {
    background: "transparent", border: "none", color: "var(--dsh-xssh-ops-muted, #8b93a1)",
    cursor: "pointer", fontSize: 13, padding: "0 3px", lineHeight: 1.2
  },
  dialogBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,.5)",
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  },
  dialog: {
    width: 360,
    maxWidth: "90vw",
    background: "var(--dsh-xssh-ops-surface, #181c22)",
    border: "1px solid var(--dsh-xssh-ops-border, #2a303a)",
    borderRadius: 12,
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    boxShadow: "0 12px 40px rgba(0,0,0,.5)"
  },
  dialogTitle: { fontSize: 14, fontWeight: 600, marginBottom: 2 },
  temporaryTitle: { fontSize: 12, color: "var(--dsh-xssh-ops-muted, #9aa3af)", marginTop: 2 },
  field: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--dsh-xssh-ops-muted, #9aa3af)", minWidth: 0 },
  formRow: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 },
  savedProfileRow: { display: "flex", alignItems: "flex-end", flexWrap: "wrap", gap: 8 },
  reuseToggle: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    paddingBottom: 7,
    fontSize: 12,
    color: "var(--dsh-xssh-ops-muted, #9aa3af)",
    cursor: "pointer",
    whiteSpace: "nowrap"
  },
  input: {
    background: "var(--dsh-xssh-ops-input, #101418)",
    border: "1px solid var(--dsh-xssh-ops-border, #2a303a)",
    borderRadius: 6,
    color: "var(--dsh-xssh-ops-text, #d7dbe2)",
    padding: "6px 8px",
    fontSize: 13,
    outline: "none"
  },
  dialogError: { fontSize: 12, color: "#f85149" },
  dialogStatus: {
    fontSize: 12,
    color: "#9cc8ff",
    background: "rgba(45,108,223,.12)",
    border: "1px solid rgba(45,108,223,.3)",
    borderRadius: 6,
    padding: "7px 8px"
  },
  keyImportRow: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
  proxyJumpSection: { display: "flex", flexDirection: "column", gap: 6 },
  proxyJumpToggle: { background: "transparent", border: "none", color: "var(--dsh-xssh-ops-muted, #9aa3af)", fontSize: 12, cursor: "pointer", textAlign: "left", padding: 0 },
  proxyJumpList: { display: "flex", flexDirection: "column", gap: 4, padding: "6px 0" },
  proxyJumpRow: { display: "flex", gap: 4 },
  batchSection: { display: "flex", flexDirection: "column", gap: 6, padding: "8px 0", borderTop: "1px solid #262b33" },
  batchTitle: { fontSize: 12, color: "#9aa3af" },
  batchNotice: { padding: "6px 10px", fontSize: 12, color: "#ffb86b", background: "rgba(255,184,107,.1)", borderBottom: "1px solid #3a3420", cursor: "pointer", userSelect: "none" },
  batchList: { display: "flex", flexDirection: "column", gap: 4, maxHeight: 120, overflowY: "auto" },
  batchItem: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#d7dbe2", cursor: "pointer" },
  pendingInline: { flex: "none", display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflowY: "auto", padding: "2px 0 8px", borderBottom: "1px solid #262b33", marginBottom: 8 },
  pendingInlineTitle: { fontSize: 12, fontWeight: 600, color: "#ffb86b" },
  pendingList: { display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", padding: "2px 0" },
  pendingCard: { border: "1px solid #3a414b", borderRadius: 8, padding: 10, background: "#181c22", display: "flex", flexDirection: "column", gap: 7 },
  pendingHead: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
  pendingBadge: { flex: "none", color: "#ffb86b", fontSize: 13, lineHeight: 1 },
  pendingToggle: {
    flex: 1, minWidth: 0, textAlign: "left",
    background: "#101418", border: "1px solid #262b33", borderRadius: 6,
    color: "#f4f6f8", fontSize: 12,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    padding: "6px 8px",
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
  },
  pendingHostTag: { flex: "none", maxWidth: 140, fontSize: 11, color: "#9aa3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  pendingModalBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,.6)",
    zIndex: 1100,
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  },
  pendingModal: {
    width: 560,
    maxWidth: "92vw",
    maxHeight: "80vh",
    overflowY: "auto",
    background: "#181c22",
    border: "1px solid #4a3520",
    borderRadius: 12,
    boxShadow: "0 16px 48px rgba(0,0,0,.55)",
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 10
  },
  pendingModalTitle: { fontSize: 15, fontWeight: 700, color: "#ffb86b" },
  pendingModalHint: { fontSize: 12, color: "#9aa3af" },
  pendingMeta: { fontSize: 11, color: "#9aa3af" },
  pendingReason: { fontSize: 12, color: "#ffb86b" },
  pendingCommand: { margin: 0, padding: 8, borderRadius: 6, background: "#101418", color: "#f4f6f8", border: "1px solid #262b33", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: 'Menlo, Monaco, "Courier New", monospace' },
  pendingActions: { display: "flex", justifyContent: "flex-end", gap: 8 },
  btnDanger: { background: "#c9372c", color: "#fff", border: "1px solid #e14b40", borderRadius: 6, padding: "6px 14px", fontSize: 13, cursor: "pointer" },
  hiddenFileInput: { display: "none" },
  keyImportHint: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "var(--dsh-xssh-ops-muted, #8b93a1)" },
  dialogActions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 },
  btnPrimary: {
    background: "var(--dsw-alias-button-primary-fill, #2d6cdf)",
    color: "var(--dsw-alias-label-primary-foreground, #fff)",
    border: "none",
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 13,
    cursor: "pointer"
  },
  btnSecondary: {
    background: "var(--dsw-alias-bg-layer-1, transparent)",
    color: "var(--dsh-xssh-ops-text, #d7dbe2)",
    border: "1px solid var(--dsh-xssh-ops-border, #3a414b)",
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 13,
    cursor: "pointer"
  }
};

