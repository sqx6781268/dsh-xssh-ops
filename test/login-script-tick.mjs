// R9① 超时策略的 **host 接线**：`tickLoginScripts` 必须真的推进状态机，
// 「跳过」与「严格模式中止」两条路径都要能触发并给出可见告警。
//
// 存在理由：`tickLoginScripts` 曾**定义了但无人调用** —— 于是计划要求的
// 「单条等待超时按策略跳过/中止」永远不会发生，而源码 review 看不出来。
// 这与 R9② 被 tree-shaking 剔除是同一类问题（写好的能力因为没接线而从未生效）。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import SshOpsService from "../src/index.js";
import { createLineJournal } from "../src/line-journal.js";

/** 会话 + service 桩。 */
function makeService({ rules, stepTimeoutMs = 1000 } = {}) {
  const service = Object.create(SshOpsService.prototype);
  service.config = {
    maxBufferBytes: 65536, maxCaptureBytes: 65536,
    sessionLogEnabled: false, commandLedgerEnabled: false, commandIdleMs: 1500,
    lineJournalMaxLines: 2000, lineJournalMaxBytes: 512 * 1024,
    taskLedgerDir: mkdtempSync(joinPath(tmpdir(), "xssh-tick-"))
  };
  service.settings = {
    loginScriptRulesEnabled: true,
    loginScriptRules: rules,
    expectMatchMode: "substring",
    expectStepTimeoutMs: stepTimeoutMs
  };
  const written = [];
  const notices = [];
  const session = {
    id: "s-tick", connectionId: "conn-tick", exited: null,
    stream: { write: (value) => written.push(value) },
    lineJournal: createLineJournal(),
    shellIntegration: null,
    buffer: "", captureBuffer: "", waiters: [], streamListeners: new Set(),
    inputLine: "", inputKnown: true, loginScript: null, sessionScript: null,
    lastActivityAt: Date.now()
  };
  service.connections = new Map([["conn-tick", { host: "192.0.2.90", port: 22, username: "root", sessions: new Set(["s-tick"]) }]]);
  service.sessions = new Map([["s-tick", session]]);
  service.activeConnectionId = "conn-tick";
  service.terminalOutput = () => ({ append() {} });
  service.sessionLogStore = () => null;
  service.wakeWaiters = () => {};
  service.notifyStreamListeners = () => {};
  service.updateInputMirror = () => {};
  service.appendTerminalNotice = (target, message) => notices.push(message);
  service.savedResourceNameList = () => [];
  service.lineMark = () => 1;
  service.sendCommand = async ({ text, pressEnter }) => {
    written.push(pressEnter === false ? text : `${text}\r`);
    return { ok: true, value: { commandId: "c-tick", startLine: 1, sent: true } };
  };
  service.readTerminalLines = () => ({ ok: true, value: { lines: [] } });   // 永远等不到 ⇒ 走超时
  return { service, session, written, notices };
}

// ── 默认跳过策略：等不到就跳过该条、继续下一条 ─────────────────────────
{
  const { service, session, written, notices } = makeService({
    rules: [
      { expect: "NeverAppears1", send: "one" },
      { expect: "NeverAppears2", send: "two" }
    ],
    stepTimeoutMs: 1000
  });
  const started = service.startLoginScriptIfEnabled(session);
  assert.equal(started.started, true, "规则引擎要启动");
  assert.equal(started.totalRules, 2);
  assert.equal(written.length, 0, "还没命中，不该发任何东西");

  // 推进时钟：第一次超时应跳过第 1 条并进入第 2 条
  service.tickLoginScripts(Date.now() + 1500);
  assert.equal(notices.length >= 1, true, "超时跳过要给一条可见告警");
  assert.match(notices[0], /第 1 条等待超时/, `告警要点名第几条：${notices[0]}`);
  assert.match(notices[0], /已跳过/, "默认策略是跳过");
  // 第 2 条进入等待（仍没命中，所以还没发）
  assert.equal(written.length, 0, "跳过后进入下一条等待，仍不发");

  // 再推进：第 2 条也超时 ⇒ 全部走完
  service.tickLoginScripts(Date.now() + 3000);
  assert.equal(notices.length >= 2, true, "第二条超时也要告警");
  assert.match(notices[1], /第 2 条等待超时/);
}

// ── 跳过策略下，命中的那一条仍要正常发送 ──────────────────────────────
{
  const { service, session, written } = makeService({
    rules: [
      { expect: "NeverAppears", send: "skip-me" },
      { expect: "Password:", send: "hunter2" }
    ],
    stepTimeoutMs: 1000
  });
  // 第一条超时跳过之后，第二条命中
  service.startLoginScriptIfEnabled(session);
  service.readTerminalLines = () => ({ ok: true, value: { lines: [{ line: 1, text: "user@host Password:" }] } });
  service.tickLoginScripts(Date.now() + 1500);        // 跳过第 1 条
  service.appendSessionOutput(session, "Password:");   // 命中第 2 条 ⇒ 发送
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(written, ["hunter2\r"], "跳过之后命中的规则照常发送");
}

