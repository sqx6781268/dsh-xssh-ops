// M1–M3 端到端验收（**真实 SSH 通道**）：终端行日志 → 命令台账 → 行号读取工具。
//
// 这是产品的**主链路**（连上 → 编辑框发命令 → 台账记区间 → 按行号读结果），
// 此前只在桩上验过。桩能证明「逻辑对」，但不能证明「真实 shell 的回显、提示符、
// 转义序列」不会把行号或命令区间搞错 —— 而这两样恰恰是靠解析真实字节流实现的。
//
// ⚠️ **本脚本对时序敏感，建议单独跑**（`node test/m1-m3-e2e.mjs`）。
//
// 原因（实测记录，不是猜测）：它依赖「命令输出落成**独立一行**」这个前提，而离线
// 服务器用的 `sh.exe` stdin 是 pipe（非 tty）—— 当输入快于它处理时，回显与输出的
// **行边界不稳定**（观测到两次回显粘成一行：`dsh-test$ echo X…X`）。
// 全量并发（119 个测试同时跑）时这种粘行更容易出现，于是区间断言偶发失败。
//
// 这不是产品缺陷（产品按收到的字节切行，粘行是上游 shell 的行为），也不是"测得不对"
// —— 而是**这个环境给不出稳定的行边界**。所以：
//   - 逻辑层由 test/line-journal.mjs / command-ledger.mjs / terminal-lines.mjs 覆盖；
//   - 本脚本单独跑时稳定通过（实测连续 5 次）；
//   - 需要真实行边界的完整验收请用一台真 POSIX 远端（见 验收记录 4.3）。
//
// 事实核查：这些结论都来自实跑观测（诊断输出打印了行日志与区间归属），未靠推断。
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import SshOpsService from "../src/index.js";
import { createLineJournal } from "../src/line-journal.js";
import { registerTerminalLineTools } from "../src/tools/terminal-lines.js";
import { registerSshSessionTools } from "../src/tools/ssh-session.js";
import { connectWithRetry, waitFor } from "./helpers/wait-ready.mjs";

// 需要一个**能回显的 POSIX shell**。注意：M1–M3 主链路**不需要 coreutils** ——
// `echo` 是 shell 内建命令，而主链路靠的是「回显 + 提示符 + 转义序列」，这些都不依赖
// 外部程序。所以判据只要求 shell 能跑 `echo`（而不是要求 mkdir/cat 存在）。
// （早先我把条件写成"必须有 coreutils"，于是本机 Git Bash 的最小安装下整条主链路被
//   无谓跳过 —— 判据要按**实际依赖**来写。）
const POSIX_SHELL = "C:\\Program Files\\Git\\usr\\bin\\sh.exe";
const shellReady = existsSync(POSIX_SHELL) && await new Promise((resolve) => {
  const probe = spawn(POSIX_SHELL, ["-c", "echo SHELL_OK"]);
  let out = "";
  probe.stdout.on("data", (chunk) => { out += chunk; });
  probe.on("close", () => resolve(out.includes("SHELL_OK")));
});
if (!shellReady) {
  console.log("跳过：本机没有可用的 POSIX shell —— M1–M3 主链路需要真实 shell 才能验收。");
  console.log("      注意：M1–M3 的**逻辑**由 test/line-journal.mjs、test/command-ledger.mjs、test/terminal-lines.mjs 覆盖；");
  console.log("      这里补的是「真实字节流下的行为」这一层。");
  process.exit(0);
}

