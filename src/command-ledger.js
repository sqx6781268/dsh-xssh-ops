/**
 * 命令台账（内存索引 + JSONL 落盘）
 *
 * 解决的问题：面板与智能体都能往终端写，但没有「谁、什么时候、发了什么、对应哪一段
 * 输出、成功与否」。（计划 5.4 / R3 R4 R6）
 *
 * 三条必须守住的语义：
 *
 * 1. **区间靠闭口判据定，且先到先定**：① shell-integration 的 OSC 133 `D`（带 exit code）
 *    ② 空闲静默（默认 1500 ms）③ 下一条命令发出。三条判据谁先到谁闭口，**闭口后绝不改写**
 *    —— 否则后到的空闲定时器会把已经确定的区间拉长，智能体按区间取回的正文就变了。
 * 2. **命令回显行不属于结果区间**：发送前记 `markLine`（命令回显将占的那一行），
 *    `startLine = markLine + 1`。否则智能体拿到的「输出」第一条永远是命令自己。
 * 3. **落盘脱敏**（Q10 = 脱敏后存）：`text` 存的是 `redactForModel` 之后的内容，
 *    并保留 `redacted` 标记，使用者能知道「这里可能被掩码过」。内存里同样脱敏 ——
 *    内存与磁盘不一致会变成更难查的 bug。
 *
 * 行号来自 `src/line-journal.js`：行号单调、永不复用，所以区间可以长期作为引用。
 */