// ── 严格模式：超时中止后续规则，不继续往下走 ───────────────────────────
{
  const { service, session, written, notices } = makeService({
    rules: [
      { expect: "NeverAppears", send: "one" },
      { expect: "Password:", send: "two" }
    ],
    stepTimeoutMs: 1000
  });
  // 切严格模式
  service.settings.onTimeout = "strict";
  // 引擎构造在 startLoginScriptIfEnabled 里读 onTimeout，这里需重建一次
  const strict = service.startLoginScriptIfEnabled(session);
  assert.equal(strict.started, true);
  // 直接给引擎塞严格模式（host 侧读的是构造参数）
  session.loginScript.onTimeout = "strict";
  service.tickLoginScripts(Date.now() + 1500);
  const strictNotice = notices.find((message) => /严格模式/.test(message));
  assert.ok(strictNotice !== undefined, `严格模式要给出明确告警：${notices.join(" | ")}`);
  assert.match(strictNotice, /已中止后续规则/);
  // 即使后面有能命中的规则，也**不该再发**（已中止）
  service.readTerminalLines = () => ({ ok: true, value: { lines: [{ line: 1, text: "Password:" }] } });
  service.appendSessionOutput(session, "Password:");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(written, [], "严格模式中止后不得继续发送");
}

// ── 没有引擎时 tick 是安全的空转（插件卸载/会话未启动时不该炸）─────────
{
  const { service } = makeService({ rules: [] });
  assert.doesNotThrow(() => service.tickLoginScripts());
  assert.doesNotThrow(() => service.tickLoginScripts(Date.now() + 99999));
}

// ── 登录后命令独立于规则开关，调用真实启动、写入与台账逻辑 ─────────────
function makeProfileService(loginScript) {
  const fixture = makeService({ rules: [{ expect: "GLOBAL", send: "echo global" }] });
  const { service, session } = fixture;
  service.connections.get(session.connectionId).profileId = "profile-login";
  service.requireProfileTable = () => new Map([["profile-login", { loginScript }]]);
  service.sendCommand = SshOpsService.prototype.sendCommand;
  return fixture;
}

for (const rulesEnabled of [undefined, false, true]) {
  const { service, session, written } = makeProfileService({
    ...(rulesEnabled === undefined ? {} : { rulesEnabled }),
    rules: [], postCommands: ["echo post-one", "echo post-two"]
  });
  const started = service.startLoginScriptIfEnabled(session);
  assert.equal(started.started, true, "只有登录后命令时也应启动");
  assert.equal(started.totalRules, 0);
  assert.deepEqual(written, [], "登录后命令交给节拍器统一执行");
  service.tickLoginScripts();
  assert.deepEqual(written, ["echo post-one\r", "echo post-two\r"]);
  assert.equal(session.commandLedger.recent({ includeHidden: true }).length, 2, "每条后续命令都记台账");
  assert.deepEqual(session.commandLedger.recent({ includeHidden: true }).map((record) => record.source), ["login-post", "login-post"]);
  assert.deepEqual(session.commandLedger.recent(), [], "登录后命令默认从日常台账过滤");
  assert.equal(service.startLoginScriptIfEnabled(session).already, true);
  service.tickLoginScripts();
  service.tickLoginScripts(Date.now() + 99999);
  assert.equal(written.length, 2, "重复启动和节拍都不得重复发送");
  clearTimeout(session.idleCloseTimer);
}

{
  const { service, session, written } = makeProfileService({
    rulesEnabled: false,
    rules: [{ expect: "NEVER", send: "echo disabled-rule" }],
    postCommands: ["echo independent"]
  });
  assert.equal(service.startLoginScriptIfEnabled(session).totalRules, 0, "禁用规则不回退执行全局规则");
  service.tickLoginScripts();
  assert.deepEqual(written, ["echo independent\r"], "规则禁用时后续命令仍执行");
  clearTimeout(session.idleCloseTimer);
}

{
  const { service, session, written } = makeProfileService({
    rulesEnabled: true,
    rules: [{ expect: "READY", send: "echo first-rule" }],
    postCommands: ["echo after-rule"]
  });
  assert.equal(service.startLoginScriptIfEnabled(session).started, true);
  service.tickLoginScripts();
  assert.deepEqual(written, [], "规则等待期间不提前发送后续命令");
  service.appendSessionOutput(session, "READY");
  assert.deepEqual(written, ["echo first-rule\r"], "先走真实规则发送通道");
  service.tickLoginScripts();
  service.tickLoginScripts();
  assert.deepEqual(written, ["echo first-rule\r", "echo after-rule\r"], "规则完成后只发送一次后续命令");
  clearTimeout(session.idleCloseTimer);
}

{
  const { service, session, written } = makeProfileService({ rulesEnabled: false, rules: [], postCommands: [] });
  assert.equal(service.startLoginScriptIfEnabled(session).started, false);
  service.tickLoginScripts();
  assert.deepEqual(written, [], "没有登录动作时保持空转");
}

// ── 产物级护栏：定时器与推进方法必须真的在 lib/index.js 里 ─────────────
{
  const { readFile } = await import("node:fs/promises");
  const built = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");
  for (const symbol of ["tickLoginScripts", "login-script timeout ticker", "tickIdleStrings", "sweepExpiredTasks"]) {
    assert.ok(built.includes(symbol), `lib/index.js 缺少 ${symbol}：定时器/推进器可能没接线`);
  }
}

console.log("login-script timeout wiring: skip and strict paths fire, notices name the rule, artifact timers exist");
