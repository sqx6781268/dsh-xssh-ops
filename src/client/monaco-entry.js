/**
 * Monaco 入口（打进 lib/monaco.min.js，由 host 的 /xssh-ops/assets/ 路由提供）。
 *
 * 只带 editor.api + 基础语言（basic-languages），不含语言服务 Worker：
 * 语法高亮、行号、折叠、查找替换、自动缩进都可用，但不做类型检查/校验，
 * 因此产物小、无需跨域 Worker 配置。挂到 globalThis 供 loader 直接读取。
 */
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/basic-languages/monaco.contribution";

globalThis.xsshMonaco = monaco;