import { mkdir, appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { randomUUID } from "node:crypto";
import { redactForModel } from "./redact.js";

/** 空闲静默闭口的默认阈值（计划 5.4 判据②，可配 `commandIdleMs`）。 */
export const DEFAULT_IDLE_CLOSE_MS = 1500;
/** 台账保留期（Q5 建议值：7 天 / 5000 条，先用建议值，实测后调）。 */
export const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_RETENTION_COUNT = 5000;
/** 启动时按需加载的尾部条数。 */
export const DEFAULT_LOAD_TAIL = 500;
/** `byText(..., { match: "substring" })` 默认返回的候选条数（9-Q8 未定，先用 5）。 */
export const DEFAULT_SUBSTRING_LIMIT = 5;

/** 命令来源。区分它才能回答「这条是谁发的」。 */
export const COMMAND_SOURCES = [
  "user-editbox",   // 命令编辑框（常用通道，记台账）
  "user-direct",    // 直接在 xterm 里敲（备用通道，提交时才补记，见 9-Q4）
  "agent-tool",     // 智能体经工具发送
  "agent-bg",       // 智能体后台执行
  "confirm-card",   // 危险命令确认卡片
  "login-script"    // 登录脚本 / 保活字符串（默认被列表过滤）
];

/** 默认过滤掉的来源：登录脚本不该污染「我发过什么命令」。
 *  注意**保活字符串不在此列** —— 它根本不进台账（见 plan 5.8 的隔离要求），
 *  所以不需要一个"隐藏来源"来表示它（早期曾有个 KEEPALIVE_SOURCE 常量，属多余，已删）。 */
export const DEFAULT_HIDDEN_SOURCES = ["login-script"];

function makeCommandId(seq, idFactory) {
  if (typeof idFactory === "function") return idFactory(seq);
  return `c${String(seq).padStart(7, "0")}-${randomUUID().slice(0, 4)}`;
}

/**
 * 一份会话级的命令台账。
 *
 * @param {object} options
 * @param {string} options.sessionId
 * @param {string|null} [options.connectionId]
 * @param {string|null} [options.host]
 * @param {number} [options.idleCloseMs]
 * @param {() => number} [options.now] 注入时钟（测试用）
 * @param {(seq: number) => string} [options.idFactory] 注入 ID 生成（测试用）
 * @param {(record: object, event: "open"|"update") => void} [options.onRecord] 落盘钩子
 * @param {number} [options.seqStart] 从已有 JSONL 续号
 */
export function createCommandLedger({
  sessionId,
  connectionId = null,
  host = null,
  idleCloseMs = DEFAULT_IDLE_CLOSE_MS,
  now = () => Date.now(),
  idFactory,
  onRecord = null,
  seqStart = 0
} = {}) {
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new Error("command ledger needs a sessionId");
  }
  const idleMs = Number.isFinite(idleCloseMs) && idleCloseMs >= 0 ? idleCloseMs : DEFAULT_IDLE_CLOSE_MS;

  /** @type {Map<string, object>} 保持插入序 = 命令发出序 */
  const records = new Map();
  let seq = Number.isSafeInteger(seqStart) && seqStart > 0 ? seqStart : 0;
  /** 未闭口记录的 commandId（同一会话同时只应有一条，见「下一条命令截断」）。 */
  let openId = null;
  let lastOutputAt = null;
  let interactive = false;

  const get = (commandId) => records.get(commandId) ?? null;

  function emit(record, event) {
    if (typeof onRecord === "function") {
      try { onRecord({ ...record }, event); } catch { /* 落盘失败不能影响会话 */ }
    }
  }

  function closeRecord(record, { endLine, exitCode, closedBy, at }) {
    // 先到先定：已闭口就不再改写（计划 5.4 的显式优先级要求）。
    if (record === null || record.endLine !== null || record.closedBy !== null) return record;
    record.endLine = Number.isSafeInteger(endLine) ? endLine : record.startLine - 1;
    record.exitCode = Number.isSafeInteger(exitCode) ? exitCode : null;
    record.closedBy = closedBy;
    record.status =
      closedBy === "session-end" && record.exitCode === null
        ? "unknown"
        : closedBy === "shell-integration" || closedBy === "idle-timeout" || closedBy === "next-command" || closedBy === "exec"
          ? "done"
          : "unknown";
    // 闭口时间可注入：调用方（如 closeIfIdle 的判定、测试）已经知道"现在"是什么时刻，
    // 再用模块内部的 now() 会造成两处时间线不一致（判定用注入值、记录用当前值）。
    record.closedAt = new Date(Number.isFinite(at) ? at : now()).toISOString();
    if (openId === record.commandId) openId = null;
    emit(record, "update");
    return record;
  }

  return {
    sessionId,

    /**
     * 记一条命令。
     * @param {object} input
     * @param {string} input.text 命令原文
     * @param {number} input.markLine 命令回显将占用的行号（= 行日志的 `nextLine()`）
     * @param {string} [input.source]
     * @param {boolean} [input.pressEnter]
     * @param {string|null} [input.connectionId]
     * @param {string|null} [input.host]
     * @param {number} [input.at] 事件时间（ms）
     * @param {string} [input.status]
     */
    open({ text, markLine, source = "user-editbox", pressEnter = true, connectionId: conn = connectionId, host: hostName = host, at, status } = {}) {
      const stamp = Number.isFinite(at) ? at : now();
      // 判据③：新命令发出 ⇒ 上一条以 next-command 闭口，且上一条的区间止于新命令回显之前。
      if (openId !== null) {
        const previous = get(openId);
        if (previous !== null) {
          closeRecord(previous, {
            endLine: Number.isSafeInteger(markLine) ? markLine - 1 : previous.startLine - 1,
            exitCode: null,
            closedBy: "next-command"
          });
        }
        openId = null;
      }

      seq += 1;
      const safe = redactForModel(text);
      const mark = Number.isSafeInteger(markLine) ? markLine : 0;
      const record = {
        commandId: makeCommandId(seq, idFactory),
        sessionId,
        connectionId: conn,
        host: hostName,
        seq,
        issuedAt: new Date(stamp).toISOString(),
        source: COMMAND_SOURCES.includes(source) ? source : "user-editbox",
        text: safe.text,
        // Q10：落盘脱敏，但留下痕迹，别让人以为原文就是这样。
        redacted: safe.redacted === true,
        pressEnter: pressEnter === true,
        status: status ?? (pressEnter === true ? "running" : "sent"),
        // 命令回显行自身不进结果区间（判据见文件头第 2 条）。
        startLine: mark + 1,
        endLine: null,
        exitCode: null,
        closedBy: null,
        truncated: false,
        closedAt: null
      };
      records.set(record.commandId, record);
      openId = record.commandId;
      lastOutputAt = stamp;
      interactive = false;
      emit(record, "open");
      return record;
    },

    /** 有新输出到达：推进「当前行」并重置空闲计时（判据②用）。 */
    noteOutput({ lastLine, at } = {}) {
      if (openId === null) return null;
      const record = get(openId);
      if (record === null) return null;
      lastOutputAt = Number.isFinite(at) ? at : now();
      if (Number.isSafeInteger(lastLine)) record.lastLine = lastLine;
      return record;
    },

    /** 前台是 TUI（vim/top）：不闭口，状态标 interactive（计划 5.4 特殊情况）。 */
    markInteractive(at) {
      if (openId === null) return null;
      const record = get(openId);
      if (record === null) return null;
      interactive = true;
      record.status = "interactive";
      lastOutputAt = Number.isFinite(at) ? at : now();
      emit(record, "update");
      return record;
    },

    /** 判据①：shell-integration 的 OSC 133 D —— 最可靠，带 exit code。 */
    closeFromShellIntegration({ endLine, exitCode, at } = {}) {
      if (openId === null) return null;
      return closeRecord(get(openId), { endLine, exitCode, closedBy: "shell-integration", at });
    },

    /**
     * exec 通道的确定性闭口：exec() 自带 exit code，跑完即真相大白，
     * 不需要等空闲判定（判据②）或 OSC 133（判据①）。由 runPreparedExec
     * 在输出镜像后调用。同一会话上更早的未闭口记录按 next-command 收口。
     */
    closeFromExec({ endLine, exitCode, at } = {}) {
      if (openId === null) return null;
      return closeRecord(get(openId), { endLine, exitCode, closedBy: "exec", at });
    },

    /**
     * 判据②：空闲静默闭口。由调用方按需调用（而不是模块内挂定时器），
     * 这样时间线完全可控、可测。TUI 前台时不闭口。
     */
    closeIfIdle({ lastLine, at } = {}) {
      if (openId === null || interactive || lastOutputAt === null) return null;
      const stamp = Number.isFinite(at) ? at : now();
      if (stamp - lastOutputAt < idleMs) return null;
      return closeRecord(get(openId), { endLine: lastLine, exitCode: null, closedBy: "idle-timeout", at: stamp });
    },

    /** 会话结束/断开：未闭口的全部以 session-end 收口。 */
    closeAll({ lastLine, at, closedBy = "session-end" } = {}) {
      const closed = [];
      for (const record of records.values()) {
        if (record.endLine !== null || record.closedBy !== null) continue;
        closed.push(closeRecord(record, { endLine: lastLine, exitCode: null, closedBy, at }));
      }
      openId = null;
      return closed;
    },

    /** 发送失败 / 被危险命令策略拦截：记录仍然留痕，但不占区间。 */
    markOutcome(commandId, { status, endLine, at } = {}) {
      const record = get(commandId);
      if (record === null) return null;
      if (typeof status === "string") record.status = status;
      if (Number.isSafeInteger(endLine) && record.endLine === null) record.endLine = endLine;
      if (record.closedBy === null && record.endLine !== null) {
        record.closedBy = "send-failed";
        // 与 closeRecord 同样允许注入时刻：发送失败是调用方观察到的，它知道当时几点。
        record.closedAt = new Date(Number.isFinite(at) ? at : now()).toISOString();
      }
      emit(record, "update");
      return record;
    },

    /** 标记区间是否落在行日志已淘汰区之前（智能体必须知道正文不全）。 */
    markTruncated(commandId, firstLine) {
      const record = get(commandId);
      if (record === null || !Number.isSafeInteger(firstLine)) return record;
      record.truncated = record.startLine < firstLine || record.truncated === true;
      return record;
    },

    byId(commandId) {
      return get(commandId);
    },

    /**
     * 按命令内容查。**默认精确匹配整条命令**（strip 首尾空白），返回最近一条；
     * `match: "substring"` 时返回最近 K 条候选，由调用方二次选择（计划 5.4 语义约定）。
     */
    byText(text, { match = "exact", limit = DEFAULT_SUBSTRING_LIMIT, sessionId: only = sessionId, includeHidden = false } = {}) {
      const needle = String(text ?? "").trim();
      if (needle === "") return [];
      const all = [...records.values()].filter((record) => {
        if (only !== undefined && only !== null && record.sessionId !== only) return false;
        if (!includeHidden && DEFAULT_HIDDEN_SOURCES.includes(record.source)) return false;
        if (match === "substring") return record.text.includes(needle);
        return record.text.trim() === needle;
      });
      all.reverse(); // 最近的在前
      const capped = Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_SUBSTRING_LIMIT;
      return match === "substring" ? all.slice(0, capped) : all.slice(0, 1);
    },

    /**
     * 最近的 N 条（默认过滤保活/登录脚本，免得它们污染「我发过什么命令」）。
     *
     * **显式指定 `source` 时不再过滤**：计划 Q17 要求 `source=login-script` 能查回证据，
     * 若默认隐藏规则照样生效，这个显式查询就永远是空结果。
     */
    recent({ limit = 50, includeHidden = false, source = undefined } = {}) {
      const askedSource = source !== undefined;
      const list = [...records.values()].filter((record) => {
        if (askedSource && record.source !== source) return false;
        if (!askedSource && !includeHidden && DEFAULT_HIDDEN_SOURCES.includes(record.source)) return false;
        return true;
      });
      list.reverse();
      const capped = Number.isSafeInteger(limit) && limit > 0 ? limit : 50;
      return list.slice(0, capped);
    },

    /**
     * 一条命令的输出区间。正文由行日志按区间取（计划 R5：结果压缩为行号）。
     * `endLine < startLine` 表示这条命令没有产生输出行。
     */
    outputOf(commandId) {
      const record = get(commandId);
      if (record === null) return null;
      return {
        commandId: record.commandId,
        sessionId: record.sessionId,
        text: record.text,
        source: record.source,
        status: record.status,
        startLine: record.startLine,
        endLine: record.endLine,
        exitCode: record.exitCode,
        closedBy: record.closedBy,
        truncated: record.truncated,
        empty: record.endLine !== null && record.endLine < record.startLine
      };
    },

    /** 未闭口的记录（「这条命令跑完了吗」的判据之一）。 */
    openRecords() {
      return [...records.values()].filter((record) => record.endLine === null || record.closedBy === null);
    },

    size() {
      return records.size;
    },

    /** 全量快照（落盘/prune 用），按命令序。 */
    all() {
      return [...records.values()];
    },

    /** 从已落盘的记录恢复（JSONL 重载；同 ID 取后者，与 append 语义一致）。 */
    restore(list) {
      let maxSeq = seq;
      for (const item of list) {
        if (item === null || typeof item !== "object" || typeof item.commandId !== "string") continue;
        records.set(item.commandId, { ...item });
        if (Number.isSafeInteger(item.seq) && item.seq > maxSeq) maxSeq = item.seq;
      }
      seq = maxSeq;
      // 恢复后若最后一条仍未闭口，继续认它（比如进程重启前的最后一条命令）。
      for (const record of [...records.values()].reverse()) {
        if (record.endLine === null && record.closedBy === null) {
          // 重启后失去 shell 集成与时钟上下文，标 unknown 而不是假装还 running。
          if (record.status === "running") record.status = "unknown";
          openId = null;
          break;
        }
      }
      return records.size;
    }
  };
}

