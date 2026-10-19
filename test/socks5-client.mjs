// SOCKS5 upstream *client* (the mirror of socks5.js): byte-level framing plus
// real round trips — against the in-repo SOCKS5 server for the happy path and
// hand-rolled mock proxies for each coded failure (auth required/failed,
// CONNECT refused, and the forward-only proxy that answers then goes silent).
import assert from "node:assert/strict";
import net from "node:net";
import {
  buildGreeting,
  parseMethodReply,
  buildUserPassAuth,
  parseUserPassReply,
  buildConnectRequest,
  parseConnectReply,
  atypForHost,
  replyCodeText,
  socks5Connect,
  METHOD_NO_AUTH,
  METHOD_USERPASS,
  METHOD_NONE_ACCEPTABLE,
  ATYP_IPV4,
  ATYP_DOMAIN,
  ATYP_IPV6
} from "../src/socks5-client.js";
import { attachSocks5 } from "../src/socks5.js";

// ── greeting ────────────────────────────────────────────────────────────────
// Without credentials only no-auth is advertised; with them 0x02 is added.
assert.deepEqual([...buildGreeting(false)], [0x05, 0x01, 0x00]);
assert.deepEqual([...buildGreeting(true)], [0x05, 0x02, 0x00, 0x02]);

// ── method reply ────────────────────────────────────────────────────────────
assert.equal(parseMethodReply(Buffer.from([0x05])), null, "one byte needs more");
assert.deepEqual(parseMethodReply(Buffer.from([0x05, 0x00])), { method: METHOD_NO_AUTH });
assert.deepEqual(parseMethodReply(Buffer.from([0x05, 0x02])), { method: METHOD_USERPASS });
assert.deepEqual(parseMethodReply(Buffer.from([0x05, 0xff])), { method: METHOD_NONE_ACCEPTABLE });
assert.equal(parseMethodReply(Buffer.from([0x04, 0x00])).ok, false, "non-SOCKS5 version rejected");

// ── username/password sub-negotiation (RFC 1929) ────────────────────────────
{
  const frame = buildUserPassAuth("alice", "secret");
  assert.equal(frame[0], 0x01, "sub-negotiation version");
  assert.equal(frame[1], 5, "username length");
  assert.equal(frame.toString("utf8", 2, 7), "alice");
  assert.equal(frame[7], 6, "password length");
  assert.equal(frame.toString("utf8", 8), "secret");
}
assert.throws(() => buildUserPassAuth("", "x"), /username/i, "empty username rejected");
assert.throws(() => buildUserPassAuth("a".repeat(256), "x"), /username/i, "overlong username rejected");
assert.throws(() => buildUserPassAuth("a", "x".repeat(256)), /password/i, "overlong password rejected");
assert.equal(parseUserPassReply(Buffer.from([0x01])), null);
assert.deepEqual(parseUserPassReply(Buffer.from([0x01, 0x00])), { ok: true });
assert.deepEqual(parseUserPassReply(Buffer.from([0x01, 0x01])), { ok: false });

// ── address type + CONNECT request framing ──────────────────────────────────
assert.equal(atypForHost("127.0.0.1"), ATYP_IPV4);
assert.equal(atypForHost("::1"), ATYP_IPV6);
assert.equal(atypForHost("2001:db8::1"), ATYP_IPV6);
assert.equal(atypForHost("db.internal"), ATYP_DOMAIN);

