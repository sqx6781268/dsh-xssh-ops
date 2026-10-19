// M4 端到端验收 · **POSIX 正常路径**（真实 SSH 通道 + 真实 POSIX shell）。
//
// 与 exec-background-e2e.mjs（Windows cmd ⇒ 验降级路径）互补：这里让离线服务器用
// Git 自带的 `sh.exe` 执行命令，于是 **POSIX 假设真的成立**，可以验到：
//   预检识别 → 远端落点 → `setsid nohup` 真实后台化 → `ready` 哨兵 → 产物落远端文件
//   → 远端状态查询 → 按行读远端文件 → 远端删除。
//
// 这一段之前只能靠命令文本断言（test/task-dir.mjs），没有真跑过。而它恰恰是
// 「远端临时目录」这条主路径 —— 用户最常走的路径。
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import SshOpsService from "../src/index.js";
import { createLineJournal } from "../src/line-journal.js";
import { parseProbe, parseStatus, probeCommand, remoteStatusCommand } from "../src/task-dir.js";
import { connectWithRetry } from "./helpers/wait-ready.mjs";

// Git 自带的 POSIX shell（Windows 上唯一可靠的 sh）
const POSIX_SHELL = "C:\\Program Files\\Git\\usr\\bin\\sh.exe";
if (!existsSync(POSIX_SHELL)) {
  console.log(`跳过：本机没有 POSIX shell（${POSIX_SHELL}）—— 正常路径需要它才能真跑`);
  process.exit(0);
}

/**
 * 前置条件：远端要有**可用的 coreutils**（`mkdir`/`cat`/`sleep`…）。
 *
 * 踩过的坑（值得记下来）：Windows 上直接 spawn `sh.exe` 时环境里**没有 `/usr/bin`**，
 * 于是 Git 自带的 coreutils（mkdir/df/awk…）全部 `command not found`。我据此误判过
 * 「本机缺 coreutils，正常路径无法验收」—— **其实只是 PATH 没带上**。
 * 现在把 `/usr/bin` 前置到 PATH（`--posix-path`），再探一次；确实不可用才跳过。
 */
const POSIX_PATH_PREFIX = "C:\\Program Files\\Git\\usr\\bin";
const shellReady = await new Promise((resolve) => {
  const probe = spawn(POSIX_SHELL, ["-c", "command -v mkdir >/dev/null 2>&1 && command -v cat >/dev/null 2>&1 && command -v sleep >/dev/null 2>&1 && echo YES || echo NO"], {
    env: { ...process.env, PATH: `${POSIX_PATH_PREFIX};${process.env.PATH ?? ""}` }
  });
  let out = "";
  probe.stdout.on("data", (chunk) => { out += chunk; });
  probe.on("close", () => resolve(out.includes("YES")));
});
if (!shellReady) {
  console.log(`跳过：${POSIX_SHELL} 在补入 PATH 后仍缺 coreutils（mkdir/cat/sleep）—— 正常路径无法在本地验收。`);
  console.log("      缺 coreutils 远端的正确行为由 exec-background-bare-remote-e2e.mjs 覆盖（预检不误降级 + 不假报 ready）。");
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
  fileURLToPath(new URL("../test-sshd.mjs", import.meta.url)), String(port),
  "--posix-shell", POSIX_SHELL,
  // 把 coreutils 的目录前置到子进程 PATH（否则 `mkdir`/`df`/`awk` 全部找不到）
  "--posix-path", "C:\\Program Files\\Git\\usr\\bin"
,
  // 独立的 host key 路径：默认那个固定路径在**并发跑**时会撞车（多个进程同时
  // 生成并写同一个文件 ⇒ 偶发握手失败）。每个脚本用自己的。
  "--host-key", joinPath(mkdtempSync(joinPath(tmpdir(), "xssh-hostkey-")), "key.pem")
], { stdio: ["ignore", "pipe", "pipe"] });
child.stderr.on("data", () => {});

// 等服务器就绪**不靠固定睡眠**：下面用 connectWithRetry 反复真连，直到 TCP 层能连上。

const client = await connectWithRetry({ port });

console.log(`已连上真实 SSH 服务器（POSIX shell: ${POSIX_SHELL}）`);

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

function makeService() {
  const service = Object.create(SshOpsService.prototype);
  service.config = {
    maxBufferBytes: 65536, maxCaptureBytes: 65536,
    sessionLogEnabled: false, commandLedgerEnabled: false, commandIdleMs: 1500,
    lineJournalMaxLines: 2000, lineJournalMaxBytes: 512 * 1024,
    taskLedgerDir: mkdtempSync(joinPath(tmpdir(), "xssh-posix-ledger-")),
    localTmpDir: mkdtempSync(joinPath(tmpdir(), "xssh-posix-local-"))
  };
  service.settings = {};
  const session = {
    id: "s-posix", connectionId: "conn-posix", exited: null,
    stream: { write: () => {} }, lineJournal: createLineJournal(),
    shellIntegration: null, buffer: "", captureBuffer: "", waiters: [],
    streamListeners: new Set(), inputLine: "", inputKnown: true, loginScript: null
  };
  service.connections = new Map([["conn-posix", { host: "127.0.0.1", port, username: "tester", sessions: new Set(["s-posix"]) }]]);
  service.sessions = new Map([["s-posix", session]]);
  service.activeConnectionId = "conn-posix";
  service.terminalOutput = () => ({ append() {} });
  service.sessionLogStore = () => null;
  service.wakeWaiters = () => {};
  service.notifyStreamListeners = () => {};
  service.updateInputMirror = () => {};
  service.appendTerminalNotice = () => {};
  service.savedResourceNameList = () => [];
  service.prefillBlockedCommand = () => null;
  service.lineMark = () => 1;
  service.ledgerFor = () => ({ open: () => ({ commandId: "c-posix" }), markOutcome: () => {} });
  // 接到**真实** ssh2 通道（不是桩）
  service.execOnConnection = async (connectionId, command, _timeoutMs) => ({ ok: true, value: await realExec(command) });
  return { service, session };
}

