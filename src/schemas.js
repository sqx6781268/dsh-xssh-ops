/**
 * Zod schemas for the dsh-xssh-ops wire contract. Bundled into both faces:
 * the host typert manifest validates incoming args and outgoing results, and
 * the client contribution validates the same envelope on the browser side.
 */
import { z } from "zod";

export const sshErrorSchema = z.object({
  code: z.string(),
  message: z.string()
});

export function okSchema(value) {
  return z.object({ ok: z.literal(true), value });
}

export function resultSchema(value) {
  return z.union([
    okSchema(value),
    z.object({ ok: z.literal(false), error: sshErrorSchema })
  ]);
}

// ── auth ────────────────────────────────────────────────────────────────────

// A single authentication factor. Dual-factor devices (firewalls/switches
// with `AuthenticationMethods password,publickey` or the reverse) require two
// factors on the SAME connection, so a credential may carry a primary factor
// plus an optional secondary of the opposite kind.
export const passwordFactorSchema = z.object({
  kind: z.literal("password"),
  password: z.string()
});

export const keyFactorSchema = z.object({
  kind: z.literal("key"),
  privateKey: z.string(),
  passphrase: z.string().optional()
});

export const passwordAuthSchema = passwordFactorSchema.extend({
  // Optional second factor: a key, when the primary factor is the password.
  secondary: keyFactorSchema.optional()
});

export const keyAuthSchema = keyFactorSchema.extend({
  // Optional second factor: a password, when the primary factor is the key.
  secondary: passwordFactorSchema.optional()
});

export const authSchema = z.union([passwordAuthSchema, keyAuthSchema]);

// ── host-key TOFU policy ─────────────────────────────────────────────────────
// accept-new: trust on first use, reject on change (OpenSSH accept-new).
// verify:     reject unseen hosts, reject on change.
// off:        skip host-key verification entirely (not recommended).

export const hostKeyModeSchema = z.enum(["accept-new", "verify", "off"]);

// ── upstream SOCKS5 proxy (consume a proxy before reaching the server) ───────
// This is the mirror of the dynamic-forward (ssh -D) feature: instead of
// *providing* a SOCKS5 proxy, the connection dials *through* one. It is
// distinct from proxyJump — the upstream here is a SOCKS5 service, not a
// login-able SSH server. A saved/recorded proxy never carries the password
// (that lives in the credential store); a one-shot connect request may carry
// an inline password instead.
//
// Both fields are optional everywhere on the way out (profileInfoSchema) so
// records saved before this feature existed load unchanged — zero migration.
export const proxyConfigSchema = z.object({
  // Only SOCKS5 is supported today; the discriminator leaves room for more.
  type: z.literal("socks5"),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(128).optional()
});
export const connectProxySchema = proxyConfigSchema.extend({
  password: z.string().max(255).optional()
});

// ── connect ─────────────────────────────────────────────────────────────────

export const connectRequestSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1),
  // A temporary connection may reference a saved shared credential.  In that
  // case the secret is resolved only in the service, never returned to React.
  auth: authSchema.optional(),
  credentialId: z.string().uuid().optional(),
  readyTimeout: z.number().int().min(1000).max(120000).optional(),
  // Legacy KEX opt-in for old VRP/IOS devices that only offer SHA-1 group14.
  // Omitted → the plugin retries once automatically when the handshake fails
  // on KEX selection; true → use the legacy set up front (no downgrade
  // warning); false → modern algorithms only, no automatic retry.
  legacy: z.boolean().optional(),
  // Opt-in SSH agent forwarding: hand the local ssh-agent to the remote host
  // so terminals opened on it can authenticate onward with the local keys.
  // Requires a running local agent (SSH_AUTH_SOCK); the connect fails fast
  // with an actionable message otherwise.
  agentForward: z.boolean().optional(),
  name: z.string().optional(),
  hostKeyMode: hostKeyModeSchema.optional(),
  proxyJump: z.array(z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().min(1),
    auth: authSchema,
    readyTimeout: z.number().int().min(1000).max(120000).optional(),
    hostKeyMode: hostKeyModeSchema.optional()
  })).optional(),
  proxyJumpProfileIds: z.array(z.string().uuid()).max(8).optional(),
  // Dial through an upstream SOCKS5 proxy before reaching host:port. Inline
  // password allowed for a one-shot quick connect; saved resources omit it.
  proxy: connectProxySchema.optional()
}).refine((request) => request.auth !== undefined || request.credentialId !== undefined, {
  message: "auth or credentialId is required"
});

export const connectResultSchema = resultSchema(
  z.object({
    connectionId: z.string(),
    name: z.string().optional(),
    host: z.string(),
    port: z.number(),
    username: z.string(),
    // Set when the handshake needed the legacy KEX set; `warning` carries the
    // user-facing explanation so a weakened transport is never silent.
    legacyFallback: z.boolean().optional(),
    // Set when the peer's identification string had to be normalized before
    // ssh2 would accept it (see ssh-banner.js); also explained in `warning`.
    bannerRepair: z.boolean().optional(),
    warning: z.string().optional()
  })
);

// ── list ────────────────────────────────────────────────────────────────────

export const listRequestSchema = z.object({});

export const connectionInfoSchema = z.object({
  connectionId: z.string(),
  name: z.string().optional(),
  host: z.string(),
  port: z.number(),
  username: z.string(),
  connected: z.boolean(),
  sessions: z.array(z.string()),
  // True while the connection has a live session opened by the agent
  // (xssh_connect_profile); the browser auto-reveals the SSH surface for it.
  agentSession: z.boolean().optional(),
  agentRevealId: z.string().optional(),
  // 资源归属（用户 2026-10-19）：面板用它与 profileList 的 groupId 对齐。
  profileId: z.string().optional()
});

// A saved SSH resource as the agent sees it (issue #25): coordinates only —
// no credentials, no credential ids, no jump chains.
export const savedResourceInfoSchema = z.object({
  profileId: z.string(),
  name: z.string(),
  host: z.string(),
  port: z.number(),
  username: z.string(),
  connected: z.boolean()
});

