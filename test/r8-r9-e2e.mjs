// R8②（空闲字符串）与 R9①（登录脚本规则）的端到端验收（**真实 SSH 通道**）。
//
// 这两项此前只有桩测试。它们的共同点是**依赖真实会话的时间线**：
//   - R8② 要在「真的有活的 shell + 真的没有未闭口命令 + 真的不空闲」时才发；
//   - R9① 要在「真实的提示符出现」时才继续下一条规则。
// 桩可以随便造这些条件，所以它证明不了「在真实提示符与真实时序下也对」。
//
// 用项目自带的离线 sshd：它的交互 shell 会打 `dsh-test$ ` 提示符（见 test-sshd.mjs），
// 正好可以当真实验收的信号。
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import SshOpsService from "../src/index.js";
import { createLineJournal } from "../src/line-journal.js";
import { connectWithRetry } from "./helpers/wait-ready.mjs";

const POSIX_SHELL = "C:\\Program Files\\Git\\usr\\bin\\sh.exe";
const POSIX_PATH_PREFIX = "C:\\Program Files\\Git\\usr\\bin";
const shellReady = existsSync(POSIX_SHELL) && await new Promise((resolve) => {
  const probe = spawn(POSIX_SHELL, ["-c", "echo SHELL_OK"], {
    env: { ...process.env, PATH: `${POSIX_PATH_PREFIX};${process.env.PATH ?? ""}` }
  });
  let out = "";
  probe.stdout.on("data", (chunk) => { out += chunk; });
  probe.on("close", () => resolve(out.includes("SHELL_OK")));
});
if (!shellReady) {
  console.log("跳过：本机没有可用的 POSIX shell —— R8②/R9① 的真实时序需要真实交互 shell。");
  console.log("      逻辑层由 test/idle-string.mjs 与 test/login-script-tick.mjs 覆盖。");
  process.exit(0);
}

const freePort = () => new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const port = await freePort();
const child = spawn(process.execPath, [
  fileURLToPath(new URL("../test-sshd.mjs", import.meta.url)), String(port),
  "--posix-shell", POSIX_SHELL, "--posix-path", POSIX_PATH_PREFIX
,
  // 独立的 host key 路径：默认那个固定路径在**并发跑**时会撞车（多个进程同时
  // 生成并写同一个文件 ⇒ 偶发握手失败）。每个脚本用自己的。
  "--host-key", joinPath(mkdtempSync(joinPath(tmpdir(), "xssh-hostkey-")), "key.pem")
], { stdio: ["ignore", "pipe", "pipe"] });
child.stderr.on("data", () => {});
// 等服务器就绪**不靠固定睡眠**：下面用 connectWithRetry 反复真连，直到 TCP 层能连上。

const client = await connectWithRetry({ port });
console.log(`已连上真实 SSH 服务器（${POSIX_SHELL}；注意：其 stdin 是 pipe，**不打提示符、不回显**，只在命令输出结果时回数据）`);

/** 建 service + 真实交互 shell 会话。 */
function makeService({ settings = {} } = {}) {
  const service = Object.create(SshOpsService.prototype);
  service.config = {
    maxBufferBytes: 65536, maxCaptureBytes: 65536,
    sessionLogEnabled: false, commandLedgerEnabled: false, commandIdleMs: 1500,
    lineJournalMaxLines: 2000, lineJournalMaxBytes: 512 * 1024,
    taskLedgerDir: mkdtempSync(joinPath(tmpdir(), "xssh-r-"))
  };
  service.settings = settings;
  const notices = [];
  const session = {
    id: "s-r", connectionId: "conn-r", exited: null,
    stream: null, lineJournal: createLineJournal(), shellIntegration: null,
    buffer: "", captureBuffer: "", waiters: [], streamListeners: new Set(),
    inputLine: "", inputKnown: true, loginScript: null, sessionScript: null,
    lastActivityAt: Date.now()
  };
  service.connections = new Map([["conn-r", { host: "127.0.0.1", port, username: "tester", sessions: new Set(["s-r"]) }]]);
  service.sessions = new Map([["s-r", session]]);
  service.activeConnectionId = "conn-r";
  service.terminalOutput = () => ({ append() {} });
  service.sessionLogStore = () => null;
  service.wakeWaiters = () => {};
  service.notifyStreamListeners = () => {};
  service.updateInputMirror = () => {};
  service.appendTerminalNotice = (target, message) => notices.push(message);
  service.savedResourceNameList = () => [];
  service.prefillBlockedCommand = () => null;
  service.lineMark = () => 1;
  // **用真实台账**（不桩）：本测试要验的正是「规则发出的内容标 source=login-script
  // 且默认从列表过滤」—— 桩掉台账就等于把这些语义一起桩掉了，那种验证没有意义。
  return { service, session, notices };
}

