/**
 * Build the Monaco bundle served by the host asset route.
 *
 * 产物 `lib/monaco.min.js` 是 IIFE：加载后挂到 globalThis.xsshMonaco，前端只在
 * 第一次打开编辑器时才通过 <script> 注入，首屏不承担这 ~2MB。
 */
import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [resolve(rootDir, "src/client/monaco-entry.js")],
  outfile: resolve(rootDir, "lib/monaco.min.js"),
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  legalComments: "none",
  logLevel: "info"
});
