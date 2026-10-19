/**
 * 后台任务的落点选择与降级判定（计划 5.5.5 / Q3 落地细则）
 *
 * 为什么单独成模块：这段逻辑是**安全与可解释性**的核心 —— 落点错了会让用户以为
 * 结果留在远端（实际断线即丢），或把任务塞进一个已经写满的磁盘。它必须能被完全
 * 确定性地测（预检输出、阈值、覆盖开关，全是纯函数），而不是埋在工具调用里。
 *
 * 三级落点（计划 5.5.5 表格）：
 *   1. `remote-tmp`   ---- `$TMPDIR`（缺省 `/tmp`）存在可写 **且** KB ≥ minRemoteFreeKb；
 *   2. `remote-home`  ---- 无可用 /tmp，但远端 `$HOME` 可写（仍是远端后台，轻提示）；
 *   3. `local`        ---- 远端无可用临时目录，**或**空间低于阈值 ⇒ 降级本地 + 严重警告。
 *
 * 两个用户覆盖开关（覆盖不等于无风险，仍然告警）：
 *   - `allowLowSpace`: 低空间仍坚持在远端跑；
 *   - `forceLocal`:    强制走本地降级通道。
 *
 * 预检只用**一条命令**（计划要求「一次往返」），输出形如 `OK <kb>` / `HOME` / `NONE`。
 */
import { join as joinPath, posix } from "node:path";
import { t } from "./i18n/core.js";

/** 远端可用空间阈值（计划 5.7：`minRemoteFreeKb` 默认 64 MiB）。 */
export const DEFAULT_MIN_REMOTE_FREE_KB = 65536;
/** 远端产物保留时长（计划 5.7：`taskTtlHours` 默认 24 h）。 */
export const DEFAULT_TASK_TTL_HOURS = 24;
/** 远端落点根目录名（三级都建在它下面，便于一次性清理）。 */
export const REMOTE_ROOT_NAME = ".dsh-xssh-ops";

/**
 * 预检命令：一次往返判定落点。
 *
 * 与计划 5.5.5 写的那段一致，但**空间判定挪到调用方**（这里只报原始 KB），
 * 这样阈值可配、可测，且同样的输出能被不同阈值复用。
 */
export function probeCommand() {
  return [
    'd="${TMPDIR:-/tmp}"',
    // 三级判定，**先判可写再判空间**：
    //   1. 可写且能拿到空间数 ⇒ `OK <kb>`（可据阈值拒绝）；
    //   2. 可写但拿不到空间数（没有 df/awk —— busybox、精简容器、Windows Git Bash
    //      都会这样）⇒ `TMP_OK`：**仍然用远端**。拿不到空间数不等于空间不足，
    //      为此降级到本地是过度反应（早期版本正是这样：df 缺失 ⇒ 空输出 ⇒ 判不可用
    //      ⇒ 白白降级，实测在 Git Bash 上踩到）。
    //   3. 临时目录不可写但家目录可写 ⇒ `HOME`；
    //   4. 都没有 ⇒ `NONE`（此时才降级）。
    //
    // **同时回显展开后的绝对路径**：`DIR <路径>`。这是为了让台账能存**真实路径**
    // 而不是 shell 模板（`${TMPDIR:-/tmp}/...`）。早期只回结论、不回路，于是台账里
    // 存的是模板字面量，`cat`/`rm` 全都找不到文件（实测：文件其实在 `/tmp`）。
    'if [ -d "$d" ] && [ -w "$d" ]; then',
    '  echo "DIR $d";',
    '  if command -v df >/dev/null 2>&1; then',
    '    kb=$(df -Pk "$d" 2>/dev/null | awk \'NR==2{print $4}\' 2>/dev/null);',
    '    if [ -n "$kb" ]; then echo "OK $kb"; else echo "TMP_OK"; fi;',
    '  else echo "TMP_OK"; fi;',
    'elif [ -d "$HOME" ] && [ -w "$HOME" ]; then echo "DIR $HOME"; echo "HOME";',
    'else echo "NONE"; fi'
  ].join("\n");
}

/**
 * 解析预检输出。容忍噪声（登录横幅、提示符、locale 报错等都会混进来），
 * 只认**最后一行**有效结果 —— 这是实测里最稳的判据。
 * @param {string} stdout
 */