export const listResultSchema = resultSchema(
  z.object({
    connections: z.array(connectionInfoSchema),
    activeConnectionId: z.string().nullable(),
    // Present only while the operator's AI-auto-connect switch is on.
    resources: z.array(savedResourceInfoSchema).optional()
  })
);

// ── agent auto-connect settings (operator switch, issue #25) ────────────────

export const agentSettingsGetRequestSchema = z.object({});
export const agentSettingsResultSchema = resultSchema(z.object({ agentAutoConnect: z.boolean() }));
export const agentSettingsSaveRequestSchema = z.object({ agentAutoConnect: z.boolean() });

// ── interface language (operator choice; null = follow DSH's own language) ──

const languageValueSchema = z.enum(["zh", "en"]);
export const languageGetRequestSchema = z.object({});
export const languageResultSchema = resultSchema(z.object({
  language: z.enum(["zh", "en"]).nullable(),
  // When false, the plugin never follows (or writes back) the host language:
  // the stored `language` value is authoritative. Absent means "true" (follow
  // the host), matching the behaviour of installs written before this field.
  autoApplySystemLanguage: z.boolean().optional()
}));
export const languageSaveRequestSchema = z.object({ language: languageValueSchema });

// ── saved SSH resources ────────────────────────────────────────────────────

const profileIdSchema = z.string().uuid();
const groupIdSchema = z.string().uuid();
const credentialIdSchema = z.string().uuid();
export const profileAuthKindSchema = z.enum(["password", "key"]);
// A saved project directory is deliberately an absolute POSIX path.  It is
// passed to SFTP and to the guarded `changeDirectory` RPC, so accepting shell
// syntax, relative paths, or control characters here would create two subtly
// different meanings for one saved value.
const projectDirectorySchema = z.string().min(1).max(1024).refine(
  (path) => path.startsWith("/") && !/[\x00-\x1f\x7f]/.test(path),
  "项目目录必须是绝对路径，且不能包含控制字符" // i18n-ignore: schema-time message, frozen by design
);
// A saved login command replaces the resource's login shell for terminal
// sessions (exec + pty): `bash -l` drops into bash on a zsh-default server.
// Single line only — a saved value containing a newline would make it
// ambiguous what actually runs in the exec request.
const loginCommandSchema = z.string().min(1).max(1024).refine(
  (command) => !/[\x00-\x1f\x7f]/.test(command),
  "登录命令必须是单行命令，不能包含控制字符" // i18n-ignore: schema-time message, frozen by design
);
const legacySavedJumpSchema = z.object({
  host: z.string().min(1).max(255), port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(128), authKind: z.enum(["credential", "password", "key"]).default("credential"), credentialId: credentialIdSchema.optional(),
  hostKeyMode: hostKeyModeSchema.optional()
});
const savedJumpSchema = z.union([z.object({ profileId: profileIdSchema }), legacySavedJumpSchema]);

const profileMetadataSchema = z.object({
  name: z.string().min(1).max(120),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(128),
  authKind: profileAuthKindSchema,
  hostKeyMode: hostKeyModeSchema.default("accept-new"),
  // SSH agent forwarding (resolved false for records saved before this
  // field existed): forward the local ssh-agent so a terminal on this server
  // can authenticate onward with the local keys.
  agentForward: z.boolean().default(false),
  // Upstream SOCKS5 proxy for reaching this server. Optional so records saved
  // before proxy support load unchanged; never carries the password.
  proxy: proxyConfigSchema.optional(),
  // **登录脚本按服务器配置**（用户 2026-10-17 要求，从全局设置迁来）。可选：
  // 老记录没有它就回退到全局设置。结构与设置页那份一致，只是归属每个服务器。
  loginScript: z.object({
    rulesEnabled: z.boolean(),
    rules: z.array(z.object({
      expect: z.string(),
      send: z.string(),
      timeoutMs: z.number().int().min(1000).max(600000).optional()
    })).max(50),
    matchMode: z.enum(["substring", "glob", "regex"]),
    stepTimeoutMs: z.number().int().min(1000).max(600000),
    onTimeout: z.enum(["skip", "strict"]),
    // 登录后执行的远端命令（用户 2026-10-17 增强）：expect/send 规则跑完后逐条发送。
    postCommands: z.array(z.string().min(1).max(2048)).max(100).optional()
  }).nullable().optional()
});

export const profileSaveRequestSchema = profileMetadataSchema.extend({
  profileId: profileIdSchema.optional(),
  groupId: groupIdSchema.nullable().optional(),
  credentialId: credentialIdSchema.nullable().optional(),
  proxyJump: z.array(savedJumpSchema).max(8).optional(),
  defaultProjectPath: projectDirectorySchema.nullable().optional(),
  loginCommand: loginCommandSchema.nullable().optional()
  // The proxy password deliberately does NOT ride in the save request. Like
  // the primary password and jump secrets, the client writes it into the
  // credential store against the proxyPassword ref returned below, so the
  // secret never passes through the profileSave RPC body or its logs.
});

export const profileCredentialRefsSchema = z.object({
  password: z.string(),
  privateKey: z.string(),
  passphrase: z.string(),
  proxyJumpPasswords: z.array(z.string()).optional(),
  proxyJumpPrivateKeys: z.array(z.string()).optional(),
  proxyJumpPassphrases: z.array(z.string()).optional(),
  // Credential-store key for the SOCKS5 proxy password, when one is set.
  proxyPassword: z.string().optional()
});

