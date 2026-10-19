/**
 * 行号行日志（line journal）
 *
 * 每个 SSH 会话额外挂一份「行号化的可读行」，解决三件事：
 *   1. 智能体按「行号区间」读取输出，而不是按字节偏移猜；
 *   2. 命令台账（`command-ledger.js`）用行号区间标注一条命令的产出范围；
 *   3. 客户端「行号视图」直接渲染它。
 *
 * 三条硬性语义（计划 5.4，用户 Q1 已定）：
 *   - **行号单调递增、永不复用**：淘汰旧行只推进 `firstLine`，已发出的行号
 *     不会再指向别的行 —— 否则智能体拿着旧行号会读到别人的输出。
 *   - **双上限**：`maxLines = 2000`（用户指定）+ `maxBytes = 512 KiB` 字节安全阀
 *     （超长行场景先到先淘汰）。淘汰发生时 `truncated`/`evicted` 为真，调用方
 *     必须把「早于 firstLine 的内容已丢失」明确告诉用户。
 *   - **行内容与终端所见一致**：ANSI 解析直接复用 `terminal-text.js` 的
 *     `LineBuffer` + `createLineScanner`，不另写一套（两份必然漂移）；扫描器负责把
 *     跨 chunk 的转义序列拼回来。
 *
 * 只有被 `\n` **提交**的行才算数：行内重绘（回车覆写、退格、`CSI n K/G`）就地
 * 更新尚未提交的那一行，因此提示符重画不会产生几十行垃圾。未提交的半行通过
 * `pendingText()` 暴露，不参与行号与区间计算 —— 命令区间需要一个确定的上界。
 */
import { LineBuffer, createLineScanner } from "./terminal-text.js";

// 行号渲染规则住在 line-number.js（纯函数、无 Node 依赖），客户端也引用它；
// 这里原样再导出，宿主端与测试只认这一处入口。
export {
  LINE_NUMBER_MIN_WIDTH,
  LINE_NUMBER_SEPARATOR,
  formatLineNumber,
  formatNumberedLines
} from "./line-number.js";

/** 每会话保留的最大行数（计划 5.7 / Q1：2000）。 */
export const DEFAULT_MAX_LINES = 2000;
/** 每会话保留的最大字节数（字节安全阀）。 */
export const DEFAULT_MAX_BYTES = 512 * 1024;
/** 单次读取默认返回的字节上限。 */
export const DEFAULT_READ_MAX_BYTES = 64 * 1024;

/** 按 UTF-8 字节上限截断一段文本（不切断多字节字符）。 */
function truncateToBytes(text, limit) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return { text, bytes: bytes.length, cut: false };
  let end = Math.max(0, limit);
  // 不要留下半个 UTF-8 码点。
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  const sliced = bytes.subarray(0, end).toString("utf8");
  return { text: sliced, bytes: Buffer.byteLength(sliced, "utf8"), cut: true };
}

/** 只把「已提交的行」交给 journal 的行缓冲。 */
class CommitBuffer extends LineBuffer {
  constructor(onCommit) {
    super();
    this.onCommit = onCommit;
  }

  newline() {
    const text = this.chars.join("").replace(/\s+$/, "");
    this.chars = [];
    this.cursor = 0;
    this.onCommit(text);
  }
}

/**
 * 建一份行号行日志。
 * @param {{maxLines?: number, maxBytes?: number}} [options]
 */
