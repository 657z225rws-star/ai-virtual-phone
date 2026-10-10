// lib/activity-watcher.ts — 「活动感知 · 主动关怀」后台观察器
//
// 解决的痛点：角色只在用户打开聊天框发消息时才知道用户在干嘛（音乐氛围注入
// 发生在构建 prompt 的那一刻）。这个观察器让角色在用户没有找它聊天时也能
// 「察觉」用户正在虚拟手机里做什么——v1 先支持听歌——并按规则触发一次主动
// 消息生成。生成走 follow-up-service 的 fireActivityProactive，最终进
// chat-engine 的同一条 prompt 管线，因此 buildMusicAtmosphere 的音乐氛围
// （歌名 + 歌词窗口）会被自动注入，角色能自然地聊起"你怎么在听这首歌"。
//
// 触发规则（全部可配置）：
//   - 连续听歌时长 ≥ 阈值（测试模式可改成按秒计，方便不用真等几十分钟）
//   - 当前时刻在允许的时段窗口内（支持跨零点，如 22 → 6）
//   - 距上次触发 ≥ 冷却分钟数
//   - 24 小时内触发次数 ≤ 每日上限
//   - 目标会话最近几分钟没有消息（用户正在聊天时就不打扰）
//
// 页面必须活着：观察器跑在 bg-timer 上（和 follow-up-service 一样），
// 页面被系统杀掉或电脑关机即停止，这是 PWA 的物理边界。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { bgSetInterval } from "./bg-timer";
import { getMusicControlBridge } from "./music-control-bridge";
import { loadChatSessions, loadChatMessages } from "./chat-storage";
import { loadCharacters } from "./character-storage";
import { fireActivityProactive } from "./follow-up-service";

const CONFIG_KEY = "ai_phone_activity_watch_v1";
const STATS_KEY = "ai_phone_activity_watch_stats_v1";
registerKvMigration(CONFIG_KEY);
registerKvMigration(STATS_KEY);

/** 轮询间隔 */
const POLL_INTERVAL_MS = 20 * 1000;
/** 目标会话最近这么多毫秒内有消息就不触发（用户正在聊天） */
const RECENT_CHAT_QUIET_MS = 3 * 60 * 1000;

export type ActivityWatchConfig = {
    enabled: boolean;
    /** 连续听歌多少分钟后允许触发 */
    musicMinutesThreshold: number;
    /** 两次触发之间的最小间隔（分钟） */
    cooldownMinutes: number;
    /** 每 24 小时最多触发几次；0 表示不限制 */
    dailyLimit: number;
    /** 允许触发的时段（本机时间，start 含、end 不含；start === end 表示全天） */
    allowedStartHour: number;
    allowedEndHour: number;
    /** 允许主动关怀的角色（contactId）；空 = 只用最近活跃的那个私聊会话 */
    targetCharacterIds: string[];
    /** 测试模式：把音乐时长阈值按「秒」计，方便验证链路不用真等几十分钟 */
    debugSecondsMode: boolean;
};

const DEFAULT_CONFIG: ActivityWatchConfig = {
    enabled: false,
    musicMinutesThreshold: 40,
    cooldownMinutes: 120,
    dailyLimit: 2,
    allowedStartHour: 0,
    allowedEndHour: 0,
    targetCharacterIds: [],
    debugSecondsMode: false,
};

type ActivityWatchStats = {
    /** 统计归属的日期（本地时区 YYYY-MM-DD），跨天自动清零 */
    date: string;
    count: number;
    lastFiredAt: number;
    /** 上一次触发的结局：sent=已发出消息；silent=角色选择沉默；error=生成失败 */
    lastOutcome?: "sent" | "silent" | "error";
    /** lastOutcome=error 时的失败原因 */
    lastError?: string;
};