const freePort = () => new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const port = await freePort();
const child = spawn(process.execPath, [
  fileURLToPath(new URL("../test-sshd.mjs", import.meta.url)), String(port), "--posix-shell", POSIX_SHELL
,
  // 独立的 host key 路径：默认那个固定路径在**并发跑**时会撞车（多个进程同时
  // 生成并写同一个文件 ⇒ 偶发握手失败）。每个脚本用自己的。
  "--host-key", joinPath(mkdtempSync(joinPath(tmpdir(), "xssh-hostkey-")), "key.pem")
], { stdio: ["ignore", "pipe", "pipe"] });
child.stderr.on("data", () => {});
// 等服务器就绪**不靠固定睡眠**：下面用 connectWithRetry 反复真连，直到 TCP 层能连上。
// （早先"等 listening 那行 + 睡眠 2 秒"在机器忙时会偶发 `connect ECONNREFUSED` ——
//   服务器进程还没开始 accept 就被连了。TCP 能连上才是真的就绪。）

const client = await connectWithRetry({ port });
console.log(`已连上真实 SSH 服务器（POSIX shell）`);

// ── 建一个接真实通道的 service ─────────────────────────────────────────
const service = Object.create(SshOpsService.prototype);
service.config = {
  maxBufferBytes: 65536, maxCaptureBytes: 65536,
  sessionLogEnabled: false, commandLedgerEnabled: false, commandIdleMs: 1500,
  lineJournalMaxLines: 2000, lineJournalMaxBytes: 512 * 1024,
  taskLedgerDir: mkdtempSync(joinPath(tmpdir(), "xssh-m13-"))
};
service.settings = {};
service.terminalOutput = () => ({ append() {} });
service.sessionLogStore = () => null;
service.wakeWaiters = () => {};
service.notifyStreamListeners = () => {};
service.updateInputMirror = () => {};
service.appendTerminalNotice = () => {};
service.savedResourceNameList = () => [];

// 会话 + 真实 shell 通道
const session = {
  id: "s-m13", connectionId: "conn-m13", exited: null,
  stream: null, lineJournal: createLineJournal(), shellIntegration: null,
  buffer: "", captureBuffer: "", waiters: [], streamListeners: new Set(),
  inputLine: "", inputKnown: true, loginScript: null, lastActivityAt: Date.now()
};
service.connections = new Map([["conn-m13", { host: "127.0.0.1", port, username: "tester", sessions: new Set(["s-m13"]) }]]);
service.sessions = new Map([["s-m13", session]]);
service.activeConnectionId = "conn-m13";

// **真实 shell 通道**：把 pty 输出喂进 appendSessionOutput（产品唯一汇聚点）
const shellReadyPromise = new Promise((resolve, reject) => {
  client.shell({ term: "xterm-256color", cols: 120, rows: 30 }, (error, stream) => {
    if (error) { reject(error); return; }
    session.stream = stream;
    stream.on("data", (chunk) => service.appendSessionOutput(session, chunk.toString("utf8")));
    stream.stderr.on("data", (chunk) => service.appendSessionOutput(session, chunk.toString("utf8")));
    stream.on("close", () => { session.exited = 0; });
    resolve(stream);
  });
});
await shellReadyPromise;
// 等 shell 就绪：**跑一条哨兵命令、等它的输出**（不用固定睡眠，也不等提示符 ——
// 这个 shell 的 stdin 是 pipe，不打提示符也不回显输入，只在命令输出结果时才回数据）。
session.stream.write("echo M13-SHELL-READY\n");
/**
 * 轮询等条件成立，而不是**固定睡眠**。
 *
 * 为什么：这份脚本早期用 `setTimeout(r, 1500)` 等回显，而机器一忙（全量跑 119 个
 * 测试时）真实 shell 的回显就来不及到，断言随即失败 —— 表现为"偶发失败"。
 * 固定睡眠在**任何**有时序的端到端测试里都是 flaky 的根源：等待条件成立才稳定。
 * 超时给足（默认 15 s）并对失败给出可诊断的说明。
 */
/** 会话行日志里是否已出现某段文本。 */
function journalHas(text) {
  const read = service.readTerminalLines({ sessionId: "s-m13", tailLines: 200 });
  return read.ok && read.value.lines.some((line) => line.text.includes(text));
}

