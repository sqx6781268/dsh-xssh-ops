// R8② 空闲字符串（真发版）与 M4 任务 TTL 清理：
// 四条前提、「自己发的不算空闲」、行日志打 keepalive 且不进命令台账、
// TTL 只清已结束任务、远端删除失败不谎报已清理。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import SshOpsService from "../src/index.js";
import { createLineJournal } from "../src/line-journal.js";
import { createIdleStringSender, evaluatePreconditions } from "../src/idle-string.js";

// ── 前提判定：四条全满足才发 ─────────────────────────────────────────────
{
  const base = {
    idleStringEnabled: true,
    idleStringIntervalSec: 60,
    idleStringText: "keepalive"
  };
  const ok = evaluatePreconditions({
    settings: base, hasLiveSession: true, openCommandCount: 0, interactive: false, idleSinceMs: 70_000
  });
  assert.equal(ok.enabled, true);
  assert.equal(ok.wouldSend, true, "四条全满足 ⇒ 会发");
  assert.equal(ok.checks.length, 4);
  // 已经够条件（空闲 70s ≥ 阈值 60s）⇒ 下一次就是「现在」，给此刻的 ISO 时间。
  assert.equal(typeof ok.nextSendAt, "string");
  assert.ok(Math.abs(Date.parse(ok.nextSendAt) - Date.now()) < 5000, "会发时 nextSendAt = 现在");

  // 逐条否掉
  for (const [patch, name] of [
    [{ hasLiveSession: false }, "live-session"],
    [{ openCommandCount: 1 }, "no-open-command"],
    [{ interactive: true }, "not-interactive"],
    [{ idleSinceMs: 1_000 }, "idle-enough"]
  ]) {
    const verdict = evaluatePreconditions({
      settings: base, hasLiveSession: true, openCommandCount: 0, interactive: false, idleSinceMs: 70_000, ...patch
    });
    assert.equal(verdict.wouldSend, false, `${name} 不满足就不该发`);
    assert.equal(verdict.checks.find((c) => c.name === name).ok, false);
  }

  // 开关/间隔/字符串任一不成立都不发
  for (const settings of [
    { ...base, idleStringEnabled: false },
    { ...base, idleStringIntervalSec: 0 },
    { ...base, idleStringText: "" }
  ]) {
    const verdict = evaluatePreconditions({
      settings, hasLiveSession: true, openCommandCount: 0, interactive: false, idleSinceMs: 70_000
    });
    assert.equal(verdict.enabled, false);
    assert.equal(verdict.wouldSend, false);
    assert.equal(verdict.nextSendAt, null, "没启用就不编时间");
  }

  // 空闲不够时不发，但给出下一次时间（未来时刻）
  const notYet = evaluatePreconditions({
    settings: base, hasLiveSession: true, openCommandCount: 0, interactive: false, idleSinceMs: 30_000
  });
  assert.equal(notYet.wouldSend, false);
  assert.equal(typeof notYet.nextSendAt, "string", "够条件前的下次时间可以给");
  assert.ok(Date.parse(notYet.nextSendAt) > Date.now(), "那是个未来时刻");

  // 前提不成立（无会话 / TUI / 有未闭口命令）⇒ 不给时间（发了也不会被允许）
  for (const patch of [{ hasLiveSession: false }, { interactive: true }, { openCommandCount: 2 }]) {
    const blocked = evaluatePreconditions({
      settings: base, hasLiveSession: true, openCommandCount: 0, interactive: false, idleSinceMs: 70_000, ...patch
    });
    assert.equal(blocked.nextSendAt, null, "前提不成立时不该给时间");
  }
}

// ── 发送器：只对符合条件的会话发，且间隔内不重复发 ───────────────────────
{
  let clock = 1_700_000_000_000;
  const sent = [];
  const sender = createIdleStringSender({
    readSettings: () => ({ idleStringEnabled: true, idleStringIntervalSec: 60, idleStringText: "ping" }),
    listSessions: () => [
      { sessionId: "ok", hasLiveSession: true, openCommandCount: 0, interactive: false, idleSinceMs: 90_000 },
      { sessionId: "busy", hasLiveSession: true, openCommandCount: 1, interactive: false, idleSinceMs: 90_000 },
      { sessionId: "tui", hasLiveSession: true, openCommandCount: 0, interactive: true, idleSinceMs: 90_000 },
      { sessionId: "fresh", hasLiveSession: true, openCommandCount: 0, interactive: false, idleSinceMs: 1_000 },
      { sessionId: "dead", hasLiveSession: false, openCommandCount: 0, interactive: false, idleSinceMs: 90_000 }
    ],
    send: async (sessionId, text) => { sent.push({ sessionId, text }); },
    now: () => clock
  });

  const first = await sender.tick();
  assert.deepEqual(first.map((item) => item.sessionId), ["ok"], "只有全满足的那个会话被发");
  assert.deepEqual(sent, [{ sessionId: "ok", text: "ping" }]);

  // 「自己发的不算空闲」：间隔内再 tick 不该重复发
  clock += 10_000;
  const second = await sender.tick();
  assert.deepEqual(second, [], "间隔未到不重复发（自己发的也是流量）");
  // 过了间隔（且调用方仍报空闲）才会再发
  clock += 60_000;
  const third = await sender.tick();
  assert.deepEqual(third.map((item) => item.sessionId), ["ok"]);
  assert.equal(sent.length, 2);
  assert.equal(sender.lastSentAt("ok"), clock);
}

