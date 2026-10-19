// xssh_proxy_test host method: a successful probe reports reachable + the SSH
// banner; a failed probe reports the coded reason + actionable hints and never
// echoes the proxy password. Drives service.proxyTest through a REAL local
// no-auth SOCKS5 proxy (attachSocks5) so the CONNECT framing is production.
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import SshOpsService from "../src/index.js";
import { attachSocks5 } from "../src/socks5.js";

const BANNER = "SSH-2.0-OpenSSH_7.4\r\n";

function startBannerServer() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => { socket.write(BANNER); socket.on("error", () => {}); });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}
function startSocksProxy() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      attachSocks5(socket, {
        forwardOut(host, port, cb) {
          const upstream = net.createConnection({ host, port });
          const onError = (error) => cb(error);
          upstream.once("error", onError);
          upstream.once("connect", () => { upstream.off("error", onError); cb(null, upstream); });
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const service = Object.create(SshOpsService.prototype);
const bannerServer = await startBannerServer();
const proxyServer = await startSocksProxy();
try {
  const bannerPort = bannerServer.address().port;
  const proxyPort = proxyServer.address().port;

  // ── success: reachable + banner + latency ─────────────────────────────────
  const ok = await service.proxyTest({
    proxy: { type: "socks5", host: "127.0.0.1", port: proxyPort },
    target: { host: "127.0.0.1", port: bannerPort }
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.reachable, true);
  assert.match(ok.value.banner, /^SSH-2\.0-OpenSSH_7\.4/);
  assert.equal(ok.value.targetPort, bannerPort);
  assert.equal(typeof ok.value.elapsedMs, "number");
  assert.equal(ok.value.authenticated, false);

  // ── refusal: closed target port → reachable false + proxy-rejected ────────
  const closed = net.createServer();
  await once(closed.listen(0, "127.0.0.1"), "listening");
  const closedPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  const bad = await service.proxyTest({
    proxy: { type: "socks5", host: "127.0.0.1", port: proxyPort, username: "gw", password: "super-secret-9001" },
    target: { host: "127.0.0.1", port: closedPort }
  });
  assert.equal(bad.ok, true, "a failed probe still resolves the envelope (reachable=false), it does not throw");
  assert.equal(bad.value.reachable, false);
  assert.equal(bad.value.errorCode, "proxy-rejected");
  assert.ok(Array.isArray(bad.value.hints) && bad.value.hints.length > 0, "failure carries actionable hints");
  assert.equal(bad.value.authenticated, true);
  // The proxy password must never appear anywhere in the diagnostic payload.
  const serialized = JSON.stringify(bad.value);
  assert.ok(!serialized.includes("super-secret-9001"), "proxy password is not echoed");

  // ── unreachable proxy → proxy-unreachable code ───────────────────────────
  const down = await service.proxyTest({
    proxy: { type: "socks5", host: "127.0.0.1", port: 9 },
    target: { host: "127.0.0.1", port: bannerPort }
  });
  assert.equal(down.value.reachable, false);
  assert.equal(down.value.errorCode, "proxy-unreachable");
} finally {
  await new Promise((r) => bannerServer.close(r));
  await new Promise((r) => proxyServer.close(r));
}

console.log("proxy-tool: probe success banner, coded refusal without password leak and unreachable code all passed");
