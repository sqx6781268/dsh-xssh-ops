// M4 端到端验收 · **POSIX shell 但缺 coreutils 的远端**（真实 SSH 通道）。
//
// 场景真实度：这等价于「精简容器 / busybox 缺 df-awk-mkdir」的远端 —— 现实里常见。
// 本机 Git Bash 的 usr/bin 几乎是空的（只有内建 echo/test），正好是这种远端。
//
// 要验的是**产品在这些远端上的行为是否正确**，不是「能不能跑成功」：
//   ① 预检：`$TMPDIR` 可写但拿不到空间数 ⇒ `TMP_OK` ⇒ 仍选远端（不白白降级）；
//   ② 包装：`mkdir` 缺失 ⇒ 必须回 `FAIL mkdir`，**不能**回 ready；
//   ③ host：识别 FAIL ⇒ 报 `background-start-failed` + 台账标 degraded-aborted，
//      并把远端 stderr 带进告警（用户能看到"到底为什么没起来"）；
//   ④ 这一整条路径**不得静默成功** —— 这是本测试的核心断言。
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import SshOpsService from "../src/index.js";
import { createLineJournal } from "../src/line-journal.js";
import { connectWithRetry } from "./helpers/wait-ready.mjs";

// 平台门控（CI 必需）：本用例用 **Windows 宿主** 的能力构造场景 ——
// `C:\Program Files\Git\usr\bin\sh.exe` 那个近乎空的 usr/bin 才是「POSIX 但缺
// coreutils」的远端。Linux/macOS runner 上这个前提不成立，场景根本构造不出来，
// 继续跑只会得到与产品无关的失败。**跳过并出声**，不伪装成通过；Windows 腿照跑。
if (process.platform !== "win32") {
  console.log(`SKIP: 本用例需要 Windows 宿主（用 Git Bash 的 sh.exe 构造缺 coreutils 的 POSIX 远端）；当前平台 ${process.platform}`);
  process.exit(0);
}

const POSIX_SHELL = "C:\\Program Files\\Git\\usr\\bin\\sh.exe";
const freePort = () => new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const port = await freePort();
const child = spawn(process.execPath, [
  fileURLToPath(new URL("../test-sshd.mjs", import.meta.url)), String(port), "--posix-shell", POSIX_SHELL,
  // **自控测试条件**：`--posix-path "!<空目录>"`（`!` 前缀 = 替换整个 PATH）⇒
  // `sh` 的 PATH 里**只有**这个空目录，没有任何 coreutils ⇒ 稳定模拟「缺
  // coreutils 的远端」。早期不传参数时，"df/awk 是否可用"取决于宿主 PATH ——
  // 我曾因此两次拿到相反结论（一次判"缺 coreutils"、一次实测 df 可用返回 38GB）。
  // 测试不该依赖宿主环境：要模拟什么条件，就显式构造什么条件。
  "--posix-path", `!${mkdtempSync(joinPath(tmpdir(), "xssh-bare-path-"))}`
,
  // 独立的 host key 路径：默认那个固定路径在**并发跑**时会撞车（多个进程同时
  // 生成并写同一个文件 ⇒ 偶发握手失败）。每个脚本用自己的。
  "--host-key", joinPath(mkdtempSync(joinPath(tmpdir(), "xssh-hostkey-")), "key.pem")
], { stdio: ["ignore", "pipe", "pipe"] });
child.stderr.on("data", () => {});
// 等服务器就绪**不靠固定睡眠**：下面用 connectWithRetry 反复真连，直到 TCP 层能连上。

