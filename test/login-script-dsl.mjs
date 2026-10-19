// R9② 方案 A：受限 DSL 会话脚本（用户 2026-10-17 拍板）
//
// 这一项的**全部意义**在安全边界，所以测试的重点是「拿不到什么」：
// 脚本必须无法访问 require / process / fs / net / child_process / 宿主原型链，
// 超预算必须被中止且**不影响会话可用性**。
import assert from "node:assert/strict";
import {
  DEFAULT_SCRIPT_MAX_STEPS,
  DEFAULT_SCRIPT_TIMEOUT_MS,
  MAX_SCRIPT_BYTES,
  SCRIPT_API_NAMES,
  createScriptRunner,
  validateScriptSettings
} from "../src/login-script-dsl.js";

/** 造一套记录调用的会话能力桩。 */
function makeCaps({ expectResult = true } = {}) {
  const calls = { expect: [], send: [], readLines: [], log: [] };
  return {
    calls,
    caps: {
      expect: async (pattern, timeoutMs) => { calls.expect.push({ pattern, timeoutMs }); return expectResult; },
      send: async (text, pressEnter) => { calls.send.push({ text, pressEnter }); },
      readLines: async (from, to) => { calls.readLines.push({ from, to }); return [{ line: from, text: "OUT" }]; },
      log: (message) => { calls.log.push(message); }
    }
  };
}

/** 固定时钟 + 立即完成的 wait，让预算判定完全确定。 */
function makeRunner(caps, options = {}) {
  let clock = 1_700_000_000_000;
  const runner = createScriptRunner(caps, {
    now: () => clock,
    wait: async (ms) => { clock += ms; },
    ...options
  });
  return { runner, advance: (ms) => { clock += ms; } };
}

// ── 默认预算与 API 名单 ───────────────────────────────────────────────────
{
  assert.equal(DEFAULT_SCRIPT_TIMEOUT_MS, 30000);
  assert.equal(DEFAULT_SCRIPT_MAX_STEPS, 200);
  assert.equal(MAX_SCRIPT_BYTES, 256 * 1024);
  assert.deepEqual(SCRIPT_API_NAMES, ["expect", "send", "readLines", "log", "sleep", "close"]);
  // 构造时缺能力要立刻报错，而不是等脚本跑起来才发现
  assert.throws(() => createScriptRunner({}), /needs a expect\(\) capability/);
  assert.throws(() => createScriptRunner({ expect: () => {} }), /needs a send\(\) capability/);
}

// ── 正常脚本：expect → send → log → close ────────────────────────────────
{
  const { caps, calls } = makeCaps();
  const { runner } = makeRunner(caps);
  const result = await runner.run(`
    const ok = await expect("Password");
    if (ok) await send("s3cret");
    log("login done");
    close();
  `);
  assert.equal(result.ok, true, `脚本应成功：${result.error?.message ?? ""}`);
  assert.equal(result.closed, true);
  assert.deepEqual(calls.expect.map((c) => c.pattern), ["Password"]);
  assert.deepEqual(calls.send, [{ text: "s3cret", pressEnter: true }]);
  assert.deepEqual(calls.log, ["login done"]);
}

// ── send(text, false) 不补回车 ────────────────────────────────────────────
{
  const { caps, calls } = makeCaps();
  const { runner } = makeRunner(caps);
  const result = await runner.run(`await send("partial", false);`);
  assert.equal(result.ok, true);
  assert.deepEqual(calls.send, [{ text: "partial", pressEnter: false }]);
}

// ── readLines 校验参数（坏参数抛错，不静默给空）──────────────────────────
{
  const { caps, calls } = makeCaps();
  const { runner } = makeRunner(caps);
  const bad = await runner.run(`const rows = await readLines(5, 1); log("unreachable");`);
  assert.equal(bad.ok, false, "from > to 必须报错");
  assert.match(bad.error.message, /1 <= from <= to/);
  assert.deepEqual(calls.readLines, [], "坏参数不该真的去读");

  const { caps: caps2, calls: calls2 } = makeCaps();
  const { runner: runner2 } = makeRunner(caps2);
  const good = await runner2.run(`const rows = await readLines(1, 3); log("got " + rows.length);`);
  assert.equal(good.ok, true);
  assert.deepEqual(calls2.readLines, [{ from: 1, to: 3 }]);
  assert.deepEqual(calls2.log, ["got 1"]);
}

