/**
 * Local SSH test server for dsh-ssh-ops.
 *
 * Spins up a password-authenticated ssh2 Server on 127.0.0.1 so the plugin can
 * be exercised against a real SSH transport without a remote host. Run several
 * instances on different ports to simulate multiple servers for the multi-tab
 * feature.
 *
 *   node test-sshd.mjs            # port 2222
 *   node test-sshd.mjs 2223       # port 2223
 *
 * Credentials: any username / password "test123".
 *
 * Channels:
 *   - exec  -> runs the command through the platform shell and streams stdout/stderr
 *              with a real exit code (exercises ssh_exec).
 *   - shell -> runs an interactive platform shell and pipes stdin/stdout
 *              to it (exercises the terminal + ssh_write Enter).
 *   - sftp  -> a sandboxed SFTP subsystem over one root directory (see
 *              test-sftp-server.mjs), seeded with sample files so the file
 *              manager, editor, export and download paths can run for real.
 *   - direct-tcpip -> forwards an accepted channel to its requested target, so
 *              local forwards and the dynamic SOCKS5 tunnel work offline.
 */
import ssh2 from "ssh2";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { attachSftp } from "./test-sftp-server.mjs";
import { fileURLToPath } from "node:url";

const { Server } = ssh2;

const PORT = Number(process.argv[2] ?? 2222);
const PASSWORD = "test123";
const IS_WINDOWS = process.platform === "win32";
/**
 * `--posix-shell <path>`：让 Windows 上的离线服务器改用**POSIX shell**执行命令。
 *
 * 用途：本插件的「远端后台任务」按 POSIX 假设实现（`setsid`/`nohup`/`df -Pk`/`$TMPDIR`）。
 * 默认的 `cmd.exe` 会让这些命令全部失败 ⇒ 只能验到降级路径。给一个 `sh.exe`
 * （Git Bash / MSYS）就能在本地真机验收**正常路径**（远端落点、真实后台化、产物落远端文件）。
 * 不指定时行为与之前完全一致（`cmd.exe`）。
 */
const POSIX_SHELL_ARG = process.argv.indexOf("--posix-shell");
const POSIX_SHELL = POSIX_SHELL_ARG >= 0 ? process.argv[POSIX_SHELL_ARG + 1] : null;
const SHELL = POSIX_SHELL ?? (IS_WINDOWS ? "cmd.exe" : "/bin/sh");
/** 命令参数形态：POSIX shell 用 `-c`；cmd.exe 用 `/Q /C`。 */
const SHELL_IS_POSIX = POSIX_SHELL !== null || !IS_WINDOWS;
/**
 * 子进程是否**自己会回显输入**。
 *
 * `cmd.exe` 不会（我们要替它模拟终端的 ECHO）；而 `sh.exe` 作为 shell 被启动、
 * 且直接往 stdin 写入时**自己会回显**。判断错了就会双份回显，进而让命令台账的
 * 区间起点偏一行 —— 那是产品的核心语义，测试环境必须与真实一致。
 */
const SHELL_ECOES_INPUT = POSIX_SHELL !== null;
/**
 * `--posix-path <dir>`：前置到子进程的 PATH。
 *
 * 为什么需要：Windows 上直接 spawn `sh.exe` 时环境里没有 `/usr/bin`，
 * 导致 Git 自带的 coreutils（mkdir/df/awk…）全部找不到。用它可以验到
 * **完整 POSIX 远端**的正常路径，而不只是「缺命令远端」的报错路径。
 */
const POSIX_PATH_ARG = process.argv.indexOf("--posix-path");
const POSIX_PATH = POSIX_PATH_ARG >= 0 ? process.argv[POSIX_PATH_ARG + 1] : null;

/**
 * SFTP sandbox: one directory this server exposes, seeded with the shapes the
 * plugin's file panel has to handle — text, a subdirectory, a "binary" file
 * and an empty file.
 */
const SFTP_ROOT = process.argv.includes("--sftp-root")
  ? resolve(process.argv[process.argv.indexOf("--sftp-root") + 1])
  : join(os.tmpdir(), `dsh-sshd-sandbox-${PORT}`);
if (process.argv.includes("--reset-sftp-root")) {
  rmSync(SFTP_ROOT, { recursive: true, force: true });
}
mkdirSync(join(SFTP_ROOT, "config"), { recursive: true });
const seed = (relative, content) => {
  const target = join(SFTP_ROOT, relative);
  if (existsSync(target)) return;
  writeFileSync(target, content);
};
seed("welcome.txt", "hello from test-sshd\n");
seed("config/nginx.conf", "server {\n  listen 80;\n  server_name test-sshd.local;\n}\n");
seed("empty.txt", "");
seed("binary.bin", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03]));

