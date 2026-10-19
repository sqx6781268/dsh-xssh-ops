// M4 客户端契约：后台任务/降级告警的 Remote 方法面必须齐全，且客户端调用的方法名
// 都在 host 侧真的存在。
//
// 为什么需要：客户端 `api.js` 走字符串方法名（`this.call("taskList", …)`），拼错不会
// 在构建期报错，而是在用户点开视图时才失败。这个测试把「客户端调用的方法」与
// 「host 注册的方法」做集合比对。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DESCRIPTORS } from "../src/descriptors.js";
import SshOpsService from "../src/index.js";

// ── 1. 客户端 api.js 里 task* / keepAlive* / command* 方法名都在 descriptors 中 ──
{
  const api = await readFile(new URL("../src/client/api.js", import.meta.url), "utf8");
  const called = new Set([...api.matchAll(/this\.call\("([A-Za-z0-9_]+)"/g)].map((m) => m[1]));
  const registered = new Set(DESCRIPTORS.map((descriptor) => descriptor.method));

  const missing = [...called].filter((name) => !registered.has(name));
  assert.deepEqual(missing, [], `客户端调用了 host 未注册的方法：${missing.join(", ")}`);

  // M4 的五个方法必须真的被客户端用到（视图才有数据）
  for (const name of ["taskList", "taskDegradedNotices", "taskStatus", "taskRead", "taskDelete"]) {
    assert.equal(called.has(name), true, `客户端应调用 ${name}`);
    assert.equal(registered.has(name), true, `host 应注册 ${name}`);
  }
}

// ── 2. host 侧的 task* 方法确实存在且可调用（名字与 descriptor 对齐）──────────
{
  const service = Object.create(SshOpsService.prototype);
  for (const name of ["taskList", "taskDegradedNotices", "taskStatus", "taskRead", "taskDelete", "sweepExpiredTasks"]) {
    assert.equal(typeof service[name], "function", `host 缺少方法 ${name}`);
  }
}

// ── 3. 任务列表返回契约字段（客户端按这些字段渲染，铺平 outBytes/errBytes）────
{
  const service = Object.create(SshOpsService.prototype);
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  service.config = { taskLedgerDir: mkdtempSync(join(tmpdir(), "xssh-contract-")) };
  const ledger = service.taskLedger();
  const task = ledger.create({
    connectionId: "c1", host: "192.0.2.1", commandId: "cmd1", command: "echo hi",
    label: "demo", location: "local", degraded: true, warnings: ["结果不留远端"], localDir: "/tmp/l1"
  });
  ledger.update(task.taskId, { state: "done", exitCode: 0, bytes: { out: 12, err: 3 } });

  const listed = service.taskList({});
  const entry = listed.value.tasks[0];
  // 客户端渲染依赖的字段一个都不能少
  for (const key of [
    "taskId", "connectionId", "host", "commandId", "command", "label",
    "location", "degraded", "warnings", "remoteDir", "localDir",
    "state", "exitCode", "outBytes", "errBytes", "startedAt", "finishedAt"
  ]) {
    assert.ok(Object.hasOwn(entry, key), `任务记录缺字段 ${key}`);
  }
  assert.equal(entry.outBytes, 12, "bytes 要铺平成 outBytes");
  assert.equal(entry.errBytes, 3);
  assert.equal(entry.degraded, true);
  assert.deepEqual(entry.warnings, ["结果不留远端"], "降级告警要原样回传");

  // 2. 降级告警汇总只含未结束的降级任务
  const notices = service.taskDegradedNotices();
  assert.equal(notices.value.degraded.length, 0, "已结束的降级任务不该占着告警条");
  const running = ledger.create({ connectionId: "c1", command: "long", location: "local", degraded: true, warnings: ["断线即中断"] });
  assert.equal(service.taskDegradedNotices().value.degraded.length, 1, "运行中的降级任务要出现在告警里");
  assert.equal(service.taskDegradedNotices().value.degraded[0].taskId, running.taskId);
}

console.log("background task contract: client calls resolve, host methods exist, list fields complete");