// ── 发送失败不吞掉：记审计事件，不影响其他会话 ──────────────────────────
{
  let clock = 1_700_000_000_000;
  const events = [];
  const sender = createIdleStringSender({
    readSettings: () => ({ idleStringEnabled: true, idleStringIntervalSec: 60, idleStringText: "x" }),
    listSessions: () => [
      { sessionId: "boom", hasLiveSession: true, openCommandCount: 0, interactive: false, idleSinceMs: 90_000 },
      { sessionId: "fine", hasLiveSession: true, openCommandCount: 0, interactive: false, idleSinceMs: 90_000 }
    ],
    send: async (sessionId) => { if (sessionId === "boom") throw new Error("stream closed"); },
    onEvent: (event) => events.push(event),
    now: () => clock
  });
  const result = await sender.tick();
  assert.deepEqual(result.map((item) => item.sessionId), ["fine"], "失败的会话被跳过，成功的照发");
  assert.equal(events.some((event) => event.kind === "keepalive-failed" && event.sessionId === "boom"), true);
  assert.equal(events.some((event) => event.kind === "keepalive-sent" && event.sessionId === "fine"), true);
}

// ── 行日志：keepalive 标记只在提交那一行上，且读取时回传 ────────────────
{
  const journal = createLineJournal();
  journal.append("$ ls\r\n");
  // 保活内容与标记必须在**同一次调用**里传入（分两步时标记会被空 append 吃掉）
  journal.appendKeepalive("keepalive-probe\r\n");
  journal.append("$ \r\n");

  const read = journal.read();
  const texts = read.lines.map((entry) => entry.text);
  // 行尾空白被裁掉，`"$ "` 变成 `"$"`（净化语义，不是 bug）
  assert.deepEqual(texts, ["$ ls", "keepalive-probe", "$"], "保活照实记录（不掩盖事实）");
  assert.equal(read.lines[1].keepalive, true, "保活那一行必须带标记");
  assert.equal(read.lines[0].keepalive, undefined, "普通行不该带标记");
  assert.equal(read.lines[2].keepalive, undefined);

  // 跨块：这一次没提交新行 ⇒ 标记留给下一块
  const split = createLineJournal();
  split.appendKeepalive("ab");        // 没有换行 ⇒ 不提交
  assert.equal(split.read().lines.length, 0, "没换行就不算一行");
  split.append("cd\r\n");
  assert.equal(split.read().lines[0].keepalive, true, "标记跟着跨块留给提交那一行");
}

// ── host 接线：真发 + 打标记 + 不进命令台账 ─────────────────────────────
{
  const service = Object.create(SshOpsService.prototype);
  service.config = {
    maxBufferBytes: 65536, maxCaptureBytes: 65536,
    sessionLogEnabled: false, commandLedgerEnabled: false, commandIdleMs: 1500,
    lineJournalMaxLines: 2000, lineJournalMaxBytes: 512 * 1024,
    taskLedgerDir: mkdtempSync(joinPath(tmpdir(), "xssh-idle-task-"))
  };
  service.settings = {
    idleStringEnabled: true, idleStringIntervalSec: 60, idleStringText: "keepalive-probe"
  };
  const written = [];
  const session = {
    id: "s-idle", connectionId: "conn-idle", exited: null,
    stream: { write: (value) => written.push(value) },
    lineJournal: createLineJournal(),
    shellIntegration: null,
    buffer: "", captureBuffer: "", waiters: [], streamListeners: new Set(),
    inputLine: "", inputKnown: true, loginScript: null,
    lastActivityAt: Date.now() - 90_000,   // 已空闲 90 秒（超过阈值）
    lastPrompt: "$ "
  };
  service.connections = new Map([["conn-idle", { host: "192.0.2.60", port: 22, username: "root", sessions: new Set(["s-idle"]) }]]);
  service.sessions = new Map([["s-idle", session]]);
  service.activeConnectionId = "conn-idle";
  service.terminalOutput = () => ({ append() {} });
  service.sessionLogStore = () => null;
  service.wakeWaiters = () => {};
  service.notifyStreamListeners = () => {};
  service.updateInputMirror = () => {};
  service.appendTerminalNotice = () => {};
  service.savedResourceNameList = () => [];

  // 前提都满足 ⇒ 真的发出去
  const sentNow = await service.tickIdleStrings();
  assert.deepEqual(sentNow.map((item) => item.sessionId), ["s-idle"]);
  assert.deepEqual(written, ["keepalive-probe"], "字符串真的写进了终端");

  // 会话收到回显时，那一行带 keepalive 标记
  service.appendSessionOutput(session, "keepalive-probe\r\n");
  const read = service.readTerminalLines({ sessionId: "s-idle" });
  const keepaliveLine = read.value.lines.find((entry) => entry.text.includes("keepalive-probe"));
  assert.equal(keepaliveLine?.keepalive, true, "回显行必须带 keepalive 标记");

  // **不进命令台账**：保活字符串绝不能被当成用户执行过的命令
  const ledger = service.ledgerFor(session);
  assert.equal(ledger.recent({ includeHidden: true }).length, 0, "台账里不该有保活记录");

  // 「测试保活」与真实发送共用同一套判据：清掉空闲后应报不会发
  session.lastActivityAt = Date.now();
  const verdict = service.keepAliveTest({ connectionId: "conn-idle" });
  assert.equal(verdict.value.wouldSend, false, "刚有活动时不该发");
  assert.equal(verdict.value.checks.find((c) => c.name === "idle-enough").ok, false);
  assert.match(verdict.value.checks.find((c) => c.name === "idle-enough").detail, /阈值 60 秒/);
}

