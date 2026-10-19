// 后台执行**工具层**的端到端验收（真实 SSH 通道）。
//
// 为什么单独一份：`exec-background-e2e.mjs` 走的是 **service 层**（直接调
// `service.execBackground(...)`），而 LLM 真正调用的是**工具层** —— 中间隔着
// 一层参数转换（`args.connection_id` → service 的 `connectionId`、
// `args.force_local` → `forceLocal`、蛇形转驼峰）与返回值裁剪。这层转换写错
// （参数名拼错、蛇形/驼峰搞混）会让工具**静默失效**：调用"成功"但参数被丢弃。
// m1-m3-e2e 走了工具层，这条一直没走。
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { connectWithRetry } from "./helpers/wait-ready.mjs";
import SshOpsService from "../src/index.js";
import { createLineJournal } from "../src/line-journal.js";

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
  console.log("跳过：本机没有可用的 POSIX shell —— 工具层真实通道需要它。");
  process.exit(0);
}

const freePort = () => new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const port = await freePort();
const child = spawn(process.execPath, [
  fileURLToPath(new URL("../test-sshd.mjs", import.meta.url)), String(port),
  "--posix-shell", POSIX_SHELL, "--posix-path", POSIX_PATH_PREFIX,
  "--host-key", joinPath(mkdtempSync(joinPath(tmpdir(), "xssh-hostkey-")), "key.pem")
], { stdio: ["ignore", "pipe", "pipe"] });
child.stderr.on("data", () => {});
const client = await connectWithRetry({ port });
console.log("已连上真实 SSH 服务器（工具层走蛇形参数 → service 驼峰参数的转换）");

