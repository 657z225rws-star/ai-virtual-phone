// 桌面小组件（My Space）→ 聊天 App 的跳转意图。
// 聊天 App 每次打开都重新挂载，延迟补发自定义事件会因挂载时序不确定而丢失，
// 或先落在默认 tab 再跳转造成"闪一下"。这里把意图写入 sessionStorage，
// 挂载方在首帧 useState 初始化时直接消费，彻底消除时序竞争。

export type ChatWidgetView = "add-friend" | "messages";

const CHAT_WIDGET_VIEW_KEY = "chat-widget-pending-view";

export function setChatWidgetIntent(view: ChatWidgetView) {
  try {
    sessionStorage.setItem(CHAT_WIDGET_VIEW_KEY, view);
  } catch {
    // sessionStorage 不可用（隐私模式等）时静默降级，仅靠事件通道
  }
}

export function consumeChatWidgetIntent(): ChatWidgetView | null {
  try {
    const raw = sessionStorage.getItem(CHAT_WIDGET_VIEW_KEY);
    if (raw) sessionStorage.removeItem(CHAT_WIDGET_VIEW_KEY);
    if (raw === "add-friend" || raw === "messages") return raw;
    return null;
  } catch {
    return null;
  }
}
