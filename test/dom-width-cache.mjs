// 终端 DOM 渲染器「canvas 测宽」补丁的单元测试（用户 2026-10-24）。
//
// 存在理由：这个补丁直接摸 `@xterm/xterm` 5.5.0 的**私有**结构
// （`term._core._renderService._renderer.value._widthCache` 与
//  `WidthCache._measure(text, variant)`），源码 review 看不出「位约定写反了」
// 或「校准形同虚设」这类错误 —— 写反了不会报错，只会让粗体/斜体渲染成别种字体。
// 所以把两条最容易错、且可在 Node 里用替身断言的判据钉成测试：
//   1. `variant` 位约定：xterm 的 `FontVariant` 是 REGULAR=0 / BOLD=1 / ITALIC=2
//      / BOLD_ITALIC=3，`get()` 里是 `bold && (variant |= 1)`、`italic && (variant |= 2)`；
//      补丁必须按同一约定还原 font 简写，否则粗体会用常规字重、斜体会丢倾斜。
//   2. 校准失败必须**放弃补丁**并保留 xterm 原行为（两种测量差超过阈值时）。
// 真实浏览器里的收益（改一次字号 4.1–11.3 秒 → 8ms）不在这里断言，见 docs 记录。
import assert from "node:assert/strict";
import {
  buildCanvasFont,
  patchDomRendererWidthCache,
  unpatchDomRendererWidthCache
} from "../src/client/dom-width-cache.js";

/**
 * 造一个形状与 xterm 5.5.0 一致的 DOM 渲染器替身。
 *
 * @param {object} [options]
 * @param {number} [options.domAdvance] DOM 侧单字符宽度（offsetWidth / 重复次数）
 * @param {number} [options.canvasAdvance] canvas 侧单字符宽度
 * @param {boolean} [options.bareRenderer] `_renderer` 直接是渲染器（不用 .value 包装）
 */
function makeFakeTerm({ domAdvance = 7.8125, canvasAdvance = 7.8, bareRenderer = false } = {}) {
  // xterm 的 `_measureElements` 是 4 个 span（regular / bold / italic / boldItalic），
  // 顺序即 FontVariant。替身用「长度 × 单字宽」模拟 offsetWidth（真浏览器里是整数像素）。
  const measureElements = [0, 1, 2, 3].map(() => {
    const element = { textContent: "" };
    Object.defineProperty(element, "offsetWidth", {
      get() {
        return Math.round(element.textContent.length * domAdvance);
      }
    });
    return element;
  });

  const canvasCalls = [];
  // font 用 getter/setter 记录「写入次数」：补丁的约定是字体描述没变时不重写，
  // 用普通属性没法断言这条（每次测量都会读到旧值）。
  const fontWrites = [];
  const ctx = {
    _font: "",
    measureText(text) {
      canvasCalls.push({ font: ctx._font, text });
      return { width: canvasAdvance * text.length };
    }
  };
  Object.defineProperty(ctx, "font", {
    get() {
      return ctx._font;
    },
    set(value) {
      ctx._font = value;
      fontWrites.push(value);
    }
  });
  const doc = {
    createElement(tag) {
      if (tag === "canvas") {
        return { getContext: (kind) => (kind === "2d" ? ctx : null) };
      }
      return { style: {} };
    }
  };

  // 与 xterm 原始实现同语义：按 variant 选测量元素，量 32 次再除以 32。
  const cache = {
    _font: "TestMono, monospace",
    _fontSize: 13,
    _weight: "normal",
    _weightBold: "bold",
    _measureElements: measureElements,
    _measure(text, variant) {
      const element = measureElements[variant];
      element.textContent = text.repeat(32);
      return element.offsetWidth / 32;
    }
  };

  const renderer = { _widthCache: cache };
  const term = {
    _core: { _renderService: { _renderer: bareRenderer ? renderer : { value: renderer } } },
    element: { ownerDocument: doc }
  };
  return { term, cache, ctx, canvasCalls, fontWrites, measureElements };
}

// ── font 简写组装 ─────────────────────────────────────────────────────────
assert.equal(buildCanvasFont(), "normal normal 13px monospace");
assert.equal(
  buildCanvasFont({ style: "italic", weight: "700", size: 15, family: "MesloLGS NF, monospace" }),
  "italic 700 15px MesloLGS NF, monospace"
);

// ── 正常打补丁：标记、替换、日志 ──────────────────────────────────────────
{
  const { term, cache } = makeFakeTerm();
  const original = cache._measure;
  const logs = [];
  const patched = patchDomRendererWidthCache(term, { log: (message) => logs.push(message) });

  assert.equal(patched, true, "等宽且两路测量一致时必须打上补丁");
  assert.notEqual(cache._measure, original, "_measure 必须被替换");
  assert.equal(cache.__xsshOpsCanvasMeasure, true, "实例上要留幂等标记");
  assert.equal(cache.__xsshOpsOriginalMeasure, original, "原始实现要留一份以便回滚");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /已启用 canvas 测宽补丁/, "成功时打一条中文诊断");
  assert.match(logs[0], /0\.01px/, "日志要带校准偏差，便于判断测量是否可信");

  // 幂等：重复挂不能套娃（否则每次字号变化都会多包一层）
  const firstPatched = cache._measure;
  assert.equal(patchDomRendererWidthCache(term), true);
  assert.equal(cache._measure, firstPatched, "重复调用不得再次包装");
}

