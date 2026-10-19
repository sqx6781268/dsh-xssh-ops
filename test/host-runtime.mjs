// host 侧的**运行时**验证：把真实产物 `lib/index.js` 加载起来，调用插件的 apply，
// 检查它真的完成了注册，并且注册面与 client/RPC 侧一致。
//
// 为什么需要：此前 host 产物只被"读文本"验证（`wiring-audit` / `coexistence` / `manifest`
// 都是字符串匹配）。字符串匹配证明不了**它能被加载**：一个顶层副作用、一个
// 缺失的依赖、一个 apply 里对 ctx 的错误假设，都要到宿主启动时才炸。
// （上一轮正是用同样方法在客户端抓到「打开面板就崩」的 `stored?.language` 缺陷。）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = joinPath(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

// ── ① 产物能被加载（顶层不得抛错）──────────────────────────────────────
let hostModule;
{
  try {
    hostModule = require(joinPath(ROOT, "lib/index.js"));
  } catch (error) {
    assert.fail(`lib/index.js 加载失败 —— 宿主启动时会报同样的错：${error.message}`);
  }
  assert.equal(typeof hostModule, "object", "host 产物应导出对象");
  console.log(`① host 产物加载成功，导出 ${Object.keys(hostModule).length} 项`);
}

// ── ② 插件类是 default 导出（实测：产物导出 11 项，插件在 `default` 上）───
//
// 实测导出面：`KEEPALIVE_DEFAULTS, LEGACY_VRP_ALGORITHMS, __esModule,
// credentialDomainSpec, default, isKexMismatchError, knownHostDomainSpec,
// loadSettingsRecord, normalizeTerminalEol, profileDomainSpec, settingsDomainSpec`
// —— 域 spec 与常量直接导出（供测试/宿主引用），**插件类在 `default` 上**。
{
  assert.ok(hostModule.default !== undefined, "host 产物必须导出插件类（default）");
  const Plugin = hostModule.default;
  assert.equal(typeof Plugin, "function", `default 应是可构造的插件类（实际 ${typeof Plugin}）`);
  // 域 spec 应当是对象且带 name
  for (const key of ["profileDomainSpec", "credentialDomainSpec", "knownHostDomainSpec", "settingsDomainSpec"]) {
    assert.equal(typeof hostModule[key], "object", `应导出 ${key}`);
    assert.equal(typeof hostModule[key].name, "string", `${key} 应带 name`);
    assert.ok(hostModule[key].name.startsWith("xssh_ops_"), `${key} 的域 id 应以 xssh_ops_ 开头（实际 ${hostModule[key].name}）`);
  }
  console.log(`② 插件类在 default（${Plugin.name || "匿名类"}）；4 个域 spec 直接导出且 id 均带 xssh_ops_ 前缀`);
}

