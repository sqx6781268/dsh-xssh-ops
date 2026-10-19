// End-to-end dial wiring through a REAL SOCKS5 proxy (the in-repo no-auth
// server, attachSocks5, fronting a banner-only TCP target). Proves the host's
// openProxySock actually traverses the proxy rather than dialing directly,
// plus the no-proxy passthrough and a CONNECT-refusal (rep=5) code path.
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import SshOpsService from "../src/index.js";
import { attachSocks5 } from "../src/socks5.js";

const BANNER = "SSH-2.0-OpenSSH_7.4\r\n";

function startBannerServer() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.write(BANNER);
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// A standalone, no-auth SOCKS5 CONNECT proxy: the production server handshake
// (attachSocks5) on every accepted socket, forwarding via real TCP.
function startSocksProxy() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      attachSocks5(socket, {
        forwardOut(host, port, cb) {
          const upstream = net.createConnection({ host, port });
          const onError = (error) => cb(error);
          upstream.once("error", onError);
          upstream.once("connect", () => {
            upstream.off("error", onError);
            cb(null, upstream);
          });
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function bareService() {
  const service = Object.create(SshOpsService.prototype);
  return service;
}

function recordFor(proxy, host, port) {
  return {
    connectConfig: { host, port, readyTimeout: 8000 },
    ...(proxy ? { proxyConfig: proxy } : {})
  };
}

function readFrame(socket, bytes = BANNER.length) {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error("timed out waiting for banner")), 5000);
    socket.on("data", function onData(chunk) {
      received = Buffer.concat([received, chunk]);
      if (received.length >= bytes) {
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(received.subarray(0, bytes).toString());
      }
    });
    socket.on("error", reject);
  });
}

// ── happy path: the target banner arrives THROUGH the proxy ─────────────────
const bannerServer = await startBannerServer();
const proxyServer = await startSocksProxy();
try {
  const bannerAddr = bannerServer.address();
  const proxyAddr = proxyServer.address();
  const service = bareService();

  const sock = await service.openProxySock(
    recordFor(
      { type: "socks5", host: "127.0.0.1", port: proxyAddr.port },
      "127.0.0.1",
      bannerAddr.port
    )
  );
  assert.ok(sock instanceof net.Socket, "a live socket is handed back for ssh2's config.sock");
  const got = await readFrame(sock);
  assert.equal(got, BANNER, "the SSH banner reaches us through the SOCKS5 tunnel, byte-identical");
  sock.destroy();

  // ── no proxy configured → passthrough (ssh2 keeps its own socket) ────────
  const none = await service.openProxySock(recordFor(undefined, "127.0.0.1", bannerAddr.port));
  assert.equal(none, undefined, "without a proxy openProxySock yields undefined");

  // ── CONNECT to a closed port → rep=5 surfaces as proxy-rejected ──────────
  // Pick a port with nothing listening; the proxy's forwardOut gets
  // ECONNREFUSED and answers rep=5, which the client maps to proxy-rejected.
  const closed = net.createServer();
  await once(closed.listen(0, "127.0.0.1"), "listening");
  const closedPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  await assert.rejects(
    () => service.openProxySock(
      recordFor({ type: "socks5", host: "127.0.0.1", port: proxyAddr.port }, "127.0.0.1", closedPort)
    ),
    (error) => error.code === "proxy-rejected" && error.socksRep === 5
  );

  // ── proxy port unreachable → proxy-unreachable, not a raw OS error ───────
  await assert.rejects(
    () => service.openProxySock(
      recordFor({ type: "socks5", host: "127.0.0.1", port: 9 }, "127.0.0.1", bannerAddr.port)
    ),
    (error) => error.code === "proxy-unreachable"
  );
} finally {
  await new Promise((r) => bannerServer.close(r));
  await new Promise((r) => proxyServer.close(r));
}

console.log("proxy-dial: banner through a real SOCKS5 proxy, passthrough and coded refusals all passed");
