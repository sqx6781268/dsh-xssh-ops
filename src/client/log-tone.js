/**
 * 会话日志行分类（上游 0.4.0 / 用户 2026-10-20）：纯文本启发式，落点在日志
 * 查看器（已剥 ANSI 的整段文本），不与远端程序自带颜色叠加。
 *
 * 规则是"宁可多亮不漏亮"：`0 errors` 这类也会被标成 error 行 —— 这与
 * grep --color 的直觉一致，排障时更愿意看到可疑行被提示。
 */
const ERROR_PATTERN = /\b(?:error|errors|fatal|failed|failure|traceback|exception|segfault|panic)\b|\[err\]/i;
// errno 必须区分大小写：带 i 标志时 E[A-Z]{3,} 会命中 expired 这类普通单词。
const ERRNO_PATTERN = /\bE[A-Z]{3,}\b/;
const WARN_PATTERN = /\b(?:warn|warns|warning|warnings|deprecated|deprecation)\b|\[warn\]/i;

/** 返回 "error" | "warn" | null（null = 普通行）。 */
export function logLineTone(line) {
  const text = String(line ?? "");
  if (text === "") return null;
  if (ERROR_PATTERN.test(text) || ERRNO_PATTERN.test(text)) return "error";
  if (WARN_PATTERN.test(text)) return "warn";
  return null;
}