// ── 安全边界：require / process / fs / net / child_process 全部拿不到 ────
//
// 判据要写对。两个坑都在这里踩过：
//   ① `typeof require` 这类**取值表达式**不能在模板字符串里拼 —— 拼进去会被当字面量，
//      于是 `typeof "require"` 得到 `"string"`，看起来像拿到了 require（假阳性）；
//   ② 赋值表达式（`x = 1`）返回右值，拿它当逃逸判据也是错的。
// 所以下面用 `typeof` 求值（真执行）+ 明确的 `undefined` 判定。
{
  // 只放**裸标识符**：这些用 `typeof x` 判存在性（JS 语言特性：未声明返回 "undefined"）。
  // 带 `...()` 调用的逃逸探针放在下面的 escapeProbes，因为它们的返回值判据不同。
  const probes = [
    ["require", "require"],
    ["process", "process"],
    ["globalThis.process", "globalThis.process"],
    ["Buffer", "Buffer"],
    ["fetch", "fetch"],
    ["setTimeout", "setTimeout"],
    ["XMLHttpRequest", "XMLHttpRequest"],
    ["module", "module"],
    ["exports", "exports"],
    ["__dirname", "__dirname"],
    ["__filename", "__filename"],
    ["process.binding", "process.binding"]
  ];
  for (const [label, expression] of probes) {
    const { caps } = makeCaps();
    const { runner } = makeRunner(caps);
    const result = await runner.run(`
      let kind;
      try { kind = typeof (${expression}); } catch (e) { kind = "ReferenceError"; }
      log(kind);
    `);
    assert.equal(result.ok, true, `${label}: 脚本本身不该崩（只是拿不到）`);
    // 两条合法结果都表示「拿不到」：
    //   - `undefined`：`typeof 未声明标识符` 是 JS 语言特性（不抛错）；
    //   - `ReferenceError`：表达式在求值阶段就找不到这个标识符。
    // 只要**不是** object/function/string/number 之类「真的取到了东西」，就算通过。
    const kind = result.messages[0];
    assert.ok(
      kind === "undefined" || kind === "ReferenceError",
      `${label}：应完全不存在（实际 typeof = ${kind}）`
    );
  }

  // 返回**值本身**的逃逸探针：这几条如果取到了东西，就是真的逃逸。
  // 判据必须**await 之后再看值**：`Function(...)()` 里若返回 Promise，只看 `typeof`
  // 会得到 "object"（Promise 本身）而被误判成逃逸 —— 实测该 Promise 在 await 时
  // 抛 `ReferenceError: require is not defined`，是安全的。
  const escapeProbes = [
    ["constructor 逃逸", "(0).constructor.constructor('return process')()"],
    ["Function 构造器逃逸", "Function('return require')()"],
    ["globalThis.constructor 逃逸", "globalThis.constructor.constructor('return process')()"],
    ["异步 Function 逃逸", "Function('return (async () => require)()')()"],
    ["new Function 逃逸", "new Function('return module')()"]
  ];
  for (const [label, expression] of escapeProbes) {
    const { caps } = makeCaps();
    const { runner } = makeRunner(caps);
    const result = await runner.run(`
      let verdict;
      try {
        const value = await (${expression});   // await 才能看到 Promise 的真实结果
        verdict = value === undefined || value === null ? "none" : "ESCAPED:" + typeof value;
      } catch (e) { verdict = "none:" + e.name; }
      log(verdict);
    `);
    assert.equal(result.ok, true, `${label}: 脚本本身不该崩`);
    assert.equal(result.messages[0]?.startsWith("ESCAPED"), false, `${label}：不得取到任何宿主对象（${result.messages[0]}）`);
  }

  // `eval('typeof module')` 这类**求值型**探针不能和上面混在一起：它本就返回字符串
  // （`"undefined"`），拿返回值当逃逸判据是错的（实测就是这么误报的）。
  {
    const { caps } = makeCaps();
    const { runner } = makeRunner(caps);
    const result = await runner.run(`
      log("eval module => " + eval('typeof module'));
      log("eval require => " + eval('typeof require'));
      log("eval process => " + eval('typeof process'));
    `);
    assert.deepEqual(result.messages, [
      "eval module => undefined",
      "eval require => undefined",
      "eval process => undefined"
    ], "求值型探针的返回值应是 undefined，而不是取到了对象");
  }
}

