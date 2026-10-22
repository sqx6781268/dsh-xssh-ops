/**
 * Durable SSH resource management for its first-class Settings section. Server coordinates
 * live in the host storage domain; secrets only cross the web boundary through
 * DSH's credentials.set/unset API and are never put in React state after save.
 */
import * as React from "react";
import { sshUiRequestSurface, sshUiSetConnections, sshUiSetError, sshUiSetProjectTarget } from "./store.js";
import { requestPaneOpen } from "./pane-selection.js";
import { privateKeyProblem } from "./pemkey.js";
import { t } from "../i18n/core.js";
import { useLanguage } from "./locale.js";
import { KeepAliveSettings } from "./KeepAliveSettings.jsx";
import { RuleTable } from "./KeepAliveSettings.jsx";
import { ShortcutsSettings } from "./ShortcutsSettings.jsx";
import { SettingsGroup } from "./settings-group.jsx";

/** Injected at build time from package.json (scripts/build-client.mjs). */
// eslint-disable-next-line no-undef
const PLUGIN_VERSION = typeof __DSH_SSH_OPS_VERSION__ === "string" ? __DSH_SSH_OPS_VERSION__ : "dev";
const GITHUB_URL = "https://github.com/sqx6781268/dsh-xssh-ops";
const UPDATE_ENDPOINT = "/api/dsh-xssh-ops/update";

/** GitHub mark (octicon, 16px, fill). */
function GitHubMarkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/** Host refresh glyph (dsh-client-ui-primitives IconRefreshOutlineArtwork, 1.3px stroke). */
function RefreshIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1" />
      <path d="M14.4999 1.5V5.1H10.8999" />
    </svg>
  );
}

const { useEffect, useRef, useState } = React;
const LEGACY_PROFILES_KEY = "dsh-xssh-ops.server-profiles.v1";

// Evaluated per render: a module-level object would freeze the labels in
// whatever language was active at import time.
const hostKeyModeLabels = () => ({
  "accept-new": t("默认（首次信任，变化才拒）"),
  verify: t("严格（拒绝未知主机）"),
  off: t("关闭校验（不推荐）")
});

function emptyForm() {
  return {
    profileId: undefined,
    name: "",
    host: "",
    port: "22",
    username: "root",
    authKind: "password",
    hostKeyMode: "accept-new",
    agentForward: false,
    groupId: "",
    credentialId: "",
    defaultProjectPath: "",
    loginCommand: "",
    proxyJump: [],
    // Upstream SOCKS5 proxy: the connection dials the proxy first and asks it
    // for the target. An empty host means "no proxy" (the field is optional, so
    // old records and records without a proxy load exactly as before).
    proxy: { type: "socks5", host: "", port: "1080", username: "", password: "" },
    // 登录脚本（按服务器配置；用户 2026-10-17 从全局设置迁来）
    loginScript: { rulesEnabled: false, rules: [], matchMode: "substring", stepTimeoutMs: 15000, onTimeout: "skip", postCommands: [] },
    secret: "",
    passphrase: "",
    secondary: "",
    clearSecret: false,
    clearPassphrase: false,
    clearSecondary: false,
    clearProxyPassword: false
  };
}

function profileToForm(profile) {
  return {
    ...emptyForm(),
    profileId: profile.profileId,
    name: profile.name,
    host: profile.host,
    port: String(profile.port),
    username: profile.username,
    authKind: profile.authKind,
    hostKeyMode: profile.hostKeyMode ?? "accept-new",
    agentForward: profile.agentForward === true,
    groupId: profile.groupId ?? "",
    credentialId: profile.credentialId ?? "",
    defaultProjectPath: profile.defaultProjectPath ?? "",
    loginCommand: profile.loginCommand ?? "",
    // The proxy's password never comes back from the host (it lives in the
    // credentials store), so the form starts empty and an empty box means
    // "keep the stored one".
    proxy: {
      type: profile.proxy?.type ?? "socks5",
      host: profile.proxy?.host ?? "",
      port: profile.proxy?.port === undefined || profile.proxy?.port === null ? "1080" : String(profile.proxy.port),
      username: profile.proxy?.username ?? "",
      password: ""
    },
    proxyJump: (profile.proxyJump ?? []).map((hop) => ({ ...hop, authKind: hop.authKind ?? "credential", password: "", privateKey: "", passphrase: "" })),
    loginScript: profile.loginScript ? { ...profile.loginScript, rules: [...(profile.loginScript.rules ?? [])], postCommands: [...(profile.loginScript.postCommands ?? [])] } : { rulesEnabled: false, rules: [], matchMode: "substring", stepTimeoutMs: 15000, onTimeout: "skip", postCommands: [] }
  };
}

async function credentialWrite(credentials, ref, value) {
  const response = await credentials.set(ref, value);
  if (response && !response.ok) throw new Error(response.error?.message ?? t("无法保存凭据"));
}

async function credentialUnset(credentials, ref) {
  const response = await credentials.unset(ref);
  if (response && !response.ok) throw new Error(response.error?.message ?? t("无法清除凭据"));
}

