/**
 * 设置页折叠组（用户 2026-10-19）。
 *
 * 连接设置、服务器管理、凭据、自定义提示词共用同一套折叠外观：标题在左、
 * 当前值摘要（digest）在右，收起时也能看到状态，而不是「藏起来」。
 */
import * as React from "react";

const styles = {
  group: { border: "1px solid var(--dsw-alias-border-l3, #3a414b)", borderRadius: 8, background: "var(--dsw-alias-bg-layer-2, #161b21)", overflow: "hidden", marginBottom: 10 },
  summary: { display: "flex", alignItems: "center", gap: 8, padding: "9px 11px", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary, #e6e8eb)", listStyle: "none", userSelect: "none" },
  summaryText: { flex: "1 1 auto", minWidth: 0 },
  digest: { flex: "none", fontSize: 12, fontWeight: 400, color: "var(--dsw-alias-label-secondary, #b9c0ca)", maxWidth: "55%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  body: { padding: "4px 11px 12px", display: "flex", flexDirection: "column", gap: 10 }
};

export function SettingsGroup({ title, digest, open = false, onToggle, children }) {
  return (
    <details style={styles.group} open={open} onToggle={(event) => onToggle?.(event.currentTarget.open)}>
      <summary style={styles.summary}>
        <span style={styles.summaryText}>{title}</span>
        {digest !== undefined && digest !== null && digest !== "" && (
          <span style={styles.digest} title={String(digest)}>{digest}</span>
        )}
      </summary>
      <div style={styles.body}>{children}</div>
    </details>
  );
}
