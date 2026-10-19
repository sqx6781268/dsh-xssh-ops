/**
 * 连接设置分组（R8 保持活动状态 / R9 登录脚本，计划 5.8 / M3.5）
 *
 * 风格照 dsh-ssh-ops 的设置页（`$UPSTREAM/src/client/SshResources.jsx:904-945`）：
 * DSH 设计令牌、`Field` 结构（label 上 / hint 中 / 控件下）、`formGrid` 多列。
 *
 * **同类设置项折叠**：用原生 `<details>` / `<summary>`（用户 2026-10-17 决策，
 * 原型截图 06–09 已验证），标题右侧带**状态摘要** —— 收起时也能看到当前值，
 * 否则折叠就变成「藏起来」而不是「收起来」。
 *
 * 两个必须守住的约束：
 *   1. **深色主题下 primary 按钮是浅填充 + 深文字**：不能硬编码 `#fff` 前景，
 *      用 `--dsw-alias-label-primary-foreground` 令牌（上游源码明确警告过这点）。
 *   2. **①的间隔改动需要重连才生效**：保存后必须显式提示，否则用户会以为没保存上。
 */
import * as React from "react";
import { t } from "../i18n/core.js";
import { SettingsGroup } from "./settings-group.jsx";
const { useCallback, useEffect, useRef, useState } = React;

// 与 host OUTPUT_LOG_DEFAULTS 保持一致（缺失时兜底显示）。
const OUT_WARN_DEFAULT_KB = 256;
const OUT_LOG_MAX_TOTAL_MB_DEFAULT = 500;
const OUT_LOG_MAX_AGE_DAYS_DEFAULT = 30;

// 匹配方式的显示名。约定：键是稳定标识（与 host 侧 `expectMatchMode` 取值一致），
// 显示时才经 t()，所以整段标 i18n-identifier（同 CommandLedger 的状态表写法）。
// i18n-identifier-start
const MATCH_MODE_LABELS = { substring: "子串", glob: "通配", regex: "正则" };
// i18n-identifier-end

