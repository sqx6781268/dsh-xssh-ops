/**
 * 行号/台账工具集（R10 工具面瘦身：同类合并）。
 *
 *   - `xssh_terminal`  ← terminal_sessions + terminal_context + shell_integration
 *   - `xssh_command`   ← command_list + command_output
 *
 * 约定保持不变：正文一律过 `redactForModel`；`truncated`/`evicted` 显式暴露；
 * `xssh_terminal op=context` 与 `op=output` 仍走操作员确认（tools/pre-execute）。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { redactForModel } from "../redact.js";
import { t } from "../i18n/core.js";

/** 单次返回的字节上限（计划 5.5.2：48 KiB）。 */
const MAX_READ_BYTES = 48 * 1024;
const DEFAULT_MAX_BYTES = 24 * 1024;

function clampBytes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_MAX_BYTES;
  return Math.min(Math.floor(numeric), MAX_READ_BYTES);
}

/** `0812–0838` / `0812–`（未闭口）/ `（无输出）`。 */
function rangeText(command) {
  if (command.endLine === null) return t(`${command.startLine}–（运行中）`);
  if (command.endLine < command.startLine) return t("（无输出）");
  return `${command.startLine}–${command.endLine}`;
}

/** op 不支持时点名可用值（R10 约束）。 */
function assertOp(tool, op, allowed) {
  if (!allowed.includes(op)) {
    throw new Error(`${tool} failed: unknown op "${op}"; use one of ${allowed.join(" | ")}`);
  }
}

