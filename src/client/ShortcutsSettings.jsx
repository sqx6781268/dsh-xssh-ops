/**
 * 设置页「快捷键」（用户 2026-10-18）。
 *
 * 两件事：
 *   1. 命令框发送规则：默认 Enter 发送 / Shift+Enter 换行，可改成别的组合；
 *   2. 可配置快捷键：把已有动作（发送、批量发送、复制、粘贴、添加到对话、
 *      解释、自定义提示词运行……）绑到 1–3 个键上。
 *
 * 动作表与键匹配逻辑在 `shortcut-actions.js`，与终端面板共用一份。
 * 配置存宿主设置表（keepAliveGet/Save），刷新或重启都还在。
 */
import * as React from "react";
import { t } from "../i18n/core.js";
import { SHORTCUT_ACTIONS, shortcutAction, shortcutLabel, keysFromEvent } from "./shortcut-actions.js";
import { SettingsGroup } from "./settings-group.jsx";
const { useCallback, useEffect, useState } = React;

// 鼠标/选择默认值：与 host 的 MOUSE_DEFAULTS 保持一致（host 归一化后总会回传）。
const DEFAULT_MOUSE = {
  middleClickPaste: true,
  rightClick: "menu",
  autoCopySelection: true,
  doubleClickSeparator: "\\ `~!@#$%^&*()-=+[]{}\\|;:'\",.<>/?",
  copyIncludeTrailingNewline: true,
  copyTrimTrailingWhitespace: false,
  copyTabsAsSpaces: false,
  urlLinks: true,
  urlPrefixes: "http:// https:// ftp:// ssh:// telnet://",
  ctrlClickOpenLink: true
};