function readLegacyProfiles() {
  try {
    const value = JSON.parse(localStorage.getItem(LEGACY_PROFILES_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((profile) => profile && typeof profile.host === "string" && typeof profile.username === "string");
  } catch {
    return [];
  }
}

/** Migrate only non-secret coordinates from older browser-local profiles. */
export async function migrateLegacyProfiles(api) {
  const legacy = readLegacyProfiles().filter((p) => String(p.host ?? "").trim() !== "");
  if (legacy.length === 0) return false;
  const remaining = [];
  for (const profile of legacy) {
    try {
      await api.profileSave({
        name: String(profile.name || profile.host).trim() || "SSH server",
        host: String(profile.host).trim(),
        port: Number(profile.port) || 22,
        username: String(profile.username).trim(),
        authKind: profile.authKind === "key" ? "key" : "password"
      });
    } catch {
      remaining.push(profile);
    }
  }
  try {
    if (remaining.length === 0) localStorage.removeItem(LEGACY_PROFILES_KEY);
    else localStorage.setItem(LEGACY_PROFILES_KEY, JSON.stringify(remaining));
  } catch {}
  return true;
}

export function ResourceEditor({ initial, groups, profiles, sharedCredentials = [], proxyLibrary = [], credentials, api, onClose, onSaved }) {
  const [form, setForm] = useState(() => initial ? profileToForm(initial) : emptyForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const keyFileInput = useRef(null);
  // 代理库是「连接设置」里维护的共享列表：打开编辑器时拉一次最新的，否则刚在
  // 设置页添加的代理不会出现在「从代理库选择」里（用户 2026-10-18 反馈）。
  const [library, setLibrary] = useState(proxyLibrary);
  const [libraryError, setLibraryError] = useState(null);
  const [selectedProxyId, setSelectedProxyId] = useState("");
  useEffect(() => {
    let alive = true;
    api.keepAliveGet?.().then((result) => {
      const value = result?.value ?? result;
      if (alive && Array.isArray(value?.proxyLibrary)) setLibrary(value.proxyLibrary);
      // 新建服务器预填上次用过的用户名（用户 2026-10-20）：只在新建表单、
      // 且用户还没改过默认用户名时生效，不覆盖已输入的内容。
      if (alive && !initial && typeof value?.lastUsername === "string" && value.lastUsername !== "") {
        setForm((previous) => (previous.username === "root" || previous.username === "" ? { ...previous, username: value.lastUsername } : previous));
      }
    }).catch((cause) => {
      if (alive) setLibraryError(cause?.message ?? String(cause));
    });
    return () => { alive = false; };
  }, [api]);
  // Advanced options start collapsed; an existing resource that already
  // carries an advanced value opens expanded so nothing stays hidden.
  // SOCKS 代理默认折叠；已有代理值的服务器打开时自动展开（同高级选项的原则：
  // 有值的东西不藏在折叠里让人以为没配）。
  const [proxyOpen, setProxyOpen] = useState(() => Boolean(initial?.proxy?.host) || Boolean(initial?.proxyCredentialConfigured));
  // 登录动作独立折叠区（用户 2026-10-18：从高级选项拆出）：登录脚本、登录后执行
  // 或登录命令任一有已配内容时自动展开。
  const [loginScriptOpen, setLoginScriptOpen] = useState(() => Boolean(initial) && (
    (initial.loginScript?.rules ?? []).length > 0
    || (initial.loginScript?.postCommands ?? []).length > 0
    || initial.loginScript?.rulesEnabled === true
    || (initial.loginCommand ?? "") !== ""
  ));
  const [advancedOpen, setAdvancedOpen] = useState(() => Boolean(
    initial
    && ((initial.defaultProjectPath ?? "") !== ""
      || (initial.hostKeyMode ?? "accept-new") !== "accept-new"
      || initial.secondaryConfigured
      || initial.agentForward === true)
  ));
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value }));
  const addJump = () => setForm((current) => ({ ...current, proxyJump: [...current.proxyJump, { profileId: "" }] }));
  const updateJump = (index, key, value) => setForm((current) => ({ ...current, proxyJump: current.proxyJump.map((hop, i) => i === index ? { ...hop, [key]: value } : hop) }));
  const removeJump = (index) => setForm((current) => ({ ...current, proxyJump: current.proxyJump.filter((_, i) => i !== index) }));
  const setProxy = (key) => (event) => {
    setSelectedProxyId("");
    setForm((current) => ({
      ...current,
      proxy: { ...current.proxy, [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value }
    }));
  };

  const importKey = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 1024 * 1024) return setError(t("私钥文件不能超过 1 MB"));
    try {
      const secret = await file.text();
      if (!secret.trim()) throw new Error(t("所选私钥文件为空"));
      setForm((current) => ({ ...current, secret }));
      setError(null);
    } catch (cause) {
      setError(cause?.message ?? t("无法读取私钥文件"));
    }
  };

  const submit = async () => {
    if (!form.name.trim() || !form.host.trim() || !form.username.trim()) {
      setError(t("请填写名称、主机和用户名"));
      return;
    }
    if (!credentials) {
      setError(t("当前 DSH 未提供凭据服务，不能安全保存 SSH 认证信息"));
      return;
    }
    if (form.proxyJump.some((hop) => !hop.profileId)) {
      setError(t("请选择每台跳板服务器"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // A truncated paste is the most common way a saved key ends up
      // "valid-looking but rejected by the server": catch it before anything
      // is persisted instead of surfacing later as a bare auth failure.
      if (form.authKind === "key" && form.secret.trim()) {
        const problem = privateKeyProblem(form.secret, form.passphrase);
        if (problem) {
          setError(problem);
          return;
        }
      }
      // Upstream SOCKS5 proxy coordinates only; the password goes to the
      // credential store against saved.credentialRefs.proxyPassword below.
      // An empty host means "no proxy", so the proxy field is omitted.
      const proxyCoordinates = form.proxy.host.trim()
        ? {
            type: "socks5",
            host: form.proxy.host.trim(),
            port: Number(form.proxy.port) || 1080,
            ...(form.proxy.username.trim() ? { username: form.proxy.username.trim() } : {})
          }
        : undefined;
      const saved = await api.profileSave({
        ...(form.profileId ? { profileId: form.profileId } : {}),
        name: form.name.trim(),
        host: form.host.trim(),
        port: Number(form.port) || 22,
        username: form.username.trim(),
        authKind: form.authKind,
        hostKeyMode: form.hostKeyMode,
        agentForward: form.agentForward === true,
        groupId: form.groupId || null,
        credentialId: form.credentialId || null,
        defaultProjectPath: form.defaultProjectPath.trim() || null,
        loginCommand: form.loginCommand.trim() || null,
        proxyJump: form.proxyJump.map((hop) => ({ profileId: hop.profileId })),
        loginScript: (form.loginScript.rulesEnabled || form.loginScript.rules.length > 0 || (form.loginScript.postCommands ?? []).length > 0)
          ? { rulesEnabled: form.loginScript.rulesEnabled === true, rules: form.loginScript.rules, matchMode: form.loginScript.matchMode ?? "substring", stepTimeoutMs: form.loginScript.stepTimeoutMs ?? 15000, onTimeout: form.loginScript.onTimeout ?? "skip", postCommands: (form.loginScript.postCommands ?? []).slice(0, 100) }
          : null,
        ...(proxyCoordinates ? { proxy: proxyCoordinates } : {})
      });
      const primaryRef = form.authKind === "password" ? saved.credentialRefs.password : saved.credentialRefs.privateKey;
      if (form.secret.trim()) await credentialWrite(credentials, primaryRef, form.secret);
      else if (form.clearSecret) await credentialUnset(credentials, primaryRef);
      if (form.authKind === "key") {
        if (form.passphrase) await credentialWrite(credentials, saved.credentialRefs.passphrase, form.passphrase);
        else if (form.clearPassphrase) await credentialUnset(credentials, saved.credentialRefs.passphrase);
      }
      // Optional second factor for dual-factor devices (AuthenticationMethods
      // password,publickey or the reverse): stored in the opposite-kind slot.
      const secondaryRef = form.authKind === "password" ? saved.credentialRefs.privateKey : saved.credentialRefs.password;
      if (form.secondary.trim()) await credentialWrite(credentials, secondaryRef, form.secondary);
      else if (form.clearSecondary) await credentialUnset(credentials, secondaryRef);
      // SOCKS5 proxy password: written only when typed; an explicit "clear"
      // checkbox removes it. A blank box keeps the stored secret. When no
      // proxy is configured, drop any stale proxy password too.
      const proxyRef = saved.credentialRefs.proxyPassword;
      if (proxyRef) {
        if (form.proxy.password) await credentialWrite(credentials, proxyRef, form.proxy.password);
        else if (form.clearProxyPassword || !proxyCoordinates) await credentialUnset(credentials, proxyRef);
      }
      await onSaved();
      onClose();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  };

  const primaryConfigured = initial?.credentialConfigured;
  return (
    <div style={styles.backdrop} onClick={busy ? undefined : onClose}>
      <div className="dsh-xssh-ops-resource-modal" style={styles.dialog} onClick={(event) => event.stopPropagation()}>
        <div style={styles.dialogTitle}>{form.profileId ? t("编辑 SSH 资源") : t("新增 SSH 资源")}</div>
        {!form.profileId && profiles.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <select
              value=""
              onChange={(event) => {
                const source = profiles.find((profile) => profile.profileId === event.target.value);
                if (!source) return;
                // 复制为新增起点：带入全部字段但清掉 profileId（保存时成为新记录）；
                // 名称加「副本」后缀提示这是复制来的。
                setForm({ ...profileToForm(source), profileId: undefined, name: source.name + t("（副本）") });
                setSelectedProxyId("");
                setProxyOpen(Boolean(source.proxy?.host));
              }}
              style={styles.input}>
              <option value="">{t("从已保存的服务器复制…")}</option>
              {profiles.map((profile) => <option key={profile.profileId} value={profile.profileId}>{profile.name} · {profile.username}@{profile.host}:{profile.port}</option>)}
            </select>
          </div>
        )}
        {/* One shared 3-column grid for the coordinate rows: every column
            boundary sits at 1/3 and 2/3, so the three rows line up. */}
        <div style={styles.formGrid}>
          <Field label={t("名称")}><input value={form.name} onChange={set("name")} placeholder={t("阿里云生产环境")} style={styles.input} /></Field>
          <Field label={t("主机")} style={{ gridColumn: "span 2" }}><input value={form.host} onChange={set("host")} placeholder={t("example.com 或 IP 地址")} style={styles.input} /></Field>
          <Field label={t("端口")}><input value={form.port} onChange={set("port")} inputMode="numeric" style={styles.input} /></Field>
          <Field label={t("用户名")}><input value={form.username} onChange={set("username")} style={styles.input} /></Field>
          <Field label={t("分组")}>
            <select value={form.groupId} onChange={set("groupId")} style={styles.input}>
              <option value="">{t("未分组")}</option>
              {groups.map((group) => <option key={group.groupId} value={group.groupId}>{group.name}</option>)}
            </select>
          </Field>
          <Field label={t("认证方式")}>
            <select value={form.authKind} onChange={set("authKind")} style={styles.input}>
              <option value="password">{t("密码")}</option>
              <option value="key">{t("PEM / 私钥")}</option>
            </select>
          </Field>
          <Field label={t("共享凭据")} style={{ gridColumn: "span 2" }}>
            <select value={form.credentialId} onChange={set("credentialId")} style={styles.input}><option value="">{t("此服务器专属凭据")}</option>{sharedCredentials.filter((item) => item.authKind === form.authKind).map((item) => <option key={item.credentialId} value={item.credentialId}>{item.name}</option>)}</select>
          </Field>
        </div>
        <Field label={form.authKind === "password" ? t("密码") : t("私钥（PEM / .key）")} hint={primaryConfigured ? t("已保存；留空保持不变") : t("保存后仅显示已配置状态")}>
          {form.authKind === "password" ? (
            <input type="password" value={form.secret} onChange={set("secret")} style={styles.input} />
          ) : (
            <>
              <textarea value={form.secret} onChange={set("secret")} rows={4} style={{ ...styles.input, fontFamily: "monospace" }} />
              <input ref={keyFileInput} type="file" accept=".pem,.key,.rsa,.ed25519,.txt,text/plain" onChange={importKey} style={{ display: "none" }} />
              <button type="button" onClick={() => keyFileInput.current?.click()} style={styles.secondary}>{t("导入 PEM / 私钥文件")}</button>
            </>
          )}
          {primaryConfigured && <Check label={t("清除已保存的认证信息")} checked={form.clearSecret} onChange={set("clearSecret")} />}
        </Field>
        {form.authKind === "key" && (
          <Field label={t("私钥口令")} hint={initial?.passphraseConfigured ? t("已保存；留空保持不变") : t("可选")}>
            <input type="password" value={form.passphrase} onChange={set("passphrase")} style={styles.input} />
            {initial?.passphraseConfigured && <Check label={t("清除已保存的私钥口令")} checked={form.clearPassphrase} onChange={set("clearPassphrase")} />}
          </Field>
        )}
        <Field label={t("跳板机（ProxyJump）")}>
          {form.proxyJump.map((hop, index) => <div key={index} style={styles.jumpRow}><select value={hop.profileId ?? ""} onChange={(event) => updateJump(index, "profileId", event.target.value)} style={styles.input}><option value="">{t("选择已保存服务器")}</option>{profiles.filter((profile) => profile.profileId !== form.profileId).map((profile) => <option key={profile.profileId} value={profile.profileId}>{profile.name} · {profile.username}@{profile.host}:{profile.port}</option>)}</select><button type="button" onClick={() => removeJump(index)} style={styles.danger}>{t("移除")}</button></div>)}
          <button type="button" onClick={addJump} style={styles.secondary}>{t("＋ 添加跳板机")}</button>
        </Field>
        {/* 库选择始终可见，只有手工代理字段折叠，避免已有代理被误认为功能消失。 */}
        <Field label={t("从代理库选择")}>
          <select aria-label={t("从代理库选择")} value={selectedProxyId} onChange={(event) => {
            const entry = library.find((item) => item.proxyId === event.target.value);
            setSelectedProxyId(event.target.value);
            setForm((current) => ({
              ...current,
              proxy: { type: "socks5", host: entry?.host ?? "", port: String(entry?.port ?? 1080), username: entry?.username ?? "", password: entry?.password ?? "" },
              // 切换到无认证代理时也应清掉旧代理的密码。
              clearProxyPassword: !entry?.password
            }));
            if (entry) setProxyOpen(true);
          }} style={styles.input}>
            <option value="">{t("不使用代理 / 手动填写")}</option>
            {library.map((entry) => <option key={entry.proxyId} value={entry.proxyId}>{entry.name} · {entry.host}:{entry.port}{entry.username ? ` · ${entry.username}` : ""}</option>)}
          </select>
          {libraryError && <small role="alert" style={styles.hint}>{t("读取代理库失败：{message}").replace("{message}", libraryError)}</small>}
          {!libraryError && library.length === 0 && <small style={styles.hint}>{t("可在连接设置中添加并保存 SOCKS5 代理，也可展开下方手动填写。")}</small>}
        </Field>
        <button type="button" onClick={() => setProxyOpen((open) => !open)} style={styles.advToggle} aria-expanded={proxyOpen}>{t(`${proxyOpen ? "▾" : "▸"} SOCKS 代理${proxyOpen ? "" : t("（可选；默认不使用）")}`)}</button>
        {proxyOpen && (
        <div style={{ display: "contents" }}>
        <Field label={t("代理（SOCKS5）")} hint={t("先连接此 SOCKS5 代理，再由代理连接到服务器；代理主机留空表示不使用代理。标准 SOCKS5 代理这里只填代理地址，目标仍是上方真实服务器主机/端口；仅转发代理机本机端口的代理，才需把上方服务器主机填 127.0.0.1、端口填代理机上的转发端口。")}>
          <div style={styles.formGrid}>
            <Field label={t("类型")}><input value="SOCKS5" readOnly style={styles.input} /></Field>
            <Field label={t("代理主机")} style={{ gridColumn: "span 2" }}><input value={form.proxy.host} onChange={setProxy("host")} placeholder={t("例如 192.168.10.4 或 gw.example.com")} style={styles.input} autoComplete="off" /></Field>
            <Field label={t("代理端口")}><input value={form.proxy.port} onChange={setProxy("port")} inputMode="numeric" style={styles.input} /></Field>
            <Field label={t("代理用户名（可选）")} style={{ gridColumn: "span 2" }}><input value={form.proxy.username} onChange={setProxy("username")} autoComplete="off" style={styles.input} /></Field>
          </div>
          <Field label={t("代理密码")} hint={initial?.proxyCredentialConfigured ? t("已保存；留空保持不变") : t("无需认证的代理留空即可")}>
            <input type="password" value={form.proxy.password} onChange={setProxy("password")} style={styles.input} autoComplete="new-password" />
            {initial?.proxyCredentialConfigured && <Check label={t("清除已保存的代理密码")} checked={form.clearProxyPassword} onChange={set("clearProxyPassword")} />}
          </Field>
        </Field>
        </div>
        )}
        {/* 登录动作：登录脚本 · 登录后命令 · 登录命令（用户 2026-10-18 要求独立折叠）。 */}
        <button type="button" onClick={() => setLoginScriptOpen((open) => !open)} style={styles.advToggle} aria-expanded={loginScriptOpen}>{t(`${loginScriptOpen ? "▾" : "▸"} 登录动作${loginScriptOpen ? "" : t("（登录脚本 · 登录后命令 · 登录命令）")}`)}</button>
        {loginScriptOpen && (
        <div style={{ display: "contents" }}>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={{ ...styles.check, marginBottom: 6 }}>
                <input type="checkbox" checked={form.loginScript.rulesEnabled} onChange={(event) => setForm((current) => ({ ...current, loginScript: { ...current.loginScript, rulesEnabled: event.target.checked } }))} />
                {t("登录脚本")}
              </label>
              <span style={styles.hint}>{t("连接就绪后按顺序等待并发送")}</span>
              <div style={{ ...styles.formGrid, marginTop: 8 }}>
                <label style={styles.field}>
                  <span>{t("匹配方式")}</span>
                  <select style={styles.input} value={form.loginScript.matchMode} onChange={(event) => setForm((current) => ({ ...current, loginScript: { ...current.loginScript, matchMode: event.target.value } }))}>
                    <option value="substring">{t("子串")}</option>
                    <option value="glob">{t("通配")}</option>
                    <option value="regex">{t("正则")}</option>
                  </select>
                </label>
                <label style={styles.field}>
                  <span>{t("单条等待超时（毫秒）")}</span>
                  <input type="number" min={1000} max={600000} style={styles.input} value={form.loginScript.stepTimeoutMs} onChange={(event) => setForm((current) => ({ ...current, loginScript: { ...current.loginScript, stepTimeoutMs: Number(event.target.value) } }))} />
                </label>
                <label style={styles.field}>
                  <span>{t("超时后怎么办")}</span>
                  <select style={styles.input} value={form.loginScript.onTimeout} onChange={(event) => setForm((current) => ({ ...current, loginScript: { ...current.loginScript, onTimeout: event.target.value } }))}>
                    <option value="skip">{t("跳过该条，继续下一条")}</option>
                    <option value="strict">{t("中止后续规则（严格）")}</option>
                  </select>
                </label>
              </div>
              <div style={{ marginTop: 8 }}>
                <RuleTable
                  rules={form.loginScript.rules}
                  mode={form.loginScript.matchMode}
                  onChange={(rules) => setForm((current) => ({ ...current, loginScript: { ...current.loginScript, rules } }))}
                />
              </div>
              <hr style={{ ...styles.advSectionLine, marginTop: 14 }} />
              <div style={{ marginTop: 8 }}>
                <label style={{ ...styles.check, marginBottom: 4 }}>
                  {t("登录后命令")}
                </label>
                <input type="file" accept=".sh,.txt,.conf,.script" style={{ fontSize: 12, marginBottom: 4 }}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = () => {
                      const lines = String(reader.result ?? "").split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim() !== "");
                      setForm((current) => ({ ...current, loginScript: { ...current.loginScript, postCommands: [...(current.loginScript.postCommands ?? []), ...lines].slice(0, 100) } }));
                    };
                    reader.readAsText(file);
                    event.target.value = "";
                  }} />
                <textarea
                  value={(form.loginScript.postCommands ?? []).join("\n")}
                  onChange={(event) => setForm((current) => ({ ...current, loginScript: { ...current.loginScript, postCommands: event.target.value.split("\n").filter((line) => line.trim() !== "") } }))}
                  rows={4}
                  style={{ ...styles.input, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, width: "100%", boxSizing: "border-box" }}
                  placeholder={t("例如：\ncd /opt/app\ndocker compose up -d")} />
                <span style={styles.hint}>{t("规则跑完后逐条执行")}</span>
              </div>
              <hr style={{ ...styles.advSectionLine, marginTop: 14 }} />
              <Field label={t("登录命令（可选）")} hint={t("替代服务器默认 shell")}>
                <input value={form.loginCommand} onChange={set("loginCommand")} placeholder={t("例如 bash -l")} style={styles.input} title={t("在默认 shell 不兼容的服务器（如 zsh）上填 bash -l 可临时改用 bash；命令即整个登录会话，想要正常 profile 加载请带 -l；留空按服务器默认。")} />
              </Field>
            </div>
        </div>
        )}

        <button type="button" onClick={() => setAdvancedOpen((open) => !open)} style={styles.advToggle} aria-expanded={advancedOpen}>{t(`${advancedOpen ? "▾" : "▸"} 高级选项${advancedOpen ? "" : t("（项目目录 · 指纹 · 第二因素 · Agent 转发）")}`)}</button>
        {advancedOpen && (
          <div style={styles.credentialColumns}>
            <div style={styles.advSection}><hr style={styles.advSectionLine} /><span style={styles.advSectionTitle}>{t("项目与登录")}</span></div>
            <Field label={t("默认项目目录")}>
              <input value={form.defaultProjectPath} onChange={set("defaultProjectPath")} placeholder={t("例如 /srv/apps/my-service")} style={styles.input} />
            </Field>
            <div style={styles.advSection}><hr style={styles.advSectionLine} /><span style={styles.advSectionTitle}>{t("安全校验")}</span></div>
            <Field label={t("主机指纹校验")}>
              <select value={form.hostKeyMode} onChange={set("hostKeyMode")} style={styles.input}>
                <option value="accept-new">{hostKeyModeLabels()["accept-new"]}</option>
                <option value="verify">{hostKeyModeLabels().verify}</option>
                <option value="off">{hostKeyModeLabels().off}</option>
              </select>
            </Field>
            <Field label={t("第二因素（可选）")}>
              {form.authKind === "password" ? (
                <textarea
                  value={form.secondary}
                  onChange={(event) => {
                    set("secondary")(event);
                    // Match the single-line inputs around it when empty; pasted
                    // PEM grows the box up to a small cap, then it scrolls.
                    const el = event.target;
                    el.style.height = "auto";
                    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
                  }}
                  rows={1}
                  style={{ ...styles.input, fontFamily: "monospace", resize: "none", overflowY: "auto" }}
                  placeholder={t("双因素设备才需要填写")}
                  title={t("防火墙/交换机启用 AuthenticationMethods password+publickey 双因素认证时填写；PEM 可直接粘贴，输入框随内容自动长高")}
                />
              ) : (
                <input
                  type="password"
                  value={form.secondary}
                  onChange={set("secondary")}
                  style={styles.input}
                  placeholder={t("双因素设备才需要填写")}
                  title={t("防火墙/交换机启用 AuthenticationMethods publickey,password 双因素认证时填写")}
                />
              )}
              {initial?.secondaryConfigured && <Check label={t("清除已保存的第二因素")} checked={form.clearSecondary} onChange={set("clearSecondary")} />}
            </Field>
            <div style={styles.advSection}><hr style={styles.advSectionLine} /><span style={styles.advSectionTitle}>{t("认证增强")}</span></div>
            <Field label={t("SSH Agent 转发")} hint={t("连接后可从这台服务器的终端用本机密钥继续登录更深层的机器")}>
              <Check label={t("转发本机 ssh-agent（需本机已运行）")} checked={form.agentForward} onChange={set("agentForward")} />
            </Field>
          </div>
        )}
        {error && <div style={styles.error} role="alert">{error}</div>}
        <div style={styles.actions}>
          <button type="button" disabled={busy} onClick={onClose} style={styles.secondary}>{t("取消")}</button>
          <button type="button" disabled={busy} onClick={submit} style={styles.primary}>{busy ? t("保存中…") : t("保存资源")}</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children, style }) {
  return <label style={{ ...styles.field, ...style }}><span>{label}</span>{hint && <small style={styles.hint}>{hint}</small>}{children}</label>;
}

