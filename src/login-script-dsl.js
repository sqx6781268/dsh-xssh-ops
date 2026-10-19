/**
 * R9② 连接会话时运行脚本 —— **方案 A：受限 DSL，只暴露会话 API**
 *
 * 用户 2026-10-17 拍板选 A（计划 Q15）。安全面是这一项的全部意义所在，所以先把
 * 边界写清楚：
 *
 *   **给谁用**：脚本只做「连上之后自动跑一段会话动作」——等提示、送口令、读输出、
 *   记日志、收尾。它替代的是人盯着屏幕敲键盘，**不是**通用自动化平台。
 *
 *   **暴露什么**（全部注入，别的一律拿不到）：
 *     - `expect(pattern, timeoutMs?)`：等待匹配（子串），返回是否等到；
 *     - `send(text, pressEnter?)`：发送（经既有写入路径，所以行日志/台账照常可用）；
 *     - `readLines(from, to)`：读行号区间；
 *     - `log(message)`：写进会话日志（不发送任何东西到远端）；
 *     - `sleep(ms)`：等待（受总预算约束）；
 *     - `close()`：结束脚本（正常收尾）。
 *
 *   **拿不到什么**：`require` / `process` / `fs` / `net` / `child_process` /
 *   `globalThis` 逃逸 / 宿主对象引用。用 `node:vm` 建一个**没有宿主原型链**的
 *   context（`Object.create(null)` 风格），并冻结注入的 API 对象。
 *
 *   **预算**（防跑飞）：总时长上限（默认 30 s）、步数上限（默认 200 次 API 调用）、
 *   脚本同步执行超时（vm 的 `timeout`）。超限 ⇒ 脚本被中止，**会话保持可用**。
 *
 *   **可见性**：脚本发出的内容记入命令台账并标 `source: login-script`（与会话日志
 *   一并保留证据），命令列表默认过滤但可显式查回（计划 Q17）。
 *
 * 本模块不碰 IO：所有会话能力由调用方以「能力对象」注入，所以可以完全确定性地测。
 * 脚本文件读取在调用方（插件自己读文件），模块只接收**脚本源码文本**。
 */
import { createContext, Script } from "node:vm";
import { readFile } from "node:fs/promises";

/** 默认预算（计划 5.8 的「有超时与步数上限」）。 */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 30000;
export const DEFAULT_SCRIPT_MAX_STEPS = 200;
export const DEFAULT_EXPECT_TIMEOUT_MS = 15000;
/** 脚本源码上限（防超大文件把内存吃满）。 */
export const MAX_SCRIPT_BYTES = 256 * 1024;

/** 脚本允许的 API 名单。**只有这些**会被注入，别的一律不存在。 */
export const SCRIPT_API_NAMES = ["expect", "send", "readLines", "log", "sleep", "close"];

/**
 * 读脚本文件（调用方应该先做路径校验；这里只做大小与编码检查）。
 * @param {string} path
 */
export async function loadScriptSource(path) {
  const raw = await readFile(path);
  if (raw.length > MAX_SCRIPT_BYTES) {
    throw new Error(`script is ${raw.length} bytes, over the ${MAX_SCRIPT_BYTES}-byte limit`);
  }
  return raw.toString("utf8");
}

/**
 * 建一个受限的脚本运行器。
 *
 * @param {object} capabilities 会话能力（由 host 注入；本模块只调用它们）
 * @param {(pattern: string, timeoutMs?: number) => Promise<boolean>} capabilities.expect
 * @param {(text: string, pressEnter?: boolean) => Promise<void>} capabilities.send
 * @param {(fromLine: number, toLine: number) => Promise<Array<{line: number, text: string}>>} capabilities.readLines
 * @param {(message: string) => void} capabilities.log
 * @param {object} [options]
 * @param {number} [options.timeoutMs] 总时长上限
 * @param {number} [options.maxSteps] API 步数上限
 * @param {() => number} [options.now] 注入时钟（测试用；sleep 也走它）
 * @param {(ms: number) => Promise<void>} [options.wait] 注入等待（测试用）
 */
