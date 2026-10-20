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

/**
 * 无后缀但含义明确的文件名（用户 2026-10-20 用空后缀文件验证图标时发现）。
 * 键一律小写；值是对应类型。加新名字只需在这里加一行。
 */
const NAME_KINDS = new Map([
  // 说明类 → 文本
  ["readme", "text"], ["license", "text"], ["licence", "text"], ["copying", "text"],
  ["changelog", "text"], ["changes", "text"], ["news", "text"], ["authors", "text"],
  ["contributors", "text"], ["notice", "text"], ["todo", "text"], ["install", "text"],
  // 构建/配置类 → 代码
  ["makefile", "code"], ["gnumakefile", "code"], ["dockerfile", "code"], ["containerfile", "code"],
  ["jenkinsfile", "code"], ["vagrantfile", "code"], ["gemfile", "code"], ["rakefile", "code"],
  ["procfile", "code"], ["cmakelists.txt", "code"], ["pkgbuild", "code"], ["brewfile", "code"],
  ["justfile", "code"], ["caddyfile", "code"], ["nginx.conf", "code"],
  // 脚本类（无后缀但通常是可执行脚本）
  ["configure", "code"], ["bootstrap", "code"],
  // 二进制/镜像类
  ["vmlinuz", "binary"], ["initrd", "binary"]
]);

export function iconKindOf(name, isDirectory = false) {
  if (isDirectory) return "folder";
  const text = String(name ?? "");
  const lower = text.toLowerCase();
  const byName = NAME_KINDS.get(lower);
  if (byName !== undefined) return byName;
  // 点开头的是「隐藏文件名」而不是扩展名（.env / .gitignore 这类）：
  // lastIndexOf(".") 对 `.env.example` 会取到 "example"，语义是错的。
  if (lower.startsWith(".") && lower.indexOf(".", 1) < 0) {
    // .gitignore / .dockerignore / .npmrc 等点文件按配置处理
    return lower === ".gitignore" || lower === ".dockerignore" || lower === ".npmignore"
      ? "code"
      : lower === ".env" ? "code" : "file";
  }
  const index = lower.lastIndexOf(".");
  if (index < 0) return "file";
  return KIND_BY_EXT.get(lower.slice(index + 1)) ?? "file";
}

/** 返回 emoji 图标；未知类型回落到普通文件。 */
export function iconFor(name, isDirectory = false) {
  return GLYPHS[iconKindOf(name, isDirectory)] ?? GLYPHS.file;
}