const styles = {
  root: { display: "flex", flexDirection: "column", gap: 14, minHeight: 0 },
  card: { border: "1px solid var(--dsw-alias-border-l3, #3a414b)", borderRadius: 8, background: "var(--dsw-alias-bg-layer-2, #161b21)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 },
  title: { fontSize: 13, fontWeight: 650, color: "var(--dsw-alias-label-primary, #e6e8eb)" },
  hint: { fontSize: 11, lineHeight: "16px", color: "var(--dsw-alias-label-tertiary, #8b93a1)" },
  row: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  field: { display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--dsw-alias-label-secondary, #b9c0ca)" },
  checkLine: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--dsw-alias-label-secondary, #b9c0ca)" },
  input: { boxSizing: "border-box", minWidth: 180, padding: "6px 8px", borderRadius: 6, fontSize: 12, background: "var(--dsw-alias-bg-layer-1, #101418)", color: "var(--dsw-alias-label-primary, #e6e8eb)", border: "1px solid var(--dsw-alias-border-l3, #3a414b)", outline: "none" },
  capture: { boxSizing: "border-box", minWidth: 200, padding: "6px 8px", borderRadius: 6, fontSize: 12, textAlign: "left", cursor: "pointer", background: "var(--dsw-alias-bg-layer-1, #101418)", color: "var(--dsw-alias-label-primary, #e6e8eb)", border: "1px dashed var(--dsw-alias-border-l3, #3a414b)" },
  primary: { padding: "6px 12px", borderRadius: 7, fontSize: 12, cursor: "pointer", border: "none", background: "var(--dsw-alias-button-primary-fill, #2d6cdf)", color: "var(--dsw-alias-label-primary-foreground, #101418)" },
  secondary: { padding: "5px 10px", borderRadius: 6, fontSize: 12, cursor: "pointer", background: "transparent", color: "var(--dsw-alias-label-primary, #e6e8eb)", border: "1px solid var(--dsw-alias-border-l3, #3a414b)" },
  danger: { padding: "3px 8px", borderRadius: 5, fontSize: 11, cursor: "pointer", background: "transparent", color: "#f07171", border: "1px solid rgba(240,113,113,.45)" },
  list: { display: "flex", flexDirection: "column", gap: 6 },
  item: { display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l4, #2a303a)", background: "var(--dsw-alias-bg-layer-1, #101418)" },
  keys: { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 12, color: "#8fb4e8", minWidth: 130 },
  actionName: { flex: 1, fontSize: 12, color: "var(--dsw-alias-label-primary, #e6e8eb)" },
  notice: { padding: "6px 9px", borderRadius: 6, fontSize: 12, border: "1px solid var(--dsw-alias-border-l3, #3a414b)", background: "var(--dsw-alias-bg-layer-3, #1a1f26)", color: "var(--dsw-alias-label-secondary, #b9c0ca)" },
  error: { padding: "6px 9px", borderRadius: 6, fontSize: 12, border: "1px solid #7a3b3b", background: "rgba(122,59,59,.18)", color: "#f0b4b4" }
};

/** 键捕获按钮：点击后按下 1–3 键组合；Esc 取消、Backspace 清空。 */
function KeyCapture({ keys, onChange, placeholder }) {
  const [listening, setListening] = useState(false);
  return (
    <button
      type="button"
      style={styles.capture}
      onClick={() => setListening(true)}
      onBlur={() => setListening(false)}
      onKeyDown={(event) => {
        if (!listening) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") { setListening(false); return; }
        if (event.key === "Backspace") { onChange([]); setListening(false); return; }
        const combo = keysFromEvent(event);
        if (combo === null) return;
        onChange(combo);
        setListening(false);
      }}
      title={t("点击后按下组合键（1–3 个键）")}
    >
      {listening ? t("按下组合键…（Esc 取消）") : (shortcutLabel(keys) || placeholder || t("点击后按下组合键"))}
    </button>
  );
}

export function ShortcutsSettings({ api }) {
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draftKeys, setDraftKeys] = useState([]);
  const [draftAction, setDraftAction] = useState("copy-selection");
  const [draftPromptId, setDraftPromptId] = useState("");
  // 自定义提示词（用户 2026-10-19）：独立的折叠框，默认折叠。
  const [openPrompts, setOpenPrompts] = useState(false);
  // 快捷键页的其它框也折叠（用户 2026-10-19）：默认全部收起。
  const [openCards, setOpenCards] = useState({ send: false, shortcuts: false, mouse: false });
  const toggleCard = (name) => (open) => setOpenCards((previous) => ({ ...previous, [name]: open }));
  const [promptTitle, setPromptTitle] = useState("");
  const [promptBody, setPromptBody] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let alive = true;
    api.keepAliveGet?.().then((result) => {
      const value = result?.value ?? result;
      if (!alive) return;
      setForm({
        sendRule: value?.sendRule ?? { send: "Enter", newline: "Shift+Enter" },
        shortcuts: Array.isArray(value?.shortcuts) ? value.shortcuts : [],
        mouse: value?.mouse ?? null,
        broadcastHintDismissed: value?.broadcastHintDismissed === true,
        customPrompts: Array.isArray(value?.customPrompts) ? value.customPrompts : []
      });
    }).catch((cause) => { if (alive) setError(cause?.message ?? String(cause)); });
    return () => { alive = false; };
  }, [api]);

  const save = useCallback(async () => {
    if (form === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.keepAliveSave({ sendRule: form.sendRule, shortcuts: form.shortcuts, mouse: form.mouse, customPrompts: form.customPrompts ?? [], broadcastHintDismissed: form.broadcastHintDismissed === true });
      if (result?.ok === false) {
        setError(result.error?.message ?? t("保存失败"));
        return;
      }
      setNotice(t("已保存。快捷键在终端面板里立即生效。"));
      // 面板常驻（设置关闭后不会重挂），用轻量自定义事件让它重新拉一次配置。
      try { globalThis.dispatchEvent?.(new CustomEvent("xssh-shortcuts-changed")); } catch { /* 宿主不支持就算了 */ }
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  }, [api, form, busy]);

  if (form === null) {
    return <div style={styles.root}>{error === null ? <div style={styles.notice}>{t("载入中…")}</div> : <div style={styles.error}>{error}</div>}</div>;
  }

  const patchKeys = (index) => (keys) => {
    setForm((current) => ({
      ...current,
      shortcuts: current.shortcuts.map((item, position) => (position === index ? { ...item, keys } : item))
    }));
    setNotice(null);
  };

  const removeShortcut = (index) => {
    setForm((current) => ({ ...current, shortcuts: current.shortcuts.filter((_, position) => position !== index) }));
    setNotice(null);
  };

  const addShortcut = () => {
    if (draftKeys.length === 0) { setError(t("请先按下一组快捷键")); return; }
    const action = shortcutAction(draftAction);
    if (action?.needsPrompt && draftPromptId === "") {
      setError(t("请先选择一条自定义提示词（或先在「自定义提示词」里创建）。"));
      return;
    }
    setError(null);
    setForm((current) => ({
      ...current,
      shortcuts: [...current.shortcuts, {
        id: (globalThis.crypto?.randomUUID?.() ?? String(Date.now())),
        keys: draftKeys,
        action: draftAction,
        ...(action?.needsPrompt ? { promptId: draftPromptId } : {})
      }]
    }));
    setDraftKeys([]);
    setDraftPromptId("");
    setAdding(false);
    setNotice(null);
  };

  const sendRule = form.sendRule;
  const draftActionDef = shortcutAction(draftAction);
  // 每条自定义提示词自己的快捷键（用户 2026-10-19）：在提示词行上直接绑定，
  // 不必先去快捷键区添加一个动作。
  const shortcutForPrompt = (promptId) => (form.shortcuts ?? []).find((shortcut) => shortcut.action === "custom-prompt" && shortcut.promptId === promptId);
  // 快捷键展示时把 promptId 解析成自定义提示词的标题（旧数据仍回退到内联 prompt）。
  const promptTitleOf = (item) => {
    if (item.promptId) {
      const found = (form.customPrompts ?? []).find((entry) => entry.id === item.promptId);
      if (found) return found.title || found.prompt.slice(0, 20);
    }
    return item.prompt ? item.prompt.slice(0, 20) : "";
  };
  const mouse = form.mouse ?? DEFAULT_MOUSE;
  const setMouse = (key, value) => {
    setForm((current) => ({ ...current, mouse: { ...DEFAULT_MOUSE, ...(current.mouse ?? {}), [key]: value } }));
    setNotice(null);
  };

  return (
    <div style={styles.root}>
      {error !== null && <div style={styles.error}>{error}</div>}
      {notice !== null && <div style={styles.notice}>{notice}</div>}

      <SettingsGroup
        title={t("命令框发送规则")}
        digest={t(`${sendRule.send} 发送 / ${sendRule.newline} 换行`)}
        open={openCards.send}
        onToggle={toggleCard("send")}
      >
        <div style={styles.hint}>{t("默认回车发送、Shift+回车换行；也可以改成别的组合（例如 Ctrl+Enter 发送、Enter 换行）。")}</div>
        <div style={styles.hint}>
          {t("批量发送（命令编辑框右侧「全部连接 / 分组发送」）：把当前编辑框里的命令发送给每个已连接会话，各自记台账；危险命令会被拦截并在面板里等待确认。弹窗里的说明卡片勾选「已知晓，以后不提示」后不再显示，目标为空时仍会说明原因。")}
        </div>
        <label style={{ ...styles.checkLine, marginTop: 8 }}>
          <input
            type="checkbox"
            checked={form.broadcastHintDismissed === true}
            onChange={(event) => { setForm((current) => ({ ...current, broadcastHintDismissed: event.target.checked })); setNotice(null); }}
          />
          {t("批量发送对话框不再显示说明（相当于勾选「已知晓，以后不提示」）")}
        </label>
        <div style={styles.row}>
          <label style={styles.field}>
            <span>{t("发送")}</span>
            <KeyCapture keys={toKeys(sendRule.send)} onChange={(keys) => { setForm((current) => ({ ...current, sendRule: { ...current.sendRule, send: shortcutLabel(keys) } })); setNotice(null); }} />
          </label>
          <label style={styles.field}>
            <span>{t("换行")}</span>
            <KeyCapture keys={toKeys(sendRule.newline)} onChange={(keys) => { setForm((current) => ({ ...current, sendRule: { ...current.sendRule, newline: shortcutLabel(keys) } })); setNotice(null); }} />
          </label>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title={t("快捷键")}
        digest={t(`${form.shortcuts.length} 个`)}
        open={openCards.shortcuts}
        onToggle={toggleCard("shortcuts")}
      >
        <div style={styles.hint}>{t("给发送、批量发送、复制、粘贴、添加到对话、解释、自定义提示词运行等动作绑定快捷键；支持 1–3 个键。")}</div>
        <div style={styles.list}>
          {form.shortcuts.length === 0 && <div style={styles.hint}>{t("还没有自定义快捷键。")}</div>}
          {form.shortcuts.map((item, index) => (
            <div key={item.id ?? index} style={styles.item}>
              <span style={styles.keys}>{shortcutLabel(item.keys)}</span>
              <span style={styles.actionName}>{t(shortcutAction(item.action)?.label ?? item.action)}{item.action === "custom-prompt" ? ` · ${promptTitleOf(item)}` : ""}</span>
              <KeyCapture keys={item.keys} onChange={patchKeys(index)} placeholder={t("重新绑定")} />
              <button type="button" style={styles.danger} onClick={() => removeShortcut(index)}>{t("移除")}</button>
            </div>
          ))}
        </div>
        {!adding ? (
          <div>
            <button type="button" style={styles.secondary} onClick={() => { setAdding(true); setDraftKeys([]); setDraftAction("copy-selection"); setDraftPromptId(""); }}>{t("添加快捷键")}</button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={styles.row}>
              <KeyCapture keys={draftKeys} onChange={setDraftKeys} placeholder={t("按下 1–3 个键")} />
              <select style={styles.input} value={draftAction} onChange={(event) => setDraftAction(event.target.value)}>
                {SHORTCUT_ACTIONS.map((item) => <option key={item.id} value={item.id}>{t(item.label)}</option>)}
              </select>
              <button type="button" style={styles.primary} disabled={draftKeys.length === 0} onClick={addShortcut}>{t("添加")}</button>
              <button type="button" style={styles.secondary} onClick={() => setAdding(false)}>{t("取消")}</button>
            </div>
            {draftActionDef?.needsPrompt && (
              <label style={styles.field}>
                <span>{t("提示词")}</span>
                <select style={styles.input} value={draftPromptId} onChange={(event) => setDraftPromptId(event.target.value)}>
                  <option value="">{t("选择一条自定义提示词")}</option>
                  {(form.customPrompts ?? []).map((item) => (
                    <option key={item.id} value={item.id}>{item.title || item.prompt.slice(0, 30)}</option>
                  ))}
                </select>
                {(form.customPrompts ?? []).length === 0 && (
                  <small style={styles.hint}>{t("还没有自定义提示词，先在下方「自定义提示词」折叠框里创建。")}</small>
                )}
              </label>
            )}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        title={t("自定义提示词")}
        digest={t(`${(form.customPrompts ?? []).length} 条`)}
        open={openPrompts}
        onToggle={setOpenPrompts}
      >
        <div style={styles.hint}>{t("预设提示词，可在终端选区右键菜单里直接调用；用 {selection} 表示框选内容，不写则自动附在末尾。")}</div>
        <div style={styles.list}>
          {(form.customPrompts ?? []).length === 0 && <div style={styles.hint}>{t("还没有自定义提示词。")}</div>}
          {(form.customPrompts ?? []).map((item, index) => (
            <div key={item.id ?? index} style={styles.item}>
              <span style={styles.actionName}>{item.title || t("未命名")}</span>
              <span
                style={{ ...styles.hint, flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={item.prompt}
              >{item.prompt}</span>
              <KeyCapture
                keys={shortcutForPrompt(item.id)?.keys ?? []}
                onChange={(keys) => {
                  setForm((current) => {
                    const others = current.shortcuts.filter((shortcut) => !(shortcut.action === "custom-prompt" && shortcut.promptId === item.id));
                    if (keys.length === 0) return { ...current, shortcuts: others };
                    return {
                      ...current,
                      shortcuts: [...others, {
                        id: shortcutForPrompt(item.id)?.id ?? (globalThis.crypto?.randomUUID?.() ?? String(Date.now())),
                        keys,
                        action: "custom-prompt",
                        promptId: item.id
                      }]
                    };
                  });
                  setNotice(null);
                }}
                placeholder={t("绑定快捷键")}
              />
              <button
                type="button"
                style={styles.danger}
                onClick={() => {
                  setForm((current) => ({
                    ...current,
                    customPrompts: (current.customPrompts ?? []).filter((_, position) => position !== index)
                  }));
                  setNotice(null);
                }}
              >{t("移除")}</button>
            </div>
          ))}
        </div>
        <label style={styles.field}>
          <span>{t("标题")}</span>
          <input style={styles.input} value={promptTitle} onChange={(event) => setPromptTitle(event.target.value)} placeholder={t("例如：解释异常")} />
        </label>
        <label style={styles.field}>
          <span>{t("提示词（用 {selection} 表示框选内容）")}</span>
          <textarea
            rows={3}
            value={promptBody}
            onChange={(event) => setPromptBody(event.target.value)}
            placeholder={t("例如：请分析这段输出，指出异常：\n{selection}")}
            style={{ ...styles.input, width: "100%", resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" }}
          />
        </label>
        <div>
          <button
            type="button"
            style={styles.secondary}
            disabled={promptBody.trim() === ""}
            onClick={() => {
              setForm((current) => ({
                ...current,
                customPrompts: [...(current.customPrompts ?? []), {
                  id: (globalThis.crypto?.randomUUID?.() ?? String(Date.now())),
                  title: promptTitle.trim(),
                  prompt: promptBody.trim()
                }]
              }));
              setPromptTitle("");
              setPromptBody("");
              setNotice(null);
            }}
          >{t("添加提示词")}</button>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title={t("鼠标与选择")}
        digest={mouse.autoCopySelection ? t("自动复制开") : t("自动复制关")}
        open={openCards.mouse}
        onToggle={toggleCard("mouse")}
      >
        <div style={styles.hint}>{t("参照 Windows Terminal 的「鼠标 / 选择」页；框选内容自动复制到剪贴板默认开启。")}</div>
        <div style={styles.row}>
          <label style={styles.checkLine}><input type="checkbox" checked={mouse.autoCopySelection} onChange={(event) => setMouse("autoCopySelection", event.target.checked)} />{t("将选定的文本自动复制到剪贴板")}</label>
          <label style={styles.checkLine}><input type="checkbox" checked={mouse.copyIncludeTrailingNewline} onChange={(event) => setMouse("copyIncludeTrailingNewline", event.target.checked)} />{t("复制时包含最后一个换行符")}</label>
        </div>
        <div style={styles.row}>
          <label style={styles.checkLine}><input type="checkbox" checked={mouse.copyTrimTrailingWhitespace} onChange={(event) => setMouse("copyTrimTrailingWhitespace", event.target.checked)} />{t("复制时删除行尾空白")}</label>
          <label style={styles.checkLine}><input type="checkbox" checked={mouse.copyTabsAsSpaces} onChange={(event) => setMouse("copyTabsAsSpaces", event.target.checked)} />{t("复制时把制表符转为空格")}</label>
        </div>
        <div style={styles.row}>
          <label style={styles.checkLine}><input type="checkbox" checked={mouse.middleClickPaste} onChange={(event) => setMouse("middleClickPaste", event.target.checked)} />{t("鼠标中键粘贴剪贴板内容")}</label>
          <label style={styles.field}>
            <span>{t("右键")}</span>
            <select style={styles.input} value={mouse.rightClick} onChange={(event) => setMouse("rightClick", event.target.value)}>
              <option value="menu">{t("打开弹出式菜单")}</option>
              <option value="paste">{t("粘贴")}</option>
              <option value="none">{t("不处理")}</option>
            </select>
          </label>
        </div>
        <label style={styles.field}>
          <span>{t("双击选择时使用的分隔符")}</span>
          <input style={styles.input} value={mouse.doubleClickSeparator} onChange={(event) => setMouse("doubleClickSeparator", event.target.value)} />
        </label>
        <div style={styles.row}>
          <label style={styles.checkLine}><input type="checkbox" checked={mouse.urlLinks} onChange={(event) => setMouse("urlLinks", event.target.checked)} />{t("识别 URL 超链接")}</label>
          <label style={styles.checkLine}><input type="checkbox" checked={mouse.ctrlClickOpenLink} onChange={(event) => setMouse("ctrlClickOpenLink", event.target.checked)} />{t("[Ctrl + 单击] 打开超链接")}</label>
        </div>
        <label style={styles.field}>
          <span>{t("URL 前缀（空格分隔）")}</span>
          <input style={styles.input} value={mouse.urlPrefixes} onChange={(event) => setMouse("urlPrefixes", event.target.value)} />
        </label>
      </SettingsGroup>

      <div style={styles.row}>
        <button type="button" style={styles.primary} disabled={busy} onClick={() => void save()}>{busy ? t("保存中…") : t("保存")}</button>
      </div>
    </div>
  );
}

/** 字符串组合转 keys 数组（"Enter" → ["Enter"]）。 */
function toKeys(text) {
  const value = String(text ?? "").trim();
  return value === "" ? [] : value.split("+").map((part) => part.trim()).filter((part) => part !== "");
}