// Persist the host key so restarts keep the same fingerprint (a real sshd keeps
// a fixed host key; regenerating one each run would trip the plugin's TOFU host
// key check on every restart).
//
// `--host-key <path>`：给**并发跑**用。默认那个固定路径在并发下会撞车 —— 多个进程
// 同时发现文件不存在、同时生成、同时写同一个文件，于是有的进程读到半写内容而
// 握手失败（实测：全量跑时偶发 `m1-m3-e2e.mjs` 失败，单独跑却总是通过）。
// 并发脚本各给一个自己的路径即可（串行跑仍用默认路径，指纹保持稳定）。
const HOST_KEY_ARG = process.argv.indexOf("--host-key");
const HOST_KEY_PATH = HOST_KEY_ARG >= 0
  ? resolve(process.argv[HOST_KEY_ARG + 1])
  : resolve(dirname(fileURLToPath(import.meta.url)), "test-sshd-hostkey.pem");
let hostKey;
if (existsSync(HOST_KEY_PATH)) {
  hostKey = readFileSync(HOST_KEY_PATH, "utf8");
} else {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  // ssh2 wants the host key as a PEM string, not a KeyObject.
  hostKey = privateKey.export({ type: "pkcs1", format: "pem" });
  // **原子写**：`existsSync` + `writeFileSync` 是 classic TOCTOU —— 两个并发进程
  // 都可能看到"不存在"然后同时写，读者就可能读到半写内容（表现为偶发握手失败）。
  // 走 `.tmp` + `rename`：rename 在同一文件系统上是原子的，读者要么看到完整旧文件、
  // 要么看到完整新文件。并发下后写者覆盖先写者也无妨（两边都是合法 host key）。
  const tmpPath = `${HOST_KEY_PATH}.${process.pid}.tmp`;
  writeFileSync(tmpPath, hostKey, "utf8");
  try { renameSync(tmpPath, HOST_KEY_PATH); } catch { /* 已被别的进程建好也无妨 */ }
  try { if (existsSync(tmpPath)) rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
}

function runShell(stream, args, { onExit, interactive = false } = {}) {
  const child = spawn(SHELL, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // An interactive shell needs its own prompt: without it there is nothing
    // for the panel (or shell integration) to key on.
    //
    // `--posix-path <dir>` 会被前置到 PATH：Windows 上的 `sh.exe` 被**直接 spawn**
    // 时（而不是经 git-bash 启动器），环境里**没有 `/usr/bin`** —— 于是 `mkdir`/`df`/`awk`
    // 这些明明存在的 coreutils 全都 `command not found`。实测踩到：我据此误判过
    // 「本机缺 coreutils，无法验收 POSIX 正常路径」，其实只是 PATH 没带上。
    env: SHELL_IS_POSIX
      ? {
          ...process.env,
          // `!` 前缀 = **替换**整个 PATH（而不是前置）：给「缺 coreutils 远端」的
          // 模拟用 —— 前置空目录后 `df` 仍能从宿主 PATH 找到，模拟就不成立
          // （实测：bare-remote 测试两次拿到相反结论的根源）。
          ...(POSIX_PATH === null ? {} : {
            PATH: POSIX_PATH.startsWith("!")
              ? POSIX_PATH.slice(1)
              : `${POSIX_PATH}:${process.env.PATH ?? ""}`
          }),
          PS1: "dsh-test$ ",
          PS2: "> ",
          TERM: "xterm-256color",
          ...(interactive ? {} : { PS1: "" })
        }
      : process.env
  });
  child.stdout.on("data", (d) => { if (!stream.destroyed) stream.write(d); });
  child.stderr.on("data", (d) => { if (!stream.destroyed) stream.stderr.write(d); });
  stream.on("data", (d) => {
    if (!child.stdin.writable) return;
    // The terminal's Enter key is a carriage return (CR). Linux's line
    // discipline (icrnl) turns that CR into a line terminator; Windows cmd.exe
    // is CRLF-oriented and would otherwise ignore a lone CR. Expand CR/LF to
    // CRLF so the local Windows test server behaves like a Linux shell —
    // POSIX shells (including a Windows sh.exe) want LF instead.
    const normalized = SHELL_IS_POSIX
      ? d.toString("utf8").replace(/\r\n?/g, "\n")
      : d.toString("utf8").replace(/\r\n?|\n/g, "\r\n");
    // Simulate a real PTY's ECHO: pipe the typed line back to the client so the
    // command text is visible, exactly as a Linux terminal echoes keystrokes.
    //
    // **但只在子进程自己不会回显时才模拟**：`cmd.exe` 不依赖 tty 输入回显，
    // 而 `sh.exe` 在被当作 shell 启动、且我们直接往它的 stdin 写东西时**自己会回显**
    // （实测：客户端只发了一次 `echo X`，却收到两行回显 —— 一行并进提示符、
    //   一行单独成行）。再补一次就成了双回显，会让「命令回显行」变成两行，
    // 从而把命令台账的区间起点搞偏（行号区间是产品的核心语义）。
    if (!SHELL_ECOES_INPUT && !stream.destroyed) stream.write(normalized);
    child.stdin.write(normalized);
  });
  stream.on("close", () => { try { child.kill(); } catch {} });
  child.on("error", () => { try { stream.close(); } catch {} });
  child.on("close", (code) => {
    onExit?.(code);
    try { stream.exit(code ?? 0); stream.end(); } catch {}
  });
  return child;
}

