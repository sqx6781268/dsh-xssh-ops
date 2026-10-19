// 工具命名空间隔离（回归护栏）。
//
// 为什么需要它：dsh-xssh-ops 与上游 dsh-ssh-ops 会**同时安装**在同一个 profile 里，
// 两个插件注册的工具名一旦相同，宿主里就是互相覆盖 —— 调用方拿到的是哪个插件的
// 实现完全看注册顺序，而且没有任何报错。
//
// 实测踩过的坑：M0 改名器只覆盖了 `ssh_*` 系列，漏了 `sftp_*` 与 `tunnel_*`，
// 于是 8 个 sftp_ 工具与 3 个 tunnel_ 工具与上游**完全同名**，直到用户在界面上
// 观察到异常才暴露。所以这里按「形态」建立不变式，而不是逐个枚举名字：
//   1. 每个注册的工具名都必须带本项目前缀（xssh_ / xsftp_ / xtunnel_），
//      也就是「在原有前缀前加一个 x」的派生规则；
//   2. 不得出现裸的 `ssh_*` / `sftp_*` / `tunnel_*` / `db_*` 工具注册名；
//   3. 同一进程内不得重复注册同名工具。
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 允许的前缀：本项目对上传工具的「加一个 x」派生。 */
// xtunnel 是 R10 规定的无下划线入口名（x 前缀已足够区分上游 tunnel_*）。
const OUR_PREFIXES = ["xssh_", "xsftp_", "xtunnel"];
/** 上游（dsh-ssh-ops）用过的前缀：绝不能以裸形式出现在注册名里。 */
const UPSTREAM_BARE = ["ssh_", "sftp_", "tunnel_", "db_", "batch_"];

async function sourceFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { await sourceFiles(full, out); continue; }
    if (/\.(js|jsx|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = await sourceFiles(join(ROOT, "src"));
/** @type {Array<{name: string, file: string, line: number}>} */
const registrations = [];

for (const file of files) {
  const text = await readFile(file, "utf8");
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    // defineTool({ name: "…" }) 是唯一的注册入口（沿用上游约定）
    const m = lines[i].match(/name:\s*"([a-z][a-z0-9_]*)"/);
    if (m === null) continue;
    const name = m[1];
    // 只关心工具注册：工具名一律 snake_case 且带已知前缀
    if (!/^(?:xssh|xsftp|xtunnel|ssh|sftp|tunnel|db|batch)(?:_|$)/.test(name)) continue;
    if (name.includes("_ops_")) continue; // 存储域 id 不是工具
    registrations.push({ name, file: relative(ROOT, file).split(sep).join("/"), line: i + 1 });
  }
}

assert.equal(registrations.length, 13, `应找到 R10 的 13 个入口工具注册（实际 ${registrations.length}）`);

// ── 1. 每个注册名都必须带本项目前缀 ────────────────────────────────────────
{
  const naked = registrations.filter((item) => !OUR_PREFIXES.some((prefix) => item.name.startsWith(prefix)));
  assert.deepEqual(
    naked.map((item) => `${item.name} (${item.file}:${item.line})`),
    [],
    "以下工具名没有本项目前缀，会与上游 dsh-ssh-ops 撞名"
  );
}

// ── 2. 不得出现上游裸前缀的注册名（重复第 1 条但报错更具体）────────────────
{
  const colliding = registrations.filter((item) => UPSTREAM_BARE.some((prefix) => item.name.startsWith(prefix)));
  assert.deepEqual(
    colliding.map((item) => `${item.name} (${item.file}:${item.line})`),
    [],
    "以下工具名与上游同名：两个插件同时安装时会互相覆盖"
  );
}

// ── 3. 同一进程内不得重复注册 ──────────────────────────────────────────────
{
  const seen = new Map();
  const duplicates = [];
  for (const item of registrations) {
    if (seen.has(item.name)) {
      duplicates.push(`${item.name}: ${seen.get(item.name)} ↔ ${item.file}:${item.line}`);
    } else {
      seen.set(item.name, `${item.file}:${item.line}`);
    }
  }
  assert.deepEqual(duplicates, [], "同一插件内重复注册了同名工具");
}

// ── 4. 「加一个 x」的派生规则本身要可验证（防止将来换规则时改名不一致）─────
{
  // 派生函数：给定上游名，本项目名应当是「前缀前插一个 x」
  const derive = (upstreamName) => {
    const [head, ...rest] = upstreamName.split("_");
    return [`x${head}`, ...rest].join("_");
  };
  assert.equal(derive("ssh_list"), "xssh_list");
  assert.equal(derive("sftp_delete"), "xsftp_delete");
  assert.equal(derive("tunnel_start"), "xtunnel_start");
  assert.equal(derive("db_query"), "xdb_query");

  // 实际注册名必须都能用这条规则从上署名推出来（本插件没有自创前缀）
  for (const item of registrations) {
    assert.ok(
      item.name === "xtunnel" || item.name.startsWith("xssh_") || item.name.startsWith("xsftp_") || item.name.startsWith("xtunnel_"),
      `${item.name} 不符合加 x 前缀规则`
    );
  }
}

console.log(`tool namespace: ${registrations.length} tool names all carry the project prefix and no upstream name is reused`);