{
  // Domain target is sent verbatim (atyp=3) so the proxy does the DNS.
  const name = Buffer.from("db.internal", "utf8");
  const expected = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, Buffer.from([0x01, 0xbb])
  ]);
  assert.deepEqual(buildConnectRequest("db.internal", 443), expected);
}
{
  const frame = buildConnectRequest("192.168.10.11", 22);
  assert.deepEqual([...frame], [0x05, 0x01, 0x00, 0x01, 192, 168, 10, 11, 0x00, 0x16]);
}
{
  const frame = buildConnectRequest("2001:db8::1", 22);
  assert.equal(frame[3], ATYP_IPV6);
  assert.equal(frame.length, 22, "VER CMD RSV ATYP + 16-byte addr + port");
  assert.deepEqual([...frame.subarray(4, 20)], [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(frame.readUInt16BE(20), 22);
}
assert.throws(() => buildConnectRequest("h", 0), /port/i);
assert.throws(() => buildConnectRequest("h", 70000), /port/i);
assert.throws(() => buildConnectRequest("", 22), /domain/i);

// ── CONNECT reply ───────────────────────────────────────────────────────────
assert.equal(parseConnectReply(Buffer.from([0x05, 0x00, 0x00])), null, "header needs the bound address");
assert.deepEqual(parseConnectReply(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])), { ok: true });
assert.deepEqual(parseConnectReply(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])), { ok: false, rep: 5 });
assert.equal(parseConnectReply(Buffer.from([0x04, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])).ok, false, "bad version");
assert.match(replyCodeText(5), /refused/i);

// ── helpers for real round trips ────────────────────────────────────────────
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(() => resolve()));
// 读取固定长度的响应（真实往返用例需要它；当前用例走的是"读到握手结束"为止的路径，
// 所以这里暂时没有调用点 —— 保留上游实现而不是删掉，避免下次要加用例时重写）
// eslint-disable-next-line no-unused-vars
const readExactly = (socket, n) => new Promise((resolve, reject) => {
  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length >= n) { socket.removeListener("data", onData); resolve(buffer.subarray(0, n)); }
  };
  socket.on("data", onData);
  socket.once("error", reject);
});

const echo = net.createServer((socket) => socket.pipe(socket));
const echoPort = await listen(echo);

// The in-repo no-auth SOCKS5 server fronts a real upstream connection.
const realProxy = net.createServer((socket) => attachSocks5(socket, {
  forwardOut: (host, port, cb) => {
    const upstream = net.connect(port, host);
    upstream.once("connect", () => cb(null, upstream));
    upstream.once("error", (error) => cb(error));
  }
}));
const realProxyPort = await listen(realProxy);

// Happy path: CONNECT by domain name, payload round-trips through the proxy.
{
  const stream = await socks5Connect({
    proxy: { host: "127.0.0.1", port: realProxyPort },
    target: { host: "127.0.0.1", port: echoPort },
    timeoutMs: 5000
  });
  assert.ok(stream.writable, "a live stream is returned for ssh2 config.sock");
  const echoed = await new Promise((resolve, reject) => {
    let got = Buffer.alloc(0);
    const onData = (c) => {
      got = Buffer.concat([got, c]);
      if (got.length >= 5) { stream.destroy(); resolve(got.subarray(0, 5).toString()); }
    };
    stream.on("data", onData);
    stream.once("error", reject);
    stream.write("ping!");
  });
  assert.equal(echoed, "ping!");
}

// proxy-unreachable: nothing listens on the proxy port.
{
  const dead = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  await assert.rejects(
    () => socks5Connect({ proxy: { host: "127.0.0.1", port: dead }, target: { host: "x", port: 22 }, timeoutMs: 3000 }),
    (err) => err.code === "proxy-unreachable"
  );
}

// A proxy that forces user/pass but the client configured none → auth-required.
{
  const srv = net.createServer((socket) => {
    socket.once("data", () => { socket.write(Buffer.from([0x05, 0x02])); }); // select user/pass
    setTimeout(() => socket.destroy(), 500);
  });
  const port = await listen(srv);
  await assert.rejects(
    () => socks5Connect({ proxy: { host: "127.0.0.1", port }, target: { host: "x", port: 22 }, timeoutMs: 3000 }),
    (err) => err.code === "proxy-auth-required"
  );
  await close(srv);
}

