// RPC 返回值与**声明 schema** 的一致性（Remote 网关的真实拒绝点）。
//
// 为什么需要：客户端调 host 走 Remote 网关，网关按 `descriptors` 里登记的
// `result.schema` 校验返回值 —— **不符合就拒**，界面表现为空白/报错。
// 而"实现返回了什么"与"schema 声明了什么"分别写在两个文件里，没有任何东西保证一致。
// 本测试对**真实调用**的返回值跑 schema.safeParse，把这道缝补上。
//
// 实测的结构（descriptors.js 的 `def()`）：
//   { id, service, namespace, method, parameters:[{codec:{schema}}], result:{schema} }
// schema 对象**直接内联**在 descriptor 上，不需要按名字去 schemas.js 解析。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import SshOpsService from "../src/index.js";
import { createLineJournal } from "../src/line-journal.js";
import { DESCRIPTORS } from "../src/descriptors.js";


// ── ① 每个 descriptor 的结构完整（含 request/result 的 strict codec）──────
{
  const problems = [];
  for (const descriptor of DESCRIPTORS) {
    if (typeof descriptor.method !== "string" || descriptor.method === "") problems.push("有 descriptor 缺 method");
    if (descriptor.result?.schema === undefined) problems.push(`${descriptor.method}: 缺 result.schema`);
    if (descriptor.result?.mode !== "strict") problems.push(`${descriptor.method}: result.mode 不是 strict`);
    const requestParam = descriptor.parameters?.find((entry) => entry.name === "request");
    if (requestParam?.codec?.schema === undefined) problems.push(`${descriptor.method}: 缺 request codec.schema`);
    // `create` 与 `schema` 必须同时给（注释说明宿主两个版本分别读其中一个）
    if (typeof requestParam?.codec?.create !== "function") problems.push(`${descriptor.method}: request codec 缺 create`);
    if (typeof descriptor.result?.create !== "function") problems.push(`${descriptor.method}: result 缺 create`);
    if (descriptor.invocation?.kind !== "direct") problems.push(`${descriptor.method}: invocation.kind 应为 direct`);
  }
  assert.deepEqual(problems, [], `descriptor 结构问题：\n  ${problems.join("\n  ")}`);
  console.log(`① ${DESCRIPTORS.length} 个 descriptor 结构完整（result.schema / strict codec / create 均在位）`);
}

// ── ② result.schema 必须接受"标准 error envelope" ───────────────────────
//
// 防的是"schema 写过严/自相矛盾"：错误分支也是契约的一半，网关同样要能编码它。
{
  const failures = [];
  for (const descriptor of DESCRIPTORS) {
    const minimalError = { ok: false, error: { code: "test", message: "test" } };
    const parsed = descriptor.result.schema.safeParse(minimalError);
    if (!parsed.success) {
      failures.push(`${descriptor.method}: ${parsed.error.issues[0]?.message ?? "?"}`);
    }
  }
  assert.deepEqual(failures, [], `这些 result.schema 不接受标准 error envelope：\n  ${failures.join("\n  ")}`);
  console.log(`② ${DESCRIPTORS.length} 个 result.schema 都接受标准 error envelope`);
}

