// xssh_resource 工具：AI 添加/保存 SSH 资源的入口（用户 2026-10-19）。
// 复用 credentials.mjs 的 mock 模式：服务原型 + fake 凭据存储，无 ssh2 传输。
// 断言四件事：
//   1. op=list 返回已存资源（坐标 + 凭据状态，无秘密）；
//   2. op=save 新建资源并把密码写进凭据存储（与 UI 同一 ref）；
//   3. op=save 更新资源：留空密码 = 保留原值（覆盖写才变）；
//   4. 秘密绝不进 profile 记录（schema 本就拒绝，工具层只写凭据存储）。
import assert from "node:assert/strict";
import SshOpsService from "../src/index.js";
import { registerResourceTools } from "../src/tools/resource.js";

function makeService() {
  const service = Object.create(SshOpsService.prototype);
  service.config = { maxBufferBytes: 65536, maxCaptureBytes: 65536 };
  service.connections = new Map();
  const store = new Map();
  const key = (ref) => (typeof ref === "string" ? ref : JSON.stringify(ref));
  service.ctx = {
    credentials: {
      async describe(ref) { return { configured: store.has(key(ref)) }; },
      async resolve(ref) { return store.has(key(ref)) ? { value: store.get(key(ref)) } : undefined; },
      async set(ref, value) { store.set(key(ref), value); return { ok: true, value: undefined }; },
      async unset(ref) { store.delete(key(ref)); return { ok: true, value: undefined }; }
    }
  };
  service.store = store;
  service.storeKey = key;
  const profiles = new Map();
  const groups = new Map();
  const credentials = new Map();
  const fakeTable = (map) => ({
    get: (id) => map.get(id),
    put: (id, record) => { map.set(id, record); },
    delete: (id) => { map.delete(id); },
    entries: () => [...map.entries()],
    size: () => map.size
  });
  service.requireProfileTable = () => fakeTable(profiles);
  service.requireGroupTable = () => fakeTable(groups);
  service.requireCredentialTable = () => fakeTable(credentials);
  return service;
}

function extractTool(ctxTools) {
  return async (name, args) => {
    const calls = ctxTools.registered;
    const tool = calls.find((entry) => entry.name === name);
    assert.ok(tool, `tool ${name} should be registered`);
    return await tool.execute(args);
  };
}

function captureCtx() {
  const registered = [];
  return { registered, register: (tool) => registered.push(tool) };
}

// ── 注册即存在 ──
{
  const ctx = captureCtx();
  registerResourceTools({ tools: ctx }, makeService());
  assert.equal(ctx.registered.length, 1);
  assert.equal(ctx.registered[0].name, "xssh_resource");
}

// ── op=list：空库与有记录 ──
{
  const service = makeService();
  const ctx = captureCtx();
  registerResourceTools({ tools: ctx }, service);
  const call = extractTool(ctx);

  const empty = await call("xssh_resource", { op: "list" });
  assert.deepEqual(empty.profiles, []);

  const saved = await service.profileSave({ name: "web1", host: "172.29.7.102", username: "root", authKind: "password" });
  assert.ok(saved.ok, saved.ok ? "" : saved.error.message);
  await service.ctx.credentials.set(service.storeKey(saved.value.credentialRefs.password), "s3cret");

  const listed = await call("xssh_resource", { op: "list" });
  assert.equal(listed.profiles.length, 1);
  const p = listed.profiles[0];
  assert.equal(p.name, "web1");
  assert.equal(p.credentialConfigured, true, "凭据已写 → describe 配置状态为 true");
  assert.equal(JSON.stringify(listed).includes("s3cret"), false, "列表绝不回显秘密");
}

