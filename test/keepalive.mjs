// R8 保持活动状态（计划 5.8 / M3.5）：设置持久化、默认值、白名单与范围校验、
// 「测试保活」的四条前提判定、建连预览，以及「间隔改动要重连才生效」的提示。
import assert from "node:assert/strict";
import SshOpsService, { KEEPALIVE_DEFAULTS, loadSettingsRecord } from "../src/index.js";
import { createLineJournal } from "../src/line-journal.js";
import { createCommandLedger } from "../src/command-ledger.js";

function fakeTable(entries = []) {
  const map = new Map(entries);
  return {
    get: (id) => map.get(id),
    put: (id, record) => { map.set(id, record); },
    delete: (id) => { map.delete(id); },
    entries: () => [...map.entries()],
    size: () => map.size
  };
}

/** 只带设置表与一条活连接的 service 桩。 */
function makeHarness({ settingsRecord = {}, session: withSession = true } = {}) {
  const service = Object.create(SshOpsService.prototype);
  const table = fakeTable([["main", { ...settingsRecord }]]);
  service.settingsTable = table;
  service.settings = loadSettingsRecord(table.get("main"));
  service.connections = new Map();
  service.sessions = new Map();
  service.activeConnectionId = null;

  const record = { host: "192.0.2.30", port: 22, username: "root", sessions: new Set() };
  const session = {
    id: "s-keep",
    connectionId: "conn-keep",
    exited: null,
    stream: withSession ? { write: () => {} } : null,
    lineJournal: createLineJournal(),
    commandLedger: createCommandLedger({ sessionId: "s-keep" }),
    waiters: [],
    streamListeners: new Set(),
    lastActivityAt: Date.now() - 90_000   // 已空闲 90 秒
  };
  if (withSession) {
    record.sessions.add("s-keep");
    service.sessions.set("s-keep", session);
  }
  service.connections.set("conn-keep", record);
  service.activeConnectionId = "conn-keep";
  service.savedResourceNameList = () => [];
  return { service, table, session, record };
}

// ── 默认值就是计划 5.7 写下的数字 ──────────────────────────────────────────
{
  assert.equal(KEEPALIVE_DEFAULTS.sshKeepAliveEnabled, true, "R8① 默认开启");
  assert.equal(KEEPALIVE_DEFAULTS.sshKeepAliveIntervalSec, 60, "R8① 默认 60 秒（取代上游 20 秒）");
  assert.equal(KEEPALIVE_DEFAULTS.sshKeepAliveCountMax, 3);
  assert.equal(KEEPALIVE_DEFAULTS.idleStringEnabled, false, "R8② 默认关闭");
  assert.equal(KEEPALIVE_DEFAULTS.idleStringIntervalSec, 0, "R8② 0 视为未启用");
  assert.equal(KEEPALIVE_DEFAULTS.tcpKeepAliveEnabled, false, "R8③ 默认关闭");
  assert.equal(KEEPALIVE_DEFAULTS.tcpKeepAliveInitialDelaySec, 60);
  assert.equal(KEEPALIVE_DEFAULTS.expectMatchMode, "substring", "R9① 默认子串匹配");
  assert.equal(KEEPALIVE_DEFAULTS.expectStepTimeoutMs, 15000);
  assert.equal(KEEPALIVE_DEFAULTS.loginScriptSandbox, "restricted", "R9② 默认受限沙箱");

  // 旧记录（没有这些键）必须能正常加载，且拿到默认值 —— 升级不能把老用户卡住。
  const legacy = loadSettingsRecord({ language: "zh", agentAutoConnect: true });
  assert.equal(legacy.sshKeepAliveIntervalSec, 60);
  assert.equal(legacy.idleStringText, "");
  assert.deepEqual(legacy.loginScriptRules, []);
  assert.equal(legacy.loginScriptRunEnabled, false);
}

// ── keepAliveGet 返回完整表单（含默认值） ─────────────────────────────────
{
  const { service } = makeHarness();
  const got = await service.keepAliveGet();
  assert.equal(got.ok, true);
  assert.equal(got.value.sshKeepAliveEnabled, true);
  assert.equal(got.value.sshKeepAliveIntervalSec, 60);
  assert.equal(got.value.idleStringText, "");
  assert.equal(got.value.tcpKeepAliveEnabled, false);
}

