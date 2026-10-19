// Terminal output → readable text: the log viewer and the agent-facing log
// tools must not print escape-sequence debris, while the stored log keeps its
// raw bytes. The fixtures below are real sequences seen in recorded sessions
// (shell-integration markers from a real server, an OSC 7 cwd report, an
// OSC 1337 command, colour codes and bracketed-paste toggles).
import assert from "node:assert/strict";
import { LineBuffer, MAX_PENDING_ESCAPE, createLineScanner, feedLineBuffer, readableLine, toReadableText } from "../src/terminal-text.js";

const ESC = "\u001b";

// ── the debris a real session logs ─────────────────────────────────────────
{
  const raw = [
    "Last login: Fri Sep 18 23:58:06 2026 from 111.180.64.27",
    // BEL-terminated shell-integration markers, exactly as the real server emits them
    `${ESC}]133;C\u0007${ESC}]133;C\u0007${ESC}]133;D;0\u0007${ESC}]1337;Command=c3R0eSAtZWNobw==\u0007${ESC}]7;file://host/root\u0007${ESC}]133;A\u0007`,
    `${ESC}]3008;start=836f28a4;user=root;hostname=iZ2vc;pid=00000000000000148399;type=shell;cwd=/root\u0007${ESC}[?2004h${ESC}]0;root@iZ2vc: ~\u0007`,
    `root@iZ2vc:~# \r${ESC}[K\r${ESC}]0;root@iZ2vc: ~\u0007root@iZ2vc:~# ${ESC}]133;B\u0007`
  ].join("\n");
  const readable = toReadableText(raw);
  assert.match(readable, /Last login: Fri Sep 18 23:58:06 2026 from 111\.180\.64\.27/);
  assert.equal(readable.split("\n").filter((line) => line.startsWith("root@iZ2vc:~#")).length, 1,
    "the redrawn prompt appears once, its markers never do");
  for (const debris of ["]133;", "]1337;", "]3008;", "]7;file:", "?2004h", "[K", ESC]) {
    assert.equal(readable.includes(debris), false, `stripped: ${debris}`);
  }
}

// ── colours, and carriage returns that OVERWRITE (terminal line semantics) ──
{
  const raw = `${ESC}[31merror${ESC}[0m: disk ${ESC}[1mfull${ESC}[0m\n`;
  assert.equal(toReadableText(raw), "error: disk full");

  const progress = "copying 10%\rcopying 50%\rcopying 100%\n";
  assert.equal(toReadableText(progress), "copying 100%", "a progress bar shows its final state, not every frame");

  assert.equal(toReadableText(`first line\r${ESC}[Kreplaced\n`), "replaced", "erase-in-line clears the redraw");
  assert.equal(toReadableText("long content here\rshort"), "shortcontent here",
    "a shorter redraw leaves the tail it never overwrote (no erase was sent)");
}

// ── ST-terminated OSC and split-ish leftovers ──────────────────────────────
{
  assert.equal(toReadableText(`before${ESC}]0;title${ESC}\\after`), "beforeafter");
  assert.equal(toReadableText(`x${ESC}(B y`), "x y", "charset selection is dropped, its text kept");
  assert.equal(toReadableText("plain\tkeeps\ttabs\nand newlines"), "plain   keeps   tabs\nand newlines",
    "tabs advance to the next 8-column stop, as a terminal does");
  assert.equal(toReadableText("nul\u0000byte and \u0007bell"), "nulbyte and bell");
}

// ── the exact prompt-redraw cycle a real bash logs ──────────────────────────
{
  const redraw = "load average: 0.05, 0.10, 0.09\r\n" + Array.from({ length: 12 }, () =>
    `root@iZ2vc27mmzgpr2oszj1kplZ:~# \r${ESC}[K\r${ESC}]0;root@iZ2vc27mmzgpr2oszj1kplZ: ~\u0007root@iZ2vc27mmzgpr2oszj1kplZ:~# ${ESC}]133;B\u0007`
  ).join("");
  assert.deepEqual(toReadableText(redraw).split("\n"), [
    "load average: 0.05, 0.10, 0.09",
    "root@iZ2vc27mmzgpr2oszj1kplZ:~#"
  ], "twelve redraws collapse into one prompt line");
}