export const profileInfoSchema = profileMetadataSchema.extend({
  profileId: profileIdSchema,
  groupId: groupIdSchema.nullable(),
  groupName: z.string().nullable(),
  credentialConfigured: z.boolean(),
  passphraseConfigured: z.boolean(),
  // Optional second factor (dual-factor auth): whether the opposite-kind
  // secret is also configured. Resolved to false for records saved before
  // dual-factor support existed.
  secondaryConfigured: z.boolean(),
  connected: z.boolean()
  ,credentialId: credentialIdSchema.nullable(),
  credentialName: z.string().nullable(),
  proxyJump: z.array(savedJumpSchema),
  // Whether a SOCKS5 proxy password is stored; drives the "saved; leave blank
  // to keep" hint. The password itself is never returned.
  proxyCredentialConfigured: z.boolean().optional(),
  defaultProjectPath: projectDirectorySchema.nullable(),
  loginCommand: loginCommandSchema.nullable()
});

const credentialInfoSchema = z.object({ credentialId: credentialIdSchema, name: z.string(), authKind: profileAuthKindSchema, credentialConfigured: z.boolean(), passphraseConfigured: z.boolean(), secondaryConfigured: z.boolean() });
export const credentialListRequestSchema = z.object({});
export const credentialListResultSchema = resultSchema(z.object({ credentials: z.array(credentialInfoSchema) }));
export const credentialSaveRequestSchema = z.object({ credentialId: credentialIdSchema.optional(), name: z.string().min(1).max(120), authKind: profileAuthKindSchema });
export const credentialSaveResultSchema = resultSchema(z.object({ credential: credentialInfoSchema, credentialRefs: profileCredentialRefsSchema }));
export const credentialDeleteRequestSchema = z.object({ credentialId: credentialIdSchema });
export const credentialDeleteResultSchema = resultSchema(z.object({ deleted: z.boolean() }));

export const profileSaveResultSchema = resultSchema(
  z.object({
    profile: profileInfoSchema,
    credentialRefs: profileCredentialRefsSchema
  })
);

export const profileListRequestSchema = z.object({});
export const profileListResultSchema = resultSchema(
  z.object({ profiles: z.array(profileInfoSchema) })
);

export const profileDeleteRequestSchema = z.object({ profileId: profileIdSchema });
export const profileDeleteResultSchema = resultSchema(z.object({ deleted: z.boolean() }));

export const profileDisconnectRequestSchema = z.object({ profileId: profileIdSchema });
export const profileDisconnectResultSchema = resultSchema(z.object({ disconnected: z.number().int().min(0) }));

export const profileConnectRequestSchema = z.object({
  profileId: profileIdSchema,
  /** Join an already-live connection for this saved server when possible. */
  reuseExisting: z.boolean().optional(),
  /** UI connects pass a shorter handshake budget and zero retries to fail fast. */
  readyTimeout: z.number().int().positive().max(120000).optional(),
  retries: z.number().int().min(0).max(5).optional(),
  /** When supplied, override this saved resource's jump chain for one connect only. */
  proxyJumpProfileIds: z.array(profileIdSchema).max(8).optional()
});
export const profileConnectResultSchema = connectResultSchema;

export const cancelProfileConnectRequestSchema = z.object({ profileId: profileIdSchema.optional() });
// **必须用 resultSchema(...) 包装**：实现里确实有 `{ok:false, error}` 分支
// （见 index.js 的 `cancelProfileConnect` 的 catch），而早期这里直接写
// `z.object({ cancelled: … })` —— 于是**错误分支无法被网关编码**：该 RPC 出错时
// 客户端拿不到错误信息，而是编码失败。其余 70 个 RPC 都是 resultSchema 形态，
// 这里是不一致的那一个（由 test/rpc-schema.mjs 的全量契约校验抓到）。
export const cancelProfileConnectResultSchema = resultSchema(
  z.object({ cancelled: z.number().int().min(0) })
);

export const groupInfoSchema = z.object({
  groupId: groupIdSchema,
  name: z.string(),
  profileCount: z.number().int().nonnegative()
});
export const groupListRequestSchema = z.object({});
export const groupListResultSchema = resultSchema(z.object({ groups: z.array(groupInfoSchema) }));
export const groupSaveRequestSchema = z.object({ groupId: groupIdSchema.optional(), name: z.string().min(1).max(80) });
export const groupSaveResultSchema = resultSchema(z.object({ group: groupInfoSchema }));
export const groupDeleteRequestSchema = z.object({ groupId: groupIdSchema });
export const groupDeleteResultSchema = resultSchema(z.object({ deleted: z.boolean(), movedProfiles: z.number().int().nonnegative() }));

// ── select the connection the agent operates on ─────────────────────────────

export const selectConnectionRequestSchema = z.object({
  connectionId: z.string().min(1)
});

export const selectConnectionResultSchema = resultSchema(z.object({
  activeConnectionId: z.string().nullable()
}));

// ── open shell session ──────────────────────────────────────────────────────

export const openSessionRequestSchema = z.object({
  connectionId: z.string().min(1),
  cols: z.number().int().min(2).max(500).optional(),
  rows: z.number().int().min(1).max(200).optional(),
  openedBy: z.enum(["panel", "agent"]).optional()
});

export const sessionInfoSchema = z.object({
  sessionId: z.string(),
  connectionId: z.string(),
  cols: z.number(),
  rows: z.number(),
  alive: z.boolean()
});

export const openSessionResultSchema = resultSchema(sessionInfoSchema);

export const terminalContextSessionSchema = z.object({
  sessionId: z.string(), connectionId: z.string(), name: z.string().optional(), host: z.string(), port: z.number().int(),
  openedAt: z.string(), openedBy: z.enum(["panel", "agent"]), alive: z.boolean(), historyStart: z.number().int().nonnegative(), historyEnd: z.number().int().nonnegative()
});
export const terminalContextListRequestSchema = z.object({});
export const terminalContextListResultSchema = resultSchema(z.object({ sessions: z.array(terminalContextSessionSchema) }));
export const terminalContextReadRequestSchema = z.object({
  sessionId: z.string().min(1), after: z.number().int().nonnegative().safe().optional(), maxBytes: z.number().int().min(1024).max(98304).optional()
});
export const shellIntegrationStateSchema = z.object({
  atPrompt: z.boolean(),
  lastExitCode: z.number().nullable(),
  cwd: z.string().nullable(),
  lastCommandAt: z.string().nullable(),
  commands: z.number().int().nonnegative()
});