function Check({ label, checked, onChange }) {
  return <label style={styles.check}><input type="checkbox" checked={checked} onChange={onChange} />{label}</label>;
}

function SharedCredentialEditor({ initial, credentials, api, onClose, onSaved }) {
  const [name, setName] = useState(initial?.name ?? ""); const [authKind, setAuthKind] = useState(initial?.authKind ?? "key"); const [secret, setSecret] = useState(""); const [passphrase, setPassphrase] = useState(""); const [secondary, setSecondary] = useState(""); const [error, setError] = useState(null); const [busy, setBusy] = useState(false); const fileInput = useRef(null);
  const importKey = async (file) => {
    if (!file) return;
    if (file.size > 1024 * 1024) return setError(t("私钥文件不能超过 1 MB"));
    try { const text = await file.text(); if (!text.trim()) throw new Error(t("所选私钥文件为空")); const problem = privateKeyProblem(text); if (problem) throw new Error(problem); setSecret(text); setError(null); } catch (cause) { setError(cause?.message ?? t("无法读取私钥文件")); }
  };
  const save = async () => { if (!name.trim()) return setError(t("请填写凭据名称")); if (authKind === "key" && secret) { const problem = privateKeyProblem(secret, passphrase); if (problem) return setError(problem); } setBusy(true); try { const saved = await api.credentialSave({ ...(initial?.credentialId ? { credentialId: initial.credentialId } : {}), name: name.trim(), authKind }); const ref = authKind === "password" ? saved.credentialRefs.password : saved.credentialRefs.privateKey; if (secret) await credentialWrite(credentials, ref, secret); if (authKind === "key" && passphrase) await credentialWrite(credentials, saved.credentialRefs.passphrase, passphrase); const secondaryRef = authKind === "password" ? saved.credentialRefs.privateKey : saved.credentialRefs.password; if (secondary.trim()) await credentialWrite(credentials, secondaryRef, secondary); await onSaved(); onClose(); } catch (cause) { setError(cause?.message ?? String(cause)); } finally { setBusy(false); } };
  return <div style={styles.backdrop} onClick={onClose}><div className="dsh-xssh-ops-resource-modal" style={styles.dialog} onClick={(event) => event.stopPropagation()} onDragOver={(event) => { if (authKind === "key") event.preventDefault(); }} onDrop={(event) => { if (authKind !== "key") return; event.preventDefault(); importKey(event.dataTransfer.files?.[0]); }}><div style={styles.dialogTitle}>{initial ? t("编辑共享凭据") : t("新增共享凭据")}</div><Field label={t("名称")}><input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("生产环境运维私钥")} style={styles.input} /></Field><Field label={t("认证方式")}><select value={authKind} onChange={(event) => setAuthKind(event.target.value)} style={styles.input}><option value="key">{t("PEM / 私钥")}</option><option value="password">{t("密码")}</option></select></Field><Field label={authKind === "key" ? t("私钥") : t("密码")} hint={initial?.credentialConfigured ? t("已保存；留空保持不变") : ""}>{authKind === "key" ? <><textarea value={secret} onChange={(event) => setSecret(event.target.value)} rows={4} style={{ ...styles.input, fontFamily: "monospace" }} /><input ref={fileInput} type="file" accept=".pem,.key,.rsa,.ed25519,.txt,text/plain" onChange={(event) => { importKey(event.target.files?.[0]); event.target.value = ""; }} style={{ display: "none" }} /><button type="button" onClick={() => fileInput.current?.click()} style={styles.secondary}>{t("选择私钥文件")}</button><small style={styles.hint}>{t("也可将 PEM / 私钥文件拖入此窗口。")}</small></> : <input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} style={styles.input} />}</Field>{authKind === "key" && <Field label={t("私钥口令")}><input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} style={styles.input} /></Field>}<Field label={authKind === "password" ? t("第二因素：私钥（可选）") : t("第二因素：密码（可选）")} hint={initial?.secondaryConfigured ? t("已保存；留空保持不变") : t("双因素设备（AuthenticationMethods password+publickey）才需要填写")}>{authKind === "password" ? <textarea value={secondary} onChange={(event) => setSecondary(event.target.value)} rows={4} style={{ ...styles.input, fontFamily: "monospace" }} /> : <input type="password" value={secondary} onChange={(event) => setSecondary(event.target.value)} style={styles.input} />}</Field>{error && <div style={styles.error}>{error}</div>}<div style={styles.actions}><button type="button" onClick={onClose} style={styles.secondary}>{t("取消")}</button><button type="button" disabled={busy} onClick={save} style={styles.primary}>{busy ? t("保存中…") : t("保存凭据")}</button></div></div></div>;
}

