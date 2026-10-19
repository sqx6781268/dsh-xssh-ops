/**
 * Agent tool for SSH resource management (用户 2026-10-19：AI 此前没有任何
 * 添加/保存 SSH 资源的入口，profileSave 一族只暴露给 Web UI RPC)。
 *
 *   - `xssh_resource`  ← list / save / delete？不 —— list / save 两个 op。
 *
 * 边界（与操作员对齐）：
 *   - op=list    列出已保存资源（坐标 + 凭据配置状态，不含任何秘密）。
 *   - op=save    新建/更新资源。密码、私钥、passphrase、代理密码经
 *                credentials.set 写入凭据存储（与 UI 同一机制、同一 ref 约定），
 *                **绝不**进 profileSave 请求体 —— 服务端 schema 本就如此设计
 *                （schemas.js profileSaveRequestSchema 注释）。
 *   - 删除不提供：资源是操作员的决策面，AI 误删的代价不可逆（profileDelete
 *                会连带 unset 全部凭据）。需要删请在右侧面板操作。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { t } from "../i18n/core.js";
import { profileSaveRequestSchema } from "../schemas.js";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

function assertOp(tool, op, allowed) {
  if (!allowed.includes(op)) {
    throw new Error(`${tool} failed: unknown op "${op}"; use one of ${allowed.join(" | ")}`);
  }
}

export function registerResourceTools(ctx, service) {
  ctx.tools.register(defineTool({
    name: "xssh_resource",
    description: "Manage saved SSH resources (server profiles). op='list' (default) lists saved resources with coordinates and credential status — no secrets are ever returned. op='save' creates or updates a resource: give at least name/host/username/authKind; password, private_key, passphrase and proxy_password are written into the credential store (never into the profile record or its logs), mirroring exactly what the operator's UI save path does. Deleting resources is operator-only: it is not offered here on purpose.",
    parameters: {
      op: { type: "string", enum: ["list", "save"], required: true, description: "list (default) | save." },
      profile_id: { type: "string", description: "save: profile id to UPDATE an existing resource; omit to create a new one." },
      name: { type: "string", description: "save: display name (required)." },
      host: { type: "string", description: "save: host or IP (required)." },
      port: { type: "integer", description: "save: SSH port, defaults to 22." },
      username: { type: "string", description: "save: login user (required)." },
      auth_kind: { type: "string", enum: ["password", "key"], description: "save: authentication kind (required)." },
      password: { type: "string", description: "save: password to store when auth_kind=password (goes to the credential store, not the profile record)." },
      private_key: { type: "string", description: "save: PEM private key to store when auth_kind=key (credential store)." },
      passphrase: { type: "string", description: "save: key passphrase (credential store)." },
      proxy: { type: "object", additionalProperties: false, properties: {
        host: { type: "string" },
        port: { type: "integer" },
        username: { type: "string" }
      }, description: "save: upstream SOCKS5 proxy (type is fixed to socks5)." },
      proxy_password: { type: "string", description: "save: SOCKS5 proxy password (credential store)." },
      group_id: { type: "string", description: "save: group id to file the resource under." },
      host_key_mode: { type: "string", enum: ["accept-new", "strict", "any"], description: "save: host-key verification mode, defaults to accept-new." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          op: { type: "string" },
          profiles: { type: "array", items: { type: "object", additionalProperties: true } },
          profile: { type: "object", additionalProperties: true },
          created: { type: "boolean" }
        }
      },
      render(args, value) {
        if (args.op === "save") {
          const p = value.profile ?? {};
          const flags = [
            p.credentialConfigured ? t("凭据已保存") : t("凭据未配置"),
            p.proxy ? `${t("代理")} ${p.proxy.host}:${p.proxy.port}` : null,
            p.proxyCredentialConfigured ? t("代理密码已存") : null
          ].filter(Boolean).join(" ");
          const action = value.created ? t("创建") : t("更新");
          return [{ type: "text", text: t(`资源已${action}：${p.name}（${p.username}@${p.host}:${p.port}，id: ${p.profileId}；${flags}）`) }];
        }
        const lines = (value.profiles ?? []).map((p) => {
          const flags = [p.credentialConfigured ? "✓" : "✗", p.proxy ? `proxy ${p.proxy.host}:${p.proxy.port}` : null, p.connected ? t("· 已连接") : null].filter(Boolean).join(" ");
          return `- ${p.name}  ${p.username}@${p.host}:${p.port}  auth=${p.authKind} [${flags}]  id=${p.profileId}`;
        });
        return [{ type: "text", text: t(`已保存的资源（${lines.length}）：`) + (lines.length ? "\n" + lines.join("\n") : "") }];
      }
    },
    async execute(args) {
      const op = args.op ?? "list";
      assertOp("xssh_resource", op, ["list", "save"]);
      if (op === "list") {
        const result = await service.profileList();
        if (!result.ok) throw new Error(`xssh_resource failed: ${result.error.message}`);
        return { op, profiles: result.value.profiles };
      }

      // ── op=save ──
      if (!args.name || !args.host || !args.username || !args.auth_kind) {
        throw new Error("xssh_resource save failed: name, host, username and auth_kind are required (omit password/private_key to keep an existing resource's stored credentials)");
      }
      // profileSaveRequestSchema 校验其余字段；proxy 按服务端约定补 type。
      const request = profileSaveRequestSchema.parse({
        ...(args.profile_id ? { profileId: args.profile_id } : {}),
        name: args.name,
        host: args.host,
        ...(args.port !== undefined ? { port: args.port } : {}),
        username: args.username,
        authKind: args.auth_kind,
        ...(args.host_key_mode ? { hostKeyMode: args.host_key_mode } : {}),
        ...(args.group_id !== undefined ? { groupId: args.group_id } : {}),
        ...(args.proxy && args.proxy.host ? { proxy: { type: "socks5", host: args.proxy.host, port: args.proxy.port ?? 1080, ...(args.proxy.username ? { username: args.proxy.username } : {}) } } : {})
      });
      const saved = await service.profileSave(request);
      if (!saved.ok) throw new Error(`xssh_resource save failed: ${saved.error.message}`);
      const { profile, credentialRefs } = saved.value;

      // 秘密写凭据存储 —— 与 UI 保存路径（SshResources.jsx credentialWrite）
      // 完全相同的 ref。只在有值时写；更新场景留空 = 保留原值。
      const storeSecret = async (ref, value) => {
        if (!value) return;
        const response = await service.ctx.credentials.set(credentialRef(ref), value);
        if (response && response.ok === false) throw new Error(`xssh_resource save failed: ${response.error?.message ?? "credential store rejected the secret"}`);
      };
      try {
        const primaryRef = args.auth_kind === "password" ? credentialRefs.password : credentialRefs.privateKey;
        await storeSecret(primaryRef, args.auth_kind === "password" ? args.password : args.private_key);
        await storeSecret(credentialRefs.passphrase, args.passphrase);
        if (credentialRefs.proxyPassword) await storeSecret(credentialRefs.proxyPassword, args.proxy_password);
      } catch (error) {
        // 凭据写失败：资源记录已落库。如实报错并附上回滚指引，不假装成功。
        await service.profileDelete({ profileId: profile.profileId }).catch(() => {});
        throw new Error(`xssh_resource save failed: credential store rejected the secret (${error.message}); the half-saved profile was rolled back`);
      }
      const after = await service.profilePublic(profile.profileId, service.requireProfileTable().get(profile.profileId));
      return { op, profile: after, created: !args.profile_id };
    }
  }));
}
