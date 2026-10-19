// 行号行日志：行号单调、\n 才提交、行内重绘就地更新、双上限淘汰、区间/tail 读取。
// 关键回归是 Q1 的 2000 行上限与「已发出的行号永不复用」——智能体拿旧行号必须
// 读不到别人的输出，所以淘汰只推进 firstLine，绝不重新编号。
import assert from "node:assert/strict";
import SshOpsService from "../src/index.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  LINE_NUMBER_MIN_WIDTH,
  createLineJournal,
  formatLineNumber,
  formatNumberedLines
} from "../src/line-journal.js";

const ESC = "\u001b";

// ── 默认上限就是用户拍板的数字 ──────────────────────────────────────────────
{
  assert.equal(DEFAULT_MAX_LINES, 2000, "Q1：行缓存上限 2000 行");
  assert.equal(DEFAULT_MAX_BYTES, 512 * 1024, "字节安全阀 512 KiB");
  assert.equal(LINE_NUMBER_MIN_WIDTH, 4, "Q1：行号四位数");
}

// ── 行号显示：四位数左补零，超过 9999 自然变宽 ─────────────────────────────
{
  assert.equal(formatLineNumber(1), "0001");
  assert.equal(formatLineNumber(812), "0812");
  assert.equal(formatLineNumber(9999), "9999");
  assert.equal(formatLineNumber(10000), "10000", "超过 9999 就用得下的宽度，不截断");
  assert.equal(formatNumberedLines([{ line: 1, text: "a" }, { line: 812, text: "b" }]), "0001 │ a\n0812 │ b");
}

// ── \n 提交行；行号从 1 开始、严格递增 ─────────────────────────────────────
{
  const journal = createLineJournal();
  journal.append("a\nb\nc\n");
  assert.equal(journal.totalLines(), 3);
  assert.equal(journal.firstLine(), 1);
  assert.equal(journal.lastLine(), 3);
  assert.equal(journal.nextLine(), 4);

  const tail = journal.read({ tailLines: 3 });
  assert.deepEqual(tail.lines.map((entry) => [entry.line, entry.text]), [[1, "a"], [2, "b"], [3, "c"]]);
  assert.equal(tail.evicted, false);
  assert.equal(tail.truncated, false);
  assert.equal(formatNumberedLines(tail.lines), "0001 │ a\n0002 │ b\n0003 │ c",
    "验收：printf 'a\\nb\\nc\\n' 后形如 `0001 │ a`");
}

// ── 未提交的半行不占行号，也不进区间 ───────────────────────────────────────
{
  const journal = createLineJournal();
  journal.append("done\npartial");
  assert.equal(journal.totalLines(), 1, "没有 \\n 就不算一行");
  assert.equal(journal.lastLine(), 1);
  assert.equal(journal.pendingText(), "partial", "半行可单独取，但不参与区间计算");
  journal.append("\n");
  assert.equal(journal.totalLines(), 2, "补上 \\n 后才提交");
  assert.equal(journal.read({ tailLines: 1 }).lines[0].text, "partial");
}

// ── 行内重绘就地更新：12 次提示符重画只产生一行 ─────────────────────────────
{
  const journal = createLineJournal();
  const redraw = Array.from({ length: 12 }, () =>
    `root@host:~# \r${ESC}[K\r${ESC}]0;root@host: ~\u0007root@host:~# ${ESC}]133;B\u0007`
  ).join("");
  journal.append(redraw);
  journal.append("\nls\n");
  assert.equal(journal.totalLines(), 2, "12 次重画折叠成一行提示符");
  assert.deepEqual(journal.read().lines.map((entry) => entry.text), ["root@host:~#", "ls"]);
}

// ── 进度条/覆写：读到的永远是终态 ─────────────────────────────────────────
{
  const journal = createLineJournal();
  journal.append("copying 10%\rcopying 50%\rcopying 100%\n");
  assert.equal(journal.read().lines[0].text, "copying 100%");

  const erased = createLineJournal();
  erased.append(`first\r${ESC}[Kreplaced\n`);
  assert.equal(erased.read().lines[0].text, "replaced", "CSI n K 擦掉旧内容");
}

