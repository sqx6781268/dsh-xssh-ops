/**
 * Agent tools for the SSH session lifecycle (R10 工具面瘦身：同类合并)。
 *
 * 入口 13 个工具的设计见 需求与实施计划 R10：核心常驻 7（connect / connection /
 * exec / read / write / command / exec_background）+ 功能包 6。本文件承载连接族：
 *   - `xssh_connect`     ← connect + connect_profile + proxy_test（target / proxy_probe）
 *   - `xssh_connection`  ← list + disconnect（op）
 *   - `xssh_exec`        保留（契约差异大）
 *   - `xssh_read`        ← read + terminal_read（mode: full | lines）
 *   - `xssh_write`       保留
 *
 * 约束（R10）：内部 service 不动，只合并入口；op 非法时点名可用值。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { t } from "../i18n/core.js";
import { redactForModel } from "../redact.js";
import { toReadableText } from "../terminal-text.js";

const MAX_READ_BYTES = 48 * 1024;
const DEFAULT_MAX_BYTES = 24 * 1024;
const DEFAULT_TAIL_LINES = 50;

function clampBytes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_MAX_BYTES;
  return Math.min(Math.floor(numeric), MAX_READ_BYTES);
}

/** op 不支持时点名可用值（R10 约束：防智能体猜参数浪费轮次）。 */
function assertOp(tool, op, allowed) {
  if (!allowed.includes(op)) {
    throw new Error(`${tool} failed: unknown op "${op}"; use one of ${allowed.join(" | ")}`);
  }
}