/** Green shield when a host's fingerprint is trusted; grey/dim when not. */
function ShieldIcon({ trusted }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
      <path d="M12 3.2 19 6v5.1c0 4.2-2.7 7.9-7 9.7-4.3-1.8-7-5.5-7-9.7V6l7-2.8Z" stroke={trusted ? "#30c77a" : "#9aa3af"} strokeWidth="1.8" strokeLinejoin="round" />
      {trusted && <path d="m8.7 12.1 2.1 2.1 4.5-4.7" stroke="#30c77a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

function ActionIcon({ kind }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
  if (kind === "connect") return <svg {...common}><path d="M9 15 15 9" /><path d="M10 6h8v8" /><path d="M19 14v3a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3" /></svg>;
  if (kind === "disconnect") return <svg {...common}><path d="M8 8 16 16M16 8l-8 8" /><path d="M19 14v3a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3" /></svg>;
  if (kind === "edit") return <svg {...common}><path d="m5 19 3.8-.8L18 9a2.1 2.1 0 0 0-3-3l-9.2 9.2L5 19Z" /><path d="m13.5 7.5 3 3" /></svg>;
  if (kind === "delete") return <svg {...common}><path d="M4 7h16M10 11v5m4-5v5M9 7l1-2h4l1 2m-9 0 1 12h10l1-12" /></svg>;
  return <svg {...common}><path d="M8 8v8m8-8v8" /></svg>;
}

/** Modal to view / copy / forget one trusted host's fingerprint. */
function HostKeyPopup({ host, port, known, copied, onCopy, onForget, forgetBusy, onClose }) {
  const key = `${host}:${port}`;
  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.dialog} onClick={(event) => event.stopPropagation()}>
        <div style={styles.dialogTitle}>{t(`主机指纹 · ${host}:${port}`)}</div>
        <div style={styles.meta}>{known.algorithm || "ssh-host-key"}</div>
        <Field label={t("SHA-256 指纹")} hint={t("可与此服务器上 ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub 的输出比对")}>
          <div style={styles.fingerprint}>SHA256:{known.fingerprint}</div>
        </Field>
        <div style={styles.meta}>{t(`首次信任 ${new Date(known.firstSeenAt).toLocaleString()} · 最近 ${new Date(known.lastSeenAt).toLocaleString()}`)}</div>
        <div style={styles.actions}>
          <button type="button" onClick={() => onCopy(host, port, known.fingerprint)} style={styles.secondary}>{copied === key ? t("已复制") : t("复制指纹")}</button>
          <button type="button" disabled={forgetBusy === key} onClick={() => onForget(host, port)} style={styles.danger}>{forgetBusy === key ? t("忘记中…") : t("忘记指纹")}</button>
          <button type="button" onClick={onClose} style={styles.secondary}>{t("关闭")}</button>
        </div>
      </div>
    </div>
  );
}

