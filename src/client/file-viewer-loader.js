/**
 * file-viewer 加载器（用户 2026-10-19）。
 *
 * 与 Monaco 一样由 host 的 /xssh-ops/assets/ 路由提供本地 bundle，首次预览
 * Office/PDF 等格式时才注入；加载失败由调用方显示错误并保留下载入口。
 */
const ASSET_BASE = "/xssh-ops/assets";

let pending = null;

export function loadFileViewer() {
  if (globalThis.xsshFileViewer) return Promise.resolve(globalThis.xsshFileViewer);
  if (pending !== null) return pending;
  pending = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${ASSET_BASE}/file-viewer.min.js`;
    script.async = true;
    script.onload = () => {
      if (globalThis.xsshFileViewer) resolve(globalThis.xsshFileViewer);
      else reject(new Error("file-viewer is not ready"));
    };
    script.onerror = () => reject(new Error("failed to load file-viewer"));
    document.head.appendChild(script);
  }).catch((error) => {
    pending = null;
    throw error;
  });
  return pending;
}

/** 这些扩展名交给 file-viewer 预览（其余仍走编辑器/下载）。 */
const VIEWER_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "epub", "mobi", "azw3",
  "csv", "tsv", "rtf", "pages", "numbers", "key", "dwg", "dxf", "kml", "gpx"
]);

export function isFileViewerName(name) {
  const text = String(name ?? "");
  const index = text.lastIndexOf(".");
  if (index < 0) return false;
  return VIEWER_EXTENSIONS.has(text.slice(index + 1).toLowerCase());
}