// ── ③ 真实调用 → 返回值必须通过 result.schema ──────────────────────────
//
// 只跑**不需要网络/凭据**的那些 —— 它们的返回值同样要过 schema，而且正是新增的
// tasks / keepAlive / terminalLines / commands 最容易写错的地方。
{
  const service = Object.create(SshOpsService.prototype);
  service.config = {
    maxBufferBytes: 65536, maxCaptureBytes: 65536,
    sessionLogEnabled: false, commandLedgerEnabled: false, commandIdleMs: 1500,
    lineJournalMaxLines: 2000, lineJournalMaxBytes: 512 * 1024,
    taskLedgerDir: mkdtempSync(joinPath(tmpdir(), "xssh-schema-")),
    localTmpDir: mkdtempSync(joinPath(tmpdir(), "xssh-schema-local-"))
  };
  service.settings = {
    sshKeepAliveEnabled: true, sshKeepAliveIntervalSec: 60, sshKeepAliveCountMax: 3,
    idleStringEnabled: false, idleStringIntervalSec: 60, idleStringText: "",
    tcpKeepAliveEnabled: false, tcpKeepAliveInitialDelaySec: 60,
    loginScriptRulesEnabled: false, loginScriptRules: [], expectMatchMode: "substring",
    expectStepTimeoutMs: 15000, onTimeout: "skip", loginScriptRunEnabled: false,
    loginScriptPath: "", loginScriptSandbox: "restricted"
  };
  const session = {
    id: "s-schema", connectionId: "conn-schema", exited: null,
    stream: { write: () => {} }, lineJournal: createLineJournal(),
    shellIntegration: null, buffer: "", captureBuffer: "", waiters: [],
    streamListeners: new Set(), inputLine: "", inputKnown: true, loginScript: null,
    lastActivityAt: Date.now()
  };
  service.connections = new Map([["conn-schema", { host: "192.0.2.1", port: 22, username: "u", sessions: new Set(["s-schema"]) }]]);
  service.sessions = new Map([["s-schema", session]]);
  service.activeConnectionId = "conn-schema";
  service.terminalOutput = () => ({ append() {} });
  service.sessionLogStore = () => null;
  service.wakeWaiters = () => {};
  service.notifyStreamListeners = () => {};
  service.updateInputMirror = () => {};
  service.appendTerminalNotice = () => {};
  service.savedResourceNameList = () => [];
  service.lineMark = () => 1;
  service.execOnConnection = async () => ({ ok: true, value: { stdout: "", stderr: "", exitCode: 0 } });
  service.settingsTable = { get: () => ({}), put: async () => {} };
  service.requireCredentialTable = () => new Map();
  service.requireProfileTable = () => new Map();
  service.requireKnownHostTable = () => new Map();
  service.requireGroupTable = () => new Map();

  // 每个条目：[descriptor 方法名, 标签, 调用]
  const CALLS = [
    ["keepAliveGet", "keepAliveGet()", () => service.keepAliveGet()],
    ["keepAliveTest", "keepAliveTest(conn)", () => service.keepAliveTest({ connectionId: "conn-schema" })],
    ["taskList", "taskList({})", () => service.taskList({})],
    ["taskDegradedNotices", "taskDegradedNotices()", () => service.taskDegradedNotices()],
    ["listCommands", "listCommands(session)", () => service.listCommands({ sessionId: "s-schema" })],
    ["readTerminalLines", "readTerminalLines(tail)", () => service.readTerminalLines({ sessionId: "s-schema", tailLines: 10 })],
    ["listKnownHosts", "listKnownHosts()", () => service.listKnownHosts({})],
    ["profileList", "profileList()", () => service.profileList()],
    ["credentialList", "credentialList()", () => service.credentialList()],
    ["groupList", "groupList()", () => service.groupList()],
    // 错误路径同样要符合 schema（`ok:false` 也是契约的一部分）
    ["taskStatus", "taskStatus(不存在)", () => service.taskStatus({ taskId: "nope" })],
    ["taskRead", "taskRead(不存在)", () => service.taskRead({ taskId: "nope" })],
    ["taskDelete", "taskDelete(不存在)", () => service.taskDelete({ taskId: "nope" })],
    ["forgetHostKey", "forgetHostKey(不存在)", () => service.forgetHostKey({ host: "192.0.2.9", port: 22 })],
    ["keepAliveSave", "keepAliveSave(非法值)", () => service.keepAliveSave({ sshKeepAliveIntervalSec: 999999 })]
  ];

  const byMethod = new Map(DESCRIPTORS.map((d) => [d.method, d]));
  const failures = [];
  const checked = [];
  for (const [method, label, invoke] of CALLS) {
    const descriptor = byMethod.get(method);
    if (descriptor === undefined) { failures.push(`${label}: descriptors 里没有方法 ${method}`); continue; }
    let value;
    try {
      value = await invoke();
    } catch (error) {
      // 同步抛错也算失败：契约要求**返回 envelope**（ok:true / ok:false），不是抛异常。
      failures.push(`${label}: 抛错而非返回 envelope —— ${error.message}`);
      continue;
    }
    const parsed = descriptor.result.schema.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
      failures.push(`${label}: 不符 result.schema\n      ${issues.slice(0, 5).join("\n      ")}`);
      continue;
    }
    checked.push(`${label} → ${value?.ok === false ? "error" : "ok"}`);
  }
  assert.deepEqual(failures, [], `RPC 返回值与声明 schema 不符（网关会拒、界面会空白）：\n  ${failures.join("\n  ")}`);
  console.log(`③ ${checked.length} 个 RPC 的**真实返回值**通过 result.schema：`);
  for (const line of checked) console.log(`     ${line}`);
}

console.log("\nRPC schema 一致性：descriptor 结构完整、error envelope 被接受、真实返回值全部合规");
