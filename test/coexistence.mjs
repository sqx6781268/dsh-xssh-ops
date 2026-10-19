// 共存验收（R1/计划 M0 的「共存」判据）：dsh-ssh-ops 与本插件**同时装载**时互不干扰。
//
// 为什么值得单独测：两个插件是同一个上游的 fork，共用大量概念（都叫 SSH 服务、都有
// tab、都有域表、都注册工具）。只要**任何一个注册面重名**，DSH 启动时就会冲突或
// 互相覆盖 —— 而那种问题在单插件测试里永远看不到。
//
// 判据分四层，全部用**两份构建产物/源码**做实证比对（不靠记忆）：
//   ① 工具名不重名（两个插件都注册给同一个 LLM 工具表）；
//   ② 存储域 id 不重名（同名域会互相覆盖数据）；
//   ③ Remote 服务命名空间不重名；
//   ④ tab 标记属性不重名（否则两个面板会互相干扰）。
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = joinPath(dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM = "C:/Users/songqixing/Documents/deepseek-harness/default-workspace/dsh-ssh-ops-socks5/repo";

if (!existsSync(joinPath(UPSTREAM, "lib/index.js"))) {
  console.log(`跳过：找不到上游构建产物（${UPSTREAM}/lib/index.js）—— 共存比对需要两份产物。`);
  console.log("      工具名/域 id 的**自身**前缀检查由 test/tool-namespace.mjs 覆盖。");
  process.exit(0);
}

const ours = readFileSync(joinPath(ROOT, "lib/index.js"), "utf8");
const theirs = readFileSync(joinPath(UPSTREAM, "lib/index.js"), "utf8");
const oursClient = readFileSync(joinPath(ROOT, "lib/client.js"), "utf8");
const theirsClient = readFileSync(joinPath(UPSTREAM, "lib/client.js"), "utf8");

/** 收集某个产物里注册的 LLM 工具名（含 ssh/sftp/tunnel 前缀的那些）。 */
function toolNames(text) {
  return new Set([...text.matchAll(/name:\s*"([a-z][a-z0-9_]*)"/g)]
    .map((m) => m[1])
    // 统计工具入口：排除 4 个存储域 id（*_ops_*），并让 xtunnel 这种无下划线名也算
    .filter((name) => /^(?:x?ssh|xsftp|xtunnel|sftp|tunnel)(?:_|$)/.test(name) && !name.includes("_ops_")));
}
/** 收集存储域 id。 */
function domainNames(text) {
  return new Set([...text.matchAll(/name:\s*"((?:x?ssh)_ops_[a-z_]+)"/g)].map((m) => m[1]));
}
/** 收集 tab 标记属性名（两个面板靠它互认）。 */
function tabAttrs(text) {
  return new Set([...text.matchAll(/data-dsh-[a-z0-9-]*(?:ssh|xssh)[a-z0-9-]*/gi)].map((m) => m[0]));
}

// ── ① 工具名零交集 ───────────────────────────────────────────────────
{
  const mine = [...toolNames(ours)];
  const yours = toolNames(theirs);
  assert.equal(mine.length, 14, `本插件应注册 R10 的 13 个入口工具 + xssh_resource（实际 ${mine.length}）`);
  assert.ok(yours.size > 10, `上游应注册多个工具（实际 ${yours.size}）`);
  const overlap = mine.filter((name) => yours.has(name));
  assert.deepEqual(overlap, [],
    `工具名不得重名（两个插件都注册给同一个工具表，重名会互相覆盖）：\n  ${overlap.join("\n  ")}`);
  console.log(`① 工具名：本插件 ${mine.length} 个，上游 ${yours.size} 个，交集 0 ✅`);
}

// ── ② 存储域 id 零交集 ───────────────────────────────────────────────
{
  const mine = [...domainNames(ours)];
  const yours = [...domainNames(theirs)];
  const overlap = mine.filter((name) => yours.includes(name));
  assert.deepEqual(overlap, [],
    `存储域 id 不得重名（同名域会互相覆盖数据）：\n  ${overlap.join("\n  ")}`);
  // 明确验计划里定的两组命名（实测形态：本插件加 x 前缀，上游无前缀）。
  // 注意用带引号的精确匹配 —— 直接 includes("ssh_ops_profiles") 会被
  // "xssh_ops_profiles" 命中（子串关系），得到假通过。
  for (const name of ["xssh_ops_profiles", "xssh_ops_credentials", "xssh_ops_known_hosts", "xssh_ops_settings"]) {
    assert.ok(ours.includes(`"${name}"`), `本插件应有域 ${name}`);
  }
  for (const name of ["ssh_ops_profiles", "ssh_ops_credentials", "ssh_ops_known_hosts", "ssh_ops_settings"]) {
    assert.ok(theirs.includes(`"${name}"`), `上游应有域 ${name}`);
    assert.equal(ours.includes(`"${name}"`), false, `不得复用上游域 ${name}`);
  }
  console.log(`② 存储域：本插件 ${JSON.stringify(mine)}；上游 ${JSON.stringify(yours)}；交集 0 ✅`);
}

// ── ③ Remote 服务命名空间不重名 ───────────────────────────────────────
{
  assert.ok(ours.includes('super(ctx, "xsshOps")'), "本插件服务名应是 xsshOps");
  assert.ok(theirs.includes('super(ctx, "sshOps")'), "上游服务名应是 sshOps");
  assert.equal(ours.includes('super(ctx, "sshOps")'), false, "不得复用上游服务名 sshOps");
  console.log(`③ 服务命名空间：xsshOps vs sshOps ✅`);
}

// ── ④ tab 标记属性不重名 ─────────────────────────────────────────────
{
  const mine = [...tabAttrs(oursClient)];
  const yours = [...tabAttrs(theirsClient)];
  const overlap = mine.filter((name) => yours.includes(name));
  assert.deepEqual(overlap, [],
    `tab 标记属性不得重名（两个面板靠它互认，重名会互相干扰）：\n  ${overlap.join("\n  ")}`);
  console.log(`④ tab 标记：本插件 ${JSON.stringify(mine)}，上游 ${JSON.stringify(yours)}，交集 0 ✅`);
}

// ── ⑤ 两份产物各自独立可加载（不互相 import）─────────────────────────
{
  // 交叉引用会让「卸载一个」影响另一个。
  for (const [label, text, foreign] of [
    ["本插件", ours, "dsh-ssh-ops"],
    ["上游", theirs, "dsh-xssh-ops"]
  ]) {
    assert.equal(text.includes(`require("${foreign}")`) || text.includes(`from "${foreign}"`), false,
      `${label}的产物不得直接引用另一个插件（否则两者无法独立卸载）`);
  }
  console.log(`⑤ 独立性：两份产物互不引用 ✅`);
}

console.log("\n共存验收：工具名 / 存储域 / 服务命名空间 / tab 标记四层注册面全部零交集，两份产物互不引用");
