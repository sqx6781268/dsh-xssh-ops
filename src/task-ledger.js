/**
 * 后台任务台账（计划 5.7 / M4）
 *
 * 与命令台账的关系：**一条后台任务同时也是一条命令**（`commandId`，来源
 * `agent-bg`），所以两者用同一个 commandId 串起来；任务台账额外记住**落点**
 * （`remote-tmp` / `remote-home` / `local`）、文件路径与降级标记。
 *
 * 三条必须守住的语义：
 * 1. **落点必须如实记录**：降级到本地却记成远端，用户会以为结果留在服务器上 ——
 *    这与「结果文件在哪」直接相关，是排障时第一个要看的字段。
 * 2. **降级告警原样落台账**：`warnings` 不丢，日志页签能复查（计划 5.5.5 要求
 *    降级告警同时出现在三处）。
 * 3. **TTL 与删除状态可追**：`expired` / `deleted` 是显式状态，不靠「文件不存在」
 *    反推（那无法区分「没跑完」与「被清理了」）。
 *
 * 落盘复用命令台账的 JSONL 写法（同目录家族：`~/.dsh/xssh-ops/`），并且同样
 * **按会话/任务顺序化写入** —— 这个坑在命令台账上已经踩过一次（open 那行可能
 * 晚于 update 那行落盘，重载时把已闭口记录覆盖回未闭口）。
 */
