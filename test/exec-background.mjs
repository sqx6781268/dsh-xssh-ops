// M4 工具层（后台执行与临时文件）：落点选择、降级告警必须回给调用方、
// ready 哨兵缺失必须报错、危险命令仍被拦、按行号读输出、删除任务。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import SshOpsService from "../src/index.js";
import { createLineJournal } from "../src/line-journal.js";
import { remoteTaskFiles } from "../src/task-dir.js";

/** 造一个能跑后台工具的 service 桩。 */
function makeHarness({ probeStdout = "OK 1048576", execResults = {}, allowLocalDegrade = true, ledgerDir = null } = {}) {
  const service = Object.create(SshOpsService.prototype);
  service.config = {
    maxBufferBytes: 65536, maxCaptureBytes: 65536,
    sessionLogEnabled: false, commandLedgerEnabled: false, commandIdleMs: 1500,
    lineJournalMaxLines: 2000, lineJournalMaxBytes: 512 * 1024,
    allowLocalDegrade,
    // 台账目录必须注入临时目录：不给的话 taskLedger() 会往**真实用户目录**
    // （~/.dsh/xssh-ops）写文件，测试会污染用户环境（实测发现已有 4 行残留）。
    taskLedgerDir: ledgerDir ?? mkdtempSync(joinPath(tmpdir(), "xssh-bg-")),
    // 本地降级目录同理
    localTmpDir: mkdtempSync(joinPath(tmpdir(), "xssh-bg-local-"))
  };
  const calls = [];
  const session = {
    id: "s-bg", connectionId: "conn-bg", exited: null,
    stream: { write: () => {} },
    lineJournal: createLineJournal(),
    shellIntegration: null,
    buffer: "", captureBuffer: "", waiters: [], streamListeners: new Set(),
    inputLine: "", inputKnown: true, loginScript: null
  };
  service.connections = new Map([["conn-bg", { host: "192.0.2.50", port: 22, username: "root", sessions: new Set(["s-bg"]) }]]);
  service.sessions = new Map([["s-bg", session]]);
  service.activeConnectionId = "conn-bg";
  service.terminalOutput = () => ({ append() {} });
  service.sessionLogStore = () => null;
  service.waiters = [];
  service.wakeWaiters = () => {};
  service.notifyStreamListeners = () => {};
  service.updateInputMirror = () => {};
  service.appendTerminalNotice = () => {};
  service.prefillBlockedCommand = () => ({ confirmationId: "confirm-bg" });
  service.savedResourceNameList = () => [];
  service.ledgerFor = (target) => {
    if (target.commandLedger === undefined || target.commandLedger === null) {
      target.commandLedger = { open: () => ({ commandId: "c-bg" }), markOutcome: () => {} };
    }
    return target.commandLedger;
  };
  service.lineMark = () => 1;

  // execOnConnection 桩：按命令内容分派。
  // **顺序要紧**：wrapper 里也含 `${TMPDIR:-/tmp}` 这个字面量，所以必须先判 setsid
  // 再判预检，否则 wrapper 会被误当成预检、返回没有 ready 的输出（实测踩到）。
  service.execOnConnection = async (connectionId, command) => {
    calls.push(command);
    if (command.includes("setsid nohup")) {
      const stdout = execResults.ready === false ? "" : "ready";
      return { ok: true, value: { stdout, stderr: "", exitCode: 0 } };
    }
    if (command.includes("df -Pk")) {
      return { ok: true, value: { stdout: probeStdout, stderr: "", exitCode: 0 } };
    }
    if (command.includes("EXIT") || command.includes("MISSING")) {
      return { ok: true, value: { stdout: "RUNNING\nBYTES 120 0", stderr: "", exitCode: 0 } };
    }
    if (command.includes("cat ")) {
      return { ok: true, value: { stdout: "line one\nline two\n", stderr: "", exitCode: 0 } };
    }
    if (command.includes("rm -rf")) {
      return { ok: true, value: { stdout: "cleaned", stderr: "", exitCode: 0 } };
    }
    return { ok: true, value: { stdout: "", stderr: "", exitCode: 0 } };
  };

  const tools = [];
  service.registerTools({ tools: { register(tool) { tools.push(tool); } } });
  return { service, calls, tools, session, tool: (name) => tools.find((item) => item.name === name) };
}

