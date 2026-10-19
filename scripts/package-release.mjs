import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Windows 兼容：new URL(...).pathname 会给出 /D:/...，拼进 join 变成 D:\D:\...
//（用户 2026-10-19 在其他 DSH 安装时发现「没有构建产物」，根因之一就是这里）。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const release = join(root, "release");
const archiveRoot = `${pkg.name}-${pkg.version}`;
const stage = join(release, archiveRoot);

rmSync(release, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// 运行时必需的条目（DSH 从目录安装只需要这些；src/test/scripts 不必随包）。
for (const entry of ["lib", "locale", "package.json", "package-lock.json", "cordis.patch.yml", "icon.svg", "README.md", "INSTALL.md", "LICENSE", "CHANGELOG.md"]) {
  const source = join(root, entry);
  if (existsSync(source)) cpSync(source, join(stage, basename(entry)), { recursive: true });
}

// npm tarball（.tgz）：按 package.json files 字段打包，安装脚本可用它。
// --ignore-scripts: prepare（会重新 build lib/）不能在打包时再跑一遍。
// Windows 上 npm 是 npm.cmd：新版 Node 拒绝直接 spawn 批处理（EINVAL），
// 统一经 cmd /c 转发（非 Windows 直接调用 npm）。
const packArgs = ["pack", "--ignore-scripts", "--pack-destination", release];
if (process.platform === "win32") {
  execFileSync("cmd", ["/c", "npm", ...packArgs], { cwd: root, stdio: "inherit" });
} else {
  execFileSync("npm", packArgs, { cwd: root, stdio: "inherit" });
}

// 目录压缩包：tar.gz 与 zip 各一份，解压后目录可直接被 dsh plugin add 使用。
// 两者都用 Windows 自带的 bsdtar（tar 命令），避免依赖 zip.exe。
const tarGz = join(release, `${archiveRoot}.tar.gz`);
const zip = join(release, `${archiveRoot}.zip`);
// 注意：bsdtar 把 "D:\..." 当成 host:path（Cannot connect to D:），所以这里
// cwd 切到 release、全部用相对名，避免盘符冒号被误解析。
try {
  execFileSync("tar", ["-czf", `${archiveRoot}.tar.gz`, archiveRoot], { cwd: release, stdio: "inherit" });
} catch (error) {
  console.warn(`tar.gz 生成失败：${error.message}`);
}
try {
  // bsdtar 的 -a 根据扩展名选择 zip 格式。
  // 本机 bsdtar 不支持 zip:compression 选项；zip 只是附带格式（未压缩，体积较大），
  // 主推 tar.gz / npm tgz。生成失败也不影响主产物。
  execFileSync("tar", ["-a", "-cf", `${archiveRoot}.zip`, archiveRoot], { cwd: release, stdio: "inherit" });
} catch (error) {
  console.warn(`zip 生成失败（可忽略）：${error.message}`);
}

rmSync(stage, { recursive: true, force: true });

for (const file of [tarGz, zip, join(release, `${pkg.name}-${pkg.version}.tgz`)]) {
  if (existsSync(file)) {
    const size = (statSync(file).size / 1024 / 1024).toFixed(1);
    console.log(`${file}  (${size} MB)`);
  }
}
console.log(`release assets created in ${release}`);