// ── M4 TTL 清理：只清已结束的，远端删失败不谎报 ─────────────────────────
{
  const service = Object.create(SshOpsService.prototype);
  service.config = {
    maxBufferBytes: 65536, maxCaptureBytes: 65536,
    sessionLogEnabled: false, commandLedgerEnabled: false,
    taskLedgerDir: mkdtempSync(joinPath(tmpdir(), "xssh-ttl-")),
    taskTtlHours: 24
  };
  service.connections = new Map([["conn-ttl", { host: "192.0.2.70", port: 22, username: "root", sessions: new Set() }]]);
  service.sessions = new Map();
  const commands = [];
  service.execOnConnection = async (connectionId, command) => {
    commands.push(command);
    if (command.includes("rm -rf")) {
      // 用一个开关模拟远端删除失败
      if (service.failDelete === true) return { ok: false, error: { message: "permission denied" } };
      return { ok: true, value: { stdout: "cleaned", stderr: "", exitCode: 0 } };
    }
    return { ok: true, value: { stdout: "", stderr: "", exitCode: 0 } };
  };

  const ledger = service.taskLedger();
  const old = ledger.create({ connectionId: "conn-ttl", command: "old", location: "remote-tmp" });
  ledger.update(old.taskId, { remoteDir: "/tmp/.dsh-xssh-ops/old", state: "done", exitCode: 0 });
  const fresh = ledger.create({ connectionId: "conn-ttl", command: "fresh", location: "remote-tmp" });
  ledger.update(fresh.taskId, { remoteDir: "/tmp/.dsh-xssh-ops/fresh", state: "done", exitCode: 0 });
  const running = ledger.create({ connectionId: "conn-ttl", command: "running", location: "remote-tmp" });
  ledger.update(running.taskId, { remoteDir: "/tmp/.dsh-xssh-ops/running" });

  // 把 old 的完成时间伪装成 25 小时前（直接改记录后检查判据）
  const raw = ledger.byId(old.taskId);
  raw.finishedAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  // fresh / running 保持不变
  const result = await service.sweepExpiredTasks();
  assert.equal(result.value.swept.length, 1, "只有超龄且已结束的那条被扫到");
  assert.equal(result.value.swept[0].taskId, old.taskId);
  assert.equal(ledger.byId(old.taskId).state, "expired");
  assert.equal(ledger.byId(fresh.taskId).state, "done", "未超龄的不动");
  assert.equal(ledger.byId(running.taskId).state, "running", "运行中的不清");
  assert.equal(commands.some((command) => command.includes("/tmp/.dsh-xssh-ops/old")), true, "删的是超龄任务的目录");

  // 远端删失败 ⇒ 不标 expired（否则台账谎报已清理，实际文件还在）
  const old2 = ledger.create({ connectionId: "conn-ttl", command: "old2", location: "remote-tmp" });
  ledger.update(old2.taskId, { remoteDir: "/tmp/.dsh-xssh-ops/old2", state: "done", exitCode: 0 });
  ledger.byId(old2.taskId).finishedAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  service.failDelete = true;
  const second = await service.sweepExpiredTasks();
  const failed = second.value.swept.find((item) => item.taskId === old2.taskId);
  assert.equal(failed.ok, false, "远端删失败要如实报");
  assert.equal(ledger.byId(old2.taskId).state, "done", "不得谎报已清理（留待下次重试）");
}

console.log("idle string: four preconditions, real send with keepalive marking, and TTL sweep all hold");
