// 行号读取工具集（M3）：三个工具走真实 service 方法，验收对齐计划 6-M3：
// 「连续三条命令后 xssh_command_list 列出三条含行区间；xssh_command_output(echo B)
// 只回 B 的行；xssh_terminal_read({from_line,to_line}) 与台账区间对齐」。
import assert from "node:assert/strict";
import SshOpsService from "../src/index.js";
import { createLineJournal } from "../src/line-journal.js";
import { ShellIntegrationTracker } from "../src/shell-integration.js";

/** 一个带活会话、行日志与命令台账的 service 桩，只桩掉与工具无关的旁路。 */
function makeHarness() {
  const service = Object.create(SshOpsService.prototype);
  service.config = {
    maxBufferBytes: 65536,
    maxCaptureBytes: 65536,
    sessionLogEnabled: false,
    commandLedgerEnabled: false,
    commandIdleMs: 1500
  };
  const session = {
    id: "s-tools",
    connectionId: "conn-tools",
    exited: null,
    stream: { write: () => {} },
    lineJournal: createLineJournal(),
    shellIntegration: new ShellIntegrationTracker(),
    buffer: "",
    captureBuffer: "",
    waiters: [],
    streamListeners: new Set(),
    inputLine: "",
    inputKnown: true
  };
  service.connections = new Map([["conn-tools", { host: "192.0.2.20", sessions: new Set(["s-tools"]) }]]);
  service.sessions = new Map([["s-tools", session]]);
  service.activeConnectionId = "conn-tools";
  service.terminalOutput = () => ({ append() {} });
  service.sessionLogStore = () => null;
  service.wakeWaiters = () => {};
  service.notifyStreamListeners = () => {};
  service.updateInputMirror = () => {};
  service.appendTerminalNotice = () => {};
  service.prefillBlockedCommand = () => null;
  service.savedResourceNameList = () => [];

  const tools = [];
  service.registerTools({ tools: { register(tool) { tools.push(tool); } } });
  return { service, session, tools, tool: (name) => tools.find((item) => item.name === name) };
}

// ── 三个工具都注册上了，且不再出现与上游撞名的裸前缀 ───────────────────────
{
  const { tools } = makeHarness();
  for (const name of ["xssh_read", "xssh_command"]) {
    assert.ok(tools.some((tool) => tool.name === name), `注册了 ${name}`);
  }
  // 这里曾只查 `ssh_`，于是 8 个 sftp_ 与 3 个 tunnel_ 工具与上游同名的 bug 从
  // 本断言下溜过去了。现在按「上游用过的全部裸前缀」来查（含 db_/batch_）。
  const naked = tools
    .map((tool) => tool.name)
    .filter((name) => /^(ssh_|sftp_|tunnel_|db_|batch_)/.test(name));
  assert.deepEqual(naked, [], `这些工具名与上游 dsh-ssh-ops 撞名：${naked.join(", ")}`);
  assert.ok(tools.every((tool) => /^(?:xssh_|xsftp_|xtunnel(?:_|$))/.test(tool.name)),
    "所有工具名都必须带本项目前缀（加一个 x 的派生规则）");
}