// ── 保存：只发被改动的字段，落盘且即时生效 ────────────────────────────────
{
  const { service, table } = makeHarness();
  const saved = await service.keepAliveSave({ sshKeepAliveIntervalSec: 120, tcpKeepAliveEnabled: true });
  assert.equal(saved.ok, true);
  assert.equal(saved.value.sshKeepAliveIntervalSec, 120);
  assert.equal(saved.value.tcpKeepAliveEnabled, true);
  assert.equal(saved.value.reconnectRequired, true, "间隔改动必须提示要重连");
  // 未改动的字段保持默认，不被覆盖
  assert.equal(saved.value.sshKeepAliveCountMax, 3);
  assert.equal(saved.value.idleStringEnabled, false);

  const persisted = table.get("main");
  assert.equal(persisted.sshKeepAliveIntervalSec, 120, "落盘");
  assert.equal(persisted.tcpKeepAliveEnabled, true);
  assert.equal(typeof persisted.updatedAt, "string", "更新时间被记录");

  // 再读一次要能读回（进程重启后的行为）
  service.settings = loadSettingsRecord(table.get("main"));
  const again = await service.keepAliveGet();
  assert.equal(again.value.sshKeepAliveIntervalSec, 120);
  assert.equal(again.value.tcpKeepAliveEnabled, true);
}

// ── 范围校验：越界要明确拒绝，而不是静默写入 ──────────────────────────────
{
  const { service } = makeHarness();
  for (const [patch, field] of [
    [{ sshKeepAliveIntervalSec: 1 }, "sshKeepAliveIntervalSec"],
    [{ sshKeepAliveIntervalSec: 99999 }, "sshKeepAliveIntervalSec"],
    [{ sshKeepAliveIntervalSec: 60.5 }, "sshKeepAliveIntervalSec"],
    [{ sshKeepAliveCountMax: 0 }, "sshKeepAliveCountMax"],
    [{ idleStringIntervalSec: -1 }, "idleStringIntervalSec"],
    [{ tcpKeepAliveInitialDelaySec: 0 }, "tcpKeepAliveInitialDelaySec"]
  ]) {
    const result = await service.keepAliveSave(patch);
    assert.equal(result.ok, false, `拒绝 ${JSON.stringify(patch)}`);
    assert.equal(result.error.code, "keepalive-invalid");
    assert.match(result.error.message, new RegExp(field), "错误里点名是哪个字段");
  }
  // 超长字符串也要拒（设置记录有 4096 上限）
  const long = await service.keepAliveSave({ idleStringText: "x".repeat(4097) });
  assert.equal(long.ok, false);

  // 未知键被忽略而不是报错，也不写进记录
  const { service: service2, table: table2 } = makeHarness();
  const unknown = await service2.keepAliveSave({ notAField: true, sshKeepAliveCountMax: 5 });
  assert.equal(unknown.ok, true);
  assert.equal(table2.get("main").notAField, undefined, "未知键不得写进设置记录");
  assert.equal(table2.get("main").sshKeepAliveCountMax, 5);
}

// ── 「测试保活」：四条前提逐条回报，且不发时给 null 而不是假时间 ────────────
{
  // ② 关闭时根本不会发
  const { service } = makeHarness();
  const off = service.keepAliveTest({ connectionId: "conn-keep" });
  assert.equal(off.ok, true);
  assert.equal(off.value.enabled, false, "idleStringEnabled=false ⇒ 未启用");
  assert.equal(off.value.wouldSend, false);
  assert.equal(off.value.nextSendAt, null, "没在发就不编时间");
  assert.equal(off.value.checks.length, 4, "四条前提都要回报");
  assert.deepEqual(off.value.checks.map((check) => check.name), ["live-session", "no-open-command", "not-interactive", "idle-enough"]);
}

{
  // ② 开启 + 空闲够 + 活会话 + 无未闭口命令 ⇒ 会发，且给出下一次时间
  const { service } = makeHarness({ settingsRecord: { idleStringEnabled: true, idleStringIntervalSec: 60, idleStringText: "x" } });
  const on = service.keepAliveTest({ connectionId: "conn-keep" });
  assert.equal(on.value.enabled, true);
  assert.equal(on.value.wouldSend, true, "四条前提全满足 ⇒ 会发");
  assert.ok(typeof on.value.nextSendAt === "string", "给出下一次发送时间");
  assert.equal(on.value.checks.every((check) => check.ok), true);
}