// ── 行尾空白裁掉；制表符按终端语义展开 ─────────────────────────────────────
{
  const journal = createLineJournal();
  journal.append("padded   \n");
  assert.equal(journal.read().lines[0].text, "padded");
  const tabs = createLineJournal();
  tabs.append("a\tb\n");
  assert.equal(tabs.read().lines[0].text, "a       b", "制表符推进到下一个 8 列停靠点");
}

// ── 2000 行上限：写 2100 行后 firstLine 前进且 evicted=true（验收 R6-b）───
{
  const journal = createLineJournal();
  for (let line = 1; line <= 2100; line += 1) journal.append(`line ${line}\n`);
  const snap = journal.snapshot();
  assert.equal(snap.totalLines, 2000, "只保留 2000 行");
  assert.equal(snap.firstLine, 101, "最早保留的是第 101 行（1..100 已淘汰）");
  assert.equal(snap.lastLine, 2100);
  assert.equal(snap.evicted, true);
  assert.equal(snap.evictedLines, 100);
  assert.equal(snap.truncated, true);

  // 已淘汰的行号绝不能读到别的行 —— 请求第 1 行必须空手而归并报 evicted，
  // 而不是悄悄把第 101 行当成第 1 行交出去。
  const early = journal.read({ fromLine: 1, toLine: 5 });
  assert.equal(early.evicted, true, "请求起点早于保留区 ⇒ evicted");
  assert.deepEqual(early.lines, [], "被淘汰的区间不给替代内容");
  assert.equal(early.firstLine, 101, "同时告知现在最早可读的是哪一行");
  assert.equal(early.lastLine, 2100);

  // 调用方改用 firstLine 重新请求，就能正常读到。
  const retry = journal.read({ fromLine: early.firstLine, toLine: early.firstLine + 1 });
  assert.deepEqual(retry.lines.map((entry) => entry.line), [101, 102]);
  assert.equal(retry.evicted, false);

  // tail 永远读得到（它从最新往回取），不受淘汰影响。
  assert.equal(journal.read({ tailLines: 1 }).lines[0].line, 2100);

  // 行号永不复用：继续写，编号接着 2101 走。
  journal.append("after\n");
  assert.equal(journal.lastLine(), 2101);
}

// ── 字节阀：超长行先到先淘汰 ───────────────────────────────────────────────
{
  const journal = createLineJournal({ maxLines: 1000, maxBytes: 1000 });
  for (let index = 0; index < 50; index += 1) journal.append(`${"x".repeat(90)}\n`);
  const snap = journal.snapshot();
  assert.ok(snap.bytes <= 1000, `字节数受 1000 限制，实际 ${snap.bytes}`);
  assert.ok(snap.totalLines < 50, "字节阀先于行数阀生效");
  assert.equal(snap.evicted, true);
  assert.equal(snap.firstLine, 50 - snap.totalLines + 1, "淘汰从最旧一行开始");
}

// ── 单行自身超过字节阀：截断保底并标 truncated，不能撑爆内存 ──────────────
{
  const journal = createLineJournal({ maxBytes: 200 });
  journal.append(`${"y".repeat(500)}\n`);
  const snap = journal.snapshot();
  assert.equal(snap.totalLines, 1, "超大行仍然保留（截断后）");
  assert.ok(snap.bytes <= 200, `截断到 200 字节以内，实际 ${snap.bytes}`);
  assert.equal(snap.truncated, true);
  assert.equal(journal.read().lines[0].text.length, 200);
}

// ── 区间读取 + 字节预算 + nextLine 游标 ───────────────────────────────────
{
  const journal = createLineJournal();
  for (let line = 1; line <= 20; line += 1) journal.append(`entry-${String(line).padStart(3, "0")}\n`);

  const first = journal.read({ fromLine: 1, toLine: 20, maxBytes: 40 });
  assert.ok(first.count > 0 && first.count < 20, "字节预算不足时只返回装得下的部分");
  assert.equal(first.truncated, true);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextLine, first.lines[first.lines.length - 1].line + 1, "nextLine 给出继续读取的游标");

  // 用游标接着读，最终能读全，且不重不漏。
  const seen = [...first.lines];
  let cursor = first.nextLine;
  for (let guard = 0; guard < 50 && cursor <= 20; guard += 1) {
    const next = journal.read({ fromLine: cursor, toLine: 20, maxBytes: 40 });
    if (next.count === 0) break;
    seen.push(...next.lines);
    cursor = next.nextLine;
  }
  assert.deepEqual(seen.map((entry) => entry.line), Array.from({ length: 20 }, (_, index) => index + 1),
    "按游标续读不重不漏");
}