// ── 计划 6-M3 验收：连发三条命令 → 台账三条含行区间，输出工具只回目标命令的行 ──
{
  const { service, session, tool } = makeHarness();
  const readTool = tool("xssh_read");
  const listTool = tool("xssh_command");
  const outputTool = tool("xssh_command");

  // 三条命令依次发出，每条之间喂入「回显 + 自己的输出」。
  const first = await service.sendCommand({ connectionId: "conn-tools", text: "echo A", pressEnter: true });
  service.appendSessionOutput(session, "echo A\r\nA\r\n");
  const second = await service.sendCommand({ connectionId: "conn-tools", text: "echo B", pressEnter: true });
  service.appendSessionOutput(session, "echo B\r\nB\r\n");
  const third = await service.sendCommand({ connectionId: "conn-tools", text: "echo C", pressEnter: true });
  service.appendSessionOutput(session, "echo C\r\nC\r\n");
  // 每次 sendCommand 都要拿到台账 ID 与起始行（这是「每命令可定位」的前提）
  for (const [label, sent] of [["第一条", first], ["第二条", second], ["第三条", third]]) {
    assert.equal(sent.ok, true, `${label}发送成功`);
    assert.ok(typeof sent.value.commandId === "string" && sent.value.commandId !== "", `${label}有 commandId`);
    assert.ok(sent.value.startLine >= 1, `${label}有 startLine`);
  }
  // 起始行必须**严格递增**：三条命令各占自己的区间，不能落到同一行
  assert.ok(first.value.startLine < second.value.startLine
    && second.value.startLine < third.value.startLine, "三条命令的起始行严格递增");
  // 最后一条不会被「下一条命令」截断，让它走判据①（shell 报告命令结束）闭口 ——
  // 否则它天然处于运行中，这与真实 shell 集成环境下的行为一致。
  service.ledgerFor(session).closeFromShellIntegration({ endLine: session.lineJournal.lastLine(), exitCode: 0 });

  // ① 台账列出三条，每条都带可用的行区间
  const listed = await listTool.execute({ op: "list",  connection_id: "conn-tools" });
  assert.equal(listed.commands.length, 3, "三条命令都在台账里");
  assert.deepEqual(listed.commands.map((command) => command.text), ["echo C", "echo B", "echo A"], "最近在前");
  for (const command of listed.commands) {
    assert.ok(command.startLine >= 1, `${command.text} 有 startLine`);
    assert.ok(command.endLine !== null && command.endLine >= command.startLine, `${command.text} 已闭口且有 endLine`);
  }
  // 区间不重叠（计划 M2 的判据在工具层同样成立）
  const ranges = listed.commands.map((command) => [command.startLine, command.endLine]).reverse();
  for (let index = 1; index < ranges.length; index += 1) {
    assert.ok(ranges[index - 1][1] < ranges[index][0], `区间不重叠：${ranges[index - 1]} < ${ranges[index]}`);
  }

  // ② 工具渲染里能看到行区间（人读得懂）
  const rendered = listTool.output.render({ op: "list" }, listed);
  assert.match(rendered[0].text, /echo B/);
  assert.match(rendered[0].text, new RegExp(`${second.value.startLine}–${second.value.startLine}`), "渲染出区间");

  // ③ 按内容取回：xssh_command_output(command_text:"echo B") 只回 B 的行
  const outputB = await outputTool.execute({ op: "output",  connection_id: "conn-tools", command_text: "echo B" });
  assert.equal(outputB.commandId, second.value.commandId, "精确匹配命中 B");
  assert.equal(outputB.output.includes("echo A"), false, "A 的行不在 B 的输出里");
  assert.equal(outputB.output.includes("echo C"), false, "C 的行不在 B 的输出里");
  assert.match(outputB.output, /B/, "含 B 自己的输出");
  assert.deepEqual(outputB.lines.map((entry) => entry.text), ["B"], "只回 B 的输出行");

  // ④ 按行号读与台账区间对齐：读 B 的区间，正好只拿到 B 的行
  // （区间从列表结果里取，而不是从 sendCommand 的返回值 —— 后者只有 startLine，
  //   endLine 要等闭口判据跑完才有；这正是「先查台账再按区间读」的真实用法。）
  const rangeB = listed.commands.find((command) => command.commandId === second.value.commandId);
  const aligned = await readTool.execute({ mode: "lines", 
    connection_id: "conn-tools",
    from_line: rangeB.startLine,
    to_line: rangeB.endLine
  });
  assert.deepEqual(aligned.lines.map((entry) => entry.text), ["B"], "行号读取与台账区间一致");
  assert.match(aligned.text, /^\d{4} │ B$/m, "渲染为四位数行号 + 分隔符");

  // ⑤ 按 ID 取回等价于按内容取回
  const byId = await outputTool.execute({ op: "output",  connection_id: "conn-tools", command_id: third.value.commandId });
  assert.equal(byId.text, "echo C");
  assert.deepEqual(byId.lines.map((entry) => entry.text), ["C"]);

  // ⑥ 未给参数时默认返回尾部 50 行（不是全部历史）
  const tailDefault = await readTool.execute({ mode: "lines",  connection_id: "conn-tools" });
  assert.equal(tailDefault.view, "lines");
  assert.ok(tailDefault.lines.length > 0);
  assert.ok(tailDefault.lines.length <= 50, "默认尾部 50 行上限");
  assert.equal(tailDefault.firstLine >= 1, true);
}

