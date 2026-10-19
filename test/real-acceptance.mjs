// 真机验收（真实服务器，由操作者已在 DSH 里保存好资源与凭据）。
//
// 直接加载 host 产物、构造服务、用保存的资源连接，然后跑真实链路：
//   连接 → 行日志 → 编辑框发命令 → 台账区间 → 按 ID 取输出 → 后台任务 → 删除。
//
// 注意：凭据存在宿主的 credential store —— 本测试跑在插件进程外，拿不到宿主实例。
// 因此这里验证的是**协议与服务层**链路（连得上、行号对、台账对、工具对），
// 认证方式用「操作者提供的临时口令环境变量」或者跳过需要凭据的步骤。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { createRequire } from "node:module";

const ROOT = "D:/ob笔记/02-开发目录/dsh-xssh-ops/repo";
const require = createRequire(import.meta.url);
const host = require(joinPath(ROOT, "lib/index.js"));
const Plugin = host.default;

const HOST = process.env.XSSH_REAL_HOST;
const PORT = Number(process.env.XSSH_REAL_PORT ?? 22);
const USER = process.env.XSSH_REAL_USER ?? "root";
const PASS = process.env.XSSH_REAL_PASS;

if (!HOST || !PASS) {
  console.log("需要环境变量 XSSH_REAL_HOST / XSSH_REAL_PASS（可选 XSSH_REAL_PORT / XSSH_REAL_USER）。");
  console.log("这是真机验收：凭据由操作者临时提供，不落盘。");
  process.exit(0);
}

// 最小 ctx：不碰宿主 storage/credentials（进程外拿不到），日志全静默
const effects = [];
const ctx = {
  effect(cb, label) { effects.push({ cb, label }); return () => {}; },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  storage: undefined, credentials: undefined, locale: undefined
};
const service = new Plugin(ctx, {
  sessionLogEnabled: false,
  commandLedgerEnabled: true,
  commandLedgerDir: mkdtempSync(joinPath(tmpdir(), "xssh-real-ledger-")),
  taskLedgerDir: mkdtempSync(joinPath(tmpdir(), "xssh-real-task-")),
  localTmpDir: mkdtempSync(joinPath(tmpdir(), "xssh-real-local-"))
});
service.settings = {};

console.log(`连接真实服务器 ${USER}@${HOST}:${PORT} …`);
const connected = await service.connect({
  host: HOST, port: PORT, username: USER,
  authKind: "password", secret: PASS,
  name: "real-acceptance",
  hostKeyMode: "accept-new",
  keepaliveInterval: 30, keepaliveCountMax: 3
});
if (!connected.ok) {
  console.log("连接失败:", JSON.stringify(connected.error));
  process.exit(1);
}
const connectionId = connected.value.connectionId;
console.log(`✅ 已连接 connectionId=${connectionId}`);

// ① 打开终端会话
const opened = await service.openSession({ connectionId });
assert.equal(opened.ok, true, `openSession: ${opened.error?.message}`);
const sessionId = opened.value.sessionId;
console.log(`✅ 会话 sessionId=${sessionId}`);

// 等 shell 就绪（轮询读行日志，等出现常见提示符或任意输出）
let ready = false;
for (let i = 0; i < 100; i += 1) {
  const read = service.readTerminalLines({ sessionId, tailLines: 30 });
  if (read.ok && read.value.totalLines > 0) { ready = true; break; }
  await new Promise((r) => setTimeout(r, 100));
}
const first = service.readTerminalLines({ sessionId, tailLines: 30 });
console.log(`✅ 行日志 ${first.value.totalLines} 行（shell 就绪=${ready}）`);
assert.equal(first.value.lines.some((l) => l.text.includes("\u001b")), false, "行日志无 ESC 残留");

// ② 编辑框发命令 → 台账
const sent = await service.sendCommand({ sessionId, text: "echo REAL-ACCEPT-01 && hostname", pressEnter: true });
assert.equal(sent.ok, true, `sendCommand: ${sent.error?.message}`);
console.log(`✅ 发命令 commandId=${sent.value.commandId} startLine=${sent.value.startLine}`);

// 等输出
let done = false;
for (let i = 0; i < 100; i += 1) {
  const rec = service.ledgerFor(service.sessions.get(sessionId)).byId(sent.value.commandId);
  if (rec && rec.closedBy !== null) { done = true; break; }
  await new Promise((r) => setTimeout(r, 100));
}
assert.equal(done, true, "命令应闭口");
const rec = service.ledgerFor(service.sessions.get(sessionId)).byId(sent.value.commandId);
console.log(`✅ 台账区间 [${rec.startLine},${rec.endLine}] closedBy=${rec.closedBy}`);

// ③ 按 ID 取输出（直接用 readTerminalLines 的区间读，与工具层同一逻辑）
const range = service.readTerminalLines({ sessionId, fromLine: rec.startLine, toLine: rec.endLine });
const body = range.value.lines.map((l) => l.text).join("\n");
assert.ok(body.includes("REAL-ACCEPT-01"), `区间应含命令输出（实际 ${JSON.stringify(body.slice(0, 200))}）`);
assert.ok(body.includes("REAL-ACCEPT-01"), "应含 echo 回显");
console.log(`✅ 区间输出: ${JSON.stringify(body.split("\n").slice(0, 4))}`);

// ④ 后台任务（真实远端）
const bg = await service.execBackground({ connectionId, command: "sleep 2; echo BG-REAL-DONE" });
assert.equal(bg.ok, true, `后台下发: ${bg.error?.message}`);
console.log(`✅ 后台任务 ${bg.value.taskId} @ ${bg.value.remoteDir}（location=${bg.value.location}）`);
let bgDone = false;
for (let i = 0; i < 120; i += 1) {
  const st = await service.taskStatus({ taskId: bg.value.taskId });
  if (st.ok && st.value.state === "done") { bgDone = true; break; }
  await new Promise((r) => setTimeout(r, 100));
}
assert.equal(bgDone, true, "后台任务应完成");
const bgRead = await service.taskRead({ taskId: bg.value.taskId, stream: "out" });
assert.ok(bgRead.value.text.includes("BG-REAL-DONE"), `后台输出应含标记（实际 ${JSON.stringify(bgRead.value.text.slice(0, 200))}）`);
console.log(`✅ 后台任务输出: ${JSON.stringify(bgRead.value.lines.map((l) => l.text))}`);
const del = await service.taskDelete({ taskId: bg.value.taskId });
assert.equal(del.ok, true, "删除应成功");
console.log(`✅ 后台产物已删除`);

// ⑤ 收尾：断开
await service.disconnect({ connectionId });
console.log("✅ 已断开");

console.log("\n真机验收通过：连接/行日志/命令台账/区间读取/后台任务全链路在真实服务器上工作");