import { mkdir, appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { DEFAULT_TASK_TTL_HOURS } from "./task-dir.js";

/** 任务状态。`missing` = 远端产物已不在（被清理或从未建成）。 */
export const TASK_STATES = ["running", "done", "missing", "degraded-aborted", "expired", "deleted"];

/** 生成 taskId（`t000012-9c2d` 形态，序号 + 随机后缀便于人读与排序）。 */
export function makeTaskId(seq, suffix) {
  const tail = suffix ?? Math.random().toString(16).slice(2, 6);
  return `t${String(seq).padStart(6, "0")}-${tail}`;
}

/**
 * 建一份任务台账（内存索引 + 可选落盘）。
 *
 * @param {object} options
 * @param {string} options.dir 落盘目录；不给则纯内存（测试用）
 * @param {() => number} [options.now]
 * @param {number} [options.ttlHours]
 */
export function createTaskLedger({ dir = null, now = () => Date.now(), ttlHours = DEFAULT_TASK_TTL_HOURS } = {}) {
  /** @type {Map<string, object>} 插入序 = 创建序 */
  const tasks = new Map();
  let seq = 0;
  /** 每个任务一条写入链：避免 open/update 两行乱序落盘（命令台账踩过的坑）。 */
  const chains = new Map();
  const file = dir === null ? null : joinPath(dir, "tasks.jsonl");

  function enqueue(taskId, task) {
    if (file === null) return Promise.resolve();
    const previous = chains.get(taskId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(dir, { recursive: true });
      await appendFile(file, `${JSON.stringify(task)}\n`, "utf8");
    }, async () => {
      await mkdir(dir, { recursive: true });
      await appendFile(file, `${JSON.stringify(task)}\n`, "utf8");
    });
    chains.set(taskId, next.catch(() => {}));
    return next;
  }

  return {
    dir,

    /** 创建一条任务记录。`location` 与 `warnings` 必填 —— 它们是要如实记录的事实。 */
    create({
      connectionId = null,
      host = null,
      commandId = null,
      command = "",
      label = "",
      location,
      degraded = false,
      warnings = [],
      remoteDir = null,
      localDir = null,
      pid = null,
      startedAt
    } = {}) {
      if (typeof location !== "string" || location === "") {
        throw new Error("task ledger: location is required (where the results actually live)");
      }
      seq += 1;
      const taskId = makeTaskId(seq);
      const stamp = Number.isFinite(startedAt) ? startedAt : now();
      const task = {
        taskId,
        connectionId,
        host,
        commandId,
        command,
        label,
        location,
        degraded: degraded === true,
        // 告警原样留存：日志页签要能复查降级原因（计划 5.5.5 要求三处一致）。
        warnings: [...warnings],
        remoteDir,
        localDir,
        pid,
        state: "running",
        exitCode: null,
        bytes: { out: 0, err: 0 },
        startedAt: new Date(stamp).toISOString(),
        finishedAt: null,
        deletedAt: null,
        expiredAt: null
      };
      tasks.set(taskId, task);
      void enqueue(taskId, task);
      return task;
    },

    byId(taskId) {
      return tasks.get(taskId) ?? null;
    },

    /** 最近的任务（倒序），可按连接过滤。 */
    recent({ limit = 20, connectionId = undefined } = {}) {
      const list = [...tasks.values()].filter((task) => connectionId === undefined || task.connectionId === connectionId);
      list.reverse();
      return list.slice(0, Number.isSafeInteger(limit) && limit > 0 ? limit : 20);
    },

    /** 更新运行态（state / exitCode / bytes / pid / warnings / 落点路径）。 */
    update(taskId, patch = {}) {
      const task = tasks.get(taskId);
      // Map.get 对缺失键返回 **undefined** 而不是 null —— 只判 null 会在
      // 「不存在的 taskId」上崩（实测）。这里统一用宽松判定。
      if (task === undefined) return null;
      if (typeof patch.state === "string" && TASK_STATES.includes(patch.state)) task.state = patch.state;
      if (patch.exitCode !== undefined) task.exitCode = patch.exitCode;
      if (patch.bytes !== undefined) task.bytes = { ...task.bytes, ...patch.bytes };
      if (patch.warnings !== undefined) task.warnings = [...task.warnings, ...patch.warnings];
      if (patch.pid !== undefined) task.pid = patch.pid;
      // 落点路径必须能通过 update 落账：`execBackground` 是**先建记录、后拿到路径**
      // （目录名依赖 taskId），漏了这两个字段会让产物路径永远为 null —— 之后
      // task_read / task_status / task_delete 全部失效（实测踩到）。
      if (patch.remoteDir !== undefined) task.remoteDir = patch.remoteDir;
      if (patch.localDir !== undefined) task.localDir = patch.localDir;
      if (task.state !== "running" && task.finishedAt === null) {
        task.finishedAt = new Date(Number.isFinite(patch.at) ? patch.at : now()).toISOString();
      }
      void enqueue(taskId, task);
      return task;
    },

    /** 标记已删除（`xssh_task_delete`）。 */
    markDeleted(taskId, at) {
      const task = tasks.get(taskId);
      // Map.get 对缺失键返回 **undefined** 而不是 null —— 只判 null 会在
      // 「不存在的 taskId」上崩（实测）。这里统一用宽松判定。
      if (task === undefined) return null;
      task.state = "deleted";
      task.deletedAt = new Date(Number.isFinite(at) ? at : now()).toISOString();
      void enqueue(taskId, task);
      return task;
    },

    /**
     * 按 TTL 找出该过期的任务（计划 5.7：默认 24 h）。
     * **只挑「已结束且未删」的**：还在跑的任务不能因为超龄就被清掉。
     */
    expired({ at = now(), ttl = ttlHours } = {}) {
      const floor = at - ttl * 3600 * 1000;
      return [...tasks.values()].filter((task) => {
        if (task.state === "deleted" || task.state === "expired") return false;
        if (task.state === "running") return false;
        const stamp = Date.parse(task.finishedAt ?? task.startedAt ?? "");
        return Number.isFinite(stamp) && stamp < floor;
      });
    },

    /** 标记过期（清理远端目录之后调用）。 */
    markExpired(taskId, at) {
      const task = tasks.get(taskId);
      // Map.get 对缺失键返回 **undefined** 而不是 null —— 只判 null 会在
      // 「不存在的 taskId」上崩（实测）。这里统一用宽松判定。
      if (task === undefined) return null;
      task.state = "expired";
      task.expiredAt = new Date(Number.isFinite(at) ? at : now()).toISOString();
      void enqueue(taskId, task);
      return task;
    },

    size() {
      return tasks.size;
    },

    all() {
      return [...tasks.values()];
    },

    /** 从 JSONL 恢复（同 taskId 后写覆盖先写）。 */
    restore(list) {
      let maxSeq = seq;
      for (const item of list) {
        if (item === null || typeof item !== "object" || typeof item.taskId !== "string") continue;
        tasks.set(item.taskId, { ...item });
        // 序号要从 taskId 里恢复，否则重启后新任务 ID 会与旧的撞车。
        const parsed = Number.parseInt(String(item.taskId).slice(1, 7), 10);
        if (Number.isFinite(parsed) && parsed > maxSeq) maxSeq = parsed;
      }
      seq = maxSeq;
      return tasks.size;
    },

    /** 读取落盘记录（后写覆盖先写）。 */
    async load({ tail = 500 } = {}) {
      if (file === null) return [];
      let raw;
      try {
        raw = await readFile(file, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
      const lines = raw.split("\n").filter((line) => line.trim() !== "");
      const slice = Number.isSafeInteger(tail) && tail > 0 ? lines.slice(-tail) : lines;
      const merged = new Map();
      for (const line of slice) {
        let item;
        try { item = JSON.parse(line); } catch { continue; } // 半行/坏行跳过
        if (item !== null && typeof item === "object" && typeof item.taskId === "string") merged.set(item.taskId, item);
      }
      return [...merged.values()];
    },

    /** 压缩落盘文件（按 TTL 丢掉过老记录）。 */
    async prune({ days = 30, at = now() } = {}) {
      if (file === null) return 0;
      const floor = at - days * 24 * 3600 * 1000;
      const kept = [...tasks.values()].filter((task) => {
        const stamp = Date.parse(task.startedAt ?? "");
        return !Number.isFinite(stamp) || stamp >= floor;
      });
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, kept.map((task) => JSON.stringify(task)).join("\n") + (kept.length > 0 ? "\n" : ""), "utf8");
      await rename(tmp, file);
      return kept.length;
    }
  };
}
