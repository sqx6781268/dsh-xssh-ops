/**
 * dsh-xssh-ops browser plugin entry.
 *
 * - Official Sidebar mode (requires `sidebarRightTabs` + `sidebarRight`): the
 *   SSH terminal is a TAB of the official right-Sidebar, beside the built-in
 *   Files tab. Registration follows the same public two-stage path every tab
 *   type uses — the type into `ctx.sidebarRightTabs`, the body into the keyed
 *   `sidebar.right.pane.tab` seat under the type's `id`. The session-header
 *   SSH button opens or focuses that tab (repeated clicks focus, never
 *   duplicate). Width, split, fullscreen and collapse are the Sidebar's; no
 *   floating panel, no chat-column margin, no own resize. The legacy floating
 *   drawer for pre-Sidebar DSH has been removed: a host without the Sidebar
 *   services shows no terminal UI (agent tools keep working), so the
 *   registration simply waits and never falls back.
 *
 * Connection lifetime is independent of the view: switching tabs, collapsing
 * the Sidebar, closing the SSH tab, or switching chats never disconnects;
 * terminals are pooled client-side (`terminal-pool.js`) and the host replays
 * output buffered while no view was attached.
 */
import * as React from "react";
import { createSshApi } from "./api.js";
import { IconTerminal16 } from "./IconTerminal16.jsx";
import { SshSidebarBody } from "./SshSidebarBody.jsx";
import { SshResources } from "./SshResources.jsx";
import { withSettingsBoundary } from "./settings-boundary.jsx";
import { sshUiAnnounceAgentConnections, sshUiSetSurfaceOpener } from "./store.js";
import { startAgentConnectionPoll } from "./agent-connection-poll.js";
import { activateSidebarWhenAvailable } from "./sidebar-lifecycle.js";
import { readHostLanguage, setLanguage } from "./locale.js";
import { installSettingsNavIcon } from "./nav-icon.js";
import TYPERT_REMOTE from "../remote.js";

const NS = "xssh-ops";

/** The tab kind this plugin owns in the official Sidebar, and its registry id. */
export const SSH_TAB_KIND = "xssh";
export const SSH_TAB_ID = "dsh-xssh-ops";

export const inject = ["remote", "remote.credentials", "slots", "locale", "connection"];

export async function apply(ctx) {
  const disposers = [];
  /** Track one disposer; on any later failure everything unwinds in reverse. */
  const own = (dispose) => {
    if (typeof dispose === "function") disposers.push(dispose);
    return dispose;
  };
  try {
    const dispose = await ctx.remote.$mount(TYPERT_REMOTE);
    own(dispose);
  } catch (error) {
    for (const d of disposers.reverse()) await d();
    throw error;
  }

  const api = createSshApi(ctx);

  // Agent-connected servers must surface even while the SSH tab is closed
  // (issue #25 real-machine feedback): xssh_connect_profile opens transport +
  // session host-side, and without a poll nobody reveals the tab — the user
  // had to find the terminal by hand, and a second server never appeared
  // beside the first. The plugin root is always mounted, so it owns the
  // slow poll; the panel's own refresh is the fast path while it is open.
  own(startAgentConnectionPoll(api, sshUiAnnounceAgentConnections));

  own(ctx.locale.register(NS, {
    zh: {
      // 显示名统一为「XSSH 工具」（用户 2026-10-17 指定）：插件页的名字来自
      // locale/*.json 的 meta.title，这里是侧栏标签 / 设置页段名 / 引导页标题，
      // 两处必须同名，否则同一个插件在不同入口叫不同名字。
      settingsSectionLabel: "XSSH 工具", // i18n-ignore: host locale entry
      sidebarTabTitle: "XSSH 终端", // i18n-ignore: host locale entry
      // 会话顶部标签条上那个按钮的**按钮文字**（很窄，所以取最短形态；
      // 完整说明放 title 提示里）。此前是硬编码 "SSH"，改名后没跟上。
      sidebarTabLabel: "XSSH", // i18n-ignore: host locale entry
      openSidebarTab: "打开或聚焦 XSSH 终端标签", // i18n-ignore: host locale entry
      guideTitle: "XSSH 工具", // i18n-ignore: host locale entry
      guideDescription: "从 dsh-ssh-ops 改进而来。", // i18n-ignore: host locale entry
      // 语言探测专用键：**永不用于显示**，所以改任何界面文案都不会破坏探测。
      // （曾经踩过：locale.js 用 sidebarTabTitle 的值做探测，改名后语言判断失效。）
      languageProbe: "zh" // i18n-ignore: host locale entry
    },
    en: {
      settingsSectionLabel: "XSSH Tools",
      sidebarTabTitle: "XSSH Terminal",
      sidebarTabLabel: "XSSH",
      openSidebarTab: "Open or focus the XSSH terminal tab",
      guideTitle: "XSSH Tools",
      guideDescription: "Improved from dsh-ssh-ops.",
      languageProbe: "en"
    }
  }));

  const hostT = ctx.locale.bind(NS);

  // Follow the host's language before any surface paints. An explicit
  // combobox choice sticks; otherwise (follow mode) the plugin adopts
  // whatever DSH Settings → Language shows now and on every later change the
  // locale face reports, writing it back so the host half (agent-visible
  // messages) speaks the same language after the next restart.
  own(syncLanguageWithHost(api, ctx));

  // The Sidebar's service faces may be provided after this bundle is
  // evaluated; register through the delayed lifecycle instead of a one-time
  // ctx.get() snapshot that would permanently miss them. There is no fallback
  // surface anymore — if the Sidebar path fails, the error is only reported.
  own(activateSidebarWhenAvailable(ctx, {
    registerSidebar: (sidebarCtx) => applySidebarRegistrations(sidebarCtx, { api, hostT }),
    onSidebarError: (error) => {
      console.error("[dsh-xssh-ops] sidebar tab registration failed; no terminal surface available:", error);
    }
  }));

  // The settings nav glyph: the host's section slot has no icon field (its
  // navIcon table falls back to the gear), so paint our terminal mark over
  // the gear on our own row — same DOM-marker technique as dshmarket.
  own(installSettingsNavIcon(ctx, () => hostT("settingsSectionLabel")));

  // SSH resources are a first-class settings section, beside General and
  // Models. Keeping them under Settings → Plugins made an operational
  // inventory look like implementation detail and forced an extra tab click.
  // The header SSH button remains only a terminal visibility toggle.
  own(ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "xssh-ops-resources",
        order: 35,
        label: () => hostT("settingsSectionLabel"), // getter: the host menu re-renders it per language change
        icon: "terminal",
        locale: NS,
        inject: () => ({ api, credentials: ctx.remote?.credentials })
      },
      withSettingsBoundary(SshResources)
    )
  ));

  return async () => {
    for (const d of disposers.reverse()) await d();
  };
}