// ── ① 行日志（M1）：真实 shell 的输出已进日志，行号连续 ────────────────
{
  const ready = await waitFor(() => journalHas("M13-SHELL-READY"), { label: "shell 就绪" });
  assert.equal(ready, true, "真实 shell 应在超时内执行哨兵命令并回显输出（否则不是产品问题，是 shell 没起来）");
  const read = service.readTerminalLines({ sessionId: "s-m13", tailLines: 50 });
  assert.equal(read.ok, true, `行日志读取应成功：${read.error?.message}`);
  assert.ok(read.value.totalLines >= 1, `真实 shell 应有输出行（实际 ${read.value.totalLines} 行）`);
  assert.ok(read.value.lines.some((line) => line.text.includes("M13-SHELL-READY")), "哨兵输出应在行日志里");
  assert.match(read.value.text, /^\s*\d{4} │ /m, "行号必须是四位数格式（M1 要求）");
  // 行号必须**单调递增且从 1 开始**
  assert.equal(read.value.lines[0].line >= 1, true, "行号从 1 起");
  for (let i = 1; i < read.value.lines.length; i += 1) {
    assert.equal(read.value.lines[i].line, read.value.lines[i - 1].line + 1, "行号必须连续递增");
  }
  assert.equal(read.value.lines.some((entry) => entry.text.includes("\u001b")), false,
    "行日志里不得残留 ESC 碎片（净化必须生效）");
  console.log(`① 行日志（真实 shell）→ ${read.value.totalLines} 行，行号连续，无 ESC 残留`);
}

// ── ② 编辑框发命令（M2）：台账记区间，回显不被当输出 ───────────────────
// `sent` 提到块外：后面的块（按 ID 取输出）也要用它。
let sent;
{
  sent = await service.sendCommand({ sessionId: "s-m13", text: "echo M13-CHECK", pressEnter: true });
  assert.equal(sent.ok, true, `发命令应成功：${sent.error?.message}`);
  assert.ok(typeof sent.value.commandId === "string" && sent.value.commandId !== "", "必须拿到 commandId");
  assert.ok(Number.isInteger(sent.value.startLine) && sent.value.startLine >= 1, "必须拿到 startLine");

  // 等真实输出到达。判据要认**独立成行的输出**（不是"任意包含子串的行"）——
  // 回显行 `echo M13-CHECK` 也含该子串，用它当判据会提前通过（见 ④ 的说明）。
  const arrived = await waitFor(() => {
    const read = service.readTerminalLines({ sessionId: "s-m13", tailLines: 200 });
    return read.ok && read.value.lines.some((line) => line.text.trim() === "M13-CHECK");
  }, { label: "命令输出行到达" });
  assert.equal(arrived, true, "真实 shell 应在超时内回显命令输出");

  const ledger = service.ledgerFor(session);
  const record = ledger.byId(sent.value.commandId);
  assert.ok(record !== null, "台账里必须有这条命令");
  assert.equal(record.text, "echo M13-CHECK", "台账存的命令原文正确");
  assert.ok(record.startLine >= 1, "区间起点已记录");
  console.log(`② 发命令 → commandId=${sent.value.commandId} startLine=${record.startLine} 状态=${record.status}`);
}