export const terminalContextReadResultSchema = resultSchema(z.object({
  sessionId: z.string(), data: z.string(), historyStart: z.number().int().nonnegative(), historyEnd: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative(), wasClamped: z.boolean(), hasMore: z.boolean(), alive: z.boolean(), exit: z.union([z.object({ code: z.number(), signal: z.number().optional() }), z.null()]), redacted: z.boolean(),
  // OSC 133 state when the shell emits it (enableShellIntegration); null before that.
  shell: shellIntegrationStateSchema.nullable()
}));

// ── write ───────────────────────────────────────────────────────────────────

export const writeRequestSchema = z.object({
  sessionId: z.string().min(1),
  data: z.string()
});

export const writeResultSchema = resultSchema(
  z.object({ written: z.number() })
);

// ── agent-originated dangerous command confirmations ──────────────────────

export const pendingConfirmationSchema = z.object({
  confirmationId: z.string().uuid(),
  connectionId: z.string(),
  sessionId: z.string(),
  name: z.string().optional(),
  host: z.string(),
  command: z.string(),
  reason: z.string(),
  createdAt: z.string(),
  prefilled: z.boolean(),
  // 给命令编辑框的人类可读版本（逐行注释 + 原命令，用户 2026-10-19）。
  annotated: z.string().optional()
});

export const pendingConfirmationListRequestSchema = z.object({});
export const pendingConfirmationListResultSchema = resultSchema(
  z.object({ confirmations: z.array(pendingConfirmationSchema) })
);

export const pendingConfirmationActionRequestSchema = z.object({
  confirmationId: z.string().uuid()
});
export const pendingConfirmationApproveResultSchema = resultSchema(
  z.object({ executed: z.literal(true) })
);
export const pendingConfirmationCancelResultSchema = resultSchema(
  z.object({ cancelled: z.literal(true) })
);

// ── known-hosts management (operator only) ──────────────────────────────────

export const knownHostInfoSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  algorithm: z.string(),
  fingerprint: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string()
});

export const listKnownHostsRequestSchema = z.object({});
export const listKnownHostsResultSchema = resultSchema(
  z.object({ hosts: z.array(knownHostInfoSchema) })
);

export const forgetHostKeyRequestSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22)
});
export const forgetHostKeyResultSchema = resultSchema(z.object({ forgotten: z.boolean() }));

// ── read ────────────────────────────────────────────────────────────────────

export const readRequestSchema = z.object({
  sessionId: z.string().min(1),
  timeoutMs: z.number().int().min(0).max(60000).optional(),
  after: z.number().int().nonnegative().safe().optional()
});

// Stream push: one sessionId, endless item stream. Each yielded item reuses
// the read() envelope so the client render path stays identical.
export const terminalStreamRequestSchema = z.object({
  sessionId: z.string().min(1),
  after: z.number().int().nonnegative().safe().optional()
});

export const changeDirectoryRequestSchema = z.object({
  sessionId: z.string().min(1),
  path: z.string().min(1).max(4096).refine((path) => path.startsWith("/") && !/[\x00-\x1f\x7f]/.test(path))
});

export const readResultSchema = resultSchema(
  z.object({
    data: z.string(),
    startOffset: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative().optional(),
    exit: z.union([z.object({ code: z.number(), signal: z.number().optional() }), z.null()])
  })
);

// ── resize ──────────────────────────────────────────────────────────────────

export const resizeRequestSchema = z.object({
  sessionId: z.string().min(1),
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(200)
});

export const resizeResultSchema = resultSchema(
  z.object({ cols: z.number(), rows: z.number() })
);

// ── close session ───────────────────────────────────────────────────────────

export const closeSessionRequestSchema = z.object({
  sessionId: z.string().min(1)
});

export const closeSessionResultSchema = resultSchema(
  z.object({ closed: z.boolean() })
);

// ── disconnect ──────────────────────────────────────────────────────────────

export const disconnectRequestSchema = z.object({
  connectionId: z.string().min(1)
});

export const disconnectResultSchema = resultSchema(
  z.object({ disconnected: z.boolean() })
);

// ── SFTP ────────────────────────────────────────────────────────────────────

const sftpEntrySchema = z.object({
  name: z.string(),
  isDirectory: z.boolean(),
  size: z.number(),
  mtime: z.number(),
  mode: z.number()
});

export const sftpListRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().optional()
});

export const sftpListResultSchema = resultSchema(
  z.object({ path: z.string(), entries: z.array(sftpEntrySchema) })
);

export const sftpStatRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1)
});

export const sftpStatResultSchema = resultSchema(sftpEntrySchema.and(z.object({ path: z.string() })));

export const sftpReadRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1),
  // 16MB：编辑器上限 10MB、图片预览上限 16MB（用户 2026-10-19 定），
  // 两者都走同一个读取入口，这里必须 ≥ 其中较大的那个。
  maxBytes: z.number().int().min(1024).max(16 * 1024 * 1024).optional()
});

export const sftpReadResultSchema = resultSchema(
  z.object({ path: z.string(), data: z.string(), truncated: z.boolean(), bytes: z.number() })
);

export const sftpWriteRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1),
  data: z.string()
});

export const sftpWriteResultSchema = resultSchema(
  z.object({ path: z.string(), bytes: z.number() })
);

// ── SCP fallback (single-file upload/download only) ─────────────────────────

export const scpReadRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1),
  maxBytes: z.number().int().min(1024).max(16 * 1024 * 1024).optional()
});

export const scpReadResultSchema = resultSchema(
  z.object({ path: z.string(), data: z.string(), truncated: z.boolean(), bytes: z.number() })
);

export const scpWriteRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1),
  data: z.string()
});