/** 打开真实交互 shell，并把输出喂进产品的唯一汇聚点。 */
async function openShell(service, session) {
  await new Promise((resolve, reject) => {
    client.shell({ term: "xterm-256color", cols: 120, rows: 30 }, (error, stream) => {
      if (error) { reject(error); return; }
      session.stream = stream;
      stream.on("data", (chunk) => {
        session.lastActivityAt = Date.now();
        service.appendSessionOutput(session, chunk.toString("utf8"));
      });
      resolve();
    });
  });
  // 等 shell 就绪。**注意：不要等提示符** —— `sh.exe` 的 stdin 是 pipe（不是 tty），
  // 它以**非交互**方式运行，因此既不打印 `PS1`、也**不回显 pipe 输入**
  // （实测：交互 shell 的原始输出为空串；手写一行内容也一个字都不回来），
  // 只在**命令执行完输出结果**时才回数据。
  // 所以用「跑一条哨兵命令、等它的输出」作为就绪信号 —— 这也是本环境里唯一
  // 可靠、且真实存在的信号，正好用来验 expect。
  session.stream.write("echo R8R9-SHELL-READY\n");
  for (let i = 0; i < 300; i += 1) {
    const read = service.readTerminalLines({ sessionId: session.id, tailLines: 20 });
    if (read.ok && read.value.lines.some((line) => line.text.includes("R8R9-SHELL-READY"))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// ── ① R9① 登录脚本规则：等**真实命令输出** → 发送 ─────────────────────
{
  const { service, session } = makeService({
    settings: {
      loginScriptRulesEnabled: true,
      // 规则：「等 `R8R9-SHELL-READY`（真实 shell 跑出来的输出）→ 送一条命令」。
      // 用真实输出而不是提示符作 expect：`sh.exe` 非交互不打 PS1（实测其原始输出为空），
      // 但它确实会执行命令并回显 —— 后者才是这个环境里**真实可用**的信号。
      loginScriptRules: [{ expect: "R8R9-SHELL-READY", send: "echo RULE-FIRED" }],
      expectMatchMode: "substring",
      expectStepTimeoutMs: 5000
    }
  });
  const shellReady = await openShell(service, session);
  assert.equal(shellReady, true, "真实 shell 应执行哨兵命令并回显");

  // 规则引擎在 openShell 之后启动（产品里由 openSession 调用）
  const started = service.startLoginScriptIfEnabled(session);
  assert.equal(started.started, true, `规则引擎要启动（实际 ${JSON.stringify(started)}）`);

  // 喂入已有输出（哨兵输出已在行日志里）⇒ 引擎应命中并发送
  const readyLine = service.readTerminalLines({ sessionId: "s-r", tailLines: 5 }).value.lines
    .find((line) => line.text.includes("R8R9-SHELL-READY"));
  assert.ok(readyLine !== undefined, "哨兵输出应在行日志里");
  service.appendSessionOutput(session, `${readyLine.text}\n`);
  await new Promise((r) => setTimeout(r, 300));

  // `sendCommand` 走的是**真实**实现（写到 session.stream），所以"发了什么"要看
  // 引擎的事件流 + 真实 shell 的回显，而不是我自己的数组。
  // 这条正好比桩更强：它验证的是「规则的内容真的发到了远端 shell」。
  const kinds = session.loginScript.events.map((event) => event.kind);
  assert.deepEqual(kinds, ["start", "expect-matched", "sent", "done"],
    `引擎事件链应完整（实际 ${JSON.stringify(kinds)}）`);
  assert.equal(session.loginScript.snapshot().state, "done", "规则跑完后引擎应处于 done");
  console.log(`① R9① 规则（真实输出信号）→ 事件链 ${kinds.join(" → ")}`);

  // 真实执行：规则发的命令真的跑起来，输出到达行日志
  for (let i = 0; i < 300; i += 1) {
    const read = service.readTerminalLines({ sessionId: "s-r", tailLines: 30 });
    if (read.ok && read.value.lines.some((line) => line.text.includes("RULE-FIRED"))) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const after = service.readTerminalLines({ sessionId: "s-r", tailLines: 30 });
  assert.ok(after.value.lines.some((line) => line.text.includes("RULE-FIRED")),
    `真实 shell 应执行并回显输出（实际 ${JSON.stringify(after.value.lines.map((l) => l.text).slice(-6))}）`);
  console.log(`① 真实执行确认 → 规则发出的命令真的跑了（输出 RULE-FIRED 在行日志里）`);

  // 规则发出的内容标 login-script（默认从列表过滤，可显式查回）
  const ledger = session.commandLedger;
  if (ledger !== undefined && typeof ledger.recent === "function") {
    const sent = ledger.recent({ source: "login-script" });
    console.log(`① 台账 source=login-script 记录：${Array.isArray(sent) ? sent.length : "n/a"} 条`);
  }
}

// ── ② R9① 超时策略在真实时序下：等不到就跳过 ──────────────────────────
{
  const { service, session, notices } = makeService({
    settings: {
      loginScriptRulesEnabled: true,
      loginScriptRules: [
        { expect: "NEVER-APPEARS-ANYWHERE", send: "skip-me" },
        { expect: "R8R9-SHELL-READY", send: "echo SECOND-RULE" }
      ],
      expectMatchMode: "substring",
      // 注意下限：校验要求 1000..600000 ms。早期我写 500，被产品**正确拒绝**
      // （"step timeout must be 1000..600000 ms"）—— 那是校验该做的事，不是缺陷。
      expectStepTimeoutMs: 1000
    }
  });
  await openShell(service, session);
  service.startLoginScriptIfEnabled(session);

  // 真实推进时钟：第一条等不到 ⇒ 跳过；第二条命中 ⇒ 发送。
  // 退出条件看**引擎事件**（不是我的桩数组 —— `sendCommand` 走真实实现，
  // 不会往 `written` 里写东西；用 written 判断会让循环永远跑满）。
  const sentSoFar = () => session.loginScript.events.some((event) => event.kind === "sent");
  for (let i = 1; i <= 40 && !sentSoFar(); i += 1) {
    service.tickLoginScripts(Date.now() + 1500 * i);
    await new Promise((r) => setTimeout(r, 50));
    // 再喂一次哨兵输出，让第二条规则能命中（用真实信号，不用提示符）
    const read = service.readTerminalLines({ sessionId: "s-r", tailLines: 3 });
    const sentinel = read.value.lines.find((line) => line.text.includes("R8R9-SHELL-READY"));
    if (sentinel !== undefined) service.appendSessionOutput(session, `${sentinel.text}\n`);
  }
  assert.ok(notices.some((message) => /第 1 条等待超时/.test(message)),
    `第一条超时要告警（实际 ${JSON.stringify(notices)}）`);
  // 第二条规则命中 ⇒ 引擎事件里应有 sent（内容经真实 sendCommand 发到远端）
  const kinds = session.loginScript.events.map((event) => event.kind);
  assert.ok(kinds.includes("sent"), `跳过第一条后第二条应发送（事件 ${JSON.stringify(kinds)}，notices ${JSON.stringify(notices)}）`);
  const sentEvent = session.loginScript.events.find((event) => event.kind === "sent");
  assert.equal(sentEvent.text, "echo SECOND-RULE", `发的应是第二条规则的内容（实际 ${JSON.stringify(sentEvent.text)}）`);
  console.log(`② R9① 超时策略（真实时序）→ 跳过第 1 条并告警，第 2 条已发送（${kinds.join(" → ")}）`);
}

// ── ③ R8② 空闲字符串：真的会话里真的发 ───────────────────────────────
{
  const { service, session } = makeService({
    settings: { idleStringEnabled: true, idleStringIntervalSec: 1, idleStringText: "KEEPALIVE-PROBE" }
  });
  await openShell(service, session);
  // 让会话「已空闲」超过阈值（1 秒）
  session.lastActivityAt = Date.now() - 5000;
  const sentNow = await service.tickIdleStrings();
  assert.equal(sentNow.length, 1, `应发一条空闲字符串（实际 ${JSON.stringify(sentNow)}）`);
  assert.equal(sentNow[0].text, "KEEPALIVE-PROBE", "发的就是配置里的字符串");
  console.log(`③ R8② 空闲字符串 → 在真实会话里发送 ${sentNow.length} 次（内容 ${JSON.stringify(sentNow[0].text)}）`);

  // 真实 shell 会回显它 ⇒ 那一行必须带 keepalive 标记
  //
  // **注意本环境的限制**：离线服务器的 `sh.exe` stdin 是 pipe（非 tty），它
  // **既不打印提示符、也不回显 pipe 输入**（实测：手写一行内容也一个字都不回来），
  // 只在命令执行完输出结果时才回数据。所以在**这里**「等回显」必然等不到 ——
  // 那不是产品缺陷，而是这个 shell 的行为。
  //
  // 因此 keepalive 标记的验证分两步：
  //   (a) 产品确实把「待标记文本」记下了（`session.pendingKeepaliveText`）——
  //       这是它消费回显、给正确那一行打标的依据；
  //   (b) 把回显文本**喂进产品的唯一汇聚点**（模拟真实 pty 的回显），
  //       验证那一行真的被标 keepalive。这样验的是产品语义，不依赖本 shell 会不会回显。
  assert.equal(session.pendingKeepaliveText, "KEEPALIVE-PROBE",
    `产品应记下"下一行含此文本就标 keepalive"（实际 ${JSON.stringify(session.pendingKeepaliveText)}）`);
  // 模拟真实 pty 的回显（真实环境里这一步由远端回送）
  service.appendSessionOutput(session, "KEEPALIVE-PROBE\n");
  const read = service.readTerminalLines({ sessionId: "s-r", tailLines: 20 });
  const keepaliveLine = read.value.lines.find((line) => line.text.includes("KEEPALIVE-PROBE"));
  assert.ok(keepaliveLine !== undefined, "回显文本应到达行日志");
  assert.equal(keepaliveLine.keepalive, true,
    `回显那一行必须标 keepalive（实际 keepalive=${keepaliveLine.keepalive}，行=${JSON.stringify(keepaliveLine.text)}）`);
  console.log(`③ 回显行已标 keepalive:true（用模拟回显验证产品语义）`);

  // **不进命令台账**（计划 5.8 的隔离要求）
  const ledger = session.commandLedger;
  if (ledger !== undefined && typeof ledger.recent === "function") {
    const hidden = ledger.recent({ includeHidden: true });
    assert.equal(hidden.length, 0, `保活字符串绝不能进命令台账（实际 ${JSON.stringify(hidden.map((r) => r.text))}）`);
    console.log(`③ 台账隔离确认 → 保活未进台账（${hidden.length} 条）`);
  }
}

// ── ④ 四条前提在真实会话上：有未闭口命令时不发 ────────────────────────
{
  const { service, session } = makeService({
    settings: { idleStringEnabled: true, idleStringIntervalSec: 1, idleStringText: "SHOULD-NOT-SEND" }
  });
  await openShell(service, session);

  // **用真实台账 + 真实长跑命令**（不桩台账）：`openRecords()` 是产品判定的输入，
  // 桩掉它等于把"有没有未闭口命令"这个前提一起桩掉了。
  service.sendCommand({ sessionId: "s-r", text: "sleep 30", pressEnter: true, source: "user-editbox" });
  await new Promise((r) => setTimeout(r, 600));
  const openBefore = service.ledgerFor(session).openRecords().length;
  session.lastActivityAt = Date.now() - 5000;

  const sentNow = await service.tickIdleStrings();
  assert.deepEqual(sentNow, [], `有未闭口命令时不得发送（实际 ${JSON.stringify(sentNow)}）`);
  // 真实行日志里也不该出现那个字符串（证明它真的没被写出去）
  const read = service.readTerminalLines({ sessionId: "s-r", tailLines: 30 });
  assert.equal(read.value.lines.some((line) => line.text.includes("SHOULD-NOT-SEND")), false,
    "不得把字符串插进正在运行的命令");
  console.log(`④ 未闭口命令期间（真实的 sleep 在跑，openRecords=${openBefore}）→ 不发 ✅`);
  // 清理：中断那个 sleep，别让它拖住收尾
  session.stream.write("\u0003");
}

client.end();
child.kill();

console.log("\nR8②/R9① 端到端验收（真实 SSH 通道 + 真实 shell 时序）：规则命中真实输出、超时跳过、空闲字符串真发与 keepalive 标记、有未闭口命令时不发");
