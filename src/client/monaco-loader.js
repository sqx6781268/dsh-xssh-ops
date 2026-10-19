/**
 * Monaco 加载器（用户 2026-10-19）。
 *
 * 插件目录里的文件不能被页面直接请求（/plugins/<id>/... 返回 404），所以由
 * host 的 /xssh-ops/assets/ 路由提供 lib/monaco.min.js 与 monaco.min.css。
 * 前端只在第一次打开编辑器时注入，首屏不承担这 ~2.7MB；加载失败由 CodeEditor
 * 回退到纯文本编辑器。
 */
const ASSET_BASE = "/xssh-ops/assets";

let pending = null;

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`无法加载 ${src}`)) // i18n-ignore;
    document.head.appendChild(script);
  });
}

function injectStyle(href) {
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    // 样式加载失败不阻断编辑器功能（只是缺少高亮配色）。
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.appendChild(link);
  });
}

/** 懒加载 Monaco；并发调用共享同一个 Promise。 */
export function loadMonaco() {
  if (globalThis.xsshMonaco) return Promise.resolve(globalThis.xsshMonaco);
  if (pending !== null) return pending;
  pending = (async () => {
    await injectStyle(`${ASSET_BASE}/monaco.min.css`);
    await injectScript(`${ASSET_BASE}/monaco.min.js`);
    if (!globalThis.xsshMonaco) throw new Error("Monaco 加载后未就绪"); // i18n-ignore
    return globalThis.xsshMonaco;
  })().catch((error) => {
    pending = null;
    throw error;
  });
  return pending;
}

const LANGUAGE_BY_EXT = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", json: "json", jsonc: "json",
  md: "markdown", markdown: "markdown",
  html: "html", htm: "html", xml: "xml", svg: "xml", vue: "html",
  css: "css", scss: "scss", less: "less",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", conf: "ini", cfg: "ini",
  sh: "shell", bash: "shell", zsh: "shell", ksh: "shell",
  py: "python", rb: "ruby", php: "php", java: "java", kt: "kotlin",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp",
  go: "go", rs: "rust", swift: "swift", sql: "sql", lua: "lua", perl: "perl",
  ps1: "powershell", bat: "bat", cmd: "bat", dockerfile: "dockerfile", diff: "diff",
  txt: "plaintext", log: "plaintext", env: "ini"
};

/** 按文件名/扩展名映射 Monaco 语言。 */
export function languageForPath(path) {
  const name = String(path ?? "").split("/").pop() ?? "";
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return "dockerfile";
  if (lower === "makefile") return "makefile";
  const index = lower.lastIndexOf(".");
  if (index < 0) return "plaintext";
  return LANGUAGE_BY_EXT[lower.slice(index + 1)] ?? "plaintext";
}
