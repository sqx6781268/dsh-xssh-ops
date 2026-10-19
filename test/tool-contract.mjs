/**
 * 工具层 ↔ 服务层契约（回归用）。
 *
 * 背景：上游 fork 时 xssh_connection 的工具还调用 service.listConnections()，
 * 而服务实现是 async list()，导致该工具必定报 “service.listConnections is not a
 * function”（用户 2026-10-19 在另一台 DSH 安装后实测）。这类“方法名对不上”的
 * 缺陷编译期发现不了，所以这里把两边的名字做一次全量比对。
 */
import assert from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serviceSource = await readFile(resolve(rootDir, "src/index.js"), "utf8");
const serviceMethods = new Set(
  [...serviceSource.matchAll(/^ {2}(?:async )?([a-zA-Z_]\w*)\(/gm)].map((match) => match[1])
);

const toolDir = resolve(rootDir, "src/tools");
const files = (await readdir(toolDir)).filter((name) => name.endsWith(".js"));
assert.ok(files.length > 0, "src/tools should contain tool modules");

const problems = [];
for (const name of files) {
  const body = await readFile(resolve(toolDir, name), "utf8");
  for (const match of body.matchAll(/service\.([a-zA-Z_]\w*)\(/g)) {
    const method = match[1];
    if (!serviceMethods.has(method)) problems.push(`src/tools/${name}: service.${method}() has no implementation in src/index.js`);
  }
}

assert.deepEqual(problems, [], `tool calls must exist on the service:\n${problems.join("\n")}`);
assert.ok(serviceMethods.has("list"), "service.list() must stay the connection listing entry point");
console.log(`tool-service contract: ${files.length} tool modules, ${serviceMethods.size} service methods, all calls resolved`);
