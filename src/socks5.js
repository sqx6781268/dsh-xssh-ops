/**
 * Minimal SOCKS5 server (RFC 1928) backing the dynamic forwarding tunnel —
 * the `ssh -D` equivalent. Only CONNECT is implemented: each accepted client
 * is piped into a fresh ssh2 forwardOut channel for the address it asked for,
 * so one listener reaches whatever the SSH server can reach. BIND and UDP
 * ASSOCIATE are answered "command not supported" instead of being silently
 * approximated: an SSH channel cannot carry either.
 *
 * Parsing and framing live here as pure functions; attachSocks5() wires them
 * to a socket.
 */

export const SOCKS_REPLY = Object.freeze({
  SUCCEEDED: 0x00,
  GENERAL_FAILURE: 0x01,
  NETWORK_UNREACHABLE: 0x03,
  HOST_UNREACHABLE: 0x04,
  CONNECTION_REFUSED: 0x05,
  COMMAND_NOT_SUPPORTED: 0x07,
  ADDRESS_NOT_SUPPORTED: 0x08
});

/** Map an ssh2 forwardOut error onto the closest SOCKS reply code. */
export function replyCodeForError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  if (message.includes("refused")) return SOCKS_REPLY.CONNECTION_REFUSED;
  if (message.includes("unreachable") || message.includes("no route")) return SOCKS_REPLY.NETWORK_UNREACHABLE;
  if (message.includes("unknown") || message.includes("not found") || message.includes("enotfound") || message.includes("resolve")) return SOCKS_REPLY.HOST_UNREACHABLE;
  return SOCKS_REPLY.GENERAL_FAILURE;
}

/**
 * Parse the client greeting (VER, NMETHODS, METHODS).
 * @returns `{ ok: true, wantsNoAuth }`, `{ ok: false, reason }`, or null when
 *   more bytes are needed.
 */
export function parseGreeting(bytes) {
  if (bytes.length < 2) return null;
  if (bytes[0] !== 0x05) return { ok: false, reason: `unsupported SOCKS version ${bytes[0]}` };
  const count = bytes[1];
  if (bytes.length < 2 + count) return null;
  const methods = bytes.subarray(2, 2 + count);
  return { ok: true, wantsNoAuth: methods.includes(0x00) };
}

/**
 * Parse a CONNECT request. The address is returned as a string ssh2 accepts:
 * dotted quad, IPv6 text, or the domain name verbatim.
 * @returns `{ cmd, host, port }`, `{ ok: false, reason }`, or null for "need more bytes".
 */
export function parseRequest(bytes) {
  if (bytes.length < 4) return null;
  if (bytes[0] !== 0x05) return { ok: false, reason: `unsupported SOCKS version ${bytes[0]}` };
  const cmd = bytes[1];
  const atyp = bytes[3];
  if (cmd !== 0x01) return { cmd, unsupportedCommand: true };
  if (atyp === 0x01) {
    if (bytes.length < 10) return null;
    const host = `${bytes[4]}.${bytes[5]}.${bytes[6]}.${bytes[7]}`;
    return { cmd, host, port: bytes.readUInt16BE(8) };
  }
  if (atyp === 0x03) {
    if (bytes.length < 5) return null;
    const length = bytes[4];
    if (bytes.length < 5 + length + 2) return null;
    const host = bytes.subarray(5, 5 + length).toString("utf8");
    return { cmd, host, port: bytes.readUInt16BE(5 + length) };
  }
  if (atyp === 0x04) {
    if (bytes.length < 22) return null;
    const groups = [];
    for (let offset = 4; offset < 20; offset += 2) groups.push(bytes.readUInt16BE(offset).toString(16));
    return { cmd, host: groups.join(":"), port: bytes.readUInt16BE(20) };
  }
  return { ok: false, reason: `unsupported address type ${atyp}` };
}

