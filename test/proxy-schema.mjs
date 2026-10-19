// Proxy schema contract: optional everywhere (zero migration), the recorded
// proxy never carries a password, the one-shot connect proxy may, and the
// type discriminator is locked to "socks5".
import assert from "node:assert/strict";
import {
  connectRequestSchema,
  profileSaveRequestSchema,
  profileInfoSchema,
  profileCredentialRefsSchema
} from "../src/schemas.js";

const baseConnect = {
  host: "192.168.10.11", port: 22, username: "root",
  credentialId: "123e4567-e89b-12d3-a456-426614174000"
};
const baseProfile = {
  name: "srv", host: "192.168.10.11", port: 22, username: "root", authKind: "password"
};

// ── connect: proxy is optional (zero migration for existing quick connects) ─
assert.doesNotThrow(() => connectRequestSchema.parse(baseConnect));

// A one-shot connect proxy may carry an inline password.
{
  const parsed = connectRequestSchema.parse({
    ...baseConnect,
    proxy: { type: "socks5", host: "192.168.10.4", port: 1080, username: "u", password: "p" }
  });
  assert.equal(parsed.proxy.host, "192.168.10.4");
  assert.equal(parsed.proxy.password, "p");
}
// No-auth proxy: just host/port.
assert.doesNotThrow(() => connectRequestSchema.parse({
  ...baseConnect, proxy: { type: "socks5", host: "192.168.10.4", port: 1080 }
}));

// Unknown proxy type is rejected (discriminator locked).
assert.throws(() => connectRequestSchema.parse({
  ...baseConnect, proxy: { type: "http", host: "h", port: 8080 }
}));
// Bad port / empty host rejected.
assert.throws(() => connectRequestSchema.parse({
  ...baseConnect, proxy: { type: "socks5", host: "h", port: 70000 }
}));
assert.throws(() => connectRequestSchema.parse({
  ...baseConnect, proxy: { type: "socks5", host: "", port: 1080 }
}));

// ── profile save: proxy + out-of-band password ──────────────────────────────
// A legacy save with no proxy field at all still validates (zero migration).
assert.doesNotThrow(() => profileSaveRequestSchema.parse(baseProfile));

{
  const parsed = profileSaveRequestSchema.parse({
    ...baseProfile,
    proxy: { type: "socks5", host: "192.168.10.4", port: 1080, username: "u" }
  });
  assert.deepEqual(parsed.proxy, { type: "socks5", host: "192.168.10.4", port: 1080, username: "u" });
}

// The save request carries no proxy-password channel at all — the secret is
// written to the credential store against the returned ref, so a proxyPassword
// key on the request body is simply stripped (never persisted).
{
  const parsed = profileSaveRequestSchema.parse({
    ...baseProfile,
    proxy: { type: "socks5", host: "h", port: 1080 },
    proxyPassword: "secret"
  });
  assert.equal("proxyPassword" in parsed, false, "the save request never keeps a proxy password");
}

// The SAVED proxy shape must NOT keep an inline password — zod strips unknown
// keys by default, so the password is dropped from the parsed record rather
// than persisted. The password only travels via proxyPassword into the store.
{
  const parsed = profileSaveRequestSchema.parse({
    ...baseProfile,
    proxy: { type: "socks5", host: "h", port: 1080, password: "leaked" }
  });
  assert.equal("password" in parsed.proxy, false, "an inline password on the recorded proxy is stripped");
  assert.equal(parsed.proxyPassword, undefined, "no password leaks onto the request either");
}

// ── profile info: proxy is present-but-passwordless + configured flag ───────
{
  const info = {
    ...baseProfile,
    profileId: "123e4567-e89b-12d3-a456-426614174000",
    groupId: null, groupName: null,
    credentialConfigured: true, passphraseConfigured: false, secondaryConfigured: false,
    connected: false, credentialId: null, credentialName: null,
    proxyJump: [], defaultProjectPath: null, loginCommand: null,
    proxy: { type: "socks5", host: "h", port: 1080 },
    proxyCredentialConfigured: true
  };
  const parsed = profileInfoSchema.parse(info);
  assert.equal(parsed.proxy.host, "h");
  assert.equal(parsed.proxyCredentialConfigured, true);
  assert.equal("password" in parsed.proxy, false, "info proxy never carries a password");
}
// An old record without proxy/proxyCredentialConfigured still parses; the flag
// is optional so pre-feature records do not break the info codec.
{
  const oldInfo = {
    ...baseProfile,
    profileId: "123e4567-e89b-12d3-a456-426614174000",
    groupId: null, groupName: null,
    credentialConfigured: false, passphraseConfigured: false, secondaryConfigured: false,
    connected: false, credentialId: null, credentialName: null,
    proxyJump: [], defaultProjectPath: null, loginCommand: null
  };
  assert.doesNotThrow(() => profileInfoSchema.parse(oldInfo));
}

// ── credential refs expose the proxy-password key when present ──────────────
{
  const refs = profileCredentialRefsSchema.parse({
    password: "p", privateKey: "", passphrase: "", proxyPassword: "DSH_SSH_OPS_X_PROXY_PASSWORD"
  });
  assert.equal(refs.proxyPassword, "DSH_SSH_OPS_X_PROXY_PASSWORD");
}

console.log("proxy-schema: optional proxy, passwordless record, inline connect password and zero migration all passed");
