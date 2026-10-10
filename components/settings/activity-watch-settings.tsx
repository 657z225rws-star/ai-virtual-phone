"use client";

// 活动感知 —— 角色主动察觉你在虚拟手机里的活动（听歌等）并发起自然关怀。
// 版式对齐「主动消息（云端）」：ui-group-card + Toggle + Input/Select。

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Alert } from "@/components/ui/feedback";
import { Input, Select, Toggle } from "@/components/ui/form";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import {
    fireActivityDebug,
    getActivityWatchStatus,
    loadActivityWatchConfig,
    saveActivityWatchConfig,
    type ActivityWatchConfig,
    type ActivityWatchStatus,
} from "@/lib/activity-watcher";

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({
    value: String(hour),
    label: `${String(hour).padStart(2, "0")}:00`,
}));

function formatFiredAt(ts: number): string {
    if (!ts) return "还没有触发过";
    const minutes = Math.round((Date.now() - ts) / 60000);
    if (minutes <= 0) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.round(hours / 24)} 天前`;
}

function formatListening(seconds: number): string {
    if (seconds < 60) return `${seconds} 秒`;
    return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

const OUTCOME_LABELS: Record<string, string> = {
    sent: "已发出消息",
    silent: "角色选择沉默（聊天里会留下一个 ♥ 思考气泡）",
    error: "生成失败",
};

export function ActivityWatchSettings({ onNotice }: { onNotice: (msg: string) => void }) {
    const [config, setConfig] = useState<ActivityWatchConfig>(() => loadActivityWatchConfig());
    const [status, setStatus] = useState<ActivityWatchStatus | null>(null);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [debugBusy, setDebugBusy] = useState(false);

    const refreshStatus = useCallback(() => {
        setStatus(getActivityWatchStatus());
    }, []);

    useEffect(() => {
        setCharacters(loadCharacters());
        refreshStatus();
        const timer = window.setInterval(refreshStatus, 5000);
        return () => window.clearInterval(timer);
    }, [refreshStatus]);

    const apply = useCallback((patch: Partial<ActivityWatchConfig>) => {
        setConfig(prev => {
            const next = { ...prev, ...patch };
            saveActivityWatchConfig(next);
            return next;
        });
    }, []);

    const toggleCharacter = useCallback((characterId: string, enabled: boolean) => {
        apply({
            targetCharacterIds: enabled
                ? [...config.targetCharacterIds, characterId]
                : config.targetCharacterIds.filter(id => id !== characterId),
        });
    }, [apply, config.targetCharacterIds]);

    const handleDebugFire = useCallback(async () => {
        setDebugBusy(true);
        try {
            const result = await fireActivityDebug();
            onNotice(result.message);
            refreshStatus();
        } finally {
            setDebugBusy(false);
        }
    }, [onNotice, refreshStatus]);

    return (
        <div className="flex flex-col gap-3">
            {/* 总开关 */}
            <div className="ui-group-card">
                <div className="flex items-center gap-2">
                    <span className="menu-label flex-1 min-w-0">活动感知（本机）</span>
                    <Toggle checked={config.enabled} onChange={value => apply({ enabled: value })} />
                </div>
                <div className="flex flex-col gap-1">
                    <span className="menu-desc !mt-0">开启后，角色会察觉你正在虚拟手机里做什么（目前支持听歌），并在符合下面规则时主动发一条自然关怀。</span>
                    {status ? (
                        <span className="menu-desc !mt-0">
                            当前状态：{status.musicPlaying
                                ? `在听《${status.currentTrackTitle || "未知歌曲"}》，本段已连续 ${formatListening(status.listeningSeconds)}`
                                : "没在听歌"}
                            ；今日已触发 {status.todayCount} 次，上次{formatFiredAt(status.lastFiredAt)}
                            {status.lastOutcome ? `，结果：${OUTCOME_LABELS[status.lastOutcome] || status.lastOutcome}${status.lastOutcome === "error" && status.lastError ? `（${status.lastError}）` : ""}` : ""}。
                        </span>
                    ) : null}
                </div>
            </div>

            {/* 触发规则 */}
            <p className="settings-menu-section-title">触发规则</p>
            <div className="flex flex-col gap-2">
                <div className="ui-group-card">
                    <span className="menu-label">连续听歌时长阈值（{config.debugSecondsMode ? "秒" : "分钟"}）</span>
                    <Input
                        type="number"
                        min={1}
                        max={config.debugSecondsMode ? 3600 : 720}
                        value={String(config.musicMinutesThreshold)}
                        onChange={event => apply({ musicMinutesThreshold: Math.max(1, Math.min(config.debugSecondsMode ? 3600 : 720, Number(event.target.value) || 1)) })}
                        style={{ width: 96, textAlign: "center" }}
                    />
                    <span className="menu-desc !mt-0">听歌达到这个时长后，下一次轮询就会触发角色主动关怀。测试链路时可打开下面的测试模式，把这里改成 10 秒左右。每次触发后，连续时长会清零重新计。</span>
                </div>
                <div className="ui-group-card">
                    <span className="menu-label">冷却时间（分钟）</span>
                    <Input
                        type="number"
                        min={1}
                        max={1440}
                        value={String(config.cooldownMinutes)}
                        onChange={event => apply({ cooldownMinutes: Math.max(1, Math.min(1440, Number(event.target.value) || 1)) })}
                        style={{ width: 96, textAlign: "center" }}
                    />
                </div>
                <div className="ui-group-card">
                    <span className="menu-label">每 24 小时最多触发（0 为不限）</span>
                    <Input
                        type="number"
                        min={0}
                        max={48}
                        value={String(config.dailyLimit)}
                        onChange={event => apply({ dailyLimit: Math.max(0, Math.min(48, Number(event.target.value) || 0)) })}
                        style={{ width: 96, textAlign: "center" }}
                    />
                </div>
                <div className="ui-group-card">
                    <span className="menu-label">允许时段</span>
                    <div className="flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                            <Select value={String(config.allowedStartHour)} onChange={event => apply({ allowedStartHour: Number(event.target.value) })}>
                                {HOUR_OPTIONS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                            </Select>
                        </div>
                        <span className="menu-desc !mt-0 shrink-0">到</span>
                        <div className="flex-1 min-w-0">
                            <Select value={String(config.allowedEndHour)} onChange={event => apply({ allowedEndHour: Number(event.target.value) })}>
                                {HOUR_OPTIONS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                            </Select>
                        </div>
                    </div>
                    <span className="menu-desc !mt-0">起止相同表示全天允许；支持跨零点（如 22:00 到 06:00）。</span>
                </div>
            </div>

            {/* 角色 */}
            <p className="settings-menu-section-title">触发角色</p>
            <div className="flex flex-col gap-2">
                <span className="menu-desc !mt-0">未选择任何角色时，将自动使用最近聊过的角色。</span>
                {characters.length === 0 ? (
                    <Alert variant="info">还没有角色</Alert>
                ) : characters.map(character => (
                    <div key={character.id} className="ui-group-card">
                        <div className="flex items-center gap-2">
                            <span className="menu-label truncate flex-1 min-w-0">{character.name}</span>
                            <Toggle
                                checked={config.targetCharacterIds.includes(character.id)}
                                onChange={value => toggleCharacter(character.id, value)}
                            />
                        </div>
                    </div>
                ))}
            </div>

            {/* 测试 */}
            <p className="settings-menu-section-title">测试</p>
            <div className="flex flex-col gap-2">
                <div className="ui-group-card">
                    <div className="flex items-center gap-2">
                        <span className="menu-label flex-1 min-w-0">测试模式（阈值按秒计）</span>
                        <Toggle checked={config.debugSecondsMode} onChange={value => apply({ debugSecondsMode: value })} />
                    </div>
                    <span className="menu-desc !mt-0">打开后，上面的「连续听歌时长阈值」按秒计算，放几秒歌就能命中规则，不用真等几十分钟。</span>
                </div>
                <div className="ui-group-card">
                    <div className="flex items-center gap-2">
                        <span className="menu-label flex-1 min-w-0">立即模拟触发一次</span>
                        {debugBusy ? (
                            <Loader2 size={16} className="animate-spin" />
                        ) : (
                            <button
                                onClick={handleDebugFire}
                                className="inline-flex h-8 items-center justify-center whitespace-nowrap rounded-full bg-black px-3 text-xs font-bold text-white transition-all hover:bg-gray-800 active:scale-95 focus:outline-none"
                            >
                                触发
                            </button>
                        )}
                    </div>
                    <span className="menu-desc !mt-0">跳过所有规则直接走一遍生成链路，验证提示词与消息落库是否正常；在放歌时会带上真实歌名。</span>
                </div>
            </div>
        </div>
    );
}