export function parseProbe(stdout) {
  const lines = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  // `DIR <绝对路径>` 是**展开后的真实目录**：台账与后续 cat/rm 都要用它，
  // 不能用 shell 模板形态（否则会去读一个字面名叫 `${TMPDIR:-/tmp}` 的路径）。
  let dir = null;
  for (const line of lines) {
    const matched = /^DIR\s+(.+)$/.exec(line);
    if (matched !== null) dir = matched[1].trim();
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const ok = /^OK\s+(\d+)$/.exec(line);
    if (ok !== null) return { kind: "tmp", freeKb: Number(ok[1]), dir: dir ?? "/tmp" };
    // 临时目录可写但空间未知（远端没有 df/awk）。**仍然是可用落点** ——
    // 只是无法据阈值判断，所以 freeKb 为 null（判定时按"未超阈值"处理）。
    if (line === "TMP_OK") return { kind: "tmp", freeKb: null, dir: dir ?? "/tmp" };
    if (line === "HOME") return { kind: "home", freeKb: null, dir: dir ?? "~" };
    if (line === "NONE") return { kind: "none", freeKb: null, dir: null };
  }
  // 完全没有可识别结果 ⇒ 视作不可用（宁可降级并告警，也不要假装远端可用）。
  return { kind: "unparsed", freeKb: null, dir: null };
}

/**
 * 选落点。纯函数：预检结果 + 阈值 + 覆盖开关 ⇒ 落点与告警。
 *
 * @param {object} input
 * @param {{kind: string, freeKb: number|null}} input.probe
 * @param {number} [input.minRemoteFreeKb]
 * @param {boolean} [input.allowLowSpace]
 * @param {boolean} [input.forceLocal]
 * @param {boolean} [input.allowLocalDegrade] 关闭时**不降级**而是直接报错（计划 5.7）
 */
export function decideLocation({
  probe,
  minRemoteFreeKb = DEFAULT_MIN_REMOTE_FREE_KB,
  allowLowSpace = false,
  forceLocal = false,
  allowLocalDegrade = true
} = {}) {
  const threshold = Number.isFinite(minRemoteFreeKb) && minRemoteFreeKb >= 0 ? minRemoteFreeKb : DEFAULT_MIN_REMOTE_FREE_KB;
  const warnings = [];

  if (forceLocal === true) {
    warnings.push(t("用户要求强制使用本地通道。"));
    // **降级的三重告警在这里也要给**：降级的后果与原因无关（结果不留远端、
    // 断线即中断、远端问题仍在），早期只给了一条"强制"说明 —— 用户看不到
    // 完整代价（实测被工具层 e2e 抓到：service 层测的是"空间不足"分支，
    // 那里有三重告警，于是这条分支的缺失只有走 force_local 才暴露）。
    warnings.push(...degradedWarnings());
    return finish("local", true, warnings, { overridden: true });
  }

  const kind = probe?.kind ?? "unparsed";

  if (kind === "tmp") {
    // `freeKb === null` ⇒ 远端可写但空间未知（没有 df/awk）。这是**可用落点**：
    // 拿不到空间数不等于空间不足，不能当作 0 去比阈值（早期写成 `?? 0`，
    // 会把"未知"当成"零空间"从而白白降级到本地 —— 实测在 Git Bash 上踩到）。
    const freeKb = Number.isFinite(probe?.freeKb) ? probe.freeKb : null;
    if (freeKb === null) {
      warnings.push(t("远端可写但没有 df/awk，拿不到可用空间：无法按阈值判断，仍在远端执行。"));
      return finish("remote-tmp", false, warnings, { freeKb: null, spaceUnknown: true });
    }
    if (freeKb >= threshold) {
      return finish("remote-tmp", false, warnings, { freeKb });
    }
    // 低于阈值
    if (allowLowSpace === true) {
      warnings.push(t(`远端临时目录可用空间仅 ${freeKb} KB（低于阈值 ${threshold} KB），按用户要求仍在远端执行。`));
      return finish("remote-tmp", false, warnings, { freeKb, overridden: true });
    }
    warnings.push(...lowSpaceWarnings(freeKb, threshold));
    warnings.push(...degradedWarnings());
    if (allowLocalDegrade === false) {
      return finish("blocked", false, warnings, { freeKb, blocked: true });
    }
    return finish("local", true, warnings, { freeKb });
  }

  if (kind === "home") {
    warnings.push(t("远端没有可用的临时目录，改用家目录存放本次任务产物（注意家目录空间）。"));
    return finish("remote-home", false, warnings, {});
  }

  // none / unparsed
  warnings.push(
    kind === "unparsed"
      ? t("远端落点预检没有给出可识别结果（可能不是 POSIX 环境），按无可用临时目录处理。")
      : t("远端既没有可写的临时目录，也没有可写的家目录。")
  );
  if (allowLocalDegrade === false) {
    return finish("blocked", false, warnings, { blocked: true });
  }
  warnings.push(...degradedWarnings());
  return finish("local", true, warnings, {});
}

