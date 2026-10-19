// 插件显示名与语言探测（回归护栏）。
//
// 两条不变式，都是踩过坑才立的：
//   1. **同一个插件在不同入口必须同名**。插件页显示的是 `locale/*.json` 的
//      `meta.title`，而侧栏标签 / 设置页段名 / 引导页标题走 `ctx.locale.register` 的
//      host 词条 —— 两处分开维护，很容易一个改了另一个忘。
//   2. **语言探测不能依赖任何会被改名的显示文案**。此前 `locale.js` 用
//      `sidebarTabTitle` 的值（"SSH Terminal" / "SSH 终端"）做探测，把标签改名成
//      "XSSH Terminal" 后探测立刻失效 → 宿主语言判断退化。现在探测走专用键
//      `languageProbe`，它只取值 "zh"/"en" 且从不显示。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const zh = JSON.parse(await readFile(new URL("locale/zh.json", ROOT), "utf8"));
const en = JSON.parse(await readFile(new URL("locale/en.json", ROOT), "utf8"));
const index = await readFile(new URL("src/client/index.jsx", ROOT), "utf8");
const locale = await readFile(new URL("src/client/locale.js", ROOT), "utf8");

// ── 1. 插件页名称是用户指定的「XSSH 工具」 ────────────────────────────────
{
  assert.equal(zh.meta.title, "XSSH 工具", "中文插件名");
  assert.equal(en.meta.title, "XSSH Tools", "英文插件名");
  assert.equal(zh.meta.description, "从 dsh-ssh-ops 改进而来。", "中文说明");
  assert.equal(en.meta.description, "Improved from dsh-ssh-ops.", "英文说明");
}

// ── 2. 设置页段名与插件页名称一致（用户明确要求同名）────────────────────
{
  assert.match(index, /settingsSectionLabel: "XSSH 工具"/, "中文段名应与插件名一致");
  assert.match(index, /settingsSectionLabel: "XSSH Tools"/, "英文段名应与插件名一致");
  // 引导页标题也一致
  assert.match(index, /guideTitle: "XSSH 工具"/, "引导页标题应一致");
  assert.match(index, /guideTitle: "XSSH Tools"/, "引导页标题应一致（英文）");
}

// ── 3. 说明文案里的「来源」也要在 host 词条里一致 ──────────────────────────
{
  assert.match(index, /guideDescription: "从 dsh-ssh-ops 改进而来。"/, "中文说明一致");
  assert.match(index, /guideDescription: "Improved from dsh-ssh-ops."/, "英文说明一致");
}

// ── 4. 语言探测必须走专用键，不得依赖任何显示文案 ─────────────────────────
{
  assert.match(locale, /translate\("languageProbe"\)/, "语言探测必须用 languageProbe");
  // 只看「实际执行的代码行」，忽略注释（注释里可以说明历史原因）。
  const codeLines = locale
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
    });
  const code = codeLines.join("\n");
  for (const displayOnly of ["sidebarTabTitle", "settingsSectionLabel", "guideTitle", "SSH Terminal", "SSH 终端"]) {
    assert.equal(code.includes(displayOnly), false,
      `探测代码不得引用显示文案 ${displayOnly}（改名会连带破坏语言判断）`);
  }
  assert.match(index, /languageProbe: "zh"/, "host 词条要提供 languageProbe");
  assert.match(index, /languageProbe: "en"/, "host 词条要提供 languageProbe（英文）");
}

// ── 5. 不存在指向旧段名的路径引用（用户可见文案会指向不存在的菜单项）──────
{
  const files = {
    "src/client/SshPanel.jsx": await readFile(new URL("src/client/SshPanel.jsx", ROOT), "utf8"),
    "src/agent-connect.js": await readFile(new URL("src/agent-connect.js", ROOT), "utf8"),
    "src/tools/ssh-session.js": await readFile(new URL("src/tools/ssh-session.js", ROOT), "utf8")
  };
  for (const [name, text] of Object.entries(files)) {
    assert.equal(text.includes("设置 → SSH 资源"), false, `${name} 仍指向旧段名「SSH 资源」`);
  }
  assert.match(files["src/client/SshPanel.jsx"], /设置 → XSSH 工具/, "重连提示应指向新段名");
}

// ── 6. 会话顶部标签条那个按钮的文字必须来自词条，不得硬编码 ───────────────
//
// 踩过的坑：按钮文字是 `button.textContent = "SSH"` 硬编码，插件改名后标签仍写
// SSH。而且它原来只在「创建按钮」时赋值一次，宿主语言切换不会更新 —— 现在改为
// 每次 mount 同步 + 一个随 label 变化的 effect。
{
  assert.equal(index.includes('button.textContent = "SSH"'), false,
    "标签按钮文字不得硬编码 \"SSH\"");
  assert.match(index, /sidebarTabLabel: "XSSH"/, "要提供短标签词条");
  assert.match(index, /label: hostT\("sidebarTabLabel"\)/, "按钮要拿到该词条");
  assert.match(index, /button\.textContent !== label/, "已存在的按钮也要同步文字（语言切换后要跟着变）");
}

console.log("plugin identity: locale meta and host entries agree, language probe is decoupled from display text, tab label is localized");
