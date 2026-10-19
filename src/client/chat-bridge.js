/**
 * 把文本送进 DSH 对话输入框（终端右键「添加到对话 / 解释」用，用户 2026-10-18）。
 *
 * DSH 的 composer 是 Lexical 的 contenteditable：优先派发 paste 事件（Lexical 的
 * paste 处理会解析 clipboardData），不可用时退回 `document.execCommand("insertText")`。
 * 两条路径都不依赖宿主未公开的内部 store，页面刷新后依然成立。
 *
 * 返回 `true` 表示输入框里已经出现该文本（用于提示「已添加到对话」或回退到复制）。
 */
export function insertIntoComposer(text) {
  const value = String(text ?? "");
  if (value === "") return false;
  const el = findComposer();
  if (el === null) return false;
  el.focus();
  try {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    if (composerContains(el, value)) return true;
  } catch { /* fall through to execCommand */ }
  try {
    document.execCommand("insertText", false, value);
    return composerContains(el, value);
  } catch {
    return false;
  }
}

/** 找到当前可见、最靠下的聊天输入框（设置弹窗等其它输入框都被排除）。 */
function findComposer() {
  const nodes = [...document.querySelectorAll('[contenteditable="true"], textarea')];
  const visible = nodes.filter((el) => {
    if (el.disabled === true || el.readOnly === true) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 200 || rect.height < 20) return false;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  });
  visible.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
  return visible[0] ?? null;
}

function composerContains(el, text) {
  const probe = text.slice(0, 24);
  return el.textContent?.includes(probe) === true || el.value?.includes(probe) === true;
}