// ── 命令尚未结束：说明「截至第 N 行」，并如实标 truncated ───────────────────
{
  const { service, session, tool } = makeHarness();
  const outputTool = tool("xssh_command");
  const pending = await service.sendCommand({ connectionId: "conn-tools", text: "tail -f /var/log/x", pressEnter: true });
  service.appendSessionOutput(session, "tail -f /var/log/x\r\nline one\r\nline two\r\n");

  const value = await outputTool.execute({ op: "output",  connection_id: "conn-tools", command_id: pending.value.commandId });
  assert.equal(value.endLine, value.lines[value.lines.length - 1].line, "未闭口时取当前行为止");
  assert.match(value.note, /尚未结束/, "必须说清命令还没结束");
  assert.equal(value.truncated, true, "未闭口 ⇒ 结果不完整");
  assert.deepEqual(value.lines.map((entry) => entry.text), ["line one", "line two"]);
}

// ── 命令没有输出：给出明确说明而不是空区间 ────────────────────────────────
{
  const { service, session, tool } = makeHarness();
  const outputTool = tool("xssh_command");
  const silent = await service.sendCommand({ connectionId: "conn-tools", text: "true", pressEnter: true });
  service.appendSessionOutput(session, "true\r\n");
  const closed = service.ledgerFor(session).closeFromShellIntegration({
    endLine: session.lineJournal.lastLine(),
    exitCode: 0
  });
  assert.equal(closed.endLine < closed.startLine, true, "无输出时区间反向");

  const value = await outputTool.execute({ op: "output",  connection_id: "conn-tools", command_id: silent.value.commandId });
  assert.equal(value.output, "");
  assert.match(value.note, /没有产生输出行/, "明确说没有输出");
}

// ── 默认隐藏保活/登录脚本，但工具能显式查回证据 ───────────────────────────
{
  const { service, tool } = makeHarness();
  const listTool = tool("xssh_command");
  await service.sendCommand({ connectionId: "conn-tools", text: "echo A", pressEnter: true });
  await service.sendCommand({ connectionId: "conn-tools", text: "keepalive-probe", pressEnter: false, source: "login-script" });

  const visible = await listTool.execute({ op: "list",  connection_id: "conn-tools" });
  assert.deepEqual(visible.commands.map((command) => command.text), ["echo A"], "默认过滤 login-script");

  // service 层的显式查询仍拿得到（计划 Q17）
  const all = service.listCommands({ sessionId: "s-tools", source: "login-script" });
  assert.equal(all.value.commands.length, 1);
}

// ── status 过滤 ───────────────────────────────────────────────────────────
{
  const { service, session, tool } = makeHarness();
  const listTool = tool("xssh_command");
  await service.sendCommand({ connectionId: "conn-tools", text: "echo done", pressEnter: true });
  service.appendSessionOutput(session, "echo done\r\ndone\r\n");
  service.ledgerFor(session).closeFromShellIntegration({ endLine: session.lineJournal.lastLine(), exitCode: 0 });
  await service.sendCommand({ connectionId: "conn-tools", text: "tail -f x", pressEnter: true });

  assert.equal((await listTool.execute({ op: "list",  connection_id: "conn-tools", status: "running" })).commands.length, 1);
  assert.equal((await listTool.execute({ op: "list",  connection_id: "conn-tools", status: "done" })).commands.length, 1);
  assert.equal((await listTool.execute({ op: "list",  connection_id: "conn-tools", status: "all" })).commands.length, 2);
}