/** Official Sidebar registrations: both stages live under one disposable scope. */
function applySidebarRegistrations(ctx, { api, hostT }) {
  const disposers = [];
  const own = (dispose) => {
    if (typeof dispose === "function") disposers.push(dispose);
    return dispose;
  };
  try {
    // Surfaces that do not own a pane (the resources page) ask for the
    // terminal through the shared store; that means focusing the Sidebar
    // tab. Cleared on release so a disposed registration cannot keep calling
    // into a host whose Sidebar is gone.
    sshUiSetSurfaceOpener(() => {
      try {
        ctx.sidebarRight.openTab(SSH_TAB_KIND);
      } catch (error) {
        console.warn("[dsh-xssh-ops] openTab failed:", error?.message ?? error);
      }
    });
    own(() => sshUiSetSurfaceOpener(null));
    own(ctx.sidebarRightTabs.register({
      id: SSH_TAB_ID,
      kind: SSH_TAB_KIND,
      priority: "extension",
      title: () => hostT("sidebarTabTitle"),
      guide: [{
        order: 20,
        title: () => hostT("guideTitle"),
        description: () => hostT("guideDescription"),
        icon: IconTerminal16
      }]
    }));
    own(ctx.slots.inject("sidebar.right.pane.tab", () =>
      ctx.slots.register(
        {
          name: "sidebar.right.pane.tab",
          key: SSH_TAB_ID,
          locale: NS,
          inject: () => ({ api, credentials: ctx.remote?.credentials })
        },
        SshSidebarBody
      )
    ));
    own(ctx.slots.inject("conversation.session.header.actions", () =>
      ctx.slots.register(
        {
          name: "conversation.session.header.actions",
          id: "xssh-ops-tab-action",
          order: 90,
          locale: NS
        },
        function SshSidebarTabAction() {
          return React.createElement(SshTabButtonHost, {
            press: () => {
              try {
                ctx.sidebarRight.openTab(SSH_TAB_KIND);
              } catch (error) {
                console.warn("[dsh-xssh-ops] openTab failed:", error?.message ?? error);
              }
            },
            isActive: () => {
              try {
                if (!ctx.sidebarRight.isExpanded()) return false;
                return ctx.sidebarRight.active()?.kind === SSH_TAB_KIND;
              } catch {
                return false;
              }
            },
            title: hostT("openSidebarTab"),
            ariaLabel: hostT("sidebarTabTitle"),
            label: hostT("sidebarTabLabel"),
            watchActive: true
          });
        }
      )
    ));
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
}

// 注入按钮的标记：**选择器与 dataset 属性名必须来自同一处**，否则改一边忘一边会
// 退化成「找不到按钮 → 反复插入」的无限重复（实测把标签条刷成几十个 SSH）。
// dataset 属性名是 camelCase，浏览器会转成 `data-` + 连字符形式。
const SSH_TAB_DATASET_KEY = "dshXsshOpsTab";
const SSH_TAB_ATTR = `data-${SSH_TAB_DATASET_KEY.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`; // data-dsh-xssh-ops-tab
const SSH_TAB_SELECTOR = `[${SSH_TAB_ATTR}="true"]`;

// 同一套派生规则也用于「已复制过来的高亮类名」标记。
const SSH_TAB_ACTIVE_CLASS_KEY = "dshXsshOpsActiveClass";

/** 自检：属性名派生是否符合预期（写错常量时构建期就发现，而不是等到界面刷屏）。
 *  这是开发者诊断，不是用户可见文案，所以用英文、不进 i18n 字典。 */
if (SSH_TAB_ATTR !== "data-dsh-xssh-ops-tab") {
  throw new Error(`xssh tab injection: derived dataset attribute is "${SSH_TAB_ATTR}" but the selector expects "data-dsh-xssh-ops-tab"`);
}

/**
 * The settings dialog also owns a tablist.  SSH belongs only beside the
 * conversation / trajectory view tabs, never inside Settings → Plugins.
 */
function findConversationTablist() {
  return [...document.querySelectorAll('[role="tablist"]')].find((tablist) => {
    const text = tablist.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
    return (text.includes("对话") && text.includes("轨迹")) // i18n-ignore: sniffs the HOST tab labels
      || (text.includes("conversation") && text.includes("trajectory"));
  });
}

function syncSshTabButton(button, active, { title, activeTitle }) {
  const activeClass = button.dataset[SSH_TAB_ACTIVE_CLASS_KEY];
  if (activeClass) button.classList.toggle(activeClass, active);
  button.setAttribute("aria-pressed", active ? "true" : "false");
  button.title = active ? (activeTitle ?? title) : title;
  // The copied host tab class carries an underline.  Explicitly control it so
  // SSH only looks selected while its terminal view is actually showing.
  button.style.setProperty(
    "color",
    active ? "var(--dsw-alias-brand, #2d6cdf)" : "var(--dsw-alias-label, currentColor)",
    "important"
  );
  button.style.setProperty(
    "border-bottom-color",
    active ? "var(--dsw-alias-brand, #2d6cdf)" : "transparent",
    "important"
  );
}

/**
 * Shared host for the DOM-injected SSH button in the conversation tab strip.
 * The chat tab strip re-renders constantly during message streaming; the
 * observer only needs to keep one button mounted, so bursts coalesce into at
 * most one scan per animation frame. Behavior (press / active) is injected by
 * the mode-specific caller; the Sidebar mode additionally polls `isActive`,
 * because the Sidebar's layout store is session-scoped and offers no
 * cross-plugin subscription for the small "is my tab showing" read.
 */
function SshTabButtonHost({ press, isActive, title, activeTitle, ariaLabel, label, watchActive }) {
  React.useEffect(() => {
    const mount = () => {
      const tablist = findConversationTablist();
      if (!tablist) return;
      // An older plugin client used the first tablist on the page, which can
      // be Settings → Plugins. Remove that stale misplaced control whenever
      // the current client mounts, then keep exactly one in the chat tab bar.
      document.querySelectorAll(SSH_TAB_SELECTOR).forEach((button) => {
        if (!tablist.contains(button)) button.remove();
      });
      let button = tablist.querySelector(SSH_TAB_SELECTOR);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        // 用同一个常量派生属性名，杜绝「选择器与属性不一致」再次发生。
        button.dataset[SSH_TAB_DATASET_KEY] = "true";
        button.setAttribute("aria-label", ariaLabel);
        // Copy an unselected host tab.  Copying the first tab would also copy
        // its `tabActive` class, whose ::after pseudo-element leaves a bright
        // underline visible even while the SSH view is not showing.
        const inactiveTab = tablist.querySelector('[role="tab"][aria-selected="false"]');
        const fallbackTab = tablist.querySelector('[role="tab"]');
        button.className = inactiveTab?.className ?? fallbackTab?.className.replace(/\S*tabActive\b/g, "").trim() ?? "";
        const selectedTab = tablist.querySelector('[role="tab"][aria-selected="true"]');
        const activeClass = [...(selectedTab?.classList ?? [])].find(
          (className) => /tabActive\b/.test(className) && !button.classList.contains(className)
        );
        if (activeClass) button.dataset[SSH_TAB_ACTIVE_CLASS_KEY] = activeClass;
        tablist.appendChild(button);
      }
      // 文案每次 mount 都同步，而不是只在创建时写死：宿主语言切换后按钮要跟着变，
      // 而这里也是唯一能保证「已经存在的按钮」被更新的地方。
      if (button.textContent !== label) button.textContent = label;
      // 标题也要跟着语言走；原先只在创建时 setAttribute，切语言后不再更新。
      button.setAttribute("aria-label", ariaLabel);
      // Assignment (rather than addEventListener) makes remounts idempotent.
      button.onclick = () => press();
      syncSshTabButton(button, isActive(), { title, activeTitle });
    };

    mount();
    let scheduled = false;
    let animationFrame = null;
    let disposed = false;
    const observer = new MutationObserver(() => {
      if (disposed || scheduled) return;
      scheduled = true;
      animationFrame = requestAnimationFrame(() => {
        animationFrame = null;
        scheduled = false;
        if (disposed) return;
        mount();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      disposed = true;
      observer.disconnect();
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      document.querySelectorAll(SSH_TAB_SELECTOR).forEach((button) => button.remove());
    };
  }, []);

  React.useEffect(() => {
    if (!watchActive) return undefined;
    const sync = () => {
      document.querySelectorAll(SSH_TAB_SELECTOR).forEach((button) => {
        syncSshTabButton(button, isActive(), { title, activeTitle });
      });
    };
    sync();
    const timer = setInterval(sync, 1000);
    return () => clearInterval(timer);
  }, [watchActive]);

  // 语言切换后更新**已存在**按钮的文案与无障碍标签。这里不能依赖上面那个
  // `[]` 依赖的 mount effect：它只在挂载时跑一次，而本组件返回 null、语言变化
  // 不会触发重挂载 —— 于是按钮文字会一直停在上一次的语言。
  React.useEffect(() => {
    document.querySelectorAll(SSH_TAB_SELECTOR).forEach((button) => {
      if (button.textContent !== label) button.textContent = label;
      button.setAttribute("aria-label", ariaLabel);
    });
  }, [label, ariaLabel]);

  return null;
}


/**
 * Resolve the stored language choice and keep follow mode tracking the host.
 * Returns a disposer for the optional live subscription.
 */
function syncLanguageWithHost(api, ctx) {
  let disposed = false;
  let unsubscribe = null;
  const applyFollow = async () => {
    if (disposed) return;
    let stored = null;
    try {
      // The stored settings decide whether the plugin follows the host at
      // all: autoApplySystemLanguage=false pins the stored language (a
      // third-party system locale such as "ru" would otherwise be coerced to
      // "zh" and written back on every load). Read them first so the pin is
      // respected even before the host locale is consulted.
      stored = await api.languageGet();
      if (disposed) return;
    } catch {
      // Older host without the languageGet RPC: treat as auto mode with no
      // stored pin and fall through to the synchronous host-locale read.
    }
    if (stored?.autoApplySystemLanguage === false) {
      if (stored.language !== null) setLanguage(stored.language);
      return;
    }
    const host = readHostLanguage(ctx.locale);
    if (host !== null) {
      setLanguage(host);
      // Write back so the host half (agent-visible messages) follows the
      // same language immediately and after the next restart.
      api.languageSave(host).catch(() => {});
      return;
    }
    // `stored` 可能是 null（老宿主没有 languageGet RPC —— catch 分支后 stored 仍是 null）。
    // 早期这里写 `stored?.language !== null`：**当 stored 为 null 时**，可选链求值为
    // `undefined`，而 `undefined !== null` 为 true ⇒ 进入分支后 `stored.language`
    // **必然抛 TypeError**（实测：加载产物后 apply 的异步后续直接崩）。
    // 与上面 397 行同一写法：先确认 stored 存在。
    if (stored !== null && stored !== undefined && stored.language !== null) setLanguage(stored.language);
  };
  void applyFollow();
  // Best-effort live follow: the documented face exposes subscribe; older
  // hosts simply re-resolve on the next plugin load.
  try {
    if (typeof ctx.locale?.subscribe === "function") {
      unsubscribe = ctx.locale.subscribe(() => { void applyFollow(); });
    }
  } catch {}
  return () => {
    disposed = true;
    try { unsubscribe?.(); } catch {}
  };
}