// ── variant 位约定：1=粗体、2=斜体、3=粗斜体（写反会静默用错字体）────────
{
  const { term, cache, ctx, fontWrites } = makeFakeTerm();
  patchDomRendererWidthCache(term);

  cache._measure("x", 0);
  assert.equal(ctx.font, "normal normal 13px TestMono, monospace", "variant 0 = 常规");

  cache._measure("x", 1);
  assert.equal(ctx.font, "normal bold 13px TestMono, monospace", "variant 1 = 粗体（用 _weightBold）");

  cache._measure("x", 2);
  assert.equal(ctx.font, "italic normal 13px TestMono, monospace", "variant 2 = 斜体（字重仍为常规）");

  cache._measure("x", 3);
  assert.equal(ctx.font, "italic bold 13px TestMono, monospace", "variant 3 = 粗斜体");

  // 宽度取自 canvas，且按正文字符数缩放（不是固定值）
  assert.equal(cache._measure("abc", 0), 7.8 * 3, "宽度要按字符数线性放大");

  // 字体描述没变时不重复写 ctx.font（避免每次测量都让 canvas 重新解析字体）
  fontWrites.length = 0;
  cache._measure("a", 0);
  cache._measure("b", 0);
  assert.equal(fontWrites.length, 0, "字体描述未变时不得重写 ctx.font");

  cache._measure("c", 1);
  assert.equal(fontWrites.length, 1, "字体描述变化时写一次");
  cache._measure("d", 1);
  assert.equal(fontWrites.length, 1, "同一字体下连续测量不得重复写");
}

// ── 校准失败：两种测量相差过大就放弃，保持 xterm 原行为 ────────────────────
{
  const { term, cache } = makeFakeTerm({ domAdvance: 7.8125, canvasAdvance: 9.2 });
  const original = cache._measure;
  const logs = [];
  const patched = patchDomRendererWidthCache(term, { log: (message) => logs.push(message) });

  assert.equal(patched, false, "测量不可信时不得打补丁");
  assert.equal(cache._measure, original, "失败时 _measure 必须保持原样");
  assert.equal(cache.__xsshOpsCanvasMeasure, undefined, "失败时不应该留任何标记");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /宽度测量补丁跳过/, "跳过时也要留中文诊断");
}

// ── 结构不匹配：一律静默返回 false，绝不抛出 ──────────────────────────────
{
  // ① 没有 _core（终端还没 open）
  assert.equal(patchDomRendererWidthCache({}), false);
  assert.equal(patchDomRendererWidthCache(undefined), false);

  // ② 渲染器不是 DOM 渲染器（canvas / webgl 没有 _widthCache）
  const canvasRenderer = { _core: { _renderService: { _renderer: { value: {} } } } };
  assert.equal(patchDomRendererWidthCache(canvasRenderer), false);

  // ③ 测量元素数量不对（上游改了内部结构）
  const { term, cache } = makeFakeTerm();
  cache._measureElements = cache._measureElements.slice(0, 2);
  assert.equal(patchDomRendererWidthCache(term), false, "结构变更时必须安全退化");

  // ④ 拿不到 2d 上下文（jsdom / 无 canvas 环境）
  const noCanvas = makeFakeTerm();
  noCanvas.term.element.ownerDocument = { createElement: () => ({ getContext: () => null }) };
  assert.equal(patchDomRendererWidthCache(noCanvas.term), false);
}

// ── _renderer 不带 .value 包装时也要能取到（跨 xterm 版本容错）─────────────
{
  const { term, cache } = makeFakeTerm({ bareRenderer: true });
  assert.equal(patchDomRendererWidthCache(term), true);
  assert.equal(cache.__xsshOpsCanvasMeasure, true);
}

// ── 回滚：unpatch 恢复原实现，之后还能重新打上 ────────────────────────────
{
  const { term, cache } = makeFakeTerm();
  const original = cache._measure;
  patchDomRendererWidthCache(term);

  assert.equal(unpatchDomRendererWidthCache(term), true);
  assert.equal(cache._measure, original, "回滚后必须还原成 xterm 原实现");
  assert.equal(cache.__xsshOpsCanvasMeasure, false);
  assert.equal(cache.__xsshOpsOriginalMeasure, undefined);

  // 没打过补丁时回滚是空操作
  assert.equal(unpatchDomRendererWidthCache(term), false);

  assert.equal(patchDomRendererWidthCache(term), true, "回滚后可以重新打上");
  assert.notEqual(cache._measure, original);
}

console.log("dom width cache: variant bits, calibration fallback, structure tolerance and rollback all hold");
