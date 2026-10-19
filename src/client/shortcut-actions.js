/**
 * 可配置快捷键的动作表与键组合工具（用户 2026-10-18）。
 *
 * 设置页「快捷键」与终端面板共用这一份：动作 id 是持久化标识，label 只在
 * 显示时经 t()；键名统一成 `Ctrl/Alt/Shift/Meta + 主键` 的顺序，存进设置的
 * `keys` 数组就是同一个规范，匹配时按数组逐项比较。
 */

/** 动作表：id 稳定（存盘），label 用于下拉与列表。needsPrompt 的动作需要提示词。 */
// label 是稳定标识（显示时才经 t()），整段标 i18n-identifier。
// i18n-identifier-start
export const SHORTCUT_ACTIONS = [
  { id: "broadcast-all", label: "全部连接发送" },
  { id: "broadcast-group", label: "分组发送" },
  { id: "copy-selection", label: "复制选中内容" },
  { id: "paste", label: "粘贴" },
  { id: "add-to-chat", label: "添加到对话" },
  { id: "explain", label: "解释选中内容" },
  { id: "copy-to-editor", label: "复制到编辑框" },
  { id: "select-all", label: "全选终端内容" },
  { id: "focus-editor", label: "聚焦命令框" },
  { id: "custom-prompt", label: "自定义提示词运行", needsPrompt: true }
];
// i18n-identifier-end

/** 动作 id → 定义。 */
export function shortcutAction(id) {
  return SHORTCUT_ACTIONS.find((item) => item.id === id) ?? null;
}

/** 修饰键的规范顺序：保存与匹配都用它。 */
export const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"];

/** 组合键的显示文本（`Ctrl+Shift+K`）。 */
export function shortcutLabel(keys) {
  return Array.isArray(keys) && keys.length > 0 ? keys.join("+") : "";
}

/** 把 "Ctrl+Shift+K" 解析成 ["Ctrl","Shift","K"]；空串返回 []。 */
export function parseShortcut(text) {
  const value = String(text ?? "").trim();
  if (value === "") return [];
  return value.split("+").map((part) => part.trim()).filter((part) => part !== "");
}

/**
 * 从键盘事件取出规范组合（最多 3 键）。纯修饰键按下返回 null，
 * 表示"还在按修饰键"，不构成一次完整组合。
 */
export function keysFromEvent(event) {
  const modifierKeys = ["Control", "Alt", "Shift", "Meta"];
  const combo = [];
  if (event.ctrlKey) combo.push("Ctrl");
  if (event.altKey) combo.push("Alt");
  if (event.shiftKey) combo.push("Shift");
  if (event.metaKey) combo.push("Meta");
  if (modifierKeys.includes(event.key)) return null;
  const key = normalizeEventKey(event.key);
  if (key === null) return null;
  combo.push(key);
  return combo.slice(0, 3);
}

/** 事件是否匹配一组键（顺序、大小写都不敏感地按规范比较）。 */
export function matchesShortcut(event, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return false;
  const combo = keysFromEvent(event);
  if (combo === null) return false;
  if (combo.length !== keys.length) return false;
  return combo.every((key, index) => key.toLowerCase() === String(keys[index]).toLowerCase());
}

function normalizeEventKey(raw) {
  if (raw === " " || raw === "Spacebar") return "Space";
  if (raw === "ArrowUp" || raw === "ArrowDown" || raw === "ArrowLeft" || raw === "ArrowRight") return raw.replace("Arrow", "");
  if (raw.length === 1) return raw.toUpperCase();
  return raw;
}
