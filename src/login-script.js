/**
 * 登录脚本规则引擎（R9①，计划 5.8 / M3.6）
 *
 * 解决的问题：连上服务器后常常要先「等某个提示出现 → 回一段字」（`sudo` 口令、
 * 跳板二次确认、`tmux attach`、进目录再起 shell）。手工做要人盯着屏幕，这里把它
 * 变成有序规则表：**数组顺序即执行顺序**（上移/下移直接改下标，不引入第二套优先级
 * 字段，避免两处状态）。
 *
 * 状态机：`idle → waiting(i) → sending → waiting(i+1) → … → done | aborted`
 *
 * 五条必须守住的语义：
 *
 * 1. **匹配用净化文本**，不是原始字节流：提示符里常夹 ANSI 颜色序列，拿原始流匹配
 *    会被 `\x1b[32m` 之类挡住。净化层复用 `toReadableText`（与行日志同一套解析）。
 * 2. **匹配用净化文本**（`toReadableText`），所以两个副作用必须知道：
 *    - 提示符里的 ANSI 颜色序列被剥掉（这正是用净化的原因）；
 *    - **行尾空白被裁掉** —— `"Password: "` 会变成 `"Password:"`。所以 expect 写成
 *      `"Password"` 更稳（子串匹配本就不要求整行相等）；带尾随空格的写法也不算错，
 *      只是对不上净化后的文本（引擎会如实不命中，不静默放宽）。
 * 3. **保留拼接窗口**：多行提示符可能跨 chunk 到达，所以匹配在一个**带上限的累积
 *    缓冲**上做（默认 4 KiB），而不是只看当前 chunk。
 * 3. **单条超时默认「告警并跳过」**，不中止整条规则链 —— 一条规则等不到不该让后续
 *    规则全废。严格模式（`strict`）才中止。
 * 4. **发送必须复用既有写入路径**：引擎只产出「要发的字」，真正写终端由调用方用
 *    与用户命令同一条路径完成 —— 这样行日志、行号、命令区间照常可用（计划 5.8）。
 * 5. **没有人工确认卡片可弹**（连接阶段），所以危险命令的拦截在**保存时**就做
 *    （见 `validateRules`），这里再兜一层：命中危险命令的规则**直接拒绝执行**。
 *
 * 本模块不碰 IO、不碰 React、不挂全局定时器：时间与写入都由调用方注入，所以可以
 * 完全确定性地测试。
 */
import { toReadableText } from "./terminal-text.js";
import { assessShellCommand } from "./safety.js";

/** 累积匹配缓冲的上限（计划 5.8：默认窗口 4 KiB）。 */
export const DEFAULT_MATCH_WINDOW_BYTES = 4096;
/** 单条规则的默认等待超时（计划 5.7：`expectStepTimeoutMs` = 15000）。 */
export const DEFAULT_STEP_TIMEOUT_MS = 15000;
/** 默认匹配方式（计划 5.7：`expectMatchMode` = substring）。 */
export const DEFAULT_MATCH_MODE = "substring";
/** 支持的匹配方式。 */
export const MATCH_MODES = ["substring", "glob", "regex"];

/** 把 glob 转成正则（`*` → `.*`，`?` → `.`，其余字符转义）。 */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(body);
}

/**
 * 编译一条匹配器。非法正则**在编译期**就抛错（保存时校验用同一函数，所以不可能
 * 存进一条运行时才炸的规则）。
 * @param {string} pattern
 * @param {"substring"|"glob"|"regex"} mode
 */
export function compileMatcher(pattern, mode = DEFAULT_MATCH_MODE) {
  const text = String(pattern ?? "");
  if (text === "") throw new Error("expect pattern is empty");
  if (mode === "regex") {
    // **必须在编译期就 new RegExp**：如果这里只返回一个「调用时才 new」的闭包，
    // 坏正则要到运行期才炸 —— 而保存时校验正是靠这个函数报错的。
    const re = new RegExp(text);
    return (haystack) => {
      re.lastIndex = 0; // 复用带 g/y 标志的正则时要复位，否则相邻匹配会漂移
      return re.test(haystack);
    };
  }
  if (mode === "glob") {
    const re = globToRegExp(text);
    return (haystack) => re.test(haystack);
  }
  if (mode !== "substring") throw new Error(`unsupported match mode "${mode}"`);
  return (haystack) => haystack.includes(text);
}

