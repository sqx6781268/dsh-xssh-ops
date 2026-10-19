// 后台任务台账（M4）：落点如实记录、降级告警留存、TTL 只清已结束的任务、
// JSONL 落盘与重载（后写覆盖先写）、以及 taskId 序号在重载后不回退。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { TASK_STATES, createTaskLedger, makeTaskId } from "../src/task-ledger.js";

/** 固定时钟。 */
function makeLedger(options = {}) {
  let clock = 1_700_000_000_000;
  const ledger = createTaskLedger({ now: () => clock, ...options });
  return { ledger, advance: (ms) => { clock += ms; }, at: () => clock };
}

const COMMON = {
  connectionId: "conn-1",
  host: "192.0.2.10",
  commandId: "c0000001-abcd",
  command: "tar czf /root/b.tgz /root/s",
  label: "backup"
};

// ── 状态集合与 ID 形态 ───────────────────────────────────────────────────
{
  assert.deepEqual(TASK_STATES, ["running", "done", "missing", "degraded-aborted", "expired", "deleted"]);
  assert.equal(makeTaskId(12, "9c2d"), "t000012-9c2d");
  assert.match(makeTaskId(1), /^t000001-[0-9a-f]{4}$/, "序号补到 6 位");
}

// ── 创建：落点与告警必须如实记录 ─────────────────────────────────────────
{
  const { ledger } = makeLedger();
  const task = ledger.create({
    ...COMMON,
    location: "remote-tmp",
    degraded: false,
    warnings: [],
    remoteDir: "/tmp/.dsh-xssh-ops/t000001-abcd",
    pid: 4242
  });
  assert.equal(task.state, "running");
  assert.equal(task.location, "remote-tmp");
  assert.equal(task.degraded, false);
  assert.deepEqual(task.warnings, []);
  assert.equal(task.remoteDir, "/tmp/.dsh-xssh-ops/t000001-abcd");
  assert.equal(task.localDir, null);
  assert.equal(task.exitCode, null);
  assert.deepEqual(task.bytes, { out: 0, err: 0 });
  assert.equal(typeof task.startedAt, "string");
  assert.equal(task.finishedAt, null);
}

// ── location 必填：落点不明的任务记录没有价值 ────────────────────────────
{
  const { ledger } = makeLedger();
  assert.throws(() => ledger.create({ ...COMMON }), /location is required/);
  assert.throws(() => ledger.create({ ...COMMON, location: "" }), /location is required/);
}

// ── 降级任务：告警原样留存（日志页签要能复查）──────────────────────────
{
  const { ledger } = makeLedger();
  const warnings = ["已降级到本地临时目录", "断线即中断", "远端磁盘不足需处理"];
  const task = ledger.create({ ...COMMON, location: "local", degraded: true, warnings, localDir: "C:/Temp/xssh/t1" });
  assert.equal(task.degraded, true);
  assert.deepEqual(task.warnings, warnings, "告警不得被截断或改写");
  assert.equal(task.remoteDir, null);
  assert.equal(task.localDir, "C:/Temp/xssh/t1");
  // 后续追加的告警要并进去，而不是覆盖
  ledger.update(task.taskId, { warnings: ["额外一条"] });
  assert.deepEqual(ledger.byId(task.taskId).warnings, [...warnings, "额外一条"]);
}

// ── update：状态、退出码、字节数、完成时间、**落点路径** ────────────────
{
  const { ledger, advance } = makeLedger();
  const task = ledger.create({ ...COMMON, location: "remote-tmp" });
  advance(5000);
  const updated = ledger.update(task.taskId, { state: "done", exitCode: 0, bytes: { out: 1234, err: 0 } });
  assert.equal(updated.state, "done");
  assert.equal(updated.exitCode, 0);
  assert.deepEqual(updated.bytes, { out: 1234, err: 0 });
  assert.equal(typeof updated.finishedAt, "string", "结束时间要打上");

  // 落点路径必须能通过 update 落账：execBackground 是先建记录、后拿到目录名
  // （目录名依赖 taskId），漏了这两个字段会让产物路径永远是 null —— 之后
  // task_read / task_status / task_delete 全部失效（实测踩到）。
  const withPaths = ledger.create({ ...COMMON, location: "remote-tmp" });
  ledger.update(withPaths.taskId, { remoteDir: "/tmp/.dsh-xssh-ops/t9" });
  assert.equal(ledger.byId(withPaths.taskId).remoteDir, "/tmp/.dsh-xssh-ops/t9");
  ledger.update(withPaths.taskId, { localDir: "C:/Temp/xssh/t9" });
  assert.equal(ledger.byId(withPaths.taskId).localDir, "C:/Temp/xssh/t9");
  assert.equal(ledger.byId(withPaths.taskId).remoteDir, "/tmp/.dsh-xssh-ops/t9", "改本地路径不该清掉远端路径");

  // 非法状态被忽略（不改状态，也不抛错）
  ledger.update(task.taskId, { state: "nonsense" });
  assert.equal(ledger.byId(task.taskId).state, "done");
  // 不存在的任务返回 null 而不是抛错
  assert.equal(ledger.update("t999999-xxxx", { state: "done" }), null);
}

