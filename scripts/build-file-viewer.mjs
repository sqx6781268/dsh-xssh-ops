/**
 * Build the file-viewer bundle served by the host asset route.
 *
 * 产物 `lib/file-viewer.min.js` 是 IIFE：加载后挂到 globalThis.xsshFileViewer，
 * 前端首次预览 Office/PDF 等格式时才加载（与 Monaco 同一套本地资产机制）。
 */
import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [resolve(rootDir, "src/client/file-viewer-entry.jsx")],
  outfile: resolve(rootDir, "lib/file-viewer.min.js"),
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  loader: { ".jsx": "jsx" },
  legalComments: "none",
  logLevel: "info"
});