export const scpWriteResultSchema = resultSchema(
  z.object({ path: z.string(), bytes: z.number() })
);

export const sftpMkdirRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1)
});

export const sftpMkdirResultSchema = resultSchema(
  z.object({ path: z.string() })
);

export const sftpDeleteRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1)
});

export const sftpDeleteResultSchema = resultSchema(
  z.object({ path: z.string(), isDirectory: z.boolean() })
);

export const sftpRenameRequestSchema = z.object({
  connectionId: z.string().optional(),
  from: z.string().min(1),
  to: z.string().min(1)
});

export const sftpRenameResultSchema = resultSchema(
  z.object({ from: z.string(), to: z.string() })
);

export const sftpUploadDirRequestSchema = z.object({
  connectionId: z.string().optional(),
  localPath: z.string().min(1),
  remotePath: z.string().min(1)
});

export const sftpDownloadDirRequestSchema = z.object({
  connectionId: z.string().optional(),
  remotePath: z.string().min(1),
  localPath: z.string().min(1)
});

export const sftpTransferDirResultSchema = resultSchema(
  z.object({
    source: z.string(),
    target: z.string(),
    directories: z.number(),
    files: z.number(),
    bytes: z.number(),
    failed: z.array(z.object({ path: z.string(), error: z.string() }))
  })
);

// ── Port forwarding ──────────────────────────────────────────────────────────

export const tunnelStartLocalRequestSchema = z.object({
  connectionId: z.string().optional(),
  bindAddr: z.string().optional(),
  bindPort: z.number().int().min(0).max(65535).optional(),
  remoteHost: z.string().min(1),
  remotePort: z.number().int().min(1).max(65535)
});

export const tunnelStartDynamicRequestSchema = z.object({
  connectionId: z.string().optional(),
  bindAddr: z.string().optional(),
  bindPort: z.number().int().min(0).max(65535).optional()
});

export const tunnelStartDynamicResultSchema = resultSchema(
  z.object({
    tunnelId: z.string(),
    kind: z.literal("dynamic"),
    bindAddr: z.string(),
    bindPort: z.number()
  })
);

export const tunnelStartLocalResultSchema = resultSchema(
  z.object({
    tunnelId: z.string(),
    kind: z.literal("local"),
    bindAddr: z.string(),
    bindPort: z.number(),
    remoteHost: z.string(),
    remotePort: z.number()
  })
);

export const tunnelStartRemoteRequestSchema = z.object({
  connectionId: z.string().optional(),
  bindAddr: z.string().optional(),
  bindPort: z.number().int().min(0).max(65535).optional(),
  remoteHost: z.string().min(1),
  remotePort: z.number().int().min(1).max(65535),
  targetHost: z.string().min(1),
  targetPort: z.number().int().min(1).max(65535)
});

export const tunnelStartRemoteResultSchema = resultSchema(
  z.object({
    tunnelId: z.string(),
    kind: z.literal("remote"),
    bindAddr: z.string(),
    bindPort: z.number(),
    remoteHost: z.string(),
    remotePort: z.number(),
    targetHost: z.string(),
    targetPort: z.number()
  })
);

export const tunnelStopRequestSchema = z.object({
  connectionId: z.string().optional(),
  tunnelId: z.string().min(1)
});

export const tunnelStopResultSchema = resultSchema(
  z.object({ tunnelId: z.string(), stopped: z.boolean() })
);

export const tunnelListRequestSchema = z.object({
  connectionId: z.string().optional()
});

export const tunnelListResultSchema = resultSchema(
  z.object({
    tunnels: z.array(z.object({
      tunnelId: z.string(),
      kind: z.string(),
      bindAddr: z.string(),
      bindPort: z.number(),
      remoteHost: z.string().optional(),
      remotePort: z.number().optional(),
      targetHost: z.string().optional(),
      targetPort: z.number().optional(),
      /** Dynamic tunnels only: accepted client connections right now. */
      connections: z.number().int().nonnegative().optional(),
      active: z.boolean()
    }))
  })
);

export const enableShellIntegrationRequestSchema = z.object({ sessionId: z.string().min(1) });
export const enableShellIntegrationResultSchema = resultSchema(
  z.object({ sessionId: z.string(), enabled: z.boolean() })
);

// ── session logs (recording) ─────────────────────────────────────────────────

export const sessionLogInfoSchema = z.object({
  sessionId: z.string(),
  connectionId: z.string().nullable(),
  name: z.string().nullable(),
  host: z.string().nullable(),
  port: z.number().nullable(),
  openedBy: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  exitCode: z.number().nullable(),
  bytes: z.number(),
  truncated: z.boolean(),
  // 是否仍在当前进程里录制（用户 2026-10-18：区分「录制中」与「已断开」）。
  live: z.boolean().optional()
});

export const sessionLogListRequestSchema = z.object({});
export const sessionLogListResultSchema = resultSchema(
  z.object({ enabled: z.boolean(), logs: z.array(sessionLogInfoSchema) })
);

export const sessionLogReadRequestSchema = z.object({
  sessionId: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  maxBytes: z.number().int().min(1).max(4194304).optional()
});
export const sessionLogReadResultSchema = resultSchema(
  z.object({
    sessionId: z.string(),
    data: z.string(),
    startOffset: z.number(),
    nextOffset: z.number(),
    eof: z.boolean(),
    size: z.number()
  })
);

// ── 行号行日志（行号视图与按行读取，计划 5.3 / 5.4） ─────────────────────────
export const terminalLineEntrySchema = z.object({ line: z.number().int(), text: z.string() });

export const terminalLinesRequestSchema = z.object({
  sessionId: z.string().min(1),
  // 区间模式：fromLine/toLine 闭区间；tail 模式：只要最后 N 行。两者都给时 tail 优先。
  fromLine: z.number().int().min(1).optional(),
  toLine: z.number().int().min(1).optional(),
  tailLines: z.number().int().min(1).max(2000).optional(),
  maxBytes: z.number().int().min(1).max(4194304).optional()
});

