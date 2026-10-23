// 命令台账：区间闭口三判据（先到先定）、回显行不进区间、下一条命令截断、
// 脱敏落盘（Q10）、JSONL 重载（后写覆盖先写）、prune（Q5）、查询语义。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import SshOpsService from "../src/index.js";
import { createLineJournal } from "../src/line-journal.js";
import { ShellIntegrationTracker } from "../src/shell-integration.js";
import {
  COMMAND_SOURCES,
  DEFAULT_IDLE_CLOSE_MS,
  DEFAULT_RETENTION_COUNT,
  DEFAULT_RETENTION_DAYS,
  createCommandLedger,
  createCommandLedgerStore
} from "../src/command-ledger.js";

/** 固定时钟 + 可预测 ID：让区间与时间的断言完全确定。 */
function makeLedger(options = {}) {
  let clock = 1_700_000_000_000;
  const ledger = createCommandLedger({
    sessionId: "s-1",
    connectionId: "conn-1",
    host: "192.0.2.10",
    now: () => clock,
    idFactory: (seq) => `c${String(seq).padStart(7, "0")}-test`,
    ...options
  });
  return { ledger, advance: (ms) => { clock += ms; }, at: () => clock };
}

// ── 默认值就是用户/计划拍板的数字 ──────────────────────────────────────────
{
  assert.equal(DEFAULT_IDLE_CLOSE_MS, 1500, "判据②空闲静默默认 1500 ms");
  assert.equal(DEFAULT_RETENTION_DAYS, 7, "Q5 建议保留 7 天");
  assert.equal(DEFAULT_RETENTION_COUNT, 5000, "Q5 建议保留 5000 条");
  assert.ok(COMMAND_SOURCES.includes("login-script"));
}

// ── 新增来源必须保真，登录后命令默认隐藏但仍可显式查询 ─────────────────
{
  const { ledger } = makeLedger();
  for (const source of ["user-broadcast", "login-post", "login-script"]) {
    assert.equal(ledger.open({ text: `echo ${source}`, source, markLine: 1 }).source, source);
  }
  assert.deepEqual(ledger.recent().map((record) => record.source), ["user-broadcast"]);
  assert.equal(ledger.recent({ includeHidden: true }).length, 3);
  assert.deepEqual(ledger.recent({ source: "login-post" }).map((record) => record.source), ["login-post"]);
  const service = Object.create(SshOpsService.prototype);
  service.sessions = new Map([["s-1", { commandLedger: ledger }]]);
  assert.deepEqual(service.listCommands().value.commands.map((record) => record.source), ["user-broadcast"]);
  assert.equal(service.listCommands({ source: "login-post" }).value.commands.length, 1);
}

// ── 批量发送走真实 Host 发送入口后仍保留来源 ───────────────────────────
{
  const { ledger } = makeLedger();
  const written = [];
  const session = { id: "s-1", connectionId: "conn-1", exited: null, stream: { write: (text) => written.push(text) }, commandLedger: ledger };
  const service = Object.create(SshOpsService.prototype);
  service.sessions = new Map([[session.id, session]]);
  service.lineMark = () => 1;
  service.updateInputMirror = () => {};
  service.scheduleIdleClose = () => {};
  const result = await service.sendCommand({ sessionId: session.id, text: "echo broadcast", source: "user-broadcast" });
  assert.equal(result.ok, true);
  assert.deepEqual(written, ["echo broadcast\r"]);
  assert.equal(ledger.recent()[0].source, "user-broadcast");
}

