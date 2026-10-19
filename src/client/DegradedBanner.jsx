/**
 * 降级告警条（M4）。
 *
 * 计划 5.5.5 要求「降级」这件事**同时出现在三处**，这是第三处（面板顶部）：
 *   1. 面板顶部红色告警条  ← 本组件
 *   2. 工具返回的 `degraded: true` + `warnings[]`（让智能体转述）
 *   3. 台账/日志页签的 `location: "local"` + `degraded: true`
 *
 * 三条必须守住的语义：
 *   - **不可关闭（dismiss）**：降级意味着「结果不留远端、断线即中断」，属于必须知道
 *     的状态，不是一个可以点掉的提示。要它消失只有两条路：任务结束、或用户把任务删了。
 *   - **文案原样来自台账**：与工具返回、日志页签完全一致（同一份 warnings），不在这里
 *     另写一套措辞 —— 三处说法不一致比不显示更糟。
 *   - **只显示未结束的降级任务**：已结束的不该一直占着告警位（host 侧已过滤）。
 */
import * as React from "react";
import { t } from "../i18n/core.js";
const { useCallback, useEffect, useState } = React;

const POLL_MS = 4000;

export function DegradedBanner({ api, visible = true }) {
  const [notices, setNotices] = useState([]);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      const result = await api.taskDegradedNotices();
      if (result?.ok === false) return;
      setNotices(result?.value?.degraded ?? result?.degraded ?? []);
    } catch { /* 告警条读失败不该打扰用户；下一次轮询会重试 */ }
  }, [api]);

  useEffect(() => {
    if (!visible) return undefined;
    void load();
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [visible, load]);

  if (notices.length === 0) return null;

  return (
    <div style={styles.root} role="alert" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.taskId} style={styles.item}>
          <div style={styles.title}>
            {t("⚠ 后台任务已降级到本地临时目录：结果不留远端；断线即中断；远端磁盘空间不足需尽快处理")}
          </div>
          {notice.warnings.length > 0 && (
            <div style={styles.detail}>{notice.warnings.join(" ")}</div>
          )}
          <div style={styles.meta}>
            {notice.label !== "" && <span>{notice.label} · </span>}
            <span>{notice.command}</span>
            {notice.localDir !== null && <span> · {notice.localDir}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

const styles = {
  root: { flex: "none", display: "flex", flexDirection: "column", gap: 2, padding: "4px 6px", background: "rgba(122,59,59,.22)", borderBottom: "1px solid #7a3b3b" },
  item: { padding: "2px 2px" },
  title: { fontSize: 11, fontWeight: 600, lineHeight: "16px", color: "#f7c2c2" },
  detail: { fontSize: 11, lineHeight: "16px", color: "#f0b4b4", marginTop: 1 },
  meta: { fontSize: 10, lineHeight: "15px", color: "#d8a0a0", marginTop: 1, fontFamily: "ui-monospace, Consolas, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
};
