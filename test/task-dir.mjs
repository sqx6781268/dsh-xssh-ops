// 后台任务落点选择与降级判定（M4 / R7）：
// 三级落点、空间阈值、用户覆盖开关、降级三重告警、预检解析容错、
// 以及远端包装/状态/清理命令的生成与解析。
import assert from "node:assert/strict";
import {
  DEFAULT_MIN_REMOTE_FREE_KB,
  DEFAULT_TASK_TTL_HOURS,
  REMOTE_ROOT_NAME,
  decideLocation,
  degradedWarnings,
  localTaskDir,
  lowSpaceWarnings,
  parseProbe,
  parseStatus,
  probeCommand,
  quoteRemotePath,
  remoteDeleteCommand,
  remoteStatusCommand,
  remoteTaskDir,
  remoteTaskFiles,
  remoteWrapperCommand,
  resolveRemoteTaskDir,
  shellSingleQuote
} from "../src/task-dir.js";

// ── 默认值就是计划 5.7 写下的数字 ──────────────────────────────────────────
{
  assert.equal(DEFAULT_MIN_REMOTE_FREE_KB, 65536, "资源阈值 64 MiB");
  assert.equal(DEFAULT_TASK_TTL_HOURS, 24, "任务产物 TTL 24 小时");
  assert.equal(REMOTE_ROOT_NAME, ".dsh-xssh-ops");
}

// ── 预检解析：容忍噪声，只认最后一个有效结果 ──────────────────────────────
{
  // `dir` 是**展开后的真实目录**（`DIR <路径>` 行）。台账与 cat/rm 都要用它，
  // 不能用 shell 模板形态 —— 否则会去找一个字面名叫 `${TMPDIR:-/tmp}` 的路径。
  assert.deepEqual(parseProbe("OK 12345"), { kind: "tmp", freeKb: 12345, dir: "/tmp" });
  assert.deepEqual(parseProbe("HOME"), { kind: "home", freeKb: null, dir: "~" });
  assert.deepEqual(parseProbe("NONE"), { kind: "none", freeKb: null, dir: null });
  // **可写但空间未知**（远端没有 df/awk）：仍然是可用落点，freeKb 为 null
  assert.deepEqual(parseProbe("TMP_OK"), { kind: "tmp", freeKb: null, dir: "/tmp" });
  // 真实回显形态：先 DIR 再结论
  assert.deepEqual(parseProbe("DIR /var/tmp\nOK 5000"), { kind: "tmp", freeKb: 5000, dir: "/var/tmp" });
  assert.deepEqual(parseProbe("DIR /var/tmp\nTMP_OK"), { kind: "tmp", freeKb: null, dir: "/var/tmp" });
  assert.deepEqual(parseProbe("DIR /root\nHOME"), { kind: "home", freeKb: null, dir: "/root" });
  // 真实环境会混进横幅/提示符/locale 报错
  const noisy = [
    "Warning: locale not supported",
    "Last login: Fri Sep 18",
    "DIR /tmp",
    "OK 99000",
    "root@host:~# "
  ].join("\r\n");
  assert.deepEqual(parseProbe(noisy), { kind: "tmp", freeKb: 99000, dir: "/tmp" }, "取最后一个有效行");
  // 不可识别 ⇒ 按不可用处理（宁可降级并告警，也不假装远端可用）
  assert.deepEqual(parseProbe("some other junk"), { kind: "unparsed", freeKb: null, dir: null });
  assert.deepEqual(parseProbe(""), { kind: "unparsed", freeKb: null, dir: null });
  assert.deepEqual(parseProbe(null), { kind: "unparsed", freeKb: null, dir: null });
}

// ── 空间未知（TMP_OK）：仍用远端，只是没法按阈值判断 ─────────────────────
//
// 回归理由：早期 `decideLocation` 把 `freeKb` 写成 `Number.isFinite(...) ? ... : 0`，
// 于是"空间未知"被当成"零空间"⇒ 明明可写的 /tmp 被判不可用、白白降级到本地。
// 实测在 Windows Git Bash（有 sh 但没有 df/awk）上踩到。
{
  const result = decideLocation({ probe: { kind: "tmp", freeKb: null } });
  assert.equal(result.location, "remote-tmp", "空间未知不该降级");
  assert.equal(result.degraded, false);
  assert.equal(result.spaceUnknown, true, "要标记「空间未知」以便 UI/日志说明");
  assert.equal(result.freeKb, null);
  assert.match(result.warnings.join(" "), /没有 df\/awk/, "要说明为什么没法按阈值判断");
  assert.equal(result.remoteMode, true);
}