// ── 按命令 ID 读取多行输出保留真实换行 ─────────────────────────────────
{
  const { ledger } = makeLedger();
  const journal = createLineJournal();
  journal.append("echo fixture\nfirst\nsecond\n");
  const record = ledger.open({ text: "echo fixture", markLine: 1 });
  ledger.closeFromShellIntegration({ endLine: 3, exitCode: 0 });
  const service = Object.create(SshOpsService.prototype);
  service.sessions = new Map([["s-1", { commandLedger: ledger, lineJournal: journal }]]);
  const result = await service.readCommandOutput({ commandId: record.commandId, waitMs: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.value.text, "first\nsecond", "换行不能变成字面反斜杠 n");
}

// ── 回显行不进区间：startLine = markLine + 1 ───────────────────────────────
{
  const { ledger } = makeLedger();
  // 行日志 nextLine()=100 表示「命令回显将占第 100 行」。
  const record = ledger.open({ text: "echo A", markLine: 100, source: "user-editbox" });
  assert.equal(record.startLine, 101, "命令自己的回显行不算输出");
  assert.equal(record.endLine, null);
  assert.equal(record.status, "running");
  assert.equal(record.seq, 1);
  assert.equal(record.source, "user-editbox");
  assert.equal(record.host, "192.0.2.10");
}

// ── 判据①：shell-integration 的 OSC 133 D 闭口，带 exit code ───────────────
{
  const { ledger } = makeLedger();
  ledger.open({ text: "echo A", markLine: 100 });
  ledger.noteOutput({ lastLine: 103 });
  const closed = ledger.closeFromShellIntegration({ endLine: 103, exitCode: 0 });
  assert.equal(closed.endLine, 103);
  assert.equal(closed.exitCode, 0);
  assert.equal(closed.closedBy, "shell-integration");
  assert.equal(closed.status, "done");
  assert.equal(ledger.openRecords().length, 0);
}

// ── closeFromExec：exec 通道的确定性闭口（xssh_exec 留痕链路，2026-10-19） ──
{
  const { ledger, advance } = makeLedger();
  const record = ledger.open({ text: "uptime", markLine: 200, source: "agent-tool", pressEnter: true });
  assert.equal(record.source, "agent-tool", "source=agent-tool 是合法枚举值");
  assert.equal(record.status, "running");
  ledger.noteOutput({ lastLine: 204 });
  advance(10);
  const closed = ledger.closeFromExec({ endLine: 204, exitCode: 0 });
  assert.equal(closed.closedBy, "exec");
  assert.equal(closed.status, "done", "exec 闭口即 done，不等空闲判定");
  assert.equal(closed.endLine, 204);
  assert.equal(closed.exitCode, 0);
  // 先到先定：闭口后 openId 已清空，再次闭口返回 null（与 closeFromShellIntegration 同约定）
  const again = ledger.closeFromExec({ endLine: 999, exitCode: 1 });
  assert.equal(again, null, "无未闭口记录时返回 null");
  assert.equal(ledger.byId(record.commandId).endLine, 204, "原记录不被改写");
  assert.equal(ledger.byId(record.commandId).exitCode, 0);
  // 非正常退出码也能闭口
  ledger.open({ text: "false", markLine: 300, source: "agent-tool" });
  const failed = ledger.closeFromExec({ endLine: 301, exitCode: 1 });
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.status, "done");
}

// ── 判据②：空闲静默，且阈值前不闭口 ────────────────────────────────────────
{
  const { ledger, advance } = makeLedger();
  ledger.open({ text: "sleep 1", markLine: 10 });
  ledger.noteOutput({ lastLine: 12 });
  advance(1400);
  assert.equal(ledger.closeIfIdle({ lastLine: 12 }), null, "未到 1500 ms 不闭口");
  advance(200);
  const closed = ledger.closeIfIdle({ lastLine: 12 });
  assert.equal(closed.closedBy, "idle-timeout");
  assert.equal(closed.exitCode, null, "空闲闭口拿不到 exit code");
  assert.equal(closed.status, "done");
}