/**
 * JSONL 落盘：`<dir>/<sessionId>.jsonl`，一行一条完整记录（追加写）。
 *
 * 同一条命令会写多行：open 一行、闭口一行 —— 重载时**后写覆盖先写**（按 commandId），
 * 所以进程在命令执行中途崩掉也不会丢记录，且不需要就地改写文件。
 */
export function createCommandLedgerStore({ dir } = {}) {
  if (typeof dir !== "string" || dir === "") throw new Error("command ledger store needs a dir");
  const fileOf = (sessionId) => joinPath(dir, `${String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, "_")}.jsonl`);
  /**
   * 每个会话一条写入链。**必须顺序化**：`append` 是异步的，而调用方（会话热路径）
   * 不会 await 它 —— 一条「打开即闭口」的短命令，close 那次 append 完全可能先落盘，
   * 重载时就会把已经闭口的记录覆盖回未闭口（实测踩到过）。
   * 按会话分链而不是全局一条，避免慢会话拖住别的会话。
   */
  const chains = new Map();
  const enqueue = (sessionId, task) => {
    const previous = chains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(task, task);
    // 失败不能卡住后续写入，但要把错误交给调用方。
    chains.set(sessionId, next.catch(() => {}));
    return next;
  };

  return {
    dir,
    fileOf,

    append(sessionId, record) {
      return enqueue(sessionId, async () => {
        await mkdir(dir, { recursive: true });
        await appendFile(fileOf(sessionId), `${JSON.stringify(record)}\n`, "utf8");
      });
    },

    /** 读回一条会话的记录（同 ID 后写覆盖先写）。`tail` 限制读取条数。 */
    async load(sessionId, { tail = DEFAULT_LOAD_TAIL } = {}) {
      let raw;
      try {
        raw = await readFile(fileOf(sessionId), "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
      const lines = raw.split("\n").filter((line) => line.trim() !== "");
      const slice = Number.isSafeInteger(tail) && tail > 0 ? lines.slice(-tail) : lines;
      const merged = new Map();
      for (const line of slice) {
        let item;
        try { item = JSON.parse(line); } catch { continue; } // 半行/坏行跳过，不让一行毁掉整份台账
        if (item !== null && typeof item === "object" && typeof item.commandId === "string") merged.set(item.commandId, item);
      }
      return [...merged.values()];
    },

    /** 按天数/条数清理（Q5 建议值 7 天 / 5000 条）。返回保留条数。 */
    async prune(sessionId, { days = DEFAULT_RETENTION_DAYS, count = DEFAULT_RETENTION_COUNT, at = Date.now() } = {}) {
      const records = await this.load(sessionId, { tail: 0 });
      let kept = records;
      if (Number.isFinite(days) && days > 0) {
        const floor = at - days * 24 * 60 * 60 * 1000;
        kept = kept.filter((record) => {
          const stamp = Date.parse(record.issuedAt ?? "");
          return !Number.isFinite(stamp) || stamp >= floor;
        });
      }
      if (Number.isSafeInteger(count) && count > 0 && kept.length > count) kept = kept.slice(-count);
      if (kept.length === records.length) return kept.length;
      await mkdir(dir, { recursive: true });
      const target = fileOf(sessionId);
      const tmp = `${target}.tmp`;
      await writeFile(tmp, kept.map((record) => JSON.stringify(record)).join("\n") + (kept.length > 0 ? "\n" : ""), "utf8");
      await rename(tmp, target);
      return kept.length;
    }
  };
}