// A proxy that rejects the credentials → auth-failed.
{
  const srv = net.createServer((socket) => {
    let stage = 0;
    socket.on("data", () => {
      if (stage === 0) { socket.write(Buffer.from([0x05, 0x02])); stage = 1; return; }
      socket.write(Buffer.from([0x01, 0x01])); // auth rejected
      setTimeout(() => socket.destroy(), 100);
    });
  });
  const port = await listen(srv);
  await assert.rejects(
    () => socks5Connect({
      proxy: { host: "127.0.0.1", port, username: "u", password: "wrong" },
      target: { host: "x", port: 22 }, timeoutMs: 3000
    }),
    (err) => err.code === "proxy-auth-failed"
  );
  await close(srv);
}

// With correct credentials the handshake proceeds and CONNECT succeeds.
{
  const srv = net.createServer((socket) => {
    let stage = 0;
    const up = net.connect(echoPort, "127.0.0.1");
    socket.on("data", (chunk) => {
      if (stage === 0) { socket.write(Buffer.from([0x05, 0x02])); stage = 1; return; }
      if (stage === 1) {
        assert.equal(chunk[0], 0x01);
        socket.write(Buffer.from([0x01, 0x00])); // auth OK
        stage = 2;
        return;
      }
      if (stage === 2) {
        // CONNECT accepted; future bytes (the payload) pipe to the echo server.
        // The chunk in hand is the CONNECT request itself, not payload, so it is
        // deliberately not forwarded — pipe() only carries what arrives next.
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        socket.pipe(up); up.pipe(socket);
        stage = 3;
      }
      // stage 3: payload is handled by pipe(), nothing to do here.
    });
  });
  const port = await listen(srv);
  const stream = await socks5Connect({
    proxy: { host: "127.0.0.1", port, username: "u", password: "p" },
    target: { host: "127.0.0.1", port: echoPort }, timeoutMs: 3000
  });
  const echoed = await new Promise((resolve) => {
    stream.once("data", (c) => { stream.destroy(); resolve(c.toString()); });
    stream.write("auth!");
  });
  assert.equal(echoed, "auth!");
  await close(srv);
}

// CONNECT refused by the proxy → proxy-rejected carrying the RFC rep code.
{
  const dead = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  await assert.rejects(
    () => socks5Connect({
      proxy: { host: "127.0.0.1", port: realProxyPort },
      target: { host: "127.0.0.1", port: dead }, timeoutMs: 3000
    }),
    (err) => err.code === "proxy-rejected" && err.socksRep === 5
  );
}

// Forward-only proxy that completes the greeting/connect reply then closes with
// no data (the 18092 behaviour for a disallowed target) → proxy-timeout class.
{
  const srv = net.createServer((socket) => {
    let stage = 0;
    socket.on("data", () => {
      if (stage === 0) { socket.write(Buffer.from([0x05, 0x00])); stage = 1; return; }
      socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      socket.end(); // answer success then shut up — nothing ever flows
    });
  });
  const port = await listen(srv);
  // The CONNECT reply itself is success, so socks5Connect resolves; the silence
  // is observable to ssh2 as an EOF during the banner read, classified upstream.
  const stream = await socks5Connect({
    proxy: { host: "127.0.0.1", port },
    target: { host: "10.0.0.9", port: 22 }, timeoutMs: 3000
  });
  const closed = await new Promise((resolve) => stream.once("close", () => resolve(true)));
  assert.ok(closed, "the half-open channel closes with no payload");
  await close(srv);
}

// Hard handshake deadline → proxy-timeout (proxy accepts but never replies).
{
  const srv = net.createServer((socket) => socket.once("data", () => {})); // swallow, stay silent
  const port = await listen(srv);
  await assert.rejects(
    () => socks5Connect({ proxy: { host: "127.0.0.1", port }, target: { host: "x", port: 22 }, timeoutMs: 300 }),
    (err) => err.code === "proxy-timeout"
  );
  await close(srv);
}

await close(realProxy);
await close(echo);
console.log("socks5-client: framing, auth negotiation, happy path and every coded failure passed");
