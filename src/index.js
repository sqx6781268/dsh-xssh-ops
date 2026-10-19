/**
 * dsh-xssh-ops host half: a Typert Remote service named `xsshOps` that manages
 * ssh2 connections and PTY shell sessions, streaming output to the browser
 * through long-poll reads. Also registers agent tools (xssh_connect, xssh_exec,
 * ...) so the main conversation can drive the same sessions the panel shows.
 */
import { createTerminalOutput } from "./terminal-output.js";
import { randomUUID } from "node:crypto";
import { findReusableProfileConnection } from "./profile-connection.js";
import { resolveProfileRef, noConnectionGuidance, AUTO_CONNECT_DISABLED_MESSAGE } from "./agent-connect.js";
import net from "node:net";
import { Client } from "ssh2";
import { Service } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { z } from "zod";
import { CATEGORY_DELETE_FILES, assessShellCommand, isPrefillable, shellQuote } from "./safety.js";
import { EXEC_CWD_ERROR_PREFIX, buildCwdAwareCommand, execEchoWarning, extractExecCwd, posixLoginShell } from "./exec-cwd.js";
import { buildTrashCommand, parseSimpleDeleteCommand, parseTrashOutput } from "./trash.js";
import { scpCommand, scpDownload, scpUpload } from "./scp.js";
import { redactForModel } from "./redact.js";
import { isTransientConnectError } from "./net-errors.js";
import { isIdentMismatchError, withRepairedBanner } from "./ssh-banner.js";
import { createAuthTracker, makeAuthHandler, classifyConnectFailure, formatConnectFailure, wasAuthCut } from "./ssh-auth.js";
import { applyAgentForwarding } from "./ssh-agent.js";
import { processTerminalInput } from "./terminal-input.js";
import { fail } from "./envelope.js";
import { POLICY_NOTICE_PREFIX, DANGEROUS_DEFAULT_REASON } from "./policy-messages.js";
import { attachSocks5 } from "./socks5.js";
import { socks5Connect } from "./socks5-client.js";
import { SessionLogStore } from "./session-log.js";
import {
  createLineJournal,
  formatNumberedLines,
  DEFAULT_MAX_LINES as LINE_JOURNAL_MAX_LINES,
  DEFAULT_MAX_BYTES as LINE_JOURNAL_MAX_BYTES
} from "./line-journal.js";
import {
  createCommandLedger,
  createCommandLedgerStore,
  DEFAULT_IDLE_CLOSE_MS as COMMAND_IDLE_CLOSE_MS
} from "./command-ledger.js";
import {
  createLoginScriptRunner,
  validateRules as validateLoginScriptRules,
  DEFAULT_STEP_TIMEOUT_MS as LOGIN_SCRIPT_STEP_TIMEOUT_MS,
  DEFAULT_MATCH_MODE as LOGIN_SCRIPT_MATCH_MODE
} from "./login-script.js";
import { createScriptRunner, loadScriptSource, validateScriptSettings } from "./login-script-dsl.js";
import { createIdleStringSender } from "./idle-string.js";
import { createTaskLedger } from "./task-ledger.js";
import {
  decideLocation,
  localTaskDir,
  parseProbe,
  parseStatus,
  probeCommand,
  remoteDeleteCommand,
  remoteStatusCommand,
  remoteTaskDir,
  remoteTaskFiles,
  remoteWrapperCommand,
  resolveRemoteTaskDir,
  shellSingleQuote,
  DEFAULT_MIN_REMOTE_FREE_KB
} from "./task-dir.js";
import { SHELL_FAMILY_PROBE, ShellIntegrationTracker, parseShellFamilyProbe, shellIntegrationCommand } from "./shell-integration.js";
import { homedir, tmpdir } from "node:os";
import { join as joinPath, dirname as dirnamePath, relative as relativePath } from "node:path";
import {
  mkdir as fsMkdir,
  readdir as fsReaddir,
  stat as fsStat,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  rm as fsRm
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { runTransferTasks, joinRemotePath, splitRemotePath } from "./sftp-dir.js";
import {
  KnownHosts,
  decideHostKey,
  keyFingerprint,
  blobAlgorithm,
  DEFAULT_HOST_KEY_MODE
} from "./hostkey.js";
import { registerSshSessionTools } from "./tools/ssh-session.js";
import { registerResourceTools } from "./tools/resource.js";
import { registerTerminalLineTools } from "./tools/terminal-lines.js";
import { registerBackgroundTools } from "./tools/exec-background.js";
import { registerSftpTools } from "./tools/sftp.js";
import { registerTunnelTools } from "./tools/tunnel.js";
import { registerSessionLogTools } from "./tools/session-log.js";
import { t, setLanguage } from "./i18n/core.js";
import { registerPluginUpdater, UPDATE_ENDPOINT } from "./plugin-updater.js";

const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_CAPTURE_BYTES = 128 * 1024;
const READ_TIMEOUT_MS = 300;
const MAX_SESSIONS = 64;
// ssh2 disables keepalives by default; without them NATs and cloud firewalls
// silently drop idle connections and every later operation fails on a dead
// transport. Keep the mapping alive and detect a truly dead link fast.
//
// 注意：保活**间隔**没有常量 —— R8① 起它来自设置（默认 60 s，见 connectConfig 处），
// 上游硬编码的 20 s 常量已随之删除（留着就是死代码，lint 会报）。
const KEEPALIVE_COUNT_MAX = 3;
// Transient connect failures (resets, timeouts, scanner-induced refusals) are
// retried with backoff; authentication failures are never retried.
const CONNECT_RETRIES = 3;

/**
 * Key-exchange algorithms for Huawei legacy VRP (S12712 and similar switches,
 * also some old IOS/Comware builds). Such devices offer ONLY SHA-1 group14 and
 * reject every modern KEX, so the handshake dies with "no matching key
 * exchange algorithm" and the device looks simply unreachable.
 *
 * ssh2 ships `diffie-hellman-group14-sha1` in SUPPORTED_KEX but deliberately
 * leaves it out of DEFAULT_KEX (SHA-1 KEX is no longer considered secure), so
 * it must be opted into explicitly. `append` places these after every modern
 * algorithm: a modern peer still negotiates modern, and only a peer that
 * speaks nothing else lands on SHA-1. Scope is deliberately KEX-only — host
 * key and cipher policy are left at ssh2's defaults.
 */
export const LEGACY_VRP_ALGORITHMS = Object.freeze({
  kex: { append: ["diffie-hellman-group14-sha1"] }
});

/**
 * True when the handshake failed because the two sides share no KEX algorithm
 * (as opposed to a wrong password, an unreachable host, or a timeout). Only
 * this specific failure justifies retrying with legacy algorithms — matching
 * anything broader would silently weaken every failing connection.
 */
export function isKexMismatchError(error) {
  const message = String(error?.message ?? error ?? "");
  return /no matching key exchange|no matching kex|key exchange algorithm/i.test(message);
}
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_WAIT_MS = 30000;
// Stream push keepalive: when the terminal is idle the generator still yields
// an empty item at this cadence, so the client can tell a live-but-quiet
// terminal from a dead WebSocket mux.
const STREAM_HEARTBEAT_MS = 15000;
// Streaming file plane (workbench S6 patch): plain-HTTP byte routes registered
// on the DSH webserver, guarded by the connection service's Host/Origin +
// browser-cookie fence (the same guard the typert gateway applies to /api and
// /api/remote.mux). Raw bytes on the wire — no base64 envelope, and no
// whole-file buffering on either side of the ssh2 SFTP streams.
const STREAM_ROUTE_PREFIX = "/xssh-ops/stream";
// 本地资产路由（用户 2026-10-19）：插件目录里的静态文件无法被页面直接请求
// （/plugins/<id>/... 全部 404），所以由 host 提供 lib/ 下的白名单文件，
// 前端按需 <script>/<link> 加载（Monaco 等大组件不在首屏 bundle 里）。
const ASSET_ROUTE_PREFIX = "/xssh-ops/assets";
const ASSET_FILES = new Set(["monaco.min.js", "monaco.min.css", "file-viewer.min.js"]);
const STREAM_HIGH_WATER_MARK = 256 * 1024;
// Zombie-upload bound: a paused request cannot observe the client's FIN while
// unread body bytes precede it (Node reports request close only after the body
// drains), so an idle-socket timeout backstops the cancelled-upload cleanup.
const STREAM_IDLE_TIMEOUT_MS = 30000;
// batchRun opens a full SSH connect + exec per target; an unbounded Promise.all
// would storm every selected server (and any rate-limited network path between)
// at once. Worker-pool the targets instead.
const BATCH_MAX_CONCURRENCY = 4;
// Upper bound for one SFTP/SCP read (agent tools may lower it via max_bytes).
const MAX_FILE_READ_BYTES = 4 * 1024 * 1024;
// Late readers can still see the exit status of the N most recently exited
// sessions (session tombstones).
const MAX_EXIT_TOMBSTONES = 64;

const profileRecordSchema = z.object({
  name: z.string(),
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  authKind: z.enum(["password", "key"]),
  groupId: z.string().uuid().nullable(),
  // Host-key TOFU mode persisted per saved server; optional so records saved
  // before this feature existed still load (treated as the accept-new default).
  hostKeyMode: z.string().optional(),
  // Optional shared credential and jump chain.  Both are optional so the
  // domain can read every pre-0.3.3 resource without migration.
  credentialId: z.string().uuid().nullable().optional(),
  // Optional so already-saved resources load without a storage migration.
  // Nullable because profileSave persists `null` for "no project directory"
  // (the request schema accepts an explicit null to clear the entry) and DSH
  // re-validates every stored record when it reopens the domain at boot.
  // This is metadata only; it never contains credentials or shell syntax.
  defaultProjectPath: z.string().nullable().optional(),
  // Optional so pre-0.3.x resources load without a migration. Unlike
  // defaultProjectPath this IS shell syntax: it replaces the login shell of
  // terminal sessions (exec + pty) and runs with the resource's own authority,
  // so it is operator-authored config, never agent-writable mid-session.
  loginCommand: z.string().nullable().optional(),
  proxyJump: z.array(z.union([z.object({ profileId: z.string().uuid() }), z.object({
    host: z.string(), port: z.number().int(), username: z.string(),
    authKind: z.enum(["credential", "password", "key"]).optional(), credentialId: z.string().uuid().optional(), hostKeyMode: z.string().optional()
  })])).optional(),
  // Upstream SOCKS5 proxy (dial the proxy first, then the server). Optional so
  // pre-feature records load without a storage migration or a domain-version
  // bump. Coordinates only — the password is kept in the credential store, so
  // an inline password is stripped here and never persisted on the record.
  proxy: z.object({
    type: z.literal("socks5"),
    host: z.string(),
    port: z.number().int(),
    username: z.string().optional()
  }).optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const credentialRecordSchema = z.object({
  name: z.string(),
  authKind: z.enum(["password", "key"]),
  createdAt: z.string(),
  updatedAt: z.string()
});

const groupRecordSchema = z.object({
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});

// Exported (with the credential, DB-profile and known-host specs below) so
// tests can assert that the records each save path writes satisfy the schemas
// DSH re-validates when it reopens the domain at boot.
export const profileDomainSpec = defineDomain({
  name: "xssh_ops_profiles",
  version: 1,
  tables: {
    profiles: domainTable(profileRecordSchema),
    groups: domainTable(groupRecordSchema)
  }
});

// Keep shared credentials in a new unit rather than bumping the established
// profile unit. DSH's JSON storage rejects in-place unit-version changes, and
// users' existing server profiles must never prevent the host from booting.
export const credentialDomainSpec = defineDomain({
  name: "xssh_ops_credentials",
  version: 1,
  tables: { credentials: domainTable(credentialRecordSchema) }
});

const knownHostRecordSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  algorithm: z.string(),
  fingerprint: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string()
});

export const knownHostDomainSpec = defineDomain({
  name: "xssh_ops_known_hosts",
  version: 1,
  tables: {
    known_hosts: domainTable(knownHostRecordSchema)
  }
});

// Operator-level plugin settings (one row, id "main"). New fields must be
// optional so records written by older builds keep loading.
const settingsRecordSchema = z.object({
  agentAutoConnect: z.boolean().optional(),
  // Interface language chosen by the operator ("zh" | "en"). Absent means
  // "never chosen explicitly", so the settings page adopts whatever DSH
  // Settings → Language is showing and writes that back.
  language: z.enum(["zh", "en"]).optional(),
  // When false, the host language is never followed or written back: the
  // stored `language` value is authoritative. Absent means "true" so first
  // installs behave exactly as before this flag existed.
  autoApplySystemLanguage: z.boolean().optional(),
  // ── R8 保持活动状态（计划 5.7 / 5.8）─────────────────────────────────────
  // ③ SSH 层保活：建连时映射 ssh2 的 keepaliveInterval/CountMax（替换上游硬编码 20 s）。
  sshKeepAliveEnabled: z.boolean().optional(),
  sshKeepAliveIntervalSec: z.number().int().min(5).max(3600).optional(),
  sshKeepAliveCountMax: z.number().int().min(1).max(20).optional(),
  // ② 网络空闲发字符串：默认关闭；字符串不自动附回车（Q14 未定，先按此）。
  idleStringEnabled: z.boolean().optional(),
  idleStringIntervalSec: z.number().int().min(0).max(3600).optional(),
  idleStringText: z.string().max(4096).optional(),
  // ③ TCP 保活包：ssh2 未公开 socket 句柄，拿不到就跳过并记日志（风险 #12）。
  tcpKeepAliveEnabled: z.boolean().optional(),
  tcpKeepAliveInitialDelaySec: z.number().int().min(1).max(86400).optional(),
  // ── R9 登录脚本 ─────────────────────────────────────────────────────────
  // 规则表顺序即执行顺序（上移/下移直接改数组下标）。
  loginScriptRulesEnabled: z.boolean().optional(),
  loginScriptRules: z.array(z.object({
    expect: z.string(),
    send: z.string(),
    timeoutMs: z.number().int().min(1000).max(600000).optional()
  })).optional(),
  expectMatchMode: z.enum(["substring", "glob", "regex"]).optional(),
  expectStepTimeoutMs: z.number().int().min(1000).max(600000).optional(),
  loginScriptRunEnabled: z.boolean().optional(),
  loginScriptPath: z.string().max(1024).optional(),
  loginScriptSandbox: z.enum(["restricted", "trusted"]).optional(),
  // ── 代理库（用户 2026-10-17 要求：设置页统一维护，资源里选择）───────────
  // 密码按明文随库保存（用户 2026-10-18 要求可核对展示，UI 只显示占位符）。
  // **必须声明在存储 schema 里**：domain 表按 schema 归一化记录，未声明的字段
  // 会在写入时被剥掉 —— 这正是代理库"保存后重启消失"的第二层原因。
  proxyLibrary: z.array(z.object({
    proxyId: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    username: z.string().max(128).optional(),
    password: z.string().max(256).optional()
  })).optional(),
  // 命令框发送规则（用户 2026-10-18）：默认 Enter 发送、Shift+Enter 换行，可改。
  sendRule: z.object({
    send: z.string().max(64).optional(),
    newline: z.string().max(64).optional()
  }).optional(),
  // 可配置快捷键（用户 2026-10-18）：keys 是 1–3 个键名（修饰键在前），
  // action 对应前端的动作表；custom-prompt 额外带提示词。
  shortcuts: z.array(z.object({
    id: z.string().min(1).max(64),
    keys: z.array(z.string().min(1).max(32)).min(1).max(3),
    action: z.string().min(1).max(64),
    prompt: z.string().max(4096).optional()
  })).max(64).optional(),
  // 鼠标与选择行为（用户 2026-10-18，参照 Windows Terminal 的鼠标/选择页）。
  mouse: z.object({
    middleClickPaste: z.boolean().optional(),
    rightClick: z.enum(["menu", "paste", "none"]).optional(),
    autoCopySelection: z.boolean().optional(),
    doubleClickSeparator: z.string().max(128).optional(),
    copyIncludeTrailingNewline: z.boolean().optional(),
    copyTrimTrailingWhitespace: z.boolean().optional(),
    copyTabsAsSpaces: z.boolean().optional(),
    urlLinks: z.boolean().optional(),
    urlPrefixes: z.string().max(512).optional(),
    ctrlClickOpenLink: z.boolean().optional()
  }).optional(),
  // 终端背景图（用户 2026-10-18）：本地图片 dataURL + 遮罩强度/模糊。
  terminalBackground: z.object({
    enabled: z.boolean().optional(),
    dataUrl: z.string().optional(),
    maskOpacity: z.number().int().min(0).max(100).optional(),
    blur: z.number().int().min(0).max(20).optional(),
    position: z.string().max(24).optional(),
    positionX: z.number().int().min(0).max(100).optional(),
    scale: z.number().int().min(10).max(400).optional(),
    stretch: z.boolean().optional()
  }).optional(),
  // 自定义提示词库（用户 2026-10-19）：{id,title,prompt}。
  customPrompts: z.array(z.object({
    id: z.string().min(1).max(64),
    title: z.string().max(80),
    prompt: z.string().max(4096)
  })).max(64).optional(),
  // 输出提示与会话日志自动清理（用户 2026-10-19）。
  // 终端字体与字号（用户 2026-10-19）。
  terminalFont: z.object({
    family: z.string().max(200).optional(),
    size: z.number().int().min(8).max(32).optional()
  }).optional(),
  outputWarnKB: z.number().int().min(0).max(10240).optional(),
  sessionLogAutoPruneEnabled: z.boolean().optional(),
  sessionLogMaxTotalMB: z.number().int().min(50).max(102400).optional(),
  sessionLogMaxAgeDays: z.number().int().min(0).max(3650).optional(),
  // 「批量发送说明已读」标记（用户 2026-10-19）：勾选「已知晓，以后不提示」后为 true。
  broadcastHintDismissed: z.boolean().optional(),
  // 终端文件名识别（下划线 + 点击打开，用户 2026-10-19），默认开。
  terminalFileLinks: z.boolean().optional(),
  // 文件页签跟随终端路径（用户 2026-10-19），默认开；关掉时终端文件名识别也失效。
  filesFollowTerminal: z.boolean().optional(),
  updatedAt: z.string().optional()
});

/** R8/R9 的默认值（计划 5.7）。读取器与设置页共用一份，避免两处默认值漂移。 */
export const KEEPALIVE_DEFAULTS = {
  sshKeepAliveEnabled: true,
  sshKeepAliveIntervalSec: 60,
  sshKeepAliveCountMax: 3,
  idleStringEnabled: false,
  idleStringIntervalSec: 0,
  idleStringText: "",
  tcpKeepAliveEnabled: false,
  tcpKeepAliveInitialDelaySec: 60,
  loginScriptRulesEnabled: false,
  loginScriptRules: [],
  expectMatchMode: "substring",
  expectStepTimeoutMs: 15000,
  loginScriptRunEnabled: false,
  loginScriptPath: "",
  loginScriptSandbox: "restricted"
};

// 命令框发送规则（用户 2026-10-18）：默认回车发送、Shift+回车换行。
export const DEFAULT_SEND_RULE = { send: "Enter", newline: "Shift+Enter" };

// 鼠标与选择行为（用户 2026-10-18，参照 Windows Terminal 的「鼠标 / 选择」页）。
export const MOUSE_DEFAULTS = {
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

/** 鼠标/选择配置归一化：未知取值回落默认，缺字段补默认。 */
export function normalizeMouseOptions(value) {
  const source = value ?? {};
  const bool = (key) => (typeof source[key] === "boolean" ? source[key] : MOUSE_DEFAULTS[key]);
  const text = (key, max) => (typeof source[key] === "string" ? source[key].slice(0, max) : MOUSE_DEFAULTS[key]);
  const rightClick = ["menu", "paste", "none"].includes(source.rightClick) ? source.rightClick : MOUSE_DEFAULTS.rightClick;
  return {
    middleClickPaste: bool("middleClickPaste"),
    rightClick,
    autoCopySelection: bool("autoCopySelection"),
    doubleClickSeparator: text("doubleClickSeparator", 128),
    copyIncludeTrailingNewline: bool("copyIncludeTrailingNewline"),
    copyTrimTrailingWhitespace: bool("copyTrimTrailingWhitespace"),
    copyTabsAsSpaces: bool("copyTabsAsSpaces"),
    urlLinks: bool("urlLinks"),
    urlPrefixes: text("urlPrefixes", 512),
    ctrlClickOpenLink: bool("ctrlClickOpenLink")
  };
}

// 终端背景图（用户 2026-10-18）：本地图片以 dataURL 存设置表，遮罩强度/模糊可调。
export const BACKGROUND_DEFAULTS = {
  enabled: false,
  dataUrl: "",
  maskOpacity: 60,
  blur: 0,
  // 背景位置（用户 2026-10-18）：center/tile/stretch/四角；positionX 是水平对齐，
  // 50 = 图片中点对齐终端宽度中点，0/100 = 左/右边缘对齐。
  position: "center",
  positionX: 50,
  // 缩放百分比（用户 2026-10-18）：100 = 原始尺寸。
  scale: 100,
  // 是否把图片拉伸铺满容器（用户 2026-10-18）：与位置/缩放正交；开启时可能变形。
  stretch: false,
  // 多图层背景（用户 2026-10-19）：每层 {id,dataUrl,maskOpacity,blur,position,positionX,scale,stretch}，
  // 数组顺序即渲染顺序（后面的层在上面）；旧版单图在归一化时迁移成一层。
  images: []
};
export const BACKGROUND_POSITIONS = ["center", "tile", "top-left", "top-center", "top-right", "left-center", "right-center", "bottom-left", "bottom-center", "bottom-right"];

/** 背景图配置归一化：dataURL 长度受限（防设置表被撑爆），数值夹紧。 */
export function normalizeTerminalBackground(value) {
  const source = value ?? {};
  const clampInt = (key, min, max) => {
    const numeric = Number(source[key]);
    if (!Number.isFinite(numeric)) return BACKGROUND_DEFAULTS[key];
    return Math.min(Math.max(Math.round(numeric), min), max);
  };
  // PNG/GIF 原样保存、不压缩不限制大小（用户 2026-10-18）：PNG 保留透明图层，
  // GIF 保留动图；只校验 MIME 前缀，避免非图片数据混进设置表。
  const dataUrl = typeof source.dataUrl === "string" && /^data:image\/[a-z0-9.+-]+;base64,/i.test(source.dataUrl)
    ? source.dataUrl
    : "";
  // 兼容旧值（用户 2026-10-18）：此前「拉伸」是 position 的一个选项，现在
  // 拆成独立开关；旧配置迁移为 position=center + stretch=true。
  const legacyStretch = source.position === "stretch";
  const position = BACKGROUND_POSITIONS.includes(source.position) ? source.position : BACKGROUND_DEFAULTS.position;
  const clampFor = (raw, key, min, max, fallback) => {
    const numeric = Number(raw?.[key]);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(Math.max(Math.round(numeric), min), max);
  };
  const imageEntry = (raw, index) => {
    const imageUrl = typeof raw?.dataUrl === "string" && /^data:image\/[a-z0-9.+-]+;base64,/i.test(raw.dataUrl) ? raw.dataUrl : "";
    const rawPosition = raw?.position === "stretch" ? "center" : raw?.position;
    return {
      id: typeof raw?.id === "string" && raw.id !== "" ? raw.id.slice(0, 64) : `layer-${index + 1}`,
      dataUrl: imageUrl,
      maskOpacity: clampFor(raw, "maskOpacity", 0, 100, BACKGROUND_DEFAULTS.maskOpacity),
      blur: clampFor(raw, "blur", 0, 20, BACKGROUND_DEFAULTS.blur),
      position: BACKGROUND_POSITIONS.includes(rawPosition) ? rawPosition : BACKGROUND_DEFAULTS.position,
      positionX: clampFor(raw, "positionX", 0, 100, BACKGROUND_DEFAULTS.positionX),
      scale: clampFor(raw, "scale", 10, 400, BACKGROUND_DEFAULTS.scale),
      stretch: raw?.stretch === true
    };
  };
  const rawImages = Array.isArray(source.images) ? source.images : [];
  let images = rawImages.map((raw, index) => imageEntry(raw, index)).filter((image) => image.dataUrl !== "").slice(0, 8);
  // 旧版单图迁移：没有 images 但有 dataUrl 时视为一层。
  if (images.length === 0 && dataUrl !== "") {
    images = [{
      id: "legacy",
      dataUrl,
      maskOpacity: clampInt("maskOpacity", 0, 100),
      blur: clampInt("blur", 0, 20),
      position,
      positionX: clampInt("positionX", 0, 100),
      scale: clampInt("scale", 10, 400),
      stretch: source.stretch === true || (legacyStretch && source.stretch === undefined)
    }];
  }
  const top = images[0] ?? null;
  return {
    enabled: source.enabled === true && images.length > 0,
    dataUrl: top?.dataUrl ?? "",
    maskOpacity: top?.maskOpacity ?? BACKGROUND_DEFAULTS.maskOpacity,
    blur: top?.blur ?? BACKGROUND_DEFAULTS.blur,
    position: top?.position ?? BACKGROUND_DEFAULTS.position,
    positionX: top?.positionX ?? BACKGROUND_DEFAULTS.positionX,
    scale: top?.scale ?? BACKGROUND_DEFAULTS.scale,
    stretch: top?.stretch ?? false,
    images
  };
}

// 终端字体与字号（用户 2026-10-19）：默认等宽字体 + 13px。
export const TERMINAL_FONT_DEFAULTS = {
  family: 'Menlo, Monaco, "Courier New", monospace',
  size: 13
};
export function normalizeTerminalFont(value) {
  const source = value ?? {};
  const family = typeof source.family === "string" && source.family.trim() !== ""
    ? source.family.slice(0, 200)
    : TERMINAL_FONT_DEFAULTS.family;
  const size = Number.isSafeInteger(source.size) ? Math.min(Math.max(source.size, 8), 32) : TERMINAL_FONT_DEFAULTS.size;
  return { family, size };
}

// 输出提示与会话日志自动清理（用户 2026-10-19）：设置项默认值。
//   - outputWarnKB：终端累计输出超过该值就提示一次（0 = 关闭）；
//   - sessionLog*：会话日志按总量/天数自动清理。
export const OUTPUT_LOG_DEFAULTS = {
  outputWarnKB: 256,
  sessionLogAutoPruneEnabled: true,
  sessionLogMaxTotalMB: 500,
  sessionLogMaxAgeDays: 30
};

// 自定义提示词（用户 2026-10-19）：从快捷键里独立出来的提示词库，
// 可在快捷键动作与终端选区右键菜单里引用。
export function normalizeCustomPrompts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 64)
    .map((item) => ({
      id: String(item?.id ?? "").trim() || randomUUID(),
      title: String(item?.title ?? "").slice(0, 80),
      prompt: String(item?.prompt ?? "").slice(0, 4096)
    }))
    .filter((item) => item.prompt.trim() !== "");
}

/** 发送规则归一化：空/缺失回落到默认值，避免保存出无法匹配的组合。 */
export function normalizeSendRule(value) {
  const send = typeof value?.send === "string" && value.send.trim() !== "" ? value.send.trim() : DEFAULT_SEND_RULE.send;
  const newline = typeof value?.newline === "string" && value.newline.trim() !== "" ? value.newline.trim() : DEFAULT_SEND_RULE.newline;
  return { send, newline };
}

export const settingsDomainSpec = defineDomain({
  name: "xssh_ops_settings",
  version: 1,
  tables: {
    settings: domainTable(settingsRecordSchema)
  }
});

const SETTINGS_ROW_ID = "main";

/**
 * Interpret one persisted settings record into the runtime switches. Absent
 * `autoApplySystemLanguage` means "true" (follow the host), which is also what
 * a first install must behave like. Extracted so boot and tests share one
 * reading of the record.
 */
export function loadSettingsRecord(record = {}) {
  return {
    agentAutoConnect: record.agentAutoConnect === true,
    language: record.language === "zh" || record.language === "en" ? record.language : null,
    autoApplySystemLanguage: record.autoApplySystemLanguage !== false,
    // R8/R9：缺省一律回到计划 5.7 的默认值（旧记录没有这些字段，必须能正常加载）。
    sshKeepAliveEnabled: record.sshKeepAliveEnabled ?? KEEPALIVE_DEFAULTS.sshKeepAliveEnabled,
    sshKeepAliveIntervalSec: record.sshKeepAliveIntervalSec ?? KEEPALIVE_DEFAULTS.sshKeepAliveIntervalSec,
    sshKeepAliveCountMax: record.sshKeepAliveCountMax ?? KEEPALIVE_DEFAULTS.sshKeepAliveCountMax,
    idleStringEnabled: record.idleStringEnabled ?? KEEPALIVE_DEFAULTS.idleStringEnabled,
    idleStringIntervalSec: record.idleStringIntervalSec ?? KEEPALIVE_DEFAULTS.idleStringIntervalSec,
    idleStringText: record.idleStringText ?? KEEPALIVE_DEFAULTS.idleStringText,
    tcpKeepAliveEnabled: record.tcpKeepAliveEnabled ?? KEEPALIVE_DEFAULTS.tcpKeepAliveEnabled,
    tcpKeepAliveInitialDelaySec: record.tcpKeepAliveInitialDelaySec ?? KEEPALIVE_DEFAULTS.tcpKeepAliveInitialDelaySec,
    loginScriptRulesEnabled: record.loginScriptRulesEnabled ?? KEEPALIVE_DEFAULTS.loginScriptRulesEnabled,
    loginScriptRules: Array.isArray(record.loginScriptRules) ? record.loginScriptRules : [],
    expectMatchMode: record.expectMatchMode ?? KEEPALIVE_DEFAULTS.expectMatchMode,
    expectStepTimeoutMs: record.expectStepTimeoutMs ?? KEEPALIVE_DEFAULTS.expectStepTimeoutMs,
    loginScriptRunEnabled: record.loginScriptRunEnabled ?? KEEPALIVE_DEFAULTS.loginScriptRunEnabled,
    loginScriptPath: record.loginScriptPath ?? KEEPALIVE_DEFAULTS.loginScriptPath,
    loginScriptSandbox: record.loginScriptSandbox ?? KEEPALIVE_DEFAULTS.loginScriptSandbox,
    // 代理库：与保活同一张设置表；早先版本漏了这一项，重启后内存里没有库，
    // 读取返回空、下一次保存又把它覆盖成空数组（用户 2026-10-18 反馈"添加的
    // 代理无法选择/重启后消失"的根因）。
    proxyLibrary: Array.isArray(record.proxyLibrary) ? record.proxyLibrary : [],
    sendRule: normalizeSendRule(record.sendRule),
    shortcuts: Array.isArray(record.shortcuts) ? record.shortcuts : [],
    mouse: normalizeMouseOptions(record.mouse),
    terminalBackground: normalizeTerminalBackground(record.terminalBackground),
    customPrompts: normalizeCustomPrompts(record.customPrompts),
    // 输出提示与会话日志自动清理（缺省回到默认值）。
    terminalFont: normalizeTerminalFont(record.terminalFont),
    outputWarnKB: Number.isSafeInteger(record.outputWarnKB) ? record.outputWarnKB : OUTPUT_LOG_DEFAULTS.outputWarnKB,
    sessionLogAutoPruneEnabled: record.sessionLogAutoPruneEnabled !== false,
    sessionLogMaxTotalMB: Number.isSafeInteger(record.sessionLogMaxTotalMB) ? record.sessionLogMaxTotalMB : OUTPUT_LOG_DEFAULTS.sessionLogMaxTotalMB,
    sessionLogMaxAgeDays: Number.isSafeInteger(record.sessionLogMaxAgeDays) ? record.sessionLogMaxAgeDays : OUTPUT_LOG_DEFAULTS.sessionLogMaxAgeDays,
    broadcastHintDismissed: record.broadcastHintDismissed === true,
    terminalFileLinks: record.terminalFileLinks !== false,
    filesFollowTerminal: record.filesFollowTerminal !== false
  };
}