export function createScriptRunner(
  { expect, send, readLines, log } = {},
  {
    timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS,
    maxSteps = DEFAULT_SCRIPT_MAX_STEPS,
    now = () => Date.now(),
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  } = {}
) {
  for (const [name, value] of Object.entries({ expect, send, readLines, log })) {
    if (typeof value !== "function") throw new Error(`script runner needs a ${name}() capability`);
  }

  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let steps = 0;
  let closed = false;
  let hasRun = false;
  const messages = [];
  const sent = [];

  function budget(label) {
    if (closed) throw new Error("script already closed");
    if (now() > deadline) throw new Error(`script exceeded its ${timeoutMs} ms budget (at ${label})`);
    steps += 1;
    if (steps > maxSteps) throw new Error(`script exceeded its ${maxSteps}-step budget (at ${label})`);
  }

  /** 注入的 API —— 全部冻结，脚本无法替换它们去影响后续调用。 */
  const api = Object.freeze({
    /** 等待匹配（子串）。返回是否在超时内等到；等不到返回 false 而不是抛错。 */
    async expect(pattern, stepTimeoutMs = DEFAULT_EXPECT_TIMEOUT_MS) {
      budget("expect");
      const text = String(pattern ?? "");
      if (text === "") throw new Error("expect() needs a non-empty pattern");
      const value = Number(stepTimeoutMs);
      const remaining = Math.max(0, deadline - now());
      // `expect` 的等待时长**夹到剩余预算**是有意为之（它的语义就是「最多等这么久」，
      // 等不到返回 false）；这与 `sleep` 不同 —— sleep 超预算必须报错，因为脚本
      // 期望的是真的睡够那么久。
      const limit = Number.isFinite(value) && value > 0 ? Math.min(value, remaining) : Math.min(DEFAULT_EXPECT_TIMEOUT_MS, remaining);
      if (limit <= 0) throw new Error("expect() has no remaining script budget to wait for");
      return await expect(text, limit);
    },

    /** 发送内容（经既有写入路径 ⇒ 行日志/行号/台账照常可用）。 */
    async send(text, pressEnter = true) {
      budget("send");
      const body = String(text ?? "");
      if (body === "") return;
      await send(body, pressEnter !== false);
      sent.push(body);
    },

    /** 读行号区间（与 xssh_terminal_read 同源）。 */
    async readLines(fromLine, toLine) {
      budget("readLines");
      const from = Number(fromLine);
      const to = Number(toLine);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
        throw new Error("readLines(from, to) needs 1 <= from <= to");
      }
      return await readLines(from, to);
    },

    /** 写日志（只进会话日志，不发送到远端）。 */
    log(message) {
      budget("log");
      const text = String(message ?? "");
      messages.push(text);
      log(text);
    },

    /** 等待（也吃预算时间）。 */
    async sleep(ms) {
      budget("sleep");
      const value = Number(ms);
      if (!Number.isFinite(value) || value < 0) throw new Error("sleep(ms) needs a non-negative number");
      const remaining = Math.max(0, deadline - now());
      // 请求的等待**超过剩余预算**要直接报错，而不是悄悄夹到预算上限：
      // 夹了之后脚本会「正常结束」，让人以为等待成功了（实测踩到）。脚本应当
      // 明确知道它想睡的这段时间已经不够了。
      if (value > remaining) {
        throw new Error(`sleep(${value} ms) exceeds the remaining ${remaining} ms of the script budget`);
      }
      await wait(value);
    },

    /** 正常收尾。调用后任何 API 都会抛错（脚本不该继续动作）。 */
    close() {
      closed = true;
    }
  });

  return {
    /** 注入给脚本的 API 名（供「脚本用了什么」的审计与文档）。 */
    apiNames: SCRIPT_API_NAMES,

    /**
     * 执行脚本源码。
     *
     * @param {string} source
     * @returns {Promise<{ok: boolean, closed: boolean, steps: number, elapsedMs: number, sent: string[], messages: string[], error: {message: string}|null}>}
     */
    async run(source) {
      const text = String(source ?? "");
      if (text.trim() === "") throw new Error("script source is empty");
      // **一次性实例**：一次 run 之后不再接受第二次。
      // 理由：预算（deadline/steps）与 closed 是实例级状态，复跑会让「预算」被绕过
      // （第一次慢跑完，第二次白拿一份新预算），而且失败后状态语义含糊。
      // 调用方要为每次执行建一个新 runner —— 这比隐式重置更容易审计。
      if (hasRun) throw new Error("this script runner has already run; create a new one for a new execution");
      hasRun = true;
      // context 里**不放**宿主对象：只放我们注入的 API 与几个无害的内建函数。
      const sandbox = createContext(Object.create(null));

      const result = { ok: false, closed: false, steps: 0, elapsedMs: 0, sent, messages, error: null };
      // context 里的 API 必须是**不可写属性**，而不只是「对象被冻结」：
      // `Object.freeze(api)` 只冻结属性值指向的对象，脚本仍可 `send = null` 把绑定
      // 换掉（实测：之后调用抛 `TypeError: send is not a function`）。defineProperty
      // 的 writable:false 才是真的改不动 —— 脚本篡改 API 会抛 TypeError 而不是自伤。
      for (const [name, value] of Object.entries(api)) {
        Object.defineProperty(sandbox, name, { value, writable: false, configurable: false, enumerable: true });
      }
      Object.defineProperty(sandbox, "console", {
        value: Object.freeze({ log: (value) => api.log(value) }),
        writable: false, configurable: false, enumerable: true
      });
      Object.defineProperty(sandbox, "TextDecoder", { value: TextDecoder, writable: false, configurable: false });
      Object.defineProperty(sandbox, "URL", { value: URL, writable: false, configurable: false });

      try {
        const script = new Script(`(async () => {\n${text}\n})()`, { filename: "xssh-login-script.js" });
        // vm 的 timeout 只约束同步部分；异步链由预算（deadline/steps）约束，
        // 两者结合才能既挡住死循环又挡住「无限 await」。
        const value = script.runInContext(sandbox, { timeout: Math.max(1, deadline - now()) });
        await value;
        result.ok = true;
      } catch (error) {
        result.error = { message: error?.message ?? String(error) };
      } finally {
        // 顺序要紧：**先收尾再记录**。反过来的话 `result.closed` 会在 `closed = true`
        // 之前读到旧值 false（实测踩到：脚本没显式 close() 时报告成未收尾）。
        // 不及时 close() 的脚本也要被收尾（否则它可能继续持有 expect 等待）。
        if (!closed) closed = true;
        result.closed = closed;
        result.steps = steps;
        result.elapsedMs = Math.max(0, now() - startedAt);
      }
      return result;
    }
  };
}