export const terminalLinesResultSchema = resultSchema(
  z.object({
    sessionId: z.string(),
    text: z.string(),
    lines: z.array(terminalLineEntrySchema),
    count: z.number().int(),
    bytes: z.number().int(),
    fromLine: z.number().int(),
    toLine: z.number().int(),
    nextLine: z.number().int(),
    hasMore: z.boolean(),
    // truncated：本次返回被上限截过（含被淘汰）；evicted：请求起点早于保留区。
    truncated: z.boolean(),
    evicted: z.boolean(),
    firstLine: z.number().int(),
    lastLine: z.number().int(),
    totalLines: z.number().int(),
    pendingText: z.string(),
    exit: z.number().nullable()
  })
);

// ── 命令编辑框与命令台账（计划 5.4 / M2） ──────────────────────────────────
export const commandSendRequestSchema = z.object({
  // 二选一：给了 sessionId 用它，否则从 connectionId 找活会话。
  sessionId: z.string().min(1).optional(),
  connectionId: z.string().min(1).optional(),
  text: z.string().min(1),
  pressEnter: z.boolean().optional(),
  source: z.string().optional()
});

export const commandSendResultSchema = resultSchema(
  z.object({
    commandId: z.string(),
    startLine: z.number().int(),
    sent: z.boolean(),
    blocked: z.boolean(),
    // 被危险命令策略拦下时的原因；正常发送为 null。
    reason: z.string().nullable(),
    confirmationId: z.string().nullable()
  })
);

// 远端补全查询（用户 2026-10-18）：只读、不镜像终端、不记台账。
export const commandCompleteRequestSchema = z.object({
  connectionId: z.string().min(1),
  kind: z.enum(["command", "path"]),
  prefix: z.string().max(1024)
});

export const commandCompleteResultSchema = resultSchema(
  z.object({ candidates: z.array(z.string()).max(500) })
);

export const commandRecordSchema = z.object({
  commandId: z.string(),
  sessionId: z.string(),
  connectionId: z.string().nullable(),
  host: z.string().nullable(),
  seq: z.number().int(),
  issuedAt: z.string(),
  source: z.string(),
  text: z.string(),
  redacted: z.boolean(),
  pressEnter: z.boolean(),
  status: z.string(),
  startLine: z.number().int(),
  // null = 尚未闭口；endLine < startLine = 这条命令没有输出行。
  endLine: z.number().int().nullable(),
  exitCode: z.number().int().nullable(),
  closedBy: z.string().nullable(),
  truncated: z.boolean()
});

export const commandListRequestSchema = z.object({
  sessionId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  source: z.string().optional(),
  includeHidden: z.boolean().optional()
});

export const commandListResultSchema = resultSchema(
  z.object({ commands: z.array(commandRecordSchema) })
);

// ── M4 后台任务（计划 5.5.5 / R7）：客户端「日志 → 后台任务」视图要用 ──────
export const taskRecordSchema = z.object({
  taskId: z.string(),
  connectionId: z.string().nullable(),
  host: z.string().nullable(),
  commandId: z.string().nullable(),
  // 命令原文（落库已脱敏，与命令台账一致）
  command: z.string(),
  label: z.string(),
  // 落点：remote-tmp / remote-home / local —— 决定产物到底在哪，必须如实回传
  location: z.string(),
  degraded: z.boolean(),
  warnings: z.array(z.string()),
  remoteDir: z.string().nullable(),
  localDir: z.string().nullable(),
  state: z.string(),
  exitCode: z.number().int().nullable(),
  outBytes: z.number().int(),
  errBytes: z.number().int(),
  startedAt: z.string(),
  finishedAt: z.string().nullable()
});

export const taskListRequestSchema = z.object({
  connectionId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional()
});

export const taskListResultSchema = resultSchema(z.object({ tasks: z.array(taskRecordSchema) }));

// 面板顶部的降级红色告警条：把「正在降级的任务」汇总给 UI（计划 5.5.5 三处告警的第三处）
export const taskDegradedNoticeSchema = z.object({
  taskId: z.string(),
  label: z.string(),
  command: z.string(),
  warnings: z.array(z.string()),
  localDir: z.string().nullable()
});

export const taskDegradedRequestSchema = z.object({});
export const taskDegradedResultSchema = resultSchema(
  z.object({ degraded: z.array(taskDegradedNoticeSchema) })
);

export const taskStatusRequestSchema = z.object({ taskId: z.string().min(1) });
export const taskStatusResultSchema = resultSchema(
  z.object({
    taskId: z.string(),
    state: z.string(),
    location: z.string(),
    degraded: z.boolean(),
    exitCode: z.number().int().nullable(),
    outBytes: z.number().int(),
    errBytes: z.number().int(),
    warnings: z.array(z.string())
  })
);

export const taskReadRequestSchema = z.object({
  taskId: z.string().min(1),
  stream: z.enum(["out", "err", "both"]).optional(),
  fromLine: z.number().int().min(1).optional(),
  toLine: z.number().int().min(1).optional(),
  tailLines: z.number().int().min(1).max(2000).optional()
});

export const taskReadResultSchema = resultSchema(
  z.object({
    taskId: z.string(),
    state: z.string(),
    location: z.string(),
    degraded: z.boolean(),
    text: z.string(),
    lines: z.array(z.object({ line: z.number().int(), stream: z.string(), text: z.string() })),
    totalLines: z.number().int(),
    nextLine: z.number().int(),
    hasMore: z.boolean(),
    warnings: z.array(z.string())
  })
);

export const taskDeleteRequestSchema = z.object({ taskId: z.string().min(1) });
export const taskDeleteResultSchema = resultSchema(
  z.object({ taskId: z.string(), deleted: z.boolean(), location: z.string() })
);


