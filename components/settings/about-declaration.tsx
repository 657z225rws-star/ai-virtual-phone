"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpCircle, Heart, Info, Loader2, RefreshCw, ShieldAlert } from "lucide-react";

/** 构建时注入：这一版是谁（Vercel 的提交号 + 构建时刻；本地开发是 dev） */
const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID || "dev";
const BUILD_TIME = process.env.NEXT_PUBLIC_BUILD_TIME || "";

function formatBuildTime(iso: string): string {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 这台设备上实际装着的版本：Service Worker 的缓存名就是版本号（ai-phone-pwa-v10-static） */
async function readRunningVersion(): Promise<string> {
    if (typeof caches === "undefined") return "";
    try {
        const keys = await caches.keys();
        const versions = keys
            .map(key => /^(ai-phone-pwa-v(\d+))/.exec(key))
            .filter((match): match is RegExpExecArray => Boolean(match))
            .map(match => ({ label: match[1], num: Number(match[2]) }));
        if (versions.length === 0) return "";
        versions.sort((a, b) => b.num - a.num);
        return versions[0].label;
    } catch {
        return "";
    }
}

/** 服务器上现在发布的是哪一版：直接读线上的 sw.js */
async function fetchServerVersion(): Promise<string> {
    try {
        const response = await fetch("/sw.js", { cache: "no-store" });
        const text = await response.text();
        return /CACHE_VERSION\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? "";
    } catch {
        return "";
    }
}

export function AboutDeclaration() {
    const [running, setRunning] = useState("");
    const [server, setServer] = useState("");
    const [checking, setChecking] = useState(false);
    const [message, setMessage] = useState("");

    useEffect(() => {
        void (async () => {
            setRunning(await readRunningVersion());
            setServer(await fetchServerVersion());
        })();
    }, []);

    const handleCheck = useCallback(async () => {
        setChecking(true);
        setMessage("");
        try {
            if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
                setMessage("这个环境没有 Service Worker（本地预览不注册），刷新页面即可");
                return;
            }
            const registration = await navigator.serviceWorker.getRegistration();
            if (!registration) {
                setMessage("还没有 Service Worker，刷新页面试试");
                return;
            }
            await registration.update();
            const latest = await fetchServerVersion();
            setServer(latest);
            const current = await readRunningVersion();
            setRunning(current);
            if (latest && current && latest !== current) {
                setMessage(`发现新版 ${latest}，正在刷新…`);
                setTimeout(() => window.location.reload(), 600);
                return;
            }
            setMessage("已经是最新版");
        } catch (error) {
            setMessage("检查失败：" + (error instanceof Error ? error.message : String(error)));
        } finally {
            setChecking(false);
        }
    }, []);

    const buildTime = formatBuildTime(BUILD_TIME);
    const hasUpdate = Boolean(server && running && server !== running);

    return (
        <div className="flex flex-col gap-5 h-full">
            <p className="card-section-label m-0 mx-2">免责声明</p>

            <div className="g-card">
                <div className="flex items-start gap-3">
                    <ShieldAlert size={20} className="shrink-0 mt-0.5 text-[var(--c-warning)]" />
                    <div className="flex flex-col gap-2">
                        <span className="menu-label font-semibold">AI 生成内容声明</span>
                        <span className="menu-desc ts-13 leading-relaxed !mt-0">
                            本应用内的所有角色对话、动态内容均为人工智能模型自动生成。生成内容不代表本平台的立场与观点，亦不对应任何现实中的人物、事件。用户应当自行辨别并承担使用风险。
                        </span>
                    </div>
                </div>
                <div className="ui-row-divider !mx-0" />
                <div className="flex items-start gap-3">
                    <Info size={20} className="shrink-0 mt-0.5 text-[var(--c-icon-active)]" />
                    <div className="flex flex-col gap-2">
                        <span className="menu-label font-semibold">隐私与数据安全</span>
                        <span className="menu-desc ts-13 leading-relaxed !mt-0">
                            您的日记、聊天记录及身份预设等敏感数据默认保存在本地浏览器中（LocalStorage/IndexedDB）。清理浏览器缓存可能会导致数据丢失，请注意妥善备份。
                        </span>
                    </div>
                </div>
            </div>

            <p className="card-section-label m-0 mx-2">相关信息</p>

            <div className="flex flex-col gap-2">
                <button className="g-card flex-row items-center">
                    <Heart size={20} fill="currentColor" className="shrink-0 text-[var(--c-icon-rose)]" />
                    <span className="menu-label flex-1">支持开发者</span>
                    <span className="menu-desc !mt-0">请我喝杯咖啡</span>
                </button>
            </div>

            <p className="card-section-label m-0 mx-2">版本</p>

            <div className="g-card">
                <div className="flex items-start gap-3">
                    <ArrowUpCircle size={20} className="shrink-0 mt-0.5 text-[var(--c-icon-active)]" />
                    <div className="flex flex-col gap-2 min-w-0">
                        <span className="menu-label font-semibold">当前版本</span>
                        <span className="menu-desc ts-13 leading-relaxed !mt-0">
                            {BUILD_ID}
                            {buildTime ? ` · 构建于 ${buildTime}` : ""}
                        </span>
                        <span className="menu-desc ts-13 leading-relaxed !mt-0">
                            {running ? `本机已装 ${running}` : "本机版本未知（还没装缓存）"}
                            {server ? ` · 服务器最新 ${server}` : ""}
                        </span>
                        {hasUpdate ? (
                            <span className="menu-desc ts-13 leading-relaxed !mt-0" style={{ color: "var(--c-warning)" }}>
                                有新版本，点下面按钮更新
                            </span>
                        ) : null}
                        {message ? <span className="menu-desc ts-13 leading-relaxed !mt-0">{message}</span> : null}
                    </div>
                </div>
                <button
                    type="button"
                    className="ui-btn ui-btn-outline"
                    style={{ alignSelf: "flex-start" }}
                    disabled={checking}
                    onClick={handleCheck}
                >
                    {checking ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />} 检查更新
                </button>
            </div>
        </div>
    );
}