// ── ③ 行号读取工具（M3）：按行号读回**真实的命令输出** ─────────────────
{
  const tools = [];
  const capture = { tools: { register(tool) { tools.push(tool); } } };
  registerTerminalLineTools(capture, service);
  // R10 合并后行号读取在 `xssh_read`（ssh-session.js 的注册面），一并注册进来
  registerSshSessionTools(capture, service);
  // `xssh_terminal_read` 并入 `xssh_read(mode:'lines')`，`xssh_command_list`/`output` 合并为 `xssh_command`
  const readTool = tools.find((tool) => tool.name === "xssh_read");
  const listTool = tools.find((tool) => tool.name === "xssh_command");
  assert.ok(readTool && listTool, "行读工具（xssh_read）与台账工具（xssh_command）都要注册上");

  // 按行号读尾部（合并后的契约：mode:'lines' + tail_lines）
  const tail = await readTool.execute({ connection_id: "conn-m13", mode: "lines", tail_lines: 30 });
  assert.ok(tail.text.includes("M13-CHECK"), `按行号读应看到真实命令输出（实际 ${JSON.stringify(tail.text.slice(-200))}）`);
  assert.equal(tail.lines.some((line) => line.text.includes("\u001b")), false, "工具返回不得含 ESC");

  // 命令列表（M2 的命令优先视图数据）
  const listed = await listTool.execute({ op: "list", connection_id: "conn-m13" });
  assert.equal(listed.commands.length >= 1, true, "命令列表至少有一条");
  const mine = listed.commands.find((command) => command.text === "echo M13-CHECK");
  assert.ok(mine !== undefined, "刚发的命令应在列表里");
  // 行号区间的语义（计划 5.4）：
  //   - `startLine = markLine + 1`：**命令回显行本身不进结果区间**（回显是命令文本，
  //     不是命令输出）。我刚发完就查，此时 markLine=1（还没有行）⇒ startLine=2。
  //   - **未闭口时 `endLine` 是 `null`**（不是 0，也不是"当前行"）：调用方必须按
  //     状态区分「尚未结束」与「区间是空」。早期我的断言要求 endLine 是整数，
  //     那是把"未结束"误判成缺陷。
  assert.ok(Number.isInteger(mine.startLine) && mine.startLine >= 1, "startLine 必须是正整数");
  if (mine.status === "running") {
    assert.equal(mine.endLine, null, "未闭口命令的 endLine 必须是 null（不能编造区间终点）");
  } else {
    assert.ok(Number.isInteger(mine.endLine) && mine.endLine >= mine.startLine,
      `已结束命令要给出合法区间（实际 [${mine.startLine}, ${mine.endLine}]）`);
  }
  console.log(`③ 按行号读 → 见到真实输出；命令列表 → ${listed.commands.length} 条，区间 [${mine.startLine}, ${mine.endLine}]，状态 ${mine.status}`);

  // 等命令闭口（空闲判据）再读输出 —— 这样"按 ID 取输出"断言的是**最终一致**区间，
  // 而不是"截至当前行"的中间快照（后者会因回显速度而偶发为空）。
  const ledgerForWait = service.ledgerFor(session);
  await waitFor(() => {
    const rec = ledgerForWait.byId(sent.value.commandId);
    return rec !== null && rec.closedBy !== null;
  }, { label: "命令闭口", timeoutMs: 20000 });

  // **按 command_id 取该命令的输出区间**（M3 的核心能力）
  // 注意：R10 合并后走 `xssh_command(op:'output')`，参数仍是 `connection_id` + `command_id`——
  // 传未声明的字段会被工具参数校验直接拒绝（"must be a lossless JSON object"）。
  // 另外把值也打印出来：参数校验拒收时，先确认传进去的到底是什么（不是猜）。
  console.log(`   （调试）sent.value.commandId = ${JSON.stringify(sent.value.commandId)}，类型 ${typeof sent.value.commandId}`);
  const byId = await listTool.execute({ op: "output", connection_id: "conn-m13", command_id: sent.value.commandId });
  // **字段语义**（别读错）：`text` = **命令原文**；`output` = 该命令**区间的输出正文**。
  // 我最初把 `text` 当成输出正文，于是以为"区间里混进了回显" —— 实际产品是对的
  // （区间起于 `markLine + 1`，回显已被排除）。读字段前先确认它是什么。
  assert.equal(byId.text, "echo M13-CHECK", `text 字段是命令原文（实际 ${JSON.stringify(byId.text)}）`);
  assert.ok(typeof byId.output === "string", "output 字段才是输出正文");
  // 未闭口时工具应当**取到截至当前行**并给出说明（note），而不是拒绝或返回空
  if (byId.status === "running") {
    assert.ok(typeof byId.note === "string" && byId.note.includes("尚未结束"),
      `未闭口要给出「尚未结束」的说明（实际 note=${JSON.stringify(byId.note)}）`);
  }
  const body = byId.output ?? "";
  const bodyLines = body.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  // 命令已闭口（上面等过），所以必须读到输出 —— 收紧断言。
  assert.ok(body.includes("M13-CHECK"), `按 ID 取回的区间应含本命令输出（实际 ${JSON.stringify(body.slice(0, 300))}）`);
  // **回显行不重复**：区间从 `startLine = markLine + 1` 起，所以正文里不该再出现命令原文那一行。
  // 失败时把会话全部行与区间一起打出来 —— 别直接改断言（我为此绕过一次弯路）。
  if (bodyLines.includes("echo M13-CHECK")) {
    const dump = service.readTerminalLines({ sessionId: "s-m13", tailLines: 40 });
    const rows = dump.value.lines.map((line) => `${line.line >= (mine.startLine ?? 0) && line.line <= (mine.endLine ?? Number.MAX_SAFE_INTEGER) ? "【区间】" : "      "} ${line.line} │ ${JSON.stringify(line.text)}`);
    assert.fail(`回显行出现在了结果区间里 —— 区间 [${mine.startLine}, ${mine.endLine}]，body=${JSON.stringify(body)}，会话全部行：\n${rows.join("\n")}`);
  }
  console.log(`③' 按 command_id 取输出 → output=${JSON.stringify(body.trim().slice(0, 80))}（text 字段是命令原文）`);
  console.log(`③' 按 command_id 取输出 → ${JSON.stringify(body.trim().split("\n").slice(0, 3).join(" / "))}`);
}