// ── readableLine trims only the tail ───────────────────────────────────────
{
  assert.equal(readableLine(`  ${ESC}[32mok${ESC}[0m  `), "  ok", "leading spaces (prompt indentation) stay");
  assert.equal(readableLine(""), "");
  assert.equal(readableLine(null), "");
}

// ── LineBuffer / feedLineBuffer / createLineScanner 的边界 ───────────────
//
// 这三个导出此前只在 line-journal 里被间接用到，没被直接验证过。它们负责「把字节流
// 切成逻辑行」，边界错会让**行号整体偏位**（而行号是其它一切功能的地基）。
{
  // 单条完整行（feedLineBuffer 要真的 LineBuffer；scanner 也接 LineBuffer 实例）
  const buffer = new LineBuffer();
  feedLineBuffer(buffer, "hello");
  assert.equal(buffer.chars.join(""), "hello", "字符按写入顺序累积");
  buffer.newline();
  assert.deepEqual(buffer.lines, ["hello"], "newline() 把当前行提交到 lines");

  // 原地重绘：`\r` + `CSI K` 抹掉回车后的旧内容（提示符重绘的常见形态）
  const redraw = new LineBuffer();
  feedLineBuffer(redraw, "old-text\rabc\u001b[K");
  assert.equal(redraw.chars.join(""), "abc", "回车 + CSI K 后只留新内容（原地重绘）");
  // CSI G 把光标移到指定列，后续写入覆盖该位置
  const positioned = new LineBuffer();
  feedLineBuffer(positioned, "abcdef\u001b[3GXY");
  assert.equal(positioned.chars.join(""), "abXYef", "CSI G 定位后覆盖写入");

  // 跨块：半个转义序列压到下一块再解析（不能吐 ESC 碎片）
  // 注意 `createLineScanner` 接的是 **LineBuffer 实例**，不是回调。
  const scannerBuffer = new LineBuffer();
  const scanner = createLineScanner(scannerBuffer);
  scanner.push(`${ESC}[32m`);
  assert.equal(scannerBuffer.lines.length, 0, "未换行不提交");
  scanner.push("green");
  scanner.push(`${ESC}[0m\n`);
  assert.deepEqual(scannerBuffer.lines, ["green"], "跨块转义被拼接后正确剥离");
  assert.equal(scannerBuffer.lines[0].includes(ESC), false, "输出里不许残留 ESC");

  // 落单的 CSI 前缀（块尾半个转义）要压住、由 flush 收尾，绝不吐碎片
  const pendingBuffer = new LineBuffer();
  const pending = createLineScanner(pendingBuffer);
  pending.push("text");
  pending.push(`${ESC}[`);
  pending.push("1m");
  pending.push("\n");
  assert.deepEqual(pendingBuffer.lines, ["text"], "转义跨块时不得把它当正文");
  assert.equal(pendingBuffer.lines[0].includes(ESC), false, "不得残留 ESC");
  // 未完成转义会被压住（pendingText 可查），不会当正文吐出去
  assert.equal(typeof pending.pendingText(), "string", "可查当前压着的未完成前缀");

  // 超长未完成转义不能无限堆积（MAX_PENDING_ESCAPE 上限）
  const floodBuffer = new LineBuffer();
  const flood = createLineScanner(floodBuffer);
  flood.push(`${ESC}[${"1;".repeat(5000)}`);
  flood.push("\n");
  assert.ok((floodBuffer.lines[0] ?? "").length < 20_000, "超长转义前缀要被截断，不能无界堆积");
  assert.ok(MAX_PENDING_ESCAPE > 0 && Number.isSafeInteger(MAX_PENDING_ESCAPE), "上限是正整数常量");
}

console.log("terminal text: escape debris stripped, prompts and content preserved, line splitting bounded");
