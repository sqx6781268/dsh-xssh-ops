/**
 * 文件页签的视图模式与展示工具（用户 2026-10-19）。
 *
 * 与 React 无关，纯数据/格式化，便于单测：
 *   - 视图模式：list / icons / details（图标模式用 +/- 调大小），记住上次选择；
 *   - 文件大小：统一转为自然语言（KB/MB/GB/TB，保留 1 位小数）；
 *   - 图片与类型判断：给预览、图标、类型列共用。
 */
export const FILE_VIEW_MODES = ["list", "icons", "details"];

const VIEW_STORAGE_KEY = "xssh-ops:files:view";

export function normalizeViewMode(value) {
  // 兼容旧存储：大/小图标合并成 icons（用户 2026-10-19）。
  if (value === "icons-large" || value === "icons-small") return "icons";
  return FILE_VIEW_MODES.includes(value) ? value : "list";
}

/** 读取上次选择的视图；localStorage 不可用时回落到列表视图。 */
export function loadViewMode(storage) {
  try {
    return normalizeViewMode(storage?.getItem(VIEW_STORAGE_KEY));
  } catch {
    return "list";
  }
}

export function saveViewMode(storage, mode) {
  try {
    storage?.setItem(VIEW_STORAGE_KEY, normalizeViewMode(mode));
  } catch {
    // 隐私模式禁用存储时忽略：视图只是偏好，不影响功能。
  }
}

/** 字节 → 自然语言（1.2 KB / 3.5 MB / 1.1 GB）；0 显示 0 B。 */
export function formatSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  if (size < 1024) return `${Math.round(size)} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = size / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);

export function extensionOf(name) {
  const text = String(name ?? "");
  const index = text.lastIndexOf(".");
  return index > 0 ? text.slice(index + 1).toLowerCase() : "";
}

export function isImageName(name) {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

/** 预览用 MIME（与扩展名对应；未知按二进制处理，浏览器仍会尽量识别）。 */
export function mimeForName(name) {
  switch (extensionOf(name)) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "bmp": return "image/bmp";
    case "ico": return "image/x-icon";
    case "avif": return "image/avif";
    default: return "application/octet-stream";
  }
}

/** 详细视图的「类型」列：目录/文件 + 扩展名大写。 */
export function typeLabelOf(entry) {
  // 返回字典键，调用方用 t() 包裹（i18n-ignore 静态检查）。
  if (entry?.isDirectory) return "目录"; // i18n-ignore
  const ext = extensionOf(entry?.name);
  return ext === "" ? "文件" : `文件 · ${ext.toUpperCase()}`; // i18n-ignore
}
