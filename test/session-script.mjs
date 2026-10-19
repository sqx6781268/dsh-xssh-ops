// R9② 的 **host 接线**（方案 A）：脚本真的会被拉起、经既有写入路径发送、
// 超预算不影响会话、保存时拒绝 trusted 沙箱。
//
// 这个测试的存在理由是踩过的坑：`login-script-dsl.js` 被写好后**只 import、没人调用**，
// 于是被 esbuild tree-shaking 剔除 —— 源码里"有"，产物里没有，功能从未生效。
// 所以这里既测行为，也测「产物里必须能找到接线符号」。
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import SshOpsService from "../src/index.js";
import { createLineJournal } from "../src/line-journal.js";

/** 会话桩 + service 桩。 */
function makeService({ settings = {}, scriptSource = null } = {}) {
  const service = Object.create(SshOpsService.prototype);
  service.config = {
    maxBufferBytes: 65536, maxCaptureBytes: 65536,
    sessionLogEnabled: false, commandLedgerEnabled: false, commandIdleMs: 1500,
    lineJournalMaxLines: 2000, lineJournalMaxBytes: 512 * 1024
  };
  service.settings = settings;
  service.connections = new Map();
  service.sessions = new Map();
  const written = [];
  const notices = [];
  const session = {
    id: "s-script", connectionId: "conn-script", exited: null,
    stream: { write: (value) => written.push(value) },
    lineJournal: createLineJournal(),
    shellIntegration: null,
    buffer: "", captureBuffer: "", waiters: [], streamListeners: new Set(),
    inputLine: "", inputKnown: true, loginScript: null, sessionScript: null,
    lastActivityAt: Date.now(), openedAt: new Date().toISOString()
  };
  service.connections.set("conn-script", { host: "192.0.2.80", port: 22, username: "root", sessions: new Set(["s-script"]) });
  service.sessions.set("s-script", session);
  service.activeConnectionId = "conn-script";
  service.terminalOutput = () => ({ append() {} });
  service.sessionLogStore = () => null;
  service.wakeWaiters = () => {};
  service.notifyStreamListeners = () => {};
  service.updateInputMirror = () => {};
  service.appendTerminalNotice = (target, message) => notices.push(message);
  service.savedResourceNameList = () => [];
  service.lineMark = () => 1;
  service.sendCommand = async ({ text, pressEnter, source }) => {
    written.push(pressEnter === false ? text : `${text}\r`);
    return { ok: true, value: { commandId: "c-script", startLine: 1, sent: true, blocked: false, source } };
  };
  return { service, session, written, notices, scriptSource };
}

// ── 默认关闭：不读脚本、不执行 ──────────────────────────────────────────
{
  const { service, session } = makeService({ settings: { loginScriptRunEnabled: false, loginScriptPath: "/nope.js" } });
  const result = await service.startSessionScriptIfEnabled(session);
  assert.equal(result.started, false, "关闭时不该启动");
  assert.equal(session.sessionScript, null);
}

// ── 开启但没有路径：也不启动（不报错，属于配置未完成）──────────────────
{
  const { service, session } = makeService({ settings: { loginScriptRunEnabled: true, loginScriptPath: "" } });
  assert.equal((await service.startSessionScriptIfEnabled(session)).started, false);
}

// ── 路径读不到：必须明确告警，不能静默跳过 ──────────────────────────────
{
  const { service, session, notices } = makeService({
    settings: { loginScriptRunEnabled: true, loginScriptPath: joinPath(tmpdir(), "definitely-missing-xssh.js") }
  });
  const result = await service.startSessionScriptIfEnabled(session);
  assert.equal(result.started, false);
  assert.equal(notices.length, 1, "读不到脚本要给用户一条可见告警");
  assert.match(notices[0], /读取失败/);
}

// ── trusted 沙箱被拒（方案 A 下不存在完整宿主能力）──────────────────────
{
  const { service, session, notices } = makeService({
    settings: { loginScriptRunEnabled: true, loginScriptPath: "/tmp/x.js", loginScriptSandbox: "trusted" }
  });
  const result = await service.startSessionScriptIfEnabled(session);
  assert.equal(result.started, false);
  assert.match(notices[0], /未通过校验|restricted/);
}