// ── tail 模式在字节不足时丢最旧的（tail 语义），而不是丢最新的 ──────────────
{
  const journal = createLineJournal();
  for (let line = 1; line <= 50; line += 1) journal.append(`row-${String(line).padStart(3, "0")}\n`);
  const tail = journal.read({ tailLines: 50, maxBytes: 60 });
  assert.equal(tail.truncated, true);
  assert.equal(tail.lines[tail.lines.length - 1].line, 50, "最后一行必须在（tail 要的是最新）");
  assert.ok(tail.lines[0].line > 1, "丢掉的是更旧的行");
}

// ── 空日志与越界请求都不炸 ─────────────────────────────────────────────────
{
  const journal = createLineJournal();
  const empty = journal.read({ tailLines: 5 });
  assert.deepEqual(empty.lines, []);
  assert.equal(empty.count, 0);
  assert.equal(empty.evicted, false, "空日志不谎报 evicted");
  assert.equal(empty.firstLine, 1);
  assert.equal(empty.lastLine, 0);

  journal.append("only\n");
  const beyond = journal.read({ fromLine: 99, toLine: 120 });
  assert.deepEqual(beyond.lines, [], "区间完全在保留区之后 ⇒ 空结果");
  assert.equal(beyond.evicted, false);
}

// ── appendLine 与 append 等价（内部合成输出用） ───────────────────────────
{
  const journal = createLineJournal();
  journal.appendLine("synthetic");
  assert.equal(journal.read().lines[0].text, "synthetic");
  assert.equal(journal.lastLine(), 1);
}

// ── 跨 chunk 拆分的行与转义序列都能正确拼接 ────────────────────────────────
{
  const journal = createLineJournal();
  journal.append("hel");
  journal.append("lo wo");
  journal.append(`rld ${ESC}[3`);
  journal.append("1mred\n");
  assert.equal(journal.totalLines(), 1);
  assert.equal(journal.read().lines[0].text, "hello world red", "被拆开的 CSI 序列不该漏进正文");
}

// ── 宿主侧接线：appendSessionOutput 是唯一汇聚点，readTerminalLines 出四位行号 ──
{
  const service = Object.create(SshOpsService.prototype);
  // 只桩掉与本用例无关的旁路（录制/唤醒/订阅），被测的是「汇聚点 → 行日志 → 读取」
  // 这条链路本身。
  service.config = { maxBufferBytes: 65536, maxCaptureBytes: 65536, sessionLogEnabled: false };
  service.terminalOutput = () => ({ append() {} });
  service.sessionLogStore = () => null;
  service.wakeWaiters = () => {};
  service.notifyStreamListeners = () => {};
  const session = {
    id: "s-lab",
    lineJournal: createLineJournal(),
    buffer: "",
    captureBuffer: "",
    waiters: [],
    streamListeners: new Set(),
    exited: null
  };
  service.sessions = new Map([["s-lab", session]]);

  // 验收（计划 M1 / R6-a）：printf 'a\nb\nc\n' 之后 tail 3 行形如 `0001 │ a`。
  service.appendSessionOutput(session, "a\nb\nc\n");
  const read = service.readTerminalLines({ sessionId: "s-lab", tailLines: 3 });
  assert.equal(read.ok, true);
  assert.equal(read.value.text, "0001 │ a\n0002 │ b\n0003 │ c", "四位左补零 + ` │ ` 分隔");
  assert.equal(read.value.firstLine, 1);
  assert.equal(read.value.lastLine, 3);
  assert.equal(read.value.totalLines, 3);
  assert.equal(read.value.evicted, false);
  assert.equal(read.value.exit, null);

  // 会话不存在要给出可判断的错误，而不是空成功。
  const missing = service.readTerminalLines({ sessionId: "nope" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "no-session");

  // 未提交的半行不占行号，但能被单独取到（提示符/正在输入的命令）。
  service.appendSessionOutput(session, "prompt$ ls");
  const live = service.readTerminalLines({ sessionId: "s-lab" });
  assert.equal(live.value.totalLines, 3, "没有 \\n 就不算新行");
  assert.equal(live.value.pendingText, "prompt$ ls");
}

console.log("line journal: monotonic line numbers, in-place redraw, dual caps and range reads all hold");