// ── R8 保持活动状态（计划 5.8 / M3.5） ─────────────────────────────────────
// 代理库条目（用户 2026-10-17 要求：代理在设置页统一维护，服务器资源里选择）。
// 密码按明文随库保存（用户 2026-10-18 要求可核对展示）；资源侧的代理密码仍走
// 凭据存放，选择代理时由表单显式带入。
export const proxyLibraryEntrySchema = z.object({
  proxyId: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(128).optional(),
  password: z.string().max(256).optional()
});
export const keepAliveSettingsSchema = z.object({
  sshKeepAliveEnabled: z.boolean(),
  sshKeepAliveIntervalSec: z.number().int(),
  sshKeepAliveCountMax: z.number().int(),
  idleStringEnabled: z.boolean(),
  idleStringIntervalSec: z.number().int(),
  idleStringText: z.string(),
  tcpKeepAliveEnabled: z.boolean(),
  tcpKeepAliveInitialDelaySec: z.number().int(),
  // R9 登录脚本（与保活同一张设置表、同一个读写入口）
  loginScriptRulesEnabled: z.boolean(),
  loginScriptRules: z.array(z.object({
    expect: z.string(),
    send: z.string(),
    timeoutMs: z.number().int().optional()
  })),
  expectMatchMode: z.enum(["substring", "glob", "regex"]),
  expectStepTimeoutMs: z.number().int(),
  onTimeout: z.enum(["skip", "strict"]),
  loginScriptRunEnabled: z.boolean(),
  loginScriptPath: z.string(),
  loginScriptSandbox: z.enum(["restricted", "trusted"]),
  proxyLibrary: z.array(proxyLibraryEntrySchema),
  // 命令框发送规则与可配置快捷键（用户 2026-10-18）。
  sendRule: z.object({ send: z.string(), newline: z.string() }),
  shortcuts: z.array(z.object({
    id: z.string(),
    keys: z.array(z.string()).max(3),
    action: z.string(),
    prompt: z.string().optional()
  })),
  // 鼠标与选择行为（用户 2026-10-18）。
  mouse: z.object({
    middleClickPaste: z.boolean(),
    rightClick: z.enum(["menu", "paste", "none"]),
    autoCopySelection: z.boolean(),
    doubleClickSeparator: z.string(),
    copyIncludeTrailingNewline: z.boolean(),
    copyTrimTrailingWhitespace: z.boolean(),
    copyTabsAsSpaces: z.boolean(),
    urlLinks: z.boolean(),
    urlPrefixes: z.string(),
    ctrlClickOpenLink: z.boolean()
  }),
  // 终端背景图（用户 2026-10-18）。
  terminalBackground: z.object({
    enabled: z.boolean(),
    dataUrl: z.string(),
    maskOpacity: z.number().int(),
    blur: z.number().int(),
    position: z.string(),
    positionX: z.number().int(),
    scale: z.number().int(),
    stretch: z.boolean(),
    // 多图层背景（用户 2026-10-19）：数组顺序即层级（后者在上）。
    images: z.array(z.object({
      id: z.string(),
      dataUrl: z.string(),
      maskOpacity: z.number().int(),
      blur: z.number().int(),
      position: z.string(),
      positionX: z.number().int(),
      scale: z.number().int(),
      stretch: z.boolean()
    }))
  }),
  customPrompts: z.array(z.object({
    id: z.string(),
    title: z.string(),
    prompt: z.string()
  })),
  // 输出提示与会话日志自动清理（用户 2026-10-19）。
  terminalFont: z.object({ family: z.string(), size: z.number().int() }),
  outputWarnKB: z.number().int(),
  sessionLogAutoPruneEnabled: z.boolean(),
  sessionLogMaxTotalMB: z.number().int(),
  sessionLogMaxAgeDays: z.number().int(),
  broadcastHintDismissed: z.boolean(),
  terminalFileLinks: z.boolean(),
  filesFollowTerminal: z.boolean(),
  lastUsername: z.string(),
  wheelZoomEnabled: z.boolean()
});

export const keepAliveGetRequestSchema = z.object({});
export const keepAliveGetResultSchema = resultSchema(keepAliveSettingsSchema);