const { service } = makeService();

// ── ① 预检在真实 POSIX 远端上必须被识别 ────────────────────────────────
{
  const probe = await realExec(probeCommand());
  const parsed = parseProbe(probe.stdout);
  assert.ok(["tmp", "home"].includes(parsed.kind),
    `POSIX 远端上预检应识别出可用目录（实际 ${parsed.kind}，stdout=${JSON.stringify(probe.stdout.slice(0, 160))}）`);
  console.log(`① 预检（真实 POSIX）→ kind=${parsed.kind} freeKb=${parsed.freeKb}`);
}

// ── ② 后台任务：走**远端**落点，不是降级 ──────────────────────────────
const started = await service.execBackground({ connectionId: "conn-posix", command: "echo hello-posix" });
assert.equal(started.ok, true, `远端任务应能下发：${started.error?.message}`);
assert.ok(["remote-tmp", "remote-home"].includes(started.value.location),
  `POSIX 远端应落远端（实际 ${started.value.location}）`);
assert.equal(started.value.degraded, false, "正常路径不该降级");
assert.ok(typeof started.value.remoteDir === "string" && started.value.remoteDir !== "", "要有远端任务目录");
console.log(`② 落点=${started.value.location} degraded=${started.value.degraded} remoteDir=${started.value.remoteDir}`);

// ── ③ 真实后台化：产物落在**远端**文件里 ─────────────────────────────
{
  const task = service.taskLedger().byId(started.value.taskId);
  const files = { out: `${task.remoteDir}/stdout.log`, exit: `${task.remoteDir}/exit.code` };
  // 等远端把 exit.code 写出来（命令很短，但后台化本身是异步的）
  let exitCode = null;
  for (let i = 0; i < 300; i += 1) {
    const read = await realExec(`[ -f ${files.exit} ] && cat ${files.exit} || echo NONE`);
    if (read.stdout.trim() !== "NONE") { exitCode = read.stdout.trim(); break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(exitCode, "0", `远端 exit.code 应为 0（实际 ${exitCode}）`);
  const out = await realExec(`cat ${files.out}`);
  assert.ok(out.stdout.includes("hello-posix"), `远端 stdout.log 应含真实输出（实际 ${JSON.stringify(out.stdout.slice(0, 120))}）`);
  console.log(`③ 远端产物 → exit.code=${exitCode} stdout=${JSON.stringify(out.stdout.trim().slice(0, 60))}`);

  // 状态查询（真实远端）
  const status = await service.taskStatus({ taskId: started.value.taskId });
  assert.equal(status.ok, true);
  assert.equal(status.value.state, "done", `远端状态应为 done（实际 ${status.value.state}）`);
  assert.equal(status.value.location, started.value.location);
  assert.equal(status.value.exitCode, 0);
  console.log(`④ taskStatus（远端）→ state=${status.value.state} exit=${status.value.exitCode}`);
}

// ── ⑤ 按行号读**远端**产物 ─────────────────────────────────────────────
{
  const read = await service.taskRead({ taskId: started.value.taskId, stream: "out" });
  assert.equal(read.ok, true);
  assert.ok(read.value.text.includes("hello-posix"), "读回的远端内容应含真实输出");
  assert.match(read.value.text, /^\s*\d{4} │ /m, "行号四位数格式");
  console.log(`⑤ taskRead（远端）→ ${read.value.totalLines} 行，首行 ${JSON.stringify(read.value.lines[0].text)}`);
}

// ── ⑥ 删除：远端目录真的消失 ───────────────────────────────────────────
{
  const task = service.taskLedger().byId(started.value.taskId);
  const dir = task.remoteDir;
  assert.equal((await realExec(`[ -d ${dir} ] && echo yes || echo no`)).stdout.trim(), "yes", "删除前远端目录存在");
  const deleted = await service.taskDelete({ taskId: started.value.taskId });
  assert.equal(deleted.ok, true);
  assert.equal((await realExec(`[ -d ${dir} ] && echo yes || echo no`)).stdout.trim(), "no", "删除后远端目录必须真的消失");
  assert.equal(service.taskLedger().byId(started.value.taskId).state, "deleted");
  console.log(`⑥ taskDelete（远端）→ 目录已消失，台账 state=deleted`);
}

// ── ⑦ 远端状态查询命令本身在真实 POSIX 上的解析 ────────────────────────
{
  const dir = service.taskLedger().byId(started.value.taskId).remoteDir;
  const deleted = await realExec(remoteStatusCommand({ dir }));
  const parsed = parseStatus(deleted.stdout);
  assert.equal(parsed.state, "missing", `已删目录应报 missing（实际 ${parsed.state}）`);
  console.log(`⑦ 远端状态解析（目录已删）→ state=${parsed.state}`);
}

client.end();
child.kill();

console.log("\nM4 端到端验收 · POSIX 正常路径：预检识别、远端落点、真实后台化、产物落远端、状态、按行读、远端删除全部通过");
