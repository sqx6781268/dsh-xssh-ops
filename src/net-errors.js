/**
 * Connect retry policy: classify a failed SSH handshake as transient (worth
 * retrying with backoff) or permanent (surface immediately). Based on the
 * error's `code` first — ssh2 surfaces socket errors as Node errno codes —
 * with a message fallback for protocol-level failures that carry no code.
 * Authentication failures are never retried regardless of wording.
 *
 * The SOCKS5 upstream proxy layer (src/socks5-client.js) raises its own STRING
 * codes, so the retry verdict is decided by code rather than by wording. The
 * split is deliberate and asymmetric:
 *
 *   transient — retried with backoff
 *     proxy-unreachable  the proxy host/port could not be reached at all
 *     proxy-timeout      the proxy handshake ran past its deadline
 *   permanent — surfaced immediately
 *     proxy-auth-required the proxy demands credentials that were not configured
 *     proxy-auth-failed   the proxy rejected the configured credentials
 *     proxy-rejected      the proxy refused the CONNECT (RFC 1928 rep code)
 *
 * A credential-shaped proxy failure must never be retried: the stored password
 * does not become correct on the next attempt, so every retry just adds another
 * backoff sleep before the operator sees the real reason.
 */

/** Node errno codes that mean "the network hiccuped, try again". */
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "EPIPE"
]);

/** Proxy-layer codes that are bad luck rather than a settled fact. */
export const PROXY_TRANSIENT_CODES = new Set([
  "proxy-unreachable",
  "proxy-timeout"
]);

/** Proxy-layer codes that will not change no matter how long the backoff is. */
export const PROXY_PERMANENT_CODES = new Set([
  "proxy-auth-required",
  "proxy-auth-failed",
  "proxy-rejected"
]);

const TRANSIENT_CODES = new Set([...TRANSIENT_NETWORK_CODES, ...PROXY_TRANSIENT_CODES]);

const PERMANENT_MESSAGE_RE = /authenticat|permission|denied/i;
const TRANSIENT_MESSAGE_RE = /reset|timeout|timed out|kex|handshake|socket/i;

/**
 * Code-less proxy wording that must not be mistaken for a transient network
 * error. Only consulted when the error carries no `code`: a coded
 * `proxy-timeout` whose text happens to mention authentication is still a
 * timeout, and the whitelist above already answered for it.
 */
const PROXY_PERMANENT_MESSAGE_RE = /proxy[\s_-]*auth|代理.{0,6}(认证|凭据|用户名)/i;

export function isTransientConnectError(error) {
  const code = error?.code === undefined ? "" : String(error.code);
  // Checked before the whitelist, not after: these codes are known to be
  // permanent, and a future edit that adds one to TRANSIENT_CODES by accident
  // must not be able to turn a rejected password into a retry loop.
  if (PROXY_PERMANENT_CODES.has(code)) return false;
  if (code !== "" && !TRANSIENT_CODES.has(code)) return false;
  const message = String(error?.message ?? error);
  if (PERMANENT_MESSAGE_RE.test(message)) return false;
  if (code === "" && PROXY_PERMANENT_MESSAGE_RE.test(message)) return false;
  return TRANSIENT_CODES.has(code) || TRANSIENT_MESSAGE_RE.test(message);
}