// ── 落点 1：tmp 且空间充足 ⇒ 远端，无告警 ──────────────────────────────────
{
  const result = decideLocation({ probe: { kind: "tmp", freeKb: 100000 } });
  assert.equal(result.location, "remote-tmp");
  assert.equal(result.degraded, false);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.remoteMode, true);
}

// ── 落点 2：无 /tmp 但家目录可写 ⇒ 仍是远端，轻提示 ────────────────────────
{
  const result = decideLocation({ probe: { kind: "home", freeKb: null } });
  assert.equal(result.location, "remote-home");
  assert.equal(result.degraded, false, "家目录落点不算降级");
  assert.equal(result.remoteMode, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /家目录/);
}

// ── 落点 3：远端空间不足 ⇒ 降级本地 + 三重严重告警 ────────────────────────
{
  const result = decideLocation({ probe: { kind: "tmp", freeKb: 1000 } });
  assert.equal(result.location, "local");
  assert.equal(result.degraded, true);
  assert.equal(result.remoteMode, false);
  // 计划 5.5.5 要求降级时告警同时出现在三处，所以文案要完整、可复用
  assert.equal(result.warnings.length, 5, "低空间 2 条 + 降级 3 条");
  const joined = result.warnings.join(" ");
  assert.match(joined, /可用空间不足/);
  assert.match(joined, /结果不留远端/);
  assert.match(joined, /断线即中断/);
  assert.match(joined, /运维故障/);
}

// ── 落点 3 的另一条路径：完全没有可用目录 ⇒ 降级 ──────────────────────────
{
  for (const kind of ["none", "unparsed"]) {
    const result = decideLocation({ probe: { kind, freeKb: null } });
    assert.equal(result.location, "local", `${kind} 应降级`);
    assert.equal(result.degraded, true);
    assert.match(result.warnings.join(" "), /结果不留远端/);
  }
}

// ── 阈值可配：同一个空间在不同阈值下结论不同 ──────────────────────────────
{
  const probe = { kind: "tmp", freeKb: 5000 };
  assert.equal(decideLocation({ probe, minRemoteFreeKb: 1000 }).location, "remote-tmp");
  assert.equal(decideLocation({ probe, minRemoteFreeKb: 9000 }).location, "local");
}

// ── 用户覆盖：覆盖不等于无风险，仍然告警 ──────────────────────────────────
{
  const low = { kind: "tmp", freeKb: 100 };
  const allow = decideLocation({ probe: low, allowLowSpace: true });
  assert.equal(allow.location, "remote-tmp", "用户坚持远端就跑远端");
  assert.equal(allow.degraded, false);
  assert.equal(allow.overridden, true);
  assert.match(allow.warnings.join(" "), /按用户要求仍在远端执行/, "覆盖也要告警");

  const forced = decideLocation({ probe: { kind: "tmp", freeKb: 999999 }, forceLocal: true });
  assert.equal(forced.location, "local", "强制本地优先于充足空间");
  assert.equal(forced.degraded, true);
  assert.equal(forced.overridden, true);
  assert.match(forced.warnings.join(" "), /强制使用本地通道/, "强制也要告警");
  // **降级三重告警在 force_local 分支也要齐**：降级的后果与原因无关 ——
  // 早期只给一条"强制"说明，用户看不到完整代价（实测被工具层 e2e 抓到：
  // service 层测的是"空间不足"分支，那里有，这条分支的缺失只有走 force_local 才暴露）。
  assert.ok(forced.warnings.length >= 4, `强制本地也要带降级三重告警（实际 ${forced.warnings.length} 条）`);
  const forcedText = forced.warnings.join(" ");
  assert.match(forcedText, /结果不留远端/, "三重之一：结果不留远端");
  assert.match(forcedText, /断线即中断/, "三重之二：断线即中断");
}

// ── allowLocalDegrade=false：不降级而是明确阻断（计划 5.7 的开关）──────────
{
  const blocked = decideLocation({ probe: { kind: "none", freeKb: null }, allowLocalDegrade: false });
  assert.equal(blocked.location, "blocked");
  assert.equal(blocked.degraded, false);
  assert.equal(blocked.blocked, true);
  assert.match(blocked.warnings.join(" "), /没有可用的临时目录|没有可写的/);
}

// ── 降级告警文案单一来源（三处共用，不许各写一份）────────────────────────
{
  const warnings = degradedWarnings();
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /降级到本地临时目录/);
  assert.match(warnings[1], /断线即中断/);
  assert.match(warnings[2], /需尽快处理/);
}