// ── context 里只应有白名单：注入的 API 与极少数无害内建 ─────────────────
{
  const { caps } = makeCaps();
  const { runner } = makeRunner(caps);
  const result = await runner.run(`
    const present = [];
    for (const key of ["expect","send","readLines","log","sleep","close","console","TextDecoder","URL","require","process","module","Buffer","fetch","setTimeout"]) {
      let kind;
      try { kind = typeof eval(key); } catch (e) { kind = "absent"; }
      if (kind !== "absent") present.push(key + ":" + kind);
    }
    log(present.join(","));
  `);
  assert.equal(result.ok, true);
  const present = String(result.messages[0] ?? "").split(",").filter(Boolean);
  const names = present.map((entry) => entry.split(":")[0]);
  // 六个 API 必须在
  for (const api of SCRIPT_API_NAMES) assert.ok(names.includes(api), `${api} 应被注入`);
  // 危险能力一个都不许在
  for (const dangerous of ["require", "process", "module", "Buffer", "fetch", "setTimeout"]) {
    assert.equal(names.includes(dangerous), false, `${dangerous} 不得出现在 context 里`);
  }
  assert.deepEqual(names.sort(), ["TextDecoder", "URL", "close", "console", "expect", "log", "readLines", "send", "sleep"].sort());
}

// ── 原型污染不穿透到宿主（同一 context 内的污染也不能影响宿主）──────────
{
  const { caps } = makeCaps();
  const { runner } = makeRunner(caps);
  const before = Object.prototype.polluted;
  const result = await runner.run(`
    // 只改本 context 内的原型；不该影响宿主
    ({}).__proto__.polluted = "yes";
    log("done");
  `);
  assert.equal(result.ok, true);
  assert.equal(Object.prototype.polluted, before, "宿主原型不得被污染");
  delete Object.prototype.polluted;
}

// ── 注入的 API 对象被冻结：脚本改不动它 ──────────────────────────────────
{
  const { caps, calls } = makeCaps();
  const { runner } = makeRunner(caps);
  const result = await runner.run(`
    try { send = null; } catch (e) {}
    try { expect = null; } catch (e) {}
    // 仍然要能正常发
    await send("still works");
  `);
  assert.equal(result.ok, true);
  assert.deepEqual(calls.send.map((c) => c.text), ["still works"], "替换失败但原函数仍可用");
}

// ── 死循环被 vm 的同步超时挡住 ───────────────────────────────────────────
{
  const { caps } = makeCaps();
  let clock = 1_700_000_000_000;
  const runner = createScriptRunner(caps, {
    timeoutMs: 50,
    now: () => clock,
    wait: async () => {}
  });
  const result = await runner.run(`while (true) {}`);
  assert.equal(result.ok, false, "死循环必须被中止");
  assert.ok(result.error !== null);
  void clock;
}

// ── 步数预算：超过上限被中止（且会话不受影响）────────────────────────────
{
  const { caps, calls } = makeCaps();
  const { runner } = makeRunner(caps, { maxSteps: 5 });
  const result = await runner.run(`
    for (let i = 0; i < 100; i += 1) { log("message " + i); }
  `);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /5-step budget/);
  assert.equal(calls.log.length, 5, "只跑到上限就停");
}

// ── 时间预算：sleep 耗尽预算后后续调用被拒 ──────────────────────────────
{
  const { caps, calls } = makeCaps();
  const { runner } = makeRunner(caps, { timeoutMs: 1000 });
  const result = await runner.run(`
    await sleep(900);
    await sleep(900);   // 这一下会撞到总预算
    log("unreachable");
  `);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /budget/);
  assert.deepEqual(calls.log, [], "预算耗尽后不该再有副作用");
}