export const keepAliveSaveRequestSchema = z.object({
  // 全部可选：设置页只发被改动的字段；未知键由 host 白名单忽略。
  sshKeepAliveEnabled: z.boolean().optional(),
  sshKeepAliveIntervalSec: z.number().int().min(5).max(3600).optional(),
  sshKeepAliveCountMax: z.number().int().min(1).max(20).optional(),
  idleStringEnabled: z.boolean().optional(),
  idleStringIntervalSec: z.number().int().min(0).max(3600).optional(),
  idleStringText: z.string().max(4096).optional(),
  tcpKeepAliveEnabled: z.boolean().optional(),
  tcpKeepAliveInitialDelaySec: z.number().int().min(1).max(86400).optional(),
  // R9 登录脚本
  loginScriptRulesEnabled: z.boolean().optional(),
  loginScriptRules: z.array(z.object({
    expect: z.string(),
    send: z.string(),
    timeoutMs: z.number().int().min(1000).max(600000).optional()
  })).max(50).optional(),
  expectMatchMode: z.enum(["substring", "glob", "regex"]).optional(),
  expectStepTimeoutMs: z.number().int().min(1000).max(600000).optional(),
  onTimeout: z.enum(["skip", "strict"]).optional(),
  loginScriptRunEnabled: z.boolean().optional(),
  loginScriptPath: z.string().max(1024).optional(),
  loginScriptSandbox: z.enum(["restricted", "trusted"]).optional(),
  proxyLibrary: z.array(proxyLibraryEntrySchema).max(64).optional(),
  // 命令框发送规则与可配置快捷键（用户 2026-10-18）。
  sendRule: z.object({
    send: z.string().max(64).optional(),
    newline: z.string().max(64).optional()
  }).optional(),
  shortcuts: z.array(z.object({
    id: z.string().min(1).max(64),
    keys: z.array(z.string().min(1).max(32)).min(1).max(3),
    action: z.string().min(1).max(64),
    prompt: z.string().max(4096).optional()
  })).max(64).optional(),
  // 鼠标与选择（用户 2026-10-18）：字段都可选，缺失由 host 归一化补默认。
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
  // 终端背景图（用户 2026-10-18）：字段都可选，缺失由 host 归一化补默认。
  terminalBackground: z.object({
    enabled: z.boolean().optional(),
    dataUrl: z.string().optional(),
    maskOpacity: z.number().int().min(0).max(100).optional(),
    blur: z.number().int().min(0).max(20).optional(),
    position: z.string().max(24).optional(),
    positionX: z.number().int().min(0).max(100).optional(),
    scale: z.number().int().min(10).max(400).optional(),
    stretch: z.boolean().optional(),
    images: z.array(z.object({
      id: z.string().max(64).optional(),
      dataUrl: z.string(),
      maskOpacity: z.number().int().min(0).max(100).optional(),
      blur: z.number().int().min(0).max(20).optional(),
      position: z.string().optional(),
      positionX: z.number().int().min(0).max(100).optional(),
      scale: z.number().int().min(10).max(400).optional(),
      stretch: z.boolean().optional()
    })).max(8).optional()
  }).optional(),
  customPrompts: z.array(z.object({
    id: z.string().min(1).max(64),
    title: z.string().max(80),
    prompt: z.string().max(4096)
  })).max(64).optional(),
  // 输出提示与会话日志自动清理（用户 2026-10-19）。
  terminalFont: z.object({
    family: z.string().max(200).optional(),
    size: z.number().int().min(8).max(32).optional()
  }).optional(),
  outputWarnKB: z.number().int().min(0).max(10240).optional(),
  sessionLogAutoPruneEnabled: z.boolean().optional(),
  sessionLogMaxTotalMB: z.number().int().min(50).max(102400).optional(),
  sessionLogMaxAgeDays: z.number().int().min(0).max(3650).optional(),
  broadcastHintDismissed: z.boolean().optional(),
  terminalFileLinks: z.boolean().optional(),
  filesFollowTerminal: z.boolean().optional(),
  lastUsername: z.string().optional(),
  wheelZoomEnabled: z.boolean().optional()
});

export const keepAliveSaveResultSchema = resultSchema(
  keepAliveSettingsSchema.extend({ reconnectRequired: z.boolean() })
);

export const keepAliveTestRequestSchema = z.object({ connectionId: z.string().min(1).optional() });

export const keepAliveCheckSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string()
});

export const keepAliveTestResultSchema = resultSchema(
  z.object({
    connectionId: z.string(),
    host: z.string(),
    enabled: z.boolean(),
    wouldSend: z.boolean(),
    // 没在发时给 null，而不是编一个假时间（排障信息必须诚实）。
    nextSendAt: z.string().nullable(),
    checks: z.array(keepAliveCheckSchema),
    sshKeepAlive: z.object({ enabled: z.boolean(), intervalSec: z.number().int(), countMax: z.number().int() }),
    tcpKeepAlive: z.object({ enabled: z.boolean(), initialDelaySec: z.number().int() })
  })
);

export const connectOptionsPreviewRequestSchema = z.object({ connectionId: z.string().min(1).optional() });

export const connectOptionsPreviewResultSchema = resultSchema(
  z.object({
    connectionId: z.string(),
    host: z.string(),
    port: z.number().int(),
    username: z.string(),
    keepaliveInterval: z.number().int(),
    keepaliveCountMax: z.number().int(),
    idleString: z.object({ enabled: z.boolean(), intervalSec: z.number().int(), textLength: z.number().int() }).nullable(),
    tcpKeepAlive: z.object({ enabled: z.boolean(), initialDelaySec: z.number().int() }),
    loginScript: z.object({ rulesEnabled: z.boolean(), ruleCount: z.number().int(), runEnabled: z.boolean(), path: z.string() }),
    hasLiveSession: z.boolean()
  })
);

export const sessionLogSearchRequestSchema = z.object({
  sessionId: z.string().min(1),
  query: z.string().min(1),
  maxHits: z.number().int().min(1).max(1000).optional()
});
export const sessionLogSearchResultSchema = resultSchema(
  z.object({
    sessionId: z.string(),
    hits: z.array(z.object({ offset: z.number(), line: z.string() })),
    scannedBytes: z.number(),
    stoppedEarly: z.boolean()
  })
);

export const sessionLogDeleteRequestSchema = z.object({ sessionId: z.string().min(1).optional() });
export const sessionLogDeleteResultSchema = resultSchema(
  z.object({ deleted: z.number(), remaining: z.number() })
);

// ── batch exec (profile-selected, operator-confirmed) ────────────────────────

export const batchPlanRequestSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().min(1000).max(120000).optional()
});

export const batchTaskSchema = z.object({
  batchId: z.string(),
  command: z.string(),
  timeoutMs: z.number(),
  dangerous: z.boolean(),
  reason: z.string().nullable(),
  createdAt: z.string()
});

export const batchPlanResultSchema = resultSchema(z.object({ task: batchTaskSchema }));

export const batchTaskListRequestSchema = z.object({});
export const batchTaskListResultSchema = resultSchema(z.object({ tasks: z.array(batchTaskSchema) }));

export const batchRunRequestSchema = z.object({
  batchId: z.string(),
  profileIds: z.array(z.string()).min(1)
});

export const batchRunResultSchema = resultSchema(
  z.object({
    results: z.array(
      z.object({
        profileId: z.string(),
        name: z.string(),
        host: z.string(),
        ok: z.boolean(),
        exitCode: z.union([z.number(), z.null()]),
        stdout: z.string(),
        stderr: z.string(),
        error: z.string().nullable()
      })
    )
  })
);

export const batchCancelRequestSchema = z.object({ batchId: z.string() });
export const batchCancelResultSchema = resultSchema(z.object({ cancelled: z.boolean() }));