/** The 10-byte reply frame; the bound address is always 0.0.0.0:0 (nothing to report). */
export function replyBytes(code) {
  return Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

/**
 * Serve one accepted socket: negotiate no-auth, open the requested address
 * through the SSH connection, then pipe both directions. Errors map to SOCKS
 * reply codes so a client sees "connection refused" rather than a hang.
 * @param socket - the accepted net.Socket.
 * @param options - { forwardOut(host, port, cb), onClose?() }.
 * @returns a disposer that stops serving and destroys the socket.
 */
export function attachSocks5(socket, { forwardOut, onClose }) {
  let buffer = Buffer.alloc(0);
  let state = "greeting";
  const closed = () => { try { onClose?.(); } catch { /* counting must never throw */ } };
  const fail = (code) => {
    try { socket.write(replyBytes(code)); } catch {}
    socket.destroy();
  };

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (state === "greeting") {
        const greeting = parseGreeting(buffer);
        if (greeting === null) return;
        if (greeting.ok === false || !greeting.wantsNoAuth) {
          // No-auth is the only method offered; anything else must be refused
          // explicitly or the client would wait forever.
          try { socket.write(Buffer.from([0x05, 0xff])); } catch {}
          socket.destroy();
          return;
        }
        buffer = buffer.subarray(2 + buffer[1]);
        state = "request";
        socket.write(Buffer.from([0x05, 0x00]));
        continue;
      }
      if (state === "request") {
        const request = parseRequest(buffer);
        if (request === null) return;
        if (request.ok === false) { fail(SOCKS_REPLY.ADDRESS_NOT_SUPPORTED); return; }
        if (request.unsupportedCommand) { fail(SOCKS_REPLY.COMMAND_NOT_SUPPORTED); return; }
        // 消费请求帧本身：残留 buffer 只含客户端在握手窗口内管线化的载荷，
        // 下面 flush 时必须只发这些字节，不能把握手帧一起写进隧道。
        // 长度按 atyp 直接算（不改 parseRequest 的返回契约）：v4=10、v6=22、域名=5+len+2。
        const atyp = buffer[3];
        const frameLength = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : atyp === 0x03 ? 5 + (buffer[4] ?? 0) + 2 : 0;
        buffer = buffer.subarray(frameLength);
        state = "open";
        // 握手完成即让解析器退役：否则后续每一个转发分块都会继续 concat 进
        // buffer，内存随流量无界增长（上游 0.3.22 实测 48MiB 转发 +204MiB 常驻）。
        socket.removeListener("data", onData);
        try {
          forwardOut(request.host, request.port, (error, stream) => {
            if (error || !stream) { fail(replyCodeForError(error)); return; }
            socket.write(replyBytes(SOCKS_REPLY.SUCCEEDED));
            stream.on("error", () => socket.destroy());
            socket.on("error", () => stream.destroy());
            // closed() 只在 socket close（下方一次注册）里调用：这里再调会把同一
            // 连接的计数减两次（上游 0.3.22 的第三个缺陷）。
            socket.on("close", () => { stream.destroy(); });
            stream.once("close", () => socket.destroy());
            // 握手窗口内客户端可能已管线化载荷：先 flush 已读到的残余再接管 pipe，
            // 否则这些字节既不在 buffer 转发里、也进不了之后的 pipe。
            if (buffer.length > 0) {
              const leftover = buffer;
              buffer = Buffer.alloc(0);
              try { stream.write(leftover); } catch { /* 对端已关：丢弃残余 */ }
            }
            socket.pipe(stream);
            stream.pipe(socket);
          });
        } catch (error) {
          // forwardOut 实现若同步 throw（ssh2 断线），按失败应答收口。
          fail(replyCodeForError(error));
        }
        return;
      }
      // Connected: everything after the request is payload handled by pipe().
      return;
    }
  };

  socket.on("data", onData);
  socket.on("error", () => socket.destroy());
  socket.on("close", closed);
  socket.on("end", () => socket.destroy());

  return () => {
    socket.removeListener("data", onData);
    socket.destroy();
  };
}
