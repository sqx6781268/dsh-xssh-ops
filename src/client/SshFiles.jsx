/**
 * Remote file manager tab: browse the connected server's filesystem over
 * SFTP, with upload, download, mkdir, delete, and rename actions.
 */
import * as React from "react";
import { MAX_EDITABLE_BYTES, decodeEditableText, encodeEditableText, filterEntries } from "./file-editor.js";
import { formatSize, isImageName, loadViewMode, mimeForName, saveViewMode, typeLabelOf } from "./file-view.js";
import { CodeEditor } from "./CodeEditor.jsx";
import { languageForPath } from "./monaco-loader.js";
import { isFileViewerName, loadFileViewer } from "./file-viewer-loader.js";
import { iconFor } from "./file-icons.js";
import { favoritesKey, readFavorites, writeFavorites, toggleFavorite } from "./sftp-favorites.js";
import { t } from "../i18n/core.js";
const { useEffect, useState } = React;

// 文件页签里的编辑弹层先隐藏（用户 2026-10-19）：编辑统一去「编辑器」页签。
const EDITOR_DIALOG_ENABLED = false;

function joinPath(base, name) {
  if (base === "/") return `/${name}`;
  return `${base.replace(/\/+$/, "")}/${name}`;
}

function dirnameOf(path) {
  if (path === "/") return "/";
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

export function SshFiles({ api, connectionId, onCd, initialPath = "/", onEditFile = null, pendingFile = null, onPendingConsumed = null, followPath = null }) {
  const [cwd, setCwd] = useState("/");
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameTo, setRenameTo] = useState("");
  const [transferMode, setTransferMode] = useState("sftp");
  const [scpReason, setScpReason] = useState("");
  const [scpUploadFile, setScpUploadFile] = useState(null);
  const [scpUploadPath, setScpUploadPath] = useState("");
  const [scpDownloadPath, setScpDownloadPath] = useState("");
  const [filter, setFilter] = useState("");
  const [favorites, setFavorites] = useState([]);
  const [favoritesStorageKey, setFavoritesStorageKey] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  // 视图模式 / 右键菜单 / 图片预览（用户 2026-10-19）。
  const [viewMode, setViewMode] = useState(() => loadViewMode(globalThis.localStorage));
  // 图标模式下用 +/- 调整的图标大小（用户 2026-10-19）。
  const [iconSize, setIconSize] = useState(44);
  const [menu, setMenu] = useState(null);
  const [preview, setPreview] = useState(null);
  // file-viewer 预览（用户 2026-10-19）：Office/PDF/压缩包等交给本地打包的 file-viewer。
  const [viewer, setViewer] = useState(null); // { name, path, status, error, url }
  const viewerRef = React.useRef(null);
  const viewerRootRef = React.useRef(null);
  const [createKind, setCreateKind] = useState("dir");
  // 编辑器弹层：全屏 / 拖动位置 / 尺寸 / 语言 / 编码（用户 2026-10-19）。
  const [editorFull, setEditorFull] = useState(false);
  const [editorPos, setEditorPos] = useState(null);
  const [editorSize, setEditorSize] = useState(null);
  const [editorLanguage, setEditorLanguage] = useState("plaintext");
  const [editorEncoding, setEditorEncoding] = useState("utf-8");
  const editorRef = React.useRef(null);
  const monacoRef = React.useRef(null);
  const dragRef = React.useRef(null);
  // Monotonic sequence: only the latest issued directory listing may commit
  // state, so a slow earlier response cannot overwrite a newer directory.
  const loadSeq = React.useRef(0);
  // Mirror of cwd for post-operation refreshes: a mutation that finishes after
  // the user navigated elsewhere must refresh the NEW directory, not snap back.
  const cwdRef = React.useRef("/");
  // 终端点文件名时要在「load 之后」用最新目录内容查找，所以额外保留一份 entries 快照。
  const entriesRef = React.useRef(null);

  // Favorites are stored per server: the runtime connection id changes every
  // session, so resolve the stable host/port/username key once here.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const value = await api.list();
        if (cancelled) return;
        const connection = (value?.connections ?? []).find((item) => item.connectionId === connectionId);
        const key = favoritesKey(connection);
        setFavoritesStorageKey(key);
        setFavorites(readFavorites(globalThis.localStorage, key));
      } catch {
        // Favorites are cosmetic: a failed lookup simply shows none.
      }
    })();
    return () => { cancelled = true; };
  }, [api, connectionId]);

  const load = async (path) => {
    const seq = ++loadSeq.current;
    setBusy(true);
    setError(null);
    setSelected(null);
    try {
      const value = await api.sftpList(connectionId, path);
      if (seq !== loadSeq.current) return;
      const items = Array.isArray(value?.entries) ? value.entries : [];
      entriesRef.current = items;
      setEntries(items);
      setCwd(value?.path || path);
      cwdRef.current = value?.path || path;
    } catch (err) {
      if (seq !== loadSeq.current) return;
      // SFTP is the normal file manager. Only failure to OPEN its subsystem
      // merits SCP fallback; permission and path errors stay visible as SFTP
      // errors instead of silently changing transfer semantics.
      if (path === "/" && err?.code === "sftp-failed") {
        setTransferMode("scp");
        setScpReason(err.message ?? t("SFTP 子系统不可用"));
        setEntries(null);
        return;
      }
      setError(err?.message ?? String(err));
      setEntries([]);
    } finally {
      if (seq === loadSeq.current) setBusy(false);
    }
  };

  useEffect(() => {
    setTransferMode("sftp");
    setScpReason("");
    setScpUploadFile(null);
    setScpUploadPath("");
    setScpDownloadPath("");
    if (connectionId) load(initialPath);
  }, [connectionId, initialPath]);

  const goUp = () => {
    if (cwd !== "/") load(dirnameOf(cwd));
  };

  const switchView = (mode) => {
    setViewMode(mode);
    saveViewMode(globalThis.localStorage, mode);
  };

  // 图片预览：SFTP 读 bytes → Blob URL；超过 32 MB 直接提示下载。
  const closePreview = () => {
    setPreview((current) => {
      if (current?.url) URL.revokeObjectURL(current.url);
      return null;
    });
  };
  const openPreview = async (entry) => {
    const targetPath = joinPath(cwd, entry.name);
    setPreview({ name: entry.name, path: targetPath, size: entry.size, status: "loading", scale: 1, url: null });
    try {
      const value = await api.sftpReadFile(connectionId, targetPath, 16 * 1024 * 1024);
      const bytes = value?.data ?? new Uint8Array();
      if (bytes.length > 16 * 1024 * 1024) throw new Error(t("图片超过 16 MB，请下载后查看"));
      const blob = new Blob([bytes], { type: mimeForName(entry.name) });
      setPreview((current) => (current && current.path === targetPath
        ? { ...current, status: "ready", url: URL.createObjectURL(blob) }
        : current));
    } catch (error) {
      setPreview((current) => (current && current.path === targetPath
        ? { ...current, status: "error", error: error?.message ?? String(error) }
        : current));
    }
  };

  const closeViewer = () => {
    viewerRootRef.current?.unmount?.();
    viewerRootRef.current = null;
    setViewer((current) => {
      if (current?.url) URL.revokeObjectURL(current.url);
      return null;
    });
  };
  useEffect(() => {
    if (viewer?.status !== "ready" || !viewer.url || !viewerRef.current) return undefined;
    let disposed = false;
    void (async () => {
      try {
        const api = await loadFileViewer();
        if (disposed || !viewerRef.current) return;
        const blob = await (await fetch(viewer.url)).blob();
        const file = new File([blob], viewer.name, { type: mimeForName(viewer.name) });
        // .doc（Word 97 二进制）用 @file-viewer/doc 的独立解析器，其余交给 FileViewer。
        const isDocBinary = viewer.name.toLowerCase().endsWith(".doc");
        if (isDocBinary && typeof api.mountDoc === "function") {
          viewerRootRef.current = await api.mountDoc(viewerRef.current, file);
        } else {
          viewerRootRef.current = api.mount(viewerRef.current, { file, fileName: viewer.name, url: viewer.url });
        }
      } catch (error) {
        setViewer((current) => (current ? { ...current, status: "error", error: error?.message ?? String(error) } : current));
      }
    })();
    return () => { disposed = true; };
  }, [viewer?.status, viewer?.url]);

  const openViewer = async (entry) => {
    const targetPath = joinPath(cwd, entry.name);
    setViewer({ name: entry.name, path: targetPath, status: "loading", url: null });
    try {
      const value = await api.sftpReadFile(connectionId, targetPath, 16 * 1024 * 1024);
      const type = mimeForName(entry.name);
      const url = URL.createObjectURL(new Blob([value?.data ?? new Uint8Array()], { type }));
      setViewer({ name: entry.name, path: targetPath, status: "ready", url });
    } catch (error) {
      setViewer({ name: entry.name, path: targetPath, status: "error", error: error?.message ?? String(error) });
    }
  };

  // 回车/双击的默认动作：目录进入、图片预览、图片/Office 等预览、其他文件下载。
  const openByDefault = (entry) => {
    if (entry.isDirectory) openEntry(entry);
    else if (isImageName(entry.name)) void openPreview(entry);
    else if (isFileViewerName(entry.name)) void openViewer(entry);
    else void openEditor(entry);
  };

  const openEntry = (entry) => {
    if (entry.isDirectory) load(joinPath(cwd, entry.name));
  };

  const download = async (entry) => {
    const target = entry || selected;
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const value = await api.sftpReadFile(connectionId, joinPath(cwd, target.name));
      if (value.truncated) {
        setError(t(`文件超过读取上限（${value.bytes} 字节），已截断——请用对话里的 xsftp_read 指定更大 max_bytes`));
        return;
      }
      // browser download
      const blob = new Blob([value.data], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = target.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const ensureRemoteDir = async (remotePath) => {
    // Build the path one level at a time, ignoring "already exists" errors.
    const parts = remotePath.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current === "" ? `/${part}` : `${current}/${part}`;
      try { await api.sftpMkdir(connectionId, current); } catch {} // ignore if exists
    }
  };

  const upload = async (fileList) => {
    const files = Array.isArray(fileList) ? fileList : [fileList];
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of files) {
        // Preserve relative path for directory uploads (webkitRelativePath).
        const relPath = file.webkitRelativePath || file.name;
        const remotePath = joinPath(cwd, relPath);
        // Ensure the remote directory exists.
        const dirPart = dirnameOf(remotePath);
        if (dirPart !== "/" && dirPart !== cwd) {
          await ensureRemoteDir(dirPart);
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        await api.sftpWriteFile(connectionId, remotePath, bytes);
      }
      load(cwdRef.current);
    } catch (err) {
      setError(t(`上传失败：${err?.message ?? String(err)}`));
    } finally {
      setBusy(false);
    }
  };

  const doCreate = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.sftpMkdir(connectionId, joinPath(cwd, newName.trim()));
      setNewName("");
      setCreating(false);
      load(cwdRef.current);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  // 新建空文件后直接进入编辑器（用户 2026-10-19）。
  const doCreateFile = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const target = joinPath(cwd, newName.trim());
      await api.sftpWriteFile(connectionId, target, new Uint8Array(0));
      const created = { name: newName.trim(), isDirectory: false };
      setNewName("");
      setCreating(false);
      await load(cwdRef.current);
      await openEditor(created);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (entry) => {
    if (!window.confirm(t(`确定删除远程路径 ${joinPath(cwd, entry.name)} ？此操作不可恢复。`))) return;
    setBusy(true);
    setError(null);
    try {
      await api.sftpDelete(connectionId, joinPath(cwd, entry.name));
      setSelected(null);
      load(cwdRef.current);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const doRename = async () => {
    if (!selected || !renameTo.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.sftpRename(connectionId, joinPath(cwd, selected.name), joinPath(cwd, renameTo.trim()));
      setRenameTo("");
      setRenaming(false);
      setSelected(null);
      load(cwdRef.current);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const scpUpload = async () => {
    if (!scpUploadFile || !scpUploadPath.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await scpUploadFile.arrayBuffer());
      await api.scpWriteFile(connectionId, scpUploadPath.trim(), bytes);
      setScpUploadFile(null);
    } catch (err) {
      setError(t(`SCP 上传失败：${err?.message ?? String(err)}`));
    } finally {
      setBusy(false);
    }
  };

  const scpDownload = async () => {
    const path = scpDownloadPath.trim();
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      const value = await api.scpReadFile(connectionId, path);
      if (value.truncated) {
        setError(t(`文件超过读取上限（${value.bytes} 字节），未下载。`));
        return;
      }
      const blob = new Blob([value.data], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = path.split("/").filter(Boolean).at(-1) || "download";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(t(`SCP 下载失败：${err?.message ?? String(err)}`));
    } finally {
      setBusy(false);
    }
  };

  const inputRef = (el) => {
    if (el) {
      el.placeholder = t("选择要上传的文本文件…");
      el.style.display = "none";
    }
  };

  if (transferMode === "scp") {
    return (
      <div style={filesStyles.root}>
        <div style={filesStyles.compatNotice}>
          {t("SFTP 子系统不可用，已切换到 SCP 兼容模式。仅支持单文件上传和下载，需填写远端完整路径。")}
          {scpReason ? <div style={filesStyles.compatDetail}>{scpReason}</div> : null}
        </div>
        {error && <div style={filesStyles.error}>{error}</div>}
        <div style={filesStyles.scpCard}>
          <div style={filesStyles.scpTitle}>{t("上传文件")}</div>
          <input
            type="file"
            onChange={(e) => setScpUploadFile(e.target.files?.[0] ?? null)}
            style={filesStyles.fileInput}
          />
          <input
            value={scpUploadPath}
            onChange={(e) => setScpUploadPath(e.target.value)}
            placeholder={t("远端完整目标路径，例如 /tmp/report.zip")}
            style={filesStyles.input}
          />
          <button onClick={scpUpload} disabled={busy || !scpUploadFile || !scpUploadPath.trim()} style={filesStyles.btnPrimary}>{t("上传")}</button>
        </div>
        <div style={filesStyles.scpCard}>
          <div style={filesStyles.scpTitle}>{t("下载文件")}</div>
          <input
            value={scpDownloadPath}
            onChange={(e) => setScpDownloadPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && scpDownload()}
            placeholder={t("远端完整文件路径，例如 /var/log/app.log")}
            style={filesStyles.input}
          />
          <button onClick={scpDownload} disabled={busy || !scpDownloadPath.trim()} style={filesStyles.btnPrimary}>{t("下载")}</button>
        </div>
      </div>
    );
  }

  const persistFavorites = (next) => {
    setFavorites(next);
    writeFavorites(globalThis.localStorage, favoritesStorageKey, next);
  };
  const pinCurrent = () => persistFavorites(toggleFavorite(favorites, cwd).paths);
  const unpin = (path) => persistFavorites(favorites.filter((item) => item !== path));

  // 提交到会话框（用户 2026-10-19）：把远端文件读成 File，模拟拖放到 DSH 会话输入框，
  // 让它进入会话附件；失败时回退到 DSH 的 file input（同样用 DataTransfer 赋值）。
  const submitToComposer = async (entry) => {
    setBusy(true);
    setError(null);
    try {
      const targetPath = joinPath(cwd, entry.name);
      const value = await api.sftpReadFile(connectionId, targetPath, 16 * 1024 * 1024);
      const bytes = value?.data ?? new Uint8Array();
      if (bytes.length >= 16 * 1024 * 1024) throw new Error(t("文件超过 16 MB，请下载后再添加到对话"));
      const type = mimeForName(entry.name);
      const file = new File([new Blob([bytes], { type })], entry.name, { type, lastModified: entry.mtime ?? Date.now() });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      // DSH 输入框的 DOM 选择器（不是界面文案）：中英文 placeholder 各认一次。
      const zhSelector = 'textarea[placeholder*="描述你想要构建"]'; // i18n-ignore
      const composer = document.querySelector(zhSelector)
        ?? document.querySelector('textarea[placeholder*="Describe what you want to build"]')
        ?? document.querySelector('[contenteditable="true"][role="textbox"]');
      let delivered = false;
      if (composer) {
        composer.focus?.();
        for (const kind of ["dragenter", "dragover", "drop"]) {
          composer.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }));
        }
        delivered = true;
      }
      if (!delivered) {
        const fileInput = [...document.querySelectorAll('input[type="file"]')]
          .find((input) => !input.closest('[class*="dsh-xssh-ops"]'));
        if (fileInput) {
          fileInput.files = transfer.files;
          fileInput.dispatchEvent(new Event("change", { bubbles: true }));
          delivered = true;
        }
      }
      if (!delivered) throw new Error(t("未找到会话输入框，无法添加附件"));
    } catch (error) {
      setError(t(`添加到对话失败：${error?.message ?? String(error)}`));
    } finally {
      setBusy(false);
    }
  };

  // 编辑器工具栏：语言下拉（常见的几种，按扩展名自动识别默认值）。
  const EDITOR_LANGUAGES = [
    ["plaintext", t("纯文本")], ["javascript", "JavaScript"], ["typescript", "TypeScript"],
    ["json", "JSON"], ["markdown", "Markdown"], ["html", "HTML"], ["css", "CSS"],
    ["xml", "XML"], ["yaml", "YAML"], ["shell", "Shell"], ["python", "Python"],
    ["php", "PHP"], ["java", "Java"], ["sql", "SQL"], ["ini", "INI/TOML"]
  ];
  const changeEditorLanguage = (language) => {
    setEditorLanguage(language);
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (editor && monaco) {
      monaco.editor.setModelLanguage(editor.getModel(), language);
    }
  };
  const runEditorFind = () => {
    const editor = editorRef.current;
    if (!editor) { setError(t("编辑器尚未就绪，请稍候再试")); return; }
    editor.focus();
    const action = editor.getAction?.("actions.find");
    if (action) action.run();
    else editor.trigger?.("", "actions.find", null);
  };
  // 编码切换：按新编码重新解码文件（只影响查看；保存仍按 UTF-8 写回）。
  const reloadWithEncoding = async (encoding) => {
    setEditorEncoding(encoding);
    if (!editing) return;
    try {
      const file = await api.sftpReadFile(connectionId, editing.path, 16 * 1024 * 1024);
      const text = new TextDecoder(encoding).decode(file.data);
      setEditing({ ...editing, text, original: text });
      setError(null);
    } catch (error) {
      setError(t(`按 ${encoding.toUpperCase()} 解码失败：${error?.message ?? String(error)}`));
    }
  };
  const handleEditorReady = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
  };
  // 拖动标题栏移动弹层 / 拖右下角调整大小（用户 2026-10-19）。
  const startDrag = (event) => {
    if (editorFull) return;
    const dialog = event.currentTarget.closest("[data-editor-dialog]");
    const rect = dialog?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = { mode: "move", startX: event.clientX, startY: event.clientY, x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    event.preventDefault();
  };
  const startResize = (event) => {
    if (editorFull) return;
    const dialog = event.currentTarget.closest("[data-editor-dialog]");
    const rect = dialog?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = { mode: "resize", startX: event.clientX, startY: event.clientY, x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    event.preventDefault();
  };
  useEffect(() => {
    const onMove = (event) => {
      const state = dragRef.current;
      if (!state) return;
      if (state.mode === "move") {
        setEditorPos({ x: Math.max(0, state.x + event.clientX - state.startX), y: Math.max(0, state.y + event.clientY - state.startY) });
      } else {
        setEditorSize({ w: Math.max(420, state.w + event.clientX - state.startX), h: Math.max(280, state.h + event.clientY - state.startY) });
      }
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  /** Read one remote file into the text editor, refusing binaries and big files. */
  const openEditor = async (entry) => {
    const path = joinPath(cwd, entry.name);
    // 文件页签的编辑动作统一跳转到「编辑器」页签执行（用户 2026-10-19）。
    if (typeof onEditFile === "function") {
      onEditFile(path);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const stat = await api.sftpStat(connectionId, path).catch(() => null);
      if (stat?.size > MAX_EDITABLE_BYTES) {
        setError(t(`文件 ${formatSize(stat.size)} 超过 ${MAX_EDITABLE_BYTES / 1024 / 1024} MB 的编辑上限，请下载后编辑`));
        return;
      }
      const file = await api.sftpReadFile(connectionId, path, MAX_EDITABLE_BYTES + 1);
      const decoded = decodeEditableText(file.data);
      if (!decoded.ok) {
        setError(t(`${entry.name}：${decoded.reason}`));
        return;
      }
      setEditorLanguage(languageForPath(path));
      setEditorEncoding("utf-8");
      setEditing({
        path,
        text: decoded.text,
        original: decoded.text,
        replaced: decoded.replaced,
        bytes: file.data.length,
        mtime: stat?.mtime ?? entry.mtime ?? null
      });
    } catch (err) {
      setError(t(`打开失败：${err?.message ?? String(err)}`));
    } finally {
      setBusy(false);
    }
  };

  const saveEditor = async () => {
    if (!editing) return;
    if (editorEncoding !== "utf-8") {
      setError(t("当前以非 UTF-8 编码查看，保存会按 UTF-8 写回并可能损坏文件；请下载后用本地编辑器修改"));
      return;
    }
    setEditorBusy(true);
    setError(null);
    try {
      // Another program may have rewritten the file since it was opened; a
      // moved mtime asks before the editor's copy wins.
      const fresh = await api.sftpStat(connectionId, editing.path).catch(() => null);
      if (fresh && editing.mtime != null && fresh.mtime !== editing.mtime
        && !globalThis.confirm?.(t("服务器上的文件已被其他程序修改，仍要用编辑器中的内容覆盖吗？"))) {
        return;
      }
      await api.sftpWriteFile(connectionId, editing.path, encodeEditableText(editing.text));
      setEditing(null);
      load(cwdRef.current);
    } catch (err) {
      setError(t(`保存失败：${err?.message ?? String(err)}`));
    } finally {
      setEditorBusy(false);
    }
  };

  const visibleEntries = entries === null ? null : filterEntries(entries, filter);
  // 文件页签跟随终端路径（用户 2026-10-19）：终端 cd 后自动切目录。
  useEffect(() => {
    if (!followPath || typeof followPath !== "string") return;
    if (followPath === cwdRef.current) return;
    void load(followPath);
  }, [followPath]);

  // 终端里点击文件名后打开（用户 2026-10-20）：
  // 直接按**绝对路径**定位，不再依赖终端提示符解析出的 cwd —— 用 xssh_write
  // 跑命令时提示符不会真实刷新，cwd 可能是上一次 cd 留下的旧值，于是会报
  // 「当前目录（旧目录）里没有 该文件」。
  // 做法：先 stat 绝对路径确认存在，再切到它的父目录打开；绝对路径不可用
  // （拿不到 cwd 拼路径）时才退回旧的「切到 cwd 找名字」行为。
  useEffect(() => {
    if (!pendingFile) return;
    const { name, path: absolutePath, cwd: targetCwd } = pendingFile;
    onPendingConsumed?.();
    void (async () => {
      // 候选目录：绝对路径的父目录优先，其次终端 cwd，最后当前目录。
      const candidates = [];
      if (typeof absolutePath === "string" && absolutePath.startsWith("/")) candidates.push(dirnameOf(absolutePath));
      if (targetCwd && !candidates.includes(targetCwd)) candidates.push(targetCwd);
      if (!candidates.includes(cwdRef.current)) candidates.push(cwdRef.current);

      for (const directory of candidates) {
        // 绝对路径可用时先 stat：避免为了一个不存在的猜测目录白跑一次 list。
        if (typeof absolutePath === "string" && absolutePath.startsWith("/")) {
          try {
            const stat = await api.sftpStat(connectionId, absolutePath);
            if (stat === undefined || stat === null) continue;
          } catch { continue; }
        }
        if (directory !== cwdRef.current) await load(directory);
        const entry = (entriesRef.current ?? []).find((item) => item.name === name);
        if (!entry) continue;
        if (entry.isDirectory) openEntry(entry);
        else if (isImageName(entry.name)) void openPreview(entry);
        else if (isFileViewerName(entry.name)) void openViewer(entry);
        else void openEditor(entry);
        return;
      }
      setError(t(`没找到 ${name}（已尝试：${candidates.join(", ")}）`));
    })();
  }, [pendingFile]);

  const isRoot = cwd === "/";
  const goParent = () => { if (!isRoot) load(dirnameOf(cwd)); };
  const openContextMenu = (event, entry) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, entry });
  };
  const beginRename = (entry) => {
    setSelected(entry);
    setRenameTo(entry.name);
    setRenaming(true);
  };
  // 菜单项按右键对象动态生成（用户 2026-10-19）：空白 / 目录 / 文件 / 图片。
  const menuItemsFor = (entry) => {
    if (entry === null) {
      return [
        { label: t("新建目录"), run: () => { setCreateKind("dir"); setCreating(true); } },
        { label: t("新建文件"), run: () => { setCreateKind("file"); setCreating(true); } },
        { label: t("上传文件…"), run: () => inputRef.current?.click() },
        { label: t("刷新"), run: () => void load(cwd) }
      ];
    }
    if (entry.isDirectory) {
      return [
        { label: t("打开"), run: () => openEntry(entry) },
        { label: t("上传到此处"), run: () => inputRef.current?.click() },
        { label: t("重命名"), run: () => beginRename(entry) },
        { label: t("删除"), run: () => void doDelete(entry) }
      ];
    }
    const items = [];
    if (isImageName(entry.name)) items.push({ label: t("预览"), run: () => void openPreview(entry) });
    else if (isFileViewerName(entry.name)) items.push({ label: t("预览"), run: () => void openViewer(entry) });
    items.push({ label: t("编辑"), run: () => void openEditor(entry) });
    items.push({ label: t("提交到会话框"), run: () => void submitToComposer(entry) });
    items.push({ label: t("下载"), run: () => void download(entry) });
    items.push({ label: t("重命名"), run: () => beginRename(entry) });
    items.push({ label: t("删除"), run: () => void doDelete(entry) });
    return items;
  };

  return (
    <div style={filesStyles.root}>
      <div style={filesStyles.toolbar}>
        <button onClick={goUp} disabled={cwd === "/"} style={filesStyles.btn} title={t("上级目录")}>↑</button>
        <span style={filesStyles.path} title={cwd}>{cwd}</span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("过滤")}
          title={t("按名称过滤当前目录")}
          aria-label={t("按名称过滤当前目录")}
          style={filesStyles.filterInput}
        />
        <button
          onClick={pinCurrent}
          style={filesStyles.btn}
          title={favorites.includes(cwd) ? t("取消收藏当前目录") : t("收藏当前目录")}
          aria-label={favorites.includes(cwd) ? t("取消收藏当前目录") : t("收藏当前目录")}
        >{favorites.includes(cwd) ? "★" : "☆"}</button>
        <button onClick={() => setCreating(!creating)} style={filesStyles.btn} title={t("新建目录")}>{t("＋")}</button>
        <label style={filesStyles.btn} title={t("上传文件（可多选）")}>{t("上传")}<input
            ref={inputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              const files = e.target.files;
              if (files && files.length > 0) upload([...files]);
              e.target.value = "";
            }}
          />
        </label>
        <button onClick={() => load(cwd)} disabled={busy} style={filesStyles.btn} title={t("刷新")}>↻</button>
        <span style={filesStyles.viewSwitch}>
          {[
            ["list", "☰", t("列表视图")],
            ["icons", "▦", t("图标视图")],
            ["details", "▥", t("详细视图")]
          ].map(([mode, glyph, title]) => (
            <button
              key={mode}
              type="button"
              onClick={() => switchView(mode)}
              title={title}
              aria-label={title}
              aria-pressed={viewMode === mode}
              style={{ ...filesStyles.viewBtn, ...(viewMode === mode ? filesStyles.viewBtnActive : {}) }}
            >{glyph}</button>
          ))}
        </span>
        {viewMode === "icons" && (
          <span style={filesStyles.iconSizeControls}>
            <button type="button" style={filesStyles.viewBtn} title={t("缩小图标")} onClick={() => setIconSize((value) => Math.max(24, value - 8))}>−</button>
            <button type="button" style={filesStyles.viewBtn} title={t("放大图标")} onClick={() => setIconSize((value) => Math.min(96, value + 8))}>+</button>
          </span>
        )}
      </div>

      {favorites.length > 0 && (
        <div style={filesStyles.favorites}>
          {favorites.map((path) => (
            <span key={path} style={filesStyles.favoriteChip}>
              <button type="button" onClick={() => load(path)} style={filesStyles.favoritePath} title={t(`进入 ${path}`)}>{path}</button>
              <button type="button" onClick={() => unpin(path)} style={filesStyles.favoriteRemove} title={t(`取消收藏 ${path}`)}>×</button>
            </span>
          ))}
        </div>
      )}

      {creating && (
        <div style={filesStyles.inlineForm}>
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              if (createKind === "file") void doCreateFile();
              else void doCreate();
            }}
            placeholder={createKind === "file" ? t("新文件名（含扩展名）") : t("新目录名")}
            style={filesStyles.input}
          />
          <button
            onClick={() => { if (createKind === "file") void doCreateFile(); else void doCreate(); }}
            disabled={busy || !newName.trim()}
            style={filesStyles.btnPrimary}
          >{createKind === "file" ? t("创建并编辑") : t("创建")}</button>
          <button onClick={() => setCreating(false)} style={filesStyles.btn}>{t("取消")}</button>
        </div>
      )}

      {error && <div style={filesStyles.error}>{error}</div>}

      {renaming && selected && (
        <div style={filesStyles.inlineForm}>
          <input
            autoFocus
            value={renameTo}
            onChange={(e) => setRenameTo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doRename()}
            placeholder={selected.name}
            style={filesStyles.input}
          />
          <button onClick={doRename} disabled={busy || !renameTo.trim()} style={filesStyles.btnPrimary}>{t("改名")}</button>
          <button onClick={() => setRenaming(false)} style={filesStyles.btn}>{t("取消")}</button>
        </div>
      )}

      <div
        style={{ ...filesStyles.list, ...(dragActive ? filesStyles.listDrop : {}) }}
        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          const files = [...(e.dataTransfer?.files ?? [])];
          if (files.length > 0) upload(files);
        }}
        onContextMenu={(event) => openContextMenu(event, null)}
      >
        {dragActive && <div style={filesStyles.dropHint}>{t(`松开鼠标：上传到 ${cwd}`)}</div>}
        {!entries || entries.length === 0 ? (
          <div style={filesStyles.empty}>{busy ? t("加载中…") : (entries && entries.length === 0 ? t("（空目录，可拖入文件上传）") : t("请连接服务器"))}</div>
        ) : visibleEntries.length === 0 ? (
          <div style={filesStyles.empty}>{t("（无匹配项）")}</div>
        ) : viewMode === "details" ? (
          <div style={filesStyles.detailsWrap}>
            <div style={filesStyles.detailsHead}>
              <span style={filesStyles.detailsName}>{t("名称")}</span>
              <span style={filesStyles.detailsType}>{t("类型")}</span>
              <span style={filesStyles.detailsSize}>{t("大小")}</span>
              <span style={filesStyles.detailsTime}>{t("修改时间")}</span>
            </div>
            <div
              style={{ ...filesStyles.detailsRow, ...(isRoot ? filesStyles.rowDisabled : {}) }}
              onClick={() => goParent()}
              onDoubleClick={() => goParent()}
              title={isRoot ? t("已在根目录") : t("返回上一层")}
            >
              <span style={filesStyles.detailsName}>../</span>
              <span style={filesStyles.detailsType}>{t("目录")}</span>
              <span style={filesStyles.detailsSize}>—</span>
              <span style={filesStyles.detailsTime}>—</span>
            </div>
            {visibleEntries.map((entry) => (
              <div
                key={entry.name}
                style={{ ...filesStyles.detailsRow, ...(selected?.name === entry.name ? filesStyles.rowSelected : {}) }}
                onClick={() => setSelected(entry)}
                onDoubleClick={() => openByDefault(entry)}
                onContextMenu={(event) => openContextMenu(event, entry)}
                title={entry.isDirectory ? t(`${entry.name}（双击打开）`) : t(`${entry.name}（${formatSize(entry.size)}，双击打开）`)}
              >
                <span style={filesStyles.detailsName}><span style={{ marginRight: 4 }}>{iconFor(entry.name, entry.isDirectory)}</span>{entry.name}</span>
                <span style={filesStyles.detailsType}>{t(typeLabelOf(entry))}</span>
                <span style={filesStyles.detailsSize}>{entry.isDirectory ? "—" : formatSize(entry.size)}</span>
                <span style={filesStyles.detailsTime}>{entry.mtime ? new Date(entry.mtime).toLocaleString() : "—"}</span>
              </div>
            ))}
          </div>
        ) : viewMode === "list" ? (
          <>
            <div
              style={{ ...filesStyles.row, ...(isRoot ? filesStyles.rowDisabled : {}) }}
              onClick={() => goParent()}
              onDoubleClick={() => goParent()}
              title={isRoot ? t("已在根目录") : t("返回上一层")}
            >
              <span style={filesStyles.icon}>⬆</span>
              <span style={filesStyles.rowName}>../</span>
            </div>
            {visibleEntries.map((entry) => (
              <div
                key={entry.name}
                style={{ ...filesStyles.row, ...(selected?.name === entry.name ? filesStyles.rowSelected : {}) }}
                onClick={() => setSelected(entry)}
                onDoubleClick={() => openByDefault(entry)}
                onContextMenu={(event) => openContextMenu(event, entry)}
                title={entry.isDirectory ? t(`${entry.name}（双击打开）`) : t(`${entry.name}（${formatSize(entry.size)}，双击打开）`)}
              >
                <span style={filesStyles.icon}>
                  {entry.isDirectory
                    ? React.createElement("svg", { width: 16, height: 14, viewBox: "0 0 16 14", fill: "none" },
                        React.createElement("path", { d: "M1 3C1 2.4 1.4 2 2 2H6L7.5 4H14C14.6 4 15 4.4 15 5V12C15 12.6 14.6 13 14 13H2C1.4 13 1 12.6 1 12V3Z", fill: "#e8c547" }))
                    : React.createElement("svg", { width: 14, height: 16, viewBox: "0 0 14 16", fill: "none" },
                        React.createElement("path", { d: "M2 1H9L13 5V14C13 14.6 12.6 15 12 15H2C1.4 15 1 14.6 1 14V2C1 1.4 1.4 1 2 1Z", fill: "#c8ccd1" }),
                        React.createElement("path", { d: "M9 1L13 5H10C9.4 5 9 4.6 9 4V1Z", fill: "#8b93a1" }))}
                </span>
                <span style={filesStyles.rowName}>{entry.name}</span>
                {!entry.isDirectory && <span style={filesStyles.rowSize}>{formatSize(entry.size)}</span>}
                {selected?.name === entry.name && (
                  <span style={filesStyles.rowActions} onClick={(e) => e.stopPropagation()}>
                    {entry.isDirectory && onCd && (
                      <button onClick={() => onCd(joinPath(cwd, entry.name))} disabled={busy} style={filesStyles.btnTiny} title={t("在右侧终端 cd 到此目录")} aria-label={t(`在终端 cd 到 ${joinPath(cwd, entry.name)}`)}>cd</button>
                    )}
                    {!entry.isDirectory && (
                      <button onClick={() => void openEditor(entry)} disabled={busy} style={filesStyles.btnTiny} title={t("在文本编辑器中打开（上限 10 MB）")}>{t("编辑")}</button>
                    )}
                    <button onClick={() => void download(entry)} disabled={busy} style={filesStyles.btnTiny}>{t("下载")}</button>
                    <button onClick={() => beginRename(entry)} style={filesStyles.btnTiny}>{t("改名")}</button>
                    <button onClick={() => void doDelete(entry)} disabled={busy} style={filesStyles.btnDanger}>{t("删除")}</button>
                  </span>
                )}
              </div>
            ))}
          </>
        ) : (
          <div style={{ ...filesStyles.grid, gridTemplateColumns: `repeat(auto-fill, minmax(${iconSize + 56}px, 1fr))` }}>
            <div
              style={{ ...filesStyles.gridCard, ...(isRoot ? filesStyles.rowDisabled : {}) }}
              onClick={() => goParent()}
              onDoubleClick={() => goParent()}
              title={isRoot ? t("已在根目录") : t("返回上一层")}
            >
              <span style={filesStyles.gridIconUpload}>⬆</span>
              <span style={filesStyles.gridName}>../</span>
            </div>
            {visibleEntries.map((entry) => (
              <div
                key={entry.name}
                style={{ ...filesStyles.gridCard, ...(selected?.name === entry.name ? filesStyles.rowSelected : {}) }}
                onClick={() => setSelected(entry)}
                onDoubleClick={() => openByDefault(entry)}
                onContextMenu={(event) => openContextMenu(event, entry)}
                title={entry.isDirectory ? t(`${entry.name}（双击打开）`) : t(`${entry.name}（${formatSize(entry.size)}，双击打开）`)}
              >
                <span style={{ fontSize: iconSize, lineHeight: 1 }}>{iconFor(entry.name, entry.isDirectory)}</span>
                <span style={filesStyles.gridName}>{entry.name}</span>
                <span style={filesStyles.gridMeta}>{entry.isDirectory ? t("目录") : formatSize(entry.size)}</span>
              </div>
            ))}
          </div>
        )}
        {viewMode === "icons" && selected !== null && (
          <div style={filesStyles.selectionBar} title={selected.name}>{t("已选：")}{selected.name}</div>
        )}
      </div>

      {menu !== null && (
        <>
          <div style={filesStyles.menuScrim} onMouseDown={() => setMenu(null)} onContextMenu={(event) => { event.preventDefault(); setMenu(null); }} />
          <div
            style={{ ...filesStyles.menu, left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 280) }}
            onMouseDown={(event) => event.stopPropagation()}
            role="menu"
          >
            {menuItemsFor(menu.entry).map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                style={filesStyles.menuItem}
                onClick={() => { setMenu(null); item.run(); }}
              >{item.label}</button>
            ))}
          </div>
        </>
      )}

      {preview !== null && (
        <div style={filesStyles.previewBackdrop} onMouseDown={closePreview}>
          <div style={filesStyles.previewDialog} onMouseDown={(event) => event.stopPropagation()}>
            <div style={filesStyles.previewHead}>
              <span style={filesStyles.previewTitle} title={preview.path}>{preview.name}</span>
              <span style={filesStyles.previewMeta}>{formatSize(preview.size)}</span>
              <span style={{ flex: 1 }} />
              <button type="button" style={filesStyles.btnTiny} onClick={() => setPreview({ ...preview, scale: Math.max(0.25, Math.round((preview.scale - 0.25) * 100) / 100) })} title={t("缩小")}>−</button>
              <span style={filesStyles.previewScale}>{Math.round(preview.scale * 100)}%</span>
              <button type="button" style={filesStyles.btnTiny} onClick={() => setPreview({ ...preview, scale: Math.min(4, Math.round((preview.scale + 0.25) * 100) / 100) })} title={t("放大")}>＋</button>
              <button type="button" style={filesStyles.btnTiny} onClick={() => setPreview({ ...preview, scale: 1 })} title={t("适应窗口")}>{t("适应")}</button>
              <button
                type="button"
                style={filesStyles.btnTiny}
                onClick={() => {
                  const target = (entries ?? []).find((item) => item.name === preview.name);
                  if (target) void download(target);
                }}
              >{t("下载原图")}</button>
              <button type="button" style={filesStyles.btnTiny} onClick={closePreview}>{t("关闭")}</button>
            </div>
            {preview.status === "loading" && <div style={filesStyles.previewHint}>{t("图片加载中…")}</div>}
            {preview.status === "error" && (
              <div style={filesStyles.previewHint}>
                <div>{t(`图片加载失败：${preview.error}`)}</div>
                <button
                  type="button"
                  style={{ ...filesStyles.btnTiny, marginTop: 8 }}
                  onClick={() => {
                    const target = (entries ?? []).find((item) => item.name === preview.name);
                    if (target) void download(target);
                  }}
                >{t("下载原图")}</button>
              </div>
            )}
            {preview.status === "ready" && (
              <div style={filesStyles.previewStage}>
                <img src={preview.url} alt={preview.name} style={{ ...filesStyles.previewImage, transform: `scale(${preview.scale})` }} />
              </div>
            )}
          </div>
        </div>
      )}

      {viewer !== null && (
        <div style={filesStyles.previewBackdrop} onMouseDown={closeViewer}>
          <div style={{ ...filesStyles.previewDialog, width: "min(94vw, 1200px)" }} onMouseDown={(event) => event.stopPropagation()}>
            <div style={filesStyles.previewHead}>
              <span style={filesStyles.previewTitle} title={viewer.path}>{viewer.name}</span>
              <span style={{ flex: 1 }} />
              <button type="button" style={filesStyles.btnTiny} onClick={closeViewer}>{t("关闭")}</button>
            </div>
            {viewer.status === "loading" && <div style={filesStyles.previewHint}>{t("加载中…")}</div>}
            {viewer.status === "error" && <div style={filesStyles.previewHint}>{t(`预览失败：${viewer.error}`)}</div>}
            {viewer.status === "ready" && <div ref={viewerRef} style={{ flex: 1, minHeight: 0, overflow: "auto" }} />}
          </div>
        </div>
      )}

      {EDITOR_DIALOG_ENABLED && editing && (
        <div style={filesStyles.editorBackdrop}>
          <div
            data-editor-dialog
            style={{
              ...filesStyles.editorDialog,
              ...(editorFull ? { position: "fixed", left: 8, top: 8, right: 8, bottom: 8, width: "auto", height: "auto", maxWidth: "none", maxHeight: "none" } : {}),
              ...(!editorFull && editorPos ? { position: "fixed", left: editorPos.x, top: editorPos.y, margin: 0 } : {}),
              ...(!editorFull && editorSize ? { width: editorSize.w, height: editorSize.h, maxWidth: "none", maxHeight: "none" } : {})
            }}
          >
            <div style={filesStyles.editorBar} onMouseDown={startDrag} title={t("拖动标题栏可移动窗口")}>
              <span style={filesStyles.editorTitle} title={editing.path}>{t(`编辑：${editing.path}`)}</span>
              <button type="button" style={filesStyles.btnTiny} onClick={runEditorFind} title={t("查找（Ctrl+F）")}>{t("查找")}</button>
              <select
                value={editorLanguage}
                onChange={(event) => changeEditorLanguage(event.target.value)}
                style={filesStyles.editorSelect}
                title={t("语法高亮语言")}
                aria-label={t("选择语言")}
              >
                {EDITOR_LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <select
                value={editorEncoding}
                onChange={(event) => void reloadWithEncoding(event.target.value)}
                style={filesStyles.editorSelect}
                title={t("文件编码（保存仍按 UTF-8 写回）")}
                aria-label={t("选择编码")}
              >
                <option value="utf-8">UTF-8</option>
                <option value="gbk">GBK（仅解码）</option>
                <option value="gb18030">GB18030（仅解码）</option>
              </select>
              <button type="button" style={filesStyles.btnTiny} onClick={() => setEditorFull((value) => !value)} title={t("全屏")}>{editorFull ? t("还原") : t("全屏")}</button>
              <button type="button" style={filesStyles.btnTiny} onClick={() => { setEditing(null); setEditorFull(false); setEditorPos(null); setEditorSize(null); }}>{t("关闭")}</button>
            </div>
            <div style={filesStyles.editorMeta}>
              {formatSize(editing.bytes)} · {editorEncoding.toUpperCase()}
              {editing.replaced ? t(" · 含无法按 UTF-8 解码的字节（保存会按 UTF-8 重写）") : ""}
              {editing.text !== editing.original ? t(" · 已修改") : ""}
            </div>
            <CodeEditor
              key={`${editing.path}:${editing.original?.length ?? 0}`}
              path={editing.path}
              value={editing.text}
              onChange={(nextText) => setEditing({ ...editing, text: nextText })}
              onReady={handleEditorReady}
              theme={globalThis.document?.documentElement?.getAttribute("data-ds-dark-theme") === null ? "light" : "dark"}
            />
            <div style={filesStyles.editorActions}>
              <button
                type="button"
                onClick={saveEditor}
                disabled={editorBusy || editing.text === editing.original}
                style={filesStyles.btnPrimary}
              >{editorBusy ? t("保存中…") : t("保存")}</button>
            </div>
            {!editorFull && <div style={filesStyles.editorResize} onMouseDown={startResize} title={t("拖动调整大小")} />}
          </div>
        </div>
      )}
    </div>
  );
}