/** 低空间触发的告警文本（人可读，供工具返回与面板告警条共用）。 */
export function lowSpaceWarnings(freeKb, threshold) {
  return [
    t(`远端临时目录可用空间不足：${freeKb} KB < 阈值 ${threshold} KB。`),
    t("远端磁盘空间不足是运维故障，本次降级只保住任务本身，不解决问题。")
  ];
}

/** 降级本地时的三重告警文本（面板条 / 工具返回 / 台账共用同一份文案）。 */
export function degradedWarnings() {
  return [
    t("后台任务已降级到本地临时目录：结果不留远端。"),
    t("该通道依赖连接存活，断线即中断（不像远端 nohup 会继续跑）。"),
    t("远端磁盘空间不足需尽快处理。")
  ];
}

function finish(location, degraded, warnings, extra) {
  return {
    location,
    degraded: degraded === true,
    warnings: [...warnings],
    remoteMode: location === "remote-tmp" || location === "remote-home",
    ...extra
  };
}

/** 远端任务目录（**shell 模板形态**：`${TMPDIR:-/tmp}/...`，用于包装命令里让远端自己展开）。
 *
 * ⚠ 注意：这个返回值**不是可直接使用的真实路径** —— 它含 shell 模板变量。
 * 要落到台账或用于 `cat`/`ls`/`rm` 这类命令，必须先经 `resolveRemoteTaskDir()`
 * 展开成真实路径。早期把本函数的返回值直接存进台账并用于 `cat`，导致
 * **taskRead / taskStatus / taskDelete 全都读不到文件**（实测：台账里的
 * `remoteDir` 是字面量 `${TMPDIR:-/tmp}/...`，而文件其实在 `/tmp/...`）。
 */
export function remoteTaskDir(location, taskId, { tmpRoot = "${TMPDIR:-/tmp}", homeRoot = "$HOME" } = {}) {
  if (location === "remote-tmp") return posix.join(tmpRoot, REMOTE_ROOT_NAME, taskId);
  if (location === "remote-home") return posix.join(homeRoot, REMOTE_ROOT_NAME, taskId);
  return null;
}

/**
 * 把 `remoteTaskDir()` 的模板形态展开成**真实远端路径**（用于台账与后续命令）。
 *
 * 为什么单独一步：模板形态只有在**远端 shell 里**才有意义。展开需要知道远端
 * 当时的 `$TMPDIR`/`$HOME` —— 所以由调用方传入**探测到的真实值**（见 `probeCommand()`
 * 与 `parseProbe()`；探测已经拿到了可写目录，这里用它）。
 * 拿不到真实值时**退回 `/tmp`/`~`** 并标记 `assumed: true`：宁可给一个"很可能对"
 * 的真实路径，也不要给一个 shell 模板（后者必然读不到，是静默失败）。
 */
export function resolveRemoteTaskDir(location, taskId, { tmpRoot = null, homeRoot = null } = {}) {
  if (location === "remote-tmp") {
    const root = typeof tmpRoot === "string" && tmpRoot !== "" ? tmpRoot : "/tmp";
    return { path: posix.join(root, REMOTE_ROOT_NAME, taskId), assumed: root === "/tmp" && tmpRoot === null };
  }
  if (location === "remote-home") {
    const root = typeof homeRoot === "string" && homeRoot !== "" ? homeRoot : "~";
    return { path: posix.join(root, REMOTE_ROOT_NAME, taskId), assumed: root === "~" && homeRoot === null };
  }
  return { path: null, assumed: false };
}

