// 接线完整性审计（回归护栏）。
//
// 存在理由：本项目**两次**出现「写好的能力因为没接线而从未生效」：
//   ① R9② 的 DSL 模块只被 import、没有任何调用点 → esbuild tree-shaking 把导出全删了；
//   ② `tickLoginScripts` 定义了但没人调用 → 登录脚本的超时策略永远不会触发。
// 两次都**在源码 review 里看不出来**。这个测试把「有没有调用点」变成一条可执行的断言。
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join as joinPath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = joinPath(dirname(fileURLToPath(import.meta.url)), "..");

/** 本次新增的模块（新增能力都要登记在这里，否则审计覆盖不到）。 */
const CAPABILITY_MODULES = [
  "src/line-journal.js",
  "src/line-number.js",
  "src/command-ledger.js",
  "src/terminal-text.js",
  "src/login-script.js",
  "src/login-script-dsl.js",
  "src/idle-string.js",
  "src/task-dir.js",
  "src/task-ledger.js",
  "src/tools/terminal-lines.js",
  "src/tools/exec-background.js"
];

/** 收集 src/ + test/ + scripts/ 的全部文本作为「调用点搜索域」。 */
function collectSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = joinPath(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(full); continue; }
      if (/\.(js|jsx|mjs)$/.test(entry.name)) out.push({ file: full, text: readFileSync(full, "utf8") });
    }
  };
  for (const sub of ["src", "test", "scripts"]) {
    if (existsSync(joinPath(ROOT, sub))) walk(joinPath(ROOT, sub));
  }
  return out;
}

/** 一个模块里所有导出名。 */
function exportedNames(text) {
  const names = new Set();
  for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const piece of m[1].split(",")) {
      const name = piece.trim().split(/\s+as\s+/).pop().trim();
      if (name !== "") names.add(name);
    }
  }
  return [...names];
}

// ── ① 每个导出都要真的有使用点 ─────────────────────────────────────────
//
// 判据分三类，写错了就会误报（两种都踩过）：
//   - **函数/工厂**（小写开头、非全大写）：必须有**外部**调用点 `name(`，
//     因为没被别处调用的函数就是"写了没接线"（会被 tree-shaking 剔除）；
//   - **常量/枚举**（全大写 `DEFAULT_*`/`MAX_*` 或类名）：只需要在**自己模块内**被用到
//     即可 —— 导出它们是为了可配与可测，本来就允许只有模块内引用；
//     一律要求外部引用会把 `byText` 的默认值常量全判成缺陷（假阳性）。
//   - 一个导出若**任何地方**都没用到（含自己模块），那就是真死代码。
{
  const sources = collectSources();
  const offenders = [];
  const deadCode = [];
  for (const rel of CAPABILITY_MODULES) {
    const full = joinPath(ROOT, rel);
    assert.ok(existsSync(full), `${rel} 不存在（能力清单过期了？）`);
    const own = readFileSync(full, "utf8");
    for (const name of exportedNames(own)) {
      const isCallLike = /^[a-z]/.test(name) && !/^[A-Z0-9_]+$/.test(name);
      // 自己模块内的使用（排除 export 那一行本身的声明）
      const ownUses = own.split("\n").some((line) => line.includes(name) && !/^\s*export\s/.test(line));
      const usedElsewhere = sources.some((s) => s.file !== full
        && s.text.includes(isCallLike ? `${name}(` : name));
      if (isCallLike) {
        if (!usedElsewhere) offenders.push(`${rel} → ${name}（函数无外部调用点）`);
      } else if (!ownUses && !usedElsewhere) {
        deadCode.push(`${rel} → ${name}（常量/类完全没被使用）`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `这些函数没有任何外部调用点 —— 很可能"写了没接线"（会被 tree-shaking 剔除或永不执行）：\n  ${offenders.join("\n  ")}`);
  assert.deepEqual(deadCode, [],
    `这些导出完全没被使用（含自己模块）—— 是死代码：\n  ${deadCode.join("\n  ")}`);
}

// ── ② 新能力的关键符号必须在构建产物里 ─────────────────────────────────
{
  const host = readFileSync(joinPath(ROOT, "lib/index.js"), "utf8");
  const client = readFileSync(joinPath(ROOT, "lib/client.js"), "utf8");
  const SYMBOLS = [
    ["行日志容量", host, "lineJournalMaxLines"],
    ["命令台账闭口", host, "closeFromShellIntegration"],
    ["登录脚本危险命令检查", host, "dangerous-send"],
    ["登录脚本超时推进", host, "tickLoginScripts"],
    ["DSL 沙箱标记", host, "xssh-login-script.js"],
    ["空闲字符串推进", host, "tickIdleStrings"],
    ["任务落点包装", host, "setsid nohup"],
    ["任务台账落盘", host, "tasks.jsonl"],
    ["TTL 清理", host, "sweepExpiredTasks"],
    ["后台任务工具", host, "xssh_exec_background"],
    ["行号读取工具", host, "xssh_terminal_read"],
    ["客户端行号格式化", client, "formatLineNumber"],
    ["客户端任务视图", client, "background tasks"],
    ["降级告警汇总", client, "taskDegradedNotices"],
    // 三个节拍器：能力本身在产物里，但如果定时器注册没进产物就等于没接线
    ["空闲字符串节拍器", host, "idle-string ticker"],
    ["登录脚本超时节拍器", host, "login-script timeout ticker"],
    ["任务 TTL 节拍器", host, "task ttl sweeper"]
  ];
  const missing = SYMBOLS.filter(([, text, symbol]) => !text.includes(symbol)).map(([label, , symbol]) => `${label}（${symbol}）`);
  assert.deepEqual(missing, [], `构建产物缺少这些符号：\n  ${missing.join("\n  ")}`);
}

// ── ③ 三个节拍器都必须真的 setInterval 且 unref ─────────────────────────
{
  const host = readFileSync(joinPath(ROOT, "src/index.js"), "utf8");
  for (const name of ["idle-string ticker", "login-script timeout ticker", "task ttl sweeper"]) {
    assert.ok(host.includes(name), `缺少节拍器注册：${name}`);
  }
  // 每个注册都要有 unref（否则插件会拖住进程退出）与 clearInterval（卸载即停）
  const unrefs = (host.match(/timer\.unref\(\)/g) || []).length;
  assert.ok(unrefs >= 3, `至少 3 处 unref（实际 ${unrefs}）—— 定时器不 unref 会拖住进程退出`);
  const clears = (host.match(/clearInterval\(timer\)/g) || []).length;
  assert.ok(clears >= 3, `至少 3 处 clearInterval（实际 ${clears}）—— 卸载时要停掉定时器`);
}

console.log("wiring audit: every exported capability has a call site, artifacts carry the symbols, all tickers armed");