const server = new Server({ hostKeys: [hostKey] }, (client) => {
  // A client that disconnects abruptly emits an 'error' (ECONNRESET); without
  // a handler that crashes the whole server.
  client.on("error", () => {});

  client.on("authentication", (ctx) => {
    if (ctx.method === "password" && ctx.password === PASSWORD) {
      ctx.accept();
    } else if (ctx.method === "none") {
      ctx.reject(["password"]);
    } else {
      ctx.reject();
    }
  });

  // direct-tcpip channels: what the plugin's local and dynamic (SOCKS5) tunnels
  // open through this server. Without this the channel request is rejected and
  // every forward fails — which is exactly the state an offline tunnel test
  // must not be stuck in.
  client.on("tcpip", (accept, reject, info) => {
    let channel;
    try { channel = accept(); } catch { try { reject?.(); } catch {} return; }
    channel.on("error", () => {});
    const target = net.connect(info.destPort, info.destIP === "0.0.0.0" ? "127.0.0.1" : info.destIP);
    target.on("connect", () => {
      target.on("error", () => channel.destroy());
      channel.on("error", () => target.destroy());
      channel.pipe(target);
      target.pipe(channel);
    });
    target.on("error", () => { try { channel.close(); } catch {} });
  });

  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      let term = "xterm-256color";
      let cols = 100;
      let rows = 30;
      let ptyRequested = false;

      session.on("pty", (acceptPty, rejectPty, info) => {
        if (!info?.term) { try { rejectPty?.(); } catch {} return; }
        ptyRequested = true;
        term = info.term ?? term;
        cols = info.cols ?? cols;
        rows = info.rows ?? rows;
        acceptPty?.();
      });

      session.on("window-change", (acceptChange, _reject, info) => {
        cols = info?.cols ?? cols;
        rows = info?.rows ?? rows;
        acceptChange?.();
      });

      session.on("shell", (acceptShell) => {
        const stream = acceptShell();
        stream.on("error", () => {});
        // Interactive shell. Windows cmd.exe needs CRLF input; POSIX shells
        // accept LF. `ptyRequested` marks the panel's terminals: those get a
        // real interactive shell so a prompt (and shell integration, which
        // rides the prompt) actually happens. exec channels and pty-less
        // shells stay non-interactive, exactly like a real server.
        const args = SHELL_IS_POSIX ? (ptyRequested ? ["-i"] : []) : ["/Q"];
        runShell(stream, args, {
          interactive: ptyRequested,
          onExit: (code) => { if (!stream.destroyed) { try { stream.exit(code ?? 0); } catch {} } }
        });
      });

      session.on("exec", (acceptExec, _reject, info) => {
        const stream = acceptExec();
        stream.on("error", () => {});
        const command = typeof info.command === "string" ? info.command : "";
        const args = SHELL_IS_POSIX ? ["-c", command] : ["/Q", "/C", command];
        runShell(stream, args, {
          onExit: (code) => { if (!stream.destroyed) { try { stream.exit(code ?? 0); } catch {} } }
        });
      });

      session.on("sftp", (acceptSftp, rejectSftp) => {
        let sftp;
        try { sftp = acceptSftp(); } catch { try { rejectSftp?.(); } catch {} return; }
        sftp.on("error", () => {});
        attachSftp(sftp, { root: SFTP_ROOT });
      });

      session.on("env", (acceptEnv) => acceptEnv?.());
      session.on("signal", (acceptSignal) => acceptSignal?.());
      session.on("close", () => {});
    });
  });
});

server.on("error", (err) => {
  console.error("[test-sshd] server error:", err.message);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[test-sshd] listening on 127.0.0.1:${PORT} (user: any / password: ${PASSWORD})`);
  console.log(`[test-sshd] sftp sandbox: ${SFTP_ROOT}`);
});