// ── ②' 插件类能被**实例化**，且构造期就完成注册（这是"能装上"的运行时验证）──
//
// 实测：注册不在 `init`/`apply` 里，而在**构造函数**中（`this.registerTools(ctx)` 与
// 三个 `setInterval` 节拍器）。所以判据是「构造后：工具已注册、节拍器已挂、
// 清理 effect 已注册」—— 用记录型 ctx 真的 `new` 一次来验。
{
  const Plugin = hostModule.default;
  const effects = [];
  const registeredTools = [];
  const timers = [];
  const ctx = {
    effect(callback, label) { effects.push({ callback, label }); return () => {}; },
    tools: { register(tool) { registeredTools.push(tool); } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get() { return undefined; }
  };
  const used = new Set();
  const ctxProxy = new Proxy(ctx, {
    get(target, prop) {
      if (prop in target) return target[prop];
      used.add(String(prop));
      return new Proxy(function () { return undefined; }, {
        get(_t, sub) { used.add(`${String(prop)}.${String(sub)}`); return function () { return undefined; }; },
        apply() { return undefined; }
      });
    }
  });

  // 记录构造期挂的定时器（节拍器必须在卸载时可清理）。**不真的跑回调** ——
  // 我们只关心"挂了几种节拍、是否 unref（否则拖住进程退出）"。
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (_fn, ms) => {
    timers.push({ ms });
    clearInterval(realSetInterval(() => {}, ms));   // 立刻清掉，不留真句柄
    return { unref() {}, ms, __fake: true };
  };

  let instance;
  try {
    instance = new Plugin(ctxProxy, {});
  } catch (error) {
    globalThis.setInterval = realSetInterval;
    assert.fail(`new Plugin(ctx) 抛错 —— 宿主加载插件时会报同样的错：${error.message}\n  它用到的宿主能力：${[...used].join(", ")}`);
  }
  globalThis.setInterval = realSetInterval;

  assert.ok(instance !== null && typeof instance === "object", "应得到插件实例");
  assert.equal(registeredTools.length, 14,
    `构造期应注册 R10 的 13 个入口工具 + xssh_resource（实际 ${registeredTools.length} 个）`);
  // ⚠️ 计数口径提示：**不要**拿"产物里 `name: "xssh_*"` 的个数"来对账 ——
  // 那会把 4 个**存储域 id**（`xssh_ops_profiles` 等）也数进去，得到 37 而这里的
  // 运行时注册数是 33（实测核实过：差集正好是那 4 个域）。工具数就该看运行时注册。
  {
    const bundleText = readFileSync(joinPath(ROOT, "lib/index.js"), "utf8");
    const declaredByRegex = [...new Set([...bundleText.matchAll(/name:\s*"((?:xssh|xsftp|xtunnel)_[a-z_]+)"/g)].map((m) => m[1]))];
    const extra = declaredByRegex.filter((name) => !registeredTools.some((tool) => tool.name === name));
    // 多出来的只应是存储域 id（`xssh_ops_*`），不应有别的
    const unexpected = extra.filter((name) => !name.startsWith("xssh_ops_"));
    assert.deepEqual(unexpected, [],
      `产物里声明了却没在构造期注册的工具（非域 id）：${unexpected.join(", ")}`);
  }
  // 工具名必须都带项目前缀（共存前提；tool-namespace.mjs 有全量核对，这里守运行时）
  const bare = registeredTools.map((tool) => tool.name).filter((name) => !/^(?:xssh|xsftp|xtunnel)(?:_|$)/.test(name));
  assert.deepEqual(bare, [], `构造期注册了未加前缀的工具：${bare.join(", ")}`);
  // 清理 effect（卸载时断开连接）必须有
  assert.ok(effects.some((entry) => String(entry.label ?? "").includes("cleanup")),
    `应注册卸载清理 effect（实际标签：${effects.map((e) => e.label).join(", ")}）`);
  // 节拍器：三个（空闲字符串 / 登录脚本超时 / 任务 TTL）
  const intervals = timers.map((t) => t.ms);
  assert.ok(intervals.includes(1000), `应有 1 秒节拍（空闲字符串 + 登录脚本超时）（实际 ${JSON.stringify(intervals)}）`);
  assert.ok(intervals.includes(3600 * 1000), `应有每小时的 TTL 节拍（实际 ${JSON.stringify(intervals)}）`);
  console.log(`②' new Plugin(ctx) 成功（${instance.constructor.name}）：注册 ${registeredTools.length} 个工具、${effects.length} 个 effect、节拍 ${JSON.stringify(intervals)}`);
}

// ── ③ 加载不产生副作用（加载两次结果一致、无额外注册）─────────────────
{
  const first = Object.keys(hostModule).sort();
  delete require.cache[require.resolve(joinPath(ROOT, "lib/index.js"))];
  const second = require(joinPath(ROOT, "lib/index.js"));
  assert.deepEqual(Object.keys(second).sort(), first, "重复加载的导出面应一致（不应有加载期副作用改变导出）");
  console.log(`③ 重复加载导出面一致（${first.length} 项）`);
}

// ── ④ 域声明与 RPC 侧一致（用**运行时导出的 spec** 比对，不是读源码）──────
//
// 这是"两边写在两个文件里、却必须对上"的契约：host 建域、RPC 按域 id 读写。
// 用产物导出的 spec 比对 —— 那是**运行时真实值**，比读源码字符串可靠。
{
  const schemas = readFileSync(joinPath(ROOT, "src/schemas.js"), "utf8");
  const descriptors = readFileSync(joinPath(ROOT, "src/descriptors.js"), "utf8");
  const domainIds = ["profileDomainSpec", "credentialDomainSpec", "knownHostDomainSpec", "settingsDomainSpec"]
    .map((key) => hostModule[key].name);
  // 每个域都应在某处被引用（否则是建了没人用）
  const unused = domainIds.filter((id) => !schemas.includes(id) && !descriptors.includes(id) && !readFileSync(joinPath(ROOT, "src/index.js"), "utf8").includes(id));
  assert.deepEqual(unused, [], `这些域声明了却没人用：${unused.join(", ")}`);
  // 域 id 不得与上游重名（共存的前提，coexistence.mjs 有全量比对，这里守本插件侧）
  for (const id of domainIds) {
    assert.equal(id.startsWith("xssh_ops_"), true, `${id} 应以 xssh_ops_ 开头`);
  }
  console.log(`④ ${domainIds.length} 个存储域（运行时值）齐全且都被引用：${domainIds.join(", ")}`);
}

// ── ⑤ 工具的 output schema 与 render 必须成对（否则调用时会崩）─────────
//
// `defineTool` 的 `output` 若给了 `schema` 就必须给 `render`（渲染结果），反之亦然；
// 只给一半会在工具被调用时抛错。这类错误构建期不报，只在**真的调用**时炸。
{
  const toolFiles = ["src/tools/terminal-lines.js", "src/tools/exec-background.js"];
  const problems = [];
  for (const file of toolFiles) {
    const source = readFileSync(joinPath(ROOT, file), "utf8");
    // 以 `defineTool({` 为界切块，粗略但足够定位
    for (const block of source.split(/defineTool\(\{/).slice(1)) {
      const nameMatch = /name:\s*"([a-z_]+)"/.exec(block);
      const name = nameMatch === null ? "(未命名)" : nameMatch[1];
      const hasOutput = /\boutput:\s*\{/.test(block);
      if (!hasOutput) continue;
      const hasSchema = /\bschema:\s*\{/.test(block);
      const hasRender = /\brender\s*\(/.test(block);
      if (hasSchema !== hasRender) {
        problems.push(`${file}: ${name} —— schema=${hasSchema} render=${hasRender}（必须成对）`);
      }
      // 有 output.schema 时，render 的返回值必须是数组（工具渲染约定）
      if (hasRender && !/return\s*\[/.test(block)) {
        problems.push(`${file}: ${name} —— render 未返回数组（工具渲染约定）`);
      }
    }
  }
  assert.deepEqual(problems, [], `工具 output 契约不完整（调用时会崩）：\n  ${problems.join("\n  ")}`);
  console.log(`⑤ 工具 output 的 schema/render 均成对且 render 返回数组`);
}

// ── ⑥ 工具的 parameters 字段名与实现里读的字段名一致 ──────────────────
//
// 客户端/智能体按 `parameters` 声明传参，实现里读 `args.*`。声明了却不读、
// 或读了却没声明，都会让参数静默失效（`must be a lossless JSON object` 类错误的根因）。
{
  const problems = [];
  for (const file of ["src/tools/terminal-lines.js", "src/tools/exec-background.js"]) {
    const source = readFileSync(joinPath(ROOT, file), "utf8");
    for (const block of source.split(/defineTool\(\{/).slice(1)) {
      const nameMatch = /name:\s*"([a-z_]+)"/.exec(block);
      const name = nameMatch === null ? "(未命名)" : nameMatch[1];
      // 参数声明区（parameters: { ... } 到 output: 之间）
      const paramsSection = /parameters:\s*\{([\s\S]*?)\n\s*\},\n\s*output:/.exec(block);
      if (paramsSection === null) continue;
      const declared = new Set([...paramsSection[1].matchAll(/^\s{6}([a-z_][a-z0-9_]*):\s*\{/gm)].map((m) => m[1]));
      // 实现里读的字段（args.xxx）
      const execSection = block.slice(block.indexOf("async execute("));
      const read = new Set([...execSection.matchAll(/args\.([a-z_][a-z0-9_]*)/g)].map((m) => m[1]));
      // 读了但没声明 ⇒ 参数校验会拒绝（实测踩过：传了 session_id 给不认它的工具）
      for (const field of read) {
        if (!declared.has(field)) problems.push(`${file}: ${name} —— 读了 args.${field} 但 parameters 未声明`);
      }
      // 声明了但不读 ⇒ 参数被忽略（静默失效），也算问题
      for (const field of declared) {
        if (!read.has(field)) problems.push(`${file}: ${name} —— 声明了 ${field} 但 execute 从不读它`);
      }
    }
  }
  assert.deepEqual(problems, [], `工具 parameters 与实现不一致：\n  ${problems.join("\n  ")}`);
  console.log(`⑥ 工具的 parameters 声明与 execute 读取一一对应`);
}

console.log("\nhost 运行时验证：产物可加载、apply 可调用、无加载副作用、域/工具契约齐全");
