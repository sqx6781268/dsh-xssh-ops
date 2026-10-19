/**
 * Agent tools for SSH port forwarding (R10 工具面瘦身：同类合并)。
 *
 * `xtunnel` ← xtunnel_start + xtunnel_stop + xtunnel_list（op）
 */
import { defineTool } from "@deepseek-ai/dsh-tools";

function assertOp(tool, op, allowed) {
  if (!allowed.includes(op)) {
    throw new Error(`${tool} failed: unknown op "${op}"; use one of ${allowed.join(" | ")}`);
  }
}

export function registerTunnelTools(ctx, service) {
  ctx.tools.register(defineTool({
    name: "xtunnel",
    description: "Manage port forwards through a connected server. op='start' creates one: kind='local' (default) makes the DSH host listen on bind_addr:bind_port and forwards to remote_host:remote_port on the server — use to reach services only the server can see; kind='remote' makes the server listen on remote_host:remote_port and forward back to target_host:target_port on this machine; kind='dynamic' starts a SOCKS5 proxy on bind_addr:bind_port (ssh -D). Returns a tunnel_id. op='list' lists active forwards. op='stop' stops one by tunnel_id.",
    parameters: {
      op: { type: "string", enum: ["start", "list", "stop"], required: true, description: "start (default) | list | stop." },
      connection_id: { type: "string", description: "Connection id from xssh_connect; omit to use the current server." },
      kind: { type: "string", enum: ["local", "remote", "dynamic"], description: "start: forward direction; defaults to local." },
      bind_addr: { type: "string", description: "start: local bind address (local/dynamic kinds), defaults to 127.0.0.1." },
      bind_port: { type: "integer", description: "start: local bind port (local/dynamic kinds); 0 picks a free port." },
      remote_host: { type: "string", description: "start: the remote host to reach (local) or to listen on (remote)." },
      remote_port: { type: "integer", description: "start: the remote port to reach (local) or to listen on (remote)." },
      target_host: { type: "string", description: "start: local target host for remote kind, defaults to 127.0.0.1." },
      target_port: { type: "integer", description: "start: local target port for remote kind (required when kind='remote')." },
      tunnel_id: { type: "string", description: "stop: the tunnel id returned by op='start' or op='list'." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          tunnelId: { type: "string" },
          kind: { type: "string" },
          bindAddr: { type: "string" },
          bindPort: { type: "number" },
          remoteHost: { type: "string" },
          remotePort: { type: "number" },
          targetHost: { type: "string" },
          targetPort: { type: "number" },
          tunnels: { type: "array", items: { type: "object", additionalProperties: true } },
          stopped: { type: "boolean" }
        }
      },
      render(args, value) {
        const op = args.op ?? "start";
        if (op === "stop") return [{ type: "text", text: `Stopped tunnel ${value.tunnelId}` }];
        if (op === "list") {
          if (!Array.isArray(value.tunnels) || value.tunnels.length === 0) return [{ type: "text", text: "(no active tunnels)" }];
          return [{ type: "text", text: value.tunnels.map((t) => `${t.kind}: ${t.bindAddr}:${t.bindPort} -> ${t.remoteHost}:${t.remotePort} (${t.tunnelId})`).join("\n") }];
        }
        const text = value.kind === "dynamic"
          ? `SOCKS5 proxy started on ${value.bindAddr}:${value.bindPort} (id: ${value.tunnelId})`
          : value.kind === "local"
            ? `Tunnel started: ${value.bindAddr}:${value.bindPort} -> ${value.remoteHost}:${value.remotePort} (id: ${value.tunnelId})`
            : `Remote forward started: ${value.remoteHost}:${value.remotePort} -> ${value.bindAddr}:${value.bindPort} (id: ${value.tunnelId})`;
        return [{ type: "text", text }];
      }
    },
    async execute(args) {
      const op = args.op ?? "start";
      assertOp("xtunnel", op, ["start", "list", "stop"]);

      if (op === "list") {
        const result = await service.tunnelList({ connectionId: args.connection_id });
        if (!result.ok) throw new Error(`xtunnel failed: ${result.error.message}`);
        return result.value;
      }
      if (op === "stop") {
        if (typeof args.tunnel_id !== "string" || args.tunnel_id === "") {
          throw new Error("xtunnel failed: stop requires tunnel_id");
        }
        const result = await service.tunnelStop({ connectionId: args.connection_id, tunnelId: args.tunnel_id });
        if (!result.ok) throw new Error(`xtunnel failed: ${result.error.message}`);
        return result.value;
      }

      let result;
      if (args.kind === "dynamic") {
        result = await service.tunnelStartDynamic({ connectionId: args.connection_id, bindAddr: args.bind_addr, bindPort: args.bind_port });
      } else if (args.kind === "remote") {
        result = await service.tunnelStartRemote({ connectionId: args.connection_id, bindAddr: args.bind_addr, bindPort: args.bind_port, remoteHost: args.remote_host, remotePort: args.remote_port, targetHost: args.target_host ?? "127.0.0.1", targetPort: args.target_port });
      } else {
        if (args.remote_host === undefined || args.remote_port === undefined) {
          throw new Error("xtunnel failed: remote_host and remote_port are required for the local kind");
        }
        result = await service.tunnelStartLocal({ connectionId: args.connection_id, bindAddr: args.bind_addr, bindPort: args.bind_port, remoteHost: args.remote_host, remotePort: args.remote_port });
      }
      if (!result.ok) throw new Error(`xtunnel failed: ${result.error.message}`);
      return result.value;
    }
  }));
}
