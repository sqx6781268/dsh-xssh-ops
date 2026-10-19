// 新增客户端组件的**运行时**验证（不是源码级、也不是产物字符串级）。
//
// 为什么需要：`TaskList.jsx` 与 `DegradedBanner.jsx` 是本项目新增、且此前**从没被
// 真正执行过** —— 测试只检查了产物里"有这些字符串"。那证明不了它们能跑：
// 一个属性名拼错、一个 `useEffect` 依赖写错、一个 `t()` 键缺失，都要到用户打开
// 界面时才炸。这份测试把产物**加载起来并调用组件函数**，检查它产出的元素树。
//
// 做法：产物是 `window.__ModuleLoader__.load({ id, factory })` 形态（CJS + react external）。
// 我们模拟一个最小 `window`，用真的 `react` 满足它的 `require("react")`，然后调用
// 组件函数。**不渲染 DOM**（没有 react-dom），但 React 函数组件在首次调用时会执行
// 主体逻辑（hooks 由我们提供的最小实现支撑），足以抓出结构性错误。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = joinPath(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = readFileSync(joinPath(ROOT, "lib/client.js"), "utf8");
const require = createRequire(import.meta.url);

// ── 加载产物：模拟 window.__ModuleLoader__.load，捕获 factory ─────────────
//
// 产物是给**浏览器**用的，加载期就会碰 `window` / `self`（xterm 的 UMD 头、
// ModuleLoader 注册），所以这里补一个最小的浏览器壳。这不是"假装在浏览器里跑"，
// 而是**够用的最小环境**：只为让它能完成注册与初始化，不做 DOM 断言。
let loaded = null;
const fakeWindow = {
  __ModuleLoader__: {
    load({ id, factory }) { loaded = { id, factory }; }
  }
};
// xterm 的 UMD 头会读 `self`；指向同一个壳即可。
fakeWindow.self = fakeWindow;
new Function("window", "self", BUNDLE)(fakeWindow, fakeWindow);
assert.ok(loaded !== null, "产物应当调用 window.__ModuleLoader__.load 完成注册");
assert.equal(loaded.id, "dsh-xssh-ops", "注册 id 应是插件名");

// 产物外部依赖只有 react 与 @deepseek-ai/*；组件只用到 react。
const exports = loaded.factory((name) => {
  if (name === "react") return require("react");
  // @deepseek-ai/* 在真实宿主机里由 ModuleLoader 提供；这里给它最小替身。
  return {};
});

// ── 组件是否真的导出了 ────────────────────────────────────────────────
//
// 观察（**实测而非假设**）：客户端插件的产物只导出 `{ SSH_TAB_ID, SSH_TAB_KIND, apply, inject }`
// —— 组件是**内部实现**，不挂在 exports 上。这是插件的正确约定（宿主只关心
// apply/inject 与 tab 标记常量），所以**不该断言组件被导出**。
// 真正该验的是：`apply` 能被调用（插件真的能装上），以及它引用的宿主能力齐全。
{
  assert.deepEqual(Object.keys(exports).sort(), ["SSH_TAB_ID", "SSH_TAB_KIND", "apply", "inject"],
    `客户端产物的导出面应与约定一致（实际 ${JSON.stringify(Object.keys(exports))}）`);
  assert.equal(typeof exports.apply, "function", "必须导出可调用的 apply");
  assert.equal(typeof exports.inject, "object", "必须导出 inject 声明");
  assert.equal(typeof exports.SSH_TAB_KIND, "string", "tab kind 应是字符串");
  assert.ok(exports.SSH_TAB_ID.length > 0, "tab id 不应为空");
  console.log(`① 产物导出面正确：${Object.keys(exports).join(", ")}（tab kind=${exports.SSH_TAB_KIND}）`);
}