// ── 子串命中多条：交回候选让调用方指定，而不是替它猜 ───────────────────────
{
  const { service, tool } = makeHarness();
  const outputTool = tool("xssh_command");
  await service.sendCommand({ connectionId: "conn-tools", text: "echo A", pressEnter: true });
  await service.sendCommand({ connectionId: "conn-tools", text: "echo AB", pressEnter: true });

  const candidates = await outputTool.execute({ op: "output",  connection_id: "conn-tools", command_text: "echo A", match: "substring" });
  assert.equal(candidates.commandId, "", "命中多条时不擅自选一条");
  assert.ok(Array.isArray(candidates.candidates) && candidates.candidates.length >= 2);
  const rendered = outputTool.output.render({ op: "output" }, candidates);
  assert.match(rendered[0].text, /command_id/, "提示用 command_id 指定");

  // 精确匹配仍然直接给结果
  const exact = await outputTool.execute({ op: "output",  connection_id: "conn-tools", command_text: "echo A" });
  assert.equal(exact.text, "echo A");
}

// ── 行号读取：区间请求超出保留区 ⇒ 如实报 evicted，不拿新行顶上 ─────────────
{
  const { service, session, tool } = makeHarness();
  const readTool = tool("xssh_read");
  for (let line = 1; line <= 2100; line += 1) service.appendSessionOutput(session, `row ${line}\n`);

  const early = await readTool.execute({ mode: "lines",  connection_id: "conn-tools", from_line: 1, to_line: 5 });
  assert.equal(early.evicted, true, "请求起点早于保留区必须报 evicted");
  assert.deepEqual(early.lines, [], "不给替代内容");
  assert.equal(early.firstLine, 101);
  const rendered = readTool.output.render({ mode: "lines" }, early);
  assert.match(rendered[0].text, /淘汰/, "渲染里明确告警");

  const ok = await readTool.execute({ mode: "lines",  connection_id: "conn-tools", from_line: early.firstLine, to_line: early.firstLine + 1 });
  assert.deepEqual(ok.lines.map((entry) => entry.line), [101, 102]);
  assert.equal(ok.evicted, false);
}

// ── 没有终端时要给可指导的错误，而不是空结果 ──────────────────────────────
{
  const { service, tool } = makeHarness();
  service.connections.set("conn-idle", { host: "192.0.2.21", sessions: new Set() });
  await assert.rejects(
    () => tool("xssh_read").execute({ mode: "lines", connection_id: "conn-idle" }),
    /no open terminal/,
    "没有终端时明确拒绝"
  );
  await assert.rejects(
    () => tool("xssh_command").execute({ op: "list", connection_id: "conn-missing" }),
    /xssh_command failed/,
    "连接不存在时拒绝"
  );
}

// ── xterm 兼容视图仍可用（旧行为不破） ─────────────────────────────────────
{
  const { service, session, tool } = makeHarness();
  service.readCurrentConnection = () => ({
    ok: true,
    value: { connectionId: "conn-tools", host: "192.0.2.20", data: "plain\x1b[31mred\x1b[0m\n", historyStart: 0, historyEnd: 9, truncated: false }
  });
  const value = await tool("xssh_read").execute({ mode: "full", connection_id: "conn-tools" });
  assert.equal(value.view, "full");
  assert.equal(value.text, "plainred", "原始流仍经可读化");
  assert.equal(value.lines.length, 0);
  void session;
}

// ── 输出脱敏：正文里的密钥不得原样透出 ────────────────────────────────────
{
  const { service, session, tool } = makeHarness();
  const outputTool = tool("xssh_command");

  // 两种形态都试：`API_KEY=` 命中键值规则，裸 token 命中 sk- 规则。
  const secret = await service.sendCommand({ connectionId: "conn-tools", text: "env | grep KEY", pressEnter: true });
  service.appendSessionOutput(
    session,
    "env | grep KEY\r\nAPI_KEY=sk-live-abcdefghijklmnop\r\ntoken=sk-live-abcdefghijklmnop\r\n"
  );
  service.ledgerFor(session).closeFromShellIntegration({ endLine: session.lineJournal.lastLine(), exitCode: 0 });

  const value = await outputTool.execute({ op: "output",  connection_id: "conn-tools", command_id: secret.value.commandId });
  assert.equal(value.output.includes("sk-live-abcdefghijklmnop"), false, "密钥不得原样返回");
  assert.match(value.output, /API_KEY=\*\*\*/, "键值形态按规则掩码");
  assert.match(value.output, /sk-\*\*\*/, "裸 token 形态也被掩码");
}

console.log("terminal line tools: numbered reads, ledger ranges, command output and redaction all hold");