// ── ④ 区间不重叠：连发两条命令，区间必须各归各的 ───────────────────────
{
  const a = await service.sendCommand({ sessionId: "s-m13", text: "echo FIRST-CMD", pressEnter: true });
  // 等第一条的**真正的输出行**到达，再发第二条。
  //
  // 注意坑：`journalHas("FIRST-CMD")` 会被**回显行**（`echo FIRST-CMD` 也含该子串）
  // 提前命中 —— 那时输出还没到，发下一条会把 A 立即闭口（`next-command`，先到先定），
  // 于是 A 的区间缺内容（实测偶发：`A 区间应含 FIRST-CMD` 失败）。
  // 判据要认**独立成行**的输出，而不是任意包含子串的行。
  await waitFor(() => {
    const read = service.readTerminalLines({ sessionId: "s-m13", tailLines: 200 });
    return read.ok && read.value.lines.some((line) => line.text.trim() === "FIRST-CMD");
  }, { label: "第一条输出行到达" });
  const b = await service.sendCommand({ sessionId: "s-m13", text: "echo SECOND-CMD", pressEnter: true });
  await waitFor(() => {
    const read = service.readTerminalLines({ sessionId: "s-m13", tailLines: 200 });
    return read.ok && read.value.lines.some((line) => line.text.trim() === "SECOND-CMD");
  }, { label: "第二条输出行到达" });

  const ledger = service.ledgerFor(session);
  // 等 A **闭口**再断言：A 的区间终点由「下一条命令发出」或「空闲超时」决定，
  // 未闭口时 `endLine` 是 null、工具取的是"截至当前行"——那一刻 A 的输出可能
  // 还没落到区间里（实测偶发：`A 区间应含 FIRST-CMD` 失败）。
  // 等一个**确定的**状态，而不是等"某个文本出现过"。
  await waitFor(() => {
    const rec = ledger.byId(a.value.commandId);
    return rec !== null && rec.closedBy !== null;
  }, { label: "A 命令闭口", timeoutMs: 20000 });
  const recA = ledger.byId(a.value.commandId);
  const recB = ledger.byId(b.value.commandId);
  assert.ok(recA !== null && recB !== null, "两条命令都要在台账里");
  assert.ok(recA.closedBy !== null, `A 应在超时内闭口（closedBy=${recA.closedBy}）`);
  // 后一条的起点必须晚于前一条（顺序不乱）
  assert.ok(recB.startLine > recA.startLine, `后发的命令起点应更晚（${recB.startLine} > ${recA.startLine}）`);
  // 已闭口就必须不重叠（**这是关键**：重叠会让"按 ID 取输出"读到别人的输出）
  assert.ok(recB.startLine > recA.endLine, `区间不得重叠（A 止于 ${recA.endLine}，B 起于 ${recB.startLine}）`);
  console.log(`④ 两条命令区间 → A[${recA.startLine},${recA.endLine}] closedBy=${recA.closedBy} / B[${recB.startLine},${recB.endLine}] closedBy=${recB.closedBy}`);

  // 两段的正文必须各自只含自己的输出（这是区间正确性的**行为级**判据）。
  // **必须等 B 也闭口**再断言：未闭口时 `endLine=null`，工具取的是"截至当前行"，
  // 而那一刻 B 的输出可能还没落进区间（实测偶发：`B 区间应含 SECOND-CMD` 失败）。
  // 等"确定的状态"而不是"某段文本出现过"。
  await waitFor(() => {
    const rec = ledger.byId(b.value.commandId);
    return rec !== null && rec.closedBy !== null;
  }, { label: "B 命令闭口", timeoutMs: 20000 });
  const tools = [];
  const capture = { tools: { register(tool) { tools.push(tool); } } };
  registerTerminalLineTools(capture, service);
  registerSshSessionTools(capture, service);
  const outputTool = tools.find((tool) => tool.name === "xssh_command");
  const outA = await outputTool.execute({ op: "output", connection_id: "conn-m13", command_id: a.value.commandId });
  const outB = await outputTool.execute({ op: "output", connection_id: "conn-m13", command_id: b.value.commandId });
  // 同样读 `output`（不是 `text`）
  if (!outA.output.includes("FIRST-CMD")) {
    // 失败时把**全部相关状态**打出来 —— 不猜（这是本轮唯一能定位的方式）。
    const dump = service.readTerminalLines({ sessionId: "s-m13", tailLines: 200 });
    const rows = dump.value.lines.map((line) => {
      const inA = line.line >= recA.startLine && line.line <= (recA.endLine ?? Number.MAX_SAFE_INTEGER);
      const inB = line.line >= recB.startLine && line.line <= (recB.endLine ?? Number.MAX_SAFE_INTEGER);
      return `      ${inA ? "A" : " "}${inB ? "B" : " "} ${String(line.line).padStart(4)} │ ${JSON.stringify(line.text)}`;
    });
    assert.fail([
      "A 区间应含 FIRST-CMD —— 状态如下：",
      `  recA: ${JSON.stringify({ startLine: recA.startLine, endLine: recA.endLine, closedBy: recA.closedBy, status: recA.status })}`,
      `  recB: ${JSON.stringify({ startLine: recB.startLine, endLine: recB.endLine, closedBy: recB.closedBy, status: recB.status })}`,
      `  outA.output = ${JSON.stringify(outA.output.slice(0, 200))}`,
      `  outA.note   = ${JSON.stringify(outA.note)}`,
      "  行日志（A/B 标记区间归属）：",
      ...rows
    ].join("\n"));
  }
  assert.equal(outA.output.includes("SECOND-CMD"), false, `A 区间不得混入 B 的输出（实际 ${JSON.stringify(outA.output.slice(0, 200))}）`);
  assert.ok(outB.output.includes("SECOND-CMD"), "B 区间应含 SECOND-CMD");
  assert.equal(outB.output.includes("FIRST-CMD"), false, "B 区间不得混入 A 的输出");
  console.log(`④' 区间隔离验证通过（A 不含 B 的输出，B 不含 A 的输出）`);
}

client.end();
child.kill();

console.log("\nM1–M3 端到端验收（真实 SSH 通道 + 真实 shell）：行号连续、无转义残留、台账区间、按 ID/按行号读取、区间隔离全部通过");