const filesStyles = {
  // 视图切换（用户 2026-10-19）
  viewSwitch: { display: "inline-flex", gap: 2, marginLeft: 2 },
  viewBtn: { width: 24, height: 22, padding: 0, fontSize: 13, lineHeight: 1, borderRadius: 5, cursor: "pointer", background: "transparent", color: "var(--dsw-alias-label-secondary, #9aa3af)", border: "1px solid transparent" },
  viewBtnActive: { background: "rgba(45,108,223,.18)", color: "var(--dsw-alias-label-primary, #d7dbe2)", borderColor: "rgba(45,108,223,.5)" },
  rowDisabled: { opacity: 0.4, cursor: "default" },
  grid: { display: "grid", gap: 8, padding: 4, alignContent: "start" },
  iconSizeControls: { display: "inline-flex", gap: 2, marginLeft: 2 },
  selectionBar: { flex: "none", padding: "3px 6px", fontSize: 11, borderRadius: 5, background: "rgba(45,108,223,.12)", color: "var(--dsw-alias-label-secondary, #9aa3af)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  gridCard: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "8px 4px", borderRadius: 6, cursor: "pointer", minWidth: 0 },
  gridIconLarge: { width: 40, height: 44, display: "flex", alignItems: "center", justifyContent: "center" },
  gridIconSmall: { width: 20, height: 22, display: "flex", alignItems: "center", justifyContent: "center" },
  gridIconUpload: { width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, opacity: 0.7 },
  gridName: { fontSize: 12, color: "var(--dsw-alias-label-primary, #d7dbe2)", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  gridMeta: { fontSize: 11, color: "var(--dsw-alias-label-secondary, #8b93a1)" },
  detailsWrap: { display: "flex", flexDirection: "column", fontVariantNumeric: "tabular-nums" },
  detailsHead: { display: "grid", gridTemplateColumns: "minmax(0,1fr) 110px 90px 150px", gap: 8, padding: "3px 6px", borderBottom: "1px solid rgba(127,127,127,.25)", fontSize: 11, color: "var(--dsw-alias-label-secondary, #8b93a1)", flex: "none" },
  detailsRow: { display: "grid", gridTemplateColumns: "minmax(0,1fr) 110px 90px 150px", gap: 8, alignItems: "center", padding: "4px 6px", borderRadius: 5, fontSize: 12, cursor: "pointer" },
  detailsName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  detailsType: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dsw-alias-label-secondary, #9aa3af)" },
  detailsSize: { textAlign: "right", color: "var(--dsw-alias-label-secondary, #9aa3af)" },
  detailsTime: { color: "var(--dsw-alias-label-secondary, #9aa3af)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  menuScrim: { position: "fixed", inset: 0, zIndex: 96, background: "transparent" },
  menu: { position: "fixed", zIndex: 97, minWidth: 170, padding: 4, borderRadius: 8, background: "#2b2f36", border: "1px solid rgba(0,0,0,.35)", boxShadow: "0 8px 24px rgba(0,0,0,.35)" },
  menuItem: { display: "block", width: "100%", padding: "6px 9px", background: "transparent", border: 0, color: "#e6e8eb", fontSize: 12, textAlign: "left", borderRadius: 4, cursor: "pointer" },
  previewBackdrop: { position: "fixed", inset: 0, zIndex: 98, background: "rgba(0,0,0,.65)", display: "flex", alignItems: "center", justifyContent: "center" },
  previewDialog: { width: "min(92vw, 1000px)", height: "min(86vh, 720px)", display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 12, background: "var(--dsw-alias-bg-layer-2, #161b21)", border: "1px solid var(--dsw-alias-border-l3, #3a414b)", boxShadow: "0 16px 48px rgba(0,0,0,.5)" },
  previewHead: { display: "flex", alignItems: "center", gap: 6, flex: "none" },
  previewTitle: { fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "40%" },
  previewMeta: { fontSize: 11, color: "var(--dsw-alias-label-secondary, #8b93a1)" },
  previewScale: { fontSize: 11, minWidth: 40, textAlign: "center", color: "var(--dsw-alias-label-secondary, #9aa3af)" },
  previewStage: { flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto" },
  previewImage: { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", transition: "transform .12s ease-out" },
  previewHint: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--dsw-alias-label-secondary, #b9c0ca)" },
  root: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, gap: 6 },
  toolbar: { display: "flex", alignItems: "center", gap: 6, flex: "none" },
  path: { flex: 1, fontSize: 12, color: "var(--dsw-alias-label-secondary, #9aa3af)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "left" },
  btn: {
    background: "var(--dsw-alias-bg-layer-1, transparent)", border: "1px solid var(--dsw-alias-border-l4, #3a414b)", color: "var(--dsw-alias-label-primary, #d7dbe2)",
    borderRadius: 6, padding: "3px 8px", fontSize: 12, cursor: "pointer", flex: "none"
  },
  btnTiny: {
    background: "var(--dsw-alias-bg-layer-1, transparent)", border: "1px solid var(--dsw-alias-border-l4, #3a414b)", color: "var(--dsw-alias-label-primary, #d7dbe2)",
    borderRadius: 6, padding: "2px 8px", fontSize: 12, cursor: "pointer"
  },
  btnPrimary: {
    background: "var(--dsw-alias-button-primary-fill, #2d6cdf)", color: "var(--dsw-alias-label-primary-foreground, #fff)", border: "none", borderRadius: 6,
    padding: "3px 10px", fontSize: 12, cursor: "pointer"
  },
  btnDanger: {
    background: "transparent", border: "1px solid #f85149", color: "#f85149",
    borderRadius: 6, padding: "2px 8px", fontSize: 12, cursor: "pointer"
  },
  inlineForm: { display: "flex", gap: 6, alignItems: "center", flex: "none" },
  input: {
    flex: 1, background: "var(--dsw-alias-bg-layer-1, #101418)", border: "1px solid var(--dsw-alias-border-l4, #2a303a)", borderRadius: 6,
    color: "var(--dsw-alias-label-primary, #d7dbe2)", padding: "4px 8px", fontSize: 12, outline: "none"
  },
  error: {
    padding: "6px 10px", fontSize: 12, color: "#f85149",
    background: "rgba(248,81,73,.1)", border: "1px solid rgba(248,81,73,.3)", borderRadius: 6, flex: "none"
  },
  compatNotice: {
    padding: "8px 10px", fontSize: 12, color: "#f0c36d",
    background: "rgba(240,195,109,.1)", border: "1px solid rgba(240,195,109,.35)", borderRadius: 6, flex: "none"
  },
  compatDetail: { marginTop: 4, color: "var(--dsw-alias-label-secondary, #9aa3af)", wordBreak: "break-word" },
  scpCard: { display: "flex", flexDirection: "column", gap: 8, padding: 10, background: "var(--dsw-alias-bg-layer-1, transparent)", border: "1px solid var(--dsw-alias-border-l3, #2a303a)", borderRadius: 6, flex: "none" },
  scpTitle: { fontSize: 13, color: "var(--dsw-alias-label-primary, #d7dbe2)", fontWeight: 600 },
  fileInput: { fontSize: 12, color: "var(--dsw-alias-label-primary, #c8ccd1)" },
  rowSize: { flex: "none", fontSize: 11, color: "var(--dsw-alias-label-secondary, #8b93a1)" },
  rowActions: { display: "flex", gap: 4, flex: "none", marginLeft: "auto" },
  list: { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 1 },
  row: { display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 6, cursor: "pointer" },
  rowSelected: { background: "rgba(45,108,223,.18)" },
  icon: { flex: "none", fontSize: 13, display: "inline-flex", alignItems: "center" },
  rowName: { flex: 1, fontSize: 13, color: "var(--dsw-alias-label-primary, #d7dbe2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  empty: { margin: "auto", fontSize: 12, color: "var(--dsw-alias-label-secondary, #8b93a1)" },
  filterInput: {
    width: 110, flex: "none", background: "var(--dsw-alias-bg-layer-1, #101418)", border: "1px solid var(--dsw-alias-border-l4, #2a303a)",
    borderRadius: 6, color: "var(--dsw-alias-label-primary, #d7dbe2)", padding: "3px 8px", fontSize: 12, outline: "none"
  },
  favorites: { display: "flex", flexWrap: "wrap", gap: 4, flex: "none" },
  favoriteChip: {
    display: "inline-flex", alignItems: "center", gap: 2, border: "1px solid var(--dsw-alias-border-l4, #2a303a)",
    borderRadius: 999, padding: "1px 2px 1px 8px", background: "var(--dsw-alias-bg-layer-1, transparent)"
  },
  favoritePath: {
    background: "transparent", border: "none", color: "var(--dsw-alias-label-primary, #d7dbe2)", cursor: "pointer",
    fontSize: 11, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: 0
  },
  favoriteRemove: { background: "transparent", border: "none", color: "var(--dsw-alias-label-secondary, #8b93a1)", cursor: "pointer", fontSize: 12, padding: "0 4px" },
  listDrop: { outline: "1px dashed var(--dsw-alias-button-primary-fill, #2d6cdf)", outlineOffset: -4, borderRadius: 6 },
  dropHint: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #8b93a1)", padding: "4px 8px" },
  editorBackdrop: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60
  },
  editorDialog: {
    width: "min(860px, 92vw)", height: "min(640px, 86vh)", display: "flex", flexDirection: "column", gap: 8, padding: 12,
    background: "var(--dsw-alias-bg-layer-2, #171b21)", border: "1px solid var(--dsw-alias-border-l3, #2a303a)", borderRadius: 10
  },
  editorBar: { display: "flex", alignItems: "center", gap: 6, flex: "none", cursor: "move" },
  editorSelect: { fontSize: 11, padding: "2px 4px", borderRadius: 5, background: "var(--dsw-alias-bg-layer-1, #101418)", color: "inherit", border: "1px solid var(--dsw-alias-border-l4, #3a414b)" },
  editorResize: { position: "absolute", right: 0, bottom: 0, width: 16, height: 16, cursor: "nwse-resize", background: "linear-gradient(135deg, transparent 50%, rgba(127,127,127,.5) 50%)" },
  editorTitle: {
    fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary, #d7dbe2)",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
  },
  editorMeta: { fontSize: 11, color: "var(--dsw-alias-label-secondary, #8b93a1)", flex: "none" },
  editorText: {
    flex: 1, minHeight: 0, resize: "none", background: "var(--dsw-alias-bg-layer-1, #101418)", color: "var(--dsw-alias-label-primary, #d7dbe2)",
    border: "1px solid var(--dsw-alias-border-l4, #2a303a)", borderRadius: 6, padding: 10, fontSize: 12, lineHeight: 1.5,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", whiteSpace: "pre", overflow: "auto", outline: "none"
  },
  editorActions: { display: "flex", justifyContent: "flex-end", gap: 8, flex: "none" }
};
