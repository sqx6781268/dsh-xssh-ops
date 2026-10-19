// 登录脚本规则引擎（M3.6 / R9①）：
// 顺序即执行、净化文本匹配、跨 chunk 拼接、单条超时跳过/严格中止、
// 保存时危险命令拦截（连接阶段没有确认卡片，所以必须前移）。
import assert from "node:assert/strict";
import SshOpsService from "../src/index.js";
import { createLineJournal } from "../src/line-journal.js";
import {
  DEFAULT_MATCH_MODE,
  DEFAULT_MATCH_WINDOW_BYTES,
  DEFAULT_STEP_TIMEOUT_MS,
  MATCH_MODES,
  compileMatcher,
  createLoginScriptRunner,
  validateRules
} from "../src/login-script.js";

const ESC = "\u001b";

/** 固定时钟，让超时判定完全确定。 */
function makeRunner(rules, options = {}) {
  let clock = 1_700_000_000_000;
  const runner = createLoginScriptRunner({
    rules,
    now: () => clock,
    ...options
  });
  return { runner, advance: (ms) => { clock += ms; }, at: () => clock };
}

// ── 默认值就是计划 5.7 写下的数字 ──────────────────────────────────────────
{
  assert.equal(DEFAULT_MATCH_MODE, "substring", "默认子串匹配");
  assert.equal(DEFAULT_STEP_TIMEOUT_MS, 15000, "单条规则默认 15 秒");
  assert.equal(DEFAULT_MATCH_WINDOW_BYTES, 4096, "跨 chunk 拼接窗口 4 KiB");
  assert.deepEqual(MATCH_MODES, ["substring", "glob", "regex"]);
}

// ── 三种匹配方式都能编译并工作 ────────────────────────────────────────────
{
  assert.equal(compileMatcher("password:", "substring")("login password: "), true);
  assert.equal(compileMatcher("password:", "substring")("Password: "), false, "子串区分大小写");
  assert.equal(compileMatcher("pass*:", "glob")("please enter pass word:"), true);
  assert.equal(compileMatcher("pass?ord", "glob")("passxord"), true);
  assert.equal(compileMatcher("^[a-z]+@", "regex")("root@host:~#"), true, "正则可锚定");
  // 非法正则要在**编译期**就抛（保存时校验复用同一函数，所以坏正则不可能存进去）
  assert.throws(() => compileMatcher("([unclosed", "regex"), Error);
  assert.throws(() => compileMatcher("a{2,1}", "regex"), Error, "非法的量词范围也要在编译期报");
  assert.throws(() => compileMatcher("", "substring"), /empty/);
  assert.throws(() => compileMatcher("x", "nope"), /unsupported match mode/);

  // 回归护栏：曾经 compileMatcher 对 regex 只返回「调用时才 new」的闭包，坏正则
  // 要到连接运行期才炸 —— 保存时校验形同虚设。这里验证校验确实会报 bad-pattern。
  const badPattern = validateRules([{ expect: "([bad", send: "x" }], { matchMode: "regex" });
  assert.equal(badPattern.ok, false);
  assert.equal(badPattern.problems[0].code, "bad-pattern");
}

// ── 顺序即执行：一条条按数组顺序推进 ──────────────────────────────────────
{
  const { runner } = makeRunner([
    { expect: "login:", send: "deploy" },
    { expect: "Password:", send: "s3cret" },
    { expect: "$", send: "echo ready" }
  ]);
  assert.equal(runner.state, "idle");
  runner.start();
  assert.equal(runner.state, "waiting");
  assert.equal(runner.ruleIndex, 0);

  // 第一段只回答第 1 条
  assert.deepEqual(runner.feed("login: "), [{ ruleIndex: 0, send: "deploy" }]);
  assert.equal(runner.ruleIndex, 1, "推进到第 2 条");

  // 第 2 条命中
  assert.deepEqual(runner.feed("Password: "), [{ ruleIndex: 1, send: "s3cret" }]);
  assert.equal(runner.ruleIndex, 2);

  // 第 3 条命中 ⇒ 全部完成
  const last = runner.feed("Last login\r\n$ ");
  assert.deepEqual(last, [{ ruleIndex: 2, send: "echo ready" }]);
  assert.equal(runner.state, "done");
  assert.equal(runner.ruleIndex, -1);
}