/** 远端任务目录下的四个文件（与计划 5.5.5 的 outPath/errPath/exitPath/pidFile 对齐）。 */
export function remoteTaskFiles(dir) {
  return {
    stdout: posix.join(dir, "stdout.log"),
    stderr: posix.join(dir, "stderr.log"),
    exit: posix.join(dir, "exit.code"),
    pid: posix.join(dir, "pid")
  };
}

/** 本地降级模式的目录（Windows 上用 path.join，所以不在这里拼 POSIX 路径）。 */
export function localTaskDir(baseDir, taskId) {
  return joinPath(baseDir, taskId);
}

/**
 * 远端执行包装（计划 5.5.5）：
 *   `setsid nohup sh -c '<cmd>' >out 2>err </dev/null &` + 记录 pid + 用一个
 *   子 shell `wait` 出 exit code，最后回一句 `ready` 让调用方确认已经起来了。
 *
 * 两个「启动器」上的坑（都实测过）：
 *   - `setsid` 不是 POSIX 标准命令，**很多环境没有**（Git for Windows 就没有）⇒ 先探测，
 *     缺失时退回 `nohup sh -c`；
 *   - **不要用 `sh -lc`**：`-l` 会读 profile 启动文件，在部分环境下后台化后
 *     **连输出都写不出来**（`nohup sh -lc 'echo X' >out` 得到空文件，`sh -c` 正常）。
 *
 * **`ready` 必须是有条件的**，否则它连自己承诺的事都做不到。三层校验（都踩过）：
 *   1. `mkdir` 失败 ⇒ `FAIL mkdir`：早期无条件 echo ready，远端建不了目录也报成功；
 *   2. `pid` 写不进去 ⇒ `FAIL pid`：同上；
 *   3. **子进程还活着**（`kill -0`）⇒ 否则 `FAIL exec`：`sh -c` 里的命令若找不到，
 *      子进程会立刻退出而 pid 早已拿到，没有这一层就仍然会"假成功"
 *      （实测：stdout 空、exit.code=127、却回了 ready）。
 */
export function remoteWrapperCommand({ dir, command, useSetsid = true }) {
  const quoted = shellSingleQuote(command);
  // `setsid` 不是 POSIX 标准命令：**不少环境没有它**（实测 Git for Windows 的
  // usr/bin 就没有）。硬用它会让子命令根本不执行，却因为后续步骤仍然回 `ready`
  // 而"看起来成功"（实测：stdout 空、exit.code=127、wrapper 照样回 ready）。
  //
  // 所以：**用之前先探测**，没有就退回 `nohup`。差异是「会话脱离」的强度：
  // 有 setsid 时进程完全脱离控制终端，断连也活；没有 setsid 时靠 nohup 忽略 SIGHUP，
  // 对「断开 SSH 后仍继续跑」这个目标通常也够用（nohup 本就是为此设计的）。
  //
  // 启动器**用 `sh -c` 而不是 `sh -lc`**：`-l` 是 login shell，会去读 profile 启动文件，
  // 在部分环境下（实测 Git for Windows）**后台化后连输出都写不出来** ——
  // `nohup sh -lc 'echo X' >out 2>err &` 得到的是**空文件**，而 `nohup sh -c` 正常。
  // `-l` 对后台任务本来也没有意义（它只为登录会话准备环境），去掉它既更稳也更可预测。
  const setsidCheck = useSetsid
    ? `if command -v setsid >/dev/null 2>&1; then launcher="setsid nohup sh -c"; else launcher="nohup sh -c"; fi`
    : `launcher="nohup sh -c"`;
  return [
    `d=${quoteRemotePath(dir)}`,
    // `ready` 必须**有条件**地回：早期版本把 `echo ready` 无条件放在最后，于是
    // `mkdir` 失败（远端缺 coreutils、目录不可写、磁盘满）时仍然回 ready ——
    // 调用方以为后台任务起来了，实际输出文件全写不进去。实测在 Git Bash 上踩到：
    // `mkdir: command not found` 之后照样 echo ready。
    // 现在：建目录失败 ⇒ 回 `FAIL mkdir`（调用方据此报 background-start-failed）。
    'mkdir -p "$d" || { echo "FAIL mkdir"; exit 1; }',
    // 启动器按可用性择一（缺 setsid 时退回 nohup，见上面的说明）
    setsidCheck,
    // **在同一层启动并等待**：`wait` 只能等**自己这个 shell** 的子进程。
    // 早期把它拆成「先 `$launcher ... &` 拿 $!，再用一个子 shell `( wait $pid )`」——
    // 子 shell 里没有那个 job，`wait` 报 "no such job" 并返回 127，于是 `exit.code`
    // **谎报 127**（实测：命令明明跑对了、stdout 正确，exit.code 却是 127）。
    // 现在把启动与 wait 放在同一个子 shell 里，$? 就是真退出码。
    `{ $launcher ${quoted} >"$d/stdout.log" 2>"$d/stderr.log" </dev/null; echo $? >"$d/exit.code"; } &`,
    'pid=$!',
    // 启动后立刻确认 pid 还活着且有 pid 文件可写 —— 这才算真的起来了。
    'echo $pid >"$d/pid" || { echo "FAIL pid"; exit 1; }',
    // **确认子进程还活着**：`sh -c` 里的命令若找不到，子进程会立刻退出而 pid 早已拿到。
    // 只写 pid 文件不足以证明「真的起来了」—— 实测就是这样：
    // stdout 空、exit.code=127、却回了 ready。
    // `kill -0` 是 POSIX 标准的「进程是否存活」探测，不依赖 coreutils。
    'kill -0 "$pid" 2>/dev/null || { echo "FAIL exec"; exit 1; }',
    'echo ready'
  ].join("\n");
}