// ── op=save 新建：密码经凭据存储落库，记录本身无秘密 ──
{
  const service = makeService();
  const ctx = captureCtx();
  registerResourceTools({ tools: ctx }, service);
  const call = extractTool(ctx);

  const result = await call("xssh_resource", {
    op: "save",
    name: "外网应用",
    host: "172.29.7.102",
    username: "root",
    auth_kind: "key",
    private_key: "-----BEGIN TEST KEY-----\nabc\n-----END TEST KEY-----",
    proxy: { host: "192.168.10.4", port: 18095 }
  });
  assert.equal(result.op, "save");
  assert.equal(result.created, true);
  const p = result.profile;
  assert.equal(p.proxy?.host, "192.168.10.4", "代理坐标进记录");
  assert.equal(p.proxy?.port, 18095);
  assert.equal(p.credentialConfigured, true, "私钥已写凭据存储");
  assert.equal(JSON.stringify(result).includes("BEGIN TEST KEY"), false, "私钥绝不回显");

  // 与 UI 同一 ref 约定（profileCredentialRefs 的 stem 规则）
  const stem = p.profileId.replaceAll("-", "").toUpperCase();
  assert.ok(service.store.has(`DSH_SSH_OPS_${stem}_PRIVATE_KEY`), "私钥落在 UI 同名 ref");
  assert.ok(service.store.has(`DSH_SSH_OPS_${stem}_PROXY_PASSWORD`) === false, "未给代理密码就不写");

  // 能被 connect 链路读到（credentials.resolve 视角）
  const resolved = await service.ctx.credentials.resolve(`DSH_SSH_OPS_${stem}_PRIVATE_KEY`);
  assert.equal(resolved.value, "-----BEGIN TEST KEY-----\nabc\n-----END TEST KEY-----");
}

// ── op=save 更新：留空 = 保留原凭据；显式传新值 = 覆盖 ──
{
  const service = makeService();
  const ctx = captureCtx();
  registerResourceTools({ tools: ctx }, service);
  const call = extractTool(ctx);

  const created = await call("xssh_resource", {
    op: "save", name: "r1", host: "h1", username: "u", auth_kind: "password", password: "old-pw"
  });
  const id = created.profile.profileId;
  const stem = id.replaceAll("-", "").toUpperCase();
  assert.equal(service.store.get(`DSH_SSH_OPS_${stem}_PASSWORD`), "old-pw");

  // 更新坐标、不传 password → 原密码保留
  const updated = await call("xssh_resource", {
    op: "save", profile_id: id, name: "r1-renamed", host: "h2", username: "u", auth_kind: "password",
    proxy: { host: "10.0.0.9", port: 1080 }, proxy_password: "proxy-pw"
  });
  assert.equal(updated.created, false);
  assert.equal(updated.profile.name, "r1-renamed");
  assert.equal(service.store.get(`DSH_SSH_OPS_${stem}_PASSWORD`), "old-pw", "留空密码 = 保留");
  assert.equal(service.store.get(`DSH_SSH_OPS_${stem}_PROXY_PASSWORD`), "proxy-pw", "代理密码按需写入");

  // 显式传新密码 → 覆盖
  await call("xssh_resource", {
    op: "save", profile_id: id, name: "r1-renamed", host: "h2", username: "u", auth_kind: "password", password: "new-pw"
  });
  assert.equal(service.store.get(`DSH_SSH_OPS_${stem}_PASSWORD`), "new-pw", "显式传值 = 覆盖");
}

// ── op=save 缺必填参数 → 明确报错 ──
{
  const service = makeService();
  const ctx = captureCtx();
  registerResourceTools({ tools: ctx }, service);
  const call = extractTool(ctx);
  await assert.rejects(
    () => call("xssh_resource", { op: "save", name: "only-name" }),
    /name, host, username and auth_kind are required/
  );
}

// ── 未知 op → 报可用值 ──
{
  const service = makeService();
  const ctx = captureCtx();
  registerResourceTools({ tools: ctx }, service);
  const call = extractTool(ctx);
  await assert.rejects(
    () => call("xssh_resource", { op: "delete", profile_id: "x" }),
    /must be one of \["list","save"\]/
  );
}