const client = await connectWithRetry({ port });
const realExec = (command) => new Promise((resolve, reject) => {
  client.exec(command, (error, stream) => {
    if (error) { reject(error); return; }
    let stdout = "", stderr = "";
    stream.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    stream.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    stream.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
});
console.log(`已连上真实 SSH 服务器（POSIX shell，usr/bin 几乎为空）`);

function makeService() {
  const service = Object.create(SshOpsService.prototype);
  service.config = {
    maxBufferBytes: 65536, maxCaptureBytes: 65536,
    sessionLogEnabled: false, commandLedgerEnabled: false, commandIdleMs: 1500,
    lineJournalMaxLines: 2000, lineJournalMaxBytes: 512 * 1024,
    taskLedgerDir: mkdtempSync(joinPath(tmpdir(), "xssh-bare-ledger-")),
    localTmpDir: mkdtempSync(joinPath(tmpdir(), "xssh-bare-local-"))
  };
  service.settings = {};
  const session = {
    id: "s-bare", connectionId: "conn-bare", exited: null,
    stream: { write: () => {} }, lineJournal: createLineJournal(),
    shellIntegration: null, buffer: "", captureBuffer: "", waiters: [],
    streamListeners: new Set(), inputLine: "", inputKnown: true, loginScript: null
  };
  service.connections = new Map([["conn-bare", { host: "127.0.0.1", port, username: "tester", sessions: new Set(["s-bare"]) }]]);
  service.sessions = new Map([["s-bare", session]]);
  service.activeConnectionId = "conn-bare";
  service.terminalOutput = () => ({ append() {} });
  service.sessionLogStore = () => null;
  service.wakeWaiters = () => {};
  service.notifyStreamListeners = () => {};
  service.updateInputMirror = () => {};
  service.appendTerminalNotice = () => {};
  service.savedResourceNameList = () => [];
  service.prefillBlockedCommand = () => null;
  service.lineMark = () => 1;
  service.ledgerFor = () => ({ open: () => ({ commandId: "c-bare" }), markOutcome: () => {} });
  service.execOnConnection = async (connectionId, command) => ({ ok: true, value: await realExec(command) });
  return { service, session };
}

const { service } = makeService();
const { parseProbe, probeCommand, remoteWrapperCommand, remoteTaskDir } = await import("../src/task-dir.js");

// ── ① 预检：可写但空间未知 ⇒ 仍选远端 ─────────────────────────────────
{
  const probe = await realExec(probeCommand());
  const parsed = parseProbe(probe.stdout);
  assert.equal(parsed.kind, "tmp", `$TMPDIR 可写就该识别为可用（实际 ${parsed.kind}，stdout=${JSON.stringify(probe.stdout)}）`);
  assert.equal(parsed.freeKb, null, "没有 df/awk ⇒ 空间未知（而不是 0）");
  console.log(`① 预检 → kind=${parsed.kind} freeKb=${parsed.freeKb}（可写但空间未知）`);
}

// ── ② 包装在缺 mkdir 的远端上必须回 FAIL，不能回 ready ─────────────────
{
  const dir = remoteTaskDir("remote-tmp", "t000002-bare");
  const wrapper = await realExec(remoteWrapperCommand({ dir, command: "echo x" }));
  assert.ok(/FAIL\s+\w+/.test(wrapper.stdout),
    `缺 mkdir 时必须回 FAIL 而不是 ready（实际 stdout=${JSON.stringify(wrapper.stdout)}）`);
  assert.equal(wrapper.stdout.includes("ready"), false, "**绝不能**在这种情形下回 ready");
  console.log(`② 包装（缺 mkdir）→ stdout=${JSON.stringify(wrapper.stdout.trim())}（正确地报失败）`);
  assert.ok(wrapper.stderr.includes("mkdir"), `stderr 应说明是 mkdir 缺失（实际 ${JSON.stringify(wrapper.stderr.slice(0, 120))}）`);
}

// ── ③ host 识别 FAIL：报错 + 台账标 degraded-aborted + 带远端 stderr ────
{
  const started = await service.execBackground({ connectionId: "conn-bare", command: "echo hello" });
  assert.equal(started.ok, false, "远端建不了目录 ⇒ 整条下发必须失败（不得静默成功）");
  assert.equal(started.error.code, "background-start-failed");
  assert.match(started.error.message, /mkdir/, `要把远端 stderr 带进来帮排查（实际 ${started.error.message.slice(0, 200)}）`);
  // 台账状态必须如实
  const task = service.taskLedger().byId(started.value.taskId);
  assert.equal(task.state, "degraded-aborted", `台账要标失败（实际 ${task.state}）`);
  assert.match(task.warnings.join(" "), /mkdir/, "告警里要有远端的具体报错");
  console.log(`③ host → ${started.error.code}，台账 state=${task.state}，告警含远端 stderr`);
}

// ── ④ 该远端上没有"假成功"的任务留下 ──────────────────────────────────
{
  const list = service.taskList({});
  const running = list.value.tasks.filter((task) => task.state === "running");
  assert.equal(running.length, 0, "失败的远端任务不得留在 running 状态（那会被当成还在跑）");
  console.log(`④ 任务列表 → ${list.value.tasks.length} 条，无一条停留在 running`);
}

client.end();
child.kill();

console.log("\nM4 端到端验收 · 缺 coreutils 的 POSIX 远端：预检不误降级、包装不假报 ready、host 如实报失败并带远端原因");
