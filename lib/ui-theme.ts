// lib/ui-theme.ts — 全局夜间模式（html[data-theme]）
//
// 用法：
// - app/layout.tsx 头部内联脚本在首帧渲染前同步应用，避免闪白
// - 设置开关调 setThemeMode 持久化并即时生效
//
// 深色变量定义见 styles/tokens.css 的 html[data-theme="dark"] 块。

const THEME_KEY = "float-theme-mode";

export type ThemeMode = "light" | "dark";

export function getThemeMode(): ThemeMode {
    try {
        return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
    } catch {
        return "light";
    }
}

export function applyThemeMode(mode: ThemeMode): void {
    if (typeof document === "undefined") return;
    if (mode === "dark") {
        document.documentElement.dataset.theme = "dark";
    } else {
        delete document.documentElement.dataset.theme;
    }
    // PWA 状态栏颜色跟随主题
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", mode === "dark" ? "#1a1a1a" : "#f8f7f2");
}

export function setThemeMode(mode: ThemeMode): void {
    try {
        localStorage.setItem(THEME_KEY, mode);
    } catch {
        // localStorage 不可用时仅本次会话生效
    }
    applyThemeMode(mode);
}
