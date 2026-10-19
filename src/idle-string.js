/**
 * R8② 空闲字符串发送器（计划 5.8）
 *
 * 干什么：连接长时间没有任何收发时，按配置的间隔往会话里送一小段字符串
 * （某些设备/中间设备需要流量才不会掐连接）。
 *
 * **四条前提，全部满足才发**（缺一发就是事故，不是小毛病）：
 *   1. 该连接存在**活的终端会话**（否则没有通道可写）；
 *   2. 该会话**没有未闭口的命令**（否则字符串会被插进正在运行的命令输出里）；
 *   3. 前台**不是 TUI / 交互程序**（否则字符串会变成它的按键输入）；
 *   4. 距上次**任一方向**的字节活动 ≥ 配置间隔（否则本来就有流量，不需要补）。
 *
 * 加上两条与设置有关的：开关打开、间隔 > 0、字符串非空。
 *
 * 隔离要求（计划 5.8 / 风险 #13）：发出的字符串会在终端画面上出现，所以
 * **行日志照实记录但打 `keepalive: true`**，且**不产生命令台账记录** —— 它绝不能被
 * 当成「用户执行过的命令」。
 *
 * 本模块不挂全局定时器：`tick(at)` 由调用方驱动（便于测试与统一生命周期）。
 */

/** 四条前提 + 开关检查的结果（供「测试保活」与发送器共用同一套判据）。 */
export function evaluatePreconditions({
  settings = {},
  hasLiveSession = false,
  openCommandCount = 0,
  interactive = false,
  idleSinceMs = null,
  now = Date.now()
} = {}) {
  const intervalSec = Number.isFinite(settings.idleStringIntervalSec) ? settings.idleStringIntervalSec : 0;
  const text = String(settings.idleStringText ?? "");
  const enabled = settings.idleStringEnabled === true && intervalSec > 0 && text !== "";
  const checks = [
    {
      name: "live-session",
      ok: hasLiveSession === true,
      // detail 是**技术描述**（英文）：本地化成用户可见文案由调用方做
      // （host 的 localizePreconditionDetail）—— 模块里不引 i18n t()，
      // 这样它能被 host 与测试共用而不依赖语言状态。
      detail: hasLiveSession ? "live terminal session" : "no open terminal"
    },
    {
      name: "no-open-command",
      ok: openCommandCount === 0,
      detail: openCommandCount === 0 ? "no unfinished command" : `${openCommandCount} command(s) still running`
    },
    {
      name: "not-interactive",
      ok: interactive !== true,
      detail: interactive ? "a TUI or interactive program seems to be in the foreground" : "no TUI in the foreground"
    },
    {
      name: "idle-enough",
      ok: idleSinceMs !== null && intervalSec > 0 && idleSinceMs >= intervalSec * 1000,
      detail: idleSinceMs === null
        ? "idle time unknown (the session records no activity timestamp)"
        : `idle ${Math.round(idleSinceMs / 1000)}s / threshold ${intervalSec}s`
    }
  ];
  return {
    enabled,
    wouldSend: enabled && checks.every((check) => check.ok),
    checks,
    intervalSec,
    text,
    // 下一次发送时间：
    //   - 已够条件（会发）⇒ 就是「现在」（此刻的 ISO 时间，语义是「马上」）；
    //   - 还没够条件 ⇒ 按剩余时间给出未来时刻；
    //   - 根本不满足发送前提（如没有会话 / TUI / 有未闭口命令）⇒ null。
    // 不编假时间：UI 与「测试保活」都靠这个字段说清「现在会不会发」。
    nextSendAt: enabled && idleSinceMs !== null && checks.slice(0, 3).every((check) => check.ok)
      ? new Date(Math.max(now, now + intervalSec * 1000 - idleSinceMs)).toISOString()
      : null
  };
}

/**
 * 建一个空闲字符串发送器。
 *
 * @param {object} options
 * @param {() => object} options.readSettings 取当前设置（每次 tick 现读，改设置即时生效）
 * @param {() => Array<{sessionId: string, hasLiveSession: boolean, openCommandCount: number, interactive: boolean, idleSinceMs: number|null}>} options.listSessions
 * @param {(sessionId: string, text: string) => Promise<void>} options.send 发送（走既有写入路径）
 * @param {(sessionId: string, text: string) => void} [options.markKeepalive] 给行日志打标记
 * @param {(event: object) => void} [options.onEvent] 审计（发出的内容与原因）
 * @param {() => number} [options.now]
 */
export function createIdleStringSender({
  readSettings,
  listSessions,
  send,
  markKeepalive = null,
  onEvent = null,
  now = () => Date.now()
} = {}) {
  for (const [name, value] of Object.entries({ readSettings, listSessions, send })) {
    if (typeof value !== "function") throw new Error(`idle string sender needs a ${name}() function`);
  }
  /** 上一次发送时间（按会话）：避免间隔未到就重复发（自己也产生流量）。 */
  const lastSentAt = new Map();

  return {
    /** 「测试保活」与发送共用同一套判定（单一来源，避免两处判据漂移）。 */
    evaluate(session) {
      const settings = readSettings() ?? {};
      return evaluatePreconditions({
        settings,
        hasLiveSession: session?.hasLiveSession === true,
        openCommandCount: session?.openCommandCount ?? 0,
        interactive: session?.interactive === true,
        idleSinceMs: session?.idleSinceMs ?? null,
        now: now()
      });
    },

    /**
     * 推进一次：对每个会话判定，够条件就发。返回本次实际发出的记录。
     * 由调用方按固定节拍驱动（模块内不挂定时器）。
     */
    async tick() {
      const settings = readSettings() ?? {};
      const stamp = now();
      const sent = [];
      for (const session of listSessions() ?? []) {
        const verdict = this.evaluate(session);
        if (!verdict.wouldSend) continue;
        // 「自己的发送也算活动」：距上次保活发送不足间隔就不再发（否则会变成刷屏）。
        const previous = lastSentAt.get(session.sessionId) ?? 0;
        if (stamp - previous < verdict.intervalSec * 1000) continue;
        // 先给行日志打标记：这样该字符串被回显时会带上 keepalive（计划 5.8）。
        // 标记必须在写入**之前**设置，否则回显可能先到、行就错过了标记。
        try { markKeepalive?.(session.sessionId, verdict.text); } catch { /* 标记失败不阻断发送 */ }
        const payload = String(settings.idleStringText ?? "");
        // 默认**不自动附加回车**（Q14 未定，先按此）：它会出现在画面上，但不提交命令行。
        try {
          await send(session.sessionId, payload);
          lastSentAt.set(session.sessionId, stamp);
          sent.push({ sessionId: session.sessionId, text: payload, at: new Date(stamp).toISOString() });
          try { onEvent?.({ kind: "keepalive-sent", sessionId: session.sessionId, text: payload, at: new Date(stamp).toISOString() }); } catch { /* 审计失败不阻断 */ }
        } catch (error) {
          try { onEvent?.({ kind: "keepalive-failed", sessionId: session.sessionId, message: error?.message ?? String(error) }); } catch { /* 同上 */ }
        }
      }
      return sent;
    },

    /** 会话关闭时清掉它的发送时间记录（避免长跑进程里 Map 无界增长）。 */
    forget(sessionId) {
      lastSentAt.delete(sessionId);
    },

    /** 最后一次发送时间（排障用）。 */
    lastSentAt(sessionId) {
      return lastSentAt.get(sessionId) ?? null;
    }
  };
}
