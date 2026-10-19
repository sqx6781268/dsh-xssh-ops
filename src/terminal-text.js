/**
 * Terminal output → readable text.
 *
 * Session logs keep the raw byte stream on purpose (a recording must be
 * faithful), but printing those bytes verbatim shows unreadable debris:
 * escape sequences, and — worse — every line redraw. An interactive shell
 * re-prints its prompt by returning the carriage and erasing the line; a real
 * terminal shows one prompt, a naive viewer shows dozens.
 *
 * So this is a *line-oriented* renderer, not a screen emulator: it honours
 * carriage returns, backspaces, tab stops and "erase in line" (plus horizontal
 * cursor parking), which is what line-shaped output uses, and it removes every
 * other sequence. Cursor up/down, scroll regions and alternate screens are NOT
 * modelled — a full-screen TUI replays approximately, which is the documented
 * trade: readable logs, not pixel-faithful playback.
 */

// CSI with its final byte: parameter bytes, intermediates, then @-~ .
const CSI = /\u001b\[([0-?]*)([ -/]*)([@-~])/y;
// OSC payload up to BEL or ST; the terminator is optional because streams do
// contain markers whose payload runs straight into the next escape, and a
// stranded remnant is exactly the debris this module exists to remove.
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/y;
// Two-character escapes (charset selection, ESC =, ESC >) and ESC ( B.
const SHORT_ESCAPE = /\u001b[@-Z\\-_]|\u001b\([0-9A-Za-z]/y;

/** One line buffer with a cursor, matching how a terminal line behaves. */
export class LineBuffer {
  constructor() {
    this.lines = [];
    this.chars = [];
    this.cursor = 0;
  }

  /** Write text at the cursor, appending and overwriting like a terminal row. */
  write(text) {
    for (const char of Array.from(text)) {
      if (this.cursor >= this.chars.length) {
        while (this.chars.length < this.cursor) this.chars.push(" ");
        this.chars.push(char);
      } else {
        this.chars[this.cursor] = char;
      }
      this.cursor += 1;
    }
  }

  carriageReturn() {
    this.cursor = 0;
  }

  backspace() {
    this.cursor = Math.max(0, this.cursor - 1);
  }

  tab() {
    const next = (Math.floor(this.cursor / 8) + 1) * 8;
    this.write(" ".repeat(next - this.cursor));
  }

  /** CSI n K — 0 (or absent): cursor→end, 1: start→cursor, 2: whole line. */
  eraseInLine(mode) {
    if (mode === 2) {
      this.chars = [];
      this.cursor = 0;
    } else if (mode === 1) {
      this.chars = this.chars.map((char, index) => (index < this.cursor ? " " : char));
    } else {
      this.chars.length = Math.min(this.chars.length, this.cursor);
    }
  }

  /** CSI n G — park the cursor at column n (1-based). */
  column(n) {
    this.cursor = Math.max(0, (Number(n) || 1) - 1);
  }

  newline() {
    this.lines.push(this.chars.join("").replace(/\s+$/, ""));
    this.chars = [];
    this.cursor = 0;
  }

  finish() {
    if (this.chars.length > 0 || this.cursor > 0) this.newline();
    return this.lines.join("\n");
  }
}

/**
 * Feed one chunk of raw terminal output into a line buffer.
 *
 * This is the single escape/cursor scanner in the plugin: `toReadableText`
 * renders a whole recording with it, and `src/line-journal.js` streams live
 * output through it into a numbered journal. Keeping one implementation is
 * deliberate — two copies drift, and a drifted renderer shows text the
 * terminal never showed.
 *
 * @param {LineBuffer} buffer target line buffer
 * @param {string} raw raw terminal bytes decoded as UTF-8
 */
export function feedLineBuffer(buffer, raw) {
  const input = String(raw ?? "");
  let index = 0;
  while (index < input.length) {
    if (input[index] === "\u001b") {
      const rest = input.slice(index);
      OSC.lastIndex = 0;
      const osc = OSC.exec(rest);
      if (osc !== null && osc.index === 0) { index += osc[0].length; continue; }
      CSI.lastIndex = 0;
      const csi = CSI.exec(rest);
      if (csi !== null && csi.index === 0) {
        const first = Number.parseInt(String(csi[1] ?? "").replace(/^[?>!]/, ""), 10);
        const final = csi[3];
        if (final === "K") buffer.eraseInLine(Number.isFinite(first) ? first : 0);
        else if (final === "G") buffer.column(Number.isFinite(first) ? first : 1);
        index += csi[0].length;
        continue;
      }
      SHORT_ESCAPE.lastIndex = 0;
      const short = SHORT_ESCAPE.exec(rest);
      if (short !== null && short.index === 0) { index += short[0].length; continue; }
      index += 1; // a lone ESC carries nothing readable
      continue;
    }

    const char = input[index];
    if (char === "\n") { buffer.newline(); index += 1; continue; }
    if (char === "\r") { buffer.carriageReturn(); index += 1; continue; }
    if (char === "\b") { buffer.backspace(); index += 1; continue; }
    if (char === "\t") { buffer.tab(); index += 1; continue; }
    const code = char.codePointAt(0);
    if (code < 32 || code === 127) { index += 1; continue; }

    // A printable run: take it in one go so the per-character buffer work is
    // paid once per run rather than once per character.
    let end = index;
    while (end < input.length) {
      const next = input[end];
      if (next === "\n" || next === "\r" || next === "\b" || next === "\t" || next === "\u001b") break;
      const nextCode = next.codePointAt(0);
      if (nextCode < 32 || nextCode === 127) break;
      end += 1;
    }
    buffer.write(input.slice(index, end));
    index = end;
  }
}

/**
 * 一段「看起来还没写完」的转义序列前缀。
 *
 * 流式场景里 chunk 边界可能落在转义序列中间（`\x1b[3` | `1m`）。一次性解析没这个
 * 问题，但逐块喂入会把 `\x1b[` 当成短转义吃掉、把剩下的 `1m` 当正文写进行里 ——
 * 实测：`"rld \x1b[3"` + `"1mred\n"` 会渲染成 `hello world [31mred`。所以逐块喂入
 * 必须把「还能被后续字节补全的前缀」压到下一块再解析。
 */
const PENDING_ESCAPE = [
  /^\u001b$/,                      // 孤立的 ESC
  /^\u001b\[[0-?]*[ -/]*$/,        // CSI 参数/中间字节齐了，只缺终止字节
  /^\u001b[()][0-9A-Za-z]?$/,      // ESC ( 0 / ESC ) B 这类字符集选择
  /^\u001b\][^\u0007\u001b\n]*$/   // OSC 还没等到 BEL / ST 终止符
];

/** 未完成前缀的保留上限：超过就说明不是转义序列，当垃圾当场丢弃，避免无界增长。 */
export const MAX_PENDING_ESCAPE = 4096;

/**
 * 找出「最后一段未完成转义序列」的起点，没有则返回 -1。
 * @param {string} text
 */
function incompleteEscapeStart(text) {
  const start = text.lastIndexOf("\u001b");
  if (start < 0) return -1;
  const tail = text.slice(start);
  return PENDING_ESCAPE.some((pattern) => pattern.test(tail)) ? start : -1;
}

/**
 * 给一个行缓冲配一个**可续的**流式扫描器：把跨 chunk 的转义序列拼回来再解析。
 *
 * 这是流式路径的唯一入口（`src/line-journal.js` 用它）；一次性渲染继续走
 * `toReadableText`。两者共享同一个 `feedLineBuffer`，不另写一份解析。
 *
 * @param {LineBuffer} buffer
 */
export function createLineScanner(buffer) {
  let pending = "";
  return {
    /** 喂入一块输出；返回还压着多少字符未解析。 */
    push(chunk) {
      const text = pending + String(chunk ?? "");
      pending = "";
      const start = incompleteEscapeStart(text);
      let head = text;
      if (start >= 0) {
        const tail = text.slice(start);
        if (tail.length <= MAX_PENDING_ESCAPE) {
          head = text.slice(0, start);
          pending = tail;
        }
      }
      if (head.length > 0) feedLineBuffer(buffer, head);
      return { pending: pending.length };
    },

    /** 需要立刻看到残留时调用（会话结束/显式读取前）：把压着的尾巴按原样解析掉。 */
    flush() {
      if (pending.length === 0) return;
      const tail = pending;
      pending = "";
      feedLineBuffer(buffer, tail);
    },

    /** 当前压着的未完成转义前缀（测试/调试用）。 */
    pendingText() {
      return pending;
    }
  };
}

/** One stream of terminal output as readable text. */
export function toReadableText(raw) {
  const buffer = new LineBuffer();
  feedLineBuffer(buffer, raw);
  return buffer.finish();
}

/**
 * Same treatment for one line — used by search hits, which arrive as raw lines
 * straight out of the log file.
 */
export function readableLine(line) {
  return toReadableText(line).trimEnd();
}