/** 把字符串安全地包成 POSIX 单引号形式（内部单引号用 '\'' 转义）。 */
export function shellSingleQuote(text) {
  return `'${String(text ?? "").replace(/'/g, "'\\''")}'`;
}
/**
 * 远端路径的引号处理：**含 `$` 的路径不能整段单引号包**，否则变量不展开 ——
 * `${TMPDIR:-/tmp}/...` 会被当成一个字面目录名（实测踩到：wrapper 看着对、落点全错）。
 * 这类路径留在双引号里才有 shell 展开语义；不含 `$` 的走单引号（最安全）。
 */
export function quoteRemotePath(path) {
  const value = String(path ?? "");
  if (!value.includes("$")) return shellSingleQuote(value);
  // 双引号内只需转义 \ 与 " 本身（路径由我们拼装，不含反引号等危险序列）。
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}


/** 远端任务状态查询：读 exit.code 与两个日志的字节数 + 进程是否还在。 */
export function remoteStatusCommand({ dir }) {
  const files = remoteTaskFiles(dir);
  return [
    `d=${quoteRemotePath(dir)}`,
    `if [ ! -d "$d" ]; then echo "MISSING"; exit 0; fi`,
    `if [ -f "${files.exit}" ]; then echo "EXIT $(cat "${files.exit}")"; else echo "RUNNING"; fi`,
    `out=0; [ -f "${files.stdout}" ] && out=$(wc -c <"${files.stdout}")`,
    `err=0; [ -f "${files.stderr}" ] && err=$(wc -c <"${files.stderr}")`,
    `echo "BYTES $out $err"`
  ].join("\n");
}

/** 解析状态输出 ⇒ `{ state, exitCode, bytes }`。 */
export function parseStatus(stdout) {
  const lines = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim());
  let state = "unknown";
  let exitCode = null;
  let out = 0;
  let err = 0;
  for (const line of lines) {
    if (line === "MISSING") state = "missing";
    else if (line === "RUNNING") state = "running";
    else {
      const exit = /^EXIT\s+(-?\d+)$/.exec(line);
      if (exit !== null) { state = "done"; exitCode = Number(exit[1]); }
      const bytes = /^BYTES\s+(\d+)\s+(\d+)$/.exec(line);
      if (bytes !== null) { out = Number(bytes[1]); err = Number(bytes[2]); }
    }
  }
  return { state, exitCode, bytes: { out, err } };
}

/** 远端清理命令：删任务目录（`xssh_task_delete` 用）。 */
export function remoteDeleteCommand({ dir }) {
  return [
    `d=${quoteRemotePath(dir)}`,
    `[ -d "$d" ] && rm -rf "$d"`,
    'echo cleaned'
  ].join("\n");
}