/**
 * 校验一份规则表（**保存时**调用）。
 *
 * 这是 R9 的安全前移点：规则在连接建立阶段自动执行，没有确认卡片可弹，所以
 * `assessShellCommand` 的判定必须发生在保存时，而**不允许悄悄存下 `rm -rf /`**。
 * 返回逐条的问题清单；没有问题时 `ok: true`。
 */
export function validateRules(rules, { matchMode = DEFAULT_MATCH_MODE, stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS } = {}) {
  const problems = [];
  if (!Array.isArray(rules)) return { ok: false, problems: [{ index: -1, code: "not-an-array", message: "rules must be an array" }] };
  if (rules.length > 50) problems.push({ index: -1, code: "too-many", message: "at most 50 rules" });
  if (!MATCH_MODES.includes(matchMode)) problems.push({ index: -1, code: "bad-mode", message: `unsupported match mode "${matchMode}"` });
  if (!Number.isSafeInteger(stepTimeoutMs) || stepTimeoutMs < 1000 || stepTimeoutMs > 600000) {
    problems.push({ index: -1, code: "bad-timeout", message: "step timeout must be 1000..600000 ms" });
  }

  rules.forEach((rule, index) => {
    if (rule === null || typeof rule !== "object") {
      problems.push({ index, code: "not-an-object", message: "rule must be an object" });
      return;
    }
    const expect = String(rule.expect ?? "");
    const send = String(rule.send ?? "");
    if (expect === "") problems.push({ index, code: "empty-expect", message: "expect pattern is required" });
    else {
      try {
        compileMatcher(expect, matchMode);
      } catch (error) {
        problems.push({ index, code: "bad-pattern", message: `expect pattern cannot compile: ${error.message}` });
      }
    }
    if (send === "" && rule.send !== "") {
      // send 是空串本身没关系（有些规则只是等待），但非字符串要报。
      problems.push({ index, code: "bad-send", message: "send must be a string" });
    }
    // 危险命令：连接阶段无人工确认，直接拒绝保存。
    if (send !== "") {
      const decision = assessShellCommand(send);
      if (!decision.ok) {
        problems.push({
          index,
          code: "dangerous-send",
          message: `send looks destructive (${decision.reason}); login-script rules run without a confirmation card`,
          reason: decision.reason
        });
      }
    }
    if (rule.timeoutMs !== undefined) {
      const value = Number(rule.timeoutMs);
      if (!Number.isSafeInteger(value) || value < 1000 || value > 600000) {
        problems.push({ index, code: "bad-rule-timeout", message: "timeoutMs must be 1000..600000" });
      }
    }
  });

  return problems.length === 0 ? { ok: true, problems: [] } : { ok: false, problems };
}

/**
 * 建一个规则引擎实例（每个终端会话一个）。
 *
 * 调用方负责：
 *   - `feed(chunk)`：把会话输出的原始 chunk 喂进来（内部做净化与窗口裁剪）；
 *   - `tick(now)`：按需推进（评估超时）—— 模块内不挂定时器，保证可测、可控；
 *   - 处理 `onSend(text)`：把要发的字**经既有写入路径**写进终端；
 *   - 处理 `onEvent(event)`：记录告警/审计（跳过、超时、危险拒绝等）。
 *
 * @param {object} options
 * @param {Array<{expect: string, send: string, timeoutMs?: number}>} options.rules
 * @param {"substring"|"glob"|"regex"} [options.matchMode]
 * @param {number} [options.stepTimeoutMs]
 * @param {"skip"|"strict"} [options.onTimeout] 超时行为：跳过（默认）/ 中止
 * @param {number} [options.windowBytes]
 * @param {() => number} [options.now]
 */