export function SshResources({ api, credentials }) {
  // Repaint on language change: every t() call below re-evaluates per render.
  useLanguage();
  const [profiles, setProfiles] = useState([]);
  const [sharedCredentials, setSharedCredentials] = useState([]);
  const [credentialEditor, setCredentialEditor] = useState(null);
  const [groups, setGroups] = useState([]);
  // Resource groups begin collapsed, keeping a long server list compact until
  // the user opens the group they need. This is display-only state.
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editor, setEditor] = useState(null);
  const [connecting, setConnecting] = useState(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);
  // Which setup panel the segmented switcher shows: "servers" | "settings" | "shortcuts".
  // 服务器分组与共享凭据合并到同一个页签（用户 2026-10-18）。
  const [setupTab, setSetupTab] = useState("servers");
  // 服务器与凭据页签里的两个折叠框（用户 2026-10-19）：服务器管理默认展开，凭据默认折叠。
  const [openGroups, setOpenGroups] = useState({ servers: true, credentials: false });
  const toggleSettingGroup = (name) => (open) => setOpenGroups((previous) => ({ ...previous, [name]: open }));
  const [knownHosts, setKnownHosts] = useState([]);
  const [forgetBusy, setForgetBusy] = useState(null);
  const [copiedHostKey, setCopiedHostKey] = useState(null);
  const [hostKeyPopup, setHostKeyPopup] = useState(null);
  // null = not loaded yet; the checkbox stays disabled until the host answers.
  const [agentAutoConnect, setAgentAutoConnect] = useState(null);
  const [agentSaving, setAgentSaving] = useState(false);
  // 代理库（设置页统一维护；资源编辑器里从库里选或单独手填）。
  const [proxyLibrary, setProxyLibrary] = useState([]);
  // Self-update: 检查更新 opens the dialog and runs a check; the meta rows,
  // manual-update command and auto-update all live inside the dialog.
  // The interface follows the host's language automatically (root resolver);
  // there is no manual language switch by design.
  const [updateOpen, setUpdateOpen] = useState(false);
  const [update, setUpdate] = useState(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState(null);
  const [copied, setCopied] = useState(false);

  const fetchUpdate = async (method) => {
    setUpdateBusy(true);
    setUpdateError(null);
    try {
      const response = await fetch(UPDATE_ENDPOINT, method === "POST" ? {
        method: "POST",
        headers: { "content-type": "application/json", "x-dsh-xssh-ops-update": "1" },
        body: "{}"
      } : { cache: "no-store" });
      const value = await response.json().catch(() => null);
      if (!response.ok) throw new Error(value?.error ?? `HTTP ${response.status}`);
      setUpdate(value);
      return value;
    } catch (cause) {
      setUpdateError(cause?.message ?? String(cause));
      return null;
    } finally {
      setUpdateBusy(false);
    }
  };

  const openUpdateDialog = () => {
    setUpdateOpen(true);
    setCopied(false);
    if (update === null) void fetchUpdate("GET");
  };

  const copyUpdateCommand = async () => {
    const profile = update?.profileName ?? "web";
    try {
      await navigator.clipboard.writeText(`dsh plugin --profile ${profile} add https://github.com/sqx6781268/dsh-xssh-ops`);
      setCopied(true);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    }
  };

  const refresh = async ({ showLoading = true } = {}) => {
    // Poll ticks must not flip the loading flag: the list would unmount and
    // remount every 5 seconds (flicker, scroll and focus loss).
    if (showLoading) setLoading(true);
    try {
      const [profileResult, groupResult, knownResult, credentialResult] = await Promise.all([
        api.profileList(),
        api.groupList(),
        api.listKnownHosts?.().catch(() => ({ hosts: [] })) ?? { hosts: [] },
        api.credentialList()
      ]);
      setProfiles(profileResult.profiles);
      setGroups(groupResult.groups);
      setKnownHosts(knownResult.hosts ?? []);
      setSharedCredentials(credentialResult.credentials ?? []);
      // Deliberately no setError(null) here: this also runs on a 5s poll, and
      // wiping the banner would erase a connect failure before anyone reads it.
      // User actions clear the error when they start.
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try { await migrateLegacyProfiles(api); } catch {}
      // The auto-connect switch is a stored operator setting, not polled live
      // data: load it once and let the toggle own it from there.
      try {
        const settings = await api.agentSettingsGet();
        if (alive) setAgentAutoConnect(settings.agentAutoConnect === true);
      } catch {
        if (alive) setAgentAutoConnect(false);
      }
      // 代理库与资源列表一样是低频配置数据，进页面拉一次即可。
      try {
        const keepAlive = await api.keepAliveGet();
        const value = keepAlive?.value ?? keepAlive;
        if (alive) setProxyLibrary(Array.isArray(value?.proxyLibrary) ? value.proxyLibrary : []);
      } catch { /* 代理库缺失不影响资源页 */ }
      if (alive) await refresh();
    })();
    // The connected badge reflects live server-side connections, which also
    // change from outside this page (SSH panel ×, agent, disconnects). Poll
    // so the badge and its 断开 control never go stale.
    const timer = setInterval(() => { if (alive) refresh({ showLoading: false }); }, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [api]);

  const toggleAgentAutoConnect = async (event) => {
    const next = event.target.checked;
    setAgentSaving(true);
    try {
      const saved = await api.agentSettingsSave(next);
      setAgentAutoConnect(saved.agentAutoConnect === true);
      setError(null);
    } catch (cause) {
      // Optimistic flip is rolled back so the checkbox never lies about what
      // the host will enforce.
      setError(cause?.message ?? String(cause));
      setAgentAutoConnect(!next);
    } finally {
      setAgentSaving(false);
    }
  };

  const connect = async (profile) => {
    setConnecting(profile.profileId);
    setError(null);
    try {
      // Fast-fail budget: an unreachable host settles in ~15s with a clear
      // error instead of a minute of silent retrying; the user can also
      // cancel the pending handshake explicitly.
      const connection = await api.profileConnect({ profileId: profile.profileId, readyTimeout: 15000, retries: 0 });
      const session = await api.openSession(connection.connectionId, 100, 30);
      if (profile.defaultProjectPath) {
        await api.changeDirectory(session.sessionId, profile.defaultProjectPath);
        sshUiSetProjectTarget(connection.connectionId, profile.defaultProjectPath);
      }
      const listed = await api.list();
      sshUiSetConnections(listed.connections);
      // This page owns no pane, so queue the connection for one to pick up and
      // ask the host to reveal the terminal. Without both halves a connect here
      // opened nothing and the new server never appeared in the panel.
      requestPaneOpen(connection.connectionId);
      // A successful connect must clear any stale panel error (e.g. an earlier
      // host-key mismatch) so the error bar doesn't linger after recovery.
      sshUiSetError(null);
      sshUiRequestSurface();
      await refresh();
    } catch (cause) {
      if (cause?.code === "connect-cancelled") return;
      const message = cause?.message ?? String(cause);
      sshUiSetError(message);
      setError(message);
    } finally {
      setConnecting(null);
    }
  };

  const cancelConnect = async (profile) => {
    try { await api.cancelProfileConnect({ profileId: profile.profileId }); } catch {}
    setConnecting(null);
  };

  const remove = async (profile) => {
    if (!window.confirm(t(`删除 SSH 资源“${profile.name}”？这会删除该资源保存的凭据，但不会断开已经建立的连接。`))) return;
    try {
      await api.profileDelete(profile.profileId);
      // Also drop the saved host-key trust record so the deleted server does
      // not linger in the "trusted hosts (not saved as resources)" group.
      try { await api.forgetHostKey(profile.host, profile.port); } catch {}
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    }
  };

  const disconnectProfile = async (profile) => {
    setError(null);
    try {
      await api.profileDisconnect(profile.profileId);
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    }
  };

  const createGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    setCreatingGroup(true);
    try {
      await api.groupSave({ name });
      setNewGroupName("");
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setCreatingGroup(false);
    }
  };

  const deleteGroup = async (group) => {
    if (!window.confirm(t(`删除分组“${group.name}”？其中 ${group.profileCount} 台服务器会移到“未分组”，不会断开已建立的连接。`))) return;
    try {
      await api.groupDelete(group.groupId);
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    }
  };

  const forgetHost = async (host, port, confirmMessage) => {
    if (!window.confirm(confirmMessage ?? t(`忘记 ${host}:${port} 的主机指纹？下次连接将重新信任该服务器当前指纹。仅当服务器被合法重装/更换时才应操作。`))) return;
    const key = `${host}:${port}`;
    setForgetBusy(key);
    try {
      await api.forgetHostKey(host, port);
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setForgetBusy(null);
    }
  };

  const copyHostFingerprint = async (host, port, fingerprint) => {
    const key = `${host}:${port}`;
    try {
      if (!navigator.clipboard?.writeText) throw new Error(t("当前环境不支持复制到剪贴板"));
      await navigator.clipboard.writeText(`SHA256:${fingerprint}`);
      setCopiedHostKey(key);
      setTimeout(() => setCopiedHostKey((current) => current === key ? null : current), 1500);
    } catch (cause) {
      setError(cause?.message ?? t("无法复制主机指纹"));
    }
  };

  const groupedProfiles = new Map(groups.map((group) => [group.groupId, []]));
  const ungrouped = [];
  for (const profile of profiles) {
    const bucket = profile.groupId === null ? undefined : groupedProfiles.get(profile.groupId);
    if (bucket === undefined) ungrouped.push(profile);
    else bucket.push(profile);
  }
  // Known hosts addressed by host:port so each saved-server card shows a green
  // shield when trusted; hosts trusted without a saved resource get a tail row.
  const knownByHost = new Map(knownHosts.map((h) => [`${h.host}:${h.port}`, h]));
  const matchedHostKeys = new Set(profiles.map((p) => `${p.host}:${p.port}`));
  const unmatchedKnownHosts = knownHosts.filter((h) => !matchedHostKeys.has(`${h.host}:${h.port}`));

  const toggleGroup = (key) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderProfiles = (items) => items.length === 0 ? null : <div style={styles.list}>{items.map((profile) => (
    <div key={profile.profileId} style={styles.card}>
      <div style={styles.cardMain}>
        <div style={styles.cardTitle}>{profile.name}{profile.connected && <span style={styles.connected}>{t("已连接")}</span>}</div>
        <div style={styles.address}>{profile.username}@{profile.host}:{profile.port}</div>
        {profile.defaultProjectPath && <div style={styles.meta}>{t(`项目：${profile.defaultProjectPath}`)}</div>}
      </div>
      <div style={styles.cardActions}>
        {(() => {
          const kh = knownByHost.get(`${profile.host}:${profile.port}`);
          return (
            <button type="button" disabled={!kh} onClick={() => kh && setHostKeyPopup(kh)} title={kh ? t(`已信任主机指纹（${kh.algorithm}）· 点击查看/复制/忘记`) : t("尚未信任该主机指纹")} aria-label={kh ? t(`查看 ${profile.host}:${profile.port} 的主机指纹`) : t("尚未信任主机指纹")} style={styles.iconButton}><ShieldIcon trusted={!!kh} /></button>
          );
        })()}
        {profile.connected && <button type="button" onClick={() => disconnectProfile(profile)} title={t("断开连接")} aria-label={t(`断开 ${profile.name}`)} style={styles.actionTextButton}>{t("断开")}</button>}
        <button type="button" disabled={connecting === profile.profileId || !profile.credentialConfigured} onClick={() => connect(profile)} title={connecting === profile.profileId ? t("连接中") : profile.defaultProjectPath ? t(`进入项目 ${profile.defaultProjectPath}`) : t("连接并打开终端")} aria-label={profile.defaultProjectPath ? t(`进入 ${profile.name} 的项目目录`) : t(`连接 ${profile.name}`)} style={{ ...styles.actionTextButton, ...styles.actionTextPrimary }}>{connecting === profile.profileId ? t("连接中") : profile.defaultProjectPath ? t("进入项目") : t("连接")}</button>
        {connecting === profile.profileId && <button type="button" onClick={() => cancelConnect(profile)} title={t("取消连接")} aria-label={t(`取消连接 ${profile.name}`)} style={styles.iconButton}><ActionIcon kind="disconnect" /></button>}
        <button type="button" onClick={() => setEditor({ mode: "edit", profile })} title={t("编辑服务器")} aria-label={t(`编辑 ${profile.name}`)} style={styles.iconButton}><ActionIcon kind="edit" /></button>
        <button type="button" onClick={() => remove(profile)} title={t("删除服务器")} aria-label={t(`删除 ${profile.name}`)} style={{ ...styles.iconButton, ...styles.iconDanger }}><ActionIcon kind="delete" /></button>
      </div>
    </div>
  ))}</div>;

  return (
    <div style={styles.page}>
      <ResourceFormTheme />
      <div style={styles.pageHeader}>
        <div style={styles.titleRow}>
          <h2 style={styles.heading}>{t("SSH 资源")}</h2>
          <span className="dsh-xssh-ops-version" title={t("当前安装的插件版本")}>v{PLUGIN_VERSION}</span>
          <div style={styles.titleLinks}>
            <a className="dsh-xssh-ops-ubtn outline" href={GITHUB_URL} target="_blank" rel="noreferrer" title={GITHUB_URL}>
              <span className="dsh-xssh-ops-ubtn-icon"><GitHubMarkIcon /></span>GitHub
            </a>
            <button type="button" className="dsh-xssh-ops-ubtn outline" onClick={openUpdateDialog}>
              <span className="dsh-xssh-ops-ubtn-icon"><RefreshIcon /></span>{t("检查更新")}
            </button>
          </div>
        </div>
        <div style={styles.headerActions}>
          <label className="dsh-xssh-ops-agent-toggle" style={styles.agentToggle}>
            <input type="checkbox" checked={agentAutoConnect === true} disabled={agentAutoConnect === null || agentSaving} onChange={toggleAgentAutoConnect} style={styles.agentToggleBox} />
            <span>{t("AI 自动连接")}</span>
            <span role="tooltip" className="dsh-xssh-ops-agent-toggle-tip">{t("开启后，对话中的 AI 可按名称自行连接这里保存的服务器并切换当前连接（xssh_connect 的 target 参数）；每次连接都会在右侧面板打开终端，操作者始终可见。关闭时 AI 只能请你手动连接。默认关闭。")}</span>
          </label>
        </div>
      </div>
      <div className="dsh-xssh-ops-segmented" style={styles.segmented} role="tablist" aria-label={t("XSSH 配置分区")}>
        <span className="dsh-xssh-ops-segmented-thumb" aria-hidden="true" style={{ ...styles.segmentThumb, transform: setupTab === "settings" ? "translateX(calc(100% + 3px))" : setupTab === "shortcuts" ? "translateX(calc(200% + 6px))" : "translateX(0)" }} />
        <button type="button" role="tab" aria-selected={setupTab === "servers"} onClick={() => setSetupTab("servers")} className="dsh-xssh-ops-segment" style={setupTab === "servers" ? styles.segmentActive : styles.segment}>{t("服务器与凭据")}</button>
        <button type="button" role="tab" aria-selected={setupTab === "settings"} onClick={() => setSetupTab("settings")} className="dsh-xssh-ops-segment" style={setupTab === "settings" ? styles.segmentActive : styles.segment}>{t("连接设置")}</button>
        <button type="button" role="tab" aria-selected={setupTab === "shortcuts"} onClick={() => setSetupTab("shortcuts")} className="dsh-xssh-ops-segment" style={setupTab === "shortcuts" ? styles.segmentActive : styles.segment}>{t("快捷键")}</button>
      </div>
      {setupTab === "settings" && <section style={styles.groupPanel}><KeepAliveSettings api={api} /></section>}
      {setupTab === "shortcuts" && <section style={styles.groupPanel}><ShortcutsSettings api={api} /></section>}
      {setupTab === "servers" && (
        <>
          <SettingsGroup
            title={t("服务器管理")}
            digest={t(`${profiles.length} 台`)}
            open={openGroups.servers}
            onToggle={toggleSettingGroup("servers")}
          >
            <div style={styles.groupCreate}><input value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") createGroup(); }} placeholder={t("例如：生产环境")} style={{ ...styles.input, flex: 1, minWidth: 0, maxWidth: 340 }} /><button type="button" disabled={creatingGroup || !newGroupName.trim()} onClick={createGroup} style={styles.secondary}>{creatingGroup ? t("创建中…") : t("创建")}</button>  <span style={{ flex: 1 }} />
              <button type="button" style={styles.primary} onClick={() => setEditor({ mode: "new" })}>{t("新增服务器")}</button>
            </div>
            {groups.length > 0 && <div style={styles.groupChips}>{groups.map((group) => <span key={group.groupId} style={styles.groupChip}>{t(`${group.name}（${group.profileCount}）`)}<button type="button" onClick={() => deleteGroup(group)} title={t(`删除分组 ${group.name}`)} style={styles.chipDelete}>×</button></span>)}</div>}
                  {error && <div style={styles.error} role="alert">{error}</div>}
      {loading ? <div style={styles.empty}>{t("加载 SSH 资源中…")}</div> : profiles.length === 0 ? <div style={styles.empty}>{t("还没有保存的服务器。新增后可一键连接并打开右侧终端。")}</div> : <div style={styles.groupedList}>{groups.map((group) => {
        const key = `group:${group.groupId}`;
        const collapsed = !expandedGroups.has(key);
        const items = groupedProfiles.get(group.groupId) ?? [];
        return <section key={group.groupId}>
          <button type="button" onClick={() => toggleGroup(key)} aria-expanded={!collapsed} style={styles.groupHeadingButton}>
            <span style={styles.groupHeading}>{collapsed ? "▸" : "▾"} {group.name} <span style={styles.groupCount}>{t(`（${items.length}）`)}</span></span>
          </button>
          {!collapsed && (renderProfiles(items) || <div style={styles.groupEmpty}>{t("这个分组还没有服务器。")}</div>)}
        </section>;
      })}{ungrouped.length > 0 && (() => {
        const key = "ungrouped";
        const collapsed = !expandedGroups.has(key);
        return <section>
          <button type="button" onClick={() => toggleGroup(key)} aria-expanded={!collapsed} style={styles.groupHeadingButton}>
            <span style={styles.groupHeading}>{t(`${collapsed ? "▸" : "▾"} 未分组`)}<span style={styles.groupCount}>{t(`（${ungrouped.length}）`)}</span></span>
          </button>
          {!collapsed && renderProfiles(ungrouped)}
        </section>;
      })()}</div>}

                  {unmatchedKnownHosts.length > 0 && (
        <div>
          <div style={styles.groupTitle}>{t("已信任主机（未保存为资源）")}</div>
          <div style={styles.list}>{unmatchedKnownHosts.map((h) => {
            const key = `${h.host}:${h.port}`;
            return (
              <div key={key} style={styles.card}>
                <div style={styles.cardMain}>
                  <div style={styles.cardTitle}>{h.host}:{h.port}</div>
                  <div style={styles.meta}>{t(`${h.algorithm || "ssh-host-key"} · 首次信任 ${new Date(h.firstSeenAt).toLocaleString()}`)}</div>
                </div>
                <div style={styles.cardActions}>
                  <button type="button" onClick={() => setHostKeyPopup(h)} title={t("查看/复制/忘记主机指纹")} aria-label={t(`查看 ${h.host}:${h.port} 的主机指纹`)} style={styles.iconButton}><ShieldIcon trusted /></button>
                  <button type="button" disabled={forgetBusy === key} onClick={() => forgetHost(h.host, h.port, t(`删除 ${h.host}:${h.port} 的信任记录？此主机未保存为资源，删除后将从「已信任主机」列表移除；下次连接将重新信任其当前指纹。`))} title={t("删除这条信任记录（仅清理临时使用过的主机）")} aria-label={t(`删除 ${h.host}:${h.port} 的信任记录`)} style={{ ...styles.iconButton, ...styles.iconDanger }}><ActionIcon kind="delete" /></button>
                  <button type="button" onClick={() => setEditor({ mode: "new", profile: { profileId: undefined, name: h.host, host: h.host, port: h.port, username: "root", authKind: "password", hostKeyMode: "accept-new" } })} title={t("把该服务器保存为 SSH 资源（可改用户名与认证方式）")} style={styles.secondary}>{t("保存为资源")}</button>
                </div>
              </div>
            );
          })}</div>
        </div>
      )}

          </SettingsGroup>
          <SettingsGroup
            title={t("共享 SSH 凭据")}
            digest={t(`${sharedCredentials.length} 个`)}
            open={openGroups.credentials}
            onToggle={toggleSettingGroup("credentials")}
          >
            <div><button type="button" onClick={() => setCredentialEditor({})} style={styles.secondary}>{t("新增共享凭据")}</button></div>
            {sharedCredentials.length > 0 && <div style={styles.credentialList}>{sharedCredentials.map((item) => <div key={item.credentialId} style={styles.credentialRow}><span title={item.name} style={styles.credentialLabel}>{item.name} · {item.authKind === "key" ? t("私钥") : t("密码")}{item.secondaryConfigured ? " + " + (item.authKind === "key" ? t("密码") : t("私钥")) : ""} · {item.credentialConfigured ? t("已保存") : t("未配置")}</span><span style={styles.credentialActions}><button type="button" onClick={() => setCredentialEditor(item)} title={t(`编辑共享凭据 ${item.name}`)} aria-label={t(`编辑共享凭据 ${item.name}`)} style={styles.iconButton}>✎</button><button type="button" onClick={async () => { if (!window.confirm(t(`删除共享凭据“${item.name}”？仍被服务器或跳板机引用时不会删除。`))) return; try { await api.credentialDelete(item.credentialId); await refresh({ showLoading: false }); } catch (cause) { setError(cause?.message ?? String(cause)); } }} title={t(`删除共享凭据 ${item.name}`)} aria-label={t(`删除共享凭据 ${item.name}`)} style={{ ...styles.iconButton, color: "#f07171" }}>×</button></span></div>)}</div>}
          </SettingsGroup>
        </>
      )}
      {updateOpen && (
        <UpdateDialog
          status={update}
          busy={updateBusy}
          error={updateError}
          copied={copied}
          onCheck={() => void fetchUpdate("GET")}
          onUpdate={() => void fetchUpdate("POST")}
          onCopy={copyUpdateCommand}
          onClose={() => setUpdateOpen(false)}
        />
      )}
      {hostKeyPopup && (
        <HostKeyPopup host={hostKeyPopup.host} port={hostKeyPopup.port} known={hostKeyPopup} copied={copiedHostKey} onCopy={copyHostFingerprint} onForget={forgetHost} forgetBusy={forgetBusy} onClose={() => setHostKeyPopup(null)} />
      )}
      {editor && <ResourceEditor initial={editor.profile} groups={groups} profiles={profiles} sharedCredentials={sharedCredentials} proxyLibrary={proxyLibrary} api={api} credentials={credentials} onClose={() => setEditor(null)} onSaved={refresh} />}
      {credentialEditor && <SharedCredentialEditor initial={credentialEditor.credentialId ? credentialEditor : null} credentials={credentials} api={api} onClose={() => setCredentialEditor(null)} onSaved={refresh} />}
    </div>
  );
}

