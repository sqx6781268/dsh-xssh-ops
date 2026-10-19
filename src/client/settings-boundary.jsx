import * as React from "react";

/**
 * 设置页渲染错误边界（用户 2026-10-19）。
 *
 * 设置 section 的渲染异常会被宿主吞掉，界面只剩空白，没有任何线索。
 * 这里把错误信息直接显示出来（并 console.error 一份），既方便用户反馈，
 * 也避免「点一下设置页就白屏」时完全不知道发生了什么。
 */
export class SettingsBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[xssh-ops] settings render failed:", error, info);
  }

  render() {
    if (this.state.error !== null) {
      const detail = String(this.state.error?.stack ?? this.state.error?.message ?? this.state.error);
      return (
        <div style={{ padding: 16, fontSize: 13, lineHeight: 1.6 }}>
          <div style={{ fontWeight: 650, marginBottom: 8 }}>XSSH 设置页渲染失败（插件错误，已记录到控制台）</div>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 320, overflow: "auto", padding: 10, borderRadius: 8, background: "rgba(127,127,127,.08)", fontSize: 12 }}>{detail}</pre>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: 10, padding: "5px 12px", borderRadius: 6, cursor: "pointer", background: "transparent", border: "1px solid var(--dsw-alias-border-l3, #3a414b)", color: "inherit" }}
          >重试</button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** 用边界包住设置页组件，注册到 settings.section 时使用。 */
export function withSettingsBoundary(Component) {
  return function SettingsSectionWithBoundary(props) {
    return React.createElement(SettingsBoundary, null, React.createElement(Component, props));
  };
}
