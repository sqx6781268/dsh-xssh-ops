/**
 * Agent tools for SFTP file management (R10 工具面瘦身：同类合并)。
 *
 *   - `xsftp_file`     ← list / read / write / mkdir / rename / delete（op）
 *   - `xsftp_transfer` ← upload_dir / download_dir（op）
 *
 * xsftp_file op=delete never deletes on its own: it converts the path into an
 * `rm -rf` confirmation card for the operator; approving it additionally leaves
 * a silent rollback copy in the server trash (see src/trash.js).
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { shellQuote } from "../safety.js";
import { buildTrashCommand, parseSimpleDeleteCommand } from "../trash.js";
import { t } from "../i18n/core.js";

function assertOp(tool, op, allowed) {
  if (!allowed.includes(op)) {
    throw new Error(`${tool} failed: unknown op "${op}"; use one of ${allowed.join(" | ")}`);
  }
}

export function registerSftpTools(ctx, service) {
  ctx.tools.register(defineTool({
    name: "xsftp_file",
    description: "Work with files and directories on a remote server over SFTP (the server open in the right-side SSH terminal unless connection_id is given). op='list' (default) returns directory entries with sizes/mtimes. op='read' returns a file's text (base64-decoded, capped by max_bytes). op='write' creates or overwrites a text file. op='mkdir' creates a directory. op='rename' moves/renames (from -> to). op='delete' is never executed by the agent: it raises an `rm -rf` confirmation card in the SSH panel for the operator (or returns a copyable command when no terminal is open).",
    parameters: {
      op: { type: "string", enum: ["list", "read", "write", "mkdir", "rename", "delete"], required: true, description: "list (default) | read | write | mkdir | rename | delete." },
      connection_id: { type: "string", description: "Connection id from xssh_connect; omit to use the current server." },
      path: { type: "string", description: "list/read/write/mkdir/delete: remote path (directory for list, file for read/write, dir for mkdir, target for delete)." },
      from: { type: "string", description: "rename: current remote path." },
      to: { type: "string", description: "rename: new remote path." },
      content: { type: "string", description: "write: file content to write (UTF-8)." },
      max_bytes: { type: "integer", description: "read: maximum bytes, defaults to 4 MiB." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          entries: { type: "array", items: { type: "object", additionalProperties: false, properties: {
            name: { type: "string" },
            isDirectory: { type: "boolean" },
            size: { type: "number" },
            mtime: { type: "number" },
            mode: { type: "number" }
          } } },
          data: { type: "string" },
          truncated: { type: "boolean" },
          bytes: { type: "number" },
          from: { type: "string" },
          to: { type: "string" },
          isDirectory: { type: "boolean" },
          blocked: { type: "boolean" },
          reason: { type: "string" },
          command: { type: "string" },
          prefilled: { type: "boolean" },
          queued: { type: "boolean" }
        }
      },
      render(args, value) {
        const op = args.op ?? "list";
        if (op === "list") {
          if (!Array.isArray(value.entries) || value.entries.length === 0) return [{ type: "text", text: `(empty directory ${value.path ?? ""})` }];
          const lines = value.entries.map((e) => `${e.isDirectory ? "d" : "-"} ${e.isDirectory ? "" : String(e.size).padStart(10)}  ${new Date(e.mtime).toISOString().slice(0, 16).replace("T", " ")}  ${e.name}`);
          return [{ type: "text", text: `Directory ${value.path} (${value.entries.length} entries):\n` + lines.join("\n") }];
        }
        if (op === "read") {
          const body = value.data || "(empty file)";
          return [{ type: "text", text: value.truncated ? `${body}\n[output truncated at ${value.bytes} bytes]` : body }];
        }
        if (op === "write") return [{ type: "text", text: `Wrote ${value.bytes} bytes to ${value.path}` }];
        if (op === "mkdir") return [{ type: "text", text: `Created directory ${value.path}` }];
        if (op === "rename") return [{ type: "text", text: `Renamed ${value.from} -> ${value.to}` }];
        if (value.blocked) {
          const where = value.queued
            ? t("命令未执行；右侧 SSH 终端面板已弹出确认卡片，等待操作员点击“执行”或“撤销”：")
            : t("命令未执行，无法预填，请粘贴到右侧终端执行：");
          return [{ type: "text", text: t(`⚠️ 已拦截：${value.reason ?? ""}\n${where}\n\`\`\`bash\n${value.command ?? ""}\n\`\`\`\n请勿重试/绕行，由人工确认执行。`) }];
        }
        return [{ type: "text", text: `Deleted ${value.path}` }];
      }
    },
    async execute(args) {
      const op = args.op ?? "list";
      assertOp("xsftp_file", op, ["list", "read", "write", "mkdir", "rename", "delete"]);
      const needPath = op === "list" || op === "read" || op === "write" || op === "mkdir" || op === "delete";
      if (needPath && (typeof args.path !== "string" || args.path === "")) {
        throw new Error(`xsftp_file failed: op="${op}" requires path`);
      }
      if (op === "rename" && (typeof args.from !== "string" || typeof args.to !== "string")) {
        throw new Error("xsftp_file failed: rename requires from and to");
      }
      if (op === "write" && typeof args.content !== "string") {
        throw new Error("xsftp_file failed: write requires content");
      }

      if (op === "list") {
        const result = await service.sftpList({ connectionId: args.connection_id, path: args.path });
        if (!result.ok) throw new Error(`xsftp_file failed: ${result.error.message}`);
        return result.value;
      }
      if (op === "read") {
        const result = await service.sftpReadFile({ connectionId: args.connection_id, path: args.path, maxBytes: args.max_bytes });
        if (!result.ok) throw new Error(`xsftp_file failed: ${result.error.message}`);
        return result.value;
      }
      if (op === "write") {
        const result = await service.sftpWriteFile({ connectionId: args.connection_id, path: args.path, data: Buffer.from(args.content, "utf8").toString("base64") });
        if (!result.ok) throw new Error(`xsftp_file failed: ${result.error.message}`);
        return result.value;
      }
      if (op === "mkdir") {
        const result = await service.sftpMkdir({ connectionId: args.connection_id, path: args.path });
        if (!result.ok) throw new Error(`xsftp_file failed: ${result.error.message}`);
        return result.value;
      }
      if (op === "rename") {
        const result = await service.sftpRename({ connectionId: args.connection_id, from: args.from, to: args.to });
        if (!result.ok) throw new Error(`xsftp_file failed: ${result.error.message}`);
        return result.value;
      }
      // delete：转成确认卡片，绝不代操作员执行。
      const command = `rm -rf ${shellQuote(args.path)}`;
      const parsed = parseSimpleDeleteCommand(command);
      const trashScript = parsed ? buildTrashCommand(parsed.targets) : null;
      const pending = service.prefillBlockedCommand(args.connection_id, command, t("删除文件或目录（SFTP）"), trashScript);
      return { path: args.path, blocked: true, reason: t("删除文件或目录（SFTP）"), command, prefilled: pending.prefilled, queued: pending.queued };
    }
  }));

  ctx.tools.register(defineTool({
    name: "xsftp_transfer",
    description: "Transfer a directory tree over SFTP. op='upload_dir' uploads a local directory to the server (creating the remote structure); op='download_dir' downloads a remote directory to a local directory. Small files transfer in parallel (bounded), large files one at a time for full link throughput. Per-file failures are reported, not fatal. Omit connection_id for the current server.",
    parameters: {
      op: { type: "string", enum: ["upload_dir", "download_dir"], required: true, description: "upload_dir | download_dir." },
      connection_id: { type: "string", description: "Connection id from xssh_connect; omit to use the current server." },
      local_path: { type: "string", required: true, description: "Local directory (source for upload_dir, destination for download_dir)." },
      remote_path: { type: "string", required: true, description: "Remote directory (destination for upload_dir, source for download_dir)." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string" },
          target: { type: "string" },
          directories: { type: "number" },
          files: { type: "number" },
          bytes: { type: "number" },
          failed: { type: "array", items: { type: "object", additionalProperties: false, properties: {
            path: { type: "string" },
            error: { type: "string" }
          } } }
        }
      },
      render(args, value) {
        const verb = (args.op ?? "upload_dir") === "download_dir" ? "Downloaded" : "Uploaded";
        const head = `${verb} ${value.files} files (${value.bytes} bytes, ${value.directories} directories) to ${value.target}`;
        if (!Array.isArray(value.failed) || value.failed.length === 0) return [{ type: "text", text: head }];
        const lines = value.failed.map((f) => `- ${f.path}: ${f.error}`);
        return [{ type: "text", text: `${head}\n${value.failed.length} failures:\n${lines.join("\n")}` }];
      }
    },
    async execute(args) {
      const op = args.op ?? "upload_dir";
      assertOp("xsftp_transfer", op, ["upload_dir", "download_dir"]);
      if (op === "download_dir") {
        const result = await service.sftpDownloadDir({ connectionId: args.connection_id, remotePath: args.remote_path, localPath: args.local_path });
        if (!result.ok) throw new Error(`xsftp_transfer failed: ${result.error.message}`);
        return result.value;
      }
      const result = await service.sftpUploadDir({ connectionId: args.connection_id, localPath: args.local_path, remotePath: args.remote_path });
      if (!result.ok) throw new Error(`xsftp_transfer failed: ${result.error.message}`);
      return result.value;
    }
  }));
}
