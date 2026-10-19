// profileConnect must merge the saved proxy coordinates with the credential-
// stored password and hand the result to connectInternal; the password never
// comes from the record. Covers: password resolved, no-auth proxy (no secret),
// and a record with no proxy at all (field omitted, zero-migration path).
import assert from "node:assert/strict";
import SshOpsService from "../src/index.js";

function makeService(record) {
  const service = Object.create(SshOpsService.prototype);
  service.connections = new Map();
  const proxyPwRef = `DSH_SSH_OPS_${record.profileId.replaceAll("-", "").toUpperCase()}_PROXY_PASSWORD`;
  service.ctx = {
    credentials: {
      // The host brands refs; match by the recognizable suffix instead of the
      // brand wrapper so the test stays independent of that representation.
      async resolve(ref) {
        return String(ref).includes("_PROXY_PASSWORD") && record.__hasProxyPw
          ? { value: "proxy-secret" }
          : undefined;
      },
      async describe() { return { configured: false }; }
    }
  };
  void proxyPwRef;
  service.requireProfileTable = () => ({ get: (id) => (id === record.profileId ? record : undefined) });
  service.resolveCredentialAuth = async () => ({ kind: "password", password: "server-pw" });
  service.captured = null;
  service.connectInternal = async (request, profileId) => {
    service.captured = { request, profileId };
    return { ok: true, value: { connectionId: "c1", host: request.host, port: request.port, username: request.username } };
  };
  return service;
}

const baseRecord = {
  profileId: "123e4567-e89b-12d3-a456-426614174000",
  name: "srv", host: "192.168.10.11", port: 22, username: "root",
  authKind: "password", credentialId: null, hostKeyMode: "accept-new",
  proxyJump: []
};

// ── proxy with a stored username + password ─────────────────────────────────
{
  const service = makeService({
    ...baseRecord,
    __hasProxyPw: true,
    proxy: { type: "socks5", host: "192.168.10.4", port: 1080, username: "gw" }
  });
  const result = await service.profileConnect({ profileId: baseRecord.profileId });
  assert.equal(result.ok, true);
  assert.deepEqual(service.captured.request.proxy, {
    type: "socks5", host: "192.168.10.4", port: 1080, username: "gw", password: "proxy-secret"
  }, "the stored proxy password is resolved onto the connect request");
  assert.equal(service.captured.profileId, baseRecord.profileId);
}

// ── no-auth proxy: coordinates present, no password stored ──────────────────
{
  const service = makeService({
    ...baseRecord,
    __hasProxyPw: false,
    proxy: { type: "socks5", host: "192.168.10.4", port: 1080 }
  });
  const result = await service.profileConnect({ profileId: baseRecord.profileId });
  assert.equal(result.ok, true);
  assert.deepEqual(service.captured.request.proxy, { type: "socks5", host: "192.168.10.4", port: 1080 });
  assert.equal("password" in service.captured.request.proxy, false, "no password is fabricated when none is stored");
}

// ── legacy record without a proxy: the field is simply absent ───────────────
{
  const service = makeService({ ...baseRecord, __hasProxyPw: false });
  const result = await service.profileConnect({ profileId: baseRecord.profileId });
  assert.equal(result.ok, true);
  assert.equal("proxy" in service.captured.request, false, "a pre-feature record connects with no proxy field");
  assert.deepEqual(service.captured.request.proxyJump, undefined);
}

console.log("proxy-profile-connect: stored password merge, no-auth proxy and proxy-less legacy record all passed");
