/**
 * 编辑器页签（用户 2026-10-19 起）：左侧远端**文件树**（按需展开子目录），
 * 右侧 Monaco 编辑区（自动换行 / 行号可切换）。读写走既有 SFTP 通道。
 */
import * as React from "react";
import { t } from "../i18n/core.js";
import { CodeEditor } from "./CodeEditor.jsx";
import { decodeEditableText, encodeEditableText } from "./file-editor.js";
import { formatSize, isImageName } from "./file-view.js";
import { languageForPath } from "./monaco-loader.js";
import { iconFor } from "./file-icons.js";
const { useEffect, useState } = React;

const join = (base, name) => (base === "/" ? `/${name}` : `${base.replace(/\/+$/, "")}/${name}`);
const LANGUAGES = [["plaintext", "Plain text"], ["javascript", "JavaScript"], ["typescript", "TypeScript"], ["json", "JSON"], ["markdown", "Markdown"], ["html", "HTML"], ["css", "CSS"], ["xml", "XML"], ["yaml", "YAML"], ["shell", "Shell"], ["python", "Python"], ["php", "PHP"], ["java", "Java"], ["sql", "SQL"], ["ini", "INI"]];

function TreeLevel({ path, depth, children, expanded, busyPaths, onToggle, onOpen, activePath, onMenu }) {
  const entries = children.get(path);
  if (!entries) {
    return depth === 0 && busyPaths.has(path) ? <div style={styles.hint}>{t("加载中…")}</div> : null;
  }
  return (
    <div>
      {entries.map((entry) => {
        const full = join(path, entry.name);
        const isDir = entry.isDirectory === true;
        const open = expanded.has(full);
        return (
          <div key={full}>
            <button
              type="button"
              style={{ ...styles.node, paddingLeft: 6 + depth * 12, ...(activePath === full ? styles.nodeActive : {}) }}
              onClick={() => (isDir ? onToggle(full) : onOpen(full, entry))}
              onContextMenu={(event) => onMenu(event, { entry, path: full })}
              title={isDir ? t("展开/收起目录") : t(`${entry.name}（${formatSize(entry.size)}）`)}
            >
              <span style={styles.glyph}>{isDir ? (open ? "▾" : "▸") : " "}</span>
              <span style={styles.icon}>{iconFor(entry.name, isDir)}</span>
              <span style={styles.name}>{entry.name}</span>
            </button>
            {isDir && open && (
              <TreeLevel path={full} depth={depth + 1} children={children} expanded={expanded} busyPaths={busyPaths} onToggle={onToggle} onOpen={onOpen} activePath={activePath} onMenu={onMenu} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function SshIde({ api, connectionId, lightTheme = false, pendingPath = null, onPendingConsumed = null }) {
  const [children, setChildren] = useState(() => new Map());
  const [expanded, setExpanded] = useState(() => new Set());
  const [busyPaths, setBusyPaths] = useState(() => new Set());
  const [error, setError] = useState(null);
  // 多文件页签（用户 2026-10-19）：同时打开多个文件，activePath 指向当前标签。
  const [files, setFiles] = useState([]);
  const [activePath, setActivePath] = useState(null);
  const [treeWidth, setTreeWidth] = useState(260);
  const file = files.find((item) => item.path === activePath) ?? null;
  const [language, setLanguage] = useState("plaintext");
  const [dirty, setDirty] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [lineNumbers, setLineNumbers] = useState(true);
  const [busy, setBusy] = useState(false);
  // 树右键菜单（用户 2026-10-19）：新建文件/目录、重命名、删除。
  const [menu, setMenu] = useState(null);

  const loadDir = async (path) => {
    if (!connectionId) return;
    setBusyPaths((prev) => new Set(prev).add(path));
    try {
      const value = await api.sftpList(connectionId, path);
      const entries = Array.isArray(value?.entries) ? [...value.entries].sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      }) : [];
      setChildren((prev) => new Map(prev).set(path, entries));
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusyPaths((prev) => { const next = new Set(prev); next.delete(path); return next; });
    }
  };

  // 文件页签「编辑」跳转过来时打开指定文件（用户 2026-10-19）。
  useEffect(() => {
    if (!pendingPath || !connectionId) return;
    const name = pendingPath.split("/").pop() ?? "";
    void openFile(pendingPath, { name, isDirectory: false, size: 0 });
    onPendingConsumed?.();
  }, [pendingPath]);

  useEffect(() => {
    setChildren(new Map());
    setExpanded(new Set());
    setFiles([]);
    setActivePath(null);
    setError(null);
    if (connectionId) void loadDir("/");
  }, [connectionId]);

  const refreshDir = async (dir) => {
    setChildren((prev) => { const next = new Map(prev); next.delete(dir); return next; });
    await loadDir(dir);
  };
  const parentOf = (path) => {
    const index = path.lastIndexOf("/");
    return index <= 0 ? "/" : path.slice(0, index);
  };
  const createEntry = async (dir, kind) => {
    const label = kind === "dir" ? t("新目录名") : t("新文件名");
    const name = window.prompt(label);
    if (!name || name.trim() === "") return;
    setError(null);
    try {
      if (kind === "dir") await api.sftpMkdir(connectionId, join(dir, name.trim()));
      else await api.sftpWriteFile(connectionId, join(dir, name.trim()), new Uint8Array(0));
      await refreshDir(dir);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    }
  };
  const renameEntry = async (entry, path) => {
    const name = window.prompt(t("新名称"), entry.name);
    if (!name || name.trim() === "" || name === entry.name) return;
    setError(null);
    try {
      await api.sftpRename(connectionId, path, join(parentOf(path), name.trim()));
      await refreshDir(parentOf(path));
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    }
  };
  const removeEntry = async (entry, path) => {
    if (!window.confirm(t(`确定删除 ${path} ？此操作不可恢复。`))) return;
    setError(null);
    try {
      await api.sftpDelete(connectionId, path);
      await refreshDir(parentOf(path));
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    }
  };
  const openMenu = (event, node) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, node });
  };

  const toggle = async (path) => {
    if (expanded.has(path)) {
      setExpanded((prev) => { const next = new Set(prev); next.delete(path); return next; });
      return;
    }
    if (!children.has(path)) await loadDir(path);
    setExpanded((prev) => new Set(prev).add(path));
  };

  const openFile = async (path, entry) => {
    if (isImageName(entry.name)) { setError(t("图片请到「文件」页签里预览")); return; }
    setBusy(true);
    setError(null);
    try {
      const value = await api.sftpReadFile(connectionId, path, 16 * 1024 * 1024);
      const decoded = decodeEditableText(value.data);
      if (!decoded.ok) { setError(decoded.reason); return; }
      setFiles((prev) => (prev.some((item) => item.path === path)
        ? prev
        : [...prev, { path, text: decoded.text, original: decoded.text }]));
      setActivePath(path);
      setLanguage(languageForPath(entry.name));
      setDirty(false);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await api.sftpWriteFile(connectionId, file.path, encodeEditableText(file.text));
      setFiles((prev) => prev.map((item) => (item.path === file.path ? { ...item, original: file.text } : item)));
      setDirty(false);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!connectionId) return <div style={styles.empty}>{t("请先连接服务器，编辑器会显示远端目录。")}</div>;

  return (
    <div style={styles.root}>
      <div style={{ ...styles.sidebar, width: treeWidth }}>
        <div style={styles.sideTitle}>
          <span style={styles.sideLabel}>{t("远端文件")}</span>
          <button type="button" style={styles.btn} title={t("刷新")} onClick={() => { setChildren(new Map()); setExpanded(new Set()); void loadDir("/"); }}>↻</button>
        </div>
        <div style={styles.tree}>
          <TreeLevel path="/" depth={0} children={children} expanded={expanded} busyPaths={busyPaths} onToggle={(path) => void toggle(path)} onOpen={(path, entry) => void openFile(path, entry)} activePath={file?.path ?? null} onMenu={(event, node) => openMenu(event, node)} />
          {children.get("/")?.length === 0 && <div style={styles.hint}>{t("空目录")}</div>}
        </div>
      </div>

      <div
        style={styles.splitter}
        role="separator"
        aria-orientation="vertical"
        title={t("拖动调整宽度")}
        onMouseDown={(event) => {
          const startX = event.clientX;
          const startWidth = treeWidth;
          const onMove = (moveEvent) => setTreeWidth(Math.min(520, Math.max(180, startWidth + moveEvent.clientX - startX)));
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
          event.preventDefault();
        }}
      />

      <div style={styles.main}>
        {files.length > 0 && (
          <div style={styles.tabs}>
            {files.map((item) => (
              <span key={item.path} style={{ ...styles.tab, ...(item.path === activePath ? styles.tabActive : {}) }}>
                <button type="button" style={styles.tabLabel} onClick={() => setActivePath(item.path)} title={item.path}>
                  {item.path.split("/").pop()}{item.text !== item.original ? " *" : ""}
                </button>
                <button
                  type="button"
                  style={styles.tabClose}
                  title={t("关闭标签")}
                  onClick={() => {
                    setFiles((prev) => prev.filter((entry) => entry.path !== item.path));
                    if (activePath === item.path) setActivePath(files.find((entry) => entry.path !== item.path)?.path ?? null);
                  }}
                >×</button>
              </span>
            ))}
          </div>
        )}
        <div style={styles.toolbar}>
          <span style={styles.fileName} title={file?.path}>{file ? file.path : t("未打开文件")}</span>
          {file && (
            <>
              <select value={language} onChange={(event) => setLanguage(event.target.value)} style={styles.select} title={t("语法高亮语言")}>
                {LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <button type="button" style={{ ...styles.btn, ...(wrap ? styles.btnOn : {}) }} onClick={() => setWrap((value) => !value)} title={t("自动换行")}>{t("换行")}</button>
              <button type="button" style={{ ...styles.btn, ...(lineNumbers ? styles.btnOn : {}) }} onClick={() => setLineNumbers((value) => !value)} title={t("显示行号")}>{t("行号")}</button>
              <button type="button" style={{ ...styles.saveBtn, ...(dirty ? styles.saveBtnDirty : {}) }} onClick={() => void save()} disabled={busy || !dirty}>{dirty ? t("保存 *") : t("保存")}</button>
            </>
          )}
        </div>
        {error && <div style={styles.error}>{error}</div>}
        {file ? (
          <CodeEditor
            key={file.path}
            path={file.path}
            value={file.text}
            onChange={(next) => {
              setFiles((prev) => prev.map((item) => (item.path === file.path ? { ...item, text: next } : item)));
              setDirty(next !== file.original);
            }}
            theme={lightTheme ? "light" : "dark"}
            language={language}
            wordWrap={wrap}
            lineNumbers={lineNumbers}
          />
        ) : (
          <div style={styles.empty}>{t("在左侧文件树里选择文件开始编辑")}</div>
        )}
      </div>

      {menu !== null && (
        <>
          <div style={styles.menuScrim} onMouseDown={() => setMenu(null)} onContextMenu={(event) => { event.preventDefault(); setMenu(null); }} />
          <div style={{ ...styles.menu, left: Math.min(menu.x, window.innerWidth - 180), top: Math.min(menu.y, window.innerHeight - 200) }} role="menu">
            {(() => {
              const node = menu.node;
              const entry = node.entry;
              const dir = entry === null ? node.path : entry.isDirectory ? node.path : parentOf(node.path);
              return (
                <>
                  <button type="button" role="menuitem" style={styles.menuItem} onClick={() => { setMenu(null); void createEntry(dir, "file"); }}>{t("新建文件")}</button>
                  <button type="button" role="menuitem" style={styles.menuItem} onClick={() => { setMenu(null); void createEntry(dir, "dir"); }}>{t("新建目录")}</button>
                  {entry !== null && (
                    <>
                      <div style={styles.menuDivider} />
                      <button type="button" role="menuitem" style={styles.menuItem} onClick={() => { setMenu(null); void renameEntry(entry, node.path); }}>{t("重命名")}</button>
                      <button type="button" role="menuitem" style={{ ...styles.menuItem, color: "#f85149" }} onClick={() => { setMenu(null); void removeEntry(entry, node.path); }}>{t("删除")}</button>
                    </>
                  )}
                </>
              );
            })()}
          </div>
        </>
      )}
    </div>
  );
}

const styles = {
  root: { flex: 1, minHeight: 0, display: "flex", gap: 6 },
  sidebar: { flex: "none", display: "flex", flexDirection: "column", border: "1px solid var(--dsw-alias-border-l4, #2a303a)", borderRadius: 6, minHeight: 0 },
  splitter: { width: 6, flex: "none", cursor: "col-resize", borderRadius: 3, background: "rgba(127,127,127,.18)" },
  tabs: { display: "flex", gap: 2, flex: "none", overflowX: "auto", paddingBottom: 2 },
  tab: { display: "inline-flex", alignItems: "center", gap: 2, padding: "0 4px", borderRadius: 5, border: "1px solid var(--dsw-alias-border-l4, #3a414b)", background: "transparent", maxWidth: 180 },
  tabActive: { background: "rgba(45,108,223,.18)", borderColor: "rgba(45,108,223,.5)" },
  tabLabel: { border: 0, background: "transparent", color: "inherit", fontSize: 11, cursor: "pointer", padding: "2px 2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  tabClose: { border: 0, background: "transparent", color: "var(--dsw-alias-label-secondary, #9aa3af)", cursor: "pointer", fontSize: 12, padding: "0 2px" },
  sideTitle: { display: "flex", alignItems: "center", gap: 4, padding: "4px 6px", borderBottom: "1px solid var(--dsw-alias-border-l4, #2a303a)" },
  sideLabel: { flex: 1, fontSize: 11, color: "var(--dsw-alias-label-secondary, #9aa3af)" },
  tree: { flex: 1, overflow: "auto", padding: "4px 2px" },
  node: { display: "flex", alignItems: "center", gap: 4, width: "100%", padding: "2px 4px", border: 0, background: "transparent", color: "inherit", borderRadius: 4, fontSize: 12, cursor: "pointer", textAlign: "left" },
  nodeActive: { background: "rgba(45,108,223,.18)" },
  glyph: { width: 10, flex: "none", color: "var(--dsw-alias-label-secondary, #9aa3af)" },
  icon: { flex: "none" },
  name: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  main: { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 4 },
  toolbar: { display: "flex", alignItems: "center", gap: 6, flex: "none" },
  fileName: { flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dsw-alias-label-secondary, #9aa3af)" },
  select: { fontSize: 11, padding: "2px 4px", borderRadius: 5, background: "var(--dsw-alias-bg-layer-1, #101418)", color: "inherit", border: "1px solid var(--dsw-alias-border-l4, #3a414b)" },
  btn: { padding: "2px 7px", fontSize: 11, borderRadius: 5, cursor: "pointer", background: "transparent", border: "1px solid var(--dsw-alias-border-l4, #3a414b)", color: "inherit" },
  btnOn: { background: "rgba(45,108,223,.18)", borderColor: "rgba(45,108,223,.5)" },
  saveBtn: { padding: "3px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer", background: "transparent", border: "1px solid var(--dsw-alias-border-l4, #3a414b)", color: "inherit" },
  saveBtnDirty: { background: "rgba(45,108,223,.2)", borderColor: "#2d6cdf" },
  error: { padding: "4px 8px", borderRadius: 6, fontSize: 11, color: "#f85149", background: "rgba(248,81,73,.1)", border: "1px solid rgba(248,81,73,.3)", flex: "none" },
  hint: { padding: 8, fontSize: 12, color: "var(--dsw-alias-label-secondary, #9aa3af)" },
  empty: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--dsw-alias-label-secondary, #9aa3af)", padding: 8 },
  menuScrim: { position: "fixed", inset: 0, zIndex: 96, background: "transparent" },
  menu: { position: "fixed", zIndex: 97, minWidth: 160, padding: 4, borderRadius: 8, background: "#2b2f36", border: "1px solid rgba(0,0,0,.35)", boxShadow: "0 8px 24px rgba(0,0,0,.35)" },
  menuItem: { display: "block", width: "100%", padding: "6px 9px", background: "transparent", border: 0, color: "#e6e8eb", fontSize: 12, textAlign: "left", borderRadius: 4, cursor: "pointer" },
  menuDivider: { height: 1, margin: "4px 6px", background: "rgba(255,255,255,.12)" }
};