// ── recent：倒序 + 按连接过滤 ────────────────────────────────────────────
{
  const { ledger } = makeLedger();
  ledger.create({ ...COMMON, command: "first", location: "remote-tmp" });
  ledger.create({ ...COMMON, command: "second", location: "remote-tmp" });
  ledger.create({ ...COMMON, commandId: "c2", connectionId: "conn-2", command: "third", location: "local", degraded: true });
  assert.deepEqual(ledger.recent().map((t) => t.command), ["third", "second", "first"]);
  assert.deepEqual(ledger.recent({ connectionId: "conn-1" }).map((t) => t.command), ["second", "first"]);
  assert.equal(ledger.recent({ limit: 1 }).length, 1);
}

// ── TTL：只挑「已结束且未删」的，还在跑的不许被清 ───────────────────────
{
  const { ledger, advance } = makeLedger({ ttlHours: 24 });
  const done = ledger.create({ ...COMMON, location: "remote-tmp" });
  ledger.update(done.taskId, { state: "done", exitCode: 0 });
  const running = ledger.create({ ...COMMON, location: "remote-tmp" });
  advance(25 * 3600 * 1000);
  const expired = ledger.expired();
  assert.deepEqual(expired.map((t) => t.taskId), [done.taskId], "只挑已结束的");
  assert.equal(expired.some((t) => t.taskId === running.taskId), false, "运行中的任务不能被 TTL 清掉");

  ledger.markExpired(done.taskId);
  assert.equal(ledger.byId(done.taskId).state, "expired");
  assert.equal(typeof ledger.byId(done.taskId).expiredAt, "string");
  // 已过期的不再被重复挑出
  assert.deepEqual(ledger.expired(), []);
}

// ── 删除标记 ─────────────────────────────────────────────────────────────
{
  const { ledger } = makeLedger();
  const task = ledger.create({ ...COMMON, location: "remote-tmp" });
  ledger.markDeleted(task.taskId);
  const marked = ledger.byId(task.taskId);
  assert.equal(marked.state, "deleted");
  assert.equal(typeof marked.deletedAt, "string");
}

// ── 落盘与重载：后写覆盖先写；taskId 序号不回退 ─────────────────────────
{
  const dir = await mkdtemp(joinPath(tmpdir(), "xssh-task-"));
  try {
    const { ledger } = makeLedger({ dir });
    const writes = [];
    // 落盘是 fire-and-forget，但要能等到（避免用 setTimeout 造成不稳定用例）
    const a = ledger.create({ ...COMMON, location: "remote-tmp" });
    ledger.update(a.taskId, { state: "done", exitCode: 0, bytes: { out: 10, err: 0 } });
    const b = ledger.create({ ...COMMON, command: "second", location: "local", degraded: true, warnings: ["降级"] });

    // 等写盘：轮询文件出现且含两条记录
    const file = joinPath(dir, "tasks.jsonl");
    for (let i = 0; i < 50; i += 1) {
      try {
        const raw = await readFile(file, "utf8");
        if (raw.split("\n").filter(Boolean).length >= 4) break;
      } catch { /* 还没建 */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const loaded = await ledger.load();
    assert.equal(loaded.length, 2, "同一 taskId 的多行合并成一条");
    const byId = new Map(loaded.map((t) => [t.taskId, t]));
    assert.equal(byId.get(a.taskId).state, "done", "重载取后写（已结束）那条");
    assert.equal(byId.get(a.taskId).exitCode, 0);
    assert.equal(byId.get(b.taskId).degraded, true, "降级标记要能重载回来");
    assert.deepEqual(byId.get(b.taskId).warnings, ["降级"]);

    // 重载进新台账：序号续号，新任务 ID 不与旧的撞车
    const revived = createTaskLedger();
    assert.equal(revived.restore(loaded), 2);
    const next = revived.create({ ...COMMON, location: "remote-tmp" });
    assert.ok(next.taskId > b.taskId, `序号必须续号（${next.taskId} > ${b.taskId}）`);

    // 缺文件不报错
    assert.deepEqual(await createTaskLedger({ dir: joinPath(dir, "nope") }).load(), []);
    void writes;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── prune：按天数压缩落盘文件 ────────────────────────────────────────────
{
  const dir = await mkdtemp(joinPath(tmpdir(), "xssh-task-prune-"));
  try {
    const { ledger, at } = makeLedger({ dir });
    ledger.create({ ...COMMON, location: "remote-tmp" });
    for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const kept = await ledger.prune({ days: 30, at: at() + 31 * 24 * 3600 * 1000 });
    assert.equal(kept, 0, "超过 30 天的记录被清掉");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── 坏行不毁掉整份台账 ──────────────────────────────────────────────────
{
  const dir = await mkdtemp(joinPath(tmpdir(), "xssh-task-bad-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    const { ledger } = makeLedger({ dir });
    await writeFile(joinPath(dir, "tasks.jsonl"), [
      JSON.stringify({ taskId: "t000001-aaaa", location: "remote-tmp", startedAt: new Date().toISOString() }),
      "{ 半行被截断",
      "not json",
      JSON.stringify({ taskId: "t000002-bbbb", location: "local", startedAt: new Date().toISOString() }),
      ""
    ].join("\n"), "utf8");
    const loaded = await ledger.load();
    assert.equal(loaded.length, 2, "坏行跳过，好行保留");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("task ledger: honest location/warning records, TTL rules, JSONL reload and pruning all hold");
