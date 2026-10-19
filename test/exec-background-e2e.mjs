// M4 端到端验收（**真实 SSH 通道**，不是桩）。
//
// 用项目自带的离线 sshd（test-sshd.mjs）起一个真实 SSH 服务器，然后让
// `execBackground` 的整条链路跑在**真实 ssh2 exec 通道**上：
//   预检 → 落点判定 → 台账 → 真实执行 → 产物落盘 → 按行读 → 删除 → TTL 清理。
//
// 为什么值得单独存在：此前 M4 的测试全是桩（execOnConnection 被替换成假函数），
// 只证明了"逻辑对"，没证明"真跑起来对"。而这一条链路恰恰有多个只有真跑才会暴露的
// 问题（落点路径的引号、远端非 POSIX 时的行为、产物是否真的写到磁盘）。
//
// 本机是 Windows，离线服务器跑 `cmd.exe` ⇒ 预检必然不可识别 ⇒ **真实触发降级路径**，
// 这正好覆盖计划 6-M4 要求的「降级三处告警」验收。POSIX 远端路径在 test/task-dir.mjs
// 用命令文本断言覆盖。
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import SshOpsService from "../src/index.js";
import { createLineJournal } from "../src/line-journal.js";
import { connectWithRetry } from "./helpers/wait-ready.mjs";

// 平台门控（CI 必需）：本用例靠 **Windows 宿主** 触发降级路径 —— 离线服务器跑
// `cmd.exe`（非 POSIX 远端）⇒ 预检必然不可识别 ⇒ 真实走「降级到本地 + 三处告警」。
// Linux runner 上远端天然是 POSIX，预检直接识别成功，这条断言的前提不存在。
// **跳过并出声**；POSIX 远端的等价覆盖在 test/exec-background-posix-e2e.mjs。
if (process.platform !== "win32") {
  console.log(`SKIP: 本用例需要 Windows 宿主的非 POSIX 远端（cmd.exe）来触发降级路径；当前平台 ${process.platform}`);
  process.exit(0);
}

const freePort = () => new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const port = await freePort();
const child = spawn(process.execPath, [
  fileURLToPath(new URL("../test-sshd.mjs", import.meta.url)), String(port)
,
  // 独立的 host key 路径：默认那个固定路径在**并发跑**时会撞车（多个进程同时
  // 生成并写同一个文件 ⇒ 偶发握手失败）。每个脚本用自己的。
  "--host-key", joinPath(mkdtempSync(joinPath(tmpdir(), "xssh-hostkey-")), "key.pem")
], { stdio: ["ignore", "pipe", "pipe"] });
child.stderr.on("data", () => {});

// 等服务器就绪**不靠固定睡眠**：下面用 connectWithRetry 反复真连，直到 TCP 层能连上。

const client = await connectWithRetry({ port });

console.log("已连上真实 SSH 服务器（127.0.0.1:" + port + "）");