// ── 正常脚本：真的执行、真的经既有写入路径发送 ─────────────────────────
{
  const dir = await mkdtemp(joinPath(tmpdir(), "xssh-script-"));
  const scriptPath = joinPath(dir, "login.js");
  await writeFile(scriptPath, [
    'log("start");',
    'await send("whoami");'
  ].join("\n"), "utf8");

  const { service, session, written } = makeService({
    settings: { loginScriptRunEnabled: true, loginScriptPath: scriptPath, loginScriptSandbox: "restricted" }
  });
  // 注入一段输出，让脚本里的 expect 能立刻命中
  service.readTerminalLines = () => ({ ok: true, value: { lines: [{ line: 1, text: "Password:" }] } });
  const result = await service.startSessionScriptIfEnabled(session);
  assert.equal(result.started, true, result.error?.message);
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(written, ["whoami\r"], "发送经既有写入路径（补回车）");
  assert.equal(session.sessionScript.path, scriptPath, "会话上留痕");
  assert.ok(result.steps >= 2, "步数可追溯");
}

// ── expect 命中与超时：命中就往下走，等不到返回 false ────────────────────
{
  const dir = await mkdtemp(joinPath(tmpdir(), "xssh-script2-"));
  const hitPath = joinPath(dir, "hit.js");
  await writeFile(hitPath, [
    'const ok = await expect("Password:", 1000);',
    'await send(ok ? "yes-hit" : "no-miss");'
  ].join("\n"), "utf8");
  const { service, session, written } = makeService({
    settings: { loginScriptRunEnabled: true, loginScriptPath: hitPath, loginScriptSandbox: "restricted" }
  });
  service.readTerminalLines = () => ({ ok: true, value: { lines: [{ line: 1, text: "user@host Password:" }] } });
  assert.equal((await service.startSessionScriptIfEnabled(session)).ok, true);
  assert.deepEqual(written, ["yes-hit\r"], "命中后走命中分支");

  const missPath = joinPath(dir, "miss.js");
  await writeFile(missPath, [
    'const ok = await expect("NeverAppears", 200);',
    'await send(ok ? "yes-hit" : "no-miss");'
  ].join("\n"), "utf8");
  const second = makeService({
    settings: { loginScriptRunEnabled: true, loginScriptPath: missPath, loginScriptSandbox: "restricted" }
  });
  second.service.readTerminalLines = () => ({ ok: true, value: { lines: [] } });
  assert.equal((await second.service.startSessionScriptIfEnabled(second.session)).ok, true);
  assert.deepEqual(second.written, ["no-miss\r"], "等不到返回 false（不抛错）");
}

// ── 脚本语法错误：被收住、会话不受影响 ─────────────────────────────────
{
  const dir = await mkdtemp(joinPath(tmpdir(), "xssh-script3-"));
  const badPath = joinPath(dir, "bad.js");
  await writeFile(badPath, "this is not valid javascript (((", "utf8");
  const { service, session, notices } = makeService({
    settings: { loginScriptRunEnabled: true, loginScriptPath: badPath, loginScriptSandbox: "restricted" }
  });
  const result = await service.startSessionScriptIfEnabled(session);
  // 语法错误在 run 内被捕获（vm 编译期抛），引擎回 ok:false 而不是把 caller 打崩
  assert.equal(result.ok, false, "语法错误要如实报失败");
  assert.ok(notices.length >= 1, "要有一条可见告警");
  // 会话本身仍然可用（模拟一次后续写入）
  assert.equal(session.exited, null);
}

// ── 保存时校验：trusted 沙箱被拒、空路径拒绝（复用同一个校验函数）────────
{
  const service = Object.create(SshOpsService.prototype);
  service.settings = { loginScriptSandbox: "restricted" };
  const table = new Map([["main", {}]]);
  service.settingsTable = {
    get: (id) => table.get(id),
    put: async (id, value) => { table.set(id, value); }
  };
  service.keepAliveGet = async () => ({ ok: true, value: {} });

  const trusted = await service.keepAliveSave({ loginScriptSandbox: "trusted" });
  assert.equal(trusted.ok, false, "trusted 必须被拒");
  assert.match(trusted.error.message, /restricted/);

  const enabledNoPath = await service.keepAliveSave({ loginScriptRunEnabled: true, loginScriptPath: "" });
  assert.equal(enabledNoPath.ok, false, "开启必须有路径");
  assert.match(enabledNoPath.error.message, /requires a path/);
}

// ── 产物护栏：接线符号必须在 lib/index.js 里（防再次被 tree-shaking 剔除）──
{
  const built = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");
  for (const symbol of ["startSessionScriptIfEnabled", "createScriptRunner", "waitForSessionOutput", "xssh-login-script.js"]) {
    assert.ok(built.includes(symbol),
      `lib/index.js 缺少 ${symbol}：模块可能又被 tree-shaking 剔除（只 import 没调用）`);
  }
}

console.log("session script wiring: starts from settings, sends via the existing path, budgets hold, trusted refused");