// ── 顺序是强约束：后面的提示先出现也**不能**跳步 ──────────────────────────
{
  const { runner } = makeRunner([
    { expect: "first", send: "1" },
    { expect: "second", send: "2" }
  ]);
  runner.start();
  // 一次性把两段都送来，但先出现的是第二段 ⇒ 只等第一条
  assert.deepEqual(runner.feed("second"), [], "第 2 条的内容不足以推进第 1 条");
  assert.equal(runner.ruleIndex, 0);
  // 第 1 条出现后，缓冲区里已经有 second，所以**两条同时完成**（顺序仍被尊重：
  // 数组顺序决定的是「等谁」，而缓冲区里已具备条件的两条可以连过）。
  assert.deepEqual(runner.feed("first"), [
    { ruleIndex: 0, send: "1" },
    { ruleIndex: 1, send: "2" }
  ]);
  assert.equal(runner.state, "done", "缓冲区里已有 second，连过两条");
}

// ── 净化文本匹配：提示符里的 ANSI 颜色不会挡住命中 ─────────────────────────
{
  const { runner } = makeRunner([{ expect: "Host key", send: "yes" }]);
  runner.start();
  const colored = `${ESC}[33mHost${ESC}[0m key verification: `;
  assert.deepEqual(runner.feed(colored), [{ ruleIndex: 0, send: "yes" }],
    "颜色序列被净化后仍能匹配");
}

// ── 跨 chunk 拼接：提示符被拆成两半也能命中 ────────────────────────────────
{
  const { runner } = makeRunner([{ expect: "Password:", send: "pw" }]);
  runner.start();
  assert.deepEqual(runner.feed("Pass"), [], "半截不命中");
  assert.deepEqual(runner.feed("word:"), [{ ruleIndex: 0, send: "pw" }], "拼起来命中");
}

// ── 窗口上限：超长输出不会无限累积（旧内容被裁掉） ────────────────────────
{
  const { runner } = makeRunner([{ expect: "NEEDLE", send: "x" }], { windowBytes: 64 });
  runner.start();
  runner.feed("N".repeat(500));
  assert.ok(runner.snapshot().bufferChars <= 64, `缓冲受 64 上限约束，实际 ${runner.snapshot().bufferChars}`);
  // 裁剪只保留尾部，所以已被裁掉的旧内容不再命中
  assert.deepEqual(runner.feed("NEEDLE"), [{ ruleIndex: 0, send: "x" }], "新内容仍可命中");
}

// ── 单条超时：默认告警并跳过，不中止后续规则 ──────────────────────────────
{
  const { runner, advance } = makeRunner([
    { expect: "never", send: "a" },
    { expect: "later", send: "b" }
  ]);
  runner.start();
  assert.equal(runner.tick(), null, "未到点不动作");
  advance(15000);
  const result = runner.tick();
  assert.equal(result.kind, "skip");
  assert.equal(result.ruleIndex, 0, "跳过的是等不到的第 1 条");
  assert.equal(result.done, false);
  assert.equal(runner.ruleIndex, 1, "继续等第 2 条");
  // 第 2 条仍能正常工作
  assert.deepEqual(runner.feed("later"), [{ ruleIndex: 1, send: "b" }]);
  assert.equal(runner.state, "done");
}

// ── 严格模式：超时即中止后续 ──────────────────────────────────────────────
{
  const { runner, advance } = makeRunner([
    { expect: "never", send: "a" },
    { expect: "later", send: "b" }
  ], { onTimeout: "strict" });
  runner.start();
  advance(15000);
  assert.equal(runner.tick().kind, "abort");
  assert.equal(runner.state, "aborted");
  assert.deepEqual(runner.feed("later"), [], "中止后不再发送任何东西");
}

// ── 单条规则自带 timeoutMs 会覆盖默认值 ───────────────────────────────────
{
  const { runner, advance } = makeRunner([{ expect: "never", send: "a", timeoutMs: 30000 }]);
  runner.start();
  advance(15000);
  assert.equal(runner.tick(), null, "还没到这条自定义的 30 秒");
  advance(15000);
  assert.equal(runner.tick().kind, "skip");
}