// ── 五个工具都注册上了 ───────────────────────────────────────────────────
{
  const { tools } = makeHarness();
  for (const name of ["xssh_exec_background", "xssh_task"]) {
    assert.ok(tools.some((tool) => tool.name === name), `注册了 ${name}`);
  }
}

// ── 空间充足 ⇒ 远端落点，无降级、无告警 ─────────────────────────────────
{
  const { service, calls } = makeHarness({ probeStdout: "OK 1048576" });
  const result = await service.execBackground({ connectionId: "conn-bg", command: "tar czf /root/b.tgz /root/s" });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.value.location, "remote-tmp");
  assert.equal(result.value.degraded, false);
  assert.deepEqual(result.value.warnings, []);
  assert.match(result.value.remoteDir, /\.dsh-xssh-ops\/t000001/);
  assert.match(result.value.outPath, /stdout\.log$/);
  // 预检只用一次往返，然后是包装执行
  assert.equal(calls.length, 2, "预检 1 次 + 启动 1 次");
  const task = service.taskLedger().byId(result.value.taskId);
  assert.equal(task.location, "remote-tmp");
  assert.equal(task.degraded, false);
  assert.equal(task.commandId, "c-bg", "与命令台账共用 commandId");
}

// ── 空间不足 ⇒ 降级本地，且告警必须回给调用方（不得静默）───────────────
{
  const { service } = makeHarness({ probeStdout: "OK 100" });
  const result = await service.execBackground({ connectionId: "conn-bg", command: "echo hi" });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.value.location, "local");
  assert.equal(result.value.degraded, true);
  assert.ok(result.value.warnings.length >= 3, "三重告警要齐");
  const joined = result.value.warnings.join(" ");
  assert.match(joined, /结果不留远端/);
  assert.match(joined, /断线即中断/);
  // 台账也要如实记录（日志页签复查）
  const task = service.taskLedger().byId(result.value.taskId);
  assert.equal(task.location, "local");
  assert.equal(task.degraded, true);
  assert.deepEqual(task.warnings, result.value.warnings);
}

// ── 远端无可用目录 ⇒ 降级（另一条路径）──────────────────────────────────
{
  const { service } = makeHarness({ probeStdout: "NONE" });
  const result = await service.execBackground({ connectionId: "conn-bg", command: "echo hi" });
  assert.equal(result.value.location, "local");
  assert.equal(result.value.degraded, true);
}

// ── 家目录落点 ⇒ 仍是远端，但有轻提示 ───────────────────────────────────
{
  const { service } = makeHarness({ probeStdout: "HOME" });
  const result = await service.execBackground({ connectionId: "conn-bg", command: "echo hi" });
  assert.equal(result.value.location, "remote-home");
  assert.equal(result.value.degraded, false);
  assert.equal(result.value.warnings.length, 1);
  assert.match(result.value.warnings[0], /家目录/);
}