/** 真实 exec 通道：拿 stdout / stderr / exitCode。 */
const realExec = (command) => new Promise((resolve, reject) => {
  client.exec(command, (error, stream) => {
    if (error) { reject(error); return; }
    let stdout = "";
    let stderr = "";
    stream.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    stream.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    stream.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
});

/** 把真实的 ssh2 通道接进 service（其余依赖桩掉）。 */
function makeService() {
  const service = Object.create(SshOpsService.prototype);
  const ledgerDir = mkdtempSync(joinPath(tmpdir(), "xssh-e2e-ledger-"));
  const localTmp = mkdtempSync(joinPath(tmpdir(), "xssh-e2e-local-"));
  service.config = {
    maxBufferBytes: 65536, maxCaptureBytes: 65536,
    sessionLogEnabled: false, commandLedgerEnabled: false, commandIdleMs: 1500,
    lineJournalMaxLines: 2000, lineJournalMaxBytes: 512 * 1024,
    taskLedgerDir: ledgerDir,
    localTmpDir: localTmp
  };
  service.settings = {};
  const session = {
    id: "s-e2e", connectionId: "conn-e2e", exited: null,
    stream: { write: () => {} },
    lineJournal: createLineJournal(),
    shellIntegration: null, buffer: "", captureBuffer: "", waiters: [],
    streamListeners: new Set(), inputLine: "", inputKnown: true, loginScript: null
  };
  service.connections = new Map([["conn-e2e", { host: "127.0.0.1", port, username: "tester", sessions: new Set(["s-e2e"]) }]]);
  service.sessions = new Map([["s-e2e", session]]);
  service.activeConnectionId = "conn-e2e";
  service.terminalOutput = () => ({ append() {} });
  service.sessionLogStore = () => null;
  service.wakeWaiters = () => {};
  service.notifyStreamListeners = () => {};
  service.updateInputMirror = () => {};
  service.appendTerminalNotice = () => {};
  service.savedResourceNameList = () => [];
  service.prefillBlockedCommand = () => null;
  service.lineMark = () => 1;
  service.ledgerFor = () => ({ open: () => ({ commandId: "c-e2e" }), markOutcome: () => {} });
  // **关键**：不改 execOnConnection —— 但它在真实 service 上要连真 client。
  // 这里把它接到真实 ssh2 通道上（而不是返回假数据）。
  service.execOnConnection = async (connectionId, command, _timeoutMs) => {
    const result = await realExec(command);
    return { ok: true, value: result };
  };
  return { service, session, ledgerDir, localTmp };
}

const { service } = makeService();

// ── ① 预检在真实远端上的结果 ───────────────────────────────────────────
{
  const probe = await service.execOnConnection("conn-e2e", (await import("../src/task-dir.js")).probeCommand(), 10000);
  const parsed = (await import("../src/task-dir.js")).parseProbe(probe.value.stdout);
  // 本机远端是 Windows（cmd），POSIX 预检命令必然不可识别 ⇒ unparsed
  assert.equal(parsed.kind, "unparsed",
    `Windows 远端上 POSIX 预检应不可识别（实际 ${parsed.kind}）—— 这决定降级路径被真实触发`);
  console.log(`① 预检（真实通道）→ kind=${parsed.kind}（Windows 远端，符合预期）`);
}

// ── ② 后台任务：真实触发降级 + 三处告警齐备 ───────────────────────────
const started = await service.execBackground({ connectionId: "conn-e2e", command: "echo hello-e2e" });
assert.equal(started.ok, true, `降级任务应能下发：${started.error?.message}`);
assert.equal(started.value.location, "local", "Windows 远端 ⇒ 降级本地");
assert.equal(started.value.degraded, true, "degraded 标记必须为真");
assert.ok(started.value.warnings.length >= 3, `降级告警要齐（实际 ${started.value.warnings.length} 条）`);
const warningText = started.value.warnings.join(" ");
for (const needle of ["结果不留远端", "断线即中断"]) {
  assert.ok(warningText.includes(needle), `告警必须包含「${needle}」`);
}
console.log(`② 落点=${started.value.location} degraded=${started.value.degraded} 告警 ${started.value.warnings.length} 条`);

// ── ③ 等真实执行完成，验证产物真的落盘 ─────────────────────────────────
{
  const taskId = started.value.taskId;
  let task = service.taskLedger().byId(taskId);
  for (let i = 0; i < 100 && task.state === "running"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    task = service.taskLedger().byId(taskId);
  }
  assert.equal(task.state, "done", `真实执行应完成（实际 ${task.state}）`);
  assert.equal(task.exitCode, 0, `退出码应为 0（实际 ${task.exitCode}）`);
  assert.ok(task.localDir !== null, "本地目录要记上");

  // 产物文件真的存在且内容来自**真实命令输出**
  const stdoutPath = joinPath(task.localDir, "stdout.log");
  assert.equal(existsSync(stdoutPath), true, "stdout.log 必须真的存在");
  const stdout = readFileSync(stdoutPath, "utf8");
  assert.ok(stdout.includes("hello-e2e"), `stdout 应含真实输出（实际 ${JSON.stringify(stdout.slice(0, 120))}）`);
  assert.equal(readFileSync(joinPath(task.localDir, "exit.code"), "utf8"), "0", "exit.code 要落 0");
  console.log(`③ 任务 ${taskId} → state=${task.state} exit=${task.exitCode} stdout=${JSON.stringify(stdout.trim().slice(0, 60))}`);
}

// ── ④ 按行号读输出（真实链路的 taskRead）───────────────────────────────
{
  const read = await service.taskRead({ taskId: started.value.taskId, stream: "out" });
  assert.equal(read.ok, true);
  assert.ok(read.value.totalLines >= 1, "至少一行输出");
  assert.ok(read.value.text.includes("hello-e2e"), "读回的内容应含真实输出");
  assert.match(read.value.text, /^\s*\d{4} │ /m, "行号必须是四位数格式");
  console.log(`④ taskRead → ${read.value.totalLines} 行，首行 ${JSON.stringify(read.value.lines[0].text)}`);
}

// ── ⑤ 状态查询（本地任务不该再走远端）─────────────────────────────────
{
  const status = await service.taskStatus({ taskId: started.value.taskId });
  assert.equal(status.ok, true);
  assert.equal(status.value.state, "done");
  assert.equal(status.value.location, "local");
  assert.equal(status.value.exitCode, 0);
  console.log(`⑤ taskStatus → state=${status.value.state} exit=${status.value.exitCode} location=${status.value.location}`);
}

// ── ⑥ 删除产物：本地文件真的消失 ──────────────────────────────────────
{
  const task = service.taskLedger().byId(started.value.taskId);
  const dir = task.localDir;
  assert.equal(existsSync(dir), true, "删除前目录存在");
  const deleted = await service.taskDelete({ taskId: started.value.taskId });
  assert.equal(deleted.ok, true);
  assert.equal(existsSync(dir), false, "删除后本地目录必须真的消失");
  assert.equal(service.taskLedger().byId(started.value.taskId).state, "deleted");
  console.log(`⑥ taskDelete → 目录已消失，台账 state=deleted`);
}

// ── ⑦ 真实通道上的失败必须报错，不能假装成功 ──────────────────────────
{
  const bad = makeService();
  // 桩要带上 `code` —— `execBackground` 预检失败时**原样返回** execOnConnection 的结果，
  // 所以 error 的形状由这里决定（缺 code 会让断言打到 undefined，那是桩的问题不是产品的问题）。
  bad.service.execOnConnection = async () => ({ ok: false, error: { code: "exec-failed", message: "channel died" } });
  const failed = await bad.service.execBackground({ connectionId: "conn-e2e", command: "echo x" });
  assert.equal(failed.ok, false, "预检失败应报错而不是假装成功");
  assert.equal(failed.error.code, "exec-failed", "预检失败要原样透传错误码");
  assert.match(failed.error.message, /channel died/);
  console.log(`⑦ 预检失败 → ${failed.error.code}: ${failed.error.message}（不假装成功）`);
}

// ── ⑧ TTL 清理在真实台账上 ────────────────────────────────────────────
{
  const big = makeService();
  const ledger = big.service.taskLedger();
  const old = ledger.create({ connectionId: "conn-e2e", command: "old", location: "local" });
  ledger.update(old.taskId, { localDir: mkdtempSync(joinPath(tmpdir(), "xssh-e2e-old-")), state: "done", exitCode: 0 });
  const oldDir = ledger.byId(old.taskId).localDir;
  // 把完成时间伪装成 25 小时前
  ledger.byId(old.taskId).finishedAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  const swept = await big.service.sweepExpiredTasks();
  assert.equal(swept.value.swept.length, 1, "超龄任务应被扫到");
  assert.equal(existsSync(oldDir), false, "本地产物目录必须真的被清掉");
  assert.equal(ledger.byId(old.taskId).state, "expired");
  console.log(`⑧ TTL 清理 → 扫到 ${swept.value.swept.length} 条，目录已清，state=expired`);
}

client.end();
child.kill();

console.log("\nM4 端到端验收（真实 SSH 通道 + 真实命令 + 真实文件）：预检、降级三处告警、产物落盘、按行读、状态、删除、TTL 全部通过");
