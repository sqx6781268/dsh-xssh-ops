// Proxy failure diagnosis: each of the five SOCKS5 codes maps to the proxy
// stage with an actionable Chinese message, the retry classification is
// asymmetric, and the proxy password never appears in any diagnosis text.
import assert from "node:assert/strict";
import {
  classifyConnectFailure,
  formatConnectFailure,
  CONNECT_FAILURE_STAGES
} from "../src/ssh-auth.js";
import { isTransientConnectError } from "../src/net-errors.js";

function proxyError(code, extra = {}) {
  const err = new Error(`coded ${code}`);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const cases = [
  { code: "proxy-unreachable", expectReason: "proxy-unreachable" },
  { code: "proxy-timeout", expectReason: "proxy-timeout" },
  { code: "proxy-auth-required", expectReason: "proxy-auth-required" },
  { code: "proxy-auth-failed", expectReason: "proxy-auth-failed" },
  { code: "proxy-rejected", expectReason: "proxy-rejected", socksRep: 5 }
];

for (const { code, expectReason, socksRep } of cases) {
  const diagnosis = classifyConnectFailure(proxyError(code, socksRep !== undefined ? { socksRep } : {}));
  assert.equal(diagnosis.stage, CONNECT_FAILURE_STAGES.PROXY, `${code} is a proxy-stage failure`);
  assert.equal(diagnosis.reason, expectReason);
  assert.ok(diagnosis.message.length > 0, `${code} has a readable message`);
  assert.ok(Array.isArray(diagnosis.hints) && diagnosis.hints.length > 0, `${code} offers hints`);
}

// The rep code is surfaced on a CONNECT refusal so the agent can tell
// "refused" from "host unreachable".
{
  const d = classifyConnectFailure(proxyError("proxy-rejected", { socksRep: 5 }));
  assert.match(d.message, /rep=5/);
}

// formatConnectFailure renders message + hints without throwing.
{
  const text = formatConnectFailure(classifyConnectFailure(proxyError("proxy-timeout")), "192.168.10.11:22");
  assert.match(text, /192\.168\.10\.11:22/);
  assert.match(text, /127\.0\.0\.1/, "the forward-only hint mentions the 127.0.0.1 workaround");
}

// ── retry classification is asymmetric ──────────────────────────────────────
assert.equal(isTransientConnectError(proxyError("proxy-unreachable")), true, "unreachable retries");
assert.equal(isTransientConnectError(proxyError("proxy-timeout")), true, "timeout retries");
assert.equal(isTransientConnectError(proxyError("proxy-auth-required")), false, "missing credentials never retry");
assert.equal(isTransientConnectError(proxyError("proxy-auth-failed")), false, "bad credentials never retry");
assert.equal(isTransientConnectError(proxyError("proxy-rejected")), false, "a ruleset refusal never retries");

// A permanent proxy code whose wording happens to say "timeout" must still be
// permanent — the code whitelist decides, not the text.
{
  const tricky = proxyError("proxy-rejected");
  tricky.message = "connection timeout while proxy rejected";
  assert.equal(isTransientConnectError(tricky), false);
}

// ── the proxy password is never echoed ──────────────────────────────────────
{
  const secret = "super-secret-pw-9001";
  for (const code of ["proxy-unreachable", "proxy-timeout", "proxy-auth-required", "proxy-auth-failed", "proxy-rejected"]) {
    const err = proxyError(code, { proxyPassword: secret, password: secret });
    const text = formatConnectFailure(classifyConnectFailure(err), "h:22");
    assert.ok(!text.includes(secret), `${code} diagnosis must not echo the proxy password`);
  }
}

console.log("proxy-errors: proxy-stage diagnosis, asymmetric retry split and password redaction all passed");