// ── 远端路径：模板形态 vs 真实路径（这里踩过一个大坑）────────────────────
{
  // `remoteTaskDir` 返回**模板形态**（让远端 shell 自己展开）—— 它不是可直接使用的路径
  assert.equal(remoteTaskDir("remote-tmp", "t000001-abcd"), "${TMPDIR:-/tmp}/.dsh-xssh-ops/t000001-abcd");
  assert.equal(remoteTaskDir("remote-home", "t000001-abcd"), "$HOME/.dsh-xssh-ops/t000001-abcd");
  assert.equal(remoteTaskDir("local", "t000001-abcd"), null, "本地不带远端目录");

  // `resolveRemoteTaskDir` 展开成**真实路径**（台账与 cat/rm 用这个）
  // 踩过的坑：早期把 remoteTaskDir 的返回值直接存台账并用于 cat ⇒ 去读一个字面名叫
  // `${TMPDIR:-/tmp}` 的路径 ⇒ taskRead/taskStatus/taskDelete 全部静默读不到文件。
  assert.equal(resolveRemoteTaskDir("remote-tmp", "t1", { tmpRoot: "/var/tmp" }).path,
    "/var/tmp/.dsh-xssh-ops/t1", "用探测到的真实临时目录");
  assert.equal(resolveRemoteTaskDir("remote-tmp", "t1", { tmpRoot: "/var/tmp" }).assumed, false);
  assert.equal(resolveRemoteTaskDir("remote-home", "t1", { homeRoot: "/root" }).path,
    "/root/.dsh-xssh-ops/t1");
  // 拿不到真实值时退回 /tmp 并标记 assumed（宁可给"很可能对"的真实路径，也不给模板）
  const fallback = resolveRemoteTaskDir("remote-tmp", "t1", { tmpRoot: null });
  assert.equal(fallback.path, "/tmp/.dsh-xssh-ops/t1");
  assert.equal(fallback.assumed, true, "退回时要标记，便于排障知道路径是猜的");
  assert.equal(resolveRemoteTaskDir("local", "t1").path, null);

  // 关键回归：真实路径里**不得**出现 shell 模板字符
  for (const resolved of [
    resolveRemoteTaskDir("remote-tmp", "t1", { tmpRoot: "/var/tmp" }).path,
    resolveRemoteTaskDir("remote-home", "t1", { homeRoot: "/root" }).path
  ]) {
    assert.equal(/\$\{|\$[A-Z]/.test(resolved), false, `真实路径不得含模板变量：${resolved}`);
  }

  const files = remoteTaskFiles("/tmp/.dsh-xssh-ops/t1");
  assert.deepEqual(files, {
    stdout: "/tmp/.dsh-xssh-ops/t1/stdout.log",
    stderr: "/tmp/.dsh-xssh-ops/t1/stderr.log",
    exit: "/tmp/.dsh-xssh-ops/t1/exit.code",
    pid: "/tmp/.dsh-xssh-ops/t1/pid"
  });
  // 本地目录用 path.join，所以交给调用方传基准目录
  const local = localTaskDir("C:\\Temp\\xssh", "t1");
  assert.ok(local.endsWith("t1"));
}

// ── 远端包装命令：必须回 ready 哨兵（否则无法区分「已后台化」与「没起来」）──
{
  const command = remoteWrapperCommand({ dir: "/tmp/.dsh-xssh-ops/t1", command: "tar czf /root/b.tgz /root/s" });
  // `setsid` 不是 POSIX 标准命令（实测 Git for Windows 就没有）—— 必须先探测再用，
  // 缺了要退回 nohup；否则子命令直接 `command not found`，而包装仍会回 ready。
  assert.ok(command.includes("command -v setsid"), "setsid 要先探测");
  assert.ok(command.includes('launcher="nohup sh -c"'), "缺 setsid 时退回 nohup");
  assert.ok(command.includes("$launcher"), "启动器走变量（按探测结果择一）");
  // **用 `sh -c` 而不是 `sh -lc`**：`-l` 的 login shell 会读 profile 启动文件，
  // 实测在 Git for Windows 上「后台化 + 重定向」时**连输出都写不出来**
  // （`nohup sh -lc 'echo X' >out` 得到空文件，`nohup sh -c` 正常）。
  assert.equal(command.includes("sh -lc"), false, "不得用 login shell（-l）");
  assert.ok(command.includes("sh -c"), "用普通 shell（-c）");
  assert.match(command, /echo ready$/, "必须有 ready 哨兵");
  // 文件路径用 "$d/..."（短且天然双引号可展开）
  assert.match(command, />"\$d\/stdout\.log"/, "stdout 落文件");
  assert.match(command, /2>"\$d\/stderr\.log"/, "stderr 落文件");
  assert.match(command, /echo \$\? >"\$d\/exit\.code"/, "退出码落文件");
  assert.match(command, /echo \$pid >"\$d\/pid"/, "pid 落文件");
  // **ready 必须是三层的**（每一层都对应一个实测踩到的假成功）：
  assert.ok(command.includes('mkdir -p "$d" || { echo "FAIL mkdir"; exit 1; }'), "① 建目录失败 ⇒ FAIL mkdir");
  assert.ok(command.includes('|| { echo "FAIL pid"; exit 1; }'), "② pid 写不进去 ⇒ FAIL pid");
  assert.ok(command.includes('kill -0 "$pid" 2>/dev/null || { echo "FAIL exec"; exit 1; }'),
    "③ 子进程立刻退出 ⇒ FAIL exec（否则 sh -c 里的命令找不到也会回 ready）");
  // **启动与 wait 必须在同一层**：`wait` 只能等自己 shell 的子进程。
  // 早期拆成「先 & 拿 $!，再用子 shell wait」⇒ 子 shell 里没有那个 job，
  // `wait` 返回 127，于是 exit.code **谎报 127**（实测：命令跑对了、stdout 正确、
  // 退出码却是 127）。判据：`echo $? >"$d/exit.code"` 必须与启动在同一对花括号内。
  assert.match(command, /\{ \$launcher .*echo \$\? >"\$d\/exit\.code"; \} &/,
    "启动与记录退出码必须在同一个子 shell 内（否则 wait 拿不到 job，退出码谎报 127）");
  assert.equal(command.includes("( wait $pid"), false, "不得用独立子 shell 去 wait（拿不到 job）");
  // 不带 setsid 的退化形态
  assert.match(remoteWrapperCommand({ dir: "/d", command: "x", useSetsid: false }), /^d='\/d'\nmkdir -p "\$d"/);
  assert.ok(remoteWrapperCommand({ dir: "/d", command: "x", useSetsid: false }).includes('launcher="nohup sh -c"'),
    "useSetsid=false 时直接 nohup，不做探测");
}

// ── 含 ${TMPDIR:-/tmp} 的路径必须可展开（不能整段单引号）────────────────
//
// 回归护栏：`d='${TMPDIR:-/tmp}/...'` 会让 shell 去找一个字面名叫 `${TMPDIR:-/tmp}`
// 的目录 —— wrapper 语法看着完全正确，落点却全错（实测踩到）。
{
  const dir = remoteTaskDir("remote-tmp", "t1");   // ${TMPDIR:-/tmp}/.dsh-xssh-ops/t1
  const command = remoteWrapperCommand({ dir, command: "echo hi" });
  assert.ok(command.includes('d="${TMPDIR:-/tmp}/.dsh-xssh-ops/t1"'), `含 $ 的路径要留在双引号里：${command.split("\n")[0]}`);
  assert.equal(command.includes("d='${TMPDIR"), false, "不得用单引号包住含 $ 的路径");

  // status 与 delete 同样如此
  for (const built of [remoteStatusCommand({ dir }), remoteDeleteCommand({ dir })]) {
    assert.ok(built.includes('d="${TMPDIR:-/tmp}/.dsh-xssh-ops/t1"'), "两处命令也要可展开");
  }
  // 普通路径（无 $）仍走单引号（最安全，避免注入）
  assert.equal(remoteStatusCommand({ dir: "/tmp/plain" }).split("\n")[0], "d='/tmp/plain'");
  // 含单引号的普通路径要被正确转义
  assert.equal(remoteDeleteCommand({ dir: "/tmp/a'b" }).split("\n")[0], "d='/tmp/a'\\''b'");
}

// ── quoteRemotePath：含 $ 的路径必须可展开（这是修过真 bug 的地方）────────
//
// 回归理由：早期三处命令都对任务目录用 shellSingleQuote 整段包单引号，而 remote-tmp
// 的目录是 `${TMPDIR:-/tmp}/...` —— 单引号会阻止 shell 展开，于是 wrapper 语法看着
// 完全正确、实际会去找一个字面名叫 `${TMPDIR:-/tmp}` 的目录。
{
  // 含 $ ⇒ 双引号（可展开）
  assert.equal(quoteRemotePath("${TMPDIR:-/tmp}/a"), '"${TMPDIR:-/tmp}/a"');
  assert.equal(quoteRemotePath("$HOME/a"), '"$HOME/a"');
  // 不含 $ ⇒ 单引号（最安全，防注入）
  assert.equal(quoteRemotePath("/tmp/plain"), "'/tmp/plain'");
  // 含单引号 + 不含 $ ⇒ 单引号内转义
  assert.equal(quoteRemotePath("/tmp/a'b"), "'/tmp/a'\\''b'");
  // 含 $ 且含双引号 ⇒ 双引号内转义双引号
  assert.equal(quoteRemotePath('$HOME/a"b'), '"$HOME/a\\"b"');
  // 空值不崩
  assert.equal(quoteRemotePath(null), "''");
}

// ── lowSpaceWarnings：两条文案，含实际数字 ──────────────────────────────
{
  const warnings = lowSpaceWarnings(1024, 65536);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /1024 KB/, "要报出实测空间");
  assert.match(warnings[0], /65536 KB/, "要报出阈值");
  assert.match(warnings[1], /运维故障/, "第二条说明降级不解决根因");
}

