/**
 * 测试辅助：等离线 sshd **真正可连**（而不是等一行日志 + 固定睡眠）。
 *
 * 为什么需要：脚本早期用「等 stdout 里出现 listening，再 setTimeout 2 秒」——
 * 在机器忙（全量跑 119 个测试）时，服务器进程可能还没开始 accept 就被连，
 * 于是偶发 `connect ECONNREFUSED`（实测抓到过）。**固定睡眠是 flaky 的根源**。
 *
 * 这里改成：**反复尝试真连**，直到成功或超时。TCP 层能连上才算真的就绪。
 */
import { Client } from "ssh2";

export const DEFAULT_CONNECT_TIMEOUT_MS = 20000;

/**
 * 轮询直到 `connect` 成功。
 * @param {object} options
 * @param {number} options.port
 * @param {string} [options.username]
 * @param {string} [options.password]
 * @param {number} [options.timeoutMs]
 * @param {() => boolean} [options.abort] 返回 true 时提前放弃（例如子进程已退出）
 */
export async function connectWithRetry({
  port,
  username = "tester",
  password = "test123",
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  abort = null
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    if (abort !== null && abort()) throw new Error(`offline sshd exited before accepting connections (last: ${lastError?.message ?? "n/a"})`);
    try {
      return await new Promise((resolve, reject) => {
        const client = new Client();
        client.on("ready", () => resolve(client));
        client.on("error", (error) => { client.end?.(); reject(error); });
        client.connect({ host: "127.0.0.1", port, username, password, readyTimeout: 4000 });
      });
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) {
        throw new Error(`offline sshd did not accept a connection within ${timeoutMs} ms: ${lastError?.message ?? lastError}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** 轮询等条件成立（不要用固定睡眠）。 */
export async function waitFor(condition, { timeoutMs = 15000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