// ── 判据③：下一条命令发出 ⇒ 上一条被截断，且止于新命令回显之前 ──────────────
{
  const { ledger } = makeLedger();
  const first = ledger.open({ text: "echo A", markLine: 100 });
  ledger.noteOutput({ lastLine: 105 });
  // 第二条命令的回显将占第 106 行。
  const second = ledger.open({ text: "echo B", markLine: 106 });
  assert.equal(first.closedBy, "next-command");
  assert.equal(first.endLine, 105, "上一条止于新命令回显之前，两条区间不重叠");
  assert.equal(second.startLine, 107);
  const rangeA = ledger.outputOf(first.commandId);
  const rangeB = ledger.outputOf(second.commandId);
  assert.ok(rangeA.endLine < rangeB.startLine, `区间必须不重叠：${rangeA.endLine} < ${rangeB.startLine}`);
}

// ── 先到先定：闭口后任何后到的判据都不得改写区间 ────────────────────────────
{
  const { ledger, advance } = makeLedger();
  ledger.open({ text: "echo A", markLine: 100 });
  ledger.noteOutput({ lastLine: 103 });
  ledger.closeFromShellIntegration({ endLine: 103, exitCode: 0 });   // 判据①先到
  advance(5000);
  assert.equal(ledger.closeIfIdle({ lastLine: 999 }), null, "已闭口就不再被空闲定时器改写");
  ledger.noteOutput({ lastLine: 999 });
  const out = ledger.outputOf(ledger.recent()[0].commandId);
  assert.equal(out.endLine, 103, "区间保持第一次闭口的取值");
  // 再发一条也不会把已闭口的那条重算
  ledger.open({ text: "echo B", markLine: 200 });
  assert.equal(out.endLine, 103);
}

// ── TUI 前台：标 interactive 且不闭口 ─────────────────────────────────────
{
  const { ledger, advance } = makeLedger();
  const record = ledger.open({ text: "top", markLine: 10 });
  ledger.markInteractive();
  advance(10_000);
  assert.equal(ledger.closeIfIdle({ lastLine: 40 }), null, "TUI 前台期间不闭口");
  assert.equal(ledger.byId(record.commandId).status, "interactive");
  // 会话结束时仍然要收口，否则记录永远挂着
  const closed = ledger.closeAll({ lastLine: 40 });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].closedBy, "session-end");
}

// ── 会话结束：所有未闭口记录收口 ──────────────────────────────────────────
{
  const { ledger } = makeLedger();
  ledger.open({ text: "echo A", markLine: 10 });
  ledger.open({ text: "echo B", markLine: 20 });
  // 第二条 open 时第一条已被 next-command 闭口；再手工制造一条真正未闭口的
  const open = ledger.open({ text: "tail -f x", markLine: 30 });
  const closed = ledger.closeAll({ lastLine: 33 });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].commandId, open.commandId);
  assert.equal(closed[0].closedBy, "session-end");
  assert.equal(closed[0].status, "unknown", "会话结束拿不到 exit code ⇒ unknown，不是 done");
}

// ── 落盘脱敏（Q10 = 脱敏后存）：内存与磁盘一致 ──────────────────────────────
{
  const { ledger } = makeLedger();
  const secret = ledger.open({ text: "export API_KEY=abcdef123 PASSWORD=hunter2", markLine: 1 });
  assert.equal(secret.redacted, true, "留下「被掩码过」的痕迹");
  assert.equal(secret.text.includes("hunter2"), false, "内存里也不留原文");
  assert.match(secret.text, /API_KEY=\*\*\*/);
  const plain = ledger.open({ text: "echo A", markLine: 5 });
  assert.equal(plain.redacted, false);
  assert.equal(plain.text, "echo A");
}

