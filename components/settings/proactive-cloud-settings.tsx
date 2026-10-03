"use client";

// 主动消息（云端）设置
//
// 使用逻辑只保留一个开关：打开 = 自动验证云端 + 申请通知权限 + 订阅推送。
// 「连接并验证 / 开启推送 / 发测试推送 / 立即同步材料 / 刷新诊断」全部是排障用的，
// 收进「高级与诊断」，默认折叠、平时不用碰。

import { useCallback, useEffect, useRef, useState } from "react";
import { BellRing, CloudUpload, Loader2, RefreshCw, Send, ShieldCheck } from "lucide-react";
import { Alert } from "@/components/ui/feedback";
import { Input, Select, Toggle } from "@/components/ui/form";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import {
    checkConnection,
    ensurePushSubscription,
    getLocalPushStatus,
    getProactiveDiagnostics,
    isProactiveCloudReady,
    loadProactiveCloudConfig,
    normalizeWorkerUrl,
    patchProactiveCloudConfig,
    reconcileIntervalTasks,
    sendTestPush,
    syncProactiveMaterial,
    type ProactiveCloudConfig,
    type ProactiveDiagnostics,
} from "@/lib/proactive-cloud";

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({
    value: hour,
    label: `${String(hour).padStart(2, "0")}:00`,
}));

type StatusTone = "info" | "success" | "danger" | "warning";
type Line = { tone: StatusTone; text: string };

