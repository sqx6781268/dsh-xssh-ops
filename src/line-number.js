/**
 * 行号显示规则（纯函数，无 Node 依赖）。
 *
 * 单独成模块的原因：宿主端（`line-journal.js`，用到 Buffer）与浏览器端
 * （`client/LinesView.jsx`）都要渲染行号，而浏览器里没有 Buffer。把规则放在
 * 这里，两边引用同一份 —— 行号格式只允许有一个实现（四位数左补零，Q1 已定）。
 */

/** 行号最小显示宽度（Q1：四位数、左补零）。 */
export const LINE_NUMBER_MIN_WIDTH = 4;
/** 行号与内容之间的分隔符。 */
export const LINE_NUMBER_SEPARATOR = " │ ";

/**
 * 行号显示形态：最小 4 位、左补零；超过 9999 自然变宽（Q11 未定，先按此）。
 * @param {number} line 行号（从 1 开始）
 * @param {number} [minWidth] 最小宽度
 */
export function formatLineNumber(line, minWidth = LINE_NUMBER_MIN_WIDTH) {
  const text = String(line);
  return text.length >= minWidth ? text : text.padStart(minWidth, "0");
}

/**
 * 把行记录渲染成带行号的文本块（`0001 │ 内容`）。
 * @param {Array<{line: number, text: string}>} entries
 * @param {{minWidth?: number, separator?: string}} [options]
 */
export function formatNumberedLines(
  entries,
  { minWidth = LINE_NUMBER_MIN_WIDTH, separator = LINE_NUMBER_SEPARATOR } = {}
) {
  return entries
    .map((entry) => `${formatLineNumber(entry.line, minWidth)}${separator}${entry.text}`)
    .join("\n");
}