/**
 * 校验脚本路径与沙箱级别（**保存时**校验，与登录脚本规则同一条安全思路）。
 * 方案 A 只允许 `restricted`：`trusted`（完整宿主能力）在方案 A 下不存在，
 * 显式传 trusted 会被拒 —— 免得配置里留下一个「以为能提权」的假开关。
 */
export function validateScriptSettings({ runEnabled, path, sandbox } = {}) {
  const problems = [];
  if (runEnabled === true) {
    if (typeof path !== "string" || path.trim() === "") {
      problems.push({ code: "empty-path", message: "enabling the script requires a path" });
    } else {
      if (path.length > 1024) problems.push({ code: "path-too-long", message: "script path is limited to 1024 characters" });
      // 控制字符会破坏 shell 包装与日志，一律拒绝
      if (/[\u0000-\u001f\u007f]/.test(path)) problems.push({ code: "path-control-chars", message: "script path contains control characters" });
    }
  }
  if (sandbox !== undefined && sandbox !== "restricted") {
    problems.push({
      code: "sandbox-unsupported",
      message: `sandbox "${sandbox}" is not available: R9② is restricted-DSL only (session APIs, no fs/net/process)`
    });
  }
  return problems.length === 0 ? { ok: true, problems: [] } : { ok: false, problems };
}