export function ProactiveCloudSettings({ onNotice }: { onNotice: (msg: string) => void }) {
    const [config, setConfig] = useState<ProactiveCloudConfig>(() => loadProactiveCloudConfig());
    const [characters, setCharacters] = useState<Character[]>([]);
    const [cloud, setCloud] = useState<Line | null>(null);
    const [push, setPush] = useState<Line | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [advanced, setAdvanced] = useState(false);
    const [diagnostics, setDiagnostics] = useState<ProactiveDiagnostics | null>(null);
    const [intervalDrafts, setIntervalDrafts] = useState<Record<string, string>>({});

    const applyConfig = useCallback((patch: Partial<ProactiveCloudConfig>) => {
        const next = patchProactiveCloudConfig(patch);
        setConfig(next);
        return next;
    }, []);

    /** 检查云端（不发权限请求），结果写进状态行 */
    const verifyCloud = useCallback(async (cfg?: ProactiveCloudConfig) => {
        const saved = cfg ?? loadProactiveCloudConfig();
        if (!normalizeWorkerUrl(saved.workerUrl)) {
            setCloud({ tone: "warning", text: "云端：还没填 Worker 地址（在「高级与诊断」里）" });
            return false;
        }
        const result = await checkConnection(saved);
        setCloud(result.ok
            ? { tone: "success", text: "云端：已连接" }
            : { tone: "danger", text: `云端：连不上 —— ${result.message}` });
        return result.ok;
    }, []);

    /** 申请通知权限 + 订阅推送（必须在用户手势里调用，所以从开关的 handler 直接调） */
    const enablePush = useCallback(async (cfg?: ProactiveCloudConfig) => {
        const saved = cfg ?? loadProactiveCloudConfig();
        const result = await ensurePushSubscription(saved);
        setPush(result.ok
            ? { tone: "success", text: "推送：已就绪" }
            : { tone: "warning", text: `推送：未开启 —— ${result.reason}` });
        return result.ok;
    }, []);

    /**
     * 推送状态一律"现查"：查本机有没有授权、有没有订阅。
     * 不依赖用户这次点过什么按钮，所以打开页面就能看到真实状态。
     */
    const refreshPushStatus = useCallback(async () => {
        const status = await getLocalPushStatus();
        if (!status.supported) { setPush({ tone: "warning", text: "推送：这个浏览器不支持" }); return; }
        if (!status.hasServiceWorker) { setPush({ tone: "warning", text: "推送：本地开发环境没有 Service Worker（上线后才可用）" }); return; }
        if (status.permission === "denied") { setPush({ tone: "danger", text: "推送：通知权限被拒绝（去系统设置里允许）" }); return; }
        if (status.permission !== "granted") { setPush({ tone: "warning", text: "推送：还没授权通知" }); return; }
        if (!status.endpoint) { setPush({ tone: "warning", text: "推送：还没订阅（打开上面的开关即可）" }); return; }
        setPush({ tone: "success", text: "推送：已就绪" });
    }, []);

    useEffect(() => {
        setCharacters(loadCharacters());
        const saved = loadProactiveCloudConfig();
        if (normalizeWorkerUrl(saved.workerUrl)) void verifyCloud(saved);
        void refreshPushStatus();
    }, [refreshPushStatus, verifyCloud]);

    /** 总开关：打开就一路做完（订阅推送 → 验证云端 → 对齐任务） */
    const handleToggle = useCallback(async (value: boolean) => {
        const saved = applyConfig({ enabled: value });
        if (!value) {
            setPush(null);
            onNotice("已关闭云端主动消息");
            return;
        }
        setBusy("enable");
        try {
            // 先订阅：iOS 要求权限请求发生在用户手势里，中间不能先 await 别的请求
            await enablePush(saved);
            const ok = await verifyCloud(saved);
            if (ok) await reconcileIntervalTasks(saved).catch(() => {});
            await refreshPushStatus();
            onNotice("已开启云端主动消息");
        } finally {
            setBusy(null);
        }
    }, [applyConfig, enablePush, onNotice, refreshPushStatus, verifyCloud]);

    /**
     * 改动角色的开关/间隔后，要把云端任务对齐（登记/清理/改间隔）。
     * 以前只有重开 app 或点「立即同步材料」才会对齐——设置完就干等着，云端根本没有任务，自然不会发。
     * 这里做 1 秒防抖：连续改多个选项只对齐一次；失败原因弹出来，别静默吞掉。
     */
    const reconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => {
        if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
    }, []);
    const scheduleReconcile = useCallback(() => {
        if (!isProactiveCloudReady(loadProactiveCloudConfig())) return;
        if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
        reconcileTimerRef.current = setTimeout(() => {
            reconcileIntervalTasks(loadProactiveCloudConfig())
                .then(result => {
                    if (result.reasons.length > 0) {
                        onNotice(`主动消息任务登记失败：${result.reasons.join("；")}`);
                    }
                })
                .catch(() => {});
        }, 1000);
    }, [onNotice]);

    const updateCharacter = useCallback((characterId: string, patch: Partial<{ enabled: boolean; intervalMinutes: number }>) => {
        const current = loadProactiveCloudConfig();
        const existing = current.perCharacter[characterId] || { enabled: false, intervalMinutes: 0 };
        applyConfig({
            perCharacter: { ...current.perCharacter, [characterId]: { ...existing, ...patch } },
        });
        scheduleReconcile();
    }, [applyConfig, scheduleReconcile]);

    const runAdvanced = useCallback(async (name: string, task: () => Promise<string>) => {
        setBusy(name);
        try {
            onNotice(await task());
        } catch (error) {
            onNotice(`失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setBusy(null);
        }
    }, [onNotice]);

    const handleSync = useCallback(() => runAdvanced("sync", async () => {
        const saved = applyConfig({ workerUrl: normalizeWorkerUrl(config.workerUrl), serverToken: config.serverToken.trim() });
        if (!isProactiveCloudReady(saved)) throw new Error("先打开总开关，并填好地址与令牌");
        const recon = await reconcileIntervalTasks(saved);
        const failed: string[] = [...recon.reasons];
        for (const [characterId, settings] of Object.entries(saved.perCharacter)) {
            if (!settings.enabled) continue;
            const result = await syncProactiveMaterial(characterId, saved);
            if (!result.ok) {
                const name = characters.find(item => item.id === characterId)?.name || characterId;
                failed.push(`${name}：${result.reason}`);
            }
        }
        if (failed.length > 0) throw new Error(failed.join("；"));
        return `已同步（登记 ${recon.registered} 个任务，清理 ${recon.cleared} 个）`;
    }), [applyConfig, characters, config.serverToken, config.workerUrl, runAdvanced]);

    const enabledCount = Object.values(config.perCharacter).filter(item => item?.enabled).length;

    return (
        <div className="flex flex-col gap-3">
            {/* 唯一需要操作的开关 */}
            <div className="ui-group-card">
                <div className="flex items-center gap-2">
                    <span className="menu-label flex-1 min-w-0">主动消息（云端）</span>
                    {busy === "enable" ? <Loader2 size={16} className="animate-spin" /> : (
                        <Toggle checked={config.enabled} onChange={handleToggle} />
                    )}
                </div>
                <div className="flex flex-col gap-1">
                    {cloud ? <span className="menu-desc !mt-0">{cloud.text}</span> : null}
                    {push ? <span className="menu-desc !mt-0">{push.text}</span> : null}
                    {config.lastSyncAt ? (
                        <span className="menu-desc !mt-0">
                            材料上次同步：{(() => {
                                const minutes = Math.max(0, Math.round((Date.now() - config.lastSyncAt!) / 60000));
                                return minutes <= 0 ? "刚刚" : `${minutes} 分钟前`;
                            })()}
                        </span>
                    ) : null}
                </div>
            </div>

            {/* 频率 */}
            <p className="settings-menu-section-title">频率</p>
            <div className="flex flex-col gap-2">
                <div className="ui-group-card">
                    <span className="menu-label">静默时段</span>
                    <div className="flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                            <Select value={String(config.quietStartHour)} onChange={event => applyConfig({ quietStartHour: Number(event.target.value) })}>
                                {HOUR_OPTIONS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                            </Select>
                        </div>
                        <span className="menu-desc !mt-0 shrink-0">到</span>
                        <div className="flex-1 min-w-0">
                            <Select value={String(config.quietEndHour)} onChange={event => applyConfig({ quietEndHour: Number(event.target.value) })}>
                                {HOUR_OPTIONS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                            </Select>
                        </div>
                    </div>
                </div>
                <div className="ui-group-card">
                    <span className="menu-label">每日上限</span>
                    <Input
                        type="number"
                        min={0}
                        max={48}
                        value={String(config.dailyLimit)}
                        onChange={event => applyConfig({ dailyLimit: Math.max(0, Math.min(48, Number(event.target.value) || 0)) })}
                        style={{ width: 96, textAlign: "center" }}
                    />
                </div>
            </div>

            {/* 角色 */}
            <p className="settings-menu-section-title">角色（{enabledCount} 个已开启）</p>
            <div className="flex flex-col gap-2">
                {characters.length === 0 ? (
                    <Alert variant="info">还没有角色</Alert>
                ) : characters.map(character => {
                    const settings = config.perCharacter[character.id] || { enabled: false, intervalMinutes: 0 };
                    return (
                        <div key={character.id} className="ui-group-card">
                            <div className="flex items-center gap-2">
                                <span className="menu-label truncate flex-1 min-w-0">{character.name}</span>
                                <Toggle checked={settings.enabled} onChange={value => updateCharacter(character.id, { enabled: value })} />
                            </div>
                            {settings.enabled ? (
                                <label className="flex items-center gap-2">
                                    <span className="menu-desc !mt-0 whitespace-nowrap">每</span>
                                    <Input
                                        type="number"
                                        step="any"
                                        min={0.02}
                                        max={168}
                                        inputMode="decimal"
                                        value={intervalDrafts[character.id] ?? (settings.intervalMinutes > 0 ? String(settings.intervalMinutes / 60) : "")}
                                        placeholder="0.5"
                                        onChange={event => {
                                            const raw = event.target.value;
                                            setIntervalDrafts(prev => ({ ...prev, [character.id]: raw }));
                                            const hours = Number(raw);
                                            const minutes = Number.isFinite(hours) && hours > 0 ? Math.min(10080, Math.round(hours * 60)) : 0;
                                            updateCharacter(character.id, { intervalMinutes: minutes });
                                        }}
                                        style={{ width: 88, textAlign: "center" }}
                                    />
                                    <span className="menu-desc !mt-0">小时主动发一次</span>
                                </label>
                            ) : null}
                        </div>
                    );
                })}
            </div>

            {/* 高级与诊断：平时不用碰 */}
            <button type="button" className="ui-link-btn" style={{ alignSelf: "flex-start" }} onClick={() => setAdvanced(value => !value)}>
                {advanced ? "收起高级与诊断" : "高级与诊断"}
            </button>

            {advanced ? (
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1">
                        <span className="menu-desc !mt-0">Worker 地址</span>
                        <Input
                            value={config.workerUrl}
                            onChange={event => setConfig({ ...config, workerUrl: event.target.value })}
                            onBlur={() => { void verifyCloud(applyConfig({ workerUrl: normalizeWorkerUrl(config.workerUrl) })); }}
                            placeholder="https://amsg.你的账号.workers.dev"
                            autoComplete="off"
                            spellCheck={false}
                        />
                    </label>
                    <label className="flex flex-col gap-1">
                        <span className="menu-desc !mt-0">访问令牌</span>
                        <Input
                            value={config.serverToken}
                            onChange={event => setConfig({ ...config, serverToken: event.target.value })}
                            onBlur={() => { void verifyCloud(applyConfig({ serverToken: config.serverToken.trim() })); }}
                            placeholder="SERVER_TOKEN"
                            autoComplete="off"
                            spellCheck={false}
                        />
                    </label>

                    <div className="flex flex-wrap gap-2">
                        <button type="button" className="ui-btn ui-btn-outline" disabled={busy !== null} onClick={() => void runAdvanced("verify", async () => ((await verifyCloud()) ? "云端已连接" : "云端连不上"))}>
                            {busy === "verify" ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />} 连接并验证
                        </button>
                        <button type="button" className="ui-btn ui-btn-outline" disabled={busy !== null} onClick={() => void runAdvanced("push", async () => ((await enablePush()) ? "推送已就绪" : "推送未开启"))}>
                            {busy === "push" ? <Loader2 size={16} className="animate-spin" /> : <BellRing size={16} />} 重新订阅推送
                        </button>
                        <button type="button" className="ui-btn ui-btn-outline" disabled={busy !== null} onClick={() => void runAdvanced("test", async () => {
                            const result = await sendTestPush();
                            if (!result.ok) throw new Error(result.reason || "测试推送失败");
                            return "测试推送已发出";
                        })}>
                            {busy === "test" ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />} 发测试推送
                        </button>
                        <button type="button" className="ui-btn ui-btn-outline" disabled={busy !== null} onClick={handleSync}>
                            {busy === "sync" ? <Loader2 size={16} className="animate-spin" /> : <CloudUpload size={16} />} 立即同步材料
                        </button>
                        <button type="button" className="ui-btn ui-btn-outline" disabled={busy !== null} onClick={() => void runAdvanced("diag", async () => {
                            const info = await getProactiveDiagnostics(loadProactiveCloudConfig());
                            setDiagnostics(info);
                            return "诊断已刷新";
                        })}>
                            {busy === "diag" ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />} 刷新诊断
                        </button>
                    </div>

                    {diagnostics ? (
                        <Alert variant={diagnostics.remote.ok ? "success" : "warning"}>
                            <div className="flex flex-col gap-1">
                                <span>云端：{diagnostics.remote.reachable ? (diagnostics.remote.ok ? "配置齐全" : diagnostics.remote.message) : "还没填地址"}</span>
                                <span>通知权限 {diagnostics.local.notificationPermission}；推送订阅 {diagnostics.local.endpoint ? "已建立" : "未建立"}</span>
                                {diagnostics.remote.counts ? (
                                    <span>
                                        设备 {diagnostics.remote.counts.devices ?? "-"}；材料 {diagnostics.remote.counts.state ?? "-"}；
                                        待发任务 {diagnostics.remote.counts.tasks ?? "-"}；收件箱 {diagnostics.remote.counts.inbox ?? "-"}
                                    </span>
                                ) : null}
                            </div>
                        </Alert>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