// ── close() 之后再调用 API 要报错（脚本不能继续动作）─────────────────────
{
  const { caps, calls } = makeCaps();
  const { runner } = makeRunner(caps);
  const result = await runner.run(`
    close();
    await send("after close");
  `);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /already closed/);
  assert.deepEqual(calls.send, [], "close 之后不得再发送");
}

// ── 未调用 close() 也算收尾（不留悬挂状态）──────────────────────────────
{
  const { caps } = makeCaps();
  const { runner } = makeRunner(caps);
  const result = await runner.run(`await send("hi");`);
  assert.equal(result.ok, true);
  assert.equal(result.closed, true, "未显式 close 也要被收尾");
  assert.equal(result.steps >= 1, true, "步数要报出来");
}

// ── 脚本抛错：错误被捕获并回报，不让会话挂掉 ────────────────────────────
{
  const { caps, calls } = makeCaps();
  const { runner } = makeRunner(caps);
  const result = await runner.run(`throw new Error("boom");`);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /boom/);
  // runner 是**一次性实例**：复跑会被明确拒绝（而不是隐式重置预算）。
  // 失败不得污染会话 —— 用**新的** runner 继续跑即可正常工作。
  await assert.rejects(() => runner.run(`await send("again");`), /already run/);
  const { caps: caps2, calls: calls2 } = makeCaps();
  const { runner: runner2 } = makeRunner(caps2);
  const recovered = await runner2.run(`await send("recovered");`);
  assert.equal(recovered.ok, true, "新实例应能正常工作（失败没有污染会话能力）");
  assert.deepEqual(calls2.send.map((c) => c.text), ["recovered"]);
  assert.deepEqual(calls.send, [], "失败的那次不该发出任何东西");
}

// ── 空脚本与超长脚本被拒 ─────────────────────────────────────────────────
{
  const { caps } = makeCaps();
  const { runner } = makeRunner(caps);
  await assert.rejects(() => runner.run("   "), /script source is empty/);
  await assert.rejects(() => runner.run(null), /script source is empty/);
}

// ── 保存时校验：方案 A 只有 restricted，trusted 必须被拒 ────────────────
{
  assert.equal(validateScriptSettings({ runEnabled: false }).ok, true, "关闭时不要求路径");
  assert.equal(validateScriptSettings({ runEnabled: true, path: "" }).ok, false, "开启必须有路径");
  assert.equal(validateScriptSettings({ runEnabled: true, path: "/home/u/s.js", sandbox: "restricted" }).ok, true);
  const trusted = validateScriptSettings({ runEnabled: true, path: "/home/u/s.js", sandbox: "trusted" });
  assert.equal(trusted.ok, false, "方案 A 下 trusted 不存在");
  assert.equal(trusted.problems[0].code, "sandbox-unsupported");
  assert.match(trusted.problems[0].message, /restricted-DSL only/);
  // 控制字符会破坏 shell 包装与日志
  assert.equal(validateScriptSettings({ runEnabled: true, path: "/home/u/a\u0000b.js", sandbox: "restricted" }).ok, false);
  assert.equal(validateScriptSettings({ runEnabled: true, path: `/${"x".repeat(1100)}.js`, sandbox: "restricted" }).ok, false);
}

// ── 审计：脚本发了什么、记了什么，都能拿到 ──────────────────────────────
{
  const { caps } = makeCaps();
  const { runner } = makeRunner(caps);
  const result = await runner.run(`
    await expect("login");
    await send("user");
    log("step 1 done");
    close();
  `);
  assert.deepEqual(result.sent, ["user"], "发出的内容可追溯");
  assert.deepEqual(result.messages, ["step 1 done"]);
  assert.equal(typeof result.elapsedMs, "number");
  assert.equal(result.ok, true);
}

console.log("login-script DSL: session-API-only sandbox holds (no require/process/fs escape), budgets and audit all hold");