// ── 查询：byId / byText 精确与子串 / recent / outputOf ────────────────────
{
  const { ledger } = makeLedger();
  const a = ledger.open({ text: "echo A", markLine: 10 });
  ledger.closeFromShellIntegration({ endLine: 12, exitCode: 0 });
  const b = ledger.open({ text: "echo B", markLine: 20 });
  ledger.closeFromShellIntegration({ endLine: 22, exitCode: 0 });
  const c = ledger.open({ text: "echo A", markLine: 30 });
  ledger.closeFromShellIntegration({ endLine: 32, exitCode: 1 });

  assert.equal(ledger.byId(a.commandId).commandId, a.commandId);
  assert.equal(ledger.byId("nope"), null);

  // 精确匹配返回最近一条（c 比 a 新）
  assert.equal(ledger.byText("echo A").length, 1);
  assert.equal(ledger.byText("echo A")[0].commandId, c.commandId);
  // 首尾空白不影响精确匹配
  assert.equal(ledger.byText("  echo A  ")[0].commandId, c.commandId);
  // 子串模式返回候选（最近在前）
  const candidates = ledger.byText("echo", { match: "substring" });
  assert.deepEqual(candidates.map((r) => r.text), ["echo A", "echo B", "echo A"]);
  assert.equal(ledger.byText("", { match: "substring" }).length, 0);

  assert.deepEqual(ledger.recent().map((r) => r.text), ["echo A", "echo B", "echo A"]);
  assert.equal(ledger.recent({ limit: 2 }).length, 2);

  const out = ledger.outputOf(c.commandId);
  assert.equal(out.startLine, 31);
  assert.equal(out.endLine, 32);
  assert.equal(out.exitCode, 1);
  assert.equal(out.empty, false);
  assert.equal(b.commandId === c.commandId, false);
}

// ── 没有输出的命令：empty 为真，而不是给出反向区间 ────────────────────────
{
  const { ledger } = makeLedger();
  const record = ledger.open({ text: "true", markLine: 10 });
  ledger.closeFromShellIntegration({ endLine: undefined, exitCode: 0 });
  const out = ledger.outputOf(record.commandId);
  assert.equal(out.endLine, out.startLine - 1, "无输出时 endLine = startLine - 1");
  assert.equal(out.empty, true);
}

// ── 保活/登录脚本默认被列表过滤，但保留可显式查询 ──────────────────────────
{
  const { ledger } = makeLedger();
  ledger.open({ text: "echo A", markLine: 10, source: "user-editbox" });
  const keepalive = ledger.open({ text: "\u0000", markLine: 20, source: "login-script" });
  assert.equal(ledger.recent().length, 1, "默认不把 login-script 混进命令列表");
  assert.equal(ledger.recent({ includeHidden: true }).length, 2, "显式查询仍能拿到证据");
  assert.equal(ledger.recent({ source: "login-script" }).length, 1);
  assert.equal(ledger.byText("echo A").length, 1);
  assert.equal(ledger.byText("\u0000").length, 0, "保活字符串不算用户命令");
  assert.equal(ledger.byId(keepalive.commandId).source, "login-script");
}

// ── 行日志淘汰：区间早于保留区 ⇒ truncated 为真 ────────────────────────────
{
  const { ledger } = makeLedger();
  const record = ledger.open({ text: "echo A", markLine: 10 });
  ledger.closeFromShellIntegration({ endLine: 12, exitCode: 0 });
  ledger.markTruncated(record.commandId, 50);
  assert.equal(ledger.outputOf(record.commandId).truncated, true, "startLine=11 < firstLine=50");
  const fresh = ledger.open({ text: "echo B", markLine: 60 });
  ledger.markTruncated(fresh.commandId, 50);
  assert.equal(ledger.outputOf(fresh.commandId).truncated, false, "区间还在保留区里就不算截断");
}