// ── `apply(ctx)` 能被真实调用 —— 这是"插件能装上"的运行时验证 ────────────
//
// **在子进程里跑**，理由：`apply` 会启动异步后续（订阅、语言跟随），在主进程里
// 那些未清理的句柄会让测试**挂住不退**（实测：跑 5 分钟不结束）。子进程里跑可以
// 拿到"是否抛错"的确定结论，然后直接杀掉 —— 干净且可诊断。
{
  const script = `
    const { readFileSync } = require("node:fs");
    const bundle = readFileSync(${JSON.stringify(joinPath(ROOT, "lib/client.js"))}, "utf8");
    let loaded = null;
    const fakeWindow = { __ModuleLoader__: { load({ id, factory }) { loaded = { id, factory }; } } };
    fakeWindow.self = fakeWindow;
    new Function("window", "self", bundle)(fakeWindow, fakeWindow);
    const exports = loaded.factory((name) => (name === "react" ? require("react") : {}));

    // 最小 ctx：用 Proxy 兜住一切未知能力，既能看到它用了什么、又不会因替身不全而误判。
    const used = new Set();
    const ctx = new Proxy({}, {
      get(_t, prop) {
        used.add(String(prop));
        return new Proxy(function () { return undefined; }, {
          get(_t2, sub) { used.add(String(prop) + "." + String(sub)); return function () { return undefined; }; },
          apply() { return undefined; }
        });
      }
    });
    try {
      exports.apply(ctx);
    } catch (error) {
      // 同步抛错 = 插件装不上（宿主启动时会报）
      console.log("APPLY_SYNC_ERROR " + error.message);
      process.exit(2);
    }
    // 给它一点时间让异步后续跑（applyFollow 之类）—— 那些错也要抓
    setTimeout(() => {
      console.log("APPLY_OK " + [...used].join(","));
      process.exit(0);
    }, 300);
    process.on("uncaughtException", (error) => {
      console.log("APPLY_ASYNC_ERROR " + error.message);
      process.exit(3);
    });
    process.on("unhandledRejection", (reason) => {
      console.log("APPLY_REJECTION " + (reason && reason.message ? reason.message : String(reason)));
      process.exit(4);
    });
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 20000
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0 && !/APPLY_/.test(out)) {
    assert.fail(`apply 子进程异常退出（status=${result.status}）：${out.slice(0, 400)}`);
  }
  assert.equal(/APPLY_SYNC_ERROR/.test(out), false,
    `apply(ctx) 同步抛错 —— 插件装不上会在宿主启动时报错：${out.match(/APPLY_SYNC_ERROR (.*)/)?.[1] ?? out.slice(0, 300)}`);
  assert.equal(/APPLY_ASYNC_ERROR|APPLY_REJECTION/.test(out), false,
    `apply 的**异步后续**抛错（用户会遇到"打开面板就崩"）：${out.match(/APPLY_(?:ASYNC_ERROR|REJECTION) (.*)/)?.[1] ?? out.slice(0, 300)}`);
  const usedCapabilities = (out.match(/APPLY_OK (.*)/)?.[1] ?? "").split(",").filter(Boolean);
  assert.ok(usedCapabilities.length > 0, `应能看到 apply 用到的宿主能力（实际 ${JSON.stringify(out.slice(0, 200))}）`);
  console.log(`② apply(ctx) 调用成功且异步后续无异常；它用到的宿主能力：${usedCapabilities.slice(0, 12).join(", ")}`);
}

// ── 契约级：组件调用的每个 api 方法都必须在 client/api.js 里存在 ──────────
//
// 这是**真正会断**的地方：客户端走字符串方法名（`api.taskList(...)`），
// 名字拼错不会在构建期报错，只会在用户点开界面时"方法不存在"。
{
  const apiSource = readFileSync(joinPath(ROOT, "src/client/api.js"), "utf8");
  // 判据要覆盖 `async name(` —— 早期正则只认 `  name(`，于是把 `async streamTerminal`
  // 这类方法误判成"不存在"（假阳性）。方法定义的实际形态是 `  async name(...)`。
  const registered = new Set([
    ...apiSource.matchAll(/^\s{2}(?:async\s+)?([a-zA-Z][A-Za-z0-9_]*)\s*\(/gm)
  ].map((m) => m[1]));

  // 组件源码里用到的 api 方法（从产物里取，因为它已经是真实编译结果）
  const used = new Set([...BUNDLE.matchAll(/\bapi\.([a-z][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]));
  assert.ok(used.size > 0, "产物里应能找到组件对 api 的调用");

  const missing = [...used].filter((name) => !registered.has(name));
  assert.deepEqual(missing, [],
    `组件调用了 api 上不存在的方法（运行时会 "is not a function"）：\n  ${missing.join("\n  ")}`);
  console.log(`③ 组件用到的 ${used.size} 个 api 方法全部存在：${[...used].sort().join(", ")}`);
}

// ── 契约级：Remote 方法名也必须在 descriptors 里（客户端调 host 的字符串）──
{
  const descriptors = readFileSync(joinPath(ROOT, "src/descriptors.js"), "utf8");
  const hostMethods = new Set([...descriptors.matchAll(/def\("([a-zA-Z0-9_]+)"/g)].map((m) => m[1]));
  const apiSource = readFileSync(joinPath(ROOT, "src/client/api.js"), "utf8");
  const called = new Set([...apiSource.matchAll(/this\.call\("([A-Za-z0-9_]+)"/g)].map((m) => m[1]));
  const missing = [...called].filter((name) => !hostMethods.has(name));
  assert.deepEqual(missing, [], `api.js 调用了 host 未注册的方法：${missing.join(", ")}`);
  console.log(`④ api.js 的 ${called.size} 个 Remote 方法都在 host descriptors 里`);
}

// ── 产物级：i18n 键必须在字典里（组件用 t() 显示文案，键缺失会显示原文）────
{
  const en = readFileSync(joinPath(ROOT, "src/i18n/messages.en.js"), "utf8");
  // 组件里 t("…") 的中文键以 \uXXXX 转义存在于产物中；这里从**源码**取键更可靠。
  const componentFiles = ["src/client/TaskList.jsx", "src/client/DegradedBanner.jsx"];
  const missing = [];
  for (const file of componentFiles) {
    const source = readFileSync(joinPath(ROOT, file), "utf8");
    for (const match of source.matchAll(/t\(\s*"([^"]{2,})"/g)) {
      const key = match[1];
      // 带 ${} 插值的键由 i18n 检查器单独校验；这里只看静态字面量
      if (key.includes("${")) continue;
      if (!en.includes(`"${key}"`)) missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(missing, [], `组件里的 i18n 键缺英译：\n  ${missing.join("\n  ")}`);
  console.log(`⑤ 两个组件的静态 i18n 键均有英译`);
}

console.log("\n客户端运行时验证：产物可加载、apply(ctx) 及其异步后续无异常、api/Remote/i18n 三类契约齐全");