// ── 单引号转义：命令里带单引号也不能破坏 wrapper 结构 ─────────────────────
{
  assert.equal(shellSingleQuote("echo hi"), "'echo hi'");
  // 内部单引号用 '\'' 关闭-转义-重开
  assert.equal(shellSingleQuote("echo 'x'"), "'echo '\\''x'\\'''");
  const command = remoteWrapperCommand({ dir: "/d", command: "echo 'hello world'" });
  assert.match(command, /echo '\\''hello world'\\'''/, "引号被安全转义");
}

// ── 状态与清理命令的内容 ─────────────────────────────────────────────────
{
  const status = remoteStatusCommand({ dir: "/tmp/.dsh-xssh-ops/t1" });
  assert.match(status, /MISSING/, "目录不在要能区分出来");
  assert.match(status, /cat "\/tmp\/\.dsh-xssh-ops\/t1\/exit\.code"/);
  assert.match(status, /wc -c <"/);
  assert.match(remoteDeleteCommand({ dir: "/tmp/.dsh-xssh-ops/t1" }), /rm -rf "\$d"/);
}

// ── 状态解析 ─────────────────────────────────────────────────────────────
{
  assert.deepEqual(parseStatus("RUNNING\nBYTES 123 0"), { state: "running", exitCode: null, bytes: { out: 123, err: 0 } });
  assert.deepEqual(parseStatus("EXIT 0\nBYTES 999 12"), { state: "done", exitCode: 0, bytes: { out: 999, err: 12 } });
  assert.deepEqual(parseStatus("EXIT 127\nBYTES 0 0"), { state: "done", exitCode: 127, bytes: { out: 0, err: 0 } });
  assert.deepEqual(parseStatus("MISSING"), { state: "missing", exitCode: null, bytes: { out: 0, err: 0 } });
  // 噪声 + 结果混在一起
  assert.deepEqual(parseStatus("bash: warning\nRUNNING\nBYTES 5 6\nroot@h:~#"), { state: "running", exitCode: null, bytes: { out: 5, err: 6 } });
  assert.deepEqual(parseStatus("junk"), { state: "unknown", exitCode: null, bytes: { out: 0, err: 0 } });
}

// ── 预检命令本身：一次往返、四级判定 ─────────────────────────────────────
{
  const command = probeCommand();
  assert.match(command, /\$\{TMPDIR:-\/tmp\}/, "尊重远端 TMPDIR");
  assert.ok(command.includes('[ -d "$d" ] && [ -w "$d" ]'), "先判临时目录可写");
  assert.match(command, /command -v df/, "df 可用性要先探测（缺失不能当空间不足）");
  assert.match(command, /echo "TMP_OK"/, "df 缺失时要回 TMP_OK（仍用远端）");
  assert.ok(command.includes('[ -d "$HOME" ] && [ -w "$HOME" ]'), "次选家目录");
  assert.match(command, /echo "NONE"/, "都没有");
  // **一次往返**：多行拼接仍是单条命令（不能变成多次 exec）
  assert.ok(command.split("\n").length <= 10, `命令不该无限膨胀（实际 ${command.split("\n").length} 行）`);
  assert.equal(command.includes("&&"), true, "用 && 串起来避免多余子 shell");
}

console.log("task dir: probe parsing, three-tier placement, degradation warnings and remote wrappers all hold");