// ── JSONL 落盘 / 重载（后写覆盖先写）/ prune ──────────────────────────────
{
  const dir = await mkdtemp(joinPath(tmpdir(), "xssh-ledger-"));
  try {
    const store = createCommandLedgerStore({ dir });
    // 收集落盘 promise 而不是 sleep 等：全量测试是并行跑的，固定等待会变成不稳定用例。
    const writes = [];
    const { ledger } = makeLedger({ onRecord: (record) => { writes.push(store.append(record.sessionId, record)); } });

    const a = ledger.open({ text: "echo A", markLine: 10 });
    ledger.closeFromShellIntegration({ endLine: 12, exitCode: 0 });
    const b = ledger.open({ text: "echo B", markLine: 20 });
    ledger.closeFromShellIntegration({ endLine: 22, exitCode: 7 });
    await Promise.all(writes);

    const raw = await readFile(store.fileOf("s-1"), "utf8");
    const lines = raw.trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(lines.length >= 4, `open/update 各一行（实际 ${lines.length}）`);

    const restored = await store.load("s-1");
    assert.equal(restored.length, 2, "同一 commandId 的多行合并成一条");
    const byId = new Map(restored.map((r) => [r.commandId, r]));
    assert.equal(byId.get(a.commandId).endLine, 12, "重载后取的是后写（闭口）那条");
    assert.equal(byId.get(b.commandId).exitCode, 7);

    // 重载进新台账：seq 续号，不重复 ID
    const revived = createCommandLedger({ sessionId: "s-1" });
    assert.equal(revived.restore(restored), 2);
    const next = revived.open({ text: "echo C", markLine: 30 });
    assert.ok(next.seq > b.seq, `seq 必须续号（${next.seq} > ${b.seq}）`);

    // 缺文件不报错
    assert.deepEqual(await store.load("never-existed"), []);

    // prune：按条数（保留最后 1 条）
    assert.equal(await store.prune("s-1", { count: 1, days: 0 }), 1);
    const kept = await store.load("s-1");
    assert.equal(kept.length, 1);

    // prune：按天数。基准时间必须显式给：本用例用的是固定时钟（2023），
    // 拿真实 Date.now() 当基准的话这条记录必然「过期」，测的就不是天数阈值了。
    const issued = Date.parse(kept[0].issuedAt);
    assert.equal(await store.prune("s-1", { days: DEFAULT_RETENTION_DAYS, count: DEFAULT_RETENTION_COUNT, at: issued + 1000 }), 1,
      "窗口内不该被删");
    assert.equal(await store.prune("s-1", { days: DEFAULT_RETENTION_DAYS, count: DEFAULT_RETENTION_COUNT, at: issued + 8 * 24 * 3600 * 1000 }), 0,
      "超过 7 天应被清理");
    assert.deepEqual(await store.load("s-1"), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── 坏行/半行不毁掉整份台账 ────────────────────────────────────────────────
{
  const dir = await mkdtemp(joinPath(tmpdir(), "xssh-ledger-bad-"));
  try {
    const store = createCommandLedgerStore({ dir });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(store.fileOf("s-2"), [
      JSON.stringify({ commandId: "c1", text: "echo A", seq: 1, issuedAt: new Date().toISOString() }),
      "{ 半行被截断",
      "not json at all",
      JSON.stringify({ commandId: "c2", text: "echo B", seq: 2, issuedAt: new Date().toISOString() }),
      ""
    ].join("\n"), "utf8");
    const loaded = await store.load("s-2");
    assert.equal(loaded.length, 2, "坏行跳过，好行保留");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── host 侧接线：sendCommand 先记台账再写终端；危险命令不发送 ──────────────
{
  const service = Object.create(SshOpsService.prototype);
  service.config = {
    maxBufferBytes: 65536,
    maxCaptureBytes: 65536,
    sessionLogEnabled: false,
    commandLedgerEnabled: false,   // 本用例不落盘
    commandIdleMs: DEFAULT_IDLE_CLOSE_MS
  };
  const written = [];
  const session = {
    id: "s-live",
    connectionId: "conn-live",
    exited: null,
    stream: { write: (value) => written.push(value) },
    lineJournal: createLineJournal(),
    shellIntegration: new ShellIntegrationTracker(),
    buffer: "",
    captureBuffer: "",
    waiters: [],
    streamListeners: new Set(),
    inputLine: "",
    inputKnown: true
  };
  service.connections = new Map([["conn-live", { host: "192.0.2.10", sessions: new Set(["s-live"]) }]]);
  service.sessions = new Map([["s-live", session]]);
  // 与用例无关的旁路：录制、唤醒、订阅、输入镜像、确认卡片、终端提示
  service.terminalOutput = () => ({ append() {} });
  service.sessionLogStore = () => null;
  service.wakeWaiters = () => {};
  service.notifyStreamListeners = () => {};
  service.updateInputMirror = () => {};
  service.appendTerminalNotice = () => {};
  service.prefillBlockedCommand = () => ({ confirmationId: "confirm-1" });

  const sent = await service.sendCommand({ connectionId: "conn-live", text: "echo A", pressEnter: true });
  assert.equal(sent.ok, true);
  assert.equal(sent.value.sent, true);
  assert.equal(sent.value.blocked, false);
  assert.equal(sent.value.startLine, 2, "台账已因回显行把 startLine 推到 markLine+1（首条 markLine=1）");
  assert.deepEqual(written, ["echo A\r"], "pressEnter 才补回车");

  const ledger = service.ledgerFor(session);
  assert.equal(ledger.size(), 1);
  assert.equal(ledger.recent()[0].source, "user-editbox", "编辑框来源必须标出来");
  assert.equal(ledger.recent()[0].status, "running");

  // 判据① 端到端：输出里出现 OSC 133 D ⇒ 立刻闭口并带 exit code
  service.appendSessionOutput(session, "echo A\r\necho A\r\n");
  service.appendSessionOutput(session, "\u001b]133;D;7\u0007");
  const closed = ledger.byId(sent.value.commandId);
  assert.equal(closed.closedBy, "shell-integration");
  assert.equal(closed.exitCode, 7, "exit code 必须来自 shell-integration");
  assert.equal(closed.status, "done");
  assert.ok(closed.endLine >= closed.startLine, "有输出时区间闭口在开始行之后");

  // 不用回车（pressEnter:false）时不写 \r，状态是 sent 而不是 running
  const typed = await service.sendCommand({ connectionId: "conn-live", text: "echo B", pressEnter: false });
  assert.equal(typed.value.sent, true);
  assert.equal(written[written.length - 1], "echo B");
  assert.equal(ledger.byId(typed.value.commandId).status, "sent");

  // 危险命令：不写终端、弹卡片、台账记 blocked 且不占区间
  const before = written.length;
  const danger = await service.sendCommand({ connectionId: "conn-live", text: "rm -rf /", pressEnter: true });
  assert.equal(danger.ok, true);
  assert.equal(danger.value.blocked, true);
  assert.equal(danger.value.sent, false);
  assert.equal(danger.value.confirmationId, "confirm-1");
  assert.equal(written.length, before, "危险命令绝不能悄悄写进终端");
  const blockedRecord = ledger.byId(danger.value.commandId);
  assert.equal(blockedRecord.status, "blocked");
  assert.equal(blockedRecord.endLine, blockedRecord.startLine - 1, "被拦下的命令不占输出区间");
  // 判据③顺带验证：这条被拦下的命令既然「发出」了，上一条就得按 next-command 收口。
  assert.equal(ledger.byId(typed.value.commandId).closedBy, "next-command");

  // 空命令直接拒绝
  const empty = await service.sendCommand({ connectionId: "conn-live", text: "" });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, "empty-command");

  // ── 计划 M2 验收：编辑框连发 echo A / echo B ⇒ 台账两条，且区间不重叠 ──
  {
    const freshSession = {
      id: "s-accept",
      connectionId: "conn-accept",
      exited: null,
      stream: { write: () => {} },
      lineJournal: createLineJournal(),
      shellIntegration: null,
      buffer: "",
      captureBuffer: "",
      waiters: [],
      streamListeners: new Set()
    };
    service.connections.set("conn-accept", { host: "192.0.2.11", sessions: new Set(["s-accept"]) });
    service.sessions.set("s-accept", freshSession);

    const first = await service.sendCommand({ connectionId: "conn-accept", text: "echo A", pressEnter: true });
    service.appendSessionOutput(freshSession, "echo A\r\nA\r\n");
    const second = await service.sendCommand({ connectionId: "conn-accept", text: "echo B", pressEnter: true });
    service.appendSessionOutput(freshSession, "echo B\r\nB\r\n");

    const accept = service.ledgerFor(freshSession);
    const list = accept.recent({ limit: 10 });
    assert.equal(list.length, 2, "两条命令都要在台账里（旧的在前，recent 倒序）");
    assert.deepEqual(list.map((r) => r.text), ["echo B", "echo A"]);

    const outFirst = accept.outputOf(first.value.commandId);
    const outSecond = accept.outputOf(second.value.commandId);
    assert.equal(outFirst.closedBy, "next-command", "第二条发出时第一条按判据③截断");
    assert.ok(outFirst.endLine < outSecond.startLine,
      `区间必须不重叠：A 止于 ${outFirst.endLine}，B 起于 ${outSecond.startLine}`);
    assert.equal(outFirst.startLine, 2, "A 的回显占第 1 行，输出从第 2 行起");
    assert.equal(outSecond.startLine, 4, "B 的回显占第 3 行，输出从第 4 行起");

    // 按命令内容取区间（计划 R4：智能体用命令内容或 ID 取回输出）
    assert.equal(accept.byText("echo A")[0].commandId, first.value.commandId);
  }

  // 会话结束：未闭口记录收口（拿不到 exit code ⇒ unknown，不能假装 done）
  const lingering = await service.sendCommand({ connectionId: "conn-live", text: "tail -f /var/log/syslog", pressEnter: true });
  assert.equal(ledger.byId(lingering.value.commandId).endLine, null, "长跑命令此时仍未闭口");
  service.removePendingForSession = () => {};
  service.recordExit(session, { code: 0 });
  const ended = ledger.byId(lingering.value.commandId);
  assert.equal(ended.closedBy, "session-end");
  assert.equal(ended.status, "unknown", "会话结束拿不到 exit code，不能标 done");
  assert.equal(ledger.openRecords().length, 0, "不该留下永远挂着的记录");
}

// ── closedAt 与注入时刻 `at` ──────────────────────────────────────────────
//
// 这段的存在理由：`closeRecord` 曾经**完全忽略** `at`、总是用模块内部 now()，
// 于是 `closeFromShellIntegration({at})` / `closeIfIdle` 的判定时刻与记录时刻
// 可能来自两条时间线。lint 的 no-unused-vars 报了"声明了不用"，但行为上没人发现
// —— 因为 closedAt 此前**根本没有测试覆盖**。这里把它钉住。
{
  let clock = 1_700_000_000_000;
  const ledger = createCommandLedger({ sessionId: "s-at", now: () => clock });

  // 判据①：注入的时刻必须落到 closedAt 上
  const a = ledger.open({ text: "echo A", markLine: 1 });
  clock += 1234;
  const injected = clock + 60_000;
  ledger.closeFromShellIntegration({ endLine: 3, exitCode: 0, at: injected });
  assert.equal(ledger.byId(a.commandId).closedAt, new Date(injected).toISOString(),
    "closeFromShellIntegration 的 at 必须生效（不能用内部 now() 顶替）");

  // 判据②：closeIfIdle 的判定与记录用同一个时刻
  const b = ledger.open({ text: "echo B", markLine: 10 });
  const outputAt = clock;                    // 最后一次输出就在此刻
  ledger.noteOutput({ at: outputAt });
  // 阈值内（默认 1500 ms）不闭口
  const earlyAt = outputAt + 1000;
  assert.equal(ledger.closeIfIdle({ lastLine: 12, at: earlyAt }), null, "阈值内不闭口");
  // 超过阈值才闭口，且记录时刻 = 判定用的时刻
  const closedAt = outputAt + 5000;
  const closed = ledger.closeIfIdle({ lastLine: 12, at: closedAt });
  assert.equal(closed.closedBy, "idle-timeout");
  assert.equal(closed.commandId, b.commandId, "闭口的正是 B 那条");
  assert.equal(closed.closedAt, new Date(closedAt).toISOString(),
    "闭口时刻必须与判定用的 at 一致（否则判定与记录来自两条时间线）");
  clock = closedAt;

  // 判据③：closeAll（会话结束）也要能用注入时刻
  const c = ledger.open({ text: "tail -f", markLine: 20 });
  const endAt = clock + 777;
  const all = ledger.closeAll({ lastLine: 25, at: endAt });
  assert.equal(all.length, 1);
  assert.equal(ledger.byId(c.commandId).closedAt, new Date(endAt).toISOString(), "closeAll 的 at 必须生效");

  // 判据④：不传 at 时退回内部时钟（默认行为不能被破坏）
  const d = ledger.open({ text: "echo D", markLine: 30 });
  ledger.markOutcome(d.commandId, { status: "blocked", endLine: 30 });
  assert.equal(ledger.byId(d.commandId).closedBy, "send-failed");
  assert.equal(ledger.byId(d.commandId).closedAt, new Date(clock).toISOString(),
    "不注入时刻时 fallback 到内部时钟");
}

// ── 输出时间线（用户 2026-10-24）：台账必须能自证「发出 → 首字节 → 最后一块」 ──
{
  const clock = 1_700_000_000_000;
  const ledger = createCommandLedger({
    sessionId: "s-timing",
    seqStart: 1,
    idleCloseMs: 1500,
    onRecord: () => {},
    now: () => clock
  });

  const record = ledger.open({ text: "ls", markLine: 0 });
  assert.equal(record.firstOutputAt, null, "刚发出时还没有输出");
  assert.equal(record.lastOutputAt, null);

  // 首字节在 120ms 后到达
  ledger.noteOutput({ lastLine: 1, at: clock + 120 });
  // 后续输出推进 lastOutputAt，但 firstOutputAt 必须保持第一次的时刻
  ledger.noteOutput({ lastLine: 5, at: clock + 400 });
  ledger.noteOutput({ lastLine: 9, at: clock + 900 });

  ledger.closeIfIdle({ lastLine: 9, at: clock + 900 + 1500 });
  const closed = ledger.byId(record.commandId);

  assert.equal(closed.firstOutputAt, new Date(clock + 120).toISOString(),
    "firstOutputAt 必须是**首个**输出到达时刻，不被后续输出覆盖");
  assert.equal(closed.lastOutputAt, new Date(clock + 900).toISOString(),
    "lastOutputAt 必须是最后一块输出");
  assert.equal(closed.firstOutputMs, 120, "发出→首字节 = 纯响应延迟");
  assert.equal(closed.durationMs, 900, "发出→最后一块 = 纯执行时间（不含闭口等待）");
  assert.equal(closed.closedAt, new Date(clock + 2400).toISOString(),
    "closedAt 仍含空闲闭口，与 durationMs 语义分开");

  // 完全没有输出的命令：firstOutputAt/lastOutputAt 保持 null，且不产生伪造的 0ms 耗时
  const empty = ledger.open({ text: ": ;", markLine: 10 });
  ledger.closeIfIdle({ lastLine: 10, at: clock + 5000 });
  const emptyClosed = ledger.byId(empty.commandId);
  assert.equal(emptyClosed.firstOutputAt, null, "无输出时不得编造首字节时间");
  assert.equal(emptyClosed.firstOutputMs, undefined, "无输出时不得编造 firstOutputMs");
  assert.equal(emptyClosed.durationMs, undefined,
    "无输出时不得编造 durationMs —— 让排查者一眼看出「这条命令没有任何输出」，而不是看到一个假的 0");
}

console.log("command ledger: closing criteria, echo-line exclusion, masking, JSONL reload, prune, closedAt and output timeline all hold");