export function registerSshSessionTools(ctx, service) {
  ctx.tools.register(defineTool({
    name: "xssh_connect",
    description: "Connect to a remote server over SSH and make it the current connection for later SSH tools (xssh_exec/xssh_read/xssh_write/xssh_command). Two ways to connect: give `target` (a saved resource name or profile id from xssh_connection op='list') — only works when the operator allowed automatic connecting to saved servers; or give `host` + `username` + `auth` for a direct connection. Set `proxy_probe: true` (with proxy + target_host) to probe a SOCKS5 proxy WITHOUT logging in: it returns reachable/banner/latency or a coded failure reason instead of connecting.",
    parameters: {
      target: { type: "string", description: "Saved SSH resource name (e.g. 'dev', 'prod') or profile id. When given without host, connects that resource and opens its terminal." },
      host: { type: "string", description: "Remote hostname or IP address (direct connection). Required when target is omitted." },
      port: { type: "integer", description: "SSH port, defaults to 22." },
      username: { type: "string", description: "SSH username (direct connection)." },
      auth: {
        type: "object",
        additionalProperties: false,
        description: "Authentication for a direct connection. Either {kind: 'password', password} or {kind: 'key', privateKey, passphrase?}.",
        properties: {
          kind: { type: "string", enum: ["password", "key"], required: true },
          password: { type: "string" },
          privateKey: { type: "string" },
          passphrase: { type: "string" }
        }
      },
      legacy: { type: "boolean", description: "Only for old network devices (Huawei legacy VRP e.g. S12712, some old IOS/Comware) that offer no modern SSH key exchange. Omit it and the plugin retries automatically once if the handshake fails on key-exchange selection, returning legacyFallback. Pass true to use the legacy algorithm set immediately, or false to forbid the automatic retry." },
      name: { type: "string", description: "Optional display name for this connection." },
      proxy: {
        type: "object",
        additionalProperties: false,
        description: "Optional upstream SOCKS5 proxy (or the proxy to probe with proxy_probe).",
        properties: {
          type: { type: "string", enum: ["socks5"], required: true },
          host: { type: "string", required: true, description: "SOCKS5 proxy hostname or IP." },
          port: { type: "integer", required: true, description: "SOCKS5 proxy port (commonly 1080)." },
          username: { type: "string", description: "Username for username/password SOCKS5 auth; omit for no-auth." },
          password: { type: "string", description: "Password for username/password SOCKS5 auth." }
        }
      },
      proxy_probe: { type: "boolean", description: "When true, only probe the SOCKS5 proxy: no SSH handshake, no login, no saved connection. Returns reachable + banner + elapsedMs, or reachable=false with a coded reason." },
      target_host: { type: "string", description: "proxy_probe only: the host the proxy should CONNECT to." },
      target_port: { type: "integer", description: "proxy_probe only: the port the proxy should CONNECT to; defaults to 22." },
      timeout_ms: { type: "integer", description: "proxy_probe only: handshake deadline in ms (1000..15000), default 10000." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectionId: { type: "string" },
          profileId: { type: "string" },
          name: { type: "string" },
          host: { type: "string" },
          port: { type: "integer" },
          username: { type: "string" },
          legacyFallback: { type: "boolean" },
          bannerRepair: { type: "boolean" },
          reused: { type: "boolean" },
          terminalOpened: { type: "boolean" },
          warning: { type: "string" },
          reachable: { type: "boolean" },
          proxyHost: { type: "string" },
          proxyPort: { type: "integer" },
          targetHost: { type: "string" },
          targetPort: { type: "integer" },
          authenticated: { type: "boolean" },
          banner: { type: "string" },
          elapsedMs: { type: "integer" },
          errorCode: { type: "string" },
          reason: { type: "string" },
          message: { type: "string" },
          hints: { type: "array", items: { type: "string" } }
        }
      },
      render(args, value) {
        if (args.proxy_probe === true) {
          const proxy = `${value.proxyHost ?? "?"}:${value.proxyPort ?? "?"}`;
          const target = `${value.targetHost ?? "?"}:${value.targetPort ?? "?"}`;
          if (value.reachable) {
            const head = `${t("SOCKS5 代理可连通目标")} (${proxy} -> ${target}, ${value.elapsedMs ?? 0}ms).`;
            const bannerLine = value.banner
              ? `\n${t("对端首行")}: ${value.banner}`
              : `\n${t("隧道已连通，但对端未在探测窗口内主动发送首行（非 SSH 服务也属正常）")}`;
            return [{ type: "text", text: head + bannerLine }];
          }
          const head = `${t("SOCKS5 代理无法连通目标")} (${proxy} -> ${target}, ${value.errorCode ?? "error"}, ${value.elapsedMs ?? 0}ms).\n${value.message ?? ""}`;
          const hintLines = Array.isArray(value.hints) && value.hints.length > 0
            ? `\n${t("建议")}:\n` + value.hints.map((hint) => `- ${hint}`).join("\n")
            : "";
          return [{ type: "text", text: head + hintLines }];
        }
        if (value.profileId !== undefined) {
          const base = t(`已连接保存的服务器「${value.name}」（${value.username}@${value.host}:${value.port}，id: ${value.connectionId}），并已设为当前 SSH 连接，后续 xssh_exec 等工具默认作用于这台机器。${value.reused ? t("复用了该服务器已有的连接。") : ""}${value.terminalOpened ? t("已为它打开终端会话（可在右侧 SSH 面板查看该机器）。") : ""}`);
          return [{ type: "text", text: value.warning ? `${base}\n⚠️ ${value.warning}` : base }];
        }
        const base = `Connected ${value.username ?? "?"}@${value.host ?? "?"} (id: ${value.connectionId ?? "?"})`;
        return [{ type: "text", text: value.warning ? `${base}\n⚠️ ${value.warning}` : base }];
      }
    },
    async execute(args) {
      // 1) 代理探测：不建立 SSH。
      if (args.proxy_probe === true) {
        if (args.proxy === undefined || args.target_host === undefined) {
          throw new Error("xssh_connect failed: proxy_probe requires proxy and target_host");
        }
        const result = await service.proxyTest({
          proxy: args.proxy,
          target: { host: args.target_host, port: args.target_port ?? 22 },
          timeoutMs: args.timeout_ms
        });
        if (!result.ok) throw new Error(`xssh_connect failed: ${result.error.message}`);
        return result.value;
      }
      // 2) 已保存资源：给了 target 且没有 host。
      const target = typeof args.target === "string" ? args.target.trim() : "";
      if (target !== "" && (args.host === undefined || args.host === "")) {
        const result = await service.agentConnectProfile({ resource: target });
        if (!result.ok) throw new Error(`xssh_connect failed: ${result.error.message}`);
        return result.value;
      }
      // 3) 直连。
      if (args.host === undefined || args.username === undefined || args.auth === undefined) {
        throw new Error("xssh_connect failed: give target (a saved resource) or host + username + auth (direct connection)");
      }
      const result = await service.connect({
        host: args.host,
        port: args.port,
        username: args.username,
        auth: args.auth,
        legacy: args.legacy,
        name: args.name,
        ...(args.proxy ? { proxy: args.proxy } : {})
      });
      if (!result.ok) throw new Error(`xssh_connect failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "xssh_connection",
    description: "Inspect or close connections. op='list' (default) reports open SSH connections, the active server, and — when the operator allowed automatic connecting to saved servers — the saved resources (name/host/username/connected) so you can pick one for xssh_connect target. op='disconnect' closes the current connection and its shell sessions (omit connection_id for the current one). Neither op returns credentials.",
    parameters: {
      op: { type: "string", enum: ["list", "disconnect"], required: true, description: "list (default) | disconnect." },
      connection_id: { type: "string", description: "disconnect only: connection to close; defaults to the current right-side SSH connection." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          activeConnectionId: { oneOf: [{ type: "string" }, { type: "null" }] },
          connections: { type: "array", items: { type: "object", additionalProperties: true } },
          resources: { type: "array", items: { type: "object", additionalProperties: true } },
          agentAutoConnect: { type: "boolean" },
          disconnected: { type: "boolean" }
        }
      },
      render(args, value) {
        if (args.op === "disconnect") {
          return [{ type: "text", text: value.disconnected ? "Disconnected." : "Connection not found." }];
        }
        const lines = [];
        if (Array.isArray(value.resources)) {
          const saved = value.resources.map((item) => `  - ${item.name} (${item.username ?? "?"}@${item.host ?? "?"})${item.connected ? t(" · 已连接") : ""}`);
          lines.push(t(`已保存的服务器（${value.resources.length}）：`) + (saved.length ? "\n" + saved.join("\n") : ""));
        }
        if (Array.isArray(value.connections) && value.connections.length > 0) {
          lines.push(value.connections.map((conn) => `${conn.connectionId}  ${conn.name ?? ""}  ${conn.username ?? "?"}@${conn.host ?? "?"}:${conn.port ?? "?"}${conn.connectionId === value.activeConnectionId ? "  ← active" : ""}`).join("\n"));
        } else {
          lines.push(t("(no open connections)"));
        }
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args) {
      const op = args.op ?? "list";
      assertOp("xssh_connection", op, ["list", "disconnect"]);
      if (op === "disconnect") {
        const result = await service.disconnectCurrentConnection({ connectionId: args.connection_id });
        if (!result.ok) throw new Error(`xssh_connection failed: ${result.error.message}`);
        return result.value;
      }
      // 服务实现的列表方法叫 list()（async）；上游 fork 时这里还留着旧名 listConnections，
      // 导致 op=list（默认分支）必定报 service.listConnections is not a function。
      const result = await service.list();
      if (!result.ok) throw new Error(`xssh_connection failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "xssh_exec",
    description: "Run a normal SSH command on the server currently open in the right-side SSH terminal and return its output. Omit connection_id when the user means the current server; do not call xssh_connection first. On Linux with one identifiable idle POSIX terminal shell, the dedicated exec channel starts in that shell's verified current directory. A busy, ambiguous, or inaccessible terminal directory rejects the command instead of guessing; when no terminal shell is detectable, the normal login directory is used and cwd is null. SSH configuration, package changes, service reloads, and config edits are allowed and remain subject to DSH permissions. Explicitly destructive or irreversible operations are not run: a confirmation popup appears in the right-side SSH panel, where only the operator can execute or cancel them. The command and output are also shown in the terminal panel.",
    parameters: {
      connection_id: { type: "string", description: "Optional. Omit to target the current right-side SSH connection." },
      command: { type: "string", required: true, description: "The shell command to execute." },
      timeout_ms: { type: "integer", description: "Timeout in milliseconds, defaults to 30000." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectionId: { type: "string", required: true },
          host: { type: "string", required: true },
          exitCode: { oneOf: [{ type: "integer" }, { type: "null" }], required: true },
          stdout: { type: "string", required: true },
          stderr: { type: "string", required: true },
          cwd: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
          commandId: { type: "string", required: true },
          startedAt: { type: "string", required: true },
          finishedAt: { type: "string", required: true },
          durationMs: { type: "integer", required: true },
          truncated: { type: "boolean", required: true },
          timedOut: { type: "boolean", required: true },
          redacted: { type: "boolean", required: true },
          blocked: { type: "boolean" },
          reason: { type: "string" },
          command: { type: "string" },
          annotated: { type: "string" },
          prefilled: { type: "boolean" },
          queued: { type: "boolean" }
        }
      },
      render(args, value) {
        if (value.blocked) {
          const where = value.queued
            ? t("命令未执行；右侧 SSH 终端面板已弹出确认卡片，等待操作员点击“执行”或“撤销”：")
            : t("命令未执行，无法预填，请粘贴到右侧终端执行：");
          const whereRuns = t("确认执行（或粘贴执行）发生在右侧交互 shell 内，跟随终端当前目录；与 xssh_exec 的 exec 通道目录无关。命令里的相对路径请按此理解。");
          return [{ type: "text", text: t(`⚠️ 已拦截：${value.reason ?? ""}\n${where}\n\`\`\`bash\n${value.command ?? ""}\n\`\`\`\n${whereRuns}\n请勿重试/绕行，由人工确认执行。`) }];
        }
        const out = value.stdout ?? "";
        const err = value.stderr ?? "";
        let body = out;
        if (err.length > 0) {
          if (body.length > 0 && !body.endsWith("\n")) body += "\n";
          body += `[stderr]\n${err}`;
        }
        if (body.length === 0) body = "(no output)";
        if (value.exitCode !== null && value.exitCode !== 0) body += `\n[exit code: ${value.exitCode}]`;
        if (value.timedOut) body += "\n[command timed out]";
        if (value.truncated) body += "\n[output truncated for safe model context]";
        if (value.redacted) body += "\n[sensitive values redacted]";
        const cwdNote = value.cwd
          ? `[cwd: ${value.cwd}]`
          : "[cwd: login directory — no interactive shell directory detected]";
        return [{ type: "text", text: `${cwdNote}\n${body}` }];
      }
    },
    async execute(args) {
      const result = await service.executeCommand({
        connectionId: args.connection_id,
        command: args.command,
        timeoutMs: args.timeout_ms ?? 30000
      });
      if (!result.ok) throw new Error(`xssh_exec failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "xssh_read",
    description: "Read from the current right-side SSH terminal. mode='full' (default) returns the buffered capture of the interactive shell (use after xssh_write, or when the user typed something in the panel). mode='lines' returns the numbered line journal instead: give from_line/to_line for a range, or tail_lines (default 50) for the newest lines (`0812 │ ...`); line numbers never change once issued. CHECK truncated/evicted: with mode='lines', evicted=true means older lines are gone for good. Content is redacted.",
    parameters: {
      connection_id: { type: "string", description: "Optional. Omit to target the current right-side SSH connection." },
      mode: { type: "string", enum: ["full", "lines"], description: "full (default) = buffered terminal capture; lines = numbered line journal." },
      from_line: { type: "integer", description: "lines mode: first line of the range (1-based); use with to_line." },
      to_line: { type: "integer", description: "lines mode: last line of the range (inclusive)." },
      tail_lines: { type: "integer", description: `lines mode: newest N lines when no range is given; defaults to ${DEFAULT_TAIL_LINES}.` },
      command_id: { type: "string", description: "Read one command's output by the id returned from xssh_write (or a ledger id). The host waits for the command to close (exit/idle) and then returns its line range — no manual sleep needed." },
      wait_ms: { type: "integer", description: "command_id mode: how long to wait for the command to close, defaults to 15000, max 60000." },
      max_bytes: { type: "integer", description: `lines mode: response size cap; defaults to ${DEFAULT_MAX_BYTES}, hard limit ${MAX_READ_BYTES}.` }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectionId: { type: "string" },
          host: { type: "string" },
          view: { type: "string" },
          data: { type: "string" },
          hasSession: { type: "boolean" },
          text: { type: "string" },
          lines: { type: "array", items: { type: "object", additionalProperties: true } },
          firstLine: { type: "number" },
          lastLine: { type: "number" },
          totalLines: { type: "number" },
          nextLine: { type: "number" },
          truncated: { type: "boolean" },
          evicted: { type: "boolean" },
          redacted: { type: "boolean" },
          commandId: { type: "string" },
          status: { type: "string" },
          exitCode: { type: "integer" },
          closedBy: { type: "string" },
          timedOut: { type: "boolean" }
        }
      },
      render(args, value) {
        if (value.view === "command") {
          const head = `${value.commandId} · ${value.status}${value.exitCode === null || value.exitCode === undefined ? "" : ` (exit ${value.exitCode})`}${value.timedOut ? t(" · 等待超时（命令可能还在跑）") : ""}${value.closedBy ? ` · closedBy=${value.closedBy}` : ""}`;
          const body = value.text === "" ? t("（无输出）") : value.text;
          return [{ type: "text", text: `${head}\n${body}` }];
        }
        const mode = args.mode === "lines" ? "lines" : "full";
        if (mode === "full") {
          const body = value.hasSession === false
            ? "(no open shell session on this connection)"
            : value.data || "(no output yet)";
          const notes = [
            value.truncated ? "[terminal capture truncated]" : "",
            value.redacted ? "[sensitive values redacted]" : ""
          ].filter(Boolean);
          return [{ type: "text", text: notes.length > 0 ? `${body}\n${notes.join("\n")}` : body }];
        }
        const head = `${value.host ?? "?"} · ${t(`第 ${value.firstLine}–${value.lastLine} 行 / 保留 ${value.totalLines} 行`)}`;
        const flags = [
          value.evicted ? t("⚠️ 更早的行已被淘汰") : "",
          value.truncated && !value.evicted ? t("⚠️ 本次返回被上限截断") : ""
        ].filter(Boolean).join("  ");
        const body = value.text === "" ? t("（无输出）") : value.text;
        return [{ type: "text", text: `${head}${flags === "" ? "" : `  ${flags}`}\n${body}` }];
      }
    },
    async execute(args) {
      if (typeof args.command_id === "string" && args.command_id !== "") {
        const output = await service.readCommandOutput({
          commandId: args.command_id,
          waitMs: args.wait_ms,
          maxBytes: clampBytes(args.max_bytes)
        });
        if (!output.ok) throw new Error(`xssh_read failed: ${output.error.message}`);
        const safe = redactForModel(output.value.text ?? "");
        return { ...output.value, view: "command", text: safe.text, redacted: safe.redacted };
      }
      const mode = args.mode === "lines" ? "lines" : "full";
      if (mode === "full") {
        const result = service.readCurrentConnection({ connectionId: args.connection_id });
        if (!result.ok) throw new Error(`xssh_read failed: ${result.error.message}`);
        // 全量捕获同时给出可读化文本（旧 xterm 视图的语义），避免 ANSI 转义
        // 把模型的输出搞乱；data 仍保留原始捕获，便于按需对照。
        const safe = redactForModel(toReadableText(result.value.data ?? ""));
        return {
          ...result.value,
          view: "full",
          text: safe.text,
          lines: [],
          redacted: result.value.redacted === true || safe.redacted
        };
      }
      const target = service.terminalLinesFor(args.connection_id);
      if (!target.ok) throw new Error(`xssh_read failed: ${target.error.message}`);
      const hasRange = Number.isSafeInteger(args.from_line) || Number.isSafeInteger(args.to_line);
      const read = service.readTerminalLines({
        sessionId: target.value.sessionId,
        fromLine: Number.isSafeInteger(args.from_line) ? args.from_line : undefined,
        toLine: Number.isSafeInteger(args.to_line) ? args.to_line : undefined,
        tailLines: hasRange ? undefined : (Number.isSafeInteger(args.tail_lines) ? args.tail_lines : DEFAULT_TAIL_LINES),
        maxBytes: clampBytes(args.max_bytes)
      });
      if (!read.ok) throw new Error(`xssh_read failed: ${read.error.message}`);
      const value = read.value;
      const safe = redactForModel(value.text);
      return {
        connectionId: target.value.connectionId,
        host: target.value.host,
        view: "lines",
        text: safe.text,
        lines: value.lines.map((entry) => ({ line: entry.line, text: redactForModel(entry.text).text })),
        firstLine: value.firstLine,
        lastLine: value.lastLine,
        totalLines: value.totalLines,
        nextLine: value.nextLine,
        truncated: value.truncated,
        evicted: value.evicted,
        redacted: safe.redacted
      };
    }
  }));

  ctx.tools.register(defineTool({
    name: "xssh_write",
    description: "Send input into a right-side SSH terminal and, by default, press Enter afterwards so the input is submitted like a human typing Enter (a carriage return \\r is appended unless the input already ends with a newline). Omit connection_id to target the current/active terminal; provide connection_id to target a specific server's terminal. If the target connection has no open terminal, one is opened automatically so the input is never silently dropped. Normal operations are permitted through DSH permissions; explicitly destructive or irreversible commands are stopped before agent execution. Ctrl-C remains available to cancel an in-progress command.",
    parameters: {
      connection_id: { type: "string", description: "Optional. Omit to target the current/active terminal; specify to target that server's terminal (e.g. from xssh_connect/xssh_connection)." },
      input: { type: "string", required: true, description: "The input to send, e.g. 'y' to answer a prompt, or 'ls -la' to run a command." },
      press_enter: { type: "boolean", description: "Whether to append a carriage return (Enter) after the input so the command or prompt answer is submitted. Defaults to true; set false to send raw input without submitting." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          written: { type: "integer", required: true },
          commandId: { type: "string" }
        }
      },
      render(args, value) {
        const note = value.commandId
          ? ` Ledger id: ${value.commandId} — call xssh_read with command_id to wait for it and get its output.`
          : "";
        return [{ type: "text", text: `Sent ${value.written} bytes to the terminal session.${note}` }];
      }
    },
    async execute(args) {
      let input = typeof args.input === "string" ? args.input : String(args.input ?? "");
      if (args.press_enter !== false && !/[\r\n]$/.test(input)) input += "\r";
      const ensure = await service.ensureSessionForWrite(args.connection_id);
      if (!ensure.ok) throw new Error(`xssh_write failed: ${ensure.error.message}`);
      const result = service.writeCurrentConnection({ connectionId: ensure.connectionId, input });
      if (!result.ok) throw new Error(`xssh_write failed: ${result.error.message}`);
      return result.value;
    }
  }));
}
