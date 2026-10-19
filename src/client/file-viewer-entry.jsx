/**
 * file-viewer 的本地打包入口（用户 2026-10-19）。
 *
 * 产物 `lib/file-viewer.min.js`（IIFE）挂到 globalThis.xsshFileViewer，前端首次
 * 预览非文本/非图片文件时按需加载。React 一起打包，FileViewer 在自己的 root 里
 * 渲染，与插件组件树互不影响。
 */
import * as React from "react";
import { createRoot } from "react-dom/client";
import { FileViewer } from "@file-viewer/react";
import { officeRenderers } from "@file-viewer/preset-office";
import { parseMsDocToHtml } from "@file-viewer/doc";

function mount(container, options) {
  const root = createRoot(container);
  // officeRenderers 是 preset 对象（{ id, label, renderers }），按官方提示用
  // options.preset 注入；preset-office 导入时还会执行自动注册，两条路都保留。
  root.render(React.createElement(FileViewer, { ...options, preset: officeRenderers }));
  return {
    unmount() {
      try { root.unmount(); } catch { /* 忽略 */ }
    }
  };
}

/**
 * .doc（Word 97 二进制）不走 FileViewer 的 renderer：@file-viewer/doc 是独立的
 * 解析/渲染库，这里单独导出挂载入口，文件页签对 .doc 使用这条路径。
 */
async function mountDoc(container, file) {
  const rendered = await parseMsDocToHtml(file);
  const wrapper = document.createElement("div");
  wrapper.className = "msdoc-root";
  wrapper.innerHTML = rendered.html;
  container.innerHTML = "";
  container.appendChild(wrapper);
  if (rendered.css) {
    const style = document.createElement("style");
    style.textContent = rendered.css;
    container.appendChild(style);
  }
  return {
    unmount() {
      container.innerHTML = "";
    }
  };
}

globalThis.xsshFileViewer = { mount, mountDoc, version: "3.2.2" };