/**
 * Self-update dialog, modeled on @michengai/dsh-archive-manager's update
 * dialog: meta rows (running/latest/profile), a copyable manual-update
 * command, and re-check / auto-update actions.
 */
function UpdateDialog({ status, busy, error, copied, onCheck, onUpdate, onCopy, onClose }) {
  const latest = status?.latestVersion;
  const profile = status?.profileName ?? "web";
  let latestStatus;
  if (busy) {
    latestStatus = <span style={styles.updateMetaLabel}>{t("检查中…")}</span>;
  } else if (status?.updatedVersion !== undefined) {
    latestStatus = <span style={styles.updateOk}>{t(`已更新到 v${status.updatedVersion}，重启 DSH 后生效。`)}</span>;
  } else if (error !== null && error !== undefined) {
    latestStatus = <span style={styles.updateBad}>{t("检查失败")}：{error}</span>;
  } else if (status?.latestCheckFailed === true) {
    latestStatus = <span style={styles.updateBad}>{t("检查失败")}</span>;
  } else if (status?.updateAvailable === true) {
    latestStatus = <span style={styles.updateOk}>{t("发现新版本")}</span>;
  } else if (status !== null) {
    latestStatus = <span style={styles.updateOk}>{t("已是最新版本")}</span>;
  }
  const command = `dsh plugin --profile ${profile} add https://github.com/sqx6781268/dsh-xssh-ops`;
  return (
    <div style={styles.backdrop} onClick={busy ? undefined : onClose}>
      <div className="dsh-xssh-ops-resource-modal" style={styles.dialog} onClick={(event) => event.stopPropagation()}>
        <div style={styles.dialogTitle}>{t("dsh-xssh-ops 更新")}</div>
        <p style={styles.updateIntro}>{t("仅检查并更新当前插件，不会联动安装其他插件。")}</p>
        <div style={styles.updateMeta}>
          <span style={styles.updateMetaLabel}>{t("运行版本")}</span>
          <span style={styles.updateMono}>{status?.currentVersion ? `v${status.currentVersion}` : "—"}</span>
          <span style={styles.updateMetaLabel}>{t("最新版本")}</span>
          <span style={styles.updateMono}>{latest ? `v${latest}` : "—"}{latestStatus ? <>{" "}{latestStatus}</> : null}</span>
        </div>
        <div style={styles.updateDivider} />
        <div style={styles.updateHeading}>{t("手工更新")}</div>
        <p style={styles.updateIntro}>{t("自动更新失败时，可在当前 DSH 终端执行以下命令，完成后重启 DSH。")}</p>
        <div style={styles.updateCommand}>
          <code style={styles.updateCode}>{command}</code>
          <button type="button" style={styles.secondary} onClick={onCopy}>{copied ? t("已复制") : t("复制命令")}</button>
        </div>
        <div style={styles.actions}>
          <button type="button" style={styles.secondary} onClick={onCheck} disabled={busy}>{t("重新检查")}</button>
          <button
            type="button"
            style={styles.primary}
            onClick={onUpdate}
            disabled={busy || status?.updateAvailable !== true || status?.canAutoUpdate === false}
            title={status?.canAutoUpdate === false ? t("当前环境不支持自动更新，请使用手工更新。") : undefined}
          >{t("自动更新")}</button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  // Settings owns the foreground color in both light and dark appearances.
  // Do not fall back to a hard-coded dark label here: this client bundle is
  // rendered inside that surface and may not receive DSH's alias variables.
  page: { padding: "20px 2px", color: "inherit", maxWidth: 900 },
  pageHeader: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 18, marginBottom: 18 },
  heading: { margin: 0, fontSize: 18 }, description: { margin: "6px 0 0", fontSize: 13, color: "inherit", opacity: 0.76, lineHeight: 1.5 },
  list: { display: "grid", gap: 10 }, card: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: 14, border: "1px solid var(--dsw-alias-border-l2, #d8dce3)", borderRadius: 10 },
  cardMain: { minWidth: 0 }, cardTitle: { fontWeight: 650, fontSize: 14, display: "flex", gap: 8, alignItems: "center" }, address: { marginTop: 4, fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }, meta: { marginTop: 5, fontSize: 12, color: "inherit", opacity: 0.76 },
  connected: { fontSize: 11, color: "#32c56c", background: "rgba(50,197,108,.16)", padding: "2px 6px", borderRadius: 99 }, cardActions: { display: "flex", flexWrap: "nowrap", flexShrink: 0, justifyContent: "flex-end", gap: 7 },
  // Keep the label paired with DSH's primary fill.  In the default dark theme
  // the fill is light, so a hard-coded white label becomes invisible.
  primary: { border: 0, borderRadius: 7, padding: "7px 11px", background: "var(--dsw-alias-button-primary-fill, #2d6cdf)", color: "var(--dsw-alias-label-primary-foreground, #fff)", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" }, secondary: { border: "1px solid rgba(127,127,127,.55)", borderRadius: 7, padding: "6px 10px", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" }, iconButton: { border: "1px solid rgba(127,127,127,.48)", borderRadius: 8, width: 30, height: 30, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "rgba(127,127,127,.05)", color: "inherit", cursor: "pointer", lineHeight: 1 }, iconPrimary: { borderColor: "rgba(55,115,230,.45)", background: "rgba(55,115,230,.12)", color: "#3b75d9" }, iconDanger: { borderColor: "rgba(240,113,113,.38)", background: "rgba(240,113,113,.08)", color: "#e06060" }, actionTextButton: { border: "1px solid rgba(127,127,127,.48)", borderRadius: 7, padding: "5px 8px", background: "rgba(127,127,127,.05)", color: "inherit", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap" }, actionTextPrimary: { borderColor: "rgba(55,115,230,.45)", background: "rgba(55,115,230,.12)", color: "#3b75d9" }, danger: { border: 0, borderRadius: 7, padding: "6px 8px", background: "transparent", color: "#f07171", cursor: "pointer", fontSize: 13 },
  empty: { padding: 28, border: "1px dashed rgba(127,127,127,.55)", borderRadius: 10, color: "inherit", opacity: 0.76, textAlign: "center" },
  // `width: "100%"`：flex 容器默认收缩到内容宽（三段×固定内边距 ≈ 546px），在宿主
  // 设置弹窗（内容区 ~612px）里会**右侧留白**，三段看起来"只占两列"（实测抓到）。
  // 撑满后每段由 `flex: 1 1 0` 均分 —— 页签条与弹窗等宽、三段严格三等分。
  groupPanel: { border: "1px solid rgba(127,127,127,.55)", borderRadius: 10, padding: 12, marginBottom: 16, minWidth: 0 },
  // 合并页签（服务器与凭据）里的两个子块。
  subSection: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 },
  subSectionTitle: { fontSize: 12, fontWeight: 650, color: "var(--dsw-alias-label-secondary, #b9c0ca)" }, segmented: { position: "relative", display: "flex", width: "100%", gap: 3, padding: 3, borderRadius: 8, background: "rgba(127,127,127,.14)", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22))", marginBottom: 12 },
  // The track is neutral translucent grey, not a bg-layer token: this surface
  // resolves --dsw-alias-bg-layer-3 to white, which made the unselected segment
  // indistinguishable from the selected pill (2026-10-07).
  // The pill is one absolutely-positioned thumb that slides between segments so
  // switching animates instead of hopping; its width matches one segment and
  // the label buttons paint above it (zIndex 1), keeping hit-testing on them.
  // 滑块宽度必须是**三等分**：`calc(50% - 4.5px)` 是「两态页签」时期的遗留 —— 后来
  // 加了第三态「连接设置」，滑块没跟着改，于是选中高亮只盖住约一半宽（实测抓到：
  // 用户看到"三列页签、选择框只有两列"正是滑块与各段不齐）。三等分推导：
  // 每段宽 = (W - 6px 容器 padding - 6px 两个 gap) / 3，即 `calc((100% - 6px - 6px)/3)`
  // → 简化为 `calc(33.333% - 4px)`；位移在 JSX 里按 `translateX(段宽 + gap)` 计算。
  segmentThumb: { position: "absolute", top: 3, bottom: 3, left: 3, boxSizing: "border-box", width: "calc(33.333% - 4px)", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))", background: "var(--dsw-alias-button-elevated-fill, #fff)", boxShadow: "0 1px 2px rgba(0,0,0,.18)", transition: "transform .18s cubic-bezier(.4,0,.2,1)", pointerEvents: "none" },
  segment: { position: "relative", zIndex: 1, flex: "1 1 0", minWidth: 0, border: "1px solid transparent", borderRadius: 6, padding: "6px 10px", background: "transparent", color: "var(--dsw-alias-label-secondary, inherit)", cursor: "pointer", font: "inherit", fontSize: 13, lineHeight: "20px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  segmentActive: { position: "relative", zIndex: 1, flex: "1 1 0", minWidth: 0, border: "1px solid transparent", borderRadius: 6, padding: "6px 10px", background: "transparent", color: "var(--dsw-alias-label-primary, inherit)", cursor: "default", font: "inherit", fontSize: 13, lineHeight: "20px", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  groupTitle: { fontSize: 13, fontWeight: 650, marginBottom: 8 }, groupCreate: { display: "flex", gap: 8, flexWrap: "nowrap", alignItems: "center" }, groupChips: { display: "flex", gap: 7, flexWrap: "wrap", marginTop: 10 }, groupChip: { display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 7px", borderRadius: 99, background: "rgba(127,127,127,.16)", fontSize: 12 }, chipDelete: { border: 0, background: "transparent", color: "#f07171", cursor: "pointer", padding: 0, fontSize: 15, lineHeight: 1 }, credentialList: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 6, maxHeight: 168, overflowY: "auto", marginTop: 8, paddingRight: 2 }, credentialRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 5, minWidth: 0 }, credentialActions: { display: "flex", alignItems: "center", gap: 2 }, credentialLabel: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }, groupedList: { display: "grid", gap: 18 }, groupHeadingButton: { border: 0, padding: 0, margin: "0 0 8px", background: "transparent", color: "inherit", cursor: "pointer", textAlign: "left" }, groupHeading: { fontSize: 14, fontWeight: 650 }, groupCount: { fontWeight: 400, opacity: 0.72 }, groupEmpty: { padding: 12, color: "inherit", opacity: 0.76, border: "1px dashed rgba(127,127,127,.55)", borderRadius: 8, fontSize: 12 },
  snippetForm: { display: "grid", gridTemplateColumns: "minmax(100px,.8fr) minmax(180px,2fr) minmax(110px,.7fr) auto", gap: 8, marginTop: 10, alignItems: "center" }, snippetList: { display: "grid", gap: 7, marginTop: 10 }, snippetItem: { display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 10px", border: "1px solid rgba(127,127,127,.4)", borderRadius: 7, fontSize: 12 }, snippetScope: { marginLeft: 7, opacity: .7 }, snippetCommand: { marginTop: 4, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", opacity: .82, overflowWrap: "anywhere" }, fingerprint: { marginTop: 8, maxWidth: 560, overflowWrap: "anywhere", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, lineHeight: 1.45, opacity: 0.86 }, backdrop: { position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,.42)", display: "flex", alignItems: "center", justifyContent: "center" }, dialog: { width: 440, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100vh - 32px)", overflow: "auto", background: "var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay, #fff))", color: "var(--dsw-alias-label-primary, inherit)", borderRadius: 12, padding: 18, boxShadow: "0 20px 60px rgba(0,0,0,.28)", display: "flex", flexDirection: "column", gap: 11 }, dialogTitle: { fontSize: 16, fontWeight: 650 },
  field: { display: "flex", flexDirection: "column", gap: 5, fontSize: 13 }, hint: { color: "var(--dsw-alias-label-secondary, inherit)", fontWeight: 400 },
  formGrid: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }, advToggle: { border: 0, padding: 0, background: "transparent", color: "inherit", opacity: 0.76, cursor: "pointer", fontSize: 13, textAlign: "left", alignSelf: "flex-start" },
  // 分组分隔线（用户 2026-10-18 要求"比较长的一条线"）：线独占一行全宽，
  // 标题在线下方左对齐 —— 之前 flex 横排让线被标题挤成半边，不美观。
  advSection: { gridColumn: "1 / -1", marginTop: 6 }, advSectionLine: { width: "100%", height: 1, background: "var(--dsw-alias-border-l2, rgba(127,127,127,.3))", border: 0, margin: "0 0 6px 0" }, advSectionTitle: { display: "block", fontSize: 12, fontWeight: 650, opacity: 0.85, marginBottom: 4 },
  titleRow: { display: "flex", alignItems: "center", gap: "8px 12px", minWidth: 0, flexWrap: "wrap" },
  titleLinks: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  updateIntro: { margin: "0 0 14px", fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-secondary, #8b93a1)" },
  updateMeta: { display: "grid", gridTemplateColumns: "max-content minmax(0,1fr)", gap: "8px 18px", margin: "0 0 16px", fontSize: 12, lineHeight: "18px" },
  updateMetaLabel: { color: "var(--dsw-alias-label-secondary, #8b93a1)" },
  updateMono: { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" },
  updateOk: { color: "#2ea44f" },
  updateBad: { color: "#f07171" },
  updateDivider: { borderTop: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))", margin: "4px 0 14px" },
  updateHeading: { margin: "0 0 6px", fontSize: 14, lineHeight: "20px", fontWeight: 600 },
  updateCommand: { display: "flex", alignItems: "flex-start", gap: 8, border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))", borderRadius: 7, padding: 10, background: "var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1, #101418))" },
  updateCode: { minWidth: 0, flex: 1, fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 12, lineHeight: "18px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  agentToggle: { display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, whiteSpace: "nowrap", marginTop: 4, cursor: "pointer", color: "inherit" }, agentToggleBox: { accentColor: "#2ea44f", width: 15, height: 15, margin: 0, cursor: "pointer" }, headerActions: { display: "flex", alignItems: "flex-start", gap: 14, flexShrink: 0 }, input: { width: "100%", boxSizing: "border-box", border: "1px solid var(--dsw-alias-border-l4, rgba(127,127,127,.55))", borderRadius: 7, padding: "7px 8px", background: "var(--dsw-alias-bg-layer-1, #101418)", color: "var(--dsw-alias-label-primary, inherit)", fontSize: 13 }, credentialColumns: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }, jumpRow: { display: "grid", gridTemplateColumns: "1fr auto", gap: 5, alignItems: "center", marginBottom: 6 }, check: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#f07171" }, actions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }, error: { padding: "8px 10px", borderRadius: 7, background: "rgba(240,113,113,.15)", color: "#ff8a8a", fontSize: 13 }
};

