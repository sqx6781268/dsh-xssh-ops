/**
 * Minimal SOCKS5 *client* (RFC 1928 + RFC 1929 username/password auth) — the
 * mirror of src/socks5.js. Where socks5.js provides a proxy (the `ssh -D`
 * direction), this module consumes one: it dials an upstream SOCKS5 proxy,
 * asks it to CONNECT the final target, and hands back the raw stream once the
 * proxy replies "succeeded". ssh2 takes that pre-connected stream via
 * config.sock, so the SSH handshake then runs through the proxy unchanged.
 *
 * Only CONNECT is implemented (BIND / UDP ASSOCIATE are not needed for reaching
 * an SSH server). Domain targets are sent verbatim with atyp=3 so the *proxy*
 * performs DNS — the plugin host never has to resolve an internal name.
 *
 * The framing helpers are pure functions so the protocol is unit-testable
 * without a socket; socks5Connect() wires them to a real net.Socket.
 *
 * Every failure carries one of the stable STRING codes consumed by
 * src/net-errors.js and src/ssh-auth.js:
 *   proxy-unreachable   could not open a TCP connection to the proxy
 *   proxy-timeout       a deadline elapsed (connect or handshake)
 *   proxy-auth-required the proxy demands user/pass but none were configured
 *   proxy-auth-failed   the proxy rejected the configured user/pass
 *   proxy-rejected      the proxy refused CONNECT (RFC 1928 reply code attached)
 */

import net from "node:net";

export const SOCKS5_VERSION = 0x05;
export const METHOD_NO_AUTH = 0x00;
export const METHOD_USERPASS = 0x02;
export const METHOD_NONE_ACCEPTABLE = 0xff;
export const CMD_CONNECT = 0x01;
export const ATYP_IPV4 = 0x01;
export const ATYP_DOMAIN = 0x03;
export const ATYP_IPV6 = 0x04;

/** RFC 1928 §6 reply codes that are not "succeeded". */
export const SOCKS5_REPLY = Object.freeze({
  GENERAL_FAILURE: 0x01,
  CONNECTION_NOT_ALLOWED: 0x02,
  NETWORK_UNREACHABLE: 0x03,
  HOST_UNREACHABLE: 0x04,
  CONNECTION_REFUSED: 0x05,
  TTL_EXPIRED: 0x06,
  COMMAND_NOT_SUPPORTED: 0x07,
  ADDRESS_NOT_SUPPORTED: 0x08
});

/** Human-readable meaning of an RFC 1928 reply code (0 is success). */
const REPLY_TEXT = {
  0x01: "general SOCKS server failure",
  0x02: "connection not allowed by ruleset",
  0x03: "network unreachable",
  0x04: "host unreachable",
  0x05: "connection refused",
  0x06: "TTL expired",
  0x07: "command not supported",
  0x08: "address type not supported"
};

export function replyCodeText(rep) {
  return REPLY_TEXT[rep] ?? `unknown reply code ${rep}`;
}

/**
 * Build the method-selection greeting.
 * RFC 1928 §3: VER, NMETHODS, METHODS...
 *
 * User/pass (0x02) is offered ONLY when credentials actually exist. Some
 * proxies pick 0x02 whenever it is on offer even though they would have
 * accepted no-auth (0x00), so advertising 0x02 unconditionally would force an
 * authentication round (and a failure) against a proxy that needed none.
 */
export function buildGreeting(hasCredentials) {
  const methods = hasCredentials ? [METHOD_NO_AUTH, METHOD_USERPASS] : [METHOD_NO_AUTH];
  return Buffer.from([SOCKS5_VERSION, methods.length, ...methods]);
}

/**
 * Parse the 2-byte method-selection reply (VER, METHOD).
 * @returns `{ method }`, `{ ok: false, reason }`, or null when more bytes are needed.
 */
export function parseMethodReply(bytes) {
  if (bytes.length < 2) return null;
  if (bytes[0] !== SOCKS5_VERSION) {
    return { ok: false, reason: `proxy is not SOCKS5 (bad version byte 0x${bytes[0].toString(16)})` };
  }
  return { method: bytes[1] };
}

/**
 * Build an RFC 1929 username/password sub-negotiation request.
 * VER(0x01), ULEN, UNAME, PLEN, PASSWD — fields are one length-prefixed byte
 * each, so names/passwords longer than 255 bytes cannot be encoded and are
 * rejected up front rather than truncated.
 */
export function buildUserPassAuth(username, password) {
  const user = Buffer.from(String(username ?? ""), "utf8");
  const pass = Buffer.from(String(password ?? ""), "utf8");
  if (user.length === 0 || user.length > 255) {
    throw new Error("SOCKS5 username must be 1-255 bytes");
  }
  if (pass.length > 255) {
    throw new Error("SOCKS5 password must be at most 255 bytes");
  }
  return Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]);
}

