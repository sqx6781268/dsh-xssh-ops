/**
 * Session-log agent tools (R10 工具面瘦身：同类合并)。
 *
 * `xssh_session_log` ← list + search + read（op）
 *
 * Content-bearing reads cross the same boundary as terminal-context reads —
 * operator approval plus redaction — because a recorded session may contain
 * anything the operator typed or saw.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { redactForModel } from "../redact.js";
import { readableLine, toReadableText } from "../terminal-text.js";
import { t } from "../i18n/core.js";

const MAX_READ_BYTES = 48 * 1024;

function assertOp(tool, op, allowed) {
  if (!allowed.includes(op)) {
    throw new Error(`${tool} failed: unknown op "${op}"; use one of ${allowed.join(" | ")}`);
  }
}

export function registerSessionLogTools(ctx, service) {
  ctx.tools.register(defineTool({
    name: "xssh_session_log",
    description: "Inspect recorded SSH terminal sessions. op='list' (default) returns metadata only (host, user, start/end, size, truncation). op='search' scans one session log for a case-insensitive substring and returns matching lines with byte offsets. op='read' returns a bounded range from one session log starting at a byte offset; continue with the returned nextOffset. Content from search/read is redacted and requires operator approval.",
    parameters: {
      op: { type: "string", enum: ["list", "search", "read"], required: true, description: "list (default) | search | read." },
      session_id: { type: "string", description: "search/read: session id from op='list'." },
      limit: { type: "integer", description: "list: how many of the newest sessions to return; defaults to 20." },
      query: { type: "string", description: "search: text to look for (case-insensitive)." },
      max_hits: { type: "integer", description: "search: stop after this many hits; defaults to 50." },
      offset: { type: "integer", description: "read: byte offset to start at; defaults to 0 (or an offset from a search hit)." },
      max_bytes: { type: "integer", description: `read: bytes to return; defaults to 24576, capped at ${MAX_READ_BYTES}.` }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          logs: { type: "array", items: { type: "object", additionalProperties: true } },
          hits: { type: "array", items: { type: "object", additionalProperties: true } },
          scannedBytes: { type: "number" },
          stoppedEarly: { type: "boolean" },
          data: { type: "string" },
          startOffset: { type: "number" },
          nextOffset: { type: "number" },
          eof: { type: "boolean" },
          size: { type: "number" }
        }
      },
      render(args, value) {
        const op = args.op ?? "list";
        if (op === "list") {
          if (value.enabled === false) return [{ type: "text", text: t("会话录制已关闭（config.sessionLogEnabled = false）。") }];
          if (!value.logs || value.logs.length === 0) return [{ type: "text", text: t("还没有已录制的会话。") }];
          const lines = value.logs.map((log) => {
            const state = log.endedAt === null ? "recording" : `ended${log.exitCode === null ? "" : ` (exit ${log.exitCode})`}`;
            const where = [log.name, log.host].filter(Boolean).join(" @ ") || "unknown host";
            return `${log.sessionId}  ${log.startedAt}  ${where}  ${Math.round((log.bytes ?? 0) / 1024)}KB${log.truncated ? " [truncated]" : ""}  ${state}`;
          });
          return [{ type: "text", text: lines.join("\n") }];
        }
        if (op === "search") {
          if (!value.hits || value.hits.length === 0) return [{ type: "text", text: t("没有匹配行。") }];
          const lines = value.hits.map((hit) => `@${hit.offset}  ${hit.line}`);
          return [{ type: "text", text: lines.join("\n") + (value.stoppedEarly ? t("\n[到达命中上限，已停止]") : "") }];
        }
        const tail = value.eof ? "" : t(`\n[已到 offset ${value.nextOffset} / ${value.size}，继续读取请用该 offset]`);
        return [{ type: "text", text: (value.data ?? "") + tail }];
      }
    },
    async execute(args) {
      const op = args.op ?? "list";
      assertOp("xssh_session_log", op, ["list", "search", "read"]);

      if (op === "list") {
        const result = await service.sessionLogList();
        if (!result.ok) throw new Error(`xssh_session_log failed: ${result.error.message}`);
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
        return { enabled: result.value.enabled, logs: result.value.logs.slice(0, limit) };
      }

      if (typeof args.session_id !== "string" || args.session_id === "") {
        throw new Error(`xssh_session_log failed: op="${op}" requires session_id`);
      }

      if (op === "search") {
        if (typeof args.query !== "string" || args.query === "") {
          throw new Error("xssh_session_log failed: search requires query");
        }
        const result = await service.sessionLogSearch({
          sessionId: args.session_id, query: args.query,
          maxHits: Math.min(Math.max(Number(args.max_hits) || 50, 1), 200)
        });
        if (!result.ok) throw new Error(`xssh_session_log failed: ${result.error.message}`);
        return {
          hits: result.value.hits.map((hit) => ({ offset: hit.offset, line: redactForModel(readableLine(hit.line)) })),
          scannedBytes: result.value.scannedBytes,
          stoppedEarly: result.value.stoppedEarly
        };
      }

      const result = await service.sessionLogRead({
        sessionId: args.session_id, offset: args.offset,
        maxBytes: Math.min(Math.max(Number(args.max_bytes) || 24576, 1024), MAX_READ_BYTES)
      });
      if (!result.ok) throw new Error(`xssh_session_log failed: ${result.error.message}`);
      return { ...result.value, data: redactForModel(toReadableText(result.value.data)) };
    }
  }));

  // Reading recorded session content is the same trust boundary as reading a
  // live terminal: the operator approves each attempt.
  if (typeof ctx.on === "function") ctx.on("tools/pre-execute", (execution, next) => {
    if (execution?.name !== "xssh_session_log") return typeof next === "function" ? next() : undefined;
    const op = execution?.args?.op;
    if (op !== "search" && op !== "read") return typeof next === "function" ? next() : undefined;
    return { kind: "ask", reason: "Agent requests recorded SSH session content, which may contain sensitive output." };
  });
}
