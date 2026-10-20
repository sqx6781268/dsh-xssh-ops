// Prompt cwd parsing: the root-cause cases behind "no such file in <dir>"
// (user 2026-10-20). Two real bugs this guards:
//   1. OSC title sequences (`ESC ] 0 ; user@host:~/p BEL`) leaked into the path,
//      producing "~/p user@host:~/p". Any shell that sets a window title hits it.
//   2. `~` was expanded to the hard-coded /root, wrong for non-root users.
import assert from "node:assert/strict";
import { expandHome, parsePromptCwd, stripTerminalControl } from "../src/client/prompt-cwd.js";

const ESC = "\u001b";
const BEL = "\u0007";

// ── 控制序列剥离 ───────────────────────────────────────────────────────────
{
  const withOsc = `before${ESC}]0;root@host:~/sda5/00temp/temp${BEL}after`;
  assert.equal(stripTerminalControl(withOsc), "beforeafter", "OSC title stripped");
  const withSt = `x${ESC}]2;title${ESC}\\y`;
  assert.equal(stripTerminalControl(withSt), "xy", "OSC with ST terminator stripped");
  const withCsi = `a${ESC}[1;32mgreen${ESC}[0mb`;
  assert.equal(stripTerminalControl(withCsi), "agreenb", "CSI colors stripped");
}

// ── 典型提示符 ────────────────────────────────────────────────────────────
assert.equal(parsePromptCwd("root@iStoreOS:~# "), "~");
assert.equal(parsePromptCwd("root@iStoreOS:~/sda5/00temp/temp# "), "~/sda5/00temp/temp");
assert.equal(parsePromptCwd("me@box:/var/log$ "), "/var/log");
assert.equal(parsePromptCwd("me@box:/# "), "/", "prompt at filesystem root");

// ── 回归：带 OSC 标题的提示符（之前会解析成脏路径）────────────────────────
{
  const dirty = `${ESC}]0;root@iStoreOS:~/sda5/00temp/temp${BEL}root@iStoreOS:~/sda5/00temp/temp# `;
  const parsed = parsePromptCwd(dirty);
  assert.equal(parsed, "~/sda5/00temp/temp", "OSC title must not leak into the path");
  assert.ok(!parsed.includes("@"), "no host text in the parsed path");
  assert.ok(!parsed.includes("root@"), "no second prompt in the parsed path");
}

// ── 多行：只看最后一个提示符 ──────────────────────────────────────────────
assert.equal(
  parsePromptCwd(`me@box:/old# \r\nme@box:/new# `),
  "/new",
  "the last prompt wins"
);

// ── 不可信输入一律 fail-closed ─────────────────────────────────────────────
for (const bad of [
  "",
  "no prompt here",
  "me@box:relative/path# ",        // 相对路径不解析
  "me@box:/a b# ",                 // 路径里有空格 → 不可信
  "me@box:/a@b# ",                 // 路径里有 @ → 不可信
  "me@box:~user/x# "               // ~user 形态不支持
]) {
  assert.equal(parsePromptCwd(bad), null, `expected null: ${JSON.stringify(bad)}`);
}
assert.equal(parsePromptCwd(null), null);
assert.equal(parsePromptCwd(undefined), null);

// ── home 展开：不再假设 /root ─────────────────────────────────────────────
assert.equal(expandHome("~", "/root"), "/root");
assert.equal(expandHome("~/a/b", "/root"), "/root/a/b");
assert.equal(expandHome("~", "/home/me"), "/home/me", "non-root home");
assert.equal(expandHome("~/x", "/home/me"), "/home/me/x");
assert.equal(expandHome("~", "/"), "/", "home at filesystem root");
assert.equal(expandHome("~/x", "/"), "/x");
assert.equal(expandHome("/abs/path", "/root"), "/abs/path", "absolute path untouched");
assert.equal(expandHome("~", null), null, "unknown home must not guess");
assert.equal(expandHome("~/x", ""), null);

console.log("prompt-cwd: OSC stripping, prompt parsing, fail-closed inputs and home expansion all hold");
