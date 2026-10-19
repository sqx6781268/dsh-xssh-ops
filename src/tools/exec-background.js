/**
 * 后台任务工具集（R10 工具面瘦身：同类合并）。
 *
 *   - `xssh_exec_background` 保留（下发任务；契约与 task 查询差异大）
 *   - `xssh_task`            ← task_list + task_status + task_read + task_delete
 *
 * 落点三级（remote-tmp → remote-home → local）与降级告警语义一律不动。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { redactForModel } from "../redact.js";
import { t } from "../i18n/core.js";

// i18n-identifier-start — 状态标签是稳定标识表，不参与 i18n 抽取
const STATE_LABELS = {
  running: "运行中",
  done: "已完成",
  missing: "产物缺失",
  "degraded-aborted": "降级后中断",
  deleted: "已删除"
};
// i18n-identifier-end

/** op 不支持时点名可用值（R10 约束）。 */
function assertOp(tool, op, allowed) {
  if (!allowed.includes(op)) {
    throw new Error(`${tool} failed: unknown op "${op}"; use one of ${allowed.join(" | ")}`);
  }
}

export function registerBackgroundTools(ctx, service) {
  ctx.tools.register(defineTool({
    name: "xssh_exec_background",
    description: "Start a long-running command in the background and keep its output in a file, then read it back by line number (xssh_task op=status / op=read). Results live in a remote temp dir by default; when the remote has no usable temp dir OR its free space is below the threshold, the task is DEGRADED to a local temp dir — then degraded=true and warnings[] tell you the results are NOT kept on the remote host and a dropped connection kills the job. Read the warnings and relay them to the user. The remote side must be POSIX (setsid/nohup/df); network devices such as Huawei VRP are not supported — use xssh_write there. Destructive commands still go through the operator confirmation card and are never run silently here.",
    parameters: {
      connection_id: { type: "string", description: "Connection to run on; defaults to the current one." },
      command: { type: "string", required: true, description: "The command line to run in the background." },
      label: { type: "string", description: "Optional note stored with the task for later identification." },
      force_local: { type: "boolean", description: "Skip the probe and force the local degraded channel (still warns)." },
      allow_low_space: { type: "boolean", description: "Run on the remote even when its free space is below the threshold (still warns; the risk is yours)." }
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          taskId: { type: "string", required: true },
          commandId: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
          location: { type: "string", required: true },
          degraded: { type: "boolean", required: true },
          warnings: { type: "array", required: true, items: { type: "string" } },
          remoteDir: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
          localDir: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
          outPath: { type: "string", required: true },
          notes: { type: "array", required: true, items: { type: "string" } }
        }
      },
      render(_args, value) {
        const head = value.degraded
          ? t(`⚠️ 后台任务已启动，但**已降级到本地**（结果不留远端，断线即中断）`)
          : t(`后台任务已启动：${value.taskId}（${value.location}）`);
        const lines = [head];
        for (const warning of value.warnings) lines.push(`  ⚠ ${warning}`);
        for (const note of value.notes) lines.push(`  · ${note}`);
        lines.push(t(`输出文件：${value.outPath}`));
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args) {
      const result = await service.execBackground({
        connectionId: args.connection_id,
        command: String(args.command ?? ""),
        label: args.label,
        forceLocal: args.force_local === true,
        allowLowSpace: args.allow_low_space === true
      });
      if (!result.ok && result.value?.taskId === undefined) {
        throw new Error(`xssh_exec_background failed: ${result.error.message}`);
      }
      const value = result.value;
      const notes = [];
      if (value.location === "remote-home") {
        notes.push(t("产物存放在远端家目录（远端没有可用的临时目录）。"));
      }
      if (value.location === "local") {
        notes.push(t("本地通道由本机持有，DSH 关闭或断线都可能中断它。"));
      }
      notes.push(t("用 xssh_task op=status 看进度，op=read 按行号读输出。"));
      return {
        taskId: value.taskId,
        commandId: value.commandId ?? null,
        location: value.location,
        degraded: value.degraded === true,
        warnings: Array.isArray(value.warnings) ? value.warnings : [],
        remoteDir: value.remoteDir ?? null,
        localDir: value.localDir ?? null,
        outPath: String(value.outPath ?? ""),
        notes
      };
    }
  }));

  ctx.tools.register(defineTool({
    name: "xssh_task",
    description: "Inspect background tasks (started by xssh_exec_background). op='list' (default) lists recent tasks with location, degraded flag, state and output paths. op='status' reports one task's state (running | done | missing | degraded-aborted), where its results live and its byte counts. op='read' reads a task's output by line number (stream out | err | both; numbered text, line range or tail; content is redacted). op='delete' removes the task's artifacts and marks the ledger entry deleted (it does not stop the task).",
    parameters: {
      op: { type: "string", enum: ["list", "status", "read", "delete"], required: true, description: "list (default) | status | read | delete." },
      connection_id: { type: "string", description: "list: only tasks for this connection; defaults to all." },
      limit: { type: "integer", description: "list: how many recent tasks to return; defaults to 20." },
      task_id: { type: "string", description: "status/read/delete: task id from xssh_exec_background or op='list'." },
      stream: { type: "string", enum: ["out", "err", "both"], description: "read: which file to read; defaults to out." },
      from_line: { type: "integer", description: "read: first line of the range (1-based); use with to_line." },
      to_line: { type: "integer", description: "read: last line of the range (inclusive)." },
      tail_lines: { type: "integer", description: "read: newest N lines when no range is given." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          tasks: { type: "array", items: { type: "object", additionalProperties: true } },
          taskId: { type: "string" },
          state: { type: "string" },
          location: { type: "string" },
          degraded: { type: "boolean" },
          exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
          outBytes: { type: "integer" },
          errBytes: { type: "integer" },
          text: { type: "string" },
          lines: { type: "array", items: { type: "object", additionalProperties: true } },
          totalLines: { type: "integer" },
          nextLine: { type: "integer" },
          hasMore: { type: "boolean" },
          warnings: { type: "array", items: { type: "string" } },
          deleted: { type: "boolean" }
        }
      },
      render(args, value) {
        const op = args.op ?? "list";
        if (op === "list") {
          if (!Array.isArray(value.tasks) || value.tasks.length === 0) return [{ type: "text", text: t("还没有后台任务记录。") }];
          const lines = value.tasks.map((task) => {
            const degraded = task.degraded ? t("（降级本地）") : "";
            const exit = task.exitCode === null ? "" : ` exit=${task.exitCode}`;
            return `${task.taskId}  ${task.location}${degraded}  ${t(STATE_LABELS[task.state] ?? t("未知"))}${exit}  ${task.command}`;
          });
          return [{ type: "text", text: lines.join("\n") }];
        }
        if (op === "status") {
          const head = `${value.taskId}  ${value.location}  ${t(STATE_LABELS[value.state] ?? t("未知"))}`;
          const exit = value.exitCode === null || value.exitCode === undefined ? "" : `  exit=${value.exitCode}`;
          const bytes = t(`  out ${value.outBytes ?? 0}B / err ${value.errBytes ?? 0}B`);
          const lines = [`${head}${exit}${bytes}`];
          for (const warning of value.warnings ?? []) lines.push(`  ⚠ ${warning}`);
          return [{ type: "text", text: lines.join("\n") }];
        }
        if (op === "read") {
          const head = `${value.taskId}  ${value.location}  ${t(STATE_LABELS[value.state] ?? t("未知"))}  ${t(`共 ${value.totalLines ?? 0} 行`)}`;
          const body = value.text === "" ? t("（暂无输出）") : value.text;
          return [{ type: "text", text: `${head}\n${body}` }];
        }
        return [{ type: "text", text: t(`已删除任务产物：${value.taskId}（${value.location}）`) }];
      }
    },
    async execute(args) {
      const op = args.op ?? "list";
      assertOp("xssh_task", op, ["list", "status", "read", "delete"]);

      if (op === "list") {
        const result = service.taskList({
          connectionId: args.connection_id,
          limit: Number.isSafeInteger(args.limit) ? args.limit : 20
        });
        if (!result.ok) throw new Error(`xssh_task failed: ${result.error.message}`);
        return {
          tasks: result.value.tasks.map((task) => ({
            taskId: task.taskId,
            connectionId: task.connectionId,
            host: task.host,
            command: redactForModel(task.command).text,
            label: task.label,
            location: task.location,
            degraded: task.degraded === true,
            state: task.state,
            exitCode: task.exitCode ?? null,
            bytes: task.bytes,
            remoteDir: task.remoteDir,
            localDir: task.localDir,
            startedAt: task.startedAt,
            warnings: task.warnings
          }))
        };
      }

      if (typeof args.task_id !== "string" || args.task_id === "") {
        throw new Error(`xssh_task failed: op="${op}" requires task_id`);
      }

      if (op === "status") {
        const result = await service.taskStatus({ taskId: String(args.task_id ?? "") });
        if (!result.ok) throw new Error(`xssh_task failed: ${result.error.message}`);
        const value = result.value;
        return {
          taskId: value.taskId,
          state: value.state,
          location: value.location,
          degraded: value.degraded === true,
          exitCode: value.exitCode ?? null,
          outBytes: value.bytes?.out ?? 0,
          errBytes: value.bytes?.err ?? 0,
          warnings: Array.isArray(value.warnings) ? value.warnings : []
        };
      }

      if (op === "read") {
        const result = await service.taskRead({
          taskId: String(args.task_id ?? ""),
          stream: args.stream,
          fromLine: Number.isSafeInteger(args.from_line) ? args.from_line : undefined,
          toLine: Number.isSafeInteger(args.to_line) ? args.to_line : undefined,
          tailLines: Number.isSafeInteger(args.tail_lines) ? args.tail_lines : undefined
        });
        if (!result.ok) throw new Error(`xssh_task failed: ${result.error.message}`);
        const value = result.value;
        const safe = redactForModel(value.text);
        return {
          taskId: value.taskId,
          state: value.state,
          location: value.location,
          degraded: value.degraded === true,
          text: safe.text,
          lines: value.lines.map((entry) => ({ line: entry.line, stream: entry.stream, text: redactForModel(entry.text).text })),
          totalLines: value.totalLines,
          nextLine: value.nextLine,
          hasMore: value.hasMore === true,
          warnings: Array.isArray(value.warnings) ? value.warnings : []
        };
      }

      // delete
      const result = await service.taskDelete({ taskId: String(args.task_id ?? "") });
      if (!result.ok) throw new Error(`xssh_task failed: ${result.error?.message ?? JSON.stringify(result.error ?? result)}`);
      return { taskId: result.value.taskId, deleted: true, location: result.value.location };
    }
  }));
}