function loadConfig(): ActivityWatchConfig {
    if (typeof window === "undefined") return { ...DEFAULT_CONFIG };
    try {
        const raw = kvGet(CONFIG_KEY);
        const parsed = raw ? JSON.parse(raw) as Partial<ActivityWatchConfig> : {};
        return { ...DEFAULT_CONFIG, ...parsed };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

export function loadActivityWatchConfig(): ActivityWatchConfig {
    return loadConfig();
}

export function saveActivityWatchConfig(next: ActivityWatchConfig): void {
    if (typeof window === "undefined") return;
    try { kvSet(CONFIG_KEY, JSON.stringify(next)); } catch { /* quota — ignore */ }
}

function loadStats(): ActivityWatchStats {
    const today = localDateString();
    try {
        const raw = kvGet(STATS_KEY);
        const parsed = raw ? JSON.parse(raw) as ActivityWatchStats : null;
        if (parsed && parsed.date === today) return parsed;
    } catch { /* fallthrough */ }
    return { date: today, count: 0, lastFiredAt: 0 };
}

function saveStats(stats: ActivityWatchStats): void {
    try { kvSet(STATS_KEY, JSON.stringify(stats)); } catch { /* quota — ignore */ }
}

function localDateString(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isHourInWindow(hour: number, start: number, end: number): boolean {
    const s = Math.max(0, Math.min(23, Math.round(start)));
    const e = Math.max(0, Math.min(23, Math.round(end)));
    if (s === e) return true; // 全天
    if (s < e) return hour >= s && hour < e;
    return hour >= s || hour < e; // 跨零点，如 22 → 6
}

// ── 运行时状态 ─────────────────────────────────────────────
let stopInterval: (() => void) | null = null;
/** 连续听歌起点；暂停 / 关掉播放器就清空，切歌不清（听的是"这一段时光"） */
let listeningSince: number | null = null;

export type ActivityWatchStatus = {
    enabled: boolean;
    /** 音乐桥实时状态：现在是否在放歌（和观察器的连续计时无关） */
    musicPlaying: boolean;
    currentTrackTitle: string;
    /** 观察器本段连续听歌秒数（每次触发后清零重计） */
    listeningSeconds: number;
    lastFiredAt: number;
    todayCount: number;
    lastOutcome?: "sent" | "silent" | "error";
    lastError?: string;
};

/** 给设置页看的实时状态 */
export function getActivityWatchStatus(): ActivityWatchStatus {
    const config = loadConfig();
    const stats = loadStats();
    const snap = getMusicControlBridge()?.getState() ?? null;
    return {
        enabled: config.enabled,
        musicPlaying: Boolean(snap?.isPlaying && snap.currentTrack),
        currentTrackTitle: snap?.currentTrack?.title || "",
        listeningSeconds: listeningSince ? Math.floor((Date.now() - listeningSince) / 1000) : 0,
        lastFiredAt: stats.lastFiredAt,
        todayCount: stats.count,
        lastOutcome: stats.lastOutcome,
        lastError: stats.lastError,
    };
}

// ── 快照与目标选择 ─────────────────────────────────────────

type MusicActivity = {
    /** 连续听了多少毫秒 */
    durationMs: number;
    title: string;
    artist: string;
};

function readMusicActivity(config: ActivityWatchConfig): MusicActivity | null {
    const bridge = getMusicControlBridge();
    const snap = bridge?.getState();
    if (!snap || !snap.isPlaying || !snap.currentTrack) {
        listeningSince = null;
        return null;
    }
    if (listeningSince === null) listeningSince = Date.now();
    const thresholdMs = config.debugSecondsMode
        ? Math.max(5, config.musicMinutesThreshold) * 1000
        : Math.max(1, config.musicMinutesThreshold) * 60 * 1000;
    const durationMs = Date.now() - listeningSince;
    if (durationMs < thresholdMs) return null;
    return {
        durationMs,
        title: snap.currentTrack.title || "未知歌曲",
        artist: snap.currentTrack.artist || "",
    };
}

/** 选目标会话：指定角色里最近活跃的私聊；没指定就用全局最近活跃的私聊 */
function pickTargetSession(config: ActivityWatchConfig): { id: string; contactId: string } | null {
    const sessions = loadChatSessions().filter(s => !s.isGroup)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (config.targetCharacterIds.length > 0) {
        const allowed = new Set(config.targetCharacterIds);
        const hit = sessions.find(s => allowed.has(s.contactId));
        return hit ? { id: hit.id, contactId: hit.contactId } : null;
    }
    return sessions[0] ? { id: sessions[0].id, contactId: sessions[0].contactId } : null;
}

function sessionRecentlyActive(sessionId: string): boolean {
    try {
        const messages = loadChatMessages(sessionId);
        const last = messages[messages.length - 1];
        if (!last) return false;
        return Date.now() - new Date(last.createdAt).getTime() < RECENT_CHAT_QUIET_MS;
    } catch {
        return false;
    }
}

/** 目标会话距上一条消息过了多少分钟；空会话返回 null */
function getSessionSilenceMinutes(sessionId: string): number | null {
    try {
        const messages = loadChatMessages(sessionId);
        const last = messages[messages.length - 1];
        if (!last) return null;
        return Math.max(0, Math.round((Date.now() - new Date(last.createdAt).getTime()) / 60000));
    } catch {
        return null;
    }
}

function buildActivityContext(activity: MusicActivity, listenMinutes: number, silenceMinutes: number | null): string {
    // 刻意不写歌名/歌手：这条快照只承担"知道对方在线 + 沉默了多久"两个信号，
    // 歌曲细节留给正常聊天时的一起听氛围注入（buildMusicAtmosphere），避免角色把歌当话题。
    const parts = [
        `对方此刻在线，独自听歌已持续约 ${listenMinutes} 分钟`,
    ];
    if (silenceMinutes !== null) {
        parts.push(silenceMinutes >= 60
            ? `距你们最近一条消息已过约 ${Math.round(silenceMinutes / 60)} 小时`
            : `距你们最近一条消息已过约 ${Math.max(1, silenceMinutes)} 分钟`);
    } else {
        parts.push("这个会话还没有聊过天");
    }
    return parts.join("；");
}

/** 兜底造一条假活动（测试按钮用：没在放歌也能模拟一次触发） */
function buildDebugContext(): string {
    return "对方此刻在线，独自听歌已持续约 40 分钟（这是手动模拟的一次活动感知，用于测试链路）";
}

// ── 触发 ───────────────────────────────────────────────────

async function tryFire(activity: MusicActivity, forced: boolean): Promise<boolean> {
    const config = loadConfig();
    if (!forced && !config.enabled) return false;

    const nowHour = new Date().getHours();
    if (!forced && !isHourInWindow(nowHour, config.allowedStartHour, config.allowedEndHour)) return false;

    const stats = loadStats();
    if (!forced && config.dailyLimit > 0 && stats.count >= config.dailyLimit) return false;
    const cooldownMs = Math.max(1, config.cooldownMinutes) * 60 * 1000;
    if (!forced && stats.lastFiredAt && Date.now() - stats.lastFiredAt < cooldownMs) return false;

    const target = pickTargetSession(config);
    if (!target) return false;
    if (!forced && sessionRecentlyActive(target.id)) return false;

    const minutes = Math.max(1, Math.round(activity.durationMs / 60000));
    const context = forced && !activity
        ? buildDebugContext()
        : buildActivityContext(activity, minutes, getSessionSilenceMinutes(target.id));

    console.log(`[ActivityWatch] Firing proactive care for session=${target.id} (${context})`);
    // 先记账再生成：生成失败也不重试轰炸，等下一轮规则命中再说。
    // 结局（发出/沉默/失败）在生成完成后补记，供设置页显示。
    listeningSince = null;
    saveStats({ date: localDateString(), count: stats.count + 1, lastFiredAt: Date.now() });
    const result = await fireActivityProactive(target.id, context);
    const prev = loadStats();
    saveStats({
        ...prev,
        lastOutcome: result.ok ? (result.hasVisible ? "sent" : "silent") : "error",
        lastError: result.error,
    });
    return true;
}

function pollActivity() {
    try {
        const config = loadConfig();
        if (!config.enabled) {
            // 关着的时候不累计连续听歌时长，避免重新打开后拿旧起点立刻误触发
            listeningSince = null;
            return;
        }
        const activity = readMusicActivity(config);
        if (activity) void tryFire(activity, false);
    } catch (e) {
        console.error("[ActivityWatch] poll error:", e);
    }
}

/** 设置页「立即模拟触发一次」：绕过时长/时段/冷却/上限，验证生成链路 */
export async function fireActivityDebug(): Promise<{ ok: boolean; message: string }> {
    const config = loadConfig();
    const target = pickTargetSession(config);
    if (!target) return { ok: false, message: "没有可用的私聊会话，先创建一个角色会话再试。" };
    const bridge = getMusicControlBridge();
    const snap = bridge?.getState();
    const activity: MusicActivity | null = snap?.isPlaying && snap.currentTrack
        ? { durationMs: 40 * 60 * 1000, title: snap.currentTrack.title || "未知歌曲", artist: snap.currentTrack.artist || "" }
        : null;
    const context = activity
        ? buildActivityContext(activity, 40, getSessionSilenceMinutes(target.id))
        : buildDebugContext();
    const characterName = loadCharacters().find(c => c.id === target.contactId)?.name || "角色";
    try {
        const result = await fireActivityProactive(target.id, context);
        const prev = loadStats();
        saveStats({
            ...prev,
            lastOutcome: result.ok ? (result.hasVisible ? "sent" : "silent") : "error",
            lastError: result.error,
        });
        if (!result.ok) return { ok: false, message: `触发失败：${result.error || "原因不明"}` };
        return result.hasVisible
            ? { ok: true, message: `已触发「${characterName}」的主动关怀，去聊天列表看看。` }
            : { ok: true, message: `链路走通了，但「${characterName}」选择沉默（聊天里会留下一个 ♥ 思考气泡）。` };
    } catch (e: any) {
        return { ok: false, message: `触发失败：${e?.message || String(e)}` };
    }
}

// ── 生命周期 ───────────────────────────────────────────────

export function startActivityWatcher() {
    if (stopInterval) return;
    console.log("[ActivityWatch] Watcher started, polling every", POLL_INTERVAL_MS, "ms");
    stopInterval = bgSetInterval(pollActivity, POLL_INTERVAL_MS);
    pollActivity();
}

export function stopActivityWatcher() {
    if (stopInterval) { stopInterval(); stopInterval = null; }
    listeningSince = null;
}