function ResourceFormTheme() {
  return <style>{`.dsh-xssh-ops-resource-modal input::placeholder, .dsh-xssh-ops-resource-modal textarea::placeholder { color: var(--dsw-alias-label-tertiary, #8b93a1); opacity: 1; } .dsh-xssh-ops-resource-modal input:focus-visible, .dsh-xssh-ops-resource-modal select:focus-visible, .dsh-xssh-ops-resource-modal textarea:focus-visible { outline: 2px solid var(--dsw-alias-button-primary-fill, #2d6cdf); outline-offset: 1px; border-color: var(--dsw-alias-button-primary-fill, #2d6cdf); } .dsh-xssh-ops-segment { transition: color .18s ease; } .dsh-xssh-ops-segment:hover:not([aria-selected="true"]) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); } .dsh-xssh-ops-segment:focus-visible { outline: 2px solid var(--dsw-alias-button-primary-fill, #2d6cdf); outline-offset: 1px; } @media (prefers-reduced-motion: reduce) { .dsh-xssh-ops-segmented-thumb, .dsh-xssh-ops-segment { transition: none; } } .dsh-xssh-ops-agent-toggle { position: relative; } .dsh-xssh-ops-version { margin-left: 2px; color: var(--dsw-alias-label-tertiary, #a0a0a0); font-family: inherit; font-size: 12px; font-weight: 500; line-height: 18px; letter-spacing: 0; white-space: nowrap; vertical-align: baseline; } .dsh-xssh-ops-ubtn { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; border: none; border-radius: var(--dsw-radius-sm, 6px); cursor: pointer; font-size: 12px; line-height: 18px; height: 28px; padding: 0 10px; color: var(--dsw-alias-label-primary, inherit); background: transparent; text-decoration: none; font-family: inherit; } .dsh-xssh-ops-ubtn:disabled { cursor: not-allowed; opacity: .4; } .dsh-xssh-ops-ubtn.outline { border: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.55)); background: transparent; } .dsh-xssh-ops-ubtn.outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); } .dsh-xssh-ops-ubtn.primary { background: var(--dsw-alias-button-primary-fill, #2d6cdf); color: var(--dsw-alias-label-primary-foreground, #fff); } .dsh-xssh-ops-ubtn.primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #255cba); } .dsh-xssh-ops-ubtn .dsh-xssh-ops-ubtn-icon { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; } .dsh-xssh-ops-ubtn .dsh-xssh-ops-ubtn-icon svg { display: block; width: 16px; height: 16px; } .dsh-xssh-ops-agent-toggle-tip { position: absolute; top: calc(100% + 8px); right: 0; z-index: 60; width: 340px; max-width: 72vw; padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(0,0,0,.25); background: #2b2f36; color: #fff; font-size: 12px; line-height: 1.6; text-align: left; white-space: normal; box-shadow: 0 8px 24px rgba(0,0,0,.24); opacity: 0; visibility: hidden; transform: translateY(-2px); pointer-events: none; transition: opacity .12s ease .15s, transform .12s ease .15s, visibility 0s linear .27s; } .dsh-xssh-ops-agent-toggle:hover .dsh-xssh-ops-agent-toggle-tip, .dsh-xssh-ops-agent-toggle:focus-within .dsh-xssh-ops-agent-toggle-tip { opacity: 1; visibility: visible; transform: translateY(0); transition-delay: .15s, .15s, 0s; }`}</style>;
}