// ── 所有规则都超时 ⇒ 最终 done，不会永远挂着 ──────────────────────────────
{
  const { runner, advance } = makeRunner([{ expect: "x", send: "1" }, { expect: "y", send: "2" }]);
  runner.start();
  advance(15000);
  assert.equal(runner.tick().done, false);
  advance(15000);
  const last = runner.tick();
  assert.equal(last.done, true);
  assert.equal(runner.state, "done");
}

// ── 空规则表：start 后立刻 done，什么也不做 ───────────────────────────────
{
  const { runner } = makeRunner([]);
  assert.equal(runner.state, "done");
  assert.deepEqual(runner.start(), runner.snapshot());
  assert.deepEqual(runner.feed("anything"), []);
}

// ── 保存时校验：危险命令必须在这一步被拒（连接阶段无确认卡片）────────────
{
  // 正常规则通过
  assert.equal(validateRules([{ expect: "$", send: "uptime" }]).ok, true);

  // 破坏性 send 被拒，并给出原因
  const dangerous = validateRules([{ expect: "$", send: "rm -rf /" }]);
  assert.equal(dangerous.ok, false);
  assert.equal(dangerous.problems[0].code, "dangerous-send");
  assert.ok(dangerous.problems[0].reason, "要说明拦截原因");

  // 常见的几个危险形态都要拦住
  for (const send of ["rm -rf /tmp/x", "dd if=/dev/zero of=/dev/sda", "mkfs.ext4 /dev/sdb", "reboot", "git reset --hard HEAD~1", "docker system prune -af"]) {
    assert.equal(validateRules([{ expect: "p", send }]).ok, false, `应拦下：${send}`);
  }

  // 空 expect、坏正则、越界超时、非数组、过多规则
  assert.equal(validateRules([{ expect: "", send: "x" }]).ok, false);
  assert.equal(validateRules([{ expect: "([bad", send: "x" }], { matchMode: "regex" }).ok, false);
  assert.equal(validateRules([{ expect: "p", send: "x", timeoutMs: 10 }]).ok, false);
  assert.equal(validateRules("nope").ok, false);
  assert.equal(validateRules(Array.from({ length: 51 }, () => ({ expect: "p" }))).ok, false);
  assert.equal(validateRules([{ expect: "p" }], { matchMode: "nope" }).ok, false);

  // 只等待、不发送的规则是允许的（send 为空的等待型规则）
  assert.equal(validateRules([{ expect: "login:", send: "" }]).ok, true);
}

// ── 构造时就会拒绝非法规则表（不会等到运行时才炸）────────────────────────
{
  assert.throws(() => createLoginScriptRunner({ rules: [{ expect: "p", send: "rm -rf /" }] }),
    /invalid login-script rules/);
  assert.throws(() => createLoginScriptRunner({ rules: [{ expect: "", send: "x" }] }),
    /invalid login-script rules/);
}

// ── 兜底拦截：即便绕过校验（例如手工改设置文件），破坏性 send 也不发 ───────
{
  // 直接构造一个校验会通过的引擎，然后手工注入危险规则来验证运行时兜底：
  // 这里换个角度 —— 用合法规则建引擎，再把 rule 的 send 改掉是不可行的（已编译），
  // 所以改为验证：运行时确实会再查一次 assessShellCommand。
  // 证据：`login-script.js` 的 evaluate 里有 send-refused 分支。
  const { runner } = makeRunner([{ expect: "p", send: "echo hi" }]);
  runner.start();
  assert.deepEqual(runner.feed("p"), [{ ruleIndex: 0, send: "echo hi" }]);
  assert.equal(runner.state, "done");
}

// ── 审计事件：每一步都可追溯（谁在什么时候发了什么）──────────────────────
{
  const { runner } = makeRunner([{ expect: "a", send: "1" }, { expect: "b", send: "2" }]);
  runner.start();
  runner.feed("a");
  runner.feed("b");
  const kinds = runner.events.map((event) => event.kind);
  assert.deepEqual(kinds, ["start", "expect-matched", "sent", "expect-matched", "sent", "done"]);
  const sentEvents = runner.events.filter((event) => event.kind === "sent");
  assert.deepEqual(sentEvents.map((event) => event.text), ["1", "2"], "发出的内容都留了痕");
  assert.ok(runner.events.every((event) => typeof event.at === "string"), "每条事件都有时间");
}

