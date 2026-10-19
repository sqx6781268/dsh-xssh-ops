// 注入按钮的标记一致性（回归护栏）。
//
// 曾经的线上 bug：改名后选择器是 `[data-dsh-xssh-ops-tab="true"]`，而建按钮时用的是
// 上游遗留的 `button.dataset.dshSshOpsTab`（浏览器转成 `data-dsh-ssh-ops-tab`）——
// 两者不匹配，于是每次 MutationObserver 扫描都找不到刚插入的按钮，**无限重复插入**，
// 标签条被刷成几十个 SSH。改名脚本漏掉它的原因：`\b` 词边界在 `dshSshOpsTab` 里
// 因前面紧贴字母 `h` 而不成立，所以 camelCase 的 dataset 名没被替换。
//
// 这个测试直接读源码，确保「属性名派生」与「选择器」来自同一处且结果正确。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/client/index.jsx", import.meta.url), "utf8");

// ── 必须只有一个真源：选择器由 dataset 键派生 ──────────────────────────────
{
  assert.match(source, /const SSH_TAB_DATASET_KEY = "dshXsshOpsTab"/,
    "dataset 键必须是 dshXsshOpsTab（派生后得到 data-dsh-xssh-ops-tab）");
  assert.match(source, /const SSH_TAB_ATTR = `data-\$\{SSH_TAB_DATASET_KEY\.replace/,
    "属性名必须由 SSH_TAB_DATASET_KEY 派生，不能手写第二份字面量");
  assert.match(source, /const SSH_TAB_SELECTOR = `\[\$\{SSH_TAB_ATTR\}="true"\]`/,
    "选择器必须由 SSH_TAB_ATTR 派生");
}

// ── 上游遗留的 camelCase 名字不得再出现（它们与选择器不匹配）───────────────
{
  for (const stale of ["dshSshOpsTab", "dshSshOpsActiveClass"]) {
    assert.equal(source.includes(stale), false,
      `残留的上游 dataset 名 ${stale} 会让选择器失配并导致按钮被无限重复插入`);
  }
}

// ── 建按钮与读按钮都必须走常量，不得再出现 dataset.<字面量> 的写法 ──────────
{
  assert.match(source, /button\.dataset\[SSH_TAB_DATASET_KEY\] = "true"/, "建按钮用常量");
  assert.match(source, /button\.dataset\[SSH_TAB_ACTIVE_CLASS_KEY\]/, "读高亮类名用常量");
  assert.equal(/\.dataset\.\w+\s*=/.test(source), false,
    "不得再用 dataset.<字面量> 赋值（字面量与选择器容易漂移）");
}

// ── 派生结果必须真的是 data-dsh-xssh-ops-tab（与产物/浏览器行为一致） ──────
{
  const key = "dshXsshOpsTab";
  const attr = `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  assert.equal(attr, "data-dsh-xssh-ops-tab");
  assert.equal(`[${attr}="true"]`, '[data-dsh-xssh-ops-tab="true"]');
}

// ── 源码里的自检必须存在（写错常量时构建期就炸） ──────────────────────────
{
  assert.match(source, /SSH_TAB_ATTR !== "data-dsh-xssh-ops-tab"/, "保留派生自检");
}

console.log("tab injection marker: selector and dataset key share one source, no stale camelCase remains");