/**
 * Parse the RFC 1929 reply (VER, STATUS); status 0 = success.
 * @returns `{ ok: true }`, `{ ok: false }`, or null when more bytes are needed.
 */
export function parseUserPassReply(bytes) {
  if (bytes.length < 2) return null;
  return { ok: bytes[1] === 0x00 };
}

/** Decide the SOCKS5 address type for a host literal. */
export function atypForHost(host) {
  const kind = net.isIP(host);
  if (kind === 4) return ATYP_IPV4;
  if (kind === 6) return ATYP_IPV6;
  return ATYP_DOMAIN;
}

/**
 * Build a CONNECT request for host:port.
 * RFC 1928 §4: VER, CMD, RSV, ATYP, DST.ADDR, DST.PORT.
 * Domains are length-prefixed (atyp=3); IPv4 is 4 raw bytes; IPv6 is 16.
 */
export function buildConnectRequest(host, port) {
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error(`SOCKS5 target port out of range: ${port}`);
  }
  const head = Buffer.from([SOCKS5_VERSION, CMD_CONNECT, 0x00]);
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(portNum, 0);

  const atyp = atypForHost(host);
  if (atyp === ATYP_IPV4) {
    const parts = String(host).split(".").map((n) => Number(n));
    const addr = Buffer.from(parts);
    return Buffer.concat([head, Buffer.from([ATYP_IPV4]), addr, portBuf]);
  }
  if (atyp === ATYP_IPV6) {
    const addr = ipToBuf(String(host));
    return Buffer.concat([head, Buffer.from([ATYP_IPV6]), addr, portBuf]);
  }
  const domain = Buffer.from(String(host), "utf8");
  if (domain.length === 0 || domain.length > 255) {
    throw new Error("SOCKS5 target domain must be 1-255 bytes");
  }
  return Buffer.concat([head, Buffer.from([ATYP_DOMAIN, domain.length]), domain, portBuf]);
}

/** Parse an IPv6 literal into its 16-byte representation (net is always available). */
function ipToBuf(ip) {
  // Expand "::" then write each of the 8 groups big-endian.
  let head = ip;
  let tail = "";
  const dc = ip.indexOf("::");
  if (dc !== -1) {
    head = ip.slice(0, dc);
    tail = ip.slice(dc + 2);
  }
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const groups = new Array(8).fill("0");
  headGroups.forEach((g, i) => { groups[i] = g; });
  const missing = 8 - headGroups.length - tailGroups.length;
  tailGroups.forEach((g, i) => { groups[headGroups.length + missing + i] = g; });
  const buf = Buffer.alloc(16);
  groups.forEach((g, i) => buf.writeUInt16BE(parseInt(g || "0", 16), i * 2));
  return buf;
}

/**
 * Parse the CONNECT reply. Only the fixed header up through BND.ADDR is needed
 * to learn success/failure; the bound address is ignored (the caller dials out,
 * it never needs to know where the proxy bound the far end).
 * @returns `{ ok:true }`, `{ ok:false, rep }`, `{ ok:false, reason }`, or null
 *   when more bytes are needed.
 */
export function parseConnectReply(bytes) {
  if (bytes.length < 4) return null;
  if (bytes[0] !== SOCKS5_VERSION) {
    return { ok: false, reason: `proxy is not SOCKS5 (bad version byte 0x${bytes[0].toString(16)})` };
  }
  const rep = bytes[1];
  const atyp = bytes[3];
  // Need enough bytes to cover the bound address so a short/garbage frame is
  // treated as "need more" rather than misread. Variable-length domain first
  // byte gives its length.
  if (atyp === ATYP_IPV4 && bytes.length < 10) return null;
  if (atyp === ATYP_IPV6 && bytes.length < 22) return null;
  if (atyp === ATYP_DOMAIN) {
    if (bytes.length < 5) return null;
    if (bytes.length < 5 + bytes[4] + 2) return null;
  }
  if (rep !== 0x00) return { ok: false, rep };
  return { ok: true };
}

/** Construct a coded proxy Error understood by net-errors / ssh-auth. */
function proxyError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/**
 * Read bytes from a socket until `parse` returns non-null, then resolve with
 * that value. Used for the three tiny, fixed SOCKS exchanges. Timeout is owned
 * by the caller (socket.setTimeout + one overall deadline in socks5Connect),
 * so this helper only deals with data/close/error — a close with no complete
 * frame is reported as proxy-timeout, which also matches a forward-only proxy
 * that answers CONNECT then immediately shuts the socket.
 */
function readReply(socket, parse) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let parsed;
      try {
        parsed = parse(buf);
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      if (parsed === null) return; // need more bytes
      cleanup();
      resolve(parsed);
    };
    const onClose = () => {
      cleanup();
      reject(proxyError("proxy-timeout",
        buf.length === 0
          ? "proxy closed the connection without replying (it may only forward to its own local ports; try target host 127.0.0.1 with the proxy-side port)"
          : "proxy closed the connection mid-handshake"));
    };
    const onError = (err) => { cleanup(); reject(err); };
    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("close", onClose);
      socket.removeListener("error", onError);
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