export function registerTerminalLineTools(ctx, service) {
  ctx.tools.register(defineTool({
    name: "xssh_terminal",
    description: "Inspect or enable shell integration on user-operated SSH terminals. op='sessions' (default) lists open terminal sessions (metadata + history cursors only, no output). op='context' reads a bounded, redacted range from one session — choose the session with op='sessions' first; the operator approves each read. op='shell_integration' enables OSC 133 markers in that shell so context reports cwd, last exit code and prompt state instead of guessing.",
    parameters: {
      op: { type: "string", enum: ["sessions", "context", "shell_integration"], required: true, description: "sessions (default) | context | shell_integration." },
      session_id: { type: "string", description: "context/shell_integration: session id from op='sessions'." },
      after: { type: "integer", description: "context: optional cursor from a previous read." },
      max_bytes: { type: "integer", description: "context: 1024..98304 bytes; defaults to 24576." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true
      },
      render(args, value) {
        const op = args.op ?? "sessions";
        if (op === "sessions") {
          if (Array.isArray(value.sessions) && value.sessions.length === 0) return [{ type: "text", text: t("(没有打开的终端会话)") }];
          return [{ type: "text", text: JSON.stringify(value.sessions ?? [], null, 2) }];
        }
        if (op === "shell_integration") {
          return [{ type: "text", text: value.enabled ? t(`已在会话 ${value.sessionId} 启用 shell integration；此后 xssh_terminal op=context 会带上 cwd/退出码/提示符状态。`) : t("启用失败。") }];
        }
        const data = typeof value === "object" && value !== null ? JSON.stringify(value, null, 2) : String(value ?? "");
        return [{ type: "text", text: data }];
      }
    },
    async execute(args) {
      const op = args.op ?? "sessions";
      assertOp("xssh_terminal", op, ["sessions", "context", "shell_integration"]);
      if (op === "sessions") {
        const result = service.listTerminalContexts();
        if (!result.ok) throw new Error(`xssh_terminal failed: ${result.error.message}`);
        return result.value;
      }
      if (op === "shell_integration") {
        if (typeof args.session_id !== "string" || args.session_id === "") {
          throw new Error("xssh_terminal failed: shell_integration requires session_id (see op='sessions')");
        }
        const result = await service.enableShellIntegration({ sessionId: args.session_id });
        if (!result.ok) throw new Error(`xssh_terminal failed: ${result.error.message}`);
        return result.value;
      }
      if (typeof args.session_id !== "string" || args.session_id === "") {
        throw new Error("xssh_terminal failed: context requires session_id (see op='sessions')");
      }
      const result = service.readTerminalContext({ sessionId: args.session_id, after: args.after, maxBytes: args.max_bytes });
      if (!result.ok) throw new Error(`xssh_terminal failed: ${result.error.message}`);
      return result.value;
    }
  }));

  // 读取手动终端内容与录制会话内容同样是高敏操作：每次读都请操作员确认。
  if (typeof ctx.on === "function") ctx.on("tools/pre-execute", (execution, next) => {
    if (execution?.name !== "xssh_terminal" || execution?.args?.op !== "context") {
      return typeof next === "function" ? next() : undefined;
    }
    return { kind: "ask", reason: "Agent requests recent manual SSH terminal activity, which may contain sensitive output." };
  });

  ctx.tools.register(defineTool({
    name: "xssh_command",
    description: "Work with the command ledger of a connection. op='list' (default) lists recorded commands with their output line ranges (startLine..endLine), status and exit code — use it to find which lines belong to which command. op='output' reads ONE command's output, addressed by command_id or command_text (exact by default; match:'substring' returns the newest matches as candidates). Handled at the entry layer only: both branches use the same ledger the panel shows; login-script/keep-alive entries stay hidden.",
    parameters: {
      op: { type: "string", enum: ["list", "output"], required: true, description: "list (default) | output." },
      connection_id: { type: "string", description: "Connection to read; defaults to the current one." },
      limit: { type: "integer", description: "list: how many recent commands to return; defaults to 20." },
      status: { type: "string", enum: ["all", "running", "done"], description: "list: filter by whether the command has finished; defaults to all." },
      command_id: { type: "string", description: "output: command id from list. Mutually exclusive with command_text." },
      command_text: { type: "string", description: "output: the command line as issued (compared after trimming)." },
      match: { type: "string", enum: ["exact", "substring"], description: "output: how command_text is matched; defaults to exact." },
      max_bytes: { type: "integer", description: `output: response size cap; defaults to ${DEFAULT_MAX_BYTES}, hard limit ${MAX_READ_BYTES}.` },
      format: { type: "string", enum: ["lines", "text"], description: "output: `lines` (default) returns numbered text; `text` returns the bare output." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectionId: { type: "string" },
          host: { type: "string" },
          commands: { type: "array", items: { type: "object", additionalProperties: true } },
          commandId: { type: "string" },
          text: { type: "string" },
          issuedAt: { type: "string" },
          status: { type: "string" },
          startLine: { type: "number" },
          endLine: { type: "number" },
          exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
          output: { type: "string" },
          lines: { type: "array", items: { type: "object", additionalProperties: true } },
          truncated: { type: "boolean" },
          note: { type: "string" },
          candidates: { type: "array", items: { type: "object", additionalProperties: true } }
        }
      },
      render(args, value) {
        if ((args.op ?? "list") === "list") {
          if (!Array.isArray(value.commands) || value.commands.length === 0) {
            return [{ type: "text", text: t("这个连接还没有命令记录。") }];
          }
          const lines = value.commands.map((command) => {
            const exit = command.exitCode === null ? "" : ` exit=${command.exitCode}`;
            const closed = command.closedBy === null ? "" : ` ${command.closedBy}`;
            return `${command.commandId}  ${command.issuedAt}  ${rangeText(command)}  ${command.status}${exit}${closed}\n  ${command.text}`;
          });
          return [{ type: "text", text: lines.join("\n") }];
        }
        if (Array.isArray(value.candidates) && value.candidates.length > 0 && value.commandId === "") {
          const lines = value.candidates.map((item) => `${item.commandId}  ${item.issuedAt}  ${rangeText(item)}\n  ${item.text}`);
          return [{ type: "text", text: `${t("命中多条，请用 command_id 指定：")}\n${lines.join("\n")}` }];
        }
        const head = `$ ${value.text ?? ""}`;
        const exit = value.exitCode === null || value.exitCode === undefined ? "" : ` exit=${value.exitCode}`;
        const meta = `${rangeText(value)}  ${value.status ?? ""}${exit}  ${value.issuedAt ?? ""}`;
        const note = value.note === "" || value.note === undefined ? "" : `\n${value.note}`;
        return [{ type: "text", text: `${head}\n${meta}${note}\n${value.output === "" ? t("（无输出）") : value.output}` }];
      }
    },
    async execute(args) {
      const op = args.op ?? "list";
      assertOp("xssh_command", op, ["list", "output"]);
      const target = service.terminalLinesFor(args.connection_id);
      if (!target.ok) throw new Error(`xssh_command failed: ${target.error.message}`);
      const sessionId = target.value.sessionId;

      if (op === "list") {
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 500);
        const result = service.listCommands({ sessionId, limit: 500 });
        if (!result.ok) throw new Error(`xssh_command failed: ${result.error.message}`);
        const want = args.status ?? "all";
        const filtered = result.value.commands.filter((command) => {
          if (want === "running") return command.endLine === null;
          if (want === "done") return command.endLine !== null;
          return true;
        });
        return {
          connectionId: target.value.connectionId,
          host: target.value.host,
          commands: filtered.slice(0, limit).map((command) => ({
            commandId: command.commandId,
            issuedAt: command.issuedAt,
            text: redactForModel(command.text).text,
            source: command.source,
            status: command.status,
            startLine: command.startLine,
            endLine: command.endLine,
            exitCode: command.exitCode,
            closedBy: command.closedBy,
            truncated: command.truncated
          }))
        };
      }

      const ledgerResult = service.listCommands({ sessionId, limit: 500 });
      if (!ledgerResult.ok) throw new Error(`xssh_command failed: ${ledgerResult.error.message}`);
      const all = ledgerResult.value.commands;

      let command;
      if (typeof args.command_id === "string" && args.command_id !== "") {
        command = all.find((item) => item.commandId === args.command_id) ?? null;
        if (command === null) throw new Error(`xssh_command failed: no command with id "${args.command_id}"`);
      } else if (typeof args.command_text === "string" && args.command_text.trim() !== "") {
        const needle = args.command_text.trim();
        const mode = args.match === "substring" ? "substring" : "exact";
        const matches = all.filter((item) => (mode === "substring" ? item.text.includes(needle) : item.text.trim() === needle));
        if (matches.length === 0) throw new Error(`xssh_command failed: no command matched "${needle}"`);
        if (matches.length > 1 && mode === "substring") {
          return {
            commandId: "",
            text: needle,
            issuedAt: matches[0].issuedAt,
            status: "",
            startLine: 0,
            endLine: 0,
            exitCode: null,
            output: "",
            lines: [],
            truncated: false,
            note: "",
            candidates: matches.slice(0, 5).map((item) => ({
              commandId: item.commandId, issuedAt: item.issuedAt, text: item.text,
              startLine: item.startLine, endLine: item.endLine, status: item.status
            }))
          };
        }
        command = matches[0];
      } else {
        throw new Error("xssh_command failed: op='output' needs either command_id or command_text");
      }

      const running = command.endLine === null;
      const snapshot = service.readTerminalLines({ sessionId, tailLines: 1 });
      const lastLine = snapshot.ok ? snapshot.value.lastLine : command.startLine;
      const endLine = running ? lastLine : command.endLine;
      const empty = endLine < command.startLine;

      let output = "";
      let numbered = "";
      let truncated = running;
      let lines = [];
      if (!empty) {
        const read = service.readTerminalLines({
          sessionId,
          fromLine: command.startLine,
          toLine: endLine,
          maxBytes: clampBytes(args.max_bytes)
        });
        if (!read.ok) throw new Error(`xssh_command failed: ${read.error.message}`);
        lines = read.value.lines.map((entry) => ({ line: entry.line, text: redactForModel(entry.text).text }));
        output = lines.map((entry) => entry.text).join("\n");
        numbered = t(`第 ${read.value.fromLine}–${read.value.toLine} 行`) + "\n" + read.value.text;
        truncated = truncated || read.value.truncated || read.value.evicted;
      }

      const notes = [];
      if (running) notes.push(t(`命令尚未结束，返回截至第 ${endLine} 行。`));
      if (empty) notes.push(t("这条命令没有产生输出行。"));
      if (truncated && !running) notes.push(t("输出区间被上限截断或更早的行已被淘汰。"));

      return {
        commandId: command.commandId,
        text: redactForModel(command.text).text,
        issuedAt: command.issuedAt,
        status: command.status,
        startLine: command.startLine,
        endLine,
        exitCode: command.exitCode,
        output: args.format === "text" ? output : redactForModel(numbered).text,
        lines,
        truncated,
        note: notes.join(" "),
        candidates: []
      };
    }
  }));
}