export function createLineJournal({
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES
} = {}) {
  const lineLimit = Number.isSafeInteger(maxLines) && maxLines > 0 ? maxLines : DEFAULT_MAX_LINES;
  const byteLimit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;

  /** @type {Array<{line: number, text: string, bytes: number, keepalive?: true}>} */
  const lines = [];
  let bytes = 0;
  let nextNumber = 1;
  let evictedCount = 0;
  /** 单行自身超限被截断过（与「旧行被淘汰」是两回事，但对调用方都是 truncated）。 */
  let lineTruncated = false;
  /** 下一次提交要打的标记（由 appendKeepalive 设置，commit 提交时消费并清空）。 */
  let pendingTag = null;

  function trim() {
    while ((lines.length > lineLimit || bytes > byteLimit) && lines.length > 1) {
      const gone = lines.shift();
      bytes -= gone.bytes;
      evictedCount += 1;
    }
  }

  function commit(rawText) {
    const sized = truncateToBytes(rawText, byteLimit);
    if (sized.cut) lineTruncated = true;
    // 保活字符串会出现在终端画面上，所以**照实记录**（不掩盖事实），但要打标记：
    // 计划 5.8 要求 `keepalive: true`，供日志页签警示色与「不得当成用户命令」的判据。
    const tag = pendingTag;
    pendingTag = null;
    const entry = { line: nextNumber, text: sized.text, bytes: sized.bytes };
    if (tag !== null) entry[tag] = true;
    lines.push(entry);
    nextNumber += 1;
    bytes += sized.bytes;
    trim();
  }

  const buffer = new CommitBuffer(commit);
  // 可续扫描器：把落在 chunk 边界上的转义序列压到下一块再解析（见 terminal-text.js）。
  const scanner = createLineScanner(buffer);

  const firstLine = () => (lines.length === 0 ? nextNumber : lines[0].line);
  const lastLine = () => (lines.length === 0 ? 0 : lines[lines.length - 1].line);

  return {
    /** 喂入一段原始终端输出（与 `appendSessionOutput` 的入参一致）。 */
    append(chunk) {
      // **不要在这里动 pendingTag**：标记的消费交给 commit（它提交行时才用掉）。
      // 早期版本在 append 开头把标记取走并清空，于是「上一次 appendKeepalive 留下的
      // 标记」会被这一次普通 append 吃掉，而 commit 反而拿不到（实测踩到）。
      scanner.push(chunk);
    },

    /**
     * 喂入一段**保活输出**（空闲字符串 / 登录脚本）并给提交出的行打
     * `keepalive: true`（计划 5.8）。
     *
     * 标记与内容**必须在同一次调用里**：分成「先设标记、再喂内容」两步时，只要第一步
     * 传空串（调用方常用它来"只设标记"），标记就会被那一次 append 消耗掉，而真正带
     * 内容的那一次反而没有标记（实测踩到）。
     */
    appendKeepalive(chunk) {
      // 设上标记后交给扫描器；标记由 commit 在**第一次提交行**时消费掉，
      // 所以跨 chunk 的保活输出也能正确落到真正那一行上。
      pendingTag = "keepalive";
      scanner.push(chunk);
    },

    /** 把压着的未完成转义前缀立刻解析掉（会话结束/显式读取前调用）。 */
    flush() {
      scanner.flush();
    },

    /** 直接提交一整行（不给 `\n` 的场景，如内部合成输出；也方便单测）。 */
    appendLine(text) {
      commit(String(text ?? ""));
    },

    /** 下一行将被分配的编号（即 `lastLine + 1`，即使缓冲区为空也成立）。 */
    nextLine() {
      return nextNumber;
    },

    firstLine,
    lastLine,
    /** 当前保留的行数（不含未提交的半行）。 */
    totalLines() {
      return lines.length;
    },

    /** 尚未提交的半行内容（提示符/正在输入的命令）。 */
    pendingText() {
      return buffer.chars.join("");
    },

    /** 保留区的元信息；`evicted` 表示确有旧行丢失。 */
    snapshot() {
      return {
        firstLine: firstLine(),
        lastLine: lastLine(),
        totalLines: lines.length,
        bytes,
        evicted: evictedCount > 0,
        evictedLines: evictedCount,
        truncated: evictedCount > 0 || lineTruncated
      };
    },

    /**
     * 按行号区间读取。
     *
     * - 只给 `tailLines`：取最后 N 行。字节预算不够时**丢最旧的**（tail 语义），
     *   并置 `truncated=true`。
     * - 给 `fromLine`/`toLine`：从 `fromLine` 起按字节预算**向后**返回，`nextLine`
     *   给出继续读取的游标。
     * - 请求起点早于 `firstLine`（内容已被淘汰）：`evicted=true`，返回仍从
     *   `firstLine` 开始 —— 调用方必须明说「更早的行已丢失」。
     */
    read({ fromLine, toLine, tailLines, maxBytes = DEFAULT_READ_MAX_BYTES } = {}) {
      const budget = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_READ_MAX_BYTES;
      const lowest = firstLine();
      const highest = lastLine();
      const empty = lines.length === 0;

      let wantTail = Number.isSafeInteger(tailLines) && tailLines > 0 ? tailLines : undefined;
      let start;
      let end;
      if (wantTail !== undefined) {
        end = highest;
        start = Math.max(lowest, highest - wantTail + 1);
      } else {
        const requestedFrom = Number.isSafeInteger(fromLine) ? fromLine : lowest;
        end = Number.isSafeInteger(toLine) ? toLine : highest;
        start = Math.max(lowest, requestedFrom);
      }
      // 请求的起点早于保留区 ⇒ 中间那段已经丢了。
      const requestedStart = Number.isSafeInteger(fromLine) ? fromLine : (wantTail !== undefined ? start : lowest);
      const evicted = !empty && requestedStart < lowest;
      if (end < start) end = start - 1;

      const window = empty ? [] : lines.filter((entry) => entry.line >= start && entry.line <= end);

      /** @type {Array<{line: number, text: string}>} */
      const picked = [];
      let used = 0;
      let truncated = evicted;

      if (wantTail !== undefined) {
        // tail：从最新往回装，装不下就丢更旧的。
        for (let index = window.length - 1; index >= 0; index -= 1) {
          const entry = window[index];
          if (used + entry.bytes > budget && picked.length > 0) { truncated = true; break; }
          // keepalive 标记要跟着行一起回传：调用方（工具/UI）靠它把保活行与
          // 真实命令输出区分开（计划 5.8 要求「不得当成用户命令」）。
          picked.unshift(entry.keepalive === true
            ? { line: entry.line, text: entry.text, keepalive: true }
            : { line: entry.line, text: entry.text });
          used += entry.bytes;
        }
      } else {
        for (const entry of window) {
          if (used + entry.bytes > budget && picked.length > 0) { truncated = true; break; }
          picked.push(entry.keepalive === true
            ? { line: entry.line, text: entry.text, keepalive: true }
            : { line: entry.line, text: entry.text });
          used += entry.bytes;
        }
      }

      const returnedLast = picked.length === 0 ? end : picked[picked.length - 1].line;
      const hasMore = !empty && returnedLast < highest;
      return {
        lines: picked,
        count: picked.length,
        bytes: used,
        fromLine: picked.length === 0 ? start : picked[0].line,
        toLine: returnedLast,
        firstLine: lowest,
        lastLine: highest,
        totalLines: lines.length,
        // 继续读取的游标（区间模式下用；tail 模式下等于已读到的下一行）。
        nextLine: returnedLast + 1,
        hasMore,
        truncated,
        evicted
      };
    }
  };
}