// ── 禁用降级 ⇒ 明确拒绝，而不是偷偷降级 ─────────────────────────────────
{
  const { service } = makeHarness({ probeStdout: "NONE", allowLocalDegrade: false });
  const result = await service.execBackground({ connectionId: "conn-bg", command: "echo hi" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "no-usable-target");
}

// ── force_local ⇒ 跳过预检直接本地 ──────────────────────────────────────
{
  const { service, calls } = makeHarness();
  const result = await service.execBackground({ connectionId: "conn-bg", command: "echo hi", forceLocal: true });
  assert.equal(result.value.location, "local");
  assert.equal(result.value.degraded, true);
  assert.equal(calls.some((command) => command.includes("TMPDIR")), false, "强制本地不该再跑预检");
}

// ── ready 哨兵缺失 ⇒ 报错并标 degraded-aborted（不假装已启动）───────────
{
  const { service } = makeHarness({ execResults: { ready: false } });
  const result = await service.execBackground({ connectionId: "conn-bg", command: "echo hi" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "background-start-failed");
  const task = service.taskLedger().byId(result.value.taskId);
  assert.equal(task.state, "degraded-aborted", "必须如实标失败，不能留 running");
  assert.match(task.warnings.join(" "), /ready/);
}

// ── 危险命令仍被拦（后台工具不得静默执行）──────────────────────────────
{
  const { service, calls } = makeHarness();
  const result = await service.execBackground({ connectionId: "conn-bg", command: "rm -rf /" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unsafe-command");
  assert.equal(calls.length, 0, "危险命令不该发到远端");
  assert.equal(result.value.confirmationId, "confirm-bg", "要走确认卡片");
}

// ── 状态：远端为准，且回写台账 ──────────────────────────────────────────
{
  const { service } = makeHarness();
  const started = await service.execBackground({ connectionId: "conn-bg", command: "echo hi" });
  const status = await service.taskStatus({ taskId: started.value.taskId });
  assert.equal(status.ok, true);
  assert.equal(status.value.state, "running");
  assert.deepEqual(status.value.bytes, { out: 120, err: 0 });
  assert.equal(status.value.location, "remote-tmp");
  // 台账已同步
  assert.equal(service.taskLedger().byId(started.value.taskId).state, "running");
}

// ── 本地任务的状态走台账（不碰远端）────────────────────────────────────
{
  const { service, calls } = makeHarness({ probeStdout: "NONE" });
  const started = await service.execBackground({ connectionId: "conn-bg", command: "echo hi" });
  const before = calls.length;
  const status = await service.taskStatus({ taskId: started.value.taskId });
  assert.equal(status.value.location, "local");
  assert.equal(calls.length, before, "本地任务的状态查询不该再跑远端命令");
}

// ── 按行号读输出：远端用 cat，本地读文件 ───────────────────────────────
{
  const { service } = makeHarness();
  const started = await service.execBackground({ connectionId: "conn-bg", command: "echo hi" });
  const read = await service.taskRead({ taskId: started.value.taskId, stream: "out" });
  assert.equal(read.ok, true);
  assert.equal(read.value.totalLines, 2);
  assert.equal(read.value.lines[0].text, "line one");
  assert.match(read.value.text, /^\d{4} │ line one$/m, "四位数行号");

  // tail 模式
  const tail = await service.taskRead({ taskId: started.value.taskId, tailLines: 1 });
  assert.equal(tail.value.lines.length, 1);
  assert.equal(tail.value.lines[0].text, "line two");
}

// ── 任务不存在时的错误要可判断 ──────────────────────────────────────────
{
  const { service } = makeHarness();
  assert.equal((await service.taskStatus({ taskId: "nope" })).error.code, "no-task");
  assert.equal((await service.taskRead({ taskId: "nope" })).error.code, "no-task");
  assert.equal((await service.taskDelete({ taskId: "nope" })).error.code, "no-task");
}

// ── 删除：远端发 rm -rf 并标台账 ────────────────────────────────────────
{
  const { service, calls } = makeHarness();
  const started = await service.execBackground({ connectionId: "conn-bg", command: "echo hi" });
  const deleted = await service.taskDelete({ taskId: started.value.taskId });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.value.deleted, true);
  const dir = remoteTaskFiles(service.taskLedger().byId(started.value.taskId).remoteDir).stdout;
  assert.match(dir, /stdout\.log/);
  assert.equal(calls.some((command) => command.includes("rm -rf")), true, "远端目录要被删");
  assert.equal(service.taskLedger().byId(started.value.taskId).state, "deleted");
}

// ── 空命令直接拒绝 ──────────────────────────────────────────────────────
{
  const { service } = makeHarness();
  const result = await service.execBackground({ connectionId: "conn-bg", command: "" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "empty-command");
}

// ── 任务列表：倒序、可过滤连接、降级标记如实 ────────────────────────────
{
  const { service } = makeHarness({ probeStdout: "NONE" });
  await service.execBackground({ connectionId: "conn-bg", command: "first" });
  await service.execBackground({ connectionId: "conn-bg", command: "second" });
  const list = service.taskList({});
  assert.equal(list.value.tasks.length, 2);
  assert.equal(list.value.tasks[0].command, "second", "最近的在前");
  assert.equal(list.value.tasks[0].degraded, true, "降级标记要如实");
}

// ── 本地降级通道的执行体（此前完全没有覆盖）────────────────────────────
//
// 这段补上计划 5.5.5 里最容易被漏测的一环：降级到本地之后，产物到底有没有
// 真的写到本地文件、退出码有没有落、台账状态有没有跟着变。
{
  const { service } = makeHarness({ probeStdout: "NONE" });
  // 本地通道的实际执行：桩成「远端命令直接回输出」。
  service.execOnConnection = async (connectionId, command) => {
    if (command.includes("df -Pk")) return { ok: true, value: { stdout: "NONE", stderr: "", exitCode: 0 } };
    return { ok: true, value: { stdout: "hello from local\n", stderr: "warn line\n", exitCode: 0 } };
  };

  const started = await service.execBackground({ connectionId: "conn-bg", command: "echo hello" });
  assert.equal(started.value.location, "local");
  const taskId = started.value.taskId;

  // 本地执行体是 fire-and-forget：轮询等它把状态写成 done。
  let task = service.taskLedger().byId(taskId);
  for (let i = 0; i < 60 && task.state === "running"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    task = service.taskLedger().byId(taskId);
  }
  assert.equal(task.state, "done", `本地任务应跑完（实际 ${task.state}）`);
  assert.equal(task.exitCode, 0, "退出码要落台账");
  assert.ok(task.bytes.out > 0, "输出字节数要记上");
  assert.ok(task.localDir !== null, "本地目录要记上（此前 update 会丢弃它）");

  // 产物文件必须真的存在，且内容正确
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(joinPath(task.localDir, "stdout.log"), "utf8"), "hello from local\n", "stdout 落文件");
  assert.equal(readFileSync(joinPath(task.localDir, "stderr.log"), "utf8"), "warn line\n", "stderr 落文件");
  assert.equal(readFileSync(joinPath(task.localDir, "exit.code"), "utf8"), "0", "退出码落文件");

  // 本地任务的 taskRead 读的是本地文件（不该再跑远端命令）
  const read = await service.taskRead({ taskId, stream: "out" });
  assert.equal(read.ok, true);
  assert.equal(read.value.lines[0].text, "hello from local");

  // 失败路径：命令报错时台账要标 degraded-aborted，而不是留 running
  const { service: failing } = makeHarness({ probeStdout: "NONE" });
  failing.execOnConnection = async (connectionId, command) => {
    if (command.includes("df -Pk")) return { ok: true, value: { stdout: "NONE", stderr: "", exitCode: 0 } };
    return { ok: false, error: { message: "transport died" } };
  };
  const failed = await failing.execBackground({ connectionId: "conn-bg", command: "echo x" });
  let failedTask = failing.taskLedger().byId(failed.value.taskId);
  for (let i = 0; i < 60 && failedTask.state === "running"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    failedTask = failing.taskLedger().byId(failed.value.taskId);
  }
  assert.equal(failedTask.state, "degraded-aborted", "失败要如实标，不能留 running");
  assert.equal(failedTask.exitCode, 255);
}

console.log("background tools: placement, degradation warnings, ready sentinel, blocked commands, local channel and line reads all hold");
