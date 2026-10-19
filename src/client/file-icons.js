/**
 * 文件类型图标（用户 2026-10-19）：一个类型对应多种后缀，文件页签与编辑器页签共用。
 * 用 emoji 而不是 SVG：跨平台、零资源、按类型扩展只需加一行。
 */
const EXTENSION_KINDS = [
  ["folder", []],
  ["image", ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "tif", "tiff", "heic", "psd"]],
  ["audio", ["mp3", "wav", "flac", "aac", "ogg", "oga", "m4a", "wma", "opus", "mid", "midi", "amr", "aiff"]],
  ["video", ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpeg", "mpg", "ts", "rmvb", "3gp"]],
  ["archive", ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "iso", "cab", "lz", "jar", "war"]],
  ["pdf", ["pdf"]],
  ["word", ["doc", "docx", "odt", "rtf", "pages", "wps", "dot", "dotx"]],
  ["excel", ["xls", "xlsx", "csv", "tsv", "ods", "numbers", "et", "xlsm"]],
  ["ppt", ["ppt", "pptx", "odp", "key", "dps", "pps", "ppsx"]],
  ["code", ["js", "mjs", "cjs", "jsx", "ts", "tsx", "vue", "svelte", "py", "go", "java", "kt", "c", "h", "cpp", "cc", "cxx", "hpp", "cs", "rs", "rb", "php", "swift", "lua", "pl", "r", "scala", "dart", "html", "htm", "css", "scss", "sass", "less", "xml", "json", "jsonc", "yaml", "yml", "toml", "ini", "conf", "cfg", "env", "md", "markdown", "rst", "sql", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "dockerfile", "makefile", "gradle", "properties"]],
  ["log", ["log", "out", "err", "trace", "dump"]],
  ["text", ["txt", "text", "nfo", "readme", "license", "asc"]],
  ["font", ["ttf", "otf", "woff", "woff2", "eot", "fon"]],
  ["database", ["db", "sqlite", "sqlite3", "mdb", "accdb", "dbf", "frm", "ibd", "myd"]],
  ["binary", ["bin", "exe", "dll", "so", "dylib", "o", "a", "obj", "class", "pyc", "apk", "deb", "rpm", "img", "dat"]],
  ["disk", ["vmdk", "vdi", "vhd", "vhdx", "qcow2", "ova"]],
  ["cert", ["pem", "crt", "cer", "key", "p12", "pfx", "csr"]]
];

const KIND_BY_EXT = new Map();
for (const [kind, extensions] of EXTENSION_KINDS) {
  for (const extension of extensions) KIND_BY_EXT.set(extension, kind);
}

const GLYPHS = {
  folder: "📁",
  image: "🖼️",
  audio: "🎵",
  video: "🎬",
  archive: "📦",
  pdf: "📕",
  word: "📘",
  excel: "📗",
  ppt: "📙",
  code: "💻",
  log: "🧾",
  text: "📝",
  font: "🔤",
  database: "🗄️",
  binary: "⚙️",
  disk: "💽",
  cert: "🔑",
  file: "📄"
};

export function iconKindOf(name, isDirectory = false) {
  if (isDirectory) return "folder";
  const text = String(name ?? "");
  const lower = text.toLowerCase();
  if (lower === "dockerfile" || lower === "makefile" || lower === "readme" || lower === "license") {
    return lower === "readme" || lower === "license" ? "text" : "code";
  }
  const index = lower.lastIndexOf(".");
  if (index < 0) return "file";
  return KIND_BY_EXT.get(lower.slice(index + 1)) ?? "file";
}

/** 返回 emoji 图标；未知类型回落到普通文件。 */
export function iconFor(name, isDirectory = false) {
  return GLYPHS[iconKindOf(name, isDirectory)] ?? GLYPHS.file;
}