const realExec = (command) => new Promise((resolve, reject) => {
  client.exec(command, (error, stream) => {
    if (error) { reject(error); return; }
    let stdout = "", stderr = "";
    stream.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    stream.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    stream.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
});

const service = Object.create(SshOpsService.prototype);
service.config = {
  maxBufferBytes: 65536, maxCaptureBytes: 65536,
  sessionLogEnabled: false, commandLedgerEnabled: false, commandIdleMs: 1500,
  lineJournalMaxLines: 2000, lineJournalMaxBytes: 512 * 1024,
  taskLedgerDir: mkdtempSync(joinPath(tmpdir(), "xssh-tool-")),
  localTmpDir: mkdtempSync(joinPath(tmpdir(), "xssh-tool-local-"))
};
service.settings = {};
const session = {
  id: "s-tool", connectionId: "conn-tool", exited: null,
  stream: null, lineJournal: createLineJournal(), shellIntegration: null,
  buffer: "", captureBuffer: "", waiters: [], streamListeners: new Set(),
  inputLine: "", inputKnown: true, loginScript: null, lastActivityAt: Date.now()
};
service.connections = new Map([["conn-tool", { host: "127.0.0.1", port, username: "tester", sessions: new Set(["s-tool"]) }]]);
service.sessions = new Map([["s-tool", session]]);
service.activeConnectionId = "conn-tool";
service.terminalOutput = () => ({ append() {} });
service.sessionLogStore = () => null;
service.wakeWaiters = () => {};
service.notifyStreamListeners = () => {};
service.updateInputMirror = () => {};
service.appendTerminalNotice = () => {};
service.savedResourceNameList = () => [];
service.prefillBlockedCommand = () => null;
service.lineMark = () => 1;
service.ledgerFor = () => ({ open: () => ({ commandId: "c-tool" }), markOutcome: () => {} });
service.execOnConnection = async (connectionId, command) => ({ ok: true, value: await realExec(command) });

// 注册**真实的工具层**
const tools = [];
service.registerTools({ tools: { register(tool) { tools.push(tool); } } });
const tool = (name) => {
  const found = tools.find((item) => item.name === name);
  assert.ok(found !== undefined, `工具 ${name} 应已注册`);
  return found;
};

// ── ① xssh_exec_background（**蛇形参数**）→ 真实下发 ────────────────────
//
// 关键：这里传的是 LLM 会传的**蛇形**参数（connection_id / label）——
// 工具层要正确把它们映射成 service 的驼峰参数。传错映射（如工具读
// args.connectionId 而非 args.connection_id）会让参数被静默丢弃。
const bg = await tool("xssh_exec_background").execute({
  connection_id: "conn-tool",
  command: "echo TOOL-E2E-CHECK",
  label: "tool-layer-check"
});
assert.equal(bg.location, "remote-tmp", `POSIX 远端应落远端（实际 ${bg.location}）`);
assert.equal(bg.degraded, false, "正常路径不该降级");
assert.ok(bg.taskId.length > 0, "要返回 taskId");
assert.ok(bg.remoteDir !== null && bg.remoteDir !== "", "要返回 remoteDir");
assert.ok(bg.commandId === "c-tool", `commandId 应来自命令台账（实际 ${JSON.stringify(bg.commandId)}）`);
console.log(`① exec_background（蛇形参数）→ ${bg.taskId} @ ${bg.remoteDir}`);

// 等远端真的写完 exit.code
let exitCode = null;
for (let i = 0; i < 200; i += 1) {
  const read = await realExec(`[ -f ${bg.remoteDir}/exit.code ] && cat ${bg.remoteDir}/exit.code || echo NONE`);
  if (read.stdout.trim() !== "NONE") { exitCode = read.stdout.trim(); break; }
  await new Promise((r) => setTimeout(r, 50));
}
assert.equal(exitCode, "0", `远端 exit.code 应为 0（实际 ${exitCode}）`);
console.log(`① 远端执行确认 → exit.code=0`);

// ── ② xssh_task op=status（蛇形 task_id）→ 真实远端状态 ───────────────
const status = await tool("xssh_task").execute({ op: "status", task_id: bg.taskId });
assert.equal(status.state, "done", `状态应为 done（实际 ${status.state}）`);
assert.equal(status.exitCode, 0, "退出码应回传");
assert.equal(status.location, "remote-tmp", "落点要如实");
assert.equal(status.outBytes > 0, true, `输出字节数要回传（实际 ${status.outBytes}）`);
console.log(`② task_status（task_id）→ state=${status.state} exit=${status.exitCode} out=${status.outBytes}B`);

// ── ③ xssh_task op=read（蛇形 task_id / tail_lines / from_line+to_line）────
const read = await tool("xssh_task").execute({ op: "read", task_id: bg.taskId, stream: "out" });
assert.ok(read.text.includes("TOOL-E2E-CHECK"), `按行号读应含真实输出（实际 ${JSON.stringify(read.text.slice(0, 200))}）`);
assert.match(read.text, /\d{4} │ /, "行号四位数格式");
assert.equal(read.hasMore, false, "全部读完时 hasMore 应为 false");
// 区间读法
const ranged = await tool("xssh_task").execute({ op: "read", task_id: bg.taskId, stream: "out", from_line: 1, to_line: 1 });
assert.ok(ranged.lines.length >= 1 && ranged.lines[0].line === 1, "from_line/to_line 要生效");
console.log(`③ task_read（蛇形参数）→ ${read.totalLines} 行，区间读 ${ranged.lines.length} 行`);

// ── ④ xssh_task op=list → 列表含刚建的任务，且 degraded 如实 ──────────
const list = await tool("xssh_task").execute({ op: "list" });
assert.ok(list.tasks.some((task) => task.taskId === bg.taskId), "列表应包含刚下发的任务");
const mine = list.tasks.find((task) => task.taskId === bg.taskId);
assert.equal(mine.state, "done", "列表里的状态要同步");
assert.equal(mine.location, "remote-tmp", "落点要如实");
console.log(`④ task_list → ${list.tasks.length} 条，含目标且状态同步`);

// ── ⑤ force_local（蛇形）→ 真实触发本地降级 ───────────────────────────
const forced = await tool("xssh_exec_background").execute({
  connection_id: "conn-tool",
  command: "echo FORCED-LOCAL",
  force_local: true
});
assert.equal(forced.location, "local", `force_local 应触发本地通道（实际 ${forced.location}）`);
assert.equal(forced.degraded, true, "本地通道必须标 degraded");
assert.ok(forced.warnings.length >= 3, `降级告警要齐（实际 ${forced.warnings.length} 条）`);
console.log(`⑤ force_local → 本地降级 + ${forced.warnings.length} 条告警`);
// 等本地执行体跑完并确认产物
let forcedDone = false;
for (let i = 0; i < 100 && !forcedDone; i += 1) {
  forcedDone = service.taskLedger().byId(forced.taskId)?.state === "done";
  if (!forcedDone) await new Promise((r) => setTimeout(r, 50));
}
assert.equal(forcedDone, true, "本地任务应跑完");
console.log(`⑤' 本地任务完成 → state=done`);

// ── ⑥ xssh_task op=delete（蛇形 task_id）→ 远端目录真的消失 ───────────
const before = await realExec(`[ -d ${bg.remoteDir} ] && echo yes || echo no`);
assert.equal(before.stdout.trim(), "yes", "删除前远端目录存在");
const deleted = await tool("xssh_task").execute({ op: "delete", task_id: bg.taskId });
assert.equal(deleted.deleted, true, "删除要成功");
const after = await realExec(`[ -d ${bg.remoteDir} ] && echo yes || echo no`);
assert.equal(after.stdout.trim(), "no", "删除后远端目录必须消失");
console.log(`⑥ task_delete → 远端目录已消失`);

// ── ⑦ 不存在的 task_id → 抛错且消息可读（不是 undefined）─────────────
for (const [op, args] of [
  ["status", { task_id: "t999999-none" }],
  ["read", { task_id: "t999999-none" }],
  ["delete", { task_id: "t999999-none" }]
]) {
  await assert.rejects(
    () => tool("xssh_task").execute({ op, ...args }),
    (error) => error instanceof Error && /does not exist/i.test(error.message),
    `xssh_task op=${op} 对不存在的任务要抛可读错误`
  );
}
console.log(`⑦ 不存在的 task_id → 三个 op 都抛可读错误`);

client.end();
child.kill();

console.log("\n后台执行工具层端到端（真实 SSH 通道）：蛇形→驼峰参数映射、五工具全链路、本地降级、删除、错误路径");