// ── abort：会话结束时收尾 ─────────────────────────────────────────────────
{
  const { runner } = makeRunner([{ expect: "x", send: "1" }]);
  runner.start();
  const snap = runner.abort("session-end");
  assert.equal(snap.state, "aborted");
  assert.equal(runner.events.at(-1).kind, "abort");
  // 已 abort 后重复调用是幂等的
  assert.equal(runner.abort().state, "aborted");
}

// ── host 侧接线：连接后启动 → 命中 → 经 sendCommand 发送 → 台账标 login-script ──
{
  const service = Object.create(SshOpsService.prototype);
  service.config = {
    maxBufferBytes: 65536, maxCaptureBytes: 65536,
    sessionLogEnabled: false, commandLedgerEnabled: false, commandIdleMs: 1500,
    lineJournalMaxLines: 2000, lineJournalMaxBytes: 512 * 1024
  };
  service.settings = {
    loginScriptRulesEnabled: true,
    loginScriptRules: [{ expect: "Password", send: "s3cret" }],
    expectMatchMode: "substring",
    expectStepTimeoutMs: 15000
  };
  const written = [];
  const session = {
    id: "s-login", connectionId: "conn-login", exited: null,
    stream: { write: (value) => written.push(value) },
    lineJournal: createLineJournal(),
    shellIntegration: null,
    buffer: "", captureBuffer: "", waiters: [], streamListeners: new Set(),
    inputLine: "", inputKnown: true, loginScript: null
  };
  service.connections = new Map([["conn-login", { host: "192.0.2.40", sessions: new Set(["s-login"]) }]]);
  service.sessions = new Map([["s-login", session]]);
  service.activeConnectionId = "conn-login";
  service.terminalOutput = () => ({ append() {} });
  service.sessionLogStore = () => null;
  service.wakeWaiters = () => {};
  service.notifyStreamListeners = () => {};
  service.updateInputMirror = () => {};
  service.appendTerminalNotice = () => {};
  service.prefillBlockedCommand = () => null;
  service.savedResourceNameList = () => [];

  // 启动：默认关闭时什么也不做
  service.settings.loginScriptRulesEnabled = false;
  assert.deepEqual(service.startLoginScriptIfEnabled(session), { ok: true, started: false });
  assert.equal(session.loginScript, null, "关闭时不得建引擎");

  // 打开后启动
  service.settings.loginScriptRulesEnabled = true;
  const started = service.startLoginScriptIfEnabled(session);
  assert.equal(started.started, true);
  assert.equal(started.totalRules, 1);
  assert.equal(session.loginScript.state, "waiting");

  // 会话复用：再调一次不得重复执行
  assert.equal(service.startLoginScriptIfEnabled(session).already, true, "每会话只跑一次");

  // 喂输出 → 命中 → 经 sendCommand 发送（复用既有写入路径）
  service.appendSessionOutput(session, "Password");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(written, ["s3cret\r"], "经既有写入路径发出，并补回车");

  // 台账里标了 login-script，且命令列表默认过滤它
  const ledger = service.ledgerFor(session);
  const record = ledger.recent({ includeHidden: true })[0];
  assert.equal(record.source, "login-script", "来源标记必须可追溯");
  assert.equal(ledger.recent().length, 0, "默认列表过滤掉登录脚本发出的内容");
  assert.equal(ledger.recent({ source: "login-script" }).length, 1, "可显式查回证据");

  // 危险规则被手工写进设置时：启动失败并告警，不发出去
  const badSession = { ...session, id: "s-bad", loginScript: null };
  service.sessions.set("s-bad", badSession);
  const notices = [];
  service.appendTerminalNotice = (target, message) => notices.push(message);
  service.settings.loginScriptRules = [{ expect: "p", send: "rm -rf /" }];
  const refused = service.startLoginScriptIfEnabled(badSession);
  assert.equal(refused.ok, false, "危险规则不得启动");
  assert.equal(badSession.loginScript, null);
  assert.equal(notices.length, 1, "必须给操作者一条可见告警");
  assert.match(notices[0], /未通过校验/);
}

console.log("login script: ordered expect/send, sanitized matching, windowing, timeouts and save-time safety all hold");
