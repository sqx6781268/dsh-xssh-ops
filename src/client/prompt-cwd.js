/**
 * 终端提示符里的当前目录解析（用户 2026-10-19/20，2026-10-20 重写为根因修复）。
 *
 * 之前的实现直接对终端行文本跑正则，有两个普遍性缺陷：
 *
 * 1. **OSC 标题序列会污染路径**。很多 shell（zsh 默认、多数发行版 bash 配置）
 *    在提示符前写 `ESC ] 0 ; user@host:~/path BEL` 设置窗口标题。旧正则先匹配
 *    到 OSC 里的 `@host:`，把 `~/path` 连同 OSC 之后的整个提示符一起吃进路径，
 *    得到 `~/path user@host:~/path` 这种脏值 —— 拼绝对路径时必然找不到文件。
 * 2. **`~` 被硬编码成 `/root`**。非 root 用户、或 home 不在 `/root` 的机器全错。
 *
 * 这里的约定：解析结果只做「语法层」的归一（去掉控制序列、取 `~`/`/` 开头的
 * 路径），**不猜测 home 目录**；`~` 保持原样，由调用方用 SFTP 的 home 展开。
 */

/** 允许出现在提示符路径里的字符：排除空白、`#`/`$`/`@`、以及所有控制字符。 */
const PATH_CHARS = /^[^\s#$@\u0000-\u001f\u007f]+$/;

/**
 * 去掉终端控制序列：OSC（`ESC ] … BEL` 或 `ESC ] … ESC \`）、CSI（`ESC [ … 终止符`）、
 * 其余 ESC 序列、以及残留的控制字符。
 * @param text - 终端行原始文本。
 * @returns 纯可见文本。
 */
export function stripTerminalControl(text) {
  const value = String(text ?? "");
  return value
    // OSC：ESC ] ... (BEL | ESC \)
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    // CSI：ESC [ 参数 中间 终止符
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // 其它双字节 ESC 序列
    .replace(/\u001b[@-Z\\-_]/g, "")
    // 残留控制字符（保留 \n，因为解析按行看）
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");
}

/**
 * 从一行（或多行）终端文本里解析提示符路径。
 *
 * 支持常见形态：`user@host:/path# `、`user@host:~/path$ `、`[user@host path]# `（不含 @ 的
 * 形态不解析）、以及 `➜  path` 这类不含 @ 的提示符不解析（宁可解析不到，也不要解析错）。
 *
 * @param text - 终端行原文（可含 OSC/ANSI 序列）。
 * @returns `"/abs/path"`、`"~"`、`"~/rel/path"`，或 null（解析不到/不可信）。
 */
export function parsePromptCwd(text) {
  const clean = stripTerminalControl(text);
  // 只看最后一个非空行：多行文本里早期的提示符是历史，不是当前目录。
  const lines = clean.split(/[\r\n]+/).filter((line) => line.trim() !== "");
  const line = lines.length > 0 ? lines[lines.length - 1] : "";
  if (line === "") return null;

  // `user@host:路径` + `#`/`$` 结尾（允许尾部空白）。
  // 路径字符集排除空白/`#`/`$`/`@`/控制字符，避免再次把后续惩罚文本吃进来。
  const match = /@[^\s:@]+:([^\s#$@]+)[#$]\s*$/.exec(line);
  if (match === null) return null;

  const candidate = match[1].trim();
  if (candidate === "" || candidate.length > 4096) return null;
  if (!PATH_CHARS.test(candidate)) return null;

  if (candidate === "~" || candidate.startsWith("~/")) return candidate;
  if (candidate.startsWith("/")) return candidate;
  return null;
}

/**
 * 把 `~` / `~/x` 按远端 home 展开；绝对路径原样返回。
 * @param path - parsePromptCwd 的结果。
 * @param home - 远端 home 绝对路径（如 `/root`、`/home/me`）。
 * @returns 绝对路径，或 null（`~` 但 home 未知）。
 */
export function expandHome(path, home) {
  if (typeof path !== "string" || path === "") return null;
  if (path.startsWith("/")) return path;
  if (path !== "~" && !path.startsWith("~/")) return null;
  if (typeof home !== "string" || !home.startsWith("/")) return null;
  const suffix = path.slice(1);
  // home 恰好是根目录时，`~` 必须展开成 `/` 而不是空串（`~/x` → `/x`）。
  if (home === "/") return suffix === "" ? "/" : suffix;
  return `${home}${suffix}`;
}