{
  // 有未闭口命令 ⇒ 不发（否则会把字符串插进正在运行的命令输出里）
  const { service, session } = makeHarness({ settingsRecord: { idleStringEnabled: true, idleStringIntervalSec: 60, idleStringText: "x" } });
  session.commandLedger.open({ text: "tail -f x", markLine: 1 });
  const busy = service.keepAliveTest({ connectionId: "conn-keep" });
  assert.equal(busy.value.wouldSend, false);
  const check = busy.value.checks.find((item) => item.name === "no-open-command");
  assert.equal(check.ok, false);
  assert.match(check.detail, /1 条命令仍在运行/, "把「为什么没发」说清楚");
}

{
  // 前台是 TUI ⇒ 不发（计划风险 #13）
  const { service, session } = makeHarness({ settingsRecord: { idleStringEnabled: true, idleStringIntervalSec: 60, idleStringText: "x" } });
  session.commandLedger.open({ text: "top", markLine: 1 });
  session.commandLedger.markInteractive();
  const tui = service.keepAliveTest({ connectionId: "conn-keep" });
  assert.equal(tui.value.wouldSend, false);
  assert.equal(tui.value.checks.find((item) => item.name === "not-interactive").ok, false);
}

{
  // 没有活会话 ⇒ 不发
  const { service } = makeHarness({ settingsRecord: { idleStringEnabled: true, idleStringIntervalSec: 60, idleStringText: "x" }, session: false });
  const dead = service.keepAliveTest({ connectionId: "conn-keep" });
  assert.equal(dead.value.wouldSend, false);
  const check = dead.value.checks.find((item) => item.name === "live-session");
  assert.equal(check.ok, false);
  assert.match(check.detail, /没有打开的终端/);
}

{
  // 空闲不够 ⇒ 不发，且详情里给出「已空闲 N 秒 / 阈值 M 秒」
  const { service, session } = makeHarness({ settingsRecord: { idleStringEnabled: true, idleStringIntervalSec: 600, idleStringText: "x" } });
  session.lastActivityAt = Date.now() - 5_000;
  const fresh = service.keepAliveTest({ connectionId: "conn-keep" });
  assert.equal(fresh.value.wouldSend, false);
  const check = fresh.value.checks.find((item) => item.name === "idle-enough");
  assert.equal(check.ok, false);
  assert.match(check.detail, /阈值 600 秒/);
}

// ── 建连预览：把最终参数摊开，能证明「保活间隔改了」 ──────────────────────
{
  const { service } = makeHarness({ settingsRecord: { sshKeepAliveEnabled: true, sshKeepAliveIntervalSec: 90, sshKeepAliveCountMax: 4 } });
  const preview = service.connectOptionsPreview({ connectionId: "conn-keep" });
  assert.equal(preview.ok, true);
  assert.equal(preview.value.keepaliveInterval, 90_000, "秒 → 毫秒");
  assert.equal(preview.value.keepaliveCountMax, 4);
  assert.equal(preview.value.hasLiveSession, true);
  assert.equal(preview.value.tcpKeepAlive.enabled, false);

  // 关闭保活 ⇒ interval 0（ssh2 语义：不发）
  const { service: service2 } = makeHarness({ settingsRecord: { sshKeepAliveEnabled: false } });
  assert.equal(service2.connectOptionsPreview({ connectionId: "conn-keep" }).value.keepaliveInterval, 0);
}

// ── 保活字符串不进命令台账（计划 risk #13 的隔离要求）────────────────────
{
  const { service, session } = makeHarness();
  // 台账里明确不认 login-script 来源：默认列表过滤、byText 也找不到它。
  session.commandLedger.open({ text: "\u0000", markLine: 1, source: "login-script", pressEnter: false });
  assert.equal(session.commandLedger.recent().length, 0, "默认列表里没有保活记录");
  assert.equal(session.commandLedger.byText("\u0000").length, 0, "按内容查也不认它");
  assert.equal(session.commandLedger.recent({ includeHidden: true }).length, 1, "但证据保留，可显式查回");
  void service;
}

// ── 连接不存在时「测试保活」给出可判断的错误 ──────────────────────────────
{
  const { service } = makeHarness();
  const missing = service.keepAliveTest({ connectionId: "nope" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "no-connection");
}

console.log("keep-alive settings: defaults, persistence, validation, four preconditions and preview all hold");
