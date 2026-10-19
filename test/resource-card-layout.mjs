import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/client/SshResources.jsx", import.meta.url), "utf8");

assert.doesNotMatch(source, /指纹校验：\{HOST_KEY_MODE_LABELS/, "the resource card omits the long host-key mode summary");
assert.doesNotMatch(source, /credentialConfigured \? "凭据已保存"/, "the resource card omits authentication and credential-status summaries");
assert.match(source, /cardActions: \{ display: "flex", flexWrap: "nowrap", flexShrink: 0/, "card actions remain a single non-shrinking row");

// 服务器分组与共享凭据合并进同一个页签（用户 2026-10-18），连接设置与快捷键
// 各自独立；三个页签仍由 segmented 控件切换。
assert.match(source, /className="dsh-xssh-ops-segmented"[^>]*role="tablist"/, "the setup switcher is a segmented control");
assert.match(source, /setupTab === "servers" && \(/, "the servers tab is gated by the switcher");
assert.match(source, /title=\{t\("服务器管理"\)\}/, "the servers tab renders a server-management group");
assert.match(source, /title=\{t\("共享 SSH 凭据"\)\}/, "the servers tab renders a credentials group");
assert.match(source, /aria-selected=\{setupTab === "servers"\}/, "segment selection derives from setupTab, never hard-coded");
assert.match(source, /className="dsh-xssh-ops-segmented-thumb"/, "the selected pill rides a sliding thumb, not a per-segment background");
assert.match(source, /segmented: \{ position: "relative"[\s\S]{0,200}background: "rgba\(127,127,127,/, "the switcher track stays a neutral grey — a layer token resolves to white on the settings surface");
assert.doesNotMatch(source, /styles\.setupGrid/, "the old side-by-side setup grid must not come back");

console.log("resource card layout: concise metadata, single-row actions and setup switcher passed");