/**
 * Dial through a SOCKS5 proxy to target host:port.
 *
 * @param {object} options
 * @param {{host:string, port:number, username?:string, password?:string}} options.proxy
 * @param {{host:string, port:number}} options.target
 * @param {number} [options.timeoutMs=10000] overall deadline for connect + handshake
 * @returns {Promise<import("node:net").Socket>} a connected, proxied stream
 *   (the SSH client passes it as config.sock). Resolves once the proxy has
 *   accepted CONNECT; rejects with a coded proxy Error otherwise.
 */
export function socks5Connect({ proxy, target, timeoutMs = 10000 }) {
  if (!proxy || typeof proxy.host !== "string" || proxy.host === "") {
    return Promise.reject(proxyError("proxy-unreachable", "SOCKS5 proxy host is empty"));
  }
  const proxyPort = Number(proxy.port);
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    return Promise.reject(proxyError("proxy-unreachable", `SOCKS5 proxy port out of range: ${proxy.port}`));
  }
  if (!target || typeof target.host !== "string" || target.host === "") {
    return Promise.reject(proxyError("proxy-rejected", "SOCKS5 target host is empty"));
  }

  const hasCredentials = Boolean(proxy.username) || Boolean(proxy.password);
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const overallTimer = setTimeout(() => finish(proxyError("proxy-timeout",
      `SOCKS5 connection timed out after ${timeoutMs}ms`)), timeoutMs);
    overallTimer.unref?.();

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      socket.destroy();
      reject(err);
    };
    const succeed = (stream) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      // Hand the live socket over; remove the connect-timeout guard but keep
      // the stream usable by ssh2 (which installs its own listeners).
      stream.removeAllListeners("close");
      stream.removeAllListeners("error");
      resolve(stream);
    };

    socket.setTimeout(Math.max(1, deadline - Date.now()));
    socket.once("timeout", () => finish(proxyError("proxy-timeout",
      `timed out connecting to SOCKS5 proxy ${proxy.host}:${proxyPort}`)));
    socket.once("error", (err) => {
      if (settled) return;
      const code = ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "ECONNRESET"].includes(err.code)
        ? "proxy-unreachable"
        : "proxy-unreachable";
      finish(proxyError(code,
        `cannot reach SOCKS5 proxy ${proxy.host}:${proxyPort} (${err.code || err.message})`,
        { cause: err }));
    });

    socket.connect(proxyPort, proxy.host, async () => {
      try {
        socket.setTimeout(Math.max(1, deadline - Date.now()));
        // 1) greeting → method selection
        socket.write(buildGreeting(hasCredentials));
        const methodReply = await readReply(socket, parseMethodReply);
        if (methodReply.ok === false) {
          finish(proxyError("proxy-rejected", methodReply.reason));
          return;
        }
        const method = methodReply.method;
        if (method === METHOD_NONE_ACCEPTABLE) {
          finish(proxyError("proxy-auth-required",
            "SOCKS5 proxy requires authentication but offered no acceptable method"));
          return;
        }
        if (method === METHOD_USERPASS) {
          if (!proxy.username) {
            finish(proxyError("proxy-auth-required",
              "SOCKS5 proxy requires username/password but none are configured"));
            return;
          }
          socket.write(buildUserPassAuth(proxy.username, proxy.password ?? ""));
          const authReply = await readReply(socket, parseUserPassReply);
          if (!authReply.ok) {
            finish(proxyError("proxy-auth-failed",
              "SOCKS5 proxy rejected the username/password"));
            return;
          }
        } else if (method !== METHOD_NO_AUTH) {
          finish(proxyError("proxy-rejected",
            `SOCKS5 proxy selected unsupported auth method 0x${method.toString(16)}`));
          return;
        }

        // 2) CONNECT the final target
        socket.write(buildConnectRequest(target.host, target.port));
        const connectReply = await readReply(socket, parseConnectReply);
        if (connectReply.ok === false) {
          if (connectReply.reason) {
            finish(proxyError("proxy-rejected", connectReply.reason));
            return;
          }
          const rep = connectReply.rep;
          finish(proxyError("proxy-rejected",
            `SOCKS5 proxy refused CONNECT to ${target.host}:${target.port}: ${replyCodeText(rep)} (rep=${rep})`,
            { socksRep: rep }));
          return;
        }
        socket.setTimeout(0);
        succeed(socket);
      } catch (err) {
        if (err && err.code && String(err.code).startsWith("proxy-")) {
          finish(err);
        } else {
          finish(proxyError("proxy-timeout", `SOCKS5 handshake failed: ${err.message || err}`));
        }
      }
    });
  });
}