export function createLoginScriptRunner({
  rules = [],
  matchMode = DEFAULT_MATCH_MODE,
  stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS,
  onTimeout = "skip",
  windowBytes = DEFAULT_MATCH_WINDOW_BYTES,
  now = () => Date.now()
} = {}) {
  const validation = validateRules(rules, { matchMode, stepTimeoutMs });
  if (!validation.ok) {
    const first = validation.problems[0];
    throw new Error(`invalid login-script rules: ${first.message} (rule ${first.index})`);
  }

  const matchers = rules.map((rule) => compileMatcher(String(rule.expect ?? ""), matchMode));
  const window = Number.isSafeInteger(windowBytes) && windowBytes > 0 ? windowBytes : DEFAULT_MATCH_WINDOW_BYTES;

  /** 状态：idle / waiting / sending / done / aborted */
  let state = rules.length === 0 ? "done" : "idle";
  let index = 0;
  let deadlineAt = null;
  /** 累积的净化文本（只在尾部保留窗口大小）。 */
  let buffer = "";

  const events = [];

  function record(kind, detail = {}) {
    const event = { kind, at: new Date(now()).toISOString(), ruleIndex: index, ...detail };
    events.push(event);
    return event;
  }

  /** 裁剪窗口：按字符数近似（净化文本已无 ANSI，1 字符≈1 字节的 ASCII 情形占多数）。 */
  function trimBuffer() {
    if (buffer.length <= window) return;
    buffer = buffer.slice(buffer.length - window);
  }

  return {
    get state() { return state; },
    /** 当前正在等待的规则下标（done/aborted 时为 -1）。 */
    get ruleIndex() { return state === "waiting" || state === "sending" ? index : -1; },
    totalRules: rules.length,
    events,

    /** 快照，用于汇报与测试。 */
    snapshot() {
      return {
        state,
        ruleIndex: state === "waiting" || state === "sending" ? index : -1,
        totalRules: rules.length,
        matchedCount: rules.length - (state === "done" ? 0 : Math.max(0, rules.length - index)),
        bufferChars: buffer.length,
        events: events.length
      };
    },

    /** 开始（连接就绪后调用一次）。 */
    start() {
      if (state !== "idle") return this.snapshot();
      if (rules.length === 0) { state = "done"; return this.snapshot(); }
      state = "waiting";
      index = 0;
      deadlineAt = now() + (rules[0].timeoutMs ?? stepTimeoutMs);
      record("start");
      this.evaluate();
      return this.snapshot();
    },

    /**
     * 喂入一段原始终端输出。返回本段触发的结果（已完成的发送）。
     *
     * @param {string} chunk
     * @returns {Array<{ruleIndex: number, send: string}>}
     */
    feed(chunk) {
      if (state === "done" || state === "aborted") return [];
      buffer += toReadableText(String(chunk ?? ""));
      trimBuffer();
      return this.evaluate();
    },

    /**
     * 评估当前状态：命中就发送、跳步/推进/收尾。
     * 单独暴露是为了「先喂数据、再驱动」的解耦测试，以及超时后重试。
     *
     * @returns {Array<{ruleIndex: number, send: string}>}
     */
    evaluate() {
      const sent = [];
      // 一次 feed 可能连过几条规则（例如一次性收到多段提示符）。
      let guard = 0;
      while (state === "waiting" && guard < rules.length + 1) {
        guard += 1;
        const matcher = matchers[index];
        if (!matcher(buffer)) break;
        const rule = rules[index];
        state = "sending";
        record("expect-matched", { expect: rule.expect });
        const text = String(rule.send ?? "");
        if (text !== "") {
          // 兜底拦截：即便有人绕过保存时校验（例如手工改了设置文件），
          // 破坏性命令也绝不在无人确认的连接阶段发出去。
          const decision = assessShellCommand(text);
          if (!decision.ok) {
            state = "aborted";
            record("send-refused", { reason: decision.reason, text });
            return sent;
          }
          sent.push({ ruleIndex: index, send: text });
          record("sent", { text });
        }
        index += 1;
        if (index >= rules.length) {
          state = "done";
          deadlineAt = null;
          record("done");
          break;
        }
        state = "waiting";
        deadlineAt = now() + (rules[index].timeoutMs ?? stepTimeoutMs);
      }
      return sent;
    },

    /**
     * 推进时间：处理「单条规则等待超时」。默认跳过该条并继续（计划 5.8），
     * 严格模式则中止后续规则。
     */
    tick(at) {
      if (state !== "waiting" || deadlineAt === null) return null;
      const stamp = Number.isFinite(at) ? at : now();
      if (stamp < deadlineAt) return null;
      const timedOut = index;
      if (onTimeout === "strict") {
        state = "aborted";
        record("timeout-abort", { timedOut });
        return { kind: "abort", ruleIndex: timedOut };
      }
      index += 1;
      if (index >= rules.length) {
        state = "done";
        deadlineAt = null;
        record("timeout-skip", { timedOut });
        record("done");
        return { kind: "skip", ruleIndex: timedOut, done: true };
      }
      state = "waiting";
      deadlineAt = stamp + (rules[index].timeoutMs ?? stepTimeoutMs);
      record("timeout-skip", { timedOut });
      return { kind: "skip", ruleIndex: timedOut, done: false };
    },

    /** 会话结束/出错时强制收尾。 */
    abort(reason = "aborted") {
      if (state === "done" || state === "aborted") return this.snapshot();
      state = "aborted";
      deadlineAt = null;
      record("abort", { reason });
      return this.snapshot();
    }
  };
}
