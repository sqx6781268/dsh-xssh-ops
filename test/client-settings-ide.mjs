// 客户端真实组件事件回归：只替换 React 调度与远端数据，不复制被测保存逻辑。
// 这是本地组件行为测试，不代表浏览器布局或真实远端 SFTP 验收。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import * as React from "react";
import SshOpsService, { loadSettingsRecord } from "../src/index.js";
import { keepAliveSaveRequestSchema } from "../src/schemas.js";

const require = createRequire(import.meta.url);

function createHarness() {
  const state = [];
  const dependencies = [];
  let cursor = 0;
  let effects = [];
  const react = {
    ...React,
    useState(initial) {
      const slot = cursor++;
      if (!(slot in state)) state[slot] = typeof initial === "function" ? initial() : initial;
      return [state[slot], (next) => { state[slot] = typeof next === "function" ? next(state[slot]) : next; }];
    },
    useRef(initial) {
      const slot = cursor++;
      if (!(slot in state)) state[slot] = { current: initial };
      return state[slot];
    },
    useCallback(callback) { cursor++; return callback; },
    useEffect(callback, deps) {
      const slot = cursor++;
      if (!dependencies[slot] || deps.some((value, index) => value !== dependencies[slot][index])) {
        dependencies[slot] = deps;
        effects.push(callback);
      }
    }
  };
  return {
    async load(name, exportName = name) {
      const result = await build({
        entryPoints: [fileURLToPath(new URL(`../src/client/${name}.jsx`, import.meta.url))],
        bundle: true, write: false, platform: "node", format: "cjs", external: ["react"]
      });
      const module = { exports: {} };
      new Function("require", "module", "exports", result.outputFiles[0].text)(
        (id) => id === "react" ? react : require(id), module, module.exports
      );
      return module.exports[exportName];
    },
    render(Component, props) { cursor = 0; return Component(props); },
    async flush() {
      const queue = effects;
      effects = [];
      for (const effect of queue) effect();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
}

// 设置控件 → 原组件保存回调 → RPC schema → 真实 Host 保存 → 重新读取。
{
  const service = Object.create(SshOpsService.prototype);
  const records = new Map([["main", {}]]);
  service.settingsTable = { get: (id) => records.get(id), put: (id, value) => records.set(id, value) };
  service.settings = loadSettingsRecord({});
  let saved;
  const api = {
    keepAliveGet: async () => (await service.keepAliveGet()).value,
    keepAliveSave: async (request) => {
      saved = request;
      const parsed = keepAliveSaveRequestSchema.parse(request);
      const result = await service.keepAliveSave(parsed);
      assert.equal(result.ok, true, JSON.stringify(result.error));
      return result.value;
    }
  };
  const harness = createHarness();
  const Component = await harness.load("KeepAliveSettings");
  const render = () => harness.render(Component, { api });
  render();
  await harness.flush();
  let tree = render();
  const changes = [
    ["终端输出提示阈值（KB）", 0],
    ["日志总量上限（MB）", 750],
    ["保留天数", 0],
    ["自动清理会话日志", false],
    ["识别终端里的文件名", false],
    ["文件页签跟随终端路径", false],
    ["Ctrl+滚轮缩放字号", false]
  ];
  for (const [label, value] of changes) {
    const field = nodes(tree).find((node) => node.type === "label" && nodes(node).some((child) =>
      child.props?.children === label || child.props?.children?.includes?.(label)));
    assert.ok(field, `应找到设置控件：${label}`);
    const input = nodes(field).find((node) => node.type === "input");
    input.props.onChange({ target: { value: String(value), checked: value } });
    tree = render();
  }
  nodes(tree).find((node) => node.type === "button" && node.props.children === "保存").props.onClick();
  await harness.flush();
  const expected = {
    outputWarnKB: 0, sessionLogMaxTotalMB: 750, sessionLogMaxAgeDays: 0,
    sessionLogAutoPruneEnabled: false, terminalFileLinks: false,
    filesFollowTerminal: false, wheelZoomEnabled: false
  };
  const reloaded = await api.keepAliveGet();
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(saved[key], value, `请求不能漏掉 ${key}`);
    assert.equal(records.get("main")[key], value, `${key} 应持久化到内存设置表`);
    assert.equal(reloaded[key], value, `${key} 重新读取应保持`);
  }
  assert.equal(saved.sshKeepAliveEnabled, true, "原有保活保存仍有正对照");
}

// 编辑 A → 打开 B → 回到 A：保存可用；保存期间又编辑则保留新脏状态。
{
  const harness = createHarness();
  const Component = await harness.load("SshIde");
  let finishSave;
  const writes = [];
  const api = {
    sftpList: async () => ({ entries: [] }),
    sftpReadFile: async () => ({ data: new TextEncoder().encode("original") }),
    sftpWriteFile: async (...args) => {
      writes.push(args);
      await new Promise((resolve) => { finishSave = resolve; });
    }
  };
  const props = { api, connectionId: "fixture-only" };
  const render = (extra = {}) => harness.render(Component, { ...props, ...extra });
  const editor = (tree) => nodes(tree).find((node) => typeof node.props?.onChange === "function" && node.props?.path);
  const saveButton = (tree) => nodes(tree).find((node) => node.type === "button" && ["保存", "保存 *"].includes(node.props.children));
  render();
  await harness.flush();
  render({ pendingPath: "/a.txt" });
  await harness.flush();
  let tree = render();
  editor(tree).props.onChange("edited A");
  tree = render();
  assert.equal(saveButton(tree).props.disabled, false);
  render({ pendingPath: "/b.txt" });
  await harness.flush();
  tree = render();
  assert.equal(saveButton(tree).props.disabled, true, "未修改的 B 不应显示可保存");
  nodes(tree).find((node) => node.type === "button" && node.props.title === "/a.txt").props.onClick();
  tree = render();
  assert.equal(editor(tree).props.value, "edited A");
  assert.equal(saveButton(tree).props.disabled, false, "切回脏文件 A 仍可保存");
  saveButton(tree).props.onClick();
  assert.equal(writes[0][1], "/a.txt");
  assert.equal(new TextDecoder().decode(writes[0][2]), "edited A");
  tree = render();
  editor(tree).props.onChange("edited while saving");
  finishSave();
  await harness.flush();
  tree = render();
  assert.equal(saveButton(tree).props.disabled, false, "保存旧快照完成不应清除新改动");
  saveButton(tree).props.onClick();
  finishSave();
  await harness.flush();
  tree = render();
  assert.equal(saveButton(tree).props.disabled, true, "当前内容保存后应恢复干净状态");
}

// 资源编辑器：默认折叠仍能选库，代理坐标与密码分通道保存，清除动作走凭据服务。
{
  const library = [
    { proxyId: "auth", name: "测试认证代理", host: "192.0.2.10", port: 1080, username: "fixture-user", password: "fixture-only-password" },
    { proxyId: "plain", name: "测试免认证代理", host: "192.0.2.11", port: 1081 }
  ];
  const makeEditor = async (initial) => {
    const harness = createHarness();
    const Component = await harness.load("SshResources", "ResourceEditor");
    const saved = [];
    const writes = [];
    const removed = [];
    let completed = 0;
    const props = {
      initial, groups: [], profiles: [], proxyLibrary: library,
      api: {
        keepAliveGet: async () => ({ proxyLibrary: library }),
        profileSave: async (request) => {
          saved.push(request);
          return { credentialRefs: { password: "fixture:ssh", privateKey: "fixture:key", proxyPassword: "fixture:proxy" } };
        }
      },
      credentials: {
        set: async (ref, value) => { writes.push({ ref, value }); return { ok: true }; },
        unset: async (ref) => { removed.push(ref); return { ok: true }; }
      },
      onSaved: async () => { completed++; }, onClose: () => {}
    };
    const render = () => harness.render(Component, props);
    render();
    await harness.flush();
    return { render, saved, writes, removed, completed: () => completed };
  };
  const selector = (tree) => nodes(tree).find((node) => node.type === "select" && node.props["aria-label"] === "从代理库选择");
  const submit = async (fixture, tree) => {
    await nodes(tree).find((node) => node.type === "button" && node.props.children === "保存资源").props.onClick();
    assert.equal(fixture.completed(), fixture.saved.length, "资源保存应完成而非只调用 API 后报错");
  };
  const fillNewResource = (fixture) => {
    for (const [label, value] of [["名称", "测试资源"], ["主机", "192.0.2.99"]]) {
      const tree = fixture.render();
      const field = nodes(tree).find((node) => node.props?.label === label);
      assert.ok(field, `应找到字段 ${label}`);
      nodes(field).find((node) => node.type === "input").props.onChange({ target: { type: "text", value } });
    }
  };

  const fresh = await makeEditor();
  let tree = fresh.render();
  const toggle = nodes(tree).find((node) => node.type === "button" && String(node.props.children).includes("SOCKS 代理"));
  assert.equal(toggle.props["aria-expanded"], false, "新建时手动代理字段默认折叠");
  assert.ok(selector(tree), "手动代理字段折叠时库选择器仍然存在");
  assert.equal(nodes(selector(tree)).filter((node) => node.type === "option").length, 3, "应有不使用代理与两条测试库项");
  fillNewResource(fresh);
  selector(fresh.render()).props.onChange({ target: { value: "auth" } });
  tree = fresh.render();
  await submit(fresh, tree);
  assert.deepEqual(fresh.saved[0].proxy, { type: "socks5", host: "192.0.2.10", port: 1080, username: "fixture-user" });
  assert.equal(Object.hasOwn(fresh.saved[0].proxy, "password"), false, "持久化坐标不能携带密码");
  assert.equal(fresh.writes.length, 1);
  assert.equal(fresh.writes[0].ref, "fixture:proxy");
  assert.equal(fresh.writes[0].value === library[0].password, true, "代理密码只能发往凭据服务");

  const existing = { profileId: "fixture-profile", name: "测试旧资源", host: "192.0.2.99", port: 22, username: "root", authKind: "password", proxy: { type: "socks5", host: "192.0.2.10", port: 1080, username: "fixture-user" }, proxyCredentialConfigured: true };
  const switched = await makeEditor(existing);
  selector(switched.render()).props.onChange({ target: { value: "plain" } });
  await submit(switched, switched.render());
  assert.deepEqual(switched.saved[0].proxy, { type: "socks5", host: "192.0.2.11", port: 1081 });
  assert.deepEqual(switched.writes, [], "免认证代理不得沿用旧密码写入");
  assert.deepEqual(switched.removed, ["fixture:proxy"], "切换免认证库项必须清除旧代理凭据");

  const cleared = await makeEditor(existing);
  tree = cleared.render();
  const clearCheck = nodes(tree).find((node) => node.props?.label === "清除已保存的代理密码");
  assert.ok(clearCheck);
  clearCheck.props.onChange({ target: { type: "checkbox", checked: true } });
  tree = cleared.render();
  assert.equal(nodes(tree).find((node) => node.props?.label === "清除已保存的代理密码").props.checked, true);
  await submit(cleared, tree);
  assert.deepEqual(cleared.removed, ["fixture:proxy"], "清除勾选必须写到顶层清除标记并实际 unset");
  assert.deepEqual(cleared.writes, []);
}

console.log("客户端事件回归：设置完整保存、编辑器脏状态正确；资源代理选择可见，密码写入与清除通道正确。");