/** DSH 令牌优先，回退值只保证 DSH 之外也能渲染（不给死颜色）。 */
const styles = {
  root: { display: "flex", flexDirection: "column", gap: 10 },
  layerCard: { display: "flex", flexDirection: "column", gap: 4, padding: "8px 10px", marginTop: 8, borderRadius: 8, border: "1px solid var(--dsw-alias-border-l3, #3a414b)", background: "rgba(127,127,127,.06)" },
  layerThumb: { width: 42, height: 28, objectFit: "cover", borderRadius: 4, border: "1px solid rgba(127,127,127,.3)" },
  iconButton: { width: 22, height: 22, padding: 0, borderRadius: 4, border: "1px solid var(--dsw-alias-border-l3, #3a414b)", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 12 },
  group: { border: "1px solid var(--dsw-alias-border-l3, #3a414b)", borderRadius: 8, background: "var(--dsw-alias-bg-layer-2, #161b21)", overflow: "hidden" },
  summary: { display: "flex", alignItems: "center", gap: 8, padding: "9px 11px", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary, #e6e8eb)", listStyle: "none", userSelect: "none" },
  summaryText: { flex: 1, minWidth: 0 },
  digest: { flex: "none", fontSize: 11, fontWeight: 400, color: "var(--dsw-alias-label-tertiary, #8b93a1)", maxWidth: "55%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  body: { padding: "2px 11px 12px", borderTop: "1px solid var(--dsw-alias-border-l4, #1f242c)" },
  formGrid: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, marginTop: 10 },
  formGridWide: { display: "grid", gridTemplateColumns: "1fr", gap: 10, marginTop: 10 },
  field: { display: "flex", flexDirection: "column", gap: 5, minWidth: 0, fontSize: 13, color: "var(--dsw-alias-label-secondary, #b9c0ca)" },
  hint: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #8b93a1)", lineHeight: "15px" },
  input: { boxSizing: "border-box", width: "100%", padding: "7px 8px", borderRadius: 7, fontSize: 13, background: "var(--dsw-alias-bg-layer-1, #101418)", color: "var(--dsw-alias-label-primary, #e6e8eb)", border: "1px solid var(--dsw-alias-border-l3, #3a414b)", outline: "none" },
  // 未勾选的分组项要「置灰」：原型截图 07/08 里已验证的观感。
  disabled: { opacity: 0.45 },
  check: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--dsw-alias-label-secondary, #b9c0ca)" },
  actions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 },
  primary: { padding: "6px 12px", borderRadius: 7, fontSize: 13, cursor: "pointer", border: "none", background: "var(--dsw-alias-button-primary-fill, #2d6cdf)", color: "var(--dsw-alias-label-primary-foreground, #101418)" },
  secondary: { padding: "6px 12px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: "transparent", color: "var(--dsw-alias-label-primary, #e6e8eb)", border: "1px solid var(--dsw-alias-border-l3, #3a414b)" },
  notice: { marginTop: 10, padding: "6px 9px", borderRadius: 6, fontSize: 12, border: "1px solid var(--dsw-alias-border-l3, #3a414b)", background: "var(--dsw-alias-bg-layer-3, #1a1f26)", color: "var(--dsw-alias-label-secondary, #b9c0ca)" },
  warn: { borderColor: "#7a5a2a", background: "rgba(122,90,42,.16)", color: "#e8d08a" },
  error: { borderColor: "#7a3b3b", background: "rgba(122,59,59,.18)", color: "#f0b4b4" },
  checkLine: { display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12, color: "var(--dsw-alias-label-secondary, #b9c0ca)", lineHeight: "17px" },
  ruleRow: { display: "grid", gridTemplateColumns: "1fr 1fr 84px 108px", gap: 6, alignItems: "center", marginTop: 8 },
  ruleHead: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #8b93a1)" },
  iconBtn: { padding: "3px 7px", borderRadius: 5, fontSize: 12, cursor: "pointer", background: "transparent", color: "var(--dsw-alias-label-secondary, #b9c0ca)", border: "1px solid var(--dsw-alias-border-l3, #3a414b)" },
  iconBtnDisabled: { opacity: 0.35, cursor: "default" }
};


/**
 * 登录脚本规则表（R9①）。
 * **数组顺序即执行顺序** —— 上移/下移直接改下标，不做「优先级」字段，避免两处状态。
 */
export function RuleTable({ rules, mode, onChange }) {
  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= rules.length) return;
    const next = [...rules];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const patch = (index, field, value) => {
    const next = rules.map((rule, position) => (position === index ? { ...rule, [field]: value } : rule));
    onChange(next);
  };

  return (
    <div>
      <div style={{ ...styles.ruleRow, marginTop: 10 }}>
        <span style={styles.ruleHead}>{t("等待匹配（Expect）")}</span>
        <span style={styles.ruleHead}>{t("发送（Send）")}</span>
        <span style={styles.ruleHead}>{t("超时 ms")}</span>
        <span style={styles.ruleHead}>{t("操作")}</span>
      </div>
      {rules.length === 0 && <div style={{ ...styles.hint, marginTop: 8 }}>{t("还没有规则。点「添加规则」新建一条；规则按从上到下的顺序执行。")}</div>}
      {rules.map((rule, index) => (
        <div key={`rule-${index}`} style={styles.ruleRow}>
          <input style={styles.input} value={rule.expect ?? ""} onChange={(event) => patch(index, "expect", event.target.value)} placeholder={t("例如 password:")} />
          <input style={styles.input} value={rule.send ?? ""} onChange={(event) => patch(index, "send", event.target.value)} placeholder={t("要发送的内容")} />
          <input
            style={styles.input}
            value={rule.timeoutMs === undefined ? "" : String(rule.timeoutMs)}
            onChange={(event) => {
              const raw = event.target.value.replace(/[^0-9]/g, "");
              patch(index, "timeoutMs", raw === "" ? undefined : Number(raw));
            }}
            placeholder={t("默认")}
          />
          <span style={{ display: "flex", gap: 4 }}>
            <button type="button" style={index === 0 ? { ...styles.iconBtn, ...styles.iconBtnDisabled } : styles.iconBtn} disabled={index === 0} onClick={() => move(index, -1)} title={t("上移")} aria-label={t("上移")}>↑</button>
            <button type="button" style={index === rules.length - 1 ? { ...styles.iconBtn, ...styles.iconBtnDisabled } : styles.iconBtn} disabled={index === rules.length - 1} onClick={() => move(index, 1)} title={t("下移")} aria-label={t("下移")}>↓</button>
            <button type="button" style={{ ...styles.iconBtn, color: "#f07171" }} onClick={() => onChange(rules.filter((_, position) => position !== index))} title={t("删除")} aria-label={t("删除")}>×</button>
          </span>
        </div>
      ))}
      <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
        <button type="button" style={styles.secondary} onClick={() => onChange([...rules, { expect: "", send: "" }])}>{t("添加规则")}</button>
        <span style={styles.hint}>{t(`匹配方式：${MATCH_MODE_LABELS[mode] ?? mode}（在高级分组里改）`)}</span>
      </div>
    </div>
  );
}

export function KeepAliveSettings({ api, connectionId = undefined }) {
  const [form, setForm] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState(null);
  // 默认全部收起（用户 2026-10-18 要求：连接设置里的所有配置块默认折叠）。
  const [proxyDraft, setProxyDraft] = useState({ name: "", host: "", port: "1080", username: "", password: "" });
  // 代理库条目的编辑态（用户 2026-10-18：保存后密码只显示占位符，只能在编辑里改；
  // 规则沿用 SSH 服务器密码——留空保持不变、可显式清除）。
  const [editingProxyId, setEditingProxyId] = useState(null);
  const [clearProxyPassword, setClearProxyPassword] = useState(false);
  const [openGroups, setOpenGroups] = useState({ keepalive: false, idle: false, tcp: false, loginScript: false, proxy: false, background: false, output: false });
  const bgInputRef = useRef(null);

  const toggleGroup = useCallback((name) => (open) => {
    setOpenGroups((previous) => ({ ...previous, [name]: open }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await api.keepAliveGet();
        if (cancelled) return;
        if (result?.ok === false) { setError(result.error?.message ?? t("读取保活设置失败")); return; }
        setForm(result?.value ?? result);
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(cause?.message ?? String(cause));
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  /** 改一个字段：保留「只发改动项」的语义（host 侧白名单会忽略未知键）。 */
  const set = useCallback((key, value) => {
    setForm((previous) => ({ ...previous, [key]: value }));
    setDirty(true);
    setNotice(null);
  }, []);

  const save = useCallback(async () => {
    if (form === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const patch = {
        sshKeepAliveEnabled: form.sshKeepAliveEnabled,
        sshKeepAliveIntervalSec: form.sshKeepAliveIntervalSec,
        sshKeepAliveCountMax: form.sshKeepAliveCountMax,
        idleStringEnabled: form.idleStringEnabled,
        idleStringIntervalSec: form.idleStringIntervalSec,
        idleStringText: form.idleStringText,
        tcpKeepAliveEnabled: form.tcpKeepAliveEnabled,
        tcpKeepAliveInitialDelaySec: form.tcpKeepAliveInitialDelaySec,
        // R9 登录脚本：这些字段与保活同一张设置表，必须一起发 —— 早期版本只发
        // 保活字段，规则表能编辑但**存不下去**（刷新即丢）。
        proxyLibrary: form.proxyLibrary ?? [],
        // 终端背景图（用户 2026-10-18）：随同一张设置表保存。
        terminalBackground: form.terminalBackground ?? { enabled: false, dataUrl: "", maskOpacity: 60, blur: 0 }
      };
      const result = await api.keepAliveSave(patch);
      if (result?.ok === false) {
        // 危险规则会被 host 在保存时拒绝（连接阶段没有确认卡片），错误里点名第几条，
        // 这里原样显示 —— 不替用户「猜着改」，他需要知道是哪一条被拒。
        setError(result.error?.message ?? t("保存失败"));
        return;
      }
      const value = result?.value ?? result;
      setForm((previous) => ({ ...previous, ...value }));
      setDirty(false);
      setNotice(value?.reconnectRequired === true
        ? t("已保存。SSH 保活间隔的改动需要重新连接这条服务器才会生效。")
        : t("已保存。"));
      // 面板（终端背景图等）要立刻看到新值，别等下次聚焦（用户 2026-10-18）。
      try { window.dispatchEvent(new CustomEvent("xssh-settings-changed")); } catch { /* 忽略 */ }
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  }, [api, form, busy]);

  // 终端背景图（用户 2026-10-18）：PNG/GIF 原样读取（PNG 保留透明图层、GIF
  // 保留动图），不压缩、不限制大小，所以不经 canvas 转码。
  // 背景图层的增删改与排序（用户 2026-10-19）：列表越靠上越靠前（z 序）。
  // form 在首次加载完成前是 null（用户 2026-10-19 实测崩溃：Cannot read properties of null），
  // 这里统一用空对象兜底。
  const bgLayers = Array.isArray(form?.terminalBackground?.images) ? form.terminalBackground.images : [];
  const [dragLayerIndex, setDragLayerIndex] = useState(null);
  const patchLayers = (layers) => set("terminalBackground", { ...(form?.terminalBackground ?? {}), images: layers });
  const patchLayer = (index, patch) => patchLayers(bgLayers.map((layer, i) => (i === index ? { ...layer, ...patch } : layer)));
  const moveLayer = (from, to) => {
    if (from === to || from < 0 || to < 0) return;
    const next = [...bgLayers];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    patchLayers(next);
  };
  const removeLayer = (index) => {
    const next = bgLayers.filter((_, i) => i !== index);
    const current = form?.terminalBackground ?? {};
    set("terminalBackground", { ...current, images: next, enabled: next.length > 0 ? current.enabled !== false : false });
  };

  // 终端背景图层（用户 2026-10-19）：一次可选多张，逐张读成 dataUrl 追加为新层；
  // PNG 透明 / GIF 动图原样保存，不经 canvas 转码。
  const pickBackground = useCallback((event) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (files.length === 0) return;
    void (async () => {
      const added = [];
      for (const file of files.slice(0, 8)) {
        const looksImage = (typeof file.type === "string" && file.type.startsWith("image/"))
          || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name ?? "");
        if (!looksImage) { setError(t("只支持图片文件（PNG、GIF、JPG、WebP 等）。")); continue; }
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ""));
          reader.onerror = () => resolve("");
          reader.readAsDataURL(file);
        });
        if (!dataUrl.startsWith("data:image/")) { setError(t("读取图片失败。")); continue; }
        added.push({
          id: globalThis.crypto?.randomUUID?.() ?? `layer-${Date.now()}-${added.length}`,
          dataUrl,
          maskOpacity: 60,
          blur: 0,
          position: "center",
          positionX: 50,
          scale: 100,
          stretch: false
        });
      }
      if (added.length === 0) return;
      setForm((previous) => {
        const current = previous.terminalBackground ?? {};
        const layers = Array.isArray(current.images) ? current.images : [];
        return { ...previous, terminalBackground: { ...current, enabled: true, images: [...layers, ...added].slice(0, 8) } };
      });
      setDirty(true);
      setNotice(null);
    })();
  }, []);

  const runTest = useCallback(async () => {
    try {
      const result = await api.keepAliveTest(connectionId);
      if (result?.ok === false) { setError(result.error?.message ?? t("测试失败")); return; }
      setTest(result?.value ?? result);
      setError(null);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    }
  }, [api, connectionId]);

  if (form === null) {
    return <div style={styles.root}>{error === null ? <div style={styles.notice}>{t("载入中…")}</div> : <div style={{ ...styles.notice, ...styles.error }}>{error}</div>}</div>;
  }

  // 折叠标题右侧的状态摘要：收起时也能看到当前值（原型要求）。
  const keepAliveDigest = form.sshKeepAliveEnabled
    ? t(`开 · ${form.sshKeepAliveIntervalSec} 秒 / ${form.sshKeepAliveCountMax} 次`)
    : t("关");
  const idleDigest = form.idleStringEnabled && form.idleStringIntervalSec > 0
    ? t(`开 · 每 ${form.idleStringIntervalSec} 秒`)
    : t("关");
  const bg = form?.terminalBackground ?? { enabled: false, dataUrl: "", maskOpacity: 60, blur: 0 };
  const bgDigest = bg.enabled && bg.dataUrl !== ""
    ? t(`开 · 遮罩 ${bg.maskOpacity}%`)
    : t("关");
  // 输出提示与会话日志清理的摘要（用户 2026-10-19）。
  const outputDigest = t(`提示 ${form.outputWarnKB ?? OUT_WARN_DEFAULT_KB} KB · 清理`) + ` ${form.sessionLogAutoPruneEnabled !== false ? t("开") : t("关")}`;

  return (
    <div style={styles.root}>
      {error !== null && <div style={{ ...styles.notice, ...styles.error }}>{error}</div>}
      {notice !== null && <div style={styles.notice}>{notice}</div>}

      <SettingsGroup title={t("① SSH 保持活动状态")} digest={keepAliveDigest} open={openGroups.keepalive} onToggle={toggleGroup("keepalive")}>
          <label style={{ ...styles.check, marginTop: 10 }}>
            <input type="checkbox" checked={form.sshKeepAliveEnabled} onChange={(event) => set("sshKeepAliveEnabled", event.target.checked)} />
            {t("连接会话期间发送保持活动状态消息")}
          </label>
          <span style={styles.hint}>{t("按间隔向服务器发送 SSH 层保活消息；连续未响应超过上限即判定连接失效。")}</span>
          <div style={styles.formGrid}>
            <label style={{ ...styles.field, ...(form.sshKeepAliveEnabled ? {} : styles.disabled) }}>
              <span>{t("间隔（秒）")}</span>
              <input type="number" min={5} max={3600} disabled={!form.sshKeepAliveEnabled} style={styles.input} value={form.sshKeepAliveIntervalSec} onChange={(event) => set("sshKeepAliveIntervalSec", Number(event.target.value))} />
              <small style={styles.hint}>{t("默认 60 秒；改动需重连后生效。")}</small>
            </label>
            <label style={{ ...styles.field, ...(form.sshKeepAliveEnabled ? {} : styles.disabled) }}>
              <span>{t("未响应上限（次）")}</span>
              <input type="number" min={1} max={20} disabled={!form.sshKeepAliveEnabled} style={styles.input} value={form.sshKeepAliveCountMax} onChange={(event) => set("sshKeepAliveCountMax", Number(event.target.value))} />
              <small style={styles.hint}>{t("超过后判定连接失效，触发既有重连逻辑。")}</small>
            </label>
          </div>
          <div style={{ ...styles.actions, justifyContent: "flex-start" }}>
            <button type="button" style={styles.secondary} onClick={() => void runTest()}>{t("测试保活")}</button>
            <span style={styles.hint}>{t("测试只读：判定四条发送前提并回报下一次发送时间。")}</span>
          </div>
          {test !== null && (
            <div style={styles.notice}>
              <div>{test.wouldSend ? t("现在会在发。") : t("现在不会发。")}{test.nextSendAt !== null && t(` 下一次：${new Date(test.nextSendAt).toLocaleTimeString()}`)}</div>
              {test.checks.map((check) => (
                <div key={check.name} style={styles.checkLine}>
                  <span>{check.ok ? "✓" : "✗"}</span>
                  <span>{check.detail}</span>
                </div>
              ))}
            </div>
          )}
      </SettingsGroup>

      <SettingsGroup title={t("② 网络空闲时发送字符串")} digest={idleDigest} open={openGroups.idle} onToggle={toggleGroup("idle")}>
        <label style={{ ...styles.check, marginTop: 10 }}>
          <input type="checkbox" checked={form.idleStringEnabled} onChange={(event) => set("idleStringEnabled", event.target.checked)} />
          {t("启用空闲字符串")}
        </label>
        <span style={styles.hint}>{t("只有在该连接有活会话、没有未闭口的命令、前台不是 TUI、且一段时间没有任何收发时才发送。")}</span>
        <div style={styles.formGrid}>
          <label style={{ ...styles.field, ...(form.idleStringEnabled ? {} : styles.disabled) }}>
            <span>{t("空闲判定（秒）")}</span>
            <input type="number" min={0} max={3600} disabled={!form.idleStringEnabled} style={styles.input} value={form.idleStringIntervalSec} onChange={(event) => set("idleStringIntervalSec", Number(event.target.value))} />
            <small style={styles.hint}>{t("0 视为未启用。")}</small>
          </label>
          <label style={{ ...styles.field, ...(form.idleStringEnabled ? {} : styles.disabled) }}>
            <span>{t("要发送的字符串")}</span>
            <input disabled={!form.idleStringEnabled} style={styles.input} value={form.idleStringText} onChange={(event) => set("idleStringText", event.target.value)} placeholder={t("例如一个空格或注释字符")} />
            <small style={styles.hint}>{t("默认不自动附加回车；发出的内容会出现在终端画面上。")}</small>
          </label>
        </div>
        <div style={{ ...styles.notice, ...styles.warn, marginTop: 10 }}>
          {t("这些字符串会在行日志里标为 keepalive，且不写入命令台账 —— 以免被误当成你执行过的命令。")}
        </div>
      </SettingsGroup>

      {/* TCP 保活：底层设置仍保留（不删字段、不删保存逻辑），但界面不再展示
          （用户 2026-10-18：「基础功能还是要的，但不给用户说明展示了」）。 */}

      <SettingsGroup title={t("③ 代理服务器（SOCKS5 库）")} digest={t(`${(form.proxyLibrary ?? []).length} 个代理`)} open={openGroups.proxy} onToggle={toggleGroup("proxy")}>
        <div style={styles.notice}>{t("在这里统一维护 SOCKS5 代理；新增/编辑服务器资源时可从库里选择。密码保存后只显示占位符，需要在编辑里修改（留空保持不变）。")}</div>
        {(form.proxyLibrary ?? []).map((entry) => (
          <div key={entry.proxyId} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
            <span style={{ fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {entry.name} · {entry.host}:{entry.port}{entry.username ? ` · ${entry.username}` : ""}{entry.password ? " · ********" : ""}
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" style={styles.secondary} onClick={() => {
              setEditingProxyId(entry.proxyId);
              setClearProxyPassword(false);
              setProxyDraft({ name: entry.name, host: entry.host, port: String(entry.port), username: entry.username ?? "", password: "" });
            }}>{t("编辑")}</button>
            <button type="button" style={styles.secondary} onClick={() => {
              if (editingProxyId === entry.proxyId) {
                setEditingProxyId(null);
                setClearProxyPassword(false);
                setProxyDraft({ name: "", host: "", port: "1080", username: "", password: "" });
              }
              set("proxyLibrary", (form.proxyLibrary ?? []).filter((item) => item.proxyId !== entry.proxyId));
            }}>{t("移除")}</button>
          </div>
        ))}
        {(form.proxyLibrary ?? []).length === 0 && <div style={styles.hint}>{t("还没有保存的代理。在下方填写并点「添加到库」。")}</div>}
        <div style={{ ...styles.formGrid, marginTop: 10 }}>
          <label style={styles.field}>
            <span>{t("名称")}</span>
            <input style={styles.input} value={proxyDraft.name} onChange={(event) => setProxyDraft({ ...proxyDraft, name: event.target.value })} placeholder={t("例如 家里宽带出口")} autoComplete="off" />
          </label>
          <label style={styles.field}>
            <span>{t("代理主机")}</span>
            <input style={styles.input} value={proxyDraft.host} onChange={(event) => setProxyDraft({ ...proxyDraft, host: event.target.value })} placeholder={t("例如 192.168.10.4")} autoComplete="off" />
          </label>
          <label style={styles.field}>
            <span>{t("端口")}</span>
            <input style={styles.input} inputMode="numeric" value={proxyDraft.port} onChange={(event) => setProxyDraft({ ...proxyDraft, port: event.target.value })} />
          </label>
          <label style={styles.field}>
            <span>{t("用户名（可选）")}</span>
            <input style={styles.input} value={proxyDraft.username} onChange={(event) => setProxyDraft({ ...proxyDraft, username: event.target.value })} autoComplete="off" />
          </label>
          <label style={styles.field}>
            <span>{t("密码（可选）")}</span>
            <input type="password" style={styles.input} value={proxyDraft.password} onChange={(event) => setProxyDraft({ ...proxyDraft, password: event.target.value })}
              placeholder={editingProxyId && (form.proxyLibrary ?? []).find((item) => item.proxyId === editingProxyId)?.password ? t("已保存；留空保持不变") : t("无需认证的代理留空即可")} autoComplete="new-password" />
          </label>
        </div>
        {editingProxyId && (form.proxyLibrary ?? []).find((item) => item.proxyId === editingProxyId)?.password && (
          <label style={{ ...styles.check, marginTop: 8 }}>
            <input type="checkbox" checked={clearProxyPassword} onChange={(event) => setClearProxyPassword(event.target.checked)} />
            {t("清除已保存的密码")}
          </label>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button type="button" style={styles.secondary} disabled={!proxyDraft.name.trim() || !proxyDraft.host.trim()} onClick={() => {
            if (editingProxyId) {
              set("proxyLibrary", (form.proxyLibrary ?? []).map((item) => {
                if (item.proxyId !== editingProxyId) return item;
                const next = { ...item, name: proxyDraft.name.trim(), host: proxyDraft.host.trim(), port: Number(proxyDraft.port) || 1080 };
                if (proxyDraft.username.trim()) next.username = proxyDraft.username.trim();
                else delete next.username;
                if (clearProxyPassword) delete next.password;
                else if (proxyDraft.password) next.password = proxyDraft.password;
                return next;
              }));
              setEditingProxyId(null);
              setClearProxyPassword(false);
              setProxyDraft({ name: "", host: "", port: "1080", username: "", password: "" });
              return;
            }
            set("proxyLibrary", [...(form.proxyLibrary ?? []), {
              proxyId: (crypto?.randomUUID?.() ?? String(Date.now())),
              name: proxyDraft.name.trim(),
              host: proxyDraft.host.trim(),
              port: Number(proxyDraft.port) || 1080,
              ...(proxyDraft.username.trim() ? { username: proxyDraft.username.trim() } : {}),
              ...(proxyDraft.password ? { password: proxyDraft.password } : {})
            }]);
            setProxyDraft({ name: "", host: "", port: "1080", username: "", password: "" });
          }}>{editingProxyId ? t("保存修改") : t("添加到库")}</button>
          {editingProxyId && (
            <button type="button" style={styles.secondary} onClick={() => {
              setEditingProxyId(null);
              setClearProxyPassword(false);
              setProxyDraft({ name: "", host: "", port: "1080", username: "", password: "" });
            }}>{t("取消编辑")}</button>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("④ 终端背景图")} digest={bgDigest} open={openGroups.background} onToggle={toggleGroup("background")}>
        <div style={styles.notice}>{t("支持多张图片叠加（最多 8 层）：每层可单独设置位置、缩放、遮罩与模糊；列表越靠上越靠前，可拖动或用 ↑/↓ 调整层级。")}</div>
        <label style={{ ...styles.check, marginTop: 8 }}>
          <input type="checkbox" checked={bg.enabled === true} onChange={(event) => set("terminalBackground", { ...bg, enabled: event.target.checked })} />
          {t("启用背景图")}
        </label>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
          <button type="button" style={styles.secondary} onClick={() => bgInputRef.current?.click()}>{t("添加图片…")}</button>
          <input ref={bgInputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={pickBackground} />
          <small style={styles.hint}>{t(`共 ${bgLayers.length} 层（最多 8 层）`)}</small>
        </div>
        {bgLayers.map((layer, index) => (
          <div
            key={layer.id ?? index}
            draggable
            onDragStart={() => setDragLayerIndex(index)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => { if (dragLayerIndex !== null && dragLayerIndex !== index) moveLayer(dragLayerIndex, index); setDragLayerIndex(null); }}
            style={styles.layerCard}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <img src={layer.dataUrl} alt="" style={styles.layerThumb} />
              <span style={{ flex: 1, fontSize: 12 }}>{t(`第 ${index + 1} 层`)}{index === 0 ? t("（最上层）") : ""}</span>
              <button type="button" style={styles.iconButton} disabled={index === 0} onClick={() => moveLayer(index, index - 1)} title={t("上移一层")}>↑</button>
              <button type="button" style={styles.iconButton} disabled={index === bgLayers.length - 1} onClick={() => moveLayer(index, index + 1)} title={t("下移一层")}>↓</button>
              <button type="button" style={{ ...styles.iconButton, color: "#f07171" }} onClick={() => removeLayer(index)} title={t("移除该层")}>×</button>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
              <select style={{ ...styles.input, width: 96 }} value={layer.position} onChange={(event) => patchLayer(index, { position: event.target.value })}>
                <option value="center-zoom">{t("居中缩放")}</option>
                <option value="center-crop">{t("居中裁剪")}</option>
                <option value="tile">{t("平铺")}</option>
                <option value="top-left">{t("左上")}</option>
                <option value="top-center">{t("上中")}</option>
                <option value="top-right">{t("右上")}</option>
                <option value="left-center">{t("左中")}</option>
                <option value="right-center">{t("右中")}</option>
                <option value="bottom-left">{t("左下")}</option>
                <option value="bottom-center">{t("下中")}</option>
                <option value="bottom-right">{t("右下")}</option>
              </select>
              <input
                type="number" min={10} max={400} step={5}
                style={{ ...styles.input, width: 72 }}
                value={layer.scale ?? 100}
                onChange={(event) => patchLayer(index, { scale: Number(event.target.value) })}
                title={t("缩放（%）")}
              />
              <label style={{ ...styles.checkLine, fontSize: 12 }}>
                <input type="checkbox" checked={layer.stretch === true} onChange={(event) => patchLayer(index, { stretch: event.target.checked })} />
                {t("拉伸")}
              </label>
            </div>
            <label style={{ ...styles.field, fontSize: 12, marginTop: 6 }}>
              <span>{t(`遮罩 ${layer.maskOpacity ?? 60}%`)}</span>
              <input type="range" min={0} max={100} value={layer.maskOpacity ?? 60} onChange={(event) => patchLayer(index, { maskOpacity: Number(event.target.value) })} />
            </label>
            <label style={{ ...styles.field, fontSize: 12 }}>
              <span>{t(`模糊 ${layer.blur ?? 0}px`)}</span>
              <input type="range" min={0} max={20} value={layer.blur ?? 0} onChange={(event) => patchLayer(index, { blur: Number(event.target.value) })} />
            </label>
          </div>
        ))}
        {bgLayers.length === 0 && <small style={styles.hint}>{t("还没有背景图，点「添加图片…」选择一张或多张。")}</small>}
      </SettingsGroup>

      <SettingsGroup title={t("⑤ 输出与日志")} digest={outputDigest} open={openGroups.output} onToggle={toggleGroup("output")}>
        <label style={styles.field}>
          <span>{t("终端输出提示阈值（KB）")}</span>
          <input
            type="number" min={0} max={10240} step={64}
            style={styles.input}
            value={form.outputWarnKB ?? OUT_WARN_DEFAULT_KB}
            onChange={(event) => set("outputWarnKB", Number(event.target.value))}
          />
          <small style={styles.hint}>{t("0 = 关闭提示；单会话累计输出超过该值时在终端提示一次（60 秒冷却），避免行历史被淘汰后毫无感知。")}</small>
        </label>
        <label style={{ ...styles.check, marginTop: 4 }}>
          <input type="checkbox" checked={form.sessionLogAutoPruneEnabled !== false} onChange={(event) => set("sessionLogAutoPruneEnabled", event.target.checked)} />
          {t("自动清理会话日志")}
        </label>
        <div style={styles.formGrid}>
          <label style={{ ...styles.field, ...(form.sessionLogAutoPruneEnabled !== false ? {} : styles.disabled) }}>
            <span>{t("日志总量上限（MB）")}</span>
            <input type="number" min={50} max={102400} step={50} disabled={form.sessionLogAutoPruneEnabled === false} style={styles.input} value={form.sessionLogMaxTotalMB ?? OUT_LOG_MAX_TOTAL_MB_DEFAULT} onChange={(event) => set("sessionLogMaxTotalMB", Number(event.target.value))} />
          </label>
          <label style={{ ...styles.field, ...(form.sessionLogAutoPruneEnabled !== false ? {} : styles.disabled) }}>
            <span>{t("保留天数")}</span>
            <input type="number" min={0} max={3650} step={1} disabled={form.sessionLogAutoPruneEnabled === false} style={styles.input} value={form.sessionLogMaxAgeDays ?? OUT_LOG_MAX_AGE_DAYS_DEFAULT} onChange={(event) => set("sessionLogMaxAgeDays", Number(event.target.value))} />
          </label>
        </div>
        <small style={styles.hint}>{t("按总量与保留天数清理 ~/.dsh/xssh-ops-logs；正在录制的会话不会被删除。")}</small>
        <label style={{ ...styles.check, marginTop: 10 }}>
          <input type="checkbox" checked={form.filesFollowTerminal !== false} onChange={(event) => set("filesFollowTerminal", event.target.checked)} />
          {t("文件页签跟随终端路径")}
        </label>
        <small style={styles.hint}>{t("开启后，在终端里 cd 到别的目录时，「文件」页签会自动切到该目录。")}</small>
        <label style={{ ...styles.check, marginTop: 8, opacity: form.filesFollowTerminal !== false ? 1 : 0.45 }}>
          <input
            type="checkbox"
            checked={form.terminalFileLinks !== false}
            disabled={form.filesFollowTerminal === false}
            onChange={(event) => set("terminalFileLinks", event.target.checked)}
          />
          {t("识别终端里的文件名")}
        </label>
        <small style={styles.hint}>{t("开启后，终端输出中带已知后缀的文件名会加下划线，点击可在「文件 / 编辑器」页签里打开预览或编辑（需要先开启「文件页签跟随终端路径」）。")}</small>
      </SettingsGroup>

      <div style={styles.actions}>
        <button type="button" style={styles.secondary} onClick={() => { void api.keepAliveGet().then((result) => { setForm(result?.value ?? result); setDirty(false); setNotice(null); }); }} disabled={busy}>{t("放弃改动")}</button>
        <button type="button" style={styles.primary} onClick={() => void save()} disabled={busy || !dirty}>{busy ? t("保存中…") : t("保存")}</button>
      </div>
    </div>
  );
}