/** POSIX 单引号转义（补全前缀本身可能含空格/引号）。 */
function shellQuotePosix(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * 生成远端补全查询命令（用户 2026-10-18）。
 *
 * 只依赖 ls/awk/sort 这类只读工具（busybox 可用），不调用 shell 自身的补全
 * 引擎 —— 那需要在交互式行编辑里才成立，从独立 exec 通道拿不到。返回：
 *   - command：常见 bin 目录里以 prefix 开头的可执行名；
 *   - path：按"目录/前缀"列出匹配项，`-F` 给目录加 `/`，便于客户端继续补。
 */
export function buildCompletionCommand(kind, prefix) {
  const quoted = shellQuotePosix(prefix);
  if (kind === "command") {
    return `P=${quoted}; for d in /usr/bin /bin /usr/sbin /sbin /usr/local/bin /usr/local/sbin; do ls -1 "$d" 2>/dev/null; done | awk -v p="$P" 'substr($0,1,length(p))==p' | sort -u | head -500`;
  }
  return `TOKEN=${quoted}; D=\${TOKEN%/*}; B=\${TOKEN##*/}; case "$TOKEN" in */*) : ;; *) D=.;; esac; ls -1Fd -- "$D/$B"* 2>/dev/null | head -500`;
}

function profileCredentialRefs(profileId) {
  const stem = profileId.replaceAll("-", "").toUpperCase();
  return {
    password: `DSH_SSH_OPS_${stem}_PASSWORD`,
    privateKey: `DSH_SSH_OPS_${stem}_PRIVATE_KEY`,
    passphrase: `DSH_SSH_OPS_${stem}_PASSPHRASE`
  };
}

function sharedCredentialRefs(credentialId) {
  const stem = credentialId.replaceAll("-", "").toUpperCase();
  return {
    password: `DSH_SSH_OPS_SHARED_${stem}_PASSWORD`,
    privateKey: `DSH_SSH_OPS_SHARED_${stem}_PRIVATE_KEY`,
    passphrase: `DSH_SSH_OPS_SHARED_${stem}_PASSPHRASE`
  };
}

/**
 * Assemble the wire `auth` object from a primary factor plus an optional
 * opposite-kind secondary factor (dual-factor devices such as firewalls or
 * switches configured with `AuthenticationMethods password,publickey`, or
 * the reverse, require both factors on the SAME connection). For a password
 * primary the secondary is a key and takes the shared passphrase slot; for a
 * key primary the secondary is a plain password.
 */
function assembleAuth(authKind, primaryValue, { secondaryValue, passphraseValue, secondaryPassphraseValue } = {}) {
  const primary = authKind === "password"
    ? { kind: "password", password: primaryValue }
    : { kind: "key", privateKey: primaryValue, ...(passphraseValue === undefined ? {} : { passphrase: passphraseValue }) };
  if (secondaryValue === undefined) return primary;
  const secondary = authKind === "password"
    ? { kind: "key", privateKey: secondaryValue, ...(secondaryPassphraseValue === undefined ? {} : { passphrase: secondaryPassphraseValue }) }
    : { kind: "password", password: secondaryValue };
  return { ...primary, secondary };
}

function profileJumpPasswordRef(profileId, index) {
  return `DSH_SSH_OPS_${profileId.replaceAll("-", "").toUpperCase()}_JUMP_${index}_PASSWORD`;
}

function profileJumpPrivateKeyRef(profileId, index) {
  return `DSH_SSH_OPS_${profileId.replaceAll("-", "").toUpperCase()}_JUMP_${index}_PRIVATE_KEY`;
}

function profileJumpPassphraseRef(profileId, index) {
  return `DSH_SSH_OPS_${profileId.replaceAll("-", "").toUpperCase()}_JUMP_${index}_PASSPHRASE`;
}

// Credential-store key for the upstream SOCKS5 proxy password. Same shape as
// the jump refs; referenced by profileSave (write), connectClient (resolve)
// and profileDelete (unset).
function profileProxyPasswordRef(profileId) {
  return `DSH_SSH_OPS_${profileId.replaceAll("-", "").toUpperCase()}_PROXY_PASSWORD`;
}

/** Base64-decode a wire payload to a UTF-8 string. */
function decodeData(data) {
  return Buffer.from(data, "base64").toString("utf8");
}

/** Base64-encode a UTF-8 string for the wire. */
function encodeData(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function appendCapped(current, next, maxBytes) {
  const existing = Buffer.byteLength(current, "utf8");
  const incoming = Buffer.from(next, "utf8");
  if (existing >= maxBytes) return { text: current, truncated: incoming.length > 0 };
  const remaining = maxBytes - existing;
  if (incoming.length <= remaining) return { text: current + next, truncated: false };
  return { text: current + incoming.subarray(0, remaining).toString("utf8"), truncated: true };
}

function tailCapped(text, maxBytes) {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= maxBytes ? text : bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

function promptFromTerminalData(text) {
  const visible = String(text)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const match = visible.match(/(?:^|[\r\n])([^\r\n]*[#$] )$/);
  return match?.[1] ?? null;
}

/**
 * ssh2 exec channels return LF-delimited text. xterm keeps the current column
 * on a bare LF, which makes multi-line agent output drift diagonally. Agent
 * output is synthetic terminal data, so normalize it to the terminal CRLF.
 */
export function normalizeTerminalEol(text) {
  return String(text ?? "").replace(/\r\n|\r|\n/g, "\r\n");
}

/**
 * SshOpsService: one cordis service (and Typert Remote) that owns all SSH
 * connections and their PTY shell sessions for the web profile.
 */
export default class SshOpsService extends TypertRemoteService {
  /** Host-owned profiles and secrets never cross the agent tool boundary. */
  static inject = ["tools", "storageDomain", "credentials"];

  /** connectionId -> live connection record */
  connections = new Map();
  /** sessionId -> live PTY shell session record */
  sessions = new Map();
  /** sessionId -> tombstoned exit records for late reads */
  exitedSessions = new Map();
  /** confirmationId -> agent-originated dangerous command awaiting a human. */
  pendingConfirmations = new Map();
  /** batchId -> operator-selected batch exec task awaiting selection/execution. */
  batchTasks = new Map();

  /** The connection currently represented by the right-side terminal panel. */
  activeConnectionId = null;
  /**
   * Agent auto-connect switch (issue #25): when true the agent may connect
   * saved SSH resources itself (xssh_connect_profile, and xssh_list shows the
   * saved resources). Persisted in xssh_ops_settings; default OFF.
   */
  agentAutoConnect = false;
  /**
   * Interface language last resolved from DSH's own Settings → Language by
   * the browser half ("zh" | "en"), or null before the first write-back.
   * There is no manual language switch: the plugin always follows the host,
   * and this stored value lets the host half (agent-visible messages) speak
   * the same language from the first message built after boot.
   */
  language = null;
  /**
   * Whether the plugin follows DSH's own Settings → Language ("true", the
   * default) or is pinned to the stored `language` value ("false", operator
   * edit of xssh_ops_settings.json). When false the host language is neither
   * followed nor written back by the browser half.
   */
  autoApplySystemLanguage = true;
  profileTable = null;
  groupTable = null;
  credentialTable = null;
  /** known_hosts table (host:port → fingerprint record); null until [Service.init]. */
  knownHostTable = null;
  /** KnownHosts adapter over `knownHostTable`; null until [Service.init]. */
  knownHosts = null;
  /** Operator settings table; null until [Service.init]. */
  settingsTable = null;

  constructor(ctx, config = {}) {
    super(ctx, "xsshOps");
    this.config = {
      defaultReadTimeoutMs: READ_TIMEOUT_MS,
      maxBufferBytes: MAX_BUFFER_BYTES,
      maxCommandOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      maxCaptureBytes: MAX_CAPTURE_BYTES,
      streamHeartbeatMs: STREAM_HEARTBEAT_MS,
      // 行号行日志上限（计划 5.7 / 用户 Q1：2000 行 + 512 KiB 字节安全阀）。
      lineJournalMaxLines: LINE_JOURNAL_MAX_LINES,
      lineJournalMaxBytes: LINE_JOURNAL_MAX_BYTES,
      // 命令台账（计划 5.4）：空闲闭口阈值、按需回填条数、落盘目录。
      commandIdleMs: COMMAND_IDLE_CLOSE_MS,
      commandLedgerEnabled: true,
      commandLedgerDir: undefined,
      commandLedgerLoadTail: undefined,
      // Session recording is on by default; the directory defaults to
      // ~/.dsh/xssh-ops/logs and is resolved lazily on first use.
      sessionLogEnabled: true,
      sessionLogDir: undefined,
      ...config
    };
    // Tear down all connections when the plugin fiber unloads.
    ctx.effect(() => () => {
      for (const conn of this.connections.values()) {
        conn.closing = true;
        if (conn.reconnectTimer !== null) clearTimeout(conn.reconnectTimer);
        try { conn.client?.end(); } catch {}
        for (const hop of conn.hops ?? []) { try { hop.end(); } catch {} }
      }
      this.connections.clear();
      this.sessions.clear();
      this.exitedSessions.clear();
      this.pendingConfirmations.clear();
      this.activeConnectionId = null;
    }, "xssh-ops: cleanup");
    this.registerTools(ctx);
    // R8② 空闲字符串的节拍器：每秒判一次「够不够条件发」。用 unref 的定时器，
    // 插件卸载/进程退出不该被它挂住；判据与「测试保活」共用同一套（idle-string.js）。
    {
      const timer = setInterval(() => { void this.tickIdleStrings(); }, 1000);
      if (typeof timer.unref === "function") timer.unref();
      ctx.effect(() => () => clearInterval(timer), "xssh-ops: idle-string ticker");
    }
    // R9① 登录脚本规则的超时节拍器：每秒推进一次规则状态机，让「单条等待超时」
    // 能真的按策略跳过或中止。**没有这个定时器，超时策略永远不会触发** ——
    // `tickLoginScripts` 此前定义了但无人调用（与 R9② 的 tree-shaking 同一类问题：
    // 写好的能力因为没接线而从未生效）。
    {
      const timer = setInterval(() => { this.tickLoginScripts(); }, 1000);
      if (typeof timer.unref === "function") timer.unref();
      ctx.effect(() => () => clearInterval(timer), "xssh-ops: login-script timeout ticker");
    }
    // M4 任务 TTL 的节拍器：每小时扫一次超龄任务并清远端产物。
    {
      const timer = setInterval(() => { void this.sweepExpiredTasks(); }, 3600 * 1000);
      if (typeof timer.unref === "function") timer.unref();
      ctx.effect(() => () => clearInterval(timer), "xssh-ops: task ttl sweeper");
    }
    // 会话日志自动清理（用户 2026-10-19）：启动后 1 分钟跑一次，之后每 6 小时。
    {
      const run = () => { void this.pruneSessionLogs().catch(() => {}); };
      const startTimer = setTimeout(run, 60 * 1000);
      if (typeof startTimer.unref === "function") startTimer.unref();
      const timer = setInterval(run, 6 * 3600 * 1000);
      if (typeof timer.unref === "function") timer.unref();
      ctx.effect(() => () => { clearTimeout(startTimer); clearInterval(timer); }, "xssh-ops: session-log prune ticker");
    }
    // Streaming file routes (workbench S6 patch): reactive inject — no hard
    // activation dependency, so compositions without a webserver simply never
    // serve the byte plane. Same registration pattern the typert gateway uses
    // for the /api/remote.mux WebSocket (connection.requestRejection guard +
    // webServer.register prefix route, disposed with this fiber).
    ctx.inject(["connection", "webServer"], (hostCtx) => {
      hostCtx.effect(() => hostCtx.webServer.register({
        kind: "prefix",
        path: STREAM_ROUTE_PREFIX,
        handler: (req, res) => {
          this.handleStreamRoute(req, res, hostCtx.connection);
        }
      }), "xssh-ops: streaming file routes");
      hostCtx.effect(() => hostCtx.webServer.register({
        kind: "prefix",
        path: ASSET_ROUTE_PREFIX,
        handler: (req, res) => { void this.handleAssetRoute(req, res); }
      }), "xssh-ops: local asset routes");
      // Settings-page self-update endpoint (GET status / trusted POST install).
      hostCtx.effect(() => registerPluginUpdater(hostCtx, {
        endpoint: UPDATE_ENDPOINT,
        packageName: "dsh-xssh-ops",
        githubRepo: "sqx6781268/dsh-xssh-ops",
        manifestUrl: new URL("../package.json", import.meta.url)
      }), "xssh-ops: plugin update endpoint");
    });
  }

  async [Service.init]() {
    const domain = await this.ctx.storageDomain.open(profileDomainSpec);
    this.profileTable = domain.table("profiles");
    this.groupTable = domain.table("groups");
    this.ctx.effect(() => () => domain.close(), "xssh-ops: profile domain close");
    const credentialDomain = await this.ctx.storageDomain.open(credentialDomainSpec);
    this.credentialTable = credentialDomain.table("credentials");
    this.ctx.effect(() => () => credentialDomain.close(), "xssh-ops: credential domain close");
    const knownHostDomain = await this.ctx.storageDomain.open(knownHostDomainSpec);
    this.knownHostTable = knownHostDomain.table("known_hosts");
    this.knownHosts = new KnownHosts(this.knownHostTable);
    this.ctx.effect(() => () => knownHostDomain.close(), "xssh-ops: known-host domain close");
    const settingsDomain = await this.ctx.storageDomain.open(settingsDomainSpec);
    this.settingsTable = settingsDomain.table("settings");
    this.ctx.effect(() => () => settingsDomain.close(), "xssh-ops: settings domain close");
    // Load the persisted operator switch; a missing row (first boot) keeps the
    // safe default off, and a read failure must not block service startup.
    try {
      const settingsRecord = this.settingsTable.get(SETTINGS_ROW_ID) ?? {};
      const loaded = loadSettingsRecord(settingsRecord);
      this.agentAutoConnect = loaded.agentAutoConnect;
      // An explicit choice drives the host half from the first message it
      // builds. With no choice stored, the host keeps its default (zh) and
      // the browser half adopts DSH's language and writes it back.
      this.language = loaded.language;
      // "false" pins the stored language: the browser half must never follow
      // (or write back) the host language. Absent defaults to true so first
      // installs keep the auto-follow behaviour.
      this.autoApplySystemLanguage = loaded.autoApplySystemLanguage;
      // R8/R9（计划 5.7/5.8）：保活与登录脚本设置。整体挂在 this.settings 上，
      // 建连与定时器都从这里读，避免每处各自去查存储。
      this.settings = {
        sshKeepAliveEnabled: loaded.sshKeepAliveEnabled,
        sshKeepAliveIntervalSec: loaded.sshKeepAliveIntervalSec,
        sshKeepAliveCountMax: loaded.sshKeepAliveCountMax,
        idleStringEnabled: loaded.idleStringEnabled,
        idleStringIntervalSec: loaded.idleStringIntervalSec,
        idleStringText: loaded.idleStringText,
        tcpKeepAliveEnabled: loaded.tcpKeepAliveEnabled,
        tcpKeepAliveInitialDelaySec: loaded.tcpKeepAliveInitialDelaySec,
        loginScriptRulesEnabled: loaded.loginScriptRulesEnabled,
        loginScriptRules: loaded.loginScriptRules,
        expectMatchMode: loaded.expectMatchMode,
        expectStepTimeoutMs: loaded.expectStepTimeoutMs,
        loginScriptRunEnabled: loaded.loginScriptRunEnabled,
        loginScriptPath: loaded.loginScriptPath,
        loginScriptSandbox: loaded.loginScriptSandbox,
        proxyLibrary: loaded.proxyLibrary,
        sendRule: loaded.sendRule,
        shortcuts: loaded.shortcuts,
        mouse: loaded.mouse,
        terminalBackground: loaded.terminalBackground,
        customPrompts: loaded.customPrompts,
        terminalFont: loaded.terminalFont,
        outputWarnKB: loaded.outputWarnKB,
        sessionLogAutoPruneEnabled: loaded.sessionLogAutoPruneEnabled,
        sessionLogMaxTotalMB: loaded.sessionLogMaxTotalMB,
        sessionLogMaxAgeDays: loaded.sessionLogMaxAgeDays,
        broadcastHintDismissed: loaded.broadcastHintDismissed,
        terminalFileLinks: loaded.terminalFileLinks,
        filesFollowTerminal: loaded.filesFollowTerminal
      };
      // Materialize the default: the flag is an operator-editable field of
      // xssh_ops_settings.json, so a record that predates it must gain the
      // explicit "true" on first load after the upgrade — otherwise the
      // settings file would never show the knob the operator can flip.
      if (settingsRecord.autoApplySystemLanguage === undefined) {
        await this.settingsTable.put(SETTINGS_ROW_ID, {
          ...settingsRecord,
          autoApplySystemLanguage: true,
          updatedAt: new Date().toISOString()
        });
      }
      // The browser half refreshes this from the live host on every load;
      // until then it is the best-known host language.
      if (this.language !== null) setLanguage(this.language);
    } catch {}
  }

  // ── Remote methods ─────────────────────────────────────────────────────────

  async list() {
    const connections = [];
    for (const [connectionId, c] of this.connections) {
      const connection = {
        connectionId,
        host: c.host,
        port: c.port,
        username: c.username,
        connected: true,
        sessions: [...c.sessions]
      };
      // Strict Typert results must be JSON-safe: optional fields must be
      // absent, rather than present with an `undefined` value.
      if (c.name !== undefined) connection.name = c.name;
      // profileId：面板据此把连接映射回资源所属分组（批量发送的分组过滤），
      // 缺了它所有连接的分组都会算成「未分组」（用户 2026-10-19 实测）。
      if (c.profileId !== undefined) connection.profileId = c.profileId;
      // The browser reveals agent-opened sessions, and a new request token
      // also reveals reused connections whose existing PTY was human-opened.
      if ([...c.sessions].some((sessionId) => this.sessions?.get(sessionId)?.openedBy === "agent")) connection.agentSession = true;
      if (c.agentRevealId !== undefined) connection.agentRevealId = c.agentRevealId;
      connections.push(connection);
    }
    const value = { connections, activeConnectionId: this.activeConnectionId };
    // Saved resources reach the agent only after the operator opted in
    // (issue #25); with the switch off, xssh_list keeps today's strict
    // live-connections-only stance.
    if (this.agentAutoConnect) {
      try {
        value.resources = this.savedResourceSummaries();
      } catch {}
    }
    return { ok: true, value };
  }

  /**
   * Saved SSH resources as the agent may see them: coordinates only. The
   * caller gates on `agentAutoConnect`; a storage failure must not take
   * `list()` down, so callers wrap this in try/catch.
   */
  savedResourceSummaries() {
    const connectedProfileIds = new Set(
      [...this.connections.values()].map((connection) => connection.profileId).filter(Boolean)
    );
    return [...this.requireProfileTable().entries()]
      .map(([profileId, record]) => ({
        profileId,
        name: record.name,
        host: record.host,
        port: record.port,
        username: record.username,
        connected: connectedProfileIds.has(profileId)
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
  }

  /** Saved resource names for error guidance; failures degrade to an empty list. */
  savedResourceNameList() {
    if (!this.agentAutoConnect) return [];
    try {
      return [...this.requireProfileTable().values()]
        .map((record) => record.name)
        .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
    } catch {
      return [];
    }
  }

  /**
   * Point the agent at one connection. Split panes are independent, so the
   * operator's click is what decides which of them an agent tool call targets:
   * tools that omit `connection_id` resolve `activeConnectionId` at call time.
   * A refused switch leaves the previous binding intact — clearing it would
   * strand the agent with no target while the panel still shows one.
   */
  async selectConnection(request) {
    const connection = this.connections.get(request.connectionId);
    if (connection === void 0) {
      return { ok: false, error: fail("no-connection", noConnectionGuidance(request.connectionId, this.savedResourceNameList(), this.agentAutoConnect)) };
    }
    if (connection.dead || connection.closing) {
      return { ok: false, error: fail("connection-lost", `connection "${request.connectionId}" is not usable`) };
    }
    this.activeConnectionId = request.connectionId;
    return { ok: true, value: { activeConnectionId: this.activeConnectionId } };
  }

  /**
   * Resolve a credential's primary factor plus its optional opposite-kind
   * secondary (dual-factor auth) from a refs triple. The passphrase slot is
   * shared: it holds the primary key's passphrase for key-primary records
   * and the secondary key's passphrase for password-primary records. The
   * secondary is optional — an unconfigured slot yields a single-factor auth.
   */
  async resolveCredentialAuth(refs, authKind) {
    const primary = await this.ctx.credentials.resolve(credentialRef(authKind === "password" ? refs.password : refs.privateKey));
    if (primary === undefined) return undefined;
    const passphrase = authKind === "key"
      ? await this.ctx.credentials.resolve(credentialRef(refs.passphrase))
      : undefined;
    const secondary = await this.ctx.credentials.resolve(credentialRef(authKind === "password" ? refs.privateKey : refs.password));
    const secondaryPassphrase = authKind === "password"
      ? await this.ctx.credentials.resolve(credentialRef(refs.passphrase))
      : undefined;
    return assembleAuth(authKind, primary.value, {
      passphraseValue: passphrase?.value,
      secondaryValue: secondary?.value,
      secondaryPassphraseValue: secondaryPassphrase?.value
    });
  }

  async connect(request) {
    let resolvedRequest = request;
    if (request.credentialId !== undefined) {
      try {
        const credential = this.requireCredentialTable().get(request.credentialId);
        if (credential === undefined) return { ok: false, error: fail("no-credential", `SSH credential "${request.credentialId}" does not exist`) };
        const refs = sharedCredentialRefs(request.credentialId);
        const auth = await this.resolveCredentialAuth(refs, credential.authKind);
        if (auth === undefined) return { ok: false, error: fail("credential-missing", `shared credential "${credential.name}" has no saved ${credential.authKind === "password" ? "password" : "private key"}`) };
        resolvedRequest = { ...request, auth };
      } catch (error) { return { ok: false, error: fail("credential-connect-failed", error.message) }; }
    }
    if (Array.isArray(resolvedRequest.proxyJumpProfileIds) && resolvedRequest.proxyJumpProfileIds.length > 0) {
      try {
        const seen = new Set();
        const proxyJump = [];
        for (const profileId of request.proxyJumpProfileIds) {
          if (seen.has(profileId)) return { ok: false, error: fail("jump-duplicate", t("同一条跳板链不能重复选择同一台服务器")) };
          seen.add(profileId);
          const profile = this.requireProfileTable().get(profileId);
          if (profile === undefined) return { ok: false, error: fail("no-profile", `jump-host profile "${profileId}" does not exist`) };
          const refs = profile.credentialId ? sharedCredentialRefs(profile.credentialId) : profileCredentialRefs(profileId);
          const auth = await this.resolveCredentialAuth(refs, profile.authKind);
          if (auth === undefined) return { ok: false, error: fail("credential-missing", `jump host "${profile.name}" has no saved credential`) };
          proxyJump.push({ host: profile.host, port: profile.port, username: profile.username, hostKeyMode: profile.hostKeyMode, auth });
        }
        return await this.connectInternal({ ...resolvedRequest, proxyJump });
      } catch (error) { return { ok: false, error: fail("profile-jump-connect-failed", error.message) }; }
    }
    return this.connectInternal(resolvedRequest);
  }

  async connectInternal(request, profileId = undefined) {
    const id = request.name ? `${request.name}-${randomUUID().slice(0, 8)}` : randomUUID();
    // R8①：保活间隔来自设置（默认 60 s），取代上游硬编码的 20 s；关闭时用 0
    // （ssh2 语义：0 = 不发保活）。请求里显式给了参数就仍然以请求为准。
    const keepAlive = this.settings ?? {};
    const keepAliveEnabled = keepAlive.sshKeepAliveEnabled !== false;
    const keepAliveInterval = keepAliveEnabled
      ? (Number.isFinite(keepAlive.sshKeepAliveIntervalSec) ? keepAlive.sshKeepAliveIntervalSec : 60) * 1000
      : 0;
    const connectConfig = {
      host: request.host,
      port: request.port ?? 22,
      username: request.username,
      readyTimeout: request.readyTimeout ?? 20000,
      keepaliveInterval: request.keepaliveInterval ?? keepAliveInterval,
      keepaliveCountMax: request.keepaliveCountMax ?? (keepAlive.sshKeepAliveCountMax ?? KEEPALIVE_COUNT_MAX)
    };
    // Dual-factor devices require both factors on the same connection: apply
    // the primary and, when present, the secondary to the ssh2 config so the
    // auth handler can walk password → publickey in either server order.
    if (request.auth.password !== undefined) connectConfig.password = request.auth.password;
    if (request.auth.privateKey !== undefined) connectConfig.privateKey = request.auth.privateKey;
    if (request.auth.passphrase !== void 0) connectConfig.passphrase = request.auth.passphrase;
    if (request.auth.secondary?.kind === "key") {
      connectConfig.privateKey = request.auth.secondary.privateKey;
      if (request.auth.secondary.passphrase !== void 0) connectConfig.passphrase = request.auth.secondary.passphrase;
    } else if (request.auth.secondary?.kind === "password") {
      connectConfig.password = request.auth.secondary.password;
    }
    // Opt-in SSH agent forwarding (jump-host workflows): wire the local agent
    // into the config BEFORE the record exists — a missing agent is an
    // environment problem the user must fix, not a transient failure worth
    // retrying. On success every shell/exec channel on this connection
    // requests forwarding (ssh2 handles the auth-agent channel plumbing), and
    // the agent also becomes an additional auth method for the handshake.
    const agentApplied = applyAgentForwarding(connectConfig, request.agentForward === true);
    if (!agentApplied.ok) {
      return { ok: false, error: fail(agentApplied.error.code, agentApplied.error.message) };
    }
    const record = {
      id,
      client: null,
      hops: [],
      host: connectConfig.host,
      port: connectConfig.port,
      username: connectConfig.username,
      name: request.name,
      profileId,
      sessions: new Set(),
      sftp: null,
      tunnels: new Map(),
      // Transport health / self-healing state: keep the auth config around so
      // a dropped transport can be re-established transparently instead of
      // forcing the user to open a brand-new session.
      connectConfig,
      // Legacy-KEX policy for this connection: an explicit request disables
      // the automatic retry, because the user already told us what to use.
      legacyAlgorithms: request.legacy === true,
      legacyFallback: false,
      // Identification-string repair: ssh2's parser refuses a few banners that
      // OpenSSH accepts, reporting them as a bare "Invalid identification
      // string". Set only after such a real rejection, so a healthy peer never
      // takes that path; `bannerRepairNote` explains what was rewritten.
      bannerRepair: false,
      bannerRepairNote: null,
      // `legacy: false` is an explicit "modern only, do NOT downgrade" — the
      // automatic retry is opt-out, not merely opt-in.
      allowLegacyDowngrade: request.legacy === undefined,
      // Authentication-stage telemetry: which methods were offered, what the
      // server still accepts, whether a keyboard-interactive prompt was
      // served. Feeds the structured connect-failure diagnosis and the
      // one-shot keyboard-interactive → plain-password fallback.
      authTracker: createAuthTracker(),
      kbdFallbackTried: false,
      proxyJump: Array.isArray(request.proxyJump) ? request.proxyJump : [],
      // Upstream SOCKS5 proxy to dial through before the first SSH byte. Kept
      // OFF connectConfig (it is not an ssh2 option); connectClient turns it
      // into a pre-connected stream and hands that to ssh2 as config.sock.
      // A quick-connect request carries the inline password here; a saved
      // resource resolves its password from the credential store first.
      proxyConfig: request.proxy && request.proxy.host ? request.proxy : undefined,
      // Host-key TOFU mode for this connection (undefined → accept-new default
      // resolved in attachHostVerifier). Persisted on the record so transparent
      // reconnects re-check with the same policy.
      hostKeyMode: request.hostKeyMode,
      dead: true,
      closing: false,
      connecting: true,
      reconnectTimer: null,
      reconnectAttempts: 0,
      reconnectWaiters: []
    };
    this.connections.set(id, record);
    const connected = await this.connectClient(record, request.retries ?? CONNECT_RETRIES);
    record.connecting = false;
    if (!connected.ok) {
      this.connections.delete(id);
      return connected;
    }
    this.attachTransportHandlers(record);
    const value = {
      connectionId: id,
      host: connectConfig.host,
      port: connectConfig.port,
      username: connectConfig.username
    };
    // See list(): the RPC gateway rejects `undefined` as a JSON value.
    if (request.name !== undefined) value.name = request.name;
    // Surface anything unusual about the handshake to the caller. Both warnings
    // can apply to one connection, so they accumulate rather than overwrite.
    const warnings = [];
    // A downgraded handshake must never be silent: a weakened transport is worse
    // than a slow one, because nobody thinks to upgrade the device afterwards.
    if (record.legacyFallback) {
      value.legacyFallback = true;
      warnings.push("This server offered no modern SSH key exchange; connected with the legacy diffie-hellman-group14-sha1 algorithm. The transport is weaker than the default — upgrade the device firmware when possible.");
    }
    // Nor must a rewritten banner: the peer is off-specification, and the user
    // should know the connection only exists because the line was repaired.
    if (record.bannerRepair) {
      value.bannerRepair = true;
      warnings.push(t(`对端的 SSH 横幅不符合 RFC 4253，ssh2 会直接拒绝这条连接；本次已按规范化后的横幅完成握手。${record.bannerRepairNote ?? ""}`));
    }
    if (warnings.length > 0) value.warning = warnings.join("\n");
    // A newly connected server is the natural target for the conversation,
    // even if the browser has not rendered its PTY yet.
    this.activeConnectionId = id;
    return {
      ok: true,
      value
    };
  }

  // ── host-key TOFU ──────────────────────────────────────────────────────────

  /**
   * Build an ssh2 `hostVerifier` (key, verify) => boolean for a host:port.
   * Decides accept/record/reject against the known_hosts store; on rejection
   * stashes a verdict on `state` so the caller surfaces a non-retriable error,
   * and on first-seen acceptance stashes a record-to-persist after `ready`.
   */
  makeHostVerifier(state, host, port, mode) {
    return (key) => {
      try {
        const algorithm = blobAlgorithm(key);
        const presented = keyFingerprint(key);
        const known = this.knownHosts?.get(host, port);
        const verdict = decideHostKey({ mode, known, presentedFingerprint: presented, algorithm });
        if (!verdict.accept) {
          state.hostKeyMismatch = { reason: verdict.reason, host, port, mode, expected: verdict.expected, got: verdict.got ?? presented };
          return false;
        }
        if (verdict.record) {
          state.hostKeyToRecord = { host, port, fingerprint: verdict.record.fingerprint, algorithm: verdict.record.algorithm };
        }
        return true;
      } catch (error) {
        state.hostKeyMismatch = { reason: "verifier-error", host, port, mode, message: error.message };
        return false;
      }
    };
  }

  /** Attach a TOFU verifier to an ssh2 connect config (no-op when off or store not ready). */
  attachHostVerifier(config, state, host, port, mode) {
    const effective = mode ?? DEFAULT_HOST_KEY_MODE;
    if (this.knownHosts === null || effective === "off") return;
    config.hostVerifier = this.makeHostVerifier(state, host, port, effective);
  }

  /** Persist a first-seen host key after a successful handshake. */
  async persistFirstSeenHostKey(state) {
    const pending = state.hostKeyToRecord;
    if (!pending) return;
    state.hostKeyToRecord = null;
    if (this.knownHosts !== null) {
      await this.knownHosts.record(pending.host, pending.port, { fingerprint: pending.fingerprint, algorithm: pending.algorithm });
    }
  }

  /** Turn a stashed host-key verdict into a non-retriable result error. */
  hostKeyError(m) {
    const where = `${m.host}:${m.port}`;
    if (m.reason === "unseen-host") {
      return fail("host-key-unseen", `host key for ${where} is not previously trusted (mode ${m.mode}). Presented SHA256:${m.got}; verify it out of band. Strict mode will not create a trust record; follow your approved process before changing the profile policy.`);
    }
    if (m.reason === "host-key-mismatch") {
      return fail("host-key-mismatch", t(`host key for ${where} changed (mode ${m.mode}). Expected SHA256:${m.expected}; presented SHA256:${m.got}. This may be a man-in-the-middle or a re-provisioned server. Verify it out of band; if legitimate, use "忘记主机指纹" and reconnect.`));
    }
    return fail("host-key-error", `host key verification error for ${where} (mode ${m.mode}): ${m.message ?? m.reason}`);
  }

  /**
   * Establish (or re-establish) the ssh2 transport of a connection record.
   * Transient network failures are retried with backoff; authentication
   * failures are not.
   */
  async connectClient(record, retries = CONNECT_RETRIES) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (record.closing) {
        return { ok: false, error: fail("connect-cancelled", `connection "${record.id}" was closed`) };
      }
      // Build the base transport for this attempt. An upstream SOCKS5 proxy,
      // when configured, dials the first hop (or the target when there is no
      // jump chain); the jump chain then runs SSH forwarding over that
      // pre-connected stream. On failure the whole chain is torn down.
      let sock;
      try {
        if (record.proxyJump.length > 0) {
          const chain = await this.connectChain(
            record.proxyJump,
            record.connectConfig.host,
            record.connectConfig.port,
            record.proxyConfig
          );
          record.hops = chain.hops;
          sock = chain.sock;
        } else if (record.proxyConfig) {
          // No jump chain: the SOCKS5 proxy is the transport straight to the
          // target SSH server.
          sock = await this.openProxySock(record);
        }
      } catch (error) {
        lastError = error;
        if (error?.code === "host-key-mismatch" || error?.code === "host-key-unseen" || error?.code === "host-key-error") {
          return { ok: false, error: fail(error.code, error.message) };
        }
        for (const hop of record.hops) { try { hop.end(); } catch {} }
        record.hops = [];
        // Deterministic proxy failures (missing/rejected credentials, a
        // ruleset refusal) cannot improve on retry — surface immediately
        // instead of sleeping through the whole backoff budget.
        if (typeof error?.code === "string" && error.code.startsWith("proxy-") && !isTransientConnectError(error)) {
          break;
        }
        if (record.closing || attempt >= retries) break;
        await this.sleep(Math.min(2000, 500 * 2 ** attempt));
        continue;
      }
      // A peer whose banner ssh2 refused gets one more attempt with that line
      // normalized first (ssh-banner.js). This is reached only after such a real
      // rejection, so a healthy peer keeps ssh2's own socket handling.
      if (record.bannerRepair) {
        try {
          sock = await this.openRepairedSock(record, sock);
        } catch (error) {
          lastError = error;
          for (const hop of record.hops) { try { hop.end(); } catch {} }
          record.hops = [];
          if (record.closing || attempt >= retries) break;
          await this.sleep(Math.min(2000, 500 * 2 ** attempt));
          continue;
        }
      }
      const client = new Client();
      record.client = client;
      try {
        await new Promise((resolve, reject) => {
          // ssh2 can emit several protocol errors while a handshake is dying
          // (observed live: "Connection lost before handshake" twice in a
          // row). The first event settles the wait; the standing error
          // listener must outlive it, because an 'error' emission with zero
          // listeners crashes the whole DSH process. A cancelled connect is
          // broken out of via the close event below.
          let settled = false;
          const onReady = () => { if (!settled) { settled = true; resolve(); } };
          const onError = (cause) => { if (!settled) { settled = true; reject(cause); } };
          const onClose = () => { if (!settled) { settled = true; reject(new Error("connection closed before handshake completed")); } };
          client.once("ready", onReady);
          client.on("error", onError);
          client.once("close", onClose);
          const config = { ...record.connectConfig };
          // Single source of truth for the legacy KEX set: `legacy: true`
          // seeds the flag, an automatic downgrade flips it mid-loop, and this
          // is the only place a handshake's options are assembled (so the two
          // paths can never drift apart).
          if (record.legacyAlgorithms) {
            config.algorithms = { ...(config.algorithms ?? {}), ...LEGACY_VRP_ALGORITHMS };
          }
          // Keyboard-interactive support: only when a saved password exists to
          // answer prompts with, and never on the plain-password fallback
          // attempt (where the device killed the transport mid-prompt).
          const hasPassword = record.connectConfig.password !== undefined;
          config.tryKeyboard = hasPassword && !record.kbdFallbackTried;
          if (config.tryKeyboard) {
            client.on("keyboard-interactive", (name, instructions, instructionsLang, prompts, finish) => {
              record.authTracker.kbdSeen = true;
              finish(prompts.map(() => record.connectConfig.password));
            });
          }
          // ssh2's own default handler walks the same method order; this one
          // additionally records what was tried and what the server accepts,
          // so a failed login produces a diagnosis instead of a bare line.
          config.authHandler = makeAuthHandler(record.authTracker, {
            hasPassword,
            hasPrivateKey: record.connectConfig.privateKey !== undefined,
            // A forwarded agent doubles as an auth source (ssh2's separate
            // "agent" method), so a keyless resource can still log in.
            hasAgent: typeof record.connectConfig.agent === "string",
            tryKeyboard: config.tryKeyboard
          });
          if (sock !== undefined) config.sock = sock;
          this.attachHostVerifier(config, record, record.host, record.port, record.hostKeyMode);
          client.connect(config);
        });
        record.dead = false;
        record.reconnectAttempts = 0;
        await this.persistFirstSeenHostKey(record);
        return { ok: true };
      } catch (error) {
        // Host-key TOFU rejection is never transient: surface it, don't retry.
        if (record.hostKeyMismatch) {
          for (const hop of record.hops) { try { hop.end(); } catch {} }
          record.hops = [];
          return { ok: false, error: this.hostKeyError(record.hostKeyMismatch) };
        }
        lastError = error;
        // A cancelled connect must not spend its remaining retry attempts.
        if (record.closing) break;
        // Tear down hops on failure so the retry starts fresh.
        for (const hop of record.hops) { try { hop.end(); } catch {} }
        record.hops = [];
        // ssh2's ident parser refuses a handful of banners that OpenSSH accepts
        // and reports them as a bare "Invalid identification string" — naming
        // neither the peer nor the offending line. Retry ONCE with that line
        // normalized. Like the KEX downgrade below, this consumes an attempt on
        // purpose and the loop bound is widened, so a caller that passed
        // retries:0 still gets the chance; otherwise the device would look
        // simply unreachable.
        if (!record.bannerRepair && isIdentMismatchError(error)) {
          record.bannerRepair = true;
          this.log(`SSH ${record.host}:${record.port} returned an identification string ssh2 refuses; retrying once with that line normalized so the handshake can proceed.`);
          if (attempt >= retries) retries += 1;
          continue;
        }
        // Only when the user did not ask for legacy explicitly: a shared
        // KEX-less handshake means this peer may be an old VRP switch, so
        // retry ONCE with the legacy algorithm set and remember that we did.
        //
        // This consumes a retry attempt on purpose — but the loop bound is
        // widened by one while the downgrade is still available, so a caller
        // that passed retries:0 (or a small budget) still gets the legacy
        // chance. Otherwise a modern-only handshake failure would be reported
        // for a device the plugin can actually reach.
        if (!record.legacyAlgorithms && record.allowLegacyDowngrade && isKexMismatchError(error)) {
          record.legacyAlgorithms = true;
          record.legacyFallback = true;
          this.log(`SSH ${record.host}:${record.port} offered no modern key exchange; retrying with legacy algorithms (diffie-hellman-group14-sha1). The transport is weaker than the default — reachable, but prefer upgrading the device if you can.`);
          if (attempt >= retries) retries += 1;
          continue;
        }
        // Devices whose firmware aborts the transport while a keyboard-
        // interactive round-trip is in flight get ONE plain-password retry
        // (tryKeyboard off, so the interactive method is never offered). Only
        // fires after auth provably started — otherwise it is a plain network
        // failure and the retry loop's own policy applies.
        if (!record.kbdFallbackTried && wasAuthCut(record.authTracker, error)) {
          record.kbdFallbackTried = true;
          this.log(`SSH ${record.host}:${record.port} dropped the transport during authentication; retrying once with the plain password method only.`);
          if (attempt >= retries) retries += 1;
          continue;
        }
        if (!isTransientConnectError(error) || attempt >= retries) break;
        await this.sleep(Math.min(2000, 500 * 2 ** attempt));
      }
    }
    if (record.closing) {
      return { ok: false, error: fail("connect-cancelled", `connection "${record.id}" was closed`) };
    }
    // Structured diagnosis instead of ssh2's bare one-liner: what stage died,
    // which methods were tried, what the server still accepts, and the next
    // steps worth trying. The code stays `connect-failed` so existing callers
    // (and their matching) are unaffected.
    const diagnosis = classifyConnectFailure(lastError, record.authTracker, {
      hasPassword: record.connectConfig.password !== undefined,
      hasPrivateKey: record.connectConfig.privateKey !== undefined
    });
    return {
      ok: false,
      error: fail("connect-failed", formatConnectFailure(diagnosis, `${record.username}@${record.host}:${record.port}`))
    };
  }

  /**
   * Open the base transport for one connect attempt through the configured
   * upstream SOCKS5 proxy. Returns undefined when no proxy is configured so a
   * plain connection keeps ssh2's own socket handling. The returned stream is
   * either used directly as config.sock or passed into openRepairedSock (which
   * must splice the handed stream rather than open its own TCP connection —
   * otherwise the proxy would be silently bypassed on a banner-repair retry).
   * Coded proxy errors (proxy-*) propagate to the retry loop, whose
   * isTransientConnectError policy already knows which are worth retrying.
   */
  async openProxySock(record) {
    const proxy = record.proxyConfig;
    if (!proxy) return undefined;
    return await socks5Connect({
      proxy: { host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password },
      target: { host: record.connectConfig.host, port: record.connectConfig.port },
      timeoutMs: Math.min(record.connectConfig.readyTimeout ?? 20000, 15000)
    });
  }

  /**
   * Obtain the transport for a banner-repaired attempt: the peer's
   * identification line has to be read and normalized before ssh2 ever sees it,
   * which means the plugin owns the byte stream instead of ssh2.
   *
   * `upstream` is the jump chain's forwarded stream when there is one — it is
   * spliced the same way, because a hop stream is just as opaque as a socket to
   * whatever the final host writes on it. Otherwise the TCP connection is ours,
   * and a failure here is an ordinary connect failure the caller's retry policy
   * already knows how to classify.
   */
  async openRepairedSock(record, upstream) {
    let sock = upstream;
    if (sock === undefined) {
      // No jump-chain stream was handed in. Dial through the upstream SOCKS5
      // proxy when one is configured BEFORE falling back to a direct socket —
      // a plain net.createConnection here would silently bypass the proxy on
      // every banner-repair attempt.
      if (record.proxyConfig) {
        sock = await this.openProxySock(record);
      } else {
        const { host, port } = record.connectConfig;
        sock = net.createConnection({ host, port });
        // Standing listener first: an 'error' emission with no listener crashes
        // the DSH process, and pre-handshake failures are surfaced through the
        // banner read below rather than through this socket.
        sock.on("error", () => {});
        await new Promise((resolve, reject) => {
          const onConnect = () => { sock.off("error", onReject); resolve(); };
          const onReject = (error) => reject(error);
          sock.once("connect", onConnect);
          sock.once("error", onReject);
        });
      }
    }
    const { stream, plan } = await withRepairedBanner(sock, {
      // Never outlast the handshake budget the user set for this connection.
      timeoutMs: Math.min(record.connectConfig.readyTimeout ?? 20000, 10000)
    });
    record.bannerRepairNote = plan.reason === "" ? null : plan.reason;
    return stream;
  }

  /**
   * Build one full jump chain: hop clients connected through in order, each
   * forwarding a stream to the next destination, ending with a stream usable
   * as the `sock` of the target connection. Returns the final stream and the
   * list of hop clients (for teardown). Each hop config is an inline object
   * {host, port, username, auth, readyTimeout}.
   */
  async connectChain(proxyJump, targetHost, targetPort, proxyConfig = undefined) {
    const hops = [];
    let sock;
    // An upstream SOCKS5 proxy fronts the whole chain: the first hop is reached
    // by asking the proxy to CONNECT it, then SSH forwarding carries the rest.
    if (proxyConfig) {
      sock = await socks5Connect({
        proxy: { host: proxyConfig.host, port: proxyConfig.port, username: proxyConfig.username, password: proxyConfig.password },
        target: { host: proxyJump[0].host, port: proxyJump[0].port ?? 22 },
        timeoutMs: Math.min(proxyConfig.readyTimeout ?? 20000, 15000)
      });
    }
    for (let index = 0; index < proxyJump.length; index += 1) {
      const hopConfig = proxyJump[index];
      const hopConnectConfig = {
        host: hopConfig.host,
        port: hopConfig.port ?? 22,
        username: hopConfig.username,
        // Jump hosts are ordinary SSH servers; legacy KEX is NOT forced on
        // them, so an old switch as a jump host would need its own explicit
        // `legacy` support. The legacy downgrade applies to the target
        // connection (the one that terminates at the device).
        readyTimeout: hopConfig.readyTimeout ?? 20000
      };
      // Primary + optional secondary factor (dual-factor jump devices): the
      // hop's auth handler walks methods from whatever is configured.
      if (hopConfig.auth?.password !== undefined) hopConnectConfig.password = hopConfig.auth.password;
      if (hopConfig.auth?.privateKey !== undefined) {
        hopConnectConfig.privateKey = hopConfig.auth.privateKey;
        if (hopConfig.auth.passphrase !== void 0) hopConnectConfig.passphrase = hopConfig.auth.passphrase;
      }
      if (hopConfig.auth?.secondary?.kind === "key") {
        hopConnectConfig.privateKey = hopConfig.auth.secondary.privateKey;
        if (hopConfig.auth.secondary.passphrase !== void 0) hopConnectConfig.passphrase = hopConfig.auth.secondary.passphrase;
      } else if (hopConfig.auth?.secondary?.kind === "password") {
        hopConnectConfig.password = hopConfig.auth.secondary.password;
      }
      // Jump hosts get the same keyboard-interactive support as targets: an
      // MFA-prompting bastion is exactly where a saved password answers prompts.
      const hopTracker = createAuthTracker();
      if (hopConnectConfig.password !== undefined) {
        hopConnectConfig.tryKeyboard = true;
        hopConnectConfig.authHandler = makeAuthHandler(hopTracker, {
          hasPassword: true, hasPrivateKey: hopConnectConfig.privateKey !== undefined, tryKeyboard: true
        });
      }
      if (sock !== undefined) hopConnectConfig.sock = sock;
      const hopState = { hostKeyMismatch: null, hostKeyToRecord: null };
      this.attachHostVerifier(hopConnectConfig, hopState, hopConnectConfig.host, hopConnectConfig.port, hopConfig.hostKeyMode);
      const hopClient = new Client();
      try {
        await new Promise((resolve, reject) => {
          // Standing error listener for the hop's whole life: ssh2 may emit a
          // second protocol error after the first one settled this promise,
          // and an unhandled 'error' crashes the DSH process.
          let settled = false;
          if (hopConnectConfig.tryKeyboard) {
            hopClient.on("keyboard-interactive", (name, instructions, instructionsLang, prompts, finish) => {
              hopTracker.kbdSeen = true;
              finish(prompts.map(() => hopConnectConfig.password));
            });
          }
          hopClient.once("ready", () => { if (!settled) { settled = true; resolve(); } });
          hopClient.on("error", (cause) => { if (!settled) { settled = true; reject(cause); } });
          hopClient.connect(hopConnectConfig);
        });
        await this.persistFirstSeenHostKey(hopState);
      } catch (error) {
        for (const h of hops) { try { h.end(); } catch {} }
        if (hopState.hostKeyMismatch) {
          const m = hopState.hostKeyMismatch;
          const hostKeyFailure = this.hostKeyError(m);
          const hopError = new Error(`proxyJump hop ${index + 1} (${hopConnectConfig.username}@${hopConnectConfig.host}:${hopConnectConfig.port}): ${hostKeyFailure.message}`);
          hopError.code = hostKeyFailure.code;
          throw hopError;
        }
        throw new Error(`proxyJump hop ${index + 1} (${hopConnectConfig.username}@${hopConnectConfig.host}:${hopConnectConfig.port}): ${error.message}`);
      }
      hops.push(hopClient);
      // forwardOut to the next destination: the next hop, or the final target.
      const next = index + 1 < proxyJump.length ? proxyJump[index + 1] : null;
      const nextHost = next !== null ? next.host : targetHost;
      const nextPort = next !== null ? (next.port ?? 22) : targetPort;
      sock = await new Promise((resolve, reject) => {
        hopClient.forwardOut("127.0.0.1", 0, nextHost, nextPort, (error, stream) => {
          if (error) {
            for (const h of hops) { try { h.end(); } catch {} }
            reject(new Error(`proxyJump hop ${index + 1} forwardOut to ${nextHost}:${nextPort}: ${error.message}`));
          } else {
            resolve(stream);
          }
        });
      });
    }
    return { hops, sock };
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Wire transport-loss handlers to the record's current client. */
  /**
   * Defensive logging: ctx.logger is not wired in the DSH host, so console
   * output is what reaches ~/.dsh/web.log. Without this, a security-relevant
   * decision (a downgraded SSH handshake) would leave no trace anywhere.
   */
  log(message) {
    try { this.ctx?.logger?.warn?.(message); } catch {}
    try { console.warn("[dsh-xssh-ops]", message); } catch {}
  }

  attachTransportHandlers(record) {
    const client = record.client;
    client.on("error", (error) => this.handleTransportLoss(record, client, error));
    client.on("close", () => this.handleTransportLoss(record, client, null));
  }

  /**
   * The transport died under us (idle NAT drop, network blip, server reset).
   * Mark the record dead, retire its shell sessions and SFTP channel, then
   * schedule a transparent reconnect so later operations self-heal instead of
   * forcing a brand-new session every time.
   */
  handleTransportLoss(record, client, _error) {
    if (record.closing || record.client !== client || record.dead) return;
    record.dead = true;
    record.sftp = null;
    for (const sessionId of [...record.sessions]) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.exited = session.exited ?? { code: 1 };
        session.stream = null;
        this.rememberExit(sessionId, session.exited);
      }
      this.sessions.delete(sessionId);
    }
    record.sessions.clear();
    for (const tunnel of record.tunnels.values()) tunnel.active = false;
    this.scheduleReconnect(record);
  }

  /** Auto-reconnect a dead record with capped exponential backoff. */
  scheduleReconnect(record) {
    if (record.closing || !record.dead || record.reconnectTimer !== null) return;
    const delay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** Math.min(record.reconnectAttempts, 5)
    );
    record.reconnectAttempts += 1;
    record.reconnectTimer = setTimeout(async () => {
      record.reconnectTimer = null;
      if (record.closing || !record.dead) return;
      const connected = await this.connectClient(record, 0);
      if (!connected.ok) {
        // A host-key mismatch/unseen must NOT trigger a reconnect storm against
        // a possibly re-provisioned or impersonated server: stop retrying and
        // let the operator decide (forget the key or investigate).
        const code = connected.error?.code;
        if (code === "host-key-mismatch" || code === "host-key-unseen" || code === "host-key-error") {
          return;
        }
        this.scheduleReconnect(record);
        return;
      }
      this.attachTransportHandlers(record);
      for (const tunnel of record.tunnels.values()) {
        if (tunnel.kind === "remote" && tunnel.bridgeInfo?.bridge) {
          record.client.prependListener("tcp connection", tunnel.bridgeInfo.bridge);
        }
        tunnel.active = true;
      }
      const waiters = record.reconnectWaiters.splice(0);
      for (const waiter of waiters) waiter();
    }, delay);
  }

  /**
   * Wait until the record's transport is usable. If it is dead, waits for the
   * in-flight reconnect (bounded). Resolves false only when the connection was
   * explicitly closed or reconnect did not complete in time.
   */
  ensureAlive(record, timeoutMs = RECONNECT_WAIT_MS) {
    if (record.closing) return Promise.resolve(false);
    if (!record.dead) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      record.reconnectWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  requireProfileTable() {
    if (this.profileTable === null) throw new Error("SSH resource storage is not ready");
    return this.profileTable;
  }

  requireKnownHostTable() {
    if (this.knownHostTable === null) throw new Error("known-host storage is not ready");
    return this.knownHostTable;
  }

  requireGroupTable() {
    if (this.groupTable === null) throw new Error("SSH resource storage is not ready");
    return this.groupTable;
  }

  requireCredentialTable() {
    if (this.credentialTable === null) throw new Error("SSH credential storage is not ready");
    return this.credentialTable;
  }

  async credentialPublic(credentialId, record) {
    const refs = sharedCredentialRefs(credentialId);
    const primaryRef = record.authKind === "password" ? refs.password : refs.privateKey;
    const secondaryRef = record.authKind === "password" ? refs.privateKey : refs.password;
    const [primary, passphrase, secondary] = await Promise.all([
      this.ctx.credentials.describe(credentialRef(primaryRef)),
      this.ctx.credentials.describe(credentialRef(refs.passphrase)),
      this.ctx.credentials.describe(credentialRef(secondaryRef))
    ]);
    return { credentialId, name: record.name, authKind: record.authKind, credentialConfigured: primary.configured, passphraseConfigured: passphrase.configured, secondaryConfigured: secondary.configured };
  }

  async credentialList() {
    try {
      const credentials = await Promise.all([...this.requireCredentialTable().entries()].map(async ([id, record]) => await this.credentialPublic(id, record)));
      credentials.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
      return { ok: true, value: { credentials } };
    } catch (error) { return { ok: false, error: fail("credential-list-failed", error.message) }; }
  }

  async credentialSave(request) {
    try {
      const table = this.requireCredentialTable();
      const credentialId = request.credentialId ?? randomUUID();
      const previous = table.get(credentialId);
      if (request.credentialId !== undefined && previous === undefined) return { ok: false, error: fail("no-credential", `SSH credential "${credentialId}" does not exist`) };
      const now = new Date().toISOString();
      const record = { name: request.name.trim(), authKind: request.authKind, createdAt: previous?.createdAt ?? now, updatedAt: now };
      await table.put(credentialId, record);
      return { ok: true, value: { credential: await this.credentialPublic(credentialId, record), credentialRefs: sharedCredentialRefs(credentialId) } };
    } catch (error) { return { ok: false, error: fail("credential-save-failed", error.message) }; }
  }

  async credentialDelete(request) {
    try {
      const table = this.requireCredentialTable();
      if (table.get(request.credentialId) === undefined) return { ok: true, value: { deleted: false } };
      const usedBy = [...this.requireProfileTable().entries()].find(([, profile]) => profile.credentialId === request.credentialId || profile.proxyJump?.some((hop) => hop.credentialId === request.credentialId));
      if (usedBy) return { ok: false, error: fail("credential-in-use", t("此凭据仍被 SSH 资源或跳板机引用；请先改用其他凭据")) };
      await Promise.all(Object.values(sharedCredentialRefs(request.credentialId)).map(async (ref) => await this.ctx.credentials.unset(credentialRef(ref))));
      await table.delete(request.credentialId);
      return { ok: true, value: { deleted: true } };
    } catch (error) { return { ok: false, error: fail("credential-delete-failed", error.message) }; }
  }

  groupPublic(groupId, record) {
    const profileCount = [...this.requireProfileTable().entries()].filter(([, profile]) => profile.groupId === groupId).length;
    return { groupId, name: record.name, profileCount };
  }

  async profilePublic(profileId, record) {
    const shared = record.credentialId ? this.requireCredentialTable().get(record.credentialId) : undefined;
    const refs = shared ? sharedCredentialRefs(record.credentialId) : profileCredentialRefs(profileId);
    const primaryRef = record.authKind === "password" ? refs.password : refs.privateKey;
    const secondaryRef = record.authKind === "password" ? refs.privateKey : refs.password;
    const [primary, passphrase, secondary, proxyPw] = await Promise.all([
      this.ctx.credentials.describe(credentialRef(primaryRef)),
      this.ctx.credentials.describe(credentialRef(refs.passphrase)),
      this.ctx.credentials.describe(credentialRef(secondaryRef)),
      this.ctx.credentials.describe(credentialRef(profileProxyPasswordRef(profileId)))
    ]);
    const connected = [...this.connections.values()].some((connection) => connection.profileId === profileId);
    const group = record.groupId === null ? undefined : this.requireGroupTable().get(record.groupId);
    return {
      profileId,
      name: record.name,
      host: record.host,
      port: record.port,
      username: record.username,
      authKind: record.authKind,
      hostKeyMode: record.hostKeyMode ?? DEFAULT_HOST_KEY_MODE,
      agentForward: record.agentForward === true,
      credentialId: shared ? record.credentialId : null,
      credentialName: shared?.name ?? null,
      proxyJump: record.proxyJump ?? [],
      // Coordinates only: the proxy password never appears here. Its presence
      // is surfaced as the boolean proxyCredentialConfigured so the form can
      // show "saved; leave blank to keep it" without echoing the secret.
      ...(record.proxy ? { proxy: record.proxy } : {}),
      proxyCredentialConfigured: proxyPw.configured,
      defaultProjectPath: record.defaultProjectPath ?? null,
      loginCommand: record.loginCommand ?? null,
      // Per-server login actions; omitted when the record carries none so an
      // untouched resource keeps reading exactly like before this feature.
      ...(record.loginScript ? { loginScript: record.loginScript } : {}),
      groupId: group === undefined ? null : record.groupId,
      groupName: group?.name ?? null,
      credentialConfigured: primary.configured,
      passphraseConfigured: passphrase.configured,
      secondaryConfigured: secondary.configured,
      connected
    };
  }

  async profileList() {
    try {
      const profiles = await Promise.all(
        [...this.requireProfileTable().entries()].map(async ([profileId, record]) => await this.profilePublic(profileId, record))
      );
      profiles.sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
      return { ok: true, value: { profiles } };
    } catch (error) {
      return { ok: false, error: fail("profile-list-failed", error.message) };
    }
  }

  async profileSave(request) {
    try {
      const table = this.requireProfileTable();
      const profileId = request.profileId ?? randomUUID();
      const previous = table.get(profileId);
      if (request.profileId !== undefined && previous === undefined) {
        return { ok: false, error: fail("no-profile", `SSH resource "${profileId}" does not exist`) };
      }
      const now = new Date().toISOString();
      const groupId = request.groupId ?? null;
      if (groupId !== null && this.requireGroupTable().get(groupId) === undefined) {
        return { ok: false, error: fail("no-group", `SSH group "${groupId}" does not exist`) };
      }
      if (request.credentialId !== null && request.credentialId !== undefined) {
        const credential = this.requireCredentialTable().get(request.credentialId);
        if (credential === undefined) return { ok: false, error: fail("no-credential", `SSH credential "${request.credentialId}" does not exist`) };
        if (credential.authKind !== request.authKind) return { ok: false, error: fail("credential-auth-mismatch", t("所选共享凭据的认证方式与服务器不一致")) };
      }
      const proxyJump = request.proxyJump ?? previous?.proxyJump ?? [];
      const defaultProjectPath = Object.hasOwn(request, "defaultProjectPath")
        ? request.defaultProjectPath
        : (previous?.defaultProjectPath ?? null);
      const loginCommand = Object.hasOwn(request, "loginCommand")
        ? request.loginCommand
        : (previous?.loginCommand ?? null);
      // Per-server login actions (script rules + post-login commands). The form
      // always submits the block; null means "clear it", an omitted field keeps
      // the stored record for backwards-compatible callers.
      const loginScript = Object.hasOwn(request, "loginScript")
        ? (request.loginScript ?? undefined)
        : (previous?.loginScript ?? undefined);
      const seenJumpProfiles = new Set();
      for (const hop of proxyJump) {
        if (hop.profileId) {
          if (hop.profileId === profileId) return { ok: false, error: fail("jump-cycle", t("服务器不能把自己设为跳板机")) };
          if (seenJumpProfiles.has(hop.profileId)) return { ok: false, error: fail("jump-duplicate", t("同一条跳板链不能重复选择同一台服务器")) };
          seenJumpProfiles.add(hop.profileId);
          if (this.requireProfileTable().get(hop.profileId) === undefined) return { ok: false, error: fail("no-profile", `jump-host profile "${hop.profileId}" does not exist`) };
          continue;
        }
        if ((hop.authKind ?? "credential") !== "password" && this.requireCredentialTable().get(hop.credentialId) === undefined) return { ok: false, error: fail("no-credential", `jump-host credential "${hop.credentialId}" does not exist`) };
      }
      // Upstream SOCKS5 proxy: coordinates only, persisted without a password.
      // The form always submits the proxy block; an empty host means "no
      // proxy", so it is stored as undefined rather than an empty shell. The
      // password rides along in request.proxyPassword and is written into the
      // credential store by the host against the ref returned below.
      const proxy = request.proxy && request.proxy.host
        ? {
            type: "socks5",
            host: request.proxy.host.trim(),
            port: request.proxy.port ?? 1080,
            ...(request.proxy.username ? { username: request.proxy.username.trim() } : {})
          }
        : undefined;
      const record = {
        name: request.name.trim(),
        host: request.host.trim(),
        port: request.port ?? 22,
        username: request.username.trim(),
        authKind: request.authKind,
        hostKeyMode: request.hostKeyMode ?? DEFAULT_HOST_KEY_MODE,
        agentForward: request.agentForward === true,
        // An explicit null detaches a shared credential and restores the
        // server's legacy dedicated credential slot; only an omitted field
        // preserves old records for backwards-compatible callers.
        credentialId: Object.hasOwn(request, "credentialId") ? request.credentialId : (previous?.credentialId ?? null),
        defaultProjectPath,
        loginCommand,
        ...(loginScript ? { loginScript } : {}),
        proxyJump,
        ...(proxy ? { proxy } : {}),
        groupId,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      };
      await table.put(profileId, record);
      return {
        ok: true,
        value: {
          profile: await this.profilePublic(profileId, record),
          credentialRefs: { ...(record.credentialId ? sharedCredentialRefs(record.credentialId) : profileCredentialRefs(profileId)), proxyPassword: profileProxyPasswordRef(profileId), proxyJumpPasswords: (record.proxyJump ?? []).map((_, index) => profileJumpPasswordRef(profileId, index)), proxyJumpPrivateKeys: (record.proxyJump ?? []).map((_, index) => profileJumpPrivateKeyRef(profileId, index)), proxyJumpPassphrases: (record.proxyJump ?? []).map((_, index) => profileJumpPassphraseRef(profileId, index)) }
        }
      };
    } catch (error) {
      return { ok: false, error: fail("profile-save-failed", error.message) };
    }
  }

  async profileDelete(request) {
    try {
      const table = this.requireProfileTable();
      const record = table.get(request.profileId);
      if (record === undefined) return { ok: true, value: { deleted: false } };
      const refs = profileCredentialRefs(request.profileId);
      // Only names derived from this resource id are ever removed. A live SSH
      // transport keeps running; deletion only forgets future quick-connect.
      await Promise.all([profileProxyPasswordRef(request.profileId), ...Object.values(refs), ...Array.from({ length: 8 }, (_, index) => [profileJumpPasswordRef(request.profileId, index), profileJumpPrivateKeyRef(request.profileId, index), profileJumpPassphraseRef(request.profileId, index)]).flat()].map(async (ref) => await this.ctx.credentials.unset(credentialRef(ref))));
      await table.delete(request.profileId);
      return { ok: true, value: { deleted: true } };
    } catch (error) {
      return { ok: false, error: fail("profile-delete-failed", error.message) };
    }
  }

  /**
   * Disconnect every live connection opened for a saved profile. The
   * resources page owns this path so a "已连接" badge always has a matching
   * operator control, including connections re-adopted after a page reload.
   */
  async profileDisconnect(request) {
    try {
      const targets = [...this.connections.values()].filter((connection) => connection.profileId === request.profileId);
      for (const record of targets) await this.disconnect({ connectionId: record.id });
      return { ok: true, value: { disconnected: targets.length } };
    } catch (error) {
      return { ok: false, error: fail("profile-disconnect-failed", error.message) };
    }
  }

  async profileConnect(request) {
    try {
      const record = this.requireProfileTable().get(request.profileId);
      if (record === undefined) return { ok: false, error: fail("no-profile", `SSH resource "${request.profileId}" does not exist`) };
      const reusable = findReusableProfileConnection([...this.connections.values()], request.profileId, {
        reuseExisting: request.reuseExisting,
        hasProxyJumpOverride: request.proxyJumpProfileIds?.length > 0
      });
      if (reusable) {
        const value = { connectionId: reusable.id, host: reusable.host, port: reusable.port, username: reusable.username };
        if (reusable.name !== undefined) value.name = reusable.name;
        return { ok: true, value };
      }
      const refs = record.credentialId ? sharedCredentialRefs(record.credentialId) : profileCredentialRefs(request.profileId);
      const targetAuth = await this.resolveCredentialAuth(refs, record.authKind);
      if (targetAuth === undefined) {
        return { ok: false, error: fail("credential-missing", `SSH resource "${record.name}" has no saved ${record.authKind === "password" ? "password" : "private key"}`) };
      }
      const proxyJump = [];
      const configuredHops = request.proxyJumpProfileIds?.map((profileId) => ({ profileId })) ?? record.proxyJump ?? [];
      const seenHops = new Set();
      for (const [index, hop] of configuredHops.entries()) {
        if (hop.profileId) {
          if (hop.profileId === request.profileId || seenHops.has(hop.profileId)) return { ok: false, error: fail("jump-cycle", t("跳板链不能包含当前服务器或重复服务器")) };
          seenHops.add(hop.profileId);
          const jump = this.requireProfileTable().get(hop.profileId);
          if (jump === undefined) return { ok: false, error: fail("no-profile", `jump-host profile "${hop.profileId}" does not exist`) };
          const jumpRefs = jump.credentialId ? sharedCredentialRefs(jump.credentialId) : profileCredentialRefs(hop.profileId);
          const auth = await this.resolveCredentialAuth(jumpRefs, jump.authKind);
          if (auth === undefined) return { ok: false, error: fail("credential-missing", `jump host "${jump.name}" has no saved credential`) };
          proxyJump.push({ host: jump.host, port: jump.port, username: jump.username, hostKeyMode: jump.hostKeyMode, auth });
          continue;
        }
        if ((hop.authKind ?? "credential") === "password") {
          const secret = await this.ctx.credentials.resolve(credentialRef(profileJumpPasswordRef(request.profileId, index)));
          if (secret === undefined) return { ok: false, error: fail("credential-missing", `jump host "${hop.host}" has no saved password`) };
          proxyJump.push({ host: hop.host, port: hop.port, username: hop.username, hostKeyMode: hop.hostKeyMode, auth: { kind: "password", password: secret.value } });
          continue;
        }
        if (hop.authKind === "key") {
          const privateKey = await this.ctx.credentials.resolve(credentialRef(profileJumpPrivateKeyRef(request.profileId, index)));
          if (privateKey === undefined) return { ok: false, error: fail("credential-missing", `jump host "${hop.host}" has no saved private key`) };
          const passphrase = await this.ctx.credentials.resolve(credentialRef(profileJumpPassphraseRef(request.profileId, index)));
          proxyJump.push({ host: hop.host, port: hop.port, username: hop.username, hostKeyMode: hop.hostKeyMode, auth: { kind: "key", privateKey: privateKey.value, ...(passphrase === undefined ? {} : { passphrase: passphrase.value }) } });
          continue;
        }
        const credential = this.requireCredentialTable().get(hop.credentialId);
        const hopRefs = sharedCredentialRefs(hop.credentialId);
        const auth = await this.resolveCredentialAuth(hopRefs, credential.authKind);
        if (auth === undefined) return { ok: false, error: fail("credential-missing", `jump host "${hop.host}" has no saved credential`) };
        proxyJump.push({ host: hop.host, port: hop.port, username: hop.username, hostKeyMode: hop.hostKeyMode, auth });
      }
      // Upstream SOCKS5 proxy: coordinates come from the saved record; the
      // password (if any) is resolved from the credential store, never from
      // the record. No proxy configured → the field is omitted entirely.
      let proxy;
      if (record.proxy && record.proxy.host) {
        proxy = { ...record.proxy };
        const secret = await this.ctx.credentials.resolve(credentialRef(profileProxyPasswordRef(request.profileId)));
        if (secret?.value) proxy.password = secret.value;
      }
      return await this.connectInternal({
        name: record.name,
        host: record.host,
        port: record.port,
        username: record.username,
        hostKeyMode: record.hostKeyMode,
        agentForward: record.agentForward === true,
        readyTimeout: request.readyTimeout,
        retries: request.retries,
        auth: targetAuth,
        ...(proxy ? { proxy } : {}),
        ...(proxyJump.length > 0 ? { proxyJump } : {})
      }, request.profileId);
    } catch (error) {
      return { ok: false, error: fail("profile-connect-failed", error.message) };
    }
  }

  /**
   * Feasibility probe for an upstream SOCKS5 proxy: open the proxy, ask it to
   * CONNECT the target, read the peer's first bytes (normally the SSH banner),
   * then close. It performs NO SSH handshake and NO authentication, so it is
   * safe to run before saving credentials and never opens a persistent
   * connection. The proxy password is used in-memory only and never echoed.
   */
  async proxyTest(request) {
    const targetHost = request.target?.host ?? request.host;
    const targetPort = request.target?.port ?? request.port ?? 22;
    const proxy = request.proxy;
    const started = Date.now();
    let socket;
    try {
      socket = await socks5Connect({
        proxy: { host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password },
        target: { host: targetHost, port: targetPort },
        timeoutMs: Math.min(request.timeoutMs ?? 10000, 15000)
      });
      // Read the peer's identification line through the tunnel (or up to 255
      // bytes / a short deadline) purely to prove the tunnel carries bytes.
      const banner = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          // A silent-but-open tunnel is still a successful CONNECT; many
          // non-SSH services wait for the client to speak first.
          resolve("");
        }, 3000);
        let received = Buffer.alloc(0);
        const onData = (chunk) => {
          received = Buffer.concat([received, chunk]);
          const newline = received.indexOf(0x0a);
          if (newline >= 0 || received.length >= 255) {
            clearTimeout(timer);
            socket.off("data", onData);
            resolve(received.subarray(0, newline >= 0 ? newline + 1 : 255).toString("utf8").trim());
          }
        };
        const onError = (error) => { clearTimeout(timer); reject(error); };
        socket.on("data", onData);
        socket.once("error", onError);
      });
      return {
        ok: true,
        value: {
          reachable: true,
          proxyHost: proxy.host,
          proxyPort: proxy.port,
          targetHost,
          targetPort,
          authenticated: Boolean(proxy.username),
          banner: banner ? banner.slice(0, 255) : "",
          elapsedMs: Date.now() - started
        }
      };
    } catch (error) {
      // Reuse the structured proxy diagnosis so the tool surfaces the same
      // actionable Chinese message as a real connect failure.
      const diagnosis = classifyConnectFailure(error, undefined, {});
      return {
        ok: true,
        value: {
          reachable: false,
          proxyHost: proxy.host,
          proxyPort: proxy.port,
          targetHost,
          targetPort,
          authenticated: Boolean(proxy.username),
          errorCode: error?.code ?? "proxy-error",
          reason: diagnosis.reason,
          message: diagnosis.message,
          hints: diagnosis.hints,
          elapsedMs: Date.now() - started
        }
      };
    } finally {
      try { socket?.destroy(); } catch {}
    }
  }

  /**
   * Abort an in-flight profile connect. Safe to call after the connect
   * settled (then it is a no-op); while the handshake is pending, ending the
   * socket breaks the wait immediately.
   */
  async cancelProfileConnect(request) {
    try {
      let cancelled = 0;
      for (const record of this.connections.values()) {
        if (!record.connecting) continue;
        if (request?.profileId !== undefined && record.profileId !== request.profileId) continue;
        record.closing = true;
        cancelled += 1;
        try { for (const hop of record.hops) { hop.end(); } } catch {}
        record.hops = [];
        try { record.client?.end(); } catch {}
      }
      return { ok: true, value: { cancelled } };
    } catch (error) {
      return { ok: false, error: fail("cancel-connect-failed", error.message) };
    }
  }

  // ── agent auto-connect (issue #25) ─────────────────────────────────────────

  async agentSettingsGet() {
    return { ok: true, value: { agentAutoConnect: this.agentAutoConnect } };
  }

  async agentSettingsSave(request) {
    const agentAutoConnect = request.agentAutoConnect === true;
    try {
      const previous = this.settingsTable.get(SETTINGS_ROW_ID) ?? {};
      await this.settingsTable.put(SETTINGS_ROW_ID, {
        ...previous,
        agentAutoConnect,
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      return { ok: false, error: fail("agent-settings-save-failed", error.message) };
    }
    this.agentAutoConnect = agentAutoConnect;
    return { ok: true, value: { agentAutoConnect: this.agentAutoConnect } };
  }

  // ── interface language ─────────────────────────────────────────────────────

  /**
   * The stored language, or null when the operator never chose one (meaning:
   * follow DSH's own Settings → Language). The host half applies the choice
   * at boot; agent-visible tool messages and safety-policy notices follow the
   * same language as the panel.
   */
  async languageGet() {
    return { ok: true, value: { language: this.language, autoApplySystemLanguage: this.autoApplySystemLanguage } };
  }

  // ── R8 保持活动状态（计划 5.8）──────────────────────────────────────────────

  /** 读当前保活设置（含默认值）。设置页据此渲染表单。 */
  async keepAliveGet() {
    const settings = this.settings ?? {};
    return {
      ok: true,
      value: {
        sshKeepAliveEnabled: settings.sshKeepAliveEnabled !== false,
        sshKeepAliveIntervalSec: settings.sshKeepAliveIntervalSec ?? KEEPALIVE_DEFAULTS.sshKeepAliveIntervalSec,
        sshKeepAliveCountMax: settings.sshKeepAliveCountMax ?? KEEPALIVE_DEFAULTS.sshKeepAliveCountMax,
        idleStringEnabled: settings.idleStringEnabled === true,
        idleStringIntervalSec: settings.idleStringIntervalSec ?? KEEPALIVE_DEFAULTS.idleStringIntervalSec,
        idleStringText: settings.idleStringText ?? "",
        tcpKeepAliveEnabled: settings.tcpKeepAliveEnabled === true,
        tcpKeepAliveInitialDelaySec: settings.tcpKeepAliveInitialDelaySec ?? KEEPALIVE_DEFAULTS.tcpKeepAliveInitialDelaySec,
        // R9 登录脚本（同一张设置表的另半部分，同一个读写入口）
        loginScriptRulesEnabled: settings.loginScriptRulesEnabled === true,
        loginScriptRules: Array.isArray(settings.loginScriptRules) ? settings.loginScriptRules : [],
        expectMatchMode: settings.expectMatchMode ?? KEEPALIVE_DEFAULTS.expectMatchMode,
        expectStepTimeoutMs: settings.expectStepTimeoutMs ?? KEEPALIVE_DEFAULTS.expectStepTimeoutMs,
        // 超时策略：skip（默认，等不到就跳过）| strict（等不到就中止后续规则）
        onTimeout: settings.onTimeout === "strict" ? "strict" : "skip",
        loginScriptRunEnabled: settings.loginScriptRunEnabled === true,
        loginScriptPath: settings.loginScriptPath ?? "",
        loginScriptSandbox: settings.loginScriptSandbox ?? KEEPALIVE_DEFAULTS.loginScriptSandbox,
        proxyLibrary: Array.isArray(settings.proxyLibrary) ? settings.proxyLibrary : [],
        sendRule: normalizeSendRule(settings.sendRule),
        shortcuts: Array.isArray(settings.shortcuts) ? settings.shortcuts : [],
        mouse: normalizeMouseOptions(settings.mouse),
        terminalBackground: normalizeTerminalBackground(settings.terminalBackground),
        customPrompts: normalizeCustomPrompts(settings.customPrompts),
        terminalFont: normalizeTerminalFont(settings.terminalFont),
        outputWarnKB: Number.isSafeInteger(settings.outputWarnKB) ? settings.outputWarnKB : OUTPUT_LOG_DEFAULTS.outputWarnKB,
        sessionLogAutoPruneEnabled: settings.sessionLogAutoPruneEnabled !== false,
        sessionLogMaxTotalMB: Number.isSafeInteger(settings.sessionLogMaxTotalMB) ? settings.sessionLogMaxTotalMB : OUTPUT_LOG_DEFAULTS.sessionLogMaxTotalMB,
        sessionLogMaxAgeDays: Number.isSafeInteger(settings.sessionLogMaxAgeDays) ? settings.sessionLogMaxAgeDays : OUTPUT_LOG_DEFAULTS.sessionLogMaxAgeDays,
        broadcastHintDismissed: settings.broadcastHintDismissed === true,
        terminalFileLinks: settings.terminalFileLinks !== false,
        filesFollowTerminal: settings.filesFollowTerminal !== false
      }
    };
  }

  /**
   * 保存保活设置。**只接受白名单字段**：设置页发什么就存什么，但未知键一律忽略，
   * 避免把前端笔误写进持久化记录（记录 schema 会拒绝新键，报错时很难定位）。
   * ②（空闲字符串）与③（TCP 保活）即时生效；①（SSH 保活间隔）需重连才换 ssh2 参数。
   */
  async keepAliveSave(request = {}) {
    const patch = {};
    const bools = ["sshKeepAliveEnabled", "idleStringEnabled", "tcpKeepAliveEnabled", "sessionLogAutoPruneEnabled", "broadcastHintDismissed", "terminalFileLinks", "filesFollowTerminal"];
    for (const key of bools) {
      if (typeof request[key] === "boolean") patch[key] = request[key];
    }
    const numbers = {
      sshKeepAliveIntervalSec: [5, 3600],
      sshKeepAliveCountMax: [1, 20],
      idleStringIntervalSec: [0, 3600],
      tcpKeepAliveInitialDelaySec: [1, 86400],
      // 输出提示与会话日志自动清理（用户 2026-10-19）。
      outputWarnKB: [0, 10240],
      sessionLogMaxTotalMB: [50, 102400],
      sessionLogMaxAgeDays: [0, 3650]
    };
    for (const [key, [min, max]] of Object.entries(numbers)) {
      const value = request[key];
      if (value === undefined) continue;
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < min || numeric > max) {
        return { ok: false, error: fail("keepalive-invalid", `${key} must be an integer in [${min}, ${max}]`) };
      }
      patch[key] = numeric;
    }
    if (typeof request.idleStringText === "string") {
      if (request.idleStringText.length > 4096) {
        return { ok: false, error: fail("keepalive-invalid", "idleStringText is limited to 4096 characters") };
      }
      patch.idleStringText = request.idleStringText;
    }

    // ── R9 登录脚本（与保活同表，所以同一个保存入口）─────────────────────
    for (const key of ["loginScriptRulesEnabled", "loginScriptRunEnabled"]) {
      if (typeof request[key] === "boolean") patch[key] = request[key];
    }
    if (request.expectMatchMode !== undefined) {
      if (!["substring", "glob", "regex"].includes(request.expectMatchMode)) {
        return { ok: false, error: fail("login-script-invalid", `expectMatchMode must be substring|glob|regex`) };
      }
      patch.expectMatchMode = request.expectMatchMode;
    }
    if (request.onTimeout !== undefined) {
      if (!["skip", "strict"].includes(request.onTimeout)) {
        return { ok: false, error: fail("login-script-invalid", "onTimeout must be skip|strict") };
      }
      patch.onTimeout = request.onTimeout;
    }
    if (request.expectStepTimeoutMs !== undefined) {
      const numeric = Number(request.expectStepTimeoutMs);
      if (!Number.isInteger(numeric) || numeric < 1000 || numeric > 600000) {
        return { ok: false, error: fail("login-script-invalid", "expectStepTimeoutMs must be 1000..600000") };
      }
      patch.expectStepTimeoutMs = numeric;
    }
    // 代理库（用户 2026-10-17 要求：设置页统一维护，服务器资源里选择）。
    // 只保留白名单字段。密码按明文随库保存（用户 2026-10-18 要求可核对展示）；
    // 资源侧的代理密码仍走凭据存放，选择代理时由表单显式带入。
    if (request.proxyLibrary !== undefined) {
      if (!Array.isArray(request.proxyLibrary)) {
        return { ok: false, error: fail("proxy-library-invalid", "proxyLibrary must be an array") };
      }
      patch.proxyLibrary = request.proxyLibrary.slice(0, 64).map((entry) => ({
        proxyId: String(entry?.proxyId ?? randomUUID()).slice(0, 64),
        name: String(entry?.name ?? "").slice(0, 120),
        host: String(entry?.host ?? "").slice(0, 255),
        port: Number.isInteger(entry?.port) ? entry.port : 1080,
        ...(entry?.username ? { username: String(entry.username).slice(0, 128) } : {}),
        ...(entry?.password ? { password: String(entry.password).slice(0, 256) } : {})
      })).filter((entry) => entry.name !== "" && entry.host !== "");
    }
    // 命令框发送规则（用户 2026-10-18）：归一化后保存，空值回落默认。
    if (request.sendRule !== undefined) {
      patch.sendRule = normalizeSendRule(request.sendRule);
    }
    // 可配置快捷键（用户 2026-10-18）：白名单清洗，最多 64 条、每条 1–3 键。
    if (request.shortcuts !== undefined) {
      if (!Array.isArray(request.shortcuts)) {
        return { ok: false, error: fail("shortcuts-invalid", "shortcuts must be an array") };
      }
      patch.shortcuts = request.shortcuts.slice(0, 64).map((item) => ({
        id: String(item?.id ?? randomUUID()).slice(0, 64),
        keys: Array.isArray(item?.keys)
          ? item.keys.map((key) => String(key).slice(0, 32)).filter((key) => key !== "").slice(0, 3)
          : [],
        action: String(item?.action ?? "").slice(0, 64),
        ...(item?.prompt ? { prompt: String(item.prompt).slice(0, 4096) } : {})
      })).filter((item) => item.keys.length > 0 && item.action !== "");
    }
    // 鼠标与选择（用户 2026-10-18）：归一化后保存。
    if (request.mouse !== undefined) {
      patch.mouse = normalizeMouseOptions(request.mouse);
    }
    // 终端背景图（用户 2026-10-18）：归一化后保存。
    if (request.terminalBackground !== undefined) {
      patch.terminalBackground = normalizeTerminalBackground(request.terminalBackground);
    }
    if (request.customPrompts !== undefined) {
      patch.customPrompts = normalizeCustomPrompts(request.customPrompts);
    }
    // 终端字体与字号（用户 2026-10-19）。
    if (request.terminalFont !== undefined) {
      patch.terminalFont = normalizeTerminalFont(request.terminalFont);
    }
    if (request.loginScriptSandbox !== undefined) {
      if (!["restricted", "trusted"].includes(request.loginScriptSandbox)) {
        return { ok: false, error: fail("login-script-invalid", "loginScriptSandbox must be restricted|trusted") };
      }
      patch.loginScriptSandbox = request.loginScriptSandbox;
    }
    if (request.loginScriptPath !== undefined) {
      if (typeof request.loginScriptPath !== "string" || request.loginScriptPath.length > 1024) {
        return { ok: false, error: fail("login-script-invalid", "loginScriptPath must be a string under 1024 chars") };
      }
      patch.loginScriptPath = request.loginScriptPath;
    }
    if (request.loginScriptRules !== undefined) {
      const rules = Array.isArray(request.loginScriptRules)
        ? request.loginScriptRules.map((rule) => ({
            expect: String(rule?.expect ?? ""),
            send: String(rule?.send ?? ""),
            ...(rule?.timeoutMs === undefined ? {} : { timeoutMs: Number(rule.timeoutMs) })
          }))
        : null;
      if (rules === null) return { ok: false, error: fail("login-script-invalid", "loginScriptRules must be an array") };
      // **保存时**做危险命令与语法校验：规则在连接阶段自动执行，没有确认卡片可弹。
      const mode = patch.expectMatchMode ?? this.settings?.expectMatchMode ?? "substring";
      const timeout = patch.expectStepTimeoutMs ?? this.settings?.expectStepTimeoutMs ?? 15000;
      const validation = validateLoginScriptRules(rules, { matchMode: mode, stepTimeoutMs: timeout });
      if (!validation.ok) {
        const first = validation.problems[0];
        return {
          ok: false,
          error: fail("login-script-unsafe", `rule ${first.index + 1}: ${first.message}`),
          value: { problems: validation.problems }
        };
      }
      patch.loginScriptRules = rules;
    }

    // R9② 连接时运行脚本的保存时校验（方案 A 只允许 restricted，trusted 明确拒绝）。
    if (request.loginScriptRunEnabled !== undefined || request.loginScriptPath !== undefined || request.loginScriptSandbox !== undefined) {
      const check = validateScriptSettings({
        runEnabled: patch.loginScriptRunEnabled ?? this.settings?.loginScriptRunEnabled ?? false,
        path: patch.loginScriptPath ?? this.settings?.loginScriptPath ?? "",
        sandbox: patch.loginScriptSandbox ?? this.settings?.loginScriptSandbox ?? "restricted"
      });
      if (!check.ok) {
        return {
          ok: false,
          error: fail("login-script-unsafe", check.problems[0].message),
          value: { problems: check.problems }
        };
      }
    }

    try {
      const previous = this.settingsTable.get(SETTINGS_ROW_ID) ?? {};
      await this.settingsTable.put(SETTINGS_ROW_ID, { ...previous, ...patch, updatedAt: new Date().toISOString() });
    } catch (error) {
      return { ok: false, error: fail("keepalive-save-failed", error.message) };
    }
    this.settings = { ...(this.settings ?? {}), ...patch };
    // 间隔变化必须让操作者知道「要重连才生效」，否则会以为设置没保存上。
    const reconnectRequired = patch.sshKeepAliveIntervalSec !== undefined || patch.sshKeepAliveEnabled !== undefined;
    return { ok: true, value: { ...(await this.keepAliveGet()).value, reconnectRequired } };
  }

  /**
   * R9② 连接时运行脚本（**方案 A：受限 DSL，只暴露会话 API**，用户 2026-10-17 拍板）。
   *
   * 与 R9① 规则表的区别：规则表是「等提示→送字」的有序清单；脚本能做更复杂的编排
   * （循环、条件、按行号读回再决定下一步）。两者**独立启动**，互不依赖。
   *
   * 安全边界（方案 A 的全部意义）：
   *   - 脚本跑在 `node:vm` 的隔离 context 里，**只注入** `expect/send/readLines/log/sleep/close`；
   *     `require`/`process`/`fs`/`net`/`child_process` 全部不可得（`test/login-script-dsl.mjs` 实测）；
   *   - 保存时校验拒绝 `sandbox: "trusted"`（方案 A 下不存在完整宿主能力这条路）；
   *   - 脚本发出的内容**经既有写入路径** ⇒ 行日志/行号/台账照常可用，标 `source: login-script`；
   *   - 超预算（总时长 / 步数）即中止，**不影响会话可用性**。
   */
  async startSessionScriptIfEnabled(session) {
    const settings = this.settings ?? {};
    if (settings.loginScriptRunEnabled !== true) return { started: false };
    const scriptPath = String(settings.loginScriptPath ?? "");
    if (scriptPath === "") return { started: false };

    // 保存时校验的兜底复用：路径与沙箱级别都再查一次（设置文件可能被手工改动）。
    const problems = validateScriptSettings({
      runEnabled: true,
      path: scriptPath,
      sandbox: settings.loginScriptSandbox ?? "restricted"
    });
    if (!problems.ok) {
      this.appendTerminalNotice(session, t(`连接脚本未通过校验，已跳过：${problems.problems[0].message}`));
      return { started: false, error: problems.problems[0] };
    }

    let source;
    try {
      source = await loadScriptSource(scriptPath);
    } catch (error) {
      // 读不到脚本要**明确告警**，不能静默跳过（用户以为它跑了）。
      this.appendTerminalNotice(session, t(`连接脚本读取失败，已跳过：${error.message}`));
      return { started: false, error: { message: error.message } };
    }

    const runner = createScriptRunner({
      // 四个能力都接到既有实现上，所以脚本里做的事与会话本身完全同源。
      expect: (pattern, timeoutMs) => this.waitForSessionOutput(session, pattern, timeoutMs),
      send: async (text, pressEnter) => {
        const result = await this.sendCommand({
          sessionId: session.id,
          text,
          pressEnter: pressEnter !== false,
          source: "login-script"
        });
        if (!result.ok) throw new Error(result.error?.message ?? "send failed");
      },
      readLines: async (fromLine, toLine) => {
        const read = this.readTerminalLines({ sessionId: session.id, fromLine, toLine });
        if (!read.ok) throw new Error(read.error?.message ?? "readLines failed");
        return read.value.lines;
      },
      log: (message) => {
        // 脚本的 log 只进会话日志（不发送到远端），与会话输出同处可查。
        try { session.logMeta !== undefined && this.sessionLogStore()?.append(session.id, `[script] ${message}\n`); } catch { /* best effort */ }
      }
    });

    session.sessionScript = { path: scriptPath, startedAt: new Date().toISOString() };
    const started = Date.now();
    try {
      const result = await runner.run(source);
      session.sessionScript.result = result;
      if (!result.ok) {
        this.appendTerminalNotice(session, t(`连接脚本执行失败（${result.error.message}）`));
      }
      return {
        started: true,
        ok: result.ok,
        steps: result.steps,
        elapsedMs: Date.now() - started,
        sent: result.sent.length,
        error: result.error
      };
    } catch (error) {
      // 引擎本身抛错（例如源码语法错误）也要被收住，会话不受影响。
      this.appendTerminalNotice(session, t(`连接脚本无法执行：${error.message}`));
      return { started: false, error: { message: error.message } };
    }
  }

  /**
   * 等会话输出里出现某个子串（脚本 `expect()` 的实现）。
   *
   * 用**行日志的净化文本**匹配（ANSI 已剥掉），并轮询到超时为止：这比挂一次性
   * 输出回调简单，也不会在会话结束时留下悬挂监听。超时返回 false（脚本据此决定下一步）。
   */
  async waitForSessionOutput(session, pattern, timeoutMs = 15000) {
    const started = Date.now();
    const needle = String(pattern ?? "");
    if (needle === "") return false;
    for (;;) {
      if (session.exited !== null) return false;
      const read = this.readTerminalLines({ sessionId: session.id, tailLines: 500 });
      if (read.ok) {
        // 在保留区里找（tail 取最近 500 行：连接初期的提示符一定在这个窗口内）
        const hit = read.value.lines.some((entry) => entry.text.includes(needle));
        if (hit) return true;
      }
      if (Date.now() - started >= timeoutMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * R8② 空闲字符串发送器（单例）。判定与发送共用 idle-string.js 的同一套前提。
   *
   * 发送**不产生命令台账记录**（计划 5.8 / 风险 #13）：它只写终端并把行日志那一行
   * 打上 keepalive，绝不能被当成「用户执行过的命令」。
   */
  idleSender() {
    if (this.idleStringSender === undefined || this.idleStringSender === null) {
      this.idleStringSender = createIdleStringSender({
        readSettings: () => this.settings ?? {},
        listSessions: () => [...this.sessions.values()].map((session) => ({
          sessionId: session.id,
          hasLiveSession: session.exited === null && session.stream !== null,
          openCommandCount: this.openCommandCountOf(session),
          interactive: this.isInteractiveOf(session),
          idleSinceMs: this.idleSinceMsOf(session)
        })),
        send: async (sessionId, text) => {
          const session = this.sessions.get(sessionId);
          if (session === undefined || session.stream === null) throw new Error("session is gone");
          session.stream.write(text);
          session.lastActivityAt = Date.now();
        },
        // 保活字符串**不发往命令台账**，但要给它在行日志里打标记。
        // 做法：发送时记下"下一行含这段文本就标 keepalive"，由 appendSessionOutput
        // 的回显路径消费 —— 因为在会话回显到达之前，我们并不知道它会落在哪一行。
        markKeepalive: (sessionId, text) => {
          const session = this.sessions.get(sessionId);
          if (session === undefined) return;
          session.pendingKeepaliveText = String(text ?? "");
        },
        onEvent: (event) => {
          if (event.kind === "keepalive-failed") {
            try { console.warn("[dsh-xssh-ops] keepalive send failed:", event.message); } catch { /* ignore */ }
          }
        }
      });
    }
    return this.idleStringSender;
  }

  /** 当前有几个未闭口命令（四条前提之二）。 */
  openCommandCountOf(session) {
    const ledger = session?.commandLedger ?? null;
    return ledger === null ? 0 : ledger.openRecords().length;
  }

  /** 前台是否疑似 TUI（四条前提之三）。 */
  isInteractiveOf(session) {
    const ledger = session?.commandLedger ?? null;
    if (ledger === null) return false;
    return ledger.recent({ limit: 1, includeHidden: true }).some((record) => record.status === "interactive");
  }

  /** 距上次任一方向字节活动多久（四条前提之四）。 */
  idleSinceMsOf(session) {
    if (session === undefined || session === null) return null;
    const stamp = session.lastActivityAt;
    if (!Number.isFinite(stamp)) return null;
    return Math.max(0, Date.now() - stamp);
  }

  /**
   * 前提 detail 的本地化：模块里出的是**英文技术描述**（它是语言无关的判据层），
   * 这里映射成用户可见文案。两条原则：
   *   - 通过/失败都有可读说法（不能只翻译失败那一侧）；
   *   - 带数字的（空闲秒数 / 命令条数）把数字带上，排障时需要。
   */
  localizePreconditionDetail(check, session) {
    const intervalSec = this.settings?.idleStringIntervalSec ?? 0;
    switch (check.name) {
      case "live-session":
        return check.ok ? t("有活的终端会话") : t("没有打开的终端");
      case "no-open-command": {
        if (check.ok) return t("没有未闭口的命令");
        const count = this.openCommandCountOf(session);
        return t(`${count} 条命令仍在运行`);
      }
      case "not-interactive":
        return check.ok ? t("前台不是 TUI") : t("前台疑似 TUI/交互程序");
      case "idle-enough": {
        const idleMs = this.idleSinceMsOf(session);
        if (idleMs === null) return t("无法判定空闲（会话未记录活动时间）");
        return t(`已空闲 ${Math.round(idleMs / 1000)} 秒 / 阈值 ${intervalSec} 秒`);
      }
      default:
        return check.detail;
    }
  }

  /**
   * 按节拍推进空闲字符串发送（由外部定时器或会话心跳调用；模块内不挂定时器）。
   * 返回本次实际发出的记录，便于测试与排障。
   */
  async tickIdleStrings() {
    try {
      return await this.idleSender().tick();
    } catch (error) {
      try { console.warn("[dsh-xssh-ops] idle tick failed:", error?.message ?? error); } catch { /* ignore */ }
      return [];
    }
  }

  /**
   * 「测试保活」：对当前连接跑一轮四条前提判定，回报是否在发、下一次何时发。
   * 这是排障入口（计划 5.8）—— 只读不改，回答「为什么没掉线 / 为什么没在发」。
   */
  keepAliveTest({ connectionId } = {}) {
    const selected = this.resolveConnection(connectionId);
    if (!selected.ok) return selected;
    const settings = this.settings ?? {};
    const session = [...selected.connection.sessions]
      .map((id) => this.sessions.get(id))
      .find((item) => item !== undefined && item.exited === null && item.stream !== null);
    // 判据走共享模块（idle-string.js）：**「测试保活」与真实发送必须是同一套判定**，
    // 两处各写一份迟早会漂移（一边说会发、另一边其实不发是最坏的情况）。
    const verdict = this.idleSender().evaluate({
      sessionId: session?.id ?? null,
      hasLiveSession: session !== undefined,
      openCommandCount: this.openCommandCountOf(session),
      interactive: this.isInteractiveOf(session),
      idleSinceMs: this.idleSinceMsOf(session)
    });
    const checks = verdict.checks.map((check) => ({
      name: check.name,
      ok: check.ok,
      detail: this.localizePreconditionDetail(check, session)
    }));
    const enabled = verdict.enabled;
    const wouldSend = verdict.wouldSend;
    return {
      ok: true,
      value: {
        connectionId: selected.connectionId,
        host: selected.connection.host,
        enabled,
        // 下一次发送的估算时间；没在发时给 null 而不是编一个假时间。
        nextSendAt: verdict.nextSendAt,
        wouldSend,
        checks,
        sshKeepAlive: {
          enabled: settings.sshKeepAliveEnabled !== false,
          intervalSec: settings.sshKeepAliveIntervalSec ?? KEEPALIVE_DEFAULTS.sshKeepAliveIntervalSec,
          countMax: settings.sshKeepAliveCountMax ?? KEEPALIVE_DEFAULTS.sshKeepAliveCountMax
        },
        tcpKeepAlive: {
          enabled: settings.tcpKeepAliveEnabled === true,
          initialDelaySec: settings.tcpKeepAliveInitialDelaySec ?? KEEPALIVE_DEFAULTS.tcpKeepAliveInitialDelaySec
        }
      }
    };
  }

  /**
   * 建连预览（计划 5.8 排障入口）：把「最终会用的连接参数」摊开，便于排查
   * 「为什么没生效」—— 保活间隔改动需要重连，这个视图能直接证明参数变了。
   */
  connectOptionsPreview({ connectionId } = {}) {
    const selected = this.resolveConnection(connectionId);
    if (!selected.ok) return selected;
    const record = selected.connection;
    const settings = this.settings ?? {};
    const keepAliveEnabled = settings.sshKeepAliveEnabled !== false;
    return {
      ok: true,
      value: {
        connectionId: selected.connectionId,
        host: record.host,
        port: record.port,
        username: record.username,
        keepaliveInterval: keepAliveEnabled
          ? (settings.sshKeepAliveIntervalSec ?? KEEPALIVE_DEFAULTS.sshKeepAliveIntervalSec) * 1000
          : 0,
        keepaliveCountMax: settings.sshKeepAliveCountMax ?? KEEPALIVE_DEFAULTS.sshKeepAliveCountMax,
        idleString: keepAliveEnabled || settings.idleStringEnabled === true
          ? {
              enabled: settings.idleStringEnabled === true,
              intervalSec: settings.idleStringIntervalSec ?? 0,
              textLength: String(settings.idleStringText ?? "").length
            }
          : null,
        tcpKeepAlive: {
          enabled: settings.tcpKeepAliveEnabled === true,
          initialDelaySec: settings.tcpKeepAliveInitialDelaySec ?? KEEPALIVE_DEFAULTS.tcpKeepAliveInitialDelaySec
        },
        loginScript: {
          rulesEnabled: settings.loginScriptRulesEnabled === true,
          ruleCount: Array.isArray(settings.loginScriptRules) ? settings.loginScriptRules.length : 0,
          runEnabled: settings.loginScriptRunEnabled === true,
          path: settings.loginScriptPath ?? ""
        },
        // 会话是否活着决定②③能不能真的动（四条前提同样适用于这里的解释）。
        hasLiveSession: [...record.sessions].some((id) => {
          const session = this.sessions.get(id);
          return session !== undefined && session.exited === null && session.stream !== null;
        })
      }
    };
  }

  /** 会话最后一次「任一方向」的字节活动时间（②的空闲判定用）。 */
  lastActivityAt(session) {
    if (session === undefined || session === null) return null;
    const stamp = session.lastActivityAt;
    return Number.isFinite(stamp) ? stamp : (session.openedAt ? Date.parse(session.openedAt) : null);
  }

  /**
   * Persist the interface language and apply it to the host half immediately.
   * `null` clears an explicit choice, so the next settings-page load goes back
   * to adopting DSH's own language.
   */
  async languageSave(request) {
    const requested = request.language === null || request.language === undefined
      ? null
      : (request.language === "zh" || request.language === "en" ? request.language : undefined);
    if (requested === undefined) {
      return { ok: false, error: fail("language-unsupported", `the plugin supports "zh" and "en", not "${request.language}"`) };
    }
    try {
      const previous = this.settingsTable.get(SETTINGS_ROW_ID) ?? {};
      await this.settingsTable.put(SETTINGS_ROW_ID, {
        ...previous,
        language: requested ?? undefined,
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      return { ok: false, error: fail("language-save-failed", error.message) };
    }
    this.language = requested;
    if (requested !== null) setLanguage(requested);
    return { ok: true, value: { language: this.language } };
  }

  /**
   * Connect a saved SSH resource by name/id at the agent's request. The
   * operator's switch gates the whole verb (the risk is waking a machine, not
   * switching between live ones). A live connection for the same profile is
   * reused, the result becomes the active connection so later xssh_exec calls
   * land on it, and a terminal is opened so the operator can always see which
   * machine the agent moved to in the right-side panel.
   */
  async agentConnectProfile(request) {
    if (!this.agentAutoConnect) {
      return { ok: false, error: fail("auto-connect-disabled", t(AUTO_CONNECT_DISABLED_MESSAGE)) };
    }
    let resolved;
    try {
      resolved = resolveProfileRef(
        [...this.requireProfileTable().entries()].map(([profileId, record]) => ({ profileId, name: record.name })),
        request.resource
      );
    } catch (error) {
      return { ok: false, error: fail("profile-list-failed", error.message) };
    }
    if (!resolved.ok) return { ok: false, error: fail(resolved.code, resolved.message) };
    const knownConnectionIds = new Set(this.connections.keys());
    const previousActiveConnectionId = this.activeConnectionId;
    const connected = await this.profileConnect({ profileId: resolved.profileId, reuseExisting: true });
    if (!connected.ok) return connected;
    const connectionId = connected.value.connectionId;
    const reused = knownConnectionIds.has(connectionId);
    const rollback = async (error, openedSessionId = null) => {
      if (!reused) await this.disconnect({ connectionId }).catch(() => {});
      else if (openedSessionId !== null) await this.closeSession({ sessionId: openedSessionId }).catch(() => {});
      this.activeConnectionId = previousActiveConnectionId;
      return { ok: false, error };
    };
    let terminalOpened = false;
    const connection = this.connections.get(connectionId);
    if (connection === undefined) return rollback(fail("no-connection", `connection "${connectionId}" disappeared before its terminal opened`));
    // Visibility is the safeguard: the agent's target machine must appear in
    // the right-side panel, not just exist as an invisible transport.
    let openedSessionId = null;
    if (connection.sessions.size === 0) {
      const opened = await this.openSession({ connectionId, openedBy: "agent" });
      if (!opened.ok) return rollback(opened.error);
      openedSessionId = opened.value.sessionId;
      terminalOpened = true;
    }
    const selected = await this.selectConnection({ connectionId });
    if (!selected.ok) return rollback(selected.error, openedSessionId);
    // A new token on every request lets the browser re-open a reused server
    // after its pane was closed, even when its existing PTY was human-opened.
    connection.agentRevealId = randomUUID();
    return {
      ok: true,
      value: {
        connectionId,
        profileId: resolved.profileId,
        name: resolved.name,
        host: connected.value.host,
        port: connected.value.port,
        username: connected.value.username,
        reused,
        terminalOpened,
        ...(connected.value.warning !== undefined ? { warning: connected.value.warning } : {})
      }
    };
  }

  /** Connect a saved profile, run one command, then disconnect. Batch channel only. */
  async runCommandOnProfile(profileId, command, timeoutMs = 30000) {
    const record = this.requireProfileTable().get(profileId);
    if (record === undefined) return { ok: false, error: fail("no-profile", `SSH resource "${profileId}" does not exist`) };
    const connect = await this.profileConnect({ profileId });
    if (!connect.ok) return connect;
    const connectionId = connect.value.connectionId;
    try {
      const raw = await this.execRawOnClient(this.connections.get(connectionId).client, command, timeoutMs);
      if (!raw.ok) return raw;
      return { ok: true, value: { ...raw.value, profileId, name: record.name, host: record.host } };
    } catch (error) {
      return { ok: false, error: fail("exec-failed", error.message) };
    } finally {
      await this.disconnect({ connectionId }).catch(() => {});
    }
  }


  async groupList() {
    try {
      const groups = [...this.requireGroupTable().entries()]
        .map(([groupId, record]) => this.groupPublic(groupId, record))
        .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
      return { ok: true, value: { groups } };
    } catch (error) {
      return { ok: false, error: fail("group-list-failed", error.message) };
    }
  }

  async groupSave(request) {
    try {
      const table = this.requireGroupTable();
      const groupId = request.groupId ?? randomUUID();
      const previous = table.get(groupId);
      if (request.groupId !== undefined && previous === undefined) {
        return { ok: false, error: fail("no-group", `SSH group "${groupId}" does not exist`) };
      }
      const name = request.name.trim();
      if ([...table.entries()].some(([id, group]) => id !== groupId && group.name.localeCompare(name, "zh-Hans-CN", { sensitivity: "accent" }) === 0)) {
        return { ok: false, error: fail("duplicate-group", `SSH group "${name}" already exists`) };
      }
      const now = new Date().toISOString();
      const record = { name, createdAt: previous?.createdAt ?? now, updatedAt: now };
      await table.put(groupId, record);
      return { ok: true, value: { group: this.groupPublic(groupId, record) } };
    } catch (error) {
      return { ok: false, error: fail("group-save-failed", error.message) };
    }
  }

  async groupDelete(request) {
    try {
      const groups = this.requireGroupTable();
      if (groups.get(request.groupId) === undefined) return { ok: true, value: { deleted: false, movedProfiles: 0 } };
      const profiles = this.requireProfileTable();
      let movedProfiles = 0;
      for (const [profileId, profile] of profiles.entries()) {
        if (profile.groupId !== request.groupId) continue;
        movedProfiles += 1;
        await profiles.put(profileId, { ...profile, groupId: null, updatedAt: new Date().toISOString() });
      }
      await groups.delete(request.groupId);
      return { ok: true, value: { deleted: true, movedProfiles } };
    } catch (error) {
      return { ok: false, error: fail("group-delete-failed", error.message) };
    }
  }

  // ── known-hosts management (operator only; NOT exposed as agent tools) ────

  async listKnownHosts() {
    try {
      const hosts = this.knownHosts ? this.knownHosts.list() : [];
      return { ok: true, value: { hosts } };
    } catch (error) {
      return { ok: false, error: fail("known-hosts-list-failed", error.message) };
    }
  }

  async forgetHostKey(request) {
    try {
      if (this.knownHosts === null) {
        return { ok: false, error: fail("known-hosts-not-ready", "known-host storage is not ready") };
      }
      const forgotten = await this.knownHosts.forget(request.host, request.port);
      return { ok: true, value: { forgotten } };
    } catch (error) {
      return { ok: false, error: fail("forget-host-key-failed", error.message) };
    }
  }

  async openSession(request) {
    const conn = this.connections.get(request.connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", noConnectionGuidance(request.connectionId, this.savedResourceNameList(), this.agentAutoConnect)) };
    if (this.sessions.size >= MAX_SESSIONS) return { ok: false, error: fail("session-limit", `too many live sessions (${MAX_SESSIONS})`) };
    if (!(await this.ensureAlive(conn))) {
      return { ok: false, error: fail("connection-lost", `connection "${request.connectionId}" is down and could not be re-established`) };
    }
    const sessionId = randomUUID();
    const cols = request.cols ?? 80;
    const rows = request.rows ?? 24;
    // A saved login command replaces the resource's login shell for this
    // terminal (exec + pty, `ssh -t host bash -l` semantics): the command IS
    // the session. Resolved live from the profile table so an edit applies to
    // the next terminal without a reconnect; a lookup hiccup must not block
    // opening a plain shell, so it degrades to null. Connections without a
    // saved resource (temporary panel connects, agent connects) keep the
    // server's own login shell.
    let loginCommand = null;
    if (conn.profileId) {
      try {
        loginCommand = this.requireProfileTable().get(conn.profileId)?.loginCommand ?? null;
      } catch {}
    }
    const session = {
      id: sessionId,
      connectionId: request.connectionId,
      openedAt: new Date().toISOString(),
      openedBy: request.openedBy ?? "panel",
      cols,
      rows,
      buffer: "",
      // Browser reads drain `buffer`. Retain a separate bounded capture for
      // an explicit xssh_read without coupling it to UI polling.
      captureBuffer: "",
      lastPrompt: null,
      waiters: [],
      streamListeners: new Set(),
      // OSC 133 markers, when the shell emits them (enableShellIntegration).
      shellIntegration: new ShellIntegrationTracker(),
      exited: null,
      stream: null,
      // The PTY receives keystrokes one at a time. Track the current command
      // locally, then allow or cancel it only when Enter is pressed.
      inputLine: "",
      inputKnown: true,
      // 行号行日志：与字节缓冲并存的叠加层，只服务「按行号读取」与命令区间
      // （计划 5.4）。挂载点唯一 —— appendSessionOutput。
      lineJournal: createLineJournal({
        maxLines: this.config.lineJournalMaxLines,
        maxBytes: this.config.lineJournalMaxBytes
      }),
      // R9① 登录脚本规则引擎（默认关闭 ⇒ 这里为 null）。连接就绪后由
      // startLoginScriptIfEnabled 建实例；会话复用时不重复执行。
      loginScript: null
    };
    this.sessions.set(sessionId, session);
    this.exitedSessions.delete(sessionId);
    conn.sessions.add(sessionId);
    try {
      const openShellChannel = () => new Promise((resolve, reject) => {
        const opened = (error, s) => {
          if (error) reject(error);
          else resolve(s);
        };
        // ssh2 carries agent forwarding and window resize on the exec+pty
        // channel exactly as on a shell channel (global connectConfig flag;
        // session.stream.setWindow), so the two paths converge below.
        if (loginCommand) conn.client.exec(loginCommand, { pty: { term: "xterm-256color", cols, rows } }, opened);
        else conn.client.shell({ term: "xterm-256color", cols, rows }, opened);
      });
      let stream;
      try {
        stream = await openShellChannel();
      } catch (error) {
        // 设备时序问题（用户 2026-10-18 实测）：部分 SSH 服务端（iStoreOS/
        // dropbear 一类）在认证刚完成、`ready` 事件后**立即**收到的 shell 请求
        // 会回 CHANNEL_FAILURE，报 "Unable to open shell"；同一连接上几秒后
        // 手动再开就成功。ssh2 在失败时已关闭该 channel，这里短延迟重试一次。
        if (!/Unable to open shell/i.test(String(error?.message ?? ""))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 600));
        stream = await openShellChannel();
      }
      session.stream = stream;
      stream.on("data", (chunk) => {
        this.appendSessionOutput(session, chunk.toString("utf8"));
      });
      stream.on("close", () => {
        this.recordExit(session, { code: 0 });
      });
      stream.on("error", () => {
        this.recordExit(session, { code: 1 });
      });
      // The panel opens this session immediately after a successful manual
      // connection. Remember it so agent tools can act on the same server
      // without making the model discover an opaque connection id first.
      this.activeConnectionId = request.connectionId;
      {
        const conn = this.connections.get(request.connectionId);
        // Recording starts with the session's FIRST output, not with the
        // session: a shell that produces nothing (an accidental tab, a probe)
        // must not leave an empty log behind.
        session.logMeta = {
          sessionId, connectionId: request.connectionId,
          name: conn?.name ?? null, host: conn?.connectConfig?.host ?? conn?.username ?? null,
          port: conn?.connectConfig?.port ?? null, openedBy: session.openedBy,
          startedAt: session.openedAt
        };
      }
      // R9① 登录脚本：shell 通道建好（连接就绪）后启动规则引擎。默认关闭时
      // startLoginScriptIfEnabled 会立刻返回，不产生任何副作用。
      this.startLoginScriptIfEnabled(session);
      // R9② 连接时运行脚本（方案 A：受限 DSL）。规则表与脚本是**两件事**，
      // 所以各自独立启动：先跑规则（等提示→送字），再跑脚本（做更复杂的会话编排）。
      this.startSessionScriptIfEnabled(session);
    } catch (error) {
      this.sessions.delete(sessionId);
      conn.sessions.delete(sessionId);
      return { ok: false, error: fail("shell-failed", `could not open shell on connection "${request.connectionId}"${loginCommand ? ` (login command: ${loginCommand})` : ""}: ${error.message}`) };
    }
    return {
      ok: true,
      value: {
        sessionId,
        connectionId: request.connectionId,
        cols,
        rows,
        alive: true
      }
    };
  }

  async write(request) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    if (session.exited !== null || session.stream === null) return { ok: false, error: fail("exited", `session "${request.sessionId}" has already exited`) };
    let text;
    try {
      text = decodeData(request.data);
    } catch {
      return { ok: false, error: fail("bad-data", "input is not valid base64") };
    }
    try {
      if (text) {
        const pending = this.pendingForSession(session.id);
        if (pending) {
          // A card's Execute button is the only confirmation path for an
          // agent-originated dangerous command.  Keyboard Enter cannot submit
          // it, while Ctrl-C and any edit revoke the pending approval first.
          if (text === "\r" || text === "\n") {
            this.appendTerminalNotice(session, t("此危险命令不会因回车执行：请使用面板弹出的确认卡片，点击“执行”或“撤销”。"));
            return { ok: true, value: { written: 0 } };
          }
          if (text === "\x03") {
            this.removePendingConfirmation(pending.confirmationId);
            session.stream.write(text);
            session.inputLine = "";
            session.inputKnown = true;
            return { ok: true, value: { written: text.length } };
          }
          this.removePendingConfirmation(pending.confirmationId);
          // Clear the protected prefill before allowing the operator's new
          // input through.  From this point the terminal is fully manual.
          session.stream.write(`\x15${text}`);
          session.inputLine = "";
          session.inputKnown = true;
          this.updateInputMirror(session, text);
          return { ok: true, value: { written: text.length } };
        }
        // This path is interactive operator input. It remains intentionally
        // unguarded; agent calls use writeToConnection()/execOnConnection().
        session.stream.write(text);
        this.updateInputMirror(session, text);
      }
    } catch (error) {
      return { ok: false, error: fail("write-failed", error.message) };
    }
    return { ok: true, value: { written: text.length } };
  }

  /** Explicit UI action: refuse drafts, foreground jobs, and ambiguous PTYs. */
  async changeDirectory(request) {
    if (typeof request.path !== "string" || !request.path.startsWith("/") || /[\x00-\x1f\x7f]/.test(request.path)) {
      return { ok: false, error: fail("bad-path", t("目录必须是绝对路径，且不能包含控制字符")) };
    }
    const session = this.sessions.get(request.sessionId);
    const conn = session && this.connections.get(session.connectionId);
    const ready = () => session && conn && this.sessions.get(request.sessionId) === session
      && !conn.dead && !conn.closing && session.exited === null && session.stream
      && session.inputKnown === true && session.inputLine === ""
      && !this.pendingForSession(session.id) && conn.sessions.size === 1;
    if (!ready()) return { ok: false, error: fail("terminal-not-ready", t("请先结束前台程序、清空未提交输入，并仅保留一个交互终端")) };
    const revision = session.inputRevision ?? 0;
    const client = conn.client;
    try {
      if (!posixLoginShell(await this.resolveLoginShell(conn))) {
        return { ok: false, error: fail("unsupported-shell", t("无法确认此 shell 的空闲状态，请在终端手动切换目录")) };
      }
      const probe = await this.collectExecOutput(client, buildCwdAwareCommand(":"), 5000);
      if (probe.exitCode !== 0 || extractExecCwd(probe.stdout).cwd === null) {
        return { ok: false, error: fail("terminal-busy", t("未确认空闲交互 shell，请结束前台程序后重试或手动 cd")) };
      }
      if (!ready() || client !== conn.client || revision !== (session.inputRevision ?? 0)) {
        return { ok: false, error: fail("terminal-changed", t("终端输入已变化，请检查后重试")) };
      }
      const quoted = "'" + request.path.replace(/'/g, "'\\''") + "'";
      return this.write({ sessionId: session.id, data: encodeData(`cd -- ${quoted}\r`) });
    } catch (error) {
      return { ok: false, error: fail("cd-failed", error.message) };
    }
  }

  /**
   * Install the OSC 133 markers in the session's shell (bash/zsh): the prompt
   * and each command's end are announced with an exit code and a cwd report,
   * which is what readTerminalContext surfaces as `shell`. Gated exactly like
   * changeDirectory — the shell must be an idle, known, single interactive
   * prompt, because the snippet edits PROMPT_COMMAND/PS1 for the login
   * session and nothing here can undo a partial write.
   */
  async enableShellIntegration(request) {
    const session = this.sessions.get(request.sessionId);
    const conn = session && this.connections.get(session.connectionId);
    const ready = () => session && conn && this.sessions.get(request.sessionId) === session
      && !conn.dead && !conn.closing && session.exited === null && session.stream
      && session.inputKnown === true && session.inputLine === ""
      && !this.pendingForSession(session.id) && conn.sessions.size === 1;
    if (!ready()) return { ok: false, error: fail("terminal-not-ready", t("请先结束前台程序、清空未提交输入，并仅保留一个交互终端")) };
    try {
      if (!posixLoginShell(await this.resolveLoginShell(conn))) {
        return { ok: false, error: fail("unsupported-shell", t("无法确认此 shell 的空闲状态，请在终端手动启用")) };
      }
      const client = conn.client;
      const probe = await this.collectExecOutput(client, buildCwdAwareCommand(":"), 5000);
      if (probe.exitCode !== 0) {
        return { ok: false, error: fail("terminal-busy", t("未确认空闲交互 shell，请结束前台程序后重试")) };
      }
      if (!ready() || client !== conn.client) {
        return { ok: false, error: fail("terminal-changed", t("终端状态已变化，请重试")) };
      }
      // Which flavour of snippet fits is the shell's own answer: a single line
      // is parsed whole, so handing zsh syntax to sh (or the reverse) would
      // abort it silently on a pipe.
      const family = await this.collectExecOutput(client, buildCwdAwareCommand(SHELL_FAMILY_PROBE), 5000)
        .then((result) => (result.exitCode === 0 ? parseShellFamilyProbe(result.stdout) : ""))
        .catch(() => "");
      const written = await this.write({ sessionId: session.id, data: encodeData(`${shellIntegrationCommand(family)}\r`) });
      if (!written.ok) return written;
      return { ok: true, value: { sessionId: session.id, enabled: true } };
    } catch (error) {
      return { ok: false, error: fail("shell-integration-failed", error.message) };
    }
  }

  async read(request) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) {
      const exit = this.exitedSessions.get(request.sessionId);
      if (exit !== void 0) return { ok: true, value: { data: "", exit } };
      return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    }
    // Cursor readers share the append-only journal. This keeps stream-to-poll
    // fallback exact and lets multiple panes observe the same bytes without
    // competing for a destructive buffer.
    if (request.after !== undefined) {
      const journal = this.terminalOutput(session);
      const available = journal.read(request.after);
      if (available.data !== "" || session.exited !== null) {
        return { ok: true, value: { ...available, data: encodeData(available.data), exit: session.exited } };
      }
      const timeoutMs = request.timeoutMs ?? this.config.defaultReadTimeoutMs;
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const index = session.waiters.indexOf(waiter);
          if (index >= 0) session.waiters.splice(index, 1);
          const item = journal.read(request.after);
          resolve({ ok: true, value: { ...item, data: encodeData(item.data), exit: session.exited } });
        };
        const timer = setTimeout(finish, timeoutMs);
        const waiter = { resolve: finish, timer, cursor: true };
        session.waiters.push(waiter);
      });
    }
    if (session.exited !== null) {
      return { ok: true, value: { data: this.drain(session), exit: session.exited } };
    }
    const pending = this.drain(session);
    if (pending !== "") {
      return { ok: true, value: { data: pending, exit: null } };
    }
    const timeoutMs = request.timeoutMs ?? this.config.defaultReadTimeoutMs;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = session.waiters.indexOf(waiter);
        if (index >= 0) session.waiters.splice(index, 1);
        resolve(value);
      };
      const timer = setTimeout(() => {
        finish({ ok: true, value: { data: this.drain(session), exit: null } });
      }, timeoutMs);
      const waiter = { resolve: finish, timer };
      session.waiters.push(waiter);
    });
  }

  /**
   * 按行号读取终端输出（计划 5.3 / M1）。
   *
   * 与 `read` 的区别：`read` 是**字节**游标，服务客户端流式订阅；这里是**行号**
   * 语义，服务智能体与「行号视图」—— 命令台账用行区间标注一条命令的产出范围，
   * 所以行号一旦发出就永不复用（淘汰只推进 firstLine，见 line-journal.js）。
   *
   * 渲染成 `0001 │ 内容`（四位数左补零）。调用方必须看 `truncated`/`evicted`：
   * 为真表示请求区间里更早的行已经被淘汰，**不能**当成完整历史。
   */
  readTerminalLines(request = {}) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) {
      return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    }
    const journal = session.lineJournal;
    if (journal === void 0) {
      return { ok: false, error: fail("no-line-journal", `session "${request.sessionId}" has no line journal`) };
    }
    const window = journal.read({
      fromLine: request.fromLine,
      toLine: request.toLine,
      tailLines: request.tailLines,
      maxBytes: request.maxBytes
    });
    const snapshot = journal.snapshot();
    return {
      ok: true,
      value: {
        sessionId: session.id,
        text: formatNumberedLines(window.lines),
        lines: window.lines,
        count: window.count,
        bytes: window.bytes,
        fromLine: window.fromLine,
        toLine: window.toLine,
        nextLine: window.nextLine,
        hasMore: window.hasMore,
        // 双上限下的丢失标记：evicted 专指「请求起点早于保留区」。
        truncated: window.truncated,
        evicted: window.evicted,
        firstLine: snapshot.firstLine,
        lastLine: snapshot.lastLine,
        totalLines: snapshot.totalLines,
        pendingText: journal.pendingText(),
        exit: session.exited
      }
    };
  }

  /**
   * 远端补全查询（用户 2026-10-18）。
   *
   * 走独立 exec 通道：**不镜像到终端、不记命令台账**，也不走危险命令判定
   * （命令由 buildCompletionCommand 拼装，只含只读工具）。候选按行返回。
   */
  async completeCommand(request = {}) {
    const conn = this.connections.get(request.connectionId);
    if (conn === void 0) {
      return { ok: false, error: fail("no-connection", `connection "${request.connectionId}" does not exist`) };
    }
    if (!(await this.ensureAlive(conn))) {
      return { ok: false, error: fail("connection-lost", `connection "${request.connectionId}" is down and could not be re-established`) };
    }
    const kind = request.kind === "command" ? "command" : "path";
    const prefix = String(request.prefix ?? "").slice(0, 1024);
    const command = buildCompletionCommand(kind, prefix);
    try {
      // 补全必须跟随**面板终端当前目录**（用户 2026-10-19 实测：进入二级目录后
      // 相对路径补全失效——exec 通道默认从登录目录起，补出来的是家目录内容）。
      // 复用 exec 的 cwd prologue：唯一的交互式 POSIX shell 时先 cd 到它所在目录。
      const shell = await this.resolveLoginShell(conn);
      const sent = posixLoginShell(shell) ? buildCwdAwareCommand(command) : command;
      const state = await this.collectExecOutput(conn.client, sent, 4000);
      // 剥掉 cwd marker 行，剩下的才是 `ls` 的输出。
      const stdout = extractExecCwd(state.stdout).stdout;
      // `ls -F` 会给名字加分类符：`/` 目录、`@` 符号链接、`*` 可执行、`|` FIFO、
      // `=` socket。只有目录的 `/` 是候选语义（客户端据此判断是否继续补全），
      // 其余分类符必须剥掉 —— 否则补进命令框会变成 `cd sda5@` 这种不可执行的
      // 名字（用户 2026-10-18 实测：cd sda5@ 报 No such file or directory）。
      const candidates = String(stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => line.replace(/[@|=$]$/, ""))
        .slice(0, 500);
      return { ok: true, value: { candidates } };
    } catch (error) {
      return { ok: false, error: fail("completion-failed", error.message) };
    }
  }

  listTerminalContexts() {
    const sessions = [];
    for (const session of this.sessions.values()) {
      const connection = this.connections.get(session.connectionId);
      if (!connection) continue;
      const history = this.terminalContextHistory(session);
      const item = { sessionId: session.id, connectionId: session.connectionId, host: connection.host, port: connection.port, openedAt: session.openedAt, openedBy: session.openedBy ?? "panel", alive: session.exited === null && session.stream !== null, historyStart: history.start, historyEnd: history.end };
      if (connection.name !== undefined) item.name = connection.name;
      sessions.push(item);
    }
    return { ok: true, value: { sessions } };
  }

  readTerminalContext(request) {
    const session = this.sessions.get(request.sessionId);
    if (!session) return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    const maxBytes = request.maxBytes ?? 24 * 1024;
    const history = this.terminalContextHistory(session);
    const relativeAfter = request.after === undefined ? undefined : request.after - history.start;
    const window = history.journal.readWindow(relativeAfter, maxBytes);
    return { ok: true, value: { sessionId: session.id, ...window, historyStart: history.start, historyEnd: history.end, offset: history.start + window.offset, nextOffset: history.start + window.nextOffset, alive: session.exited === null && session.stream !== null, exit: session.exited, redacted: history.redacted, shell: session.shellIntegration?.snapshot() ?? null } };
  }

  terminalContextHistory(session) {
    const raw = this.terminalOutput(session).read();
    const safe = redactForModel(raw.data);
    const journal = createTerminalOutput(safe.text, Number.MAX_SAFE_INTEGER);
    return { journal, start: raw.startOffset, end: raw.startOffset + safe.text.length, redacted: safe.redacted };
  }

  /**
   * Stream-push terminal output (typert mode:'stream', WebSocket mux carrier).
   * Each yielded item reuses the read() envelope so the client render path is
   * identical to polling; items are validated by the gateway against the
   * descriptor's strict result codec. Ends when the session exits or the
   * caller's AbortSignal fires — the client falls back to 300ms polling if the
   * stream can't be opened or breaks.
   */
  async *terminalStream(request, signal) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) {
      yield { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
      return;
    }
    const journal = this.terminalOutput(session);
    const listener = { wake: null, timer: null };
    session.streamListeners ??= new Set();
    session.streamListeners.add(listener);
    let cursor = request.after;
    const abort = () => listener.wake?.();
    signal?.addEventListener("abort", abort);
    try {
      let heartbeatFired = false;
      while (!signal?.aborted) {
        const item = journal.read(cursor);
        const exit = session.exited;
        if (item.data !== "" || exit !== null || heartbeatFired) {
          cursor = item.offset;
          yield { ok: true, value: { ...item, data: encodeData(item.data), exit } };
        }
        if (exit !== null || signal?.aborted) return;
        // Output can arrive while suspended at yield. Do not sleep over it.
        if (journal.read(cursor).data !== "") continue;
        heartbeatFired = false;
        await new Promise((resolve) => {
          listener.wake = resolve;
          listener.timer = setTimeout(() => {
            heartbeatFired = true;
            resolve();
          }, this.config.streamHeartbeatMs);
        });
        listener.wake = null;
        clearTimeout(listener.timer);
        listener.timer = null;
      }
    } finally {
      clearTimeout(listener.timer);
      session.streamListeners.delete(listener);
      signal?.removeEventListener("abort", abort);
      // History belongs to the session, not its readers. No per-reader
      // copyback: simultaneous cancellations cannot duplicate output.
    }
  }

  terminalOutput(session) {
    session.outputJournal ??= createTerminalOutput(session.buffer ?? "", this.config.maxBufferBytes);
    return session.outputJournal;
  }

  pendingConfirmationList() {
    return {
      ok: true,
      value: {
        confirmations: [...this.pendingConfirmations.values()]
          .map((item) => this.publicPendingConfirmation(item))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      }
    };
  }

  batchPlan(request) {
    const decision = assessShellCommand(request.command);
    // Clamp here, not just in the RPC schema: the ssh_batch tool calls this
    // method directly and bypasses zod, so an agent-supplied timeout_ms must
    // still land inside the 1s–120s window.
    const timeoutMs = Math.min(120000, Math.max(1000, request.timeoutMs ?? 30000));
    const task = {
      batchId: randomUUID(),
      command: request.command.trim(),
      timeoutMs,
      dangerous: !decision.ok,
      reason: decision.ok ? null : (decision.category ?? decision.reason),
      createdAt: new Date().toISOString()
    };
    this.batchTasks.set(task.batchId, task);
    return { ok: true, value: { task } };
  }

  batchTaskList() {
    return { ok: true, value: { tasks: [...this.batchTasks.values()] } };
  }

  async batchRun(request) {
    const task = this.batchTasks.get(request.batchId);
    if (!task) return { ok: false, error: fail("batch-missing", t(`批量任务 "${request.batchId}" 不存在或已执行`)) };
    if (request.profileIds.length === 0) return { ok: false, error: fail("batch-no-targets", t("未选择任何服务器")) };
    this.batchTasks.delete(request.batchId);
    // Fixed worker pool over the target list; results keep the requested order
    // via index-addressed slots.
    const targets = request.profileIds;
    const results = new Array(targets.length);
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const index = next++;
        const profileId = targets[index];
        try {
          const r = await this.runCommandOnProfile(profileId, task.command, task.timeoutMs);
          if (!r.ok) results[index] = { profileId, name: "", host: "", ok: false, exitCode: null, stdout: "", stderr: "", error: r.error.message };
          else results[index] = { profileId, name: r.value.name, host: r.value.host, ok: true, exitCode: r.value.exitCode, stdout: r.value.stdout, stderr: r.value.stderr, error: null };
        } catch (error) {
          results[index] = { profileId, name: "", host: "", ok: false, exitCode: null, stdout: "", stderr: "", error: error.message };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_MAX_CONCURRENCY, targets.length) }, () => worker()));
    return { ok: true, value: { results } };
  }

  batchCancel(request) {
    const cancelled = this.batchTasks.delete(request.batchId);
    return { ok: true, value: { cancelled } };
  }

  async pendingConfirmationApprove(request) {
    const pending = this.pendingConfirmations.get(request.confirmationId);
    if (!pending) return { ok: false, error: fail("confirmation-missing", t("待确认命令不存在或已处理")) };
    const session = this.sessions.get(pending.sessionId);
    if (!session || session.exited !== null || session.stream === null) {
      this.removePendingConfirmation(pending.confirmationId);
      return { ok: false, error: fail("confirmation-session-closed", t("终端已关闭，无法执行待确认命令")) };
    }
    if (pending.trashScript) {
      // The approved command runs as the reversible trash move on the exec
      // channel when that is possible. When it is not (connection gone, or a
      // non-POSIX login shell that cannot anchor relative paths), execution
      // falls through to the historical PTY path below — exactly what the
      // operator approved before this safety net existed. The card, the
      // notices and the terminal output are identical either way; the only
      // difference is whether a rollback copy exists.
      const conn = this.connections.get(pending.connectionId);
      if (conn) {
        const shell = await this.resolveLoginShell(conn);
        if (posixLoginShell(shell)) {
          this.removePendingConfirmation(pending.confirmationId);
          const result = await this.runPreparedExec(pending.connectionId, pending.trashScript, pending.command, true, 30000, false);
          if (!result.ok) {
            this.appendTerminalNotice(session, t(`回收站移动未能执行：${result.error.message}。命令未执行。`));
            return { ok: true, value: { executed: false } };
          }
          return { ok: true, value: { executed: true } };
        }
      }
    }
    if (pending.prefilled && (!session.inputKnown || session.inputLine !== pending.command)) {
      this.removePendingConfirmation(pending.confirmationId);
      return { ok: false, error: fail("confirmation-modified", t("终端命令已变化，待确认项已作废")) };
    }
    try {
      this.removePendingConfirmation(pending.confirmationId);
      // Clear any text the operator may have typed, then send the command +
      // Enter.  Without the line-kill the command would concatenate onto
      // unsaved input and produce a garbled, unsafe shell line.
      session.stream.write(`\x15${pending.command}\r`);
      session.inputLine = "";
      session.inputKnown = true;
      return { ok: true, value: { executed: true } };
    } catch (error) {
      return { ok: false, error: fail("confirmation-execute-failed", error.message) };
    }
  }

  pendingConfirmationCancel(request) {
    const pending = this.pendingConfirmations.get(request.confirmationId);
    if (!pending) return { ok: false, error: fail("confirmation-missing", t("待确认命令不存在或已处理")) };
    const session = this.sessions.get(pending.sessionId);
    this.removePendingConfirmation(pending.confirmationId);
    if (pending.prefilled && session && session.exited === null && session.stream !== null) {
      try { session.stream.write("\x15"); } catch {}
      session.inputLine = "";
      session.inputKnown = true;
    }
    return { ok: true, value: { cancelled: true } };
  }

  /** The one protected line currently visible in a terminal, if any. */
  pendingForSession(sessionId) {
    for (const pending of this.pendingConfirmations.values()) {
      if (pending.sessionId === sessionId && pending.prefilled) return pending;
    }
    return null;
  }

  removePendingConfirmation(confirmationId) {
    this.pendingConfirmations.delete(confirmationId);
  }

  removePendingForSession(sessionId) {
    for (const [confirmationId, pending] of this.pendingConfirmations) {
      if (pending.sessionId === sessionId) this.pendingConfirmations.delete(confirmationId);
    }
  }

  publicPendingConfirmation(pending) {
    return {
      confirmationId: pending.confirmationId,
      connectionId: pending.connectionId,
      sessionId: pending.sessionId,
      ...(pending.name ? { name: pending.name } : {}),
      host: pending.host,
      command: pending.command,
      reason: pending.reason,
      createdAt: pending.createdAt,
      prefilled: pending.prefilled
    };
  }

  async resize(request) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    if (session.stream === null || session.exited !== null) return { ok: false, error: fail("exited", `session "${request.sessionId}" is not alive`) };
    try {
      session.stream.setWindow(request.rows, request.cols);
    } catch (error) {
      return { ok: false, error: fail("resize-failed", error.message) };
    }
    session.cols = request.cols;
    session.rows = request.rows;
    return { ok: true, value: { cols: request.cols, rows: request.rows } };
  }

  async closeSession(request) {
    try { void this.sessionLogStore()?.end(request.sessionId, { exitCode: null }); } catch { /* best-effort */ }
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    this.sessions.delete(request.sessionId);
    this.removePendingForSession(request.sessionId);
    const conn = this.connections.get(session.connectionId);
    if (conn) conn.sessions.delete(request.sessionId);
    if (session.exited === null && session.stream !== null) {
      try { session.stream.end(); } catch {}
      session.exited = { code: 0 };
    }
    this.rememberExit(request.sessionId, session.exited ?? { code: 0 });
    return { ok: true, value: { closed: true } };
  }

  async disconnect(request) {
    const conn = this.connections.get(request.connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", noConnectionGuidance(request.connectionId, this.savedResourceNameList(), this.agentAutoConnect)) };
    // Explicit disconnect: never auto-reconnect, and stop any in-flight one.
    conn.closing = true;
    if (conn.reconnectTimer !== null) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    for (const sessionId of [...conn.sessions]) {
      const session = this.sessions.get(sessionId);
      if (session) {
        this.sessions.delete(sessionId);
        this.removePendingForSession(sessionId);
        if (session.exited === null && session.stream !== null) {
          try { session.stream.end(); } catch {}
          session.exited = { code: 0 };
        }
        this.rememberExit(sessionId, session.exited ?? { code: 0 });
      }
    }
    conn.sessions.clear();
    this.connections.delete(request.connectionId);
    if (this.activeConnectionId === request.connectionId) {
      this.activeConnectionId = null;
    }
    try { conn.client.end(); } catch {}
    for (const hop of conn.hops ?? []) { try { hop.end(); } catch {} }
    conn.hops = [];
    return { ok: true, value: { disconnected: true } };
  }

  // ── Agent-facing helpers (called directly by tools, not over the wire) ────

  /**
   * Run one command over a dedicated exec channel on a connection. The
   * command line and its output are ALSO appended to the connection's shell
   * session buffers (if any), so the panel shows what the agent did.
   */

  /**
   * Run one command over a dedicated exec channel. No policy gate and no
   * terminal mirror: used by the batch channel, where the operator already
   * confirmed the command against a chosen server list. Returns raw output.
   */
  /**
   * Open one non-interactive exec channel and collect stdout/stderr until the
   * channel closes or the timeout fires (then the channel is closed and the
   * timeout flag set). Shared by the batch channel (raw) and the agent
   * xssh_exec path (mirrored into the panel terminal).
   */
  async collectExecOutput(client, command, timeoutMs) {
    const stream = await new Promise((resolve, reject) => {
      client.exec(command, { pty: false }, (error, s) => {
        if (error) reject(error);
        else resolve(s);
      });
    });
    const state = { exitCode: null, stdout: "", stderr: "", truncated: false, timedOut: false };
    const timer = setTimeout(() => {
      state.timedOut = true;
      try { stream.close(); } catch {}
    }, timeoutMs);
    await new Promise((resolve) => {
      stream.on("data", (chunk) => {
        const result = appendCapped(state.stdout, chunk.toString("utf8"), this.config.maxCommandOutputBytes);
        state.stdout = result.text;
        state.truncated ||= result.truncated;
      });
      stream.stderr.on("data", (chunk) => {
        const result = appendCapped(state.stderr, chunk.toString("utf8"), this.config.maxCommandOutputBytes);
        state.stderr = result.text;
        state.truncated ||= result.truncated;
      });
      stream.on("close", (code) => {
        clearTimeout(timer);
        state.exitCode = typeof code === "number" ? code : null;
        resolve();
      });
      stream.on("error", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return state;
  }

  async execRawOnClient(client, command, timeoutMs = 30000) {
    try {
      return { ok: true, value: await this.collectExecOutput(client, command, timeoutMs) };
    } catch (error) {
      return { ok: false, error: fail("exec-failed", error.message) };
    }
  }

  /**
   * One-time probe of the connection's login shell — the binary sshd runs for
   * exec channels — cached on the connection record. `echo $SHELL` is a bare
   * variable expansion valid in every shell family, so the probe itself never
   * breaks fish/csh; unknown or exotic families keep the plain-exec behavior.
   * A transient probe failure clears itself so a later exec can retry.
   */
  resolveLoginShell(conn) {
    if (conn.loginShell !== undefined) return Promise.resolve(conn.loginShell);
    if (conn.loginShellProbe === undefined) {
      conn.loginShellProbe = this.collectExecOutput(conn.client, "echo $SHELL", 10000)
        .then((state) => {
          const name = state.stdout.trim().split("/").pop() ?? "";
          conn.loginShell = name.length > 0 ? name.toLowerCase() : null;
        })
        .catch(() => {
          // Leave loginShell undefined: the next exec re-probes once the
          // transport is healthy again. This call keeps the plain behavior.
          conn.loginShellProbe = undefined;
        });
    }
    return conn.loginShellProbe.then(() => conn.loginShell);
  }

  async execOnConnection(connectionId, command, timeoutMs = 30000, retried = false, options = {}) {
    const decision = assessShellCommand(command);
    if (!decision.ok) {
      // A simple, fully-literal rm/unlink/rmdir still goes through the
      // operator's confirmation card — but approving it performs the
      // reversible trash move, not a real deletion. The card carries the
      // prepared script; real `rm` only ever happens when the operator types
      // it in their own terminal.
      let trashScript = null;
      if (decision.category === CATEGORY_DELETE_FILES) {
        const parsed = parseSimpleDeleteCommand(command);
        if (parsed) trashScript = buildTrashCommand(parsed.targets);
      }
      // The card, the reason and every notice stay byte-for-byte what they
      // always were — the trash is a silent rollback margin, never a new UX.
      return this.prefillBlockedResult(connectionId, command, t(decision.category ?? decision.reason), trashScript);
    }
    return this.runPreparedExec(connectionId, command, command, false, timeoutMs, retried, options);
  }

  async runPreparedExec(connectionId, prepared, displayCommand, trashRun, timeoutMs = 30000, retried = false, options = {}) {
    const conn = this.connections.get(connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
    if (!(await this.ensureAlive(conn))) {
      return { ok: false, error: fail("connection-lost", `connection "${connectionId}" is down and could not be re-established`) };
    }
    // An exec channel always starts in the login home directory — the panel's
    // interactive shell may be somewhere else entirely. When the login shell
    // is POSIX-family, prepend the interactive-cwd prologue (see exec-cwd.js)
    // so the command runs where the operator's terminal is, and the resolved
    // directory comes back on a stripped marker line. (The trash move is only
    // ever dispatched through pendingConfirmationApprove, which refuses to
    // run it when the shell family cannot anchor relative paths.)
    const shell = await this.resolveLoginShell(conn);
    const sent = posixLoginShell(shell) && options.skipCwdFollow !== true ? buildCwdAwareCommand(prepared) : prepared;
    const commandId = randomUUID();
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    let state;
    try {
      state = await this.collectExecOutput(conn.client, sent, timeoutMs);
    } catch (error) {
      // The transport may have died between the liveness check and the exec.
      // Wait for the self-healing reconnect and retry once transparently.
      if (!retried && conn.dead && (await this.ensureAlive(conn))) {
        return this.runPreparedExec(connectionId, prepared, displayCommand, trashRun, timeoutMs, true, options);
      }
      return { ok: false, error: fail("exec-failed", error.message) };
    }
    const { cwd, stdout: execStdout } = extractExecCwd(state.stdout);
    let stdout = execStdout;
    let trashEvents = null;
    if (trashRun) {
      const parsed = parseTrashOutput(execStdout);
      stdout = parsed.stdout;
      trashEvents = parsed.events.filter((event) => event.event !== "purged");
    }
    const { stderr } = state;
    if (state.exitCode === 125 && cwd === null && stderr.startsWith(EXEC_CWD_ERROR_PREFIX)) {
      return { ok: false, error: fail("cwd-unavailable", stderr.trim()) };
    }
    // Mirror the command and output into every live shell session of this
    // connection so the panel displays agent-driven commands too. No steady-
    // state label: the `$ ` prefix is the established agent marker and, with
    // the cwd inherited, output is consistent with the visible prompt. A dim
    // warning appears only in the fallback case (cwd undetected — the exec
    // ran from the home directory, so output may contradict the prompt). A
    // trash run echoes the plain original command: the rollback margin is
    // silent, the terminal looks exactly as it always did.
    const warning = execEchoWarning(cwd);
    const display = normalizeTerminalEol(`${warning ? `${warning}\n` : ""}$ ${displayCommand}\n${stdout}${stderr.length > 0 ? stderr : ""}`)
      .replace(/(?:\r\n)+$/, "");
        // 命令台账：xssh_exec 也必须留痕（用户 2026-10-19 报告的缺口）。此前这条链路只
    // 把命令镜像到终端显示，从不调 ledger.open()，xssh_command 查不到。source=
    // agent-tool（COMMAND_SOURCES 里早已定义但从未使用的枚举值）。顺序：先 open 记
    // 命令行，再 appendSessionOutput 让输出落行日志，最后 closeFromExec 用 exec 自带
    // 的 exitCode 确定性闭口 —— 不依赖空闲判定。
    for (const sessionId of conn.sessions) {
      const session = this.sessions.get(sessionId);
      if (session && session.exited === null) {
        try {
          const ledger = this.ledgerFor(session);
          const record = ledger.open({ text: displayCommand, markLine: this.lineMark(session), source: "agent-tool", pressEnter: true });
          if (trashRun) ledger.markOutcome(record.commandId, { status: "done" });
        } catch { /* 台账是叠加层 */ }
        const prompt = session.lastPrompt ?? this.fallbackPrompt(conn);
        // exec() is a separate non-interactive SSH channel. It never makes
        // the PTY shell emit a prompt, so restore the last real prompt here.
        this.appendSessionOutput(session, `${display}\r\n${prompt}`, { capture: false, observePrompt: false });
        try {
          const ledger = session.commandLedger;
          if (ledger !== undefined && ledger !== null) {
            ledger.closeFromExec({ endLine: this.lineMark(session) - 1, exitCode: state.exitCode });
          }
        } catch { /* 台账是叠加层 */ }
      }
    }
    const value = {
      exitCode: state.exitCode,
      stdout,
      stderr,
      cwd,
      display,
      commandId,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      truncated: state.truncated,
      timedOut: state.timedOut
    };
    if (trashEvents !== null && trashEvents.length > 0) {
      value.trashed = trashEvents.map((event) => (
        event.event === "moved"
          ? { original: event.original, trashPath: event.trashPath }
          : { original: event.original }
      ));
    }
    return { ok: true, value };
  }

  /**
   * Prefill a blocked command into the first live interactive terminal session
   * of a connection WITHOUT submitting it (no Enter). Returns whether the
   * command was actually prefilled (false when no live session is open or the
   * command contains control characters that would be unsafe to send to a PTY).
   * The operator — never the agent — is the one who presses Enter.
   */
  /**
   * 危险命令被拦截时给命令编辑框的「可读版本」（用户 2026-10-19）：逐行注释写清
   * 作用、影响范围与风险，最后一行才是原命令，方便人工判断后再执行。
   */
  annotateBlockedCommand(command, reason) {
    const targets = this.blockedCommandTargets(command);
    const lines = [
      t(`# ⚠ 危险操作已被拦截：${reason}`),
      t(`# 作用：${reason}`),
      t("# 影响范围：") + (targets !== "" ? targets : t("整台服务器 / 当前目录（见最后一行命令）")),
      t("# 风险：删除、覆盖或停机类操作通常不可恢复，请先核对目标"),
      t("# 执行：确认无误后在面板点“执行”，或复制最后一行到终端回车"),
      t("# 取消：清空本编辑框即可，不会执行任何内容"),
      String(command ?? "")
    ];
    return lines.join("\n");
  }

  /** 从常见危险命令里粗略提取作用目标（只用于展示，不影响执行）。 */
  blockedCommandTargets(command) {
    const text = String(command ?? "");
    const rm = text.match(/(?:^|[;&|]\s*)(?:rm|unlink|rmdir|shred)\s+(?:-[^\s]+\s+)*([^;&|]+)/i);
    if (rm) {
      const targets = rm[1].trim().split(/\s+/).filter(Boolean).slice(0, 10);
      if (targets.length > 0) return targets.join(", ");
    }
    const dd = text.match(/\bof=([^\s;&|]+)/i);
    if (dd) return dd[1];
    const mkfs = text.match(/\bmkfs[^\s;&|]*\s+([^\s;&|]+)/i);
    if (mkfs) return mkfs[1];
    const redirect = text.match(/>\s*([^\s;&|]+)/);
    if (redirect) return redirect[1];
    return "";
  }

  prefillBlockedCommand(connectionId, command, reason = null, trashScript = null) {
    // The default reason is translated per call: module-level t() would freeze
    // whatever language happened to be active at import time.
    const effectiveReason = reason ?? t(DANGEROUS_DEFAULT_REASON);
    // Agent tools commonly omit connection_id to mean the selected right-side
    // server. Resolve it here so safety confirmations follow exactly the same
    // current-connection semantics as xssh_exec and the other SFTP tools.
    const effectiveConnectionId = connectionId ?? this.activeConnectionId;
    const conn = this.connections?.get(effectiveConnectionId);
    if (!conn) return { queued: false, prefilled: false };
    for (const sessionId of conn.sessions ?? []) {
      const session = this.sessions.get(sessionId);
      if (session && session.exited === null && session.stream !== null) {
        if (isPrefillable(command)) {
          // The command is queued for confirmation but NOT written to the
          // terminal input line.  This avoids the contradiction of a visible
          // command that Enter cannot submit — the only execution path is the
          // panel's Execute button, which sends the full command + Enter.
          // For a simple delete the card also carries the prepared trash
          // script: approving performs the reversible move, never a real rm.
          const confirmation = {
            confirmationId: randomUUID(),
            connectionId: effectiveConnectionId,
            sessionId: session.id,
            name: conn.name,
            host: conn.host,
            command,
            reason: effectiveReason,
            createdAt: new Date().toISOString(),
            prefilled: false,
            // 给命令编辑框的人类可读版本（逐行注释 + 原命令）。
            annotated: this.annotateBlockedCommand(command, effectiveReason),
            ...(trashScript ? { trashScript } : {})
          };
          this.pendingConfirmations.set(confirmation.confirmationId, confirmation);
          this.appendTerminalNotice(session, t(`危险命令已被拦截并弹出确认卡片，请在右侧 SSH 面板点击“执行”或“撤销”：${command}`));
          return { queued: true, prefilled: false, confirmationId: confirmation.confirmationId };
        }
        return { queued: false, prefilled: false };
      }
    }
    return { queued: false, prefilled: false };
  }

  /**
   * Build the xssh_exec result for a blocked destructive command: prefilled into
   * the terminal when possible, otherwise a copyable command card.
   */
  prefillBlockedResult(connectionId, command, reason, trashScript = null) {
    const pending = this.prefillBlockedCommand(connectionId, command, reason, trashScript);
    const now = new Date().toISOString();
    return {
      blocked: true,
      value: {
        exitCode: null,
        stdout: "",
        stderr: "",
        cwd: null,
        commandId: "(blocked)",
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        truncated: false,
        timedOut: false,
        blocked: true,
        reason,
        command,
        annotated: this.annotateBlockedCommand(command, reason),
        prefilled: pending.prefilled,
        queued: pending.queued
      }
    };
  }

  /** Send raw input into every live shell session of a connection. */
  writeToConnection(connectionId, input) {
    const conn = this.connections.get(connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
    let written = 0;
    let blockedReason = null;
    const touchedSessions = [];
    for (const sessionId of conn.sessions) {
      const session = this.sessions.get(sessionId);
      if (session && session.exited === null && session.stream !== null) {
        touchedSessions.push(session);
        try {
          const guarded = this.prepareTerminalInput(session, input);
          if (guarded.forwarded) session.stream.write(guarded.forwarded);
          written += guarded.forwarded.length;
          blockedReason ??= guarded.blockedReason;
        } catch {}
      }
    }
    if (blockedReason) return { ok: false, error: fail("unsafe-command", blockedReason) };
    // R3 备用通道也要留痕：**以回车结尾的单行输入**是一条完整命令 ⇒ 记台账。
    // 多行粘贴与无回车的部分输入不记（无法确定命令边界）。这补上了真机验收
    // 发现的缺口：xssh_write 直接打字的命令从不出现在 xssh_command_list 里。
    const text = String(input ?? "");
    if (text.endsWith("\r") || text.endsWith("\n")) {
      const command = text.replace(/[\r\n]+$/, "");
      if (command !== "" && !command.includes("\n")) {
        for (const session of touchedSessions) {
          try {
            const ledger = this.ledgerFor(session);
            ledger.open({ text: command, markLine: this.lineMark(session), source: "terminal-direct", pressEnter: true });
            this.scheduleIdleClose(session);
          } catch { /* 台账是叠加层 */ }
        }
      }
    }
    return { ok: true, value: { written } };
  }

  /** Add a local policy notice to the same buffer rendered by the terminal. */
  appendTerminalNotice(session, message) {
    this.appendSessionOutput(session, `\r\n\x1b[33m${t(POLICY_NOTICE_PREFIX)} ${message}\x1b[0m\r\n`);
  }

  /**
   * Preserve normal terminal editing, but submit a line only after host-side
   * policy approval. A denied line is cleared with Ctrl-U before the shell can
   * execute it. History navigation and tab completion fail closed as well.
   */
  prepareTerminalInput(session, text) {
    session.inputRevision = (session.inputRevision ?? 0) + 1;
    const { forwarded, blockedReason } = processTerminalInput(session, text, (line) => assessShellCommand(line));
    if (blockedReason !== null) this.appendTerminalNotice(session, blockedReason);
    return { forwarded, blockedReason };
  }

  /**
   * Keep the local input-line mirror in sync with raw operator input written
   * directly to the PTY (the interactive browser terminal path). The agent's
   * prepareTerminalInput() gate relies on this mirror; without syncing it
   * here, a human-typed destructive line would be invisible to the gate and a
   * later agent-driven Enter could submit it. Mirrors the per-char tracking of
   * prepareTerminalInput but never blocks or rewrites — the operator is trusted
   * on this path, only the mirror is kept honest.
   */
  updateInputMirror(session, text) {
    session.inputRevision = (session.inputRevision ?? 0) + 1;
    if (typeof text !== "string") return;
    if (session.inputLine === undefined) session.inputLine = "";
    if (session.inputKnown === undefined) session.inputKnown = true;
    processTerminalInput(session, text, null);
  }

  /** Current buffered text of a connection's first live shell session. */
  readConnectionOutput(connectionId) {
    const conn = this.connections.get(connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
    const first = [...conn.sessions].map((id) => this.sessions.get(id)).find((s) => s !== void 0 && s.exited === null);
    if (first === void 0) {
      return { ok: true, value: { data: "", hasSession: false, truncated: false, redacted: false } };
    }
    const redaction = redactForModel(first.captureBuffer);
    return {
      ok: true,
      value: {
        data: redaction.text,
        hasSession: true,
        truncated: Buffer.byteLength(first.captureBuffer, "utf8") >= this.config.maxCaptureBytes,
        redacted: redaction.redacted
      }
    };
  }

  /**
   * Select the connection represented by the right-side terminal. For a
   * single connection, fall back to it so a normal conversational request
   * never has to expose an implementation-only UUID to the user.
   */
  resolveConnection(connectionId) {
    const resourceNames = this.savedResourceNameList();
    if (connectionId !== undefined) {
      const connection = this.connections.get(connectionId);
      if (connection !== undefined) return { ok: true, connectionId, connection };
      return { ok: false, error: fail("no-connection", noConnectionGuidance(connectionId, resourceNames, this.agentAutoConnect)) };
    }
    if (this.activeConnectionId !== null) {
      const connection = this.connections.get(this.activeConnectionId);
      if (connection !== undefined) {
        return { ok: true, connectionId: this.activeConnectionId, connection };
      }
      this.activeConnectionId = null;
    }
    if (this.connections.size === 1) {
      const [resolvedId, connection] = this.connections.entries().next().value;
      return { ok: true, connectionId: resolvedId, connection };
    }
    if (this.connections.size === 0) {
      return { ok: false, error: fail("no-connection", noConnectionGuidance(undefined, resourceNames, this.agentAutoConnect)) };
    }
    return { ok: false, error: fail("connection-selection-required", "multiple SSH connections are open; select a server in the SSH panel or provide connection_id") };
  }

  // ── SFTP (file management) ─────────────────────────────────────────────────

  /** Lazily open (or reuse) the sftp subsystem of a connection. */
  async requireSftp(connection, retried = false) {
    if (connection.sftp !== null) return { ok: true, sftp: connection.sftp };
    if (!(await this.ensureAlive(connection))) {
      return { ok: false, error: fail("connection-lost", `connection "${connection.id}" is down and could not be re-established`) };
    }
    try {
      const sftp = await new Promise((resolve, reject) => {
        connection.client.sftp((error, s) => {
          if (error) reject(error);
          else resolve(s);
        });
      });
      connection.sftp = sftp;
      return { ok: true, sftp };
    } catch (error) {
      if (!retried && connection.dead && (await this.ensureAlive(connection))) {
        return this.requireSftp(connection, true);
      }
      return { ok: false, error: fail("sftp-failed", `could not open SFTP subsystem: ${error.message}`) };
    }
  }

  /** List one remote directory: entries with type, size, mtime, and mode. */
  async sftpList(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    const remotePath = request.path || ".";
    try {
      const entries = await new Promise((resolve, reject) => {
        sftp.sftp.readdir(remotePath, (error, list) => {
          if (error) reject(error);
          else resolve(list);
        });
      });
      const items = await Promise.all(entries.map(async (entry) => {
        const kind = entry.attrs.mode & 0o170000;
        let isDirectory = kind === 0o040000;
        // readdir reports the link itself, so a directory symlink such as
        // /var/lock appears as a file. Follow it once to give the UI the
        // target's real type; otherwise it tries to download a directory and
        // SFTP servers commonly respond with the opaque "Failure".
        if (kind === 0o120000) {
          const entryPath = remotePath === "/" ? `/${entry.filename}` : `${remotePath.replace(/\/+$/, "")}/${entry.filename}`;
          try {
            const attrs = await new Promise((resolve, reject) => {
              sftp.sftp.stat(entryPath, (error, value) => (error ? reject(error) : resolve(value)));
            });
            isDirectory = (attrs.mode & 0o170000) === 0o040000;
          } catch {
            // A broken or inaccessible link remains downloadable as a file;
            // its later operation can then report the server's exact error.
          }
        }
        return {
          name: entry.filename,
          isDirectory,
          size: entry.attrs.size,
          mtime: entry.attrs.mtime * 1000,
          mode: entry.attrs.mode
        };
      }));
      return { ok: true, value: { path: remotePath, entries: items } };
    } catch (error) {
      return { ok: false, error: fail("sftp-list-failed", `${remotePath}: ${error.message}`) };
    }
  }

  /** Stat one remote path. */
  async sftpStat(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      const attrs = await new Promise((resolve, reject) => {
        sftp.sftp.stat(request.path, (error, a) => {
          if (error) reject(error);
          else resolve(a);
        });
      });
      return {
        ok: true,
        value: {
          path: request.path,
          isDirectory: (attrs.mode & 0o170000) === 0o040000,
          size: attrs.size,
          mtime: attrs.mtime * 1000,
          mode: attrs.mode
        }
      };
    } catch (error) {
      return { ok: false, error: fail("sftp-stat-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Read a remote file as base64 (bounded; large files spill a hint). */
  async sftpReadFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    const maxBytes = request.maxBytes ?? MAX_FILE_READ_BYTES;
    const chunks = [];
    let total = 0;
    try {
      const stream = sftp.sftp.createReadStream(request.path);
      const done = new Promise((resolve, reject) => {
        stream.on("data", (chunk) => {
          total += chunk.length;
          if (total <= maxBytes) chunks.push(chunk);
        });
        stream.on("end", resolve);
        stream.on("error", reject);
      });
      await done;
      const truncated = total > maxBytes;
      const data = Buffer.concat(chunks).toString("base64");
      return { ok: true, value: { path: request.path, data, truncated, bytes: total } };
    } catch (error) {
      return { ok: false, error: fail("sftp-read-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Write base64 content to a remote file. */
  async sftpWriteFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      const buf = Buffer.from(request.data, "base64");
      await new Promise((resolve, reject) => {
        const stream = sftp.sftp.createWriteStream(request.path);
        stream.on("close", resolve);
        stream.on("error", reject);
        stream.end(buf);
      });
      return { ok: true, value: { path: request.path, bytes: buf.length } };
    } catch (error) {
      return { ok: false, error: fail("sftp-write-failed", `${request.path}: ${error.message}`) };
    }
  }

  // ── Streaming file plane (workbench S6 patch) ──────────────────────────────
  // HTTP byte routes over this service's own connections: callers address an
  // existing connectionId, so profile/credential/connection/host-key lifecycle
  // is fully reused and the ssh2 Client never leaves this class. Errors mirror
  // the typert business envelope ({ok:false,error:{code,message}}) with an HTTP
  // status for the transport-level outcome; success replies are {ok:true,value}.

  /** Route entry: auth fence first, then path/method dispatch. */
  /** 提供 lib/ 下的白名单静态文件（Monaco 包与其样式）。 */
  async handleAssetRoute(req, res) {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const name = url.pathname.slice(ASSET_ROUTE_PREFIX.length + 1);
      if (!ASSET_FILES.has(name)) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const bytes = await fsReadFile(new URL(`../lib/${name}`, import.meta.url));
      res.statusCode = 200;
      res.setHeader("Content-Type", name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
      // 组件产物会随构建变化（例如 file-viewer 增加了 renderer），必须每次校验：
      // 之前用 max-age 缓存导致浏览器一直跑旧 bundle（用户 2026-10-19 实测的假象）。
      res.setHeader("Cache-Control", "no-store");
      res.end(bytes);
    } catch (error) {
      res.statusCode = 404;
      res.end(`missing: ${error?.message ?? String(error)}`);
    }
  }

  handleStreamRoute(req, res, connection) {
    const rejection = connection.requestRejection(req);
    if (rejection !== void 0) {
      res.writeHead(rejection, { "content-type": "text/plain; charset=utf-8" });
      res.end(rejection === 401 ? "unauthorized" : "forbidden");
      return;
    }
    let url;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      this.streamJson(res, 400, "bad-request", "invalid request URL");
      return;
    }
    const connectionId = url.searchParams.get("connectionId");
    if (connectionId === null || connectionId === "") {
      this.streamJson(res, 400, "bad-request", "connectionId query parameter is required");
      return;
    }
    if (url.pathname === `${STREAM_ROUTE_PREFIX}/file`) {
      if (req.method === "GET") return this.streamGuard(res, this.streamDownloadFile(req, res, url, connectionId));
      if (req.method === "PUT") return this.streamGuard(res, this.streamUploadFile(req, res, url, connectionId));
    } else if (url.pathname === `${STREAM_ROUTE_PREFIX}/archive` && req.method === "GET") {
      // SFTP and SSH exec can resolve the same absolute spelling in different
      // filesystem namespaces (for example, a chrooted SFTP account). Until
      // archive generation is implemented solely through the SFTP namespace,
      // never hand an SFTP path to an SSH shell command.
      this.streamJson(res, 501, "archive-unavailable", "archive streaming is disabled until SFTP namespace-safe archiving is available");
      return;
    }
    this.streamJson(res, 405, "method-not-allowed", `${req.method} ${url.pathname} is not served`, { allow: "GET, PUT" });
  }

  /** Last-resort guard: unexpected throw → 502 envelope (or truncated body). */
  streamGuard(res, promise) {
    promise.catch((error) => {
      this.streamJson(res, 502, "stream-failed", error instanceof Error ? error.message : String(error));
    });
  }

  /** Business-envelope JSON reply (only valid before any body byte is sent). */
  streamJson(res, status, code, message, headers = {}) {
    if (res.destroyed || res.headersSent || res.writableEnded) {
      if (!res.destroyed) res.destroy();
      return;
    }
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify({ ok: false, error: { code, message } }));
  }

  /** resolveConnection/requireSftp failure → 404 (gone) or 502 (transport). */
  streamReplyFailure(res, failure) {
    const code = failure?.error?.code ?? "stream-failed";
    const message = failure?.error?.message ?? "streaming file operation failed";
    this.streamJson(res, code === "no-connection" || code === "connection-lost" ? 404 : 502, code, message);
  }

  /** Connection + live SFTP subsystem, or a mapped error reply and null. */
  async streamPrepareSftp(res, connectionId) {
    const selected = this.resolveConnection(connectionId);
    if (!selected.ok) {
      this.streamReplyFailure(res, selected);
      return null;
    }
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) {
      this.streamReplyFailure(res, sftp);
      return null;
    }
    return { connection: selected.connection, sftp: sftp.sftp };
  }

  /** stat → attrs, or a 404/502 reply and null (not-found by message, sftpList convention). */
  async streamStat(res, sftp, remotePath) {
    try {
      return await new Promise((resolve, reject) => {
        sftp.stat(remotePath, (error, attrs) => (error ? reject(error) : resolve(attrs)));
      });
    } catch (error) {
      this.streamJson(res, /No such file/i.test(error.message) ? 404 : 502, "sftp-stat-failed", `${remotePath}: ${error.message}`);
      return null;
    }
  }

  /**
   * Await the ssh2 stream 'open' event (SFTP ReadStream and WriteStream both
   * emit it) so handle-open failures stay replyable as JSON envelopes.
   * @returns the open error, or null on success.
   */
  streamAwaitOpen(stream) {
    return new Promise((resolve) => {
      let settled = false;
      stream.once("open", () => {
        if (!settled) { settled = true; resolve(null); }
      });
      stream.once("error", (error) => {
        if (!settled) { settled = true; resolve(error); }
      });
    });
  }

  /**
   * Active streaming-upload registry keyed by connectionId. A cancelled PUT can
   * go unobserved by request events (unread body masks the client FIN), so
   * connection teardown sweeps the registry to destroy SFTP write streams and
   * reply 502 — no handler outlives its SSH connection.
   */
  trackStreamUpload(connectionId, entry) {
    this.streamUploads ??= new Map();
    let set = this.streamUploads.get(connectionId);
    if (set === undefined) {
      set = new Set();
      this.streamUploads.set(connectionId, set);
    }
    set.add(entry);
  }

  untrackStreamUpload(connectionId, entry) {
    const set = this.streamUploads?.get(connectionId);
    if (set === undefined) return;
    set.delete(entry);
    if (set.size === 0) this.streamUploads.delete(connectionId);
  }

  sweepStreamUploads(connectionId, reason) {
    const set = this.streamUploads?.get(connectionId);
    if (set === undefined) return;
    this.streamUploads.delete(connectionId);
    for (const entry of [...set]) {
      try {
        entry.cancel(reason);
      } catch {}
    }
  }

  /** GET /xssh-ops/stream/file?connectionId&path — unbounded raw-byte download. */
  async streamDownloadFile(req, res, url, connectionId) {
    const remotePath = url.searchParams.get("path");
    if (remotePath === null || remotePath === "") {
      this.streamJson(res, 400, "bad-path", "path query parameter is required");
      return;
    }
    const prepared = await this.streamPrepareSftp(res, connectionId);
    if (prepared === null) return;
    const attrs = await this.streamStat(res, prepared.sftp, remotePath);
    if (attrs === null) return;
    if ((attrs.mode & 0o170000) === 0o040000) {
      this.streamJson(res, 400, "is-directory", `${remotePath}: directories download through ${STREAM_ROUTE_PREFIX}/archive`);
      return;
    }
    const stream = prepared.sftp.createReadStream(remotePath, { highWaterMark: STREAM_HIGH_WATER_MARK });
    const openError = await this.streamAwaitOpen(stream);
    if (openError !== null) {
      stream.destroy();
      this.streamJson(res, /No such file/i.test(openError.message) ? 404 : 502, "sftp-read-failed", `${remotePath}: ${openError.message}`);
      return;
    }
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(attrs.size),
      "cache-control": "no-store, no-transform"
    });
    let destroyed = false;
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      stream.destroy();
    };
    // Client abort (fetch AbortController / socket close) ends the response →
    // stop reading upstream immediately: real mid-flight cancellation.
    res.on("close", destroy);
    stream.on("error", (error) => {
      destroy();
      this.ctx.logger.warn(new Error(`xssh-ops stream download failed: ${remotePath}: ${error.message}`));
      // Headers already out: a truncated body is the only honest failure left.
      if (!res.writableEnded) res.destroy();
    });
    stream.pipe(res);
  }

  /**
   * PUT /xssh-ops/stream/file?connectionId&path[&overwrite=false][&onCancel=keep]
   * — unbounded raw-byte upload with OS-level backpressure. Cancel = request
   * socket closing before the body ends: the SFTP write stream is destroyed
   * (servers drop pending writes when the handle closes) and the partial file
   * is removed by default — deterministic policy; onCancel=keep preserves it.
   */
  async streamUploadFile(req, res, url, connectionId) {
    const remotePath = url.searchParams.get("path");
    if (remotePath === null || remotePath === "") {
      this.streamJson(res, 400, "bad-path", "path query parameter is required");
      return;
    }
    const overwrite = url.searchParams.get("overwrite") !== "false";
    const keepPartial = url.searchParams.get("onCancel") === "keep";
    const prepared = await this.streamPrepareSftp(res, connectionId);
    if (prepared === null) return;
    if (!overwrite) {
      const existing = await new Promise((resolve) => {
        prepared.sftp.stat(remotePath, (error, attrs) => resolve(error ? null : attrs));
      });
      if (existing !== null) {
        this.streamJson(res, 409, "target-exists", `${remotePath}: already exists (overwrite=false)`);
        return;
      }
    }
    const out = prepared.sftp.createWriteStream(remotePath, { highWaterMark: STREAM_HIGH_WATER_MARK });
    const openError = await this.streamAwaitOpen(out);
    if (openError !== null) {
      out.destroy();
      this.streamJson(res, 502, "sftp-write-failed", `${remotePath}: ${openError.message}`);
      return;
    }
    let bytes = 0;
    let ended = false; // request body fully received
    let settled = false; // success reply sent
    let discarded = false; // cancel path taken
    // Zombie-upload backstop 1: idle socket. While the request is paused the
    // server cannot see the client's FIN (unread body bytes precede it), so
    // socket inactivity — not request events — bounds a cancelled upload.
    const socket = req.socket;
    const onIdle = () => {
      discard("socket idle timeout");
      try { res.destroy(); } catch {}
    };
    try {
      socket.setTimeout(STREAM_IDLE_TIMEOUT_MS, onIdle);
    } catch {}
    const finalizeIo = () => {
      try {
        socket.setTimeout(0);
        socket.removeListener("timeout", onIdle);
      } catch {}
      this.untrackStreamUpload(connectionId, registryEntry);
    };
    const discard = (reason) => {
      if (settled || discarded) return;
      discarded = true;
      finalizeIo();
      try { req.pause(); } catch {}
      out.destroy();
      if (!keepPartial) {
        // Deterministic partial policy: remove the half-written file. unlink
        // succeeds while the handle is still open (POSIX); servers drop the
        // pending writes as the handle closes, so the size never grows after.
        // After connection teardown the session is dead and this is a no-op —
        // the consumer-side cleanup (Workbench backend) owns the final delete.
        prepared.sftp.unlink(remotePath, () => {});
      }
      this.streamJson(res, 502, "upload-cancelled", `${remotePath}: ${reason}`);
    };
    // Zombie-upload backstop 2: connection teardown sweeps in-flight uploads
    // (destroy the SFTP write stream + 502 reply), so no paused handler
    // outlives the SSH connection that carried it.
    const registryEntry = { path: remotePath, cancel: (reason) => discard(reason) };
    this.trackStreamUpload(connectionId, registryEntry);
    if (prepared.connection.streamUploadSweepClient !== prepared.connection.client) {
      prepared.connection.streamUploadSweepClient = prepared.connection.client;
      prepared.connection.client.once("close", () => {
        this.sweepStreamUploads(connectionId, "ssh connection closed");
      });
    }
    req.on("aborted", () => discard("client aborted the request"));
    req.on("error", (error) => discard(`request error: ${error.message}`));
    req.on("close", () => {
      if (!ended && !settled) discard("client closed the request early");
    });
    // Full body received but the client vanished before the reply (late
    // abort): still deterministic — cancelled means no file left behind.
    res.on("close", () => {
      if (!settled && !res.writableEnded) discard("client disconnected before completion");
    });
    out.on("error", (error) => {
      if (settled || discarded) return;
      settled = true;
      finalizeIo();
      try { req.destroy(); } catch {}
      this.streamJson(res, 502, "sftp-write-failed", `${remotePath}: ${error.message}`);
    });
    out.on("close", () => {
      if (settled || discarded) return;
      settled = true;
      finalizeIo();
      if (res.destroyed || res.headersSent || res.writableEnded) {
        if (!res.destroyed) res.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, value: { path: remotePath, bytes } }));
    });
    // Manual pump (instead of pipe) to count bytes and keep backpressure:
    // pause the request while the SFTP window is full, resume on drain.
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (!out.write(chunk)) req.pause();
    });
    out.on("drain", () => {
      if (!discarded && !ended) req.resume();
    });
    req.on("end", () => {
      ended = true;
      if (!discarded && !settled) out.end();
    });
  }

  /**
   * GET /xssh-ops/stream/archive?connectionId&path[&format=tar|tar.gz] —
   * folder download as a remote `tar` pipe over an exec channel. tar stores
   * symlinks as link entries (never -h): no recursive following, no directory
   * escape; empty directories and hierarchy are preserved. Non-zero exit or
   * mid-stream failure truncates the chunked response (fail-closed); the
   * stderr tail goes to the host log. Client abort closes the exec channel,
   * and servers kill the tar child on channel close — remote production stops.
   *
   * Path namespace: the SFTP view and the exec shell's filesystem view can
   * differ (chrooted/jailed SFTP servers). A one-shot `[ -d <abs> ]` exec probe
   * decides deterministically: absolute path when it exists in the shell
   * namespace (plain OpenSSH: SFTP paths are real paths), shell-cwd-relative
   * otherwise (jailed servers whose exec cwd is the SFTP root). Note the
   * inherent ambiguity when BOTH views exist (chrooted SFTP + same-named real
   * path): the absolute view wins; exec channels are not jailed anyway.
   * A failed tar with zero stdout still resolves before headers (JSON 502);
   * mid-stream failure truncates the chunked body (fail-closed).
   */
  async streamDownloadArchive(req, res, url, connectionId) {
    const remotePath = url.searchParams.get("path");
    if (remotePath === null || remotePath === "") {
      this.streamJson(res, 400, "bad-path", "path query parameter is required");
      return;
    }
    const format = url.searchParams.get("format") === "tar" ? "tar" : "tar.gz";
    const prepared = await this.streamPrepareSftp(res, connectionId);
    if (prepared === null) return;
    const attrs = await this.streamStat(res, prepared.sftp, remotePath);
    if (attrs === null) return;
    if ((attrs.mode & 0o170000) !== 0o040000) {
      this.streamJson(res, 400, "not-directory", `${remotePath}: archive download requires a directory`);
      return;
    }
    const normalized = remotePath.replace(/\/+$/u, "");
    const name = normalized.slice(normalized.lastIndexOf("/") + 1);
    const parent = normalized.slice(0, normalized.length - name.length) || "/";
    if (name === "" || name === "." || name === "..") {
      this.streamJson(res, 400, "bad-path", `${remotePath}: cannot archive this path`);
      return;
    }
    const relative = normalized.replace(/^\/+/u, "");
    const relParent = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : ".";
    const relName = relative.slice(relative.lastIndexOf("/") + 1);
    // COPYFILE_DISABLE=1 keeps macOS bsdtar from adding AppleDouble (._*)
    // members; a harmless environment prefix on every other platform.
    const build = (par, nm) => `COPYFILE_DISABLE=1 tar -c${format === "tar.gz" ? "z" : ""}f - -C ${shellQuote(par)} ${shellQuote(nm)}`;
    const contentType = format === "tar.gz" ? "application/gzip" : "application/x-tar";
    // Deterministic namespace probe (one-shot exec): does the SFTP-absolute
    // path exist in the shell's filesystem view?
    const absoluteExists = await new Promise((resolve) => {
      prepared.connection.client.exec(`[ -d ${shellQuote(normalized)} ]`, { pty: false }, (error, probe) => {
        if (error) {
          resolve(false);
          return;
        }
        let code = null;
        probe.on("exit", (exitCode) => {
          code = exitCode;
        });
        probe.on("error", () => {});
        probe.on("close", () => resolve(code === 0));
        probe.resume();
      });
    });
    const attempt = absoluteExists
      ? { label: "absolute", command: build(parent, name) }
      : { label: "cwd-relative", command: build(relParent, relName) };
    const outcome = await this.streamArchiveExec(req, res, prepared.connection, attempt.command, remotePath, contentType);
    if (outcome.streamed) return; // headers owned by the attempt (finished, truncated, or client gone)
    this.streamJson(res, 502, "archive-failed", `${remotePath}: remote tar failed (${attempt.label}: exit=${outcome.code === null ? "?" : String(outcome.code)}${outcome.stderr ? ` stderr=${String(outcome.stderr).trim().slice(-300)}` : ""})`);
  }

  /**
   * Run one archive exec attempt. Resolves {streamed:true} once the attempt
   * owned the response (first stdout byte → 200 + manual forwarding), or
   * {streamed:false, code, stderr} when it failed with zero output (headers
   * untouched — caller may try the next candidate or reply a JSON error).
   */
  streamArchiveExec(req, res, connection, command, remotePath, contentType) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      connection.client.exec(command, { pty: false }, (error, stream) => {
        if (error) {
          settle({ streamed: false, code: null, stderr: error.message });
          return;
        }
        let stderr = "";
        let exit = null;
        let started = false;
        let broken = false;
        const teardown = () => {
          if (broken) return;
          broken = true;
          try { stream.destroy(); } catch {}
        };
        stream.stderr.on("data", (chunk) => {
          stderr = tailCapped(stderr + Buffer.from(chunk).toString("utf8"), MAX_COMMAND_OUTPUT_BYTES);
        });
        stream.on("exit", (code, signal) => {
          exit = { code, signal: signal ?? null };
        });
        res.on("close", () => {
          if (!res.writableEnded) teardown();
          settle({ streamed: true }); // client gone — nothing left to reply
        });
        stream.on("error", (streamError) => {
          this.ctx.logger.warn(new Error(`xssh-ops archive stream failed: ${remotePath}: ${streamError.message}`));
          teardown();
          if (started && !res.writableEnded) res.destroy();
          settle(started ? { streamed: true } : { streamed: false, code: null, stderr: stderr || streamError.message });
        });
        stream.on("data", (chunk) => {
          if (broken) return;
          if (!started) {
            if (res.destroyed || res.writableEnded) {
              teardown();
              settle({ streamed: true });
              return;
            }
            started = true;
            res.writeHead(200, {
              "content-type": contentType,
              "cache-control": "no-store, no-transform"
            });
            settle({ streamed: true });
          }
          if (!res.write(chunk)) stream.pause();
        });
        res.on("drain", () => {
          if (!broken) stream.resume();
        });
        stream.on("close", () => {
          if (broken) {
            settle({ streamed: true });
            return;
          }
          const code = exit === null ? 0 : exit.code;
          if (!started) {
            settle({ streamed: false, code: exit === null ? null : code, stderr });
            return;
          }
          if (exit !== null && code !== 0) {
            // Truncated chunked body = fail-closed signal for a broken archive.
            this.ctx.logger.warn(new Error(`xssh-ops archive exited ${String(code)}${exit.signal ? ` (${exit.signal})` : ""}: ${remotePath}: ${stderr.trim() || "no stderr"}`));
            broken = true;
            if (!res.writableEnded) res.destroy();
          } else if (!res.writableEnded) {
            res.end();
          }
          settle({ streamed: true });
        });
      });
    });
  }

  /** Open one non-interactive SCP channel on a live SSH connection. */
  async openScpChannel(connection, command) {
    if (!(await this.ensureAlive(connection))) {
      throw new Error(`connection "${connection.id}" is down and could not be re-established`);
    }
    return new Promise((resolve, reject) => {
      connection.client.exec(command, { pty: false }, (error, stream) => {
        if (error) reject(error);
        else {
          // SCP itself reports startup failures (not installed, exec denied)
          // on stderr rather than through the binary protocol channel.
          stream.scpStderr = "";
          stream.stderr?.on("data", (chunk) => {
            stream.scpStderr = tailCapped(stream.scpStderr + Buffer.from(chunk).toString("utf8"), MAX_COMMAND_OUTPUT_BYTES);
          });
          resolve(stream);
        }
      });
    });
  }

  /** Download one file through SCP when the SSH server has no SFTP subsystem. */
  async scpReadFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const maxBytes = request.maxBytes ?? MAX_FILE_READ_BYTES;
    let stream;
    try {
      stream = await this.openScpChannel(selected.connection, scpCommand("f", request.path));
      const result = await scpDownload(stream, maxBytes);
      return {
        ok: true,
        value: { path: request.path, data: result.data.toString("base64"), truncated: result.truncated, bytes: result.bytes }
      };
    } catch (error) {
      return { ok: false, error: fail("scp-read-failed", `${request.path}: ${stream?.scpStderr?.trim() || error.message}`) };
    }
  }

  /** Upload one file through SCP when the SSH server has no SFTP subsystem. */
  async scpWriteFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    let stream;
    try {
      const data = Buffer.from(request.data, "base64");
      stream = await this.openScpChannel(selected.connection, scpCommand("t", request.path));
      const result = await scpUpload(stream, request.path, data);
      return { ok: true, value: { path: request.path, bytes: result.bytes } };
    } catch (error) {
      return { ok: false, error: fail("scp-write-failed", `${request.path}: ${stream?.scpStderr?.trim() || error.message}`) };
    }
  }

  /** Create a remote directory (mkdir -p semantics via mkdir + stat). */
  async sftpMkdir(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      await new Promise((resolve, reject) => {
        sftp.sftp.mkdir(request.path, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return { ok: true, value: { path: request.path } };
    } catch (error) {
      return { ok: false, error: fail("sftp-mkdir-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Delete a remote file (or empty directory). */
  async sftpDelete(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      const isDir = await new Promise((resolve, reject) => {
        sftp.sftp.stat(request.path, (error, attrs) => {
          if (error) reject(error);
          else resolve((attrs.mode & 0o170000) === 0o040000);
        });
      });
      await new Promise((resolve, reject) => {
        const fn = isDir ? sftp.sftp.rmdir : sftp.sftp.unlink;
        fn.call(sftp.sftp, request.path, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return { ok: true, value: { path: request.path, isDirectory: isDir } };
    } catch (error) {
      return { ok: false, error: fail("sftp-delete-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Rename a remote file or directory. */
  async sftpRename(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      await new Promise((resolve, reject) => {
        sftp.sftp.rename(request.from, request.to, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return { ok: true, value: { from: request.from, to: request.to } };
    } catch (error) {
      return { ok: false, error: fail("sftp-rename-failed", `${request.from} -> ${request.to}: ${error.message}`) };
    }
  }

  // ── Directory batch transfer (SFTP) ────────────────────────────────────────
  // Scheduling policy lives in sftp-dir.js: small files in a bounded pool of
  // 6, files over 512 KiB one at a time, monotone counters, per-file failures
  // collected instead of fatal. These methods only implement the I/O.

  /** Promisified one-shot sftp callback op. */
  sftpCall(sftp, fn) {
    return new Promise((resolve, reject) => fn((error, value) => (error ? reject(error) : resolve(value))));
  }

  /** mkdir -p over SFTP: create each missing segment, verify with stat. */
  async ensureRemoteDir(sftp, dir) {
    if (dir === "/" || dir === "") return;
    try {
      await this.sftpCall(sftp, (cb) => sftp.sftp.mkdir(dir, cb));
      return;
    } catch {
      // Fall through: the directory may already exist, or the parent may be
      // missing — stat decides, recursion creates the parent chain.
    }
    try {
      const attrs = await this.sftpCall(sftp, (cb) => sftp.sftp.stat(dir, cb));
      if ((attrs.mode & 0o170000) === 0o040000) return;
      throw new Error(`${dir} exists and is not a directory`);
    } catch (error) {
      if (/not a directory/.test(error.message)) throw error;
      const { parent } = splitRemotePath(dir);
      await this.ensureRemoteDir(sftp, parent);
      await this.sftpCall(sftp, (cb) => sftp.sftp.mkdir(dir, cb));
    }
  }

  /** Upload one local file into a remote SFTP write stream. */
  sftpUploadFile(sftp, localFile, remoteFile) {
    return new Promise((resolve, reject) => {
      const source = createReadStream(localFile);
      const target = sftp.sftp.createWriteStream(remoteFile);
      source.on("error", (error) => { target.destroy(); reject(error); });
      target.on("error", (error) => { source.destroy(); reject(error); });
      target.on("close", () => resolve());
      source.pipe(target);
    });
  }

  /** Download one remote SFTP file into a local write stream. */
  sftpDownloadFile(sftp, remoteFile, localFile) {
    return new Promise((resolve, reject) => {
      const source = sftp.sftp.createReadStream(remoteFile);
      const target = createWriteStream(localFile);
      source.on("error", (error) => { target.destroy(); reject(error); });
      target.on("error", (error) => { source.destroy(); reject(error); });
      target.on("close", () => resolve());
      source.pipe(target);
    });
  }

  /** Recursively list a remote directory; returns [{ rel, path, size, isDirectory }]. */
  async walkRemoteDir(sftp, root, base = root, out = []) {
    const entries = await this.sftpCall(sftp, (cb) => sftp.sftp.readdir(root, cb));
    for (const entry of entries) {
      const path = joinRemotePath(root, entry.filename);
      const rel = relativePath(base, path).split("\\").join("/");
      const isDirectory = (entry.attrs.mode & 0o170000) === 0o040000;
      if (isDirectory) {
        out.push({ rel, path, size: 0, isDirectory: true });
        await this.walkRemoteDir(sftp, path, base, out);
      } else {
        out.push({ rel, path, size: entry.attrs.size ?? 0, isDirectory: false });
      }
    }
    return out;
  }

  /**
   * Upload a local directory tree over SFTP. Small files transfer in a
   * bounded pool; large files one at a time; per-file failures are reported
   * in the result instead of aborting the batch.
   */
  async sftpUploadDir(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    const { localPath, remotePath } = request;
    try {
      const rootStat = await fsStat(localPath);
      if (!rootStat.isDirectory()) {
        return { ok: false, error: fail("sftp-upload-dir-failed", `${localPath} is not a directory`) };
      }
      await this.ensureRemoteDir(sftp, remotePath);
      const entries = [];
      const walk = async (dir) => {
        for (const entry of await fsReaddir(dir, { withFileTypes: true })) {
          const full = joinPath(dir, entry.filename ?? entry.name);
          if (entry.isDirectory()) {
            await walk(full);
          } else if (entry.isFile()) {
            const { size } = await fsStat(full);
            entries.push({ full, size });
          }
        }
      };
      await walk(localPath);
      const tasks = entries.map(({ full, size }) => {
        const rel = relativePath(localPath, full).split("\\").join("/");
        return { path: rel, size, run: () => this.sftpUploadFile(sftp, full, joinRemotePath(remotePath, rel)) };
      });
      // Every ancestor directory of every file, deduplicated, created shallow
      // first so each mkdir sees its parent already in place.
      const remoteDirs = new Set();
      for (const task of tasks) {
        let dir = dirnamePath(task.path).split("\\").join("/");
        while (dir !== "." && dir !== "/" && dir !== "") {
          remoteDirs.add(dir);
          dir = dirnamePath(dir);
        }
      }
      const sortedDirs = [...remoteDirs].sort((a, b) => a.length - b.length);
      for (const dir of sortedDirs) {
        await this.ensureRemoteDir(sftp, joinRemotePath(remotePath, dir));
      }
      const { files, bytes, failures } = await runTransferTasks(tasks);
      return {
        ok: true,
        value: { source: localPath, target: remotePath, directories: remoteDirs.size + 1, files, bytes, failed: failures }
      };
    } catch (error) {
      return { ok: false, error: fail("sftp-upload-dir-failed", `${localPath} -> ${remotePath}: ${error.message}`) };
    }
  }

  /**
   * Download a remote directory tree over SFTP with the same scheduling
   * policy as sftpUploadDir.
   */
  async sftpDownloadDir(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    const { remotePath, localPath } = request;
    try {
      const rootAttrs = await this.sftpCall(sftp, (cb) => sftp.sftp.stat(remotePath, cb));
      if ((rootAttrs.mode & 0o170000) !== 0o040000) {
        return { ok: false, error: fail("sftp-download-dir-failed", `${remotePath} is not a directory`) };
      }
      await fsMkdir(localPath, { recursive: true });
      const entries = await this.walkRemoteDir(sftp, remotePath);
      const directories = entries.filter((e) => e.isDirectory).length;
      for (const dir of entries.filter((e) => e.isDirectory)) {
        await fsMkdir(joinPath(localPath, dir.rel), { recursive: true });
      }
      const tasks = entries.filter((e) => !e.isDirectory).map((entry) => ({
        path: entry.rel,
        size: entry.size,
        run: async () => {
          const local = joinPath(localPath, entry.rel);
          await fsMkdir(dirnamePath(local), { recursive: true });
          await this.sftpDownloadFile(sftp, entry.path, local);
        }
      }));
      const { files, bytes, failures } = await runTransferTasks(tasks);
      return {
        ok: true,
        value: { source: remotePath, target: localPath, directories: directories + 1, files, bytes, failed: failures }
      };
    } catch (error) {
      return { ok: false, error: fail("sftp-download-dir-failed", `${remotePath} -> ${localPath}: ${error.message}`) };
    }
  }

  // ── Port forwarding (tunnels) ──────────────────────────────────────────────

  /**
   * Start a local port forward: the DSH host listens on bindAddr:bindPort and
   * forwards connections through the SSH connection to remoteHost:remotePort
   * (ssh2 Client.forwardOut semantics). Returns the assigned local endpoint.
   */
  async tunnelStartLocal(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const conn = selected.connection;
    if (!(await this.ensureAlive(conn))) {
      return { ok: false, error: fail("connection-lost", `connection "${conn.id}" is down and could not be re-established`) };
    }
    const tunnelId = `tun-${randomUUID().slice(0, 8)}`;
    const bindAddr = request.bindAddr ?? "127.0.0.1";
    const bindPort = request.bindPort ?? 0;
    const net = await import("node:net");
    try {
      const server = net.createServer((socket) => {
        conn.client.forwardOut(bindAddr, bindPort, request.remoteHost, request.remotePort, (error, stream) => {
          if (error) {
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
        });
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(bindPort, bindAddr, () => resolve());
      });
      const address = server.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : bindPort;
      conn.tunnels.set(tunnelId, {
        id: tunnelId,
        kind: "local",
        bindAddr,
        bindPort: actualPort,
        remoteHost: request.remoteHost,
        remotePort: request.remotePort,
        server,
        active: true
      });
      return {
        ok: true,
        value: {
          tunnelId,
          kind: "local",
          bindAddr,
          bindPort: actualPort,
          remoteHost: request.remoteHost,
          remotePort: request.remotePort
        }
      };
    } catch (error) {
      return { ok: false, error: fail("tunnel-start-failed", `local ${bindAddr}:${bindPort} -> ${request.remoteHost}:${request.remotePort}: ${error.message}`) };
    }
  }

  /**
   * Start a remote port forward: connections to remoteHost:remotePort on the
   * server are forwarded back through the SSH connection to bindAddr:bindPort
   * on the DSH host (ssh2 Client.forwardIn). Requires the server's sshd to
   * allow remote forwards (AllowTcpForwarding); typically needs root or a
   * GatewayPorts-capable sshd.
   */
  async tunnelStartRemote(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const conn = selected.connection;
    if (!(await this.ensureAlive(conn))) {
      return { ok: false, error: fail("connection-lost", `connection "${conn.id}" is down and could not be re-established`) };
    }
    const tunnelId = `tun-${randomUUID().slice(0, 8)}`;
    const bindAddr = request.bindAddr ?? "127.0.0.1";
    const bindPort = request.bindPort ?? 0;
    try {
      await new Promise((resolve, reject) => {
        conn.client.forwardIn(bindAddr, bindPort, (error, port) => {
          if (error) reject(error);
          else resolve(port);
        });
      });
      // Bridge every accepted remote connection to the local target.
      const bridge = (info, accept) => {
        if (info.destIP !== bindAddr || info.destPort !== bindPort) return;
        const stream = accept();
        const socket = net.connect(request.targetPort, request.targetHost);
        socket.on("error", () => stream.destroy());
        stream.on("error", () => socket.destroy());
        stream.pipe(socket).pipe(stream);
      };
      conn.client.prependListener("tcp connection", bridge);
      const bridgeInfo = { kind: "remote", bindAddr, bindPort, bridge };
      conn.tunnels.set(tunnelId, {
        id: tunnelId,
        kind: "remote",
        bindAddr,
        bindPort,
        remoteHost: request.remoteHost,
        remotePort: request.remotePort,
        targetHost: request.targetHost,
        targetPort: request.targetPort,
        active: true,
        bridgeInfo
      });
      return {
        ok: true,
        value: {
          tunnelId,
          kind: "remote",
          bindAddr,
          bindPort,
          remoteHost: request.remoteHost,
          remotePort: request.remotePort,
          targetHost: request.targetHost,
          targetPort: request.targetPort
        }
      };
    } catch (error) {
      return { ok: false, error: fail("tunnel-start-failed", `remote ${bindAddr}:${bindPort}: ${error.message}`) };
    }
  }

  /** Stop a tunnel by id. */
  /**
   * Dynamic SOCKS5 forwarding (the `ssh -D` equivalent): one local listener
   * whose clients choose the destination per connection; each chosen address
   * is opened as a fresh channel on the SSH connection, so the client reaches
   * whatever that server can reach.
   */
  async tunnelStartDynamic(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const conn = selected.connection;
    if (!(await this.ensureAlive(conn))) {
      return { ok: false, error: fail("connection-lost", `connection "${conn.id}" is down and could not be re-established`) };
    }
    const tunnelId = `tun-${randomUUID().slice(0, 8)}`;
    const bindAddr = request.bindAddr ?? "127.0.0.1";
    const bindPort = request.bindPort ?? 0;
    const net = await import("node:net");
    const record = { id: tunnelId, kind: "dynamic", bindAddr, bindPort, active: true, connections: 0 };
    try {
      const server = net.createServer((socket) => {
        record.connections += 1;
        attachSocks5(socket, {
          forwardOut: (host, port, callback) => conn.client.forwardOut("127.0.0.1", 0, host, port, callback),
          onClose: () => { record.connections = Math.max(0, record.connections - 1); }
        });
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(bindPort, bindAddr, () => resolve());
      });
      const address = server.address();
      record.bindPort = typeof address === "object" && address !== null ? address.port : bindPort;
      record.server = server;
      conn.tunnels.set(tunnelId, record);
      return { ok: true, value: { tunnelId, kind: "dynamic", bindAddr, bindPort: record.bindPort } };
    } catch (error) {
      return { ok: false, error: fail("tunnel-start-failed", error.message) };
    }
  }

  async tunnelStop(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const conn = selected.connection;
    const tunnel = conn.tunnels.get(request.tunnelId);
    if (tunnel === void 0) return { ok: false, error: fail("no-tunnel", `tunnel "${request.tunnelId}" does not exist on this connection`) };
    try {
      if (tunnel.kind === "local" || tunnel.kind === "dynamic") {
        await new Promise((resolve) => tunnel.server.close(() => resolve()));
      } else {
        if (tunnel.bridgeInfo?.bridge) {
          conn.client.removeListener("tcp connection", tunnel.bridgeInfo.bridge);
        }
        await new Promise((resolve) => conn.client.unforwardIn(tunnel.bindAddr, tunnel.bindPort, () => resolve()));
      }
      conn.tunnels.delete(request.tunnelId);
      return { ok: true, value: { tunnelId: request.tunnelId, stopped: true } };
    } catch (error) {
      return { ok: false, error: fail("tunnel-stop-failed", error.message) };
    }
  }

  /** List tunnels on a connection. */
  async tunnelList(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const tunnels = [...selected.connection.tunnels.values()].map((t) => {
      const entry = {
        tunnelId: t.id,
        kind: t.kind,
        bindAddr: t.bindAddr,
        bindPort: t.bindPort,
        remoteHost: t.remoteHost,
        remotePort: t.remotePort,
        active: t.active
      };
      if (t.targetHost !== undefined) entry.targetHost = t.targetHost;
      if (t.targetPort !== undefined) entry.targetPort = t.targetPort;
      if (t.connections !== undefined) entry.connections = t.connections;
      return entry;
    });
    return { ok: true, value: { tunnels } };
  }

  // ── session logs ───────────────────────────────────────────────────────────

  async sessionLogList() {
    const store = this.sessionLogStore();
    if (store === null) return { ok: true, value: { enabled: false, logs: [] } };
    return { ok: true, value: { enabled: true, logs: await store.list() } };
  }

  async sessionLogRead(request) {
    const store = this.sessionLogStore();
    if (store === null) {
      return { ok: false, error: fail("session-log-disabled", t("会话录制已关闭（config.sessionLogEnabled = false）")) };
    }
    const result = await store.read(request.sessionId, { offset: request.offset, maxBytes: request.maxBytes });
    if (result.ok !== true) {
      return { ok: false, error: fail("no-session-log", t(`会话日志不存在：${request.sessionId}`)) };
    }
    return {
      ok: true,
      value: {
        sessionId: request.sessionId, data: result.data,
        startOffset: result.startOffset, nextOffset: result.nextOffset, eof: result.eof, size: result.size
      }
    };
  }

  async sessionLogSearch(request) {
    const store = this.sessionLogStore();
    if (store === null) {
      return { ok: false, error: fail("session-log-disabled", t("会话录制已关闭（config.sessionLogEnabled = false）")) };
    }
    const result = await store.search(request.sessionId, { query: request.query, maxHits: request.maxHits });
    if (result.ok !== true) {
      return { ok: false, error: fail("no-session-log", t(`会话日志不存在：${request.sessionId}`)) };
    }
    return {
      ok: true,
      value: { sessionId: request.sessionId, hits: result.hits, scannedBytes: result.scannedBytes, stoppedEarly: result.stoppedEarly }
    };
  }

  async sessionLogDelete(request) {
    const store = this.sessionLogStore();
    if (store === null) return { ok: true, value: { deleted: 0, remaining: 0 } };
    const deleted = request.sessionId === undefined
      ? (await store.removeAll()).deleted
      : ((await store.remove(request.sessionId)), 1);
    return { ok: true, value: { deleted, remaining: (await store.list()).length } };
  }

  /** Execute a command on the explicit or current SSH connection. */
  async executeCommand(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const result = await this.execOnConnection(selected.connectionId, request.command, request.timeoutMs);
    if (result.blocked) {
      return {
        ok: true,
        value: {
          connectionId: selected.connectionId,
          host: selected.connection.host,
          ...result.value,
          redacted: false
        }
      };
    }
    if (!result.ok) return result;
    const { exitCode, stdout, stderr, cwd, commandId, startedAt, finishedAt, durationMs, truncated, timedOut } = result.value;
    const safeStdout = redactForModel(stdout);
    const safeStderr = redactForModel(stderr);
    return {
      ok: true,
      value: {
        connectionId: selected.connectionId,
        host: selected.connection.host,
        exitCode,
        stdout: safeStdout.text,
        stderr: safeStderr.text,
        cwd,
        commandId,
        startedAt,
        finishedAt,
        durationMs,
        truncated,
        timedOut,
        redacted: safeStdout.redacted || safeStderr.redacted
      }
    };
  }

  /** Read terminal output from the explicit or current SSH connection. */
  readCurrentConnection(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const result = this.readConnectionOutput(selected.connectionId);
    if (!result.ok) return result;
    return {
      ok: true,
      value: {
        connectionId: selected.connectionId,
        host: selected.connection.host,
        ...result.value
      }
    };
  }

  /**
   * Make sure the target connection has a live PTY session so agent input can
   * actually be submitted. With multiple open connections and no terminal open
   * on the target yet, a plain write would otherwise drop the input (0 bytes
   * written). Resolves the connection by id or the active one, then opens a
   * session lazily when none is live.
   */
  async ensureSessionForWrite(connectionId) {
    const selected = this.resolveConnection(connectionId);
    if (!selected.ok) return selected;
    const live = [...selected.connection.sessions].some((sessionId) => {
      const session = this.sessions.get(sessionId);
      return session !== void 0 && session.exited === null && session.stream !== null;
    });
    if (live) return { ok: true, connectionId: selected.connectionId };
    const opened = await this.openSession({ connectionId: selected.connectionId, cols: 100, rows: 30, openedBy: "agent" });
    if (!opened.ok) return opened;
    return { ok: true, connectionId: selected.connectionId };
  }

  /**
   * 工具侧入口：把「连接（或当前连接）」解析到一个**活的**、带行日志的会话。
   *
   * 单独抽出来是因为三个行号工具都要这一步，而各自的错误文案要一致
   * （「没有打开的终端」比「找不到会话」更能指导下一步动作）。
   */
  terminalLinesFor(connectionId) {
    const selected = this.resolveConnection(connectionId);
    if (!selected.ok) return selected;
    const session = [...selected.connection.sessions]
      .map((id) => this.sessions.get(id))
      .find((item) => item !== void 0 && item.exited === null && item.lineJournal !== undefined);
    if (session === void 0) {
      return { ok: false, error: fail("no-terminal", `connection "${selected.connectionId}" has no open terminal`) };
    }
    return {
      ok: true,
      value: {
        sessionId: session.id,
        connectionId: selected.connectionId,
        host: selected.connection.host,
        session
      }
    };
  }

  /** Send tool input to the explicit or current SSH connection. */
  writeCurrentConnection(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    return this.writeToConnection(selected.connectionId, request.input);
  }

  /** Disconnect the explicit or current SSH connection. */
  async disconnectCurrentConnection(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    return this.disconnect({ connectionId: selected.connectionId });
  }

  /** Append transport data and retain a bounded, explicit-read capture. */
  /**
   * The session-log store, created on first use. Returns null when recording
   * is switched off in config; every call site treats null as "not recording".
   */
  sessionLogStore() {
    if (this.config.sessionLogEnabled === false) return null;
    if (this.sessionLogs === undefined || this.sessionLogs === null) {
      const dir = this.config.sessionLogDir ?? joinPath(homedir(), ".dsh", "xssh-ops-logs");
      this.sessionLogs = new SessionLogStore({ dir });
    }
    return this.sessionLogs;
  }

  /** 按设置自动清理会话日志（用户 2026-10-19）：总量与保留天数双条件。 */
  async pruneSessionLogs() {
    const settings = this.settings ?? {};
    if (settings.sessionLogAutoPruneEnabled === false) return { ok: true, skipped: true };
    const store = this.sessionLogStore();
    if (store === null) return { ok: true, skipped: true };
    const maxTotalBytes = Math.max(1, Number(settings.sessionLogMaxTotalMB ?? OUTPUT_LOG_DEFAULTS.sessionLogMaxTotalMB)) * 1024 * 1024;
    const maxAgeDays = Math.max(0, Number(settings.sessionLogMaxAgeDays ?? OUTPUT_LOG_DEFAULTS.sessionLogMaxAgeDays));
    try {
      return await store.prune({ maxTotalBytes, maxAgeDays });
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  /** 命令台账的 JSONL 落盘（默认 `~/.dsh/xssh-ops/commands/`）。 */
  commandLedgerStore() {
    if (this.config.commandLedgerEnabled === false) return null;
    if (this.commandLedgers === undefined || this.commandLedgers === null) {
      const dir = this.config.commandLedgerDir ?? joinPath(homedir(), ".dsh", "xssh-ops", "commands");
      this.commandLedgers = createCommandLedgerStore({ dir });
    }
    return this.commandLedgers;
  }

  /**
   * 会话的命令台账（懒建）。落盘是**旁路**：写失败只丢持久化，不影响会话与内存台账。
   * 首次创建时异步回填最近若干条（进程重启后仍能按命令内容查到旧命令）。
   */
  ledgerFor(session) {
    if (session.commandLedger !== undefined && session.commandLedger !== null) return session.commandLedger;
    const store = this.commandLedgerStore();
    const connection = this.connections.get(session.connectionId);
    const ledger = createCommandLedger({
      sessionId: session.id,
      connectionId: session.connectionId,
      host: connection?.host ?? null,
      idleCloseMs: this.config.commandIdleMs,
      onRecord: store === null ? null : (record, _event) => { void store.append(session.id, record).catch(() => {}); }
    });
    session.commandLedger = ledger;
    if (store !== null) {
      void store.load(session.id, { tail: this.config.commandLedgerLoadTail })
        .then((records) => { if (records.length > 0) ledger.restore(records); })
        .catch(() => {});
    }
    return ledger;
  }

  /**
   * R9① 连接就绪后启动规则引擎（计划 5.8）。
   *
   * 两条约束：
   *   - **每会话最多跑一次**：会话对象上记 `loginScript`,已存在就直接返回，避免
   *     复用已有会话时重复执行（会重复发口令一类副作用）。
   *   - **校验在保存时**：这里再校验一次是兜底 —— 若设置文件被手工改成危险内容，
   *     启动会失败而不是把它发出去（连接阶段没有确认卡片可弹）。
   */
  startLoginScriptIfEnabled(session) {
    // **登录脚本按服务器资源配置**（用户 2026-10-17 要求，从设置页迁来）：
    // 优先读本会话所属服务器（profile）上的 loginScript；该服务器没配时**回退**
    // 到全局设置（向后兼容：老配置还在 settings 表里，仍能生效）。
    const settings = this.settings ?? {};
    const connection = this.connections.get(session.connectionId);
    const profileRecord = connection?.profileId !== undefined
      ? this.requireProfileTable().get(connection.profileId)
      : undefined;
    const perServer = profileRecord?.loginScript;
    const perServerEnabled = perServer !== undefined && perServer !== null && perServer.rulesEnabled === true;
    const rulesEnabled = perServerEnabled || settings.loginScriptRulesEnabled === true;
    if (!rulesEnabled) return { ok: true, started: false };
    const rules = perServerEnabled
      ? (Array.isArray(perServer.rules) ? perServer.rules : [])
      : (Array.isArray(settings.loginScriptRules) ? settings.loginScriptRules : []);
    if (rules.length === 0) return { ok: true, started: false };
    if (session.loginScript !== null && session.loginScript !== undefined) {
      return { ok: true, started: false, already: true };
    }
    const matchMode = perServerEnabled
      ? (perServer.matchMode ?? LOGIN_SCRIPT_MATCH_MODE)
      : (settings.expectMatchMode ?? LOGIN_SCRIPT_MATCH_MODE);
    const stepTimeoutMs = perServerEnabled
      ? (perServer.stepTimeoutMs ?? LOGIN_SCRIPT_STEP_TIMEOUT_MS)
      : (settings.expectStepTimeoutMs ?? LOGIN_SCRIPT_STEP_TIMEOUT_MS);
    const onTimeout = perServerEnabled
      ? (perServer.onTimeout === "strict" ? "strict" : "skip")
      : (settings.onTimeout === "strict" ? "strict" : "skip");
    const validation = validateLoginScriptRules(rules, { matchMode, stepTimeoutMs });
    if (!validation.ok) {
      // 危险/非法规则：不启动，并把原因写进终端，让操作者立刻看到。
      this.appendTerminalNotice(session, t(`登录脚本规则未通过校验，已跳过：${validation.problems[0].message}`));
      return { ok: false, started: false, error: validation.problems[0] };
    }
    try {
      const runner = createLoginScriptRunner({ rules, matchMode, stepTimeoutMs, onTimeout });
      session.loginScript = runner;
      // 登录后命令（用户 2026-10-17 增强）：expect/send 规则跑完后逐条发送。
      session.loginScriptPostCommands = perServerEnabled ? (Array.isArray(perServer.postCommands) ? perServer.postCommands : []) : [];
      session.loginScriptPostSent = false;
      session.loginScriptStartedAt = new Date().toISOString();
      runner.start();
      return { ok: true, started: true, totalRules: rules.length };
    } catch (error) {
      this.appendTerminalNotice(session, t(`登录脚本启动失败：${error.message}`));
      return { ok: false, started: false, error: { message: error.message } };
    }
  }

  /**
   * 推进所有会话的登录脚本超时判定（判据：单条规则等不到就跳过）。
   * 由外部或内部的轻量定时器调用；模块本身不挂定时器，方便测试。
   */
  /**
   * 发送「登录后命令」（用户 2026-10-17 增强）：规则序列结束后逐条发送。
   * 每条独立记台账（source=login-post）；失败只写终端提示，不中断后续条目。
   */
  sendPostLoginCommands(session) {
    const commands = Array.isArray(session.loginScriptPostCommands) ? session.loginScriptPostCommands : [];
    if (commands.length === 0) return;
    for (const command of commands) {
      const text = String(command ?? "");
      if (text.trim() === "") continue;
      try {
        const guarded = this.prepareTerminalInput(session, text + "\r");
        if (guarded.forwarded) session.stream.write(guarded.forwarded);
        const ledger = this.ledgerFor(session);
        ledger.open({ text, markLine: this.lineMark(session), source: "login-post", pressEnter: true });
        this.scheduleIdleClose(session);
      } catch (error) {
        this.appendTerminalNotice(session, t(`登录后命令发送失败：${error.message}`));
      }
    }
    this.appendTerminalNotice(session, t(`登录脚本完成，已执行 ${commands.length} 条登录后命令。`));
  }


  tickLoginScripts(at = Date.now()) {
    for (const session of this.sessions.values()) {
      const runner = session.loginScript;
      if (runner === null || runner === undefined) continue;
      // 规则跑完 → 发登录后命令（幂等：发过就不再发）。
      if (runner.snapshot().state === "done" && session.loginScriptPostSent !== true) {
        session.loginScriptPostSent = true;
        this.sendPostLoginCommands(session);
      }
      try {
        const result = runner.tick(at);
        if (result !== null && result.kind === "skip") {
          this.appendTerminalNotice(session, t(`登录脚本第 ${result.ruleIndex + 1} 条等待超时，已跳过。`));
        } else if (result !== null && result.kind === "abort") {
          this.appendTerminalNotice(session, t(`登录脚本第 ${result.ruleIndex + 1} 条等待超时（严格模式），已中止后续规则。`));
        }
      } catch { /* 引擎是叠加层 */ }
    }
  }

  /** 命令编辑框的唯一入口（计划 M2 / R3）：**先记台账，再写终端**。
   *
   * 顺序是有意的：先写终端的话，命令可能在台账落账前就已经回显并开始产出，区间会错。
   *
   * 危险命令走确认卡片而**不直接发送**（R3 验收）：与智能体同一条 `assessShellCommand`
   * 策略，卡片里点「执行」才真的发出去。
   */
  async sendCommand({ sessionId, connectionId, text, pressEnter = true, source = "user-editbox" } = {}) {
    const command = String(text ?? "");
    if (command === "") return { ok: false, error: fail("empty-command", "command text is empty") };

    let session = sessionId !== undefined ? this.sessions.get(sessionId) : void 0;
    if (session === void 0 && connectionId !== undefined) {
      const connection = this.connections.get(connectionId);
      session = [...(connection?.sessions ?? [])]
        .map((id) => this.sessions.get(id))
        .find((item) => item !== void 0 && item.exited === null && item.stream !== null);
    }
    if (session === void 0) return { ok: false, error: fail("no-session", "no live terminal session to send into") };
    if (session.exited !== null || session.stream === null) {
      return { ok: false, error: fail("exited", `session "${session.id}" has already exited`) };
    }

    const ledger = this.ledgerFor(session);
    const decision = assessShellCommand(command);
    if (!decision.ok) {
      // 记一条 blocked，留痕但明确不占输出区间；随后弹确认卡片（不写终端）。
      const blockedRecord = ledger.open({ text: command, markLine: this.lineMark(session), source, pressEnter });
      ledger.markOutcome(blockedRecord.commandId, { status: "blocked", endLine: blockedRecord.startLine - 1 });
      const queued = this.prefillBlockedCommand(session.connectionId, command, decision.reason);
      this.appendTerminalNotice(session, t(`命令编辑框拦下一条危险命令，请在右侧面板确认或撤销：${command}`));
      return {
        ok: true,
        value: {
          blocked: true,
          reason: decision.reason,
          commandId: blockedRecord.commandId,
          startLine: blockedRecord.startLine,
          confirmationId: queued?.confirmationId ?? null,
          sent: false
        }
      };
    }

    const record = ledger.open({ text: command, markLine: this.lineMark(session), source, pressEnter });
    try {
      session.stream.write(pressEnter === true ? `${command}\r` : command);
      // 发出的字节同样算活动（R8② 判据 4 是「任一方向」）。
      session.lastActivityAt = Date.now();
      this.updateInputMirror(session, pressEnter === true ? `${command}\r` : command);
    } catch (error) {
      ledger.markOutcome(record.commandId, { status: "failed-to-send", endLine: record.startLine - 1 });
      return { ok: false, error: fail("write-failed", error.message) };
    }
    this.scheduleIdleClose(session);
    return {
      ok: true,
      value: {
        commandId: record.commandId,
        startLine: record.startLine,
        sent: true,
        blocked: false,
        reason: null,
        confirmationId: null
      }
    };
  }

  /**
   * 命令台账列表（供「日志 → 命令台账」视图与 `xssh_command_list` 共用）。
   *
   * 默认过滤保活/登录脚本（计划 Q17）；显式传 `source` 时不再过滤，否则那个显式
   * 查询永远是空结果。
   */
  listCommands({ sessionId, limit = 50, source, includeHidden = false } = {}) {
    const sessions = sessionId !== undefined
      ? [this.sessions.get(sessionId)].filter((item) => item !== undefined)
      : [...this.sessions.values()];
    /** @type {Array<object>} */
    const commands = [];
    for (const session of sessions) {
      const ledger = session.commandLedger;
      if (ledger === undefined || ledger === null) continue;
      commands.push(...ledger.recent({ limit: 500, source, includeHidden }));
    }
    // 跨会话时按发出时间倒序合并；单会话本来就已是倒序。
    commands.sort((left, right) => String(right.issuedAt).localeCompare(String(left.issuedAt)));
    const capped = Number.isSafeInteger(limit) && limit > 0 ? limit : 50;
    return { ok: true, value: { commands: commands.slice(0, capped) } };
  }

  // ── M4 后台执行与临时文件（R7）────────────────────────────────────────────

  /** 任务台账（懒建，落盘 `~/.dsh/xssh-ops/tasks.jsonl`）。 */
  taskLedger() {
    if (this.tasks === undefined || this.tasks === null) {
      const dir = this.config.taskLedgerDir ?? joinPath(homedir(), ".dsh", "xssh-ops");
      this.tasks = createTaskLedger({ dir });
      void this.tasks.load({ tail: 500 })
        .then((records) => { if (records.length > 0) this.tasks.restore(records); })
        .catch(() => {});
    }
    return this.tasks;
  }

  /**
   * 下发一个后台任务（计划 5.5.5 / R7）。
   *
   * 流程：**预检一次往返 → 选落点（可能降级）→ 建台账（落点如实记录）→
   * 在远端后台化（`setsid nohup` + `ready` 哨兵）或走本地通道**。
   *
   * 三条不能省的：
   *   1. 破坏性命令仍然过 `assessShellCommand` —— **不允许后台工具静默执行**；
   *   2. 降级必须把三重告警同时写进工具返回与台账（用户与智能体都要知道结果不在远端）；
   *   3. 等 `ready` 哨兵才算起了 —— 没有它就分不清「已后台化」与「根本没起来」。
   */
  async execBackground(request = {}) {
    const command = String(request.command ?? "");
    if (command === "") return { ok: false, error: fail("empty-command", "command text is empty") };

    // 安全：与前台同一条策略。破坏性命令只走确认卡片，后台工具不得静默执行。
    const decision = assessShellCommand(command);
    if (!decision.ok) {
      const queued = this.prefillBlockedCommand(request.connectionId, command, decision.reason);
      return {
        ok: false,
        error: fail("unsafe-command", t(`后台任务被安全策略拦下（${decision.reason}）；请走确认卡片或人工执行。`)),
        value: { queued: queued === null, confirmationId: queued?.confirmationId ?? null }
      };
    }

    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const connectionId = selected.connectionId;

    // 预检（一次往返）。**force_local 时跳过**：用户已经明说要本地通道，
    // 再跑一次探测是白花的往返（实测被这条断言抓到）。
    let probe = { kind: "unparsed", freeKb: null };
    if (request.forceLocal !== true) {
      const probeResult = await this.execOnConnection(connectionId, probeCommand(), 10000, false, { skipCwdFollow: true });
      if (!probeResult.ok) return probeResult;
      probe = parseProbe(probeResult.value.stdout);
    }

    const minFree = Number.isFinite(this.config.minRemoteFreeKb) ? this.config.minRemoteFreeKb : DEFAULT_MIN_REMOTE_FREE_KB;
    const plan = decideLocation({
      probe,
      minRemoteFreeKb: minFree,
      allowLowSpace: request.allowLowSpace === true,
      forceLocal: request.forceLocal === true,
      allowLocalDegrade: this.config.allowLocalDegrade !== false
    });
    if (plan.location === "blocked") {
      return {
        ok: false,
        error: fail("no-usable-target", t("远端没有可用的临时目录，且已禁用本地降级。")),
        value: { warnings: plan.warnings }
      };
    }

    // 命令台账：后台任务也是一条命令（source=agent-bg），与任务台账共用 commandId。
    const session = [...selected.connection.sessions]
      .map((id) => this.sessions.get(id))
      .find((item) => item !== undefined && item.exited === null);
    const ledger = session === undefined ? null : this.ledgerFor(session);
    const commandRecord = ledger === null
      ? null
      : ledger.open({ text: command, markLine: this.lineMark(session), source: "agent-bg", pressEnter: false });
    const commandId = commandRecord?.commandId ?? null;

    const task = this.taskLedger().create({
      connectionId,
      host: selected.connection.host,
      commandId,
      command,
      label: String(request.label ?? ""),
      location: plan.location,
      degraded: plan.degraded,
      // 降级告警原样落台账（日志页签要能复查）。
      warnings: plan.warnings,
      remoteDir: null,
      localDir: null
    });

    if (plan.remoteMode) {
      // **两个形态要分清**（这里踩过一次大坑）：
      //   - 包装命令里用**模板形态** `$d=${TMPDIR:-/tmp}/...`，让远端 shell 自己展开，
      //     这样它总是落在远端当时真正的临时目录（可能不是 /tmp）；
      //   - **台账里存展开后的真实路径**（`probe.dir`），因为 `cat`/`ls`/`rm` 都要拿它
      //     去执行 —— 存模板会让它们去找一个字面名叫 `${TMPDIR:-/tmp}` 的路径，
      //     结果就是 taskRead/taskStatus/taskDelete 全部"读不到文件"（且静默）。
      const templateDir = remoteTaskDir(plan.location, task.taskId);
      const wrapper = remoteWrapperCommand({ dir: templateDir, command });
      const started = await this.execOnConnection(connectionId, wrapper, 30000, false, { skipCwdFollow: true });
      const stdoutText = started.ok ? String(started.value.stdout ?? "") : "";
      const stderrText = started.ok ? String(started.value.stderr ?? "") : "";
      // 真实目录：优先用预检回显的（`probe.dir`），退回 `/tmp`/`~` 时也如实记录
      const realDir = resolveRemoteTaskDir(plan.location, task.taskId, {
        tmpRoot: plan.location === "remote-tmp" ? (probe.dir ?? null) : null,
        homeRoot: plan.location === "remote-home" ? (probe.dir ?? null) : null
      }).path;
      // 哨兵判定要**先看 FAIL 再看 ready**：包装里有条件回 `ready`，失败时回
      // `FAIL mkdir` / `FAIL pid` / `FAIL exec`（早期是无条件 echo ready，于是远端
      // 建不了目录、pid 写不进去、甚至子进程立刻退出都照样"成功"）。
      // stderr 一并带进告警，否则用户只看到"没回 ready"却不知道远端到底报了什么。
      const failure = /FAIL\s+\w+/.exec(stdoutText);
      if (!started.ok || failure !== null || !stdoutText.includes("ready")) {
        const reason = failure !== null
          ? t(`远端后台化失败（${failure[0]}）`)
          : started.ok ? t("后台化没有回显 ready") : started.error.message;
        // 嵌套模板里再嵌一个 `远端输出：…` 会让 i18n 检查器与译者都难处理，
        // 所以把远端 stderr 单独拼出来再进 t()。
        const remoteHint = stderrText.trim() === ""
          ? ""
          : t(`远端输出：${stderrText.trim().slice(0, 400)}`);
        this.taskLedger().update(task.taskId, {
          state: "degraded-aborted",
          warnings: [t(`${reason}：命令可能没有真正起来，请用任务状态复查。`) + remoteHint]
        });
        return {
          ok: false,
          error: fail("background-start-failed", `${reason}: ${started.ok ? (stderrText.trim() || "no sentinel") : started.error.message}`),
          value: { taskId: task.taskId, location: plan.location, warnings: plan.warnings, remoteDir: realDir }
        };
      }
      const files = remoteTaskFiles(realDir);
      this.taskLedger().update(task.taskId, { remoteDir: realDir });
      return {
        ok: true,
        value: {
          taskId: task.taskId,
          commandId,
          location: plan.location,
          degraded: plan.degraded,
          warnings: plan.warnings,
          remoteDir: realDir,
          localDir: null,
          outPath: files.stdout,
          errPath: files.stderr,
          exitPath: files.exit,
          pidFile: files.pid,
          startedAt: task.startedAt
        }
      };
    }

    // 本地降级通道：由 host 持久的 exec 通道把输出写到本地文件。
    // **代价已在告警里写明**：断线即中断，结果不留远端。
    const base = this.config.localTmpDir ?? joinPath(tmpdir(), "dsh-xssh-ops");
    const localDir = localTaskDir(base, task.taskId);
    try {
      await fsMkdir(localDir, { recursive: true });
    } catch (error) {
      this.taskLedger().markDeleted(task.taskId);
      return { ok: false, error: fail("local-dir-failed", error.message), value: { warnings: plan.warnings } };
    }
    const outPath = joinPath(localDir, "stdout.log");
    const errPath = joinPath(localDir, "stderr.log");
    const exitPath = joinPath(localDir, "exit.code");
    this.taskLedger().update(task.taskId, { localDir });
    // 本地通道的写入是异步的：任务状态由 _runLocalBackground 更新。
    void this._runLocalBackground({ connectionId, taskId: task.taskId, command, outPath, errPath, exitPath });
    return {
      ok: true,
      value: {
        taskId: task.taskId,
        commandId,
        location: "local",
        degraded: true,
        // 降级告警必须回给智能体，让它在对话里主动转述（计划 5.5.5 第二处）。
        warnings: plan.warnings,
        remoteDir: null,
        localDir,
        outPath,
        errPath,
        exitPath,
        pidFile: null,
        startedAt: task.startedAt
      }
    };
  }

  /** 本地降级通道的实际执行体（异步、不阻塞工具返回）。 */
  async _runLocalBackground({ connectionId, taskId, command, outPath, errPath, exitPath }) {
    try {
      const result = await this.execOnConnection(connectionId, command, 0);
      const stdout = result.ok ? String(result.value.stdout ?? "") : "";
      const stderr = result.ok ? String(result.value.stderr ?? "") : String(result.error?.message ?? "");
      await fsWriteFile(outPath, stdout, "utf8");
      await fsWriteFile(errPath, stderr, "utf8");
      const code = result.ok ? String(result.value.exitCode ?? 0) : "255";
      await fsWriteFile(exitPath, code, "utf8");
      // **失败必须标 degraded-aborted**：`execOnConnection` 用 `{ok:false}` 报错（不是抛
      // 异常），早期版本不管 ok 一律标 done —— 于是一次失败的本地任务在界面上显示
      // 「已完成」，这正是本视图最不该有的误导（跟把 missing 显示成 done 同一类错）。
      this.taskLedger().update(taskId, {
        state: result.ok ? "done" : "degraded-aborted",
        exitCode: Number(code),
        bytes: { out: Buffer.byteLength(stdout, "utf8"), err: Buffer.byteLength(stderr, "utf8") },
        ...(result.ok ? {} : { warnings: [t(`本地通道执行失败：${result.error?.message ?? "unknown"}`)] })
      });
    } catch (error) {
      try { await fsWriteFile(errPath, String(error?.message ?? error), "utf8"); } catch { /* best effort */ }
      try { await fsWriteFile(exitPath, "255", "utf8"); } catch { /* best effort */ }
      this.taskLedger().update(taskId, { state: "degraded-aborted", warnings: [String(error?.message ?? error)] });
    }
  }

  /** 查任务状态：远端读 exit/stdout/stderr 的大小与运行标志；本地读文件。 */
  async taskStatus(request = {}) {
    const task = this.taskLedger().byId(String(request.taskId ?? ""));
    if (task === null) return { ok: false, error: fail("no-task", `task "${request.taskId}" does not exist`) };
    // 本地模式：靠台账状态（文件由 _runLocalBackground 写）。
    // 判据用 location，而不是台账里不存在的 remoteMode 字段（写错会永远走远端分支）。
    if (task.location === "local") {
      // 本地模式：靠台账状态（文件由 _runLocalBackground 写）
      return {
        ok: true,
        value: {
          taskId: task.taskId,
          state: task.state,
          location: task.location,
          degraded: task.degraded,
          exitCode: task.exitCode,
          bytes: task.bytes,
          warnings: task.warnings
        }
      };
    }
    const statusResult = await this.execOnConnection(task.connectionId, remoteStatusCommand({ dir: task.remoteDir }), 10000, false, { skipCwdFollow: true });
    if (!statusResult.ok) return statusResult;
    const parsed = parseStatus(statusResult.value.stdout);
    // 远端状态与台账不一致时以**远端为准**（台账只是记录，事实在服务器上）
    const patch = { state: parsed.state === "done" ? "done" : parsed.state === "missing" ? "missing" : "running" };
    if (parsed.exitCode !== null) patch.exitCode = parsed.exitCode;
    patch.bytes = parsed.bytes;
    this.taskLedger().update(task.taskId, patch);
    const updated = this.taskLedger().byId(task.taskId);
    return {
      ok: true,
      value: {
        taskId: task.taskId,
        state: updated.state,
        location: updated.location,
        degraded: updated.degraded,
        exitCode: updated.exitCode,
        bytes: updated.bytes,
        warnings: updated.warnings
      }
    };
  }

  /** 按行号读取任务输出（与 readTerminalLines 同构，但读的是文件）。 */
  async taskRead(request = {}) {
    const task = this.taskLedger().byId(String(request.taskId ?? ""));
    if (task === null) return { ok: false, error: fail("no-task", `task "${request.taskId}" does not exist`) };
    const stream = request.stream === "err" ? "err" : request.stream === "both" ? "both" : "out";
    const paths = task.location === "local"
      ? { out: joinPath(task.localDir, "stdout.log"), err: joinPath(task.localDir, "stderr.log") }
      : { out: remoteTaskFiles(task.remoteDir).stdout, err: remoteTaskFiles(task.remoteDir).stderr };
    // 统一用 `cat`/读文件都行；远端用 `cat -n` 拿到带行号的正文，本地直接读文件。
    const wanted = stream === "both" ? ["out", "err"] : [stream];
    const chunks = [];
    for (const which of wanted) {
      const path = paths[which];
      // 不预设初值：两个分支都会赋值，空串初值从未被读取（lint no-useless-assignment）。
      let text;
      if (task.location === "local") {
        try { text = await fsReadFile(path, "utf8"); } catch (error) { text = error?.code === "ENOENT" ? "" : String(error?.message ?? error); }
      } else {
        const read = await this.execOnConnection(task.connectionId, `[ -f ${shellSingleQuote(path)} ] && cat ${shellSingleQuote(path)} || true`, 15000, false, { skipCwdFollow: true });
        text = read.ok ? String(read.value.stdout ?? "") : "";
      }
      chunks.push({ stream: which, text });
    }
    // 行号化：与行日志同一套规则（四位数左补零）
    const lines = [];
    for (const chunk of chunks) {
      const raw = chunk.text.split(/\r?\n/);
      // 末尾换行会产生一个空元素，去掉它（否则最后一行总是空行）
      if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
      for (const line of raw) lines.push({ stream: chunk.stream, line: lines.length + 1, text: line });
    }
    const from = Number.isSafeInteger(request.fromLine) && request.fromLine > 0 ? request.fromLine : 1;
    const to = Number.isSafeInteger(request.toLine) ? request.toLine : lines.length;
    const tail = Number.isSafeInteger(request.tailLines) && request.tailLines > 0 ? request.tailLines : null;
    const slice = tail === null
      ? lines.filter((entry) => entry.line >= from && entry.line <= to)
      : lines.slice(Math.max(0, lines.length - tail));
    return {
      ok: true,
      value: {
        taskId: task.taskId,
        state: task.state,
        location: task.location,
        degraded: task.degraded,
        text: formatNumberedLines(slice.map((entry) => ({ line: entry.line, text: entry.text }))),
        lines: slice,
        count: slice.length,
        totalLines: lines.length,
        firstLine: lines.length === 0 ? 0 : 1,
        lastLine: lines.length,
        nextLine: slice.length === 0 ? from : slice[slice.length - 1].line + 1,
        hasMore: slice.length > 0 && slice[slice.length - 1].line < lines.length,
        warnings: task.warnings
      }
    };
  }

  /** 删除任务产物（远端目录 / 本地文件）并标记台账。 */
  async taskDelete(request = {}) {
    const task = this.taskLedger().byId(String(request.taskId ?? ""));
    if (task === null) return { ok: false, error: fail("no-task", `task "${request.taskId}" does not exist`) };
    if (task.location !== "local" && task.remoteDir !== null) {
      const deleted = await this.execOnConnection(task.connectionId, remoteDeleteCommand({ dir: task.remoteDir }), 15000, false, { skipCwdFollow: true });
      if (!deleted.ok) return deleted;
    }
    if (task.location === "local" && task.localDir !== null) {
      try { await fsRm(task.localDir, { recursive: true, force: true }); } catch { /* 已经不在也无妨 */ }
    }
    this.taskLedger().markDeleted(task.taskId);
    return { ok: true, value: { taskId: task.taskId, deleted: true, location: task.location } };
  }

  /**
   * 任务列表（供工具与客户端「日志 → 后台任务」视图共用）。
   *
   * 返回的是**契约字段**（不是裸台账记录）：`outBytes`/`errBytes` 铺平、命令过脱敏 ——
   * 客户端与工具都按同一形状消费，避免两边各猜一次字段名。
   */
  taskList({ connectionId, limit = 20 } = {}) {
    const tasks = this.taskLedger().recent({ connectionId, limit });
    return {
      ok: true,
      value: {
        tasks: tasks.map((task) => ({
          taskId: task.taskId,
          connectionId: task.connectionId,
          host: task.host,
          commandId: task.commandId,
          command: redactForModel(String(task.command ?? "")).text,
          label: String(task.label ?? ""),
          location: task.location,
          degraded: task.degraded === true,
          warnings: Array.isArray(task.warnings) ? [...task.warnings] : [],
          remoteDir: task.remoteDir,
          localDir: task.localDir,
          state: task.state,
          exitCode: task.exitCode ?? null,
          outBytes: task.bytes?.out ?? 0,
          errBytes: task.bytes?.err ?? 0,
          startedAt: task.startedAt,
          finishedAt: task.finishedAt ?? null
        }))
      }
    };
  }

  /**
   * 降级告警汇总（计划 5.5.5：降级告警必须同时出现在三处，这里是第三处 —— 面板）。
   * 只回**未结束的降级任务**：已结束的没必要一直占着告警条。
   */
  taskDegradedNotices() {
    const degraded = this.taskLedger()
      .recent({ limit: 50 })
      .filter((task) => task.degraded === true && task.state === "running")
      .map((task) => ({
        taskId: task.taskId,
        label: String(task.label ?? ""),
        command: redactForModel(String(task.command ?? "")).text,
        warnings: Array.isArray(task.warnings) ? [...task.warnings] : [],
        localDir: task.localDir
      }));
    return { ok: true, value: { degraded } };
  }

  /**
   * 按 TTL 扫一遍超龄任务并清远端产物（计划 5.7：`taskTtlHours` 默认 24 h）。
   *
   * **只清「已结束且未删」的**（`expired()` 已保证）。远端删除失败的任务**不标
   * expired** —— 否则台账会显示"已清理"而远端文件其实还在，反而更难查。
   */
  async sweepExpiredTasks({ at = Date.now() } = {}) {
    const ttlHours = Number.isFinite(this.config.taskTtlHours) ? this.config.taskTtlHours : 24;
    const ledger = this.taskLedger();
    const stale = ledger.expired({ at, ttl: ttlHours });
    const swept = [];
    for (const task of stale) {
      try {
        if (task.location !== "local" && task.remoteDir !== null) {
          const deleted = await this.execOnConnection(task.connectionId, remoteDeleteCommand({ dir: task.remoteDir }), 15000, false, { skipCwdFollow: true });
          // 远端删除失败就跳过标记（留着让下一次重试，别谎报已清理）。
          if (!deleted.ok) { swept.push({ taskId: task.taskId, ok: false, reason: deleted.error.message }); continue; }
        } else if (task.location === "local" && task.localDir !== null) {
          try { await fsRm(task.localDir, { recursive: true, force: true }); } catch { /* 已不在也无妨 */ }
        }
        ledger.markExpired(task.taskId, at);
        swept.push({ taskId: task.taskId, ok: true });
      } catch (error) {
        swept.push({ taskId: task.taskId, ok: false, reason: error?.message ?? String(error) });
      }
    }
    // 顺带压缩落盘文件（默认留 30 天，与任务 TTL 解耦：台账记录比产物留得久）
    try { await ledger.prune({ days: 30, at }); } catch { /* 压缩失败不影响清理结果 */ }
    return { ok: true, value: { swept, ttlHours } };
  }

  /**
   * 命令回显将占用的行号 = 行日志「下一个待分配行号」。命令回显行本身不进结果区间
   * （`startLine = markLine + 1`，见 command-ledger.js 文件头第 2 条）。
   */
  lineMark(session) {
    const journal = session.lineJournal;
    if (journal === undefined) return 0;
    return journal.nextLine();
  }

  /**
   * 判据②的空闲闭口：有未闭口命令时挂一个一次性定时器。
   *
   * **必须"重置"而不是"叠加"**：每次输出到达都会重挂（"空闲"的定义是"一段时间
   * 没有新输出"）。早期直接 `setTimeout` 不做取消，于是**多个定时器同时存在** ——
   * 早挂的那个先触发并闭口，把**之后才到达的输出**排除在区间之外（实测：
   * `closedBy=idle-timeout` 且 `endLine` 指向一行空行，输出行根本没进区间）。
   * 现在每次重挂前先 `clearTimeout` 掉上一个，语义就是标准的"重置空闲计时"。
   */
  scheduleIdleClose(session) {
    const idleMs = Number.isFinite(this.config.commandIdleMs) ? this.config.commandIdleMs : 1500;
    // 取消上一个（如果有）—— 不取消会让早挂的定时器先闭口，丢掉后到的输出。
    if (session.idleCloseTimer !== undefined && session.idleCloseTimer !== null) {
      clearTimeout(session.idleCloseTimer);
      session.idleCloseTimer = null;
    }
    const timer = setTimeout(() => {
      session.idleCloseTimer = null;
      const ledger = session.commandLedger;
      if (ledger === void 0 || ledger === null) return;
      ledger.closeIfIdle({ lastLine: session.lineJournal?.lastLine(), at: Date.now() });
    }, idleMs + 50);
    if (typeof timer.unref === "function") timer.unref();
    session.idleCloseTimer = timer;
  }

  appendSessionOutput(session, text, { capture = true, observePrompt = true } = {}) {
    this.terminalOutput(session).append(text);
    // R8② 的空闲判定要「任一方向的字节活动」时间：这里记收，write 里记发。
    session.lastActivityAt = Date.now();
    // 判据②「空闲静默闭口」必须**在输出到达时重挂定时器**：
    // "空闲"的定义就是"一段时间没有新输出"，而输出是异步到达的（真实 shell 回显
    // 可能晚于 `sendCommand` 里的那一次定时器）。只在 sendCommand 挂一次的话，
    // 输出晚到时区间会在内容还没落进来时就闭口 —— 实测表现为
    // 「按 ID 取输出读不到命令的输出」（偶发，取决于回显速度）。
    // 注意**不新建台账**（不在无命令的会话上产生副作用）。
    if (session.commandLedger !== undefined && session.commandLedger !== null
      && session.commandLedger.openRecords().length > 0) {
      this.scheduleIdleClose(session);
    }
    // 行号行日志：唯一汇聚点的叠加层。解析异常绝不能拖垮会话本身。
    try {
      // 保活字符串的回显：如果这段输出里有刚发出的保活文本，就给提交出的那一行
      // 打 keepalive（计划 5.8：照实记录但可识别，且不得当成用户命令）。
      const pending = session.pendingKeepaliveText;
      if (typeof pending === "string" && pending !== "" && String(text).includes(pending)) {
        session.lineJournal?.appendKeepalive(text);
        session.pendingKeepaliveText = null;
      } else {
        session.lineJournal?.append(text);
      }
    } catch { /* 行日志是叠加层，坏了不影响会话 */ }
    // R9① 登录脚本：把同一段原始输出喂给规则引擎。匹配用净化文本（引擎内部做），
    // 命中后**经 sendCommand 发送**，所以行日志/行号/命令区间照常可用，并标
    // source=login-script（命令列表默认过滤它，但可显式查回）。
    if (session.loginScript !== null && session.loginScript !== undefined) {
      try {
        const triggered = session.loginScript.feed(text);
        for (const item of triggered) {
          void this.sendCommand({
            sessionId: session.id,
            text: item.send,
            pressEnter: true,
            source: "login-script"
          }).catch(() => {});
        }
      } catch { /* 脚本引擎是叠加层，坏了不影响会话可用性 */ }
    }
    // Recording must never influence the session: a broken log is swallowed.
    try {
      const store = this.sessionLogStore();
      if (store !== null && session.logMeta !== undefined) {
        if (!store.has(session.id)) void store.begin(session.logMeta).catch(() => {});
        store.append(session.id, text);
      }
    } catch { /* keep the session alive */ }
    // shell-integration 既喂给 tracker，也用来判「命令结束」（OSC 133 D）——
    // 这是命令台账判据①，最可靠且带 exit code。
    let finishedCommands = null;
    const tracker = session.shellIntegration;
    if (tracker !== undefined && tracker !== null) {
      const before = tracker.state?.commands ?? 0;
      try { tracker.feed(text); } catch { /* tracking is decoration */ }
      const after = tracker.state?.commands ?? 0;
      if (after > before) finishedCommands = tracker.state?.lastExitCode ?? null;
    }
    // 命令台账：有新输出就推进「当前行」并重置空闲计时（判据②的分母）；
    // 若这一段输出里出现了 OSC 133 D，就是判据①，立即闭口。
    if (session.commandLedger !== undefined && session.commandLedger !== null) {
      try {
        session.commandLedger.noteOutput({ lastLine: session.lineJournal?.lastLine() });
        if (finishedCommands !== null && tracker !== undefined) {
          session.commandLedger.closeFromShellIntegration({
            endLine: session.lineJournal?.lastLine(),
            exitCode: finishedCommands
          });
        }
      } catch { /* 台账是叠加层，坏了不影响会话 */ }
    }
    // Legacy poll readers retain their independent destructive buffer.
    session.buffer = tailCapped((session.buffer ?? "") + text, this.config.maxBufferBytes);
    if (capture) {
      session.captureBuffer = tailCapped((session.captureBuffer ?? "") + text, this.config.maxCaptureBytes);
    }
    if (observePrompt) {
      const prompt = promptFromTerminalData(text);
      if (prompt !== null) session.lastPrompt = prompt;
    }
    // 输出过大提示（用户 2026-10-19）：累计超过设置阈值时提醒一次（60 秒冷却），
    // 避免「行历史被淘汰、旧命令查不到内容」时毫无感知。
    try {
      const warnKB = Number(this.settings?.outputWarnKB ?? OUTPUT_LOG_DEFAULTS.outputWarnKB);
      if (warnKB > 0) {
        session.outputWarnBytes = (session.outputWarnBytes ?? 0) + Buffer.byteLength(String(text ?? ""), "utf8");
        const now = Date.now();
        if (session.outputWarnBytes >= warnKB * 1024 && now - (session.outputWarnAt ?? 0) > 60_000) {
          const totalKB = Math.round(session.outputWarnBytes / 1024);
          session.outputWarnBytes = 0;
          session.outputWarnAt = now;
          this.appendTerminalNotice(session, t(`本次输出较大（约 ${totalKB} KB），行历史可能已被淘汰；建议用 tail -n / head -c / sed -n 限制输出。`));
        }
      }
    } catch { /* 提示是叠加层，失败不影响会话 */ }
    this.wakeWaiters(session, null);
    this.notifyStreamListeners(session, text);
  }

  fallbackPrompt(connection) {
    return `${connection.username}@${connection.host}:~${connection.username === "root" ? "#" : "$"} `;
  }

  // ── Agent tools ────────────────────────────────────────────────────────────

  registerTools(ctx) {
    // Tool bodies live in src/tools/*; each register function binds this
    // service instance via closure (defineTool invokes execute as a bare
    // function, so the tools reach service methods through this argument).
    registerSshSessionTools(ctx, this);
    registerResourceTools(ctx, this);
    registerTerminalLineTools(ctx, this);
    registerBackgroundTools(ctx, this);
    registerSftpTools(ctx, this);
    registerTunnelTools(ctx, this);
    registerSessionLogTools(ctx, this);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  recordExit(session, exit) {
    if (session.exited !== null) return;
    session.exited = exit;
    try { void this.sessionLogStore()?.end(session.id, { exitCode: exit?.code ?? null }); } catch { /* best-effort */ }
    // 会话结束：未闭口的命令按 session-end 收口（拿不到 exit code ⇒ status=unknown，
    // 不能假装 done）。否则那条记录会永远挂在「运行中」。
    try {
      session.commandLedger?.closeAll({ lastLine: session.lineJournal?.lastLine(), closedBy: "session-end" });
    } catch { /* 台账是叠加层 */ }
    this.removePendingForSession(session.id);
    // A naturally-exited shell must no longer count as an open terminal:
    // drop it from the connection's live-session set so list() reports only
    // live PTYs and the panel can offer to open a fresh one on that tab.
    if (session.connectionId !== undefined) {
      const conn = this.connections.get(session.connectionId);
      if (conn !== undefined) conn.sessions.delete(session.id);
    }
    this.wakeWaiters(session, exit);
    this.notifyStreamListeners(session, "");
  }

  rememberExit(id, exit) {
    if (this.exitedSessions.size >= MAX_EXIT_TOMBSTONES) {
      const oldest = this.exitedSessions.keys().next().value;
      if (oldest !== void 0) this.exitedSessions.delete(oldest);
    }
    this.exitedSessions.set(id, exit);
  }

  wakeWaiters(session, exit) {
    if (session.waiters.length === 0) return;
    const cursorWaiters = session.waiters.filter((waiter) => waiter.cursor);
    session.waiters = session.waiters.filter((waiter) => !waiter.cursor);
    for (const waiter of cursorWaiters) waiter.resolve();
    if (session.waiters.length === 0) return;
    session.waiters.shift().resolve({
      ok: true,
      value: { data: this.drain(session), exit }
    });
    if (exit !== null) {
      for (const rest of session.waiters.splice(0)) {
        rest.resolve({ ok: true, value: { data: "", exit } });
      }
    }
  }

  /** Feed appended output to stream-push consumers; every listener sees every item. */
  notifyStreamListeners(session, _text) {
    if (session.streamListeners === undefined) return;
    for (const listener of session.streamListeners) {
      listener.wake?.();
    }
  }

  drain(session) {
    const pending = session.buffer;
    session.buffer = "";
    return encodeData(pending);
  }
}

