// lib/proactive-cloud.ts
// 「主动消息 · 云端」客户端
//
// 解决的痛点：本地的「稍后主动联系 / 定时唤醒」活在页面里，app 一被系统杀掉就永远不会执行。
// 这里把两件事搬到云端（Cloudflare Worker，见 _deploy/worker.js）：
//   1. 把生成所需的材料同步上去：角色卡 + 长期记忆 + 最近 20 条消息 + 模型配置
//   2. 把「什么时候该主动联系」登记上去：一次性（稍后发送）或按间隔循环
// 云端到点自己调大模型生成，结果落云端收件箱并发 Web Push。
// 推送只负责"及时提醒"，消息本体留在收件箱——推送被系统吞了也不会丢消息。
//
// 两条硬约定：
// - Worker 地址和访问令牌只存在本机（IndexedDB），绝不写进代码。这个仓库是公开的。
// - 角色的 API Key 会同步到云端（用 MASTER_KEY 加密后存 D1），这是云端生成的必需代价。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { loadCharacters } from "./character-storage";
import { loadMemoryEntriesByType } from "./memory-storage";
import {
    CHAT_MESSAGE_PUSHED_EVENT,
    hydrateChatStorage,
    loadChatSessions,
    loadChatMessages,
    pushChatMessage,
    type ChatMessage,
} from "./chat-storage";
import { loadTimedWakeSchedules, removeTimedWakeSchedule } from "./timed-wake-storage";

const CONFIG_KEY = "ai_phone_proactive_cloud_v1";
registerKvMigration(CONFIG_KEY);

/** 最近同步给云的聊天条数 */
const RECENT_MESSAGE_LIMIT = 20;
/** 单条消息同步上去时的截断长度 */
const MESSAGE_CHAR_CAP = 800;
/** 角色卡 / 记忆同步上去的截断长度 */
const CARD_CHAR_CAP = 8000;
const MEMORY_CHAR_CAP = 6000;
/** 拉收件箱的间隔（页面可见时才跑） */
const PULL_INTERVAL_MS = 60 * 1000;
/** 材料自动重新同步的间隔（兜底，主要靠发消息触发） */
const RESYNC_INTERVAL_MS = 15 * 60 * 1000;
/** 有新消息后重新同步材料的节流：同一个人最多这么久传一次 */
const MESSAGE_SYNC_THROTTLE_MS = 3 * 60 * 1000;

export type ProactiveCharacterSettings = {
    enabled: boolean;
    /** 自动主动消息的间隔（分钟）；0 表示只用手动的「稍后发送」，不自动发 */
    intervalMinutes: number;
};

/**
 * 云端生成专用的 API 条目。
 * 为什么单独一套：角色平时用的是谷歌原生格式（/v1beta/models/xxx:generateContent），
 * 而云端按 OpenAI 兼容的 /v1/chat/completions 调。这里可以存多条，指定用哪一条。
 */
export type ProactiveCloudApiEntry = {
    id: string;
    name: string;
    /** OpenAI 兼容根地址，例如 https://你的中转站.com（带不带 /v1 都行） */
    apiUrl: string;
    apiKey: string;
    model: string;
    /** 这条是从哪个已有 API 配置填入的（只用于界面回显，界面靠它显示"选的是哪条"） */
    sourceConfigId?: string;
};

export function makeCloudApiId(): string {
    return `cloudapi_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export type ProactiveCloudConfig = {
    enabled: boolean;
    workerUrl: string;
    serverToken: string;
    deviceId: string;
    /** 静默时段（按角色本地时区），start 含、end 不含；start === end 表示不静默 */
    quietStartHour: number;
    quietEndHour: number;
    /** 最近 24 小时最多发几条；0 表示不限制 */
    dailyLimit: number;
    perCharacter: Record<string, ProactiveCharacterSettings>;
    /** 云端生成可用的 API 列表 */
    cloudApis: ProactiveCloudApiEntry[];
    /** 当前用哪一条 */
    activeCloudApiId: string;
    lastPullAt?: number;
    lastSyncAt?: number;
};

const DEFAULT_CONFIG: Omit<ProactiveCloudConfig, "deviceId"> = {
    enabled: false,
    workerUrl: "",
    serverToken: "",
    quietStartHour: 23,
    quietEndHour: 8,
    dailyLimit: 3,
    perCharacter: {},
    cloudApis: [],
    activeCloudApiId: "",
};

function makeDeviceId(): string {
    const rand = typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID().replace(/-/g, "").slice(0, 20)
        : Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    return `dev_${rand}`;
}

export function loadProactiveCloudConfig(): ProactiveCloudConfig {
    if (typeof window === "undefined") {
        return { ...DEFAULT_CONFIG, deviceId: "" };
    }
    try {
        const raw = kvGet(CONFIG_KEY);
        const parsed = raw ? JSON.parse(raw) as Partial<ProactiveCloudConfig> & { cloudApi?: Partial<ProactiveCloudApiEntry> } : {};

        // 早期版本存的是一套固定配置（cloudApi），这里迁移成列表里的一条
        let cloudApis: ProactiveCloudApiEntry[] = Array.isArray(parsed.cloudApis)
            ? parsed.cloudApis.filter(item => item && typeof item.id === "string")
            : [];
        if (cloudApis.length === 0 && parsed.cloudApi && (parsed.cloudApi.apiUrl || parsed.cloudApi.apiKey || parsed.cloudApi.model)) {
            cloudApis = [{
                id: makeCloudApiId(),
                name: "主动消息 API",
                apiUrl: parsed.cloudApi.apiUrl || "",
                apiKey: parsed.cloudApi.apiKey || "",
                model: parsed.cloudApi.model || "",
            }];
        }
        const activeCloudApiId = cloudApis.some(item => item.id === parsed.activeCloudApiId)
            ? String(parsed.activeCloudApiId)
            : (cloudApis[0]?.id ?? "");

        const merged: ProactiveCloudConfig = {
            ...DEFAULT_CONFIG,
            ...parsed,
            perCharacter: parsed.perCharacter && typeof parsed.perCharacter === "object" ? parsed.perCharacter : {},
            cloudApis,
            activeCloudApiId,
            deviceId: typeof parsed.deviceId === "string" && parsed.deviceId ? parsed.deviceId : makeDeviceId(),
        };
        // 首次生成 deviceId / 做过迁移时立刻落库
        if (merged.deviceId !== parsed.deviceId || !Array.isArray(parsed.cloudApis)) saveProactiveCloudConfig(merged);
        return merged;
    } catch {
        return { ...DEFAULT_CONFIG, deviceId: makeDeviceId() };
    }
}

export function saveProactiveCloudConfig(config: ProactiveCloudConfig): void {
    if (typeof window === "undefined") return;
    try { kvSet(CONFIG_KEY, JSON.stringify(config)); } catch { /* 存不上就算了，下次读默认值 */ }
}

export function patchProactiveCloudConfig(patch: Partial<ProactiveCloudConfig>): ProactiveCloudConfig {
    const next = { ...loadProactiveCloudConfig(), ...patch };
    saveProactiveCloudConfig(next);
    return next;
}

export function normalizeWorkerUrl(url: string): string {
    return String(url || "").trim().replace(/\/+$/, "");
}

/** 地址和令牌都齐了才算能用 */
export function isProactiveCloudReady(config: ProactiveCloudConfig = loadProactiveCloudConfig()): boolean {
    return config.enabled
        && normalizeWorkerUrl(config.workerUrl).startsWith("https://")
        && config.serverToken.trim().length > 0;
}

// ──────────────────────────── 与 Worker 通信 ────────────────────────────

async function cloudFetch(
    config: ProactiveCloudConfig,
    path: string,
    init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
    const base = normalizeWorkerUrl(config.workerUrl);
    if (!base) throw new Error("还没填 Worker 地址");
    const timeoutMs = init?.timeoutMs ?? 20000;
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(init?.headers as Record<string, string> | undefined) };
    const token = config.serverToken.trim();
    if (token) headers["X-Client-Token"] = token;
    return fetch(`${base}${path}`, {
        ...init,
        headers,
        signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    });
}

async function readJsonSafe<T>(res: Response): Promise<T | null> {
    try { return await res.json() as T; } catch { return null; }
}

/** 读 /config-check：不需要令牌，用来判断"云端到底配齐没有" */
export async function checkConnection(config: ProactiveCloudConfig = loadProactiveCloudConfig()): Promise<{
    ok: boolean;
    message: string;
    warnings: string[];
}> {
    const base = normalizeWorkerUrl(config.workerUrl);
    if (!base) return { ok: false, message: "还没填 Worker 地址", warnings: [] };
    try {
        const res = await fetch(`${base}/config-check`, {
            signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
        });
        const data = await readJsonSafe<{ config?: { ok?: boolean; message?: string; warnings?: string[] } }>(res);
        if (!res.ok || !data) return { ok: false, message: `云端返回 HTTP ${res.status}`, warnings: [] };
        return {
            ok: data.config?.ok === true,
            message: data.config?.message || (data.config?.ok ? "配置齐全，可以用" : "云端配置不完整"),
            warnings: data.config?.warnings || [],
        };
    } catch (error) {
        return { ok: false, message: `连不上 Worker：${error instanceof Error ? error.message : String(error)}`, warnings: [] };
    }
}

// ──────────────────────────── 组装要同步的材料 ────────────────────────────

/**
 * 把 baseUrl 归一化成 OpenAI 兼容的根地址。
 * 她的中转站可能是 /v1beta（Gemini 原生用），而云端生成走的是 /v1/chat/completions，
 * 所以要把 v1beta / v1 / chat/completions 后缀去掉，让 Worker 自己拼。
 */
export function openAiCompatibleRoot(baseUrl: string): string {
    return String(baseUrl || "")
        .trim()
        .replace(/\/+$/, "")
        .replace(/\/chat\/completions$/i, "")
        .replace(/\/(v1beta|v1alpha|v1)$/i, "");
}

function formatMemories(core: { content: string }[], longTerm: { content: string; importance?: number; createdAt?: string }[]): string {
    const lines: string[] = [];
    if (core.length > 0) {
        lines.push("【关于对方的核心记忆】");
        for (const item of core) lines.push(`- ${item.content.trim()}`);
    }
    if (longTerm.length > 0) {
        // 重要的排前面，其次新的排前面
        const sorted = [...longTerm].sort((a, b) => {
            const byImportance = (b.importance ?? 0) - (a.importance ?? 0);
            if (Math.abs(byImportance) > 0.15) return byImportance;
            return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
        });
        lines.push("【长期记忆】");
        for (const item of sorted) lines.push(`- ${item.content.trim()}`);
    }
    const text = lines.join("\n");
    return text.length > MEMORY_CHAR_CAP ? `${text.slice(0, MEMORY_CHAR_CAP)}…` : text;
}

export type ProactiveMaterial = {
    characterName: string;
    characterCard: string;
    memory: string;
    styleRules: string;
    recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
    timeZone: string;
    quietHours: { start: number; end: number };
    dailyLimit: number;
    llm: { apiUrl: string; apiKey: string; model: string; temperature?: number; maxTokens?: number };
};

export type MaterialBuildResult =
    | { ok: true; material: ProactiveMaterial }
    | { ok: false; reason: string };

/**
 * 组装某个角色的云端生成材料。任何一个必需项缺失都返回人话原因，
 * 让设置页能直接告诉用户"缺什么"，而不是等到消息发不出来才发现。
 */
export async function buildProactiveMaterial(
    characterId: string,
    config: ProactiveCloudConfig = loadProactiveCloudConfig(),
): Promise<MaterialBuildResult> {
    await hydrateChatStorage();

    const character = loadCharacters().find(item => item.id === characterId);
    if (!character) return { ok: false, reason: "找不到这个角色" };

    const llmResult = resolveCloudLlm(config);
    if (!llmResult.ok) return { ok: false, reason: llmResult.reason };
    const llm = llmResult.llm;

    const [coreMemories, longTermMemories] = await Promise.all([
        loadMemoryEntriesByType(characterId, "core").catch(() => []),
        loadMemoryEntriesByType(characterId, "long_term").catch(() => []),
    ]);

    const session = loadChatSessions().find(item => !item.isGroup && item.contactId === characterId);
    const rawHistory: ChatMessage[] = session ? loadChatMessages(session.id, 60) : [];
    const recentMessages = rawHistory
        .filter(item => (item.role === "user" || item.role === "assistant") && typeof item.content === "string" && item.content.trim())
        .slice(-RECENT_MESSAGE_LIMIT)
        .map(item => ({
            role: item.role as "user" | "assistant",
            content: item.content.trim().slice(0, MESSAGE_CHAR_CAP),
        }));

    const styleSource = [character.personality?.trim(), character.briefPersona?.trim()].filter(Boolean).join("\n");

    return {
        ok: true,
        material: {
            characterName: character.name,
            characterCard: (character.persona || "").slice(0, CARD_CHAR_CAP),
            memory: formatMemories(coreMemories, longTermMemories),
            styleRules: styleSource.slice(0, 4000),
            recentMessages,
            timeZone: character.timeZone || "Asia/Shanghai",
            quietHours: { start: config.quietStartHour, end: config.quietEndHour },
            dailyLimit: config.dailyLimit,
            llm,
        },
    };
}

/**
 * 解析"云端生成用哪个模型"。两档：
 * - custom（默认）：用设置页里那套专用配置
 * - binding：沿用角色绑定的那套（地址必须是 OpenAI 兼容的，例如中转站）
 */
/** 当前选中的那条（没选就退回第一条） */
export function loadActiveCloudApi(
    config: ProactiveCloudConfig = loadProactiveCloudConfig(),
): ProactiveCloudApiEntry | null {
    const list = Array.isArray(config.cloudApis) ? config.cloudApis : [];
    if (list.length === 0) return null;
    return list.find(item => item.id === config.activeCloudApiId) ?? list[0] ?? null;
}

export function resolveCloudLlm(
    config: ProactiveCloudConfig = loadProactiveCloudConfig(),
): { ok: true; llm: ProactiveMaterial["llm"] } | { ok: false; reason: string } {
    const entry = loadActiveCloudApi(config);
    if (!entry) return { ok: false, reason: "还没有配置主动消息 API" };

    const label = entry.name?.trim() || "未命名";
    const apiUrl = openAiCompatibleRoot(entry.apiUrl);
    if (!apiUrl) return { ok: false, reason: `「${label}」还没填接口地址` };
    if (!entry.apiKey?.trim()) return { ok: false, reason: `「${label}」还没填 API Key` };
    if (!entry.model?.trim()) return { ok: false, reason: `「${label}」还没填模型名` };
    if (/generativelanguage\.googleapis\.com/i.test(apiUrl)) {
        return { ok: false, reason: `「${label}」是 Google 官方直连地址，云端需要中转站地址` };
    }

    return {
        ok: true,
        llm: { apiUrl, apiKey: entry.apiKey.trim(), model: entry.model.trim(), temperature: 0.95, maxTokens: 400 },
    };
}

/** 与云端 Worker 里 normalizeApiUrl 完全一致的拼法 */
export function buildOpenAiChatUrl(apiUrl: string): string {
    const base = String(apiUrl || "").trim().replace(/\/+$/, "");
    if (!base) return "";
    if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
}

/**
 * 在浏览器里直接试一次"云端生成用的 API"，不用等云端。
 * 这样就地能看出地址/Key/模型名对不对，省得部署完才发现调不通。
 */
export async function testProactiveCloudApi(
    config: ProactiveCloudConfig = loadProactiveCloudConfig(),
): Promise<{ ok: boolean; reply?: string; reason?: string }> {
    const resolved = resolveCloudLlm(config);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };

    const url = buildOpenAiChatUrl(resolved.llm.apiUrl);
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolved.llm.apiKey}` },
            body: JSON.stringify({
                model: resolved.llm.model,
                messages: [{ role: "user", content: "只回两个字：收到" }],
                max_tokens: 20,
                stream: false,
            }),
            signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(25000) : undefined,
        });
        const text = await res.text();
        if (!res.ok) return { ok: false, reason: `HTTP ${res.status}：${text.slice(0, 200)}` };
        type ChatCompletionShape = { choices?: Array<{ message?: { content?: string }; text?: string }> };
        let parsed: ChatCompletionShape | null = null;
        try { parsed = JSON.parse(text) as ChatCompletionShape; }
        catch { return { ok: false, reason: `返回的不是 JSON：${text.slice(0, 140)}` }; }
        const content = parsed?.choices?.[0]?.message?.content ?? parsed?.choices?.[0]?.text ?? "";
        return { ok: true, reply: String(content).trim().slice(0, 80) || "（通道正常，但模型返回了空内容）" };
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

/** 同步材料到云端；返回人话原因方便设置页直接显示 */
export async function syncProactiveMaterial(
    characterId: string,
    config: ProactiveCloudConfig = loadProactiveCloudConfig(),
): Promise<{ ok: boolean; reason?: string }> {
    if (!normalizeWorkerUrl(config.workerUrl)) return { ok: false, reason: "还没填 Worker 地址" };

    const built = await buildProactiveMaterial(characterId, config);
    if (!built.ok) return { ok: false, reason: built.reason };

    try {
        const res = await cloudFetch(config, "/sync", {
            method: "POST",
            body: JSON.stringify({ deviceId: config.deviceId, characterId, payload: built.material }),
        });
        if (!res.ok) {
            const data = await readJsonSafe<{ error?: string }>(res);
            return { ok: false, reason: data?.error || `云端返回 HTTP ${res.status}` };
        }
        patchProactiveCloudConfig({ lastSyncAt: Date.now() });
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

// ──────────────────────────── 任务登记 ────────────────────────────

export type ProactiveTaskInput = {
    taskId: string;
    characterId: string;
    fireAt: number;
    intent: string;
    title?: string;
    /** interval：云端触发后自动排下一次 */
    kind?: "once" | "interval";
    intervalMs?: number;
};

export async function registerProactiveTask(
    task: ProactiveTaskInput,
    config: ProactiveCloudConfig = loadProactiveCloudConfig(),
): Promise<{ ok: boolean; reason?: string }> {
    if (!isProactiveCloudReady(config)) return { ok: false, reason: "云端主动消息没开启或没配置" };
    try {
        const res = await cloudFetch(config, "/task", {
            method: "POST",
            body: JSON.stringify({
                deviceId: config.deviceId,
                characterId: task.characterId,
                taskId: task.taskId,
                fireAt: task.fireAt,
                intent: task.intent,
                title: task.title,
                kind: task.kind,
                intervalMs: task.intervalMs,
            }),
        });
        if (!res.ok) {
            const data = await readJsonSafe<{ error?: string }>(res);
            return { ok: false, reason: data?.error || `云端返回 HTTP ${res.status}` };
        }
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

export async function cancelProactiveTask(
    taskId: string,
    config: ProactiveCloudConfig = loadProactiveCloudConfig(),
): Promise<boolean> {
    if (!normalizeWorkerUrl(config.workerUrl)) return false;
    try {
        const res = await cloudFetch(config, "/task/delete", {
            method: "POST",
            body: JSON.stringify({ taskId }),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/** 清空某个角色所有待发任务（关掉某个角色、改间隔时用） */
export async function cancelCharacterTasks(
    characterId: string,
    config: ProactiveCloudConfig = loadProactiveCloudConfig(),
): Promise<boolean> {
    if (!normalizeWorkerUrl(config.workerUrl)) return false;
    try {
        const res = await cloudFetch(config, "/task/delete", {
            method: "POST",
            body: JSON.stringify({ deviceId: config.deviceId, characterId }),
        });
        return res.ok;
    } catch {
        return false;
    }
}

export type CloudTask = {
    id: string;
    character_id: string;
    fire_at: number;
    status: string;
    kind?: string | null;
    interval_ms?: number | null;
};

export async function listProactiveTasks(
    config: ProactiveCloudConfig = loadProactiveCloudConfig(),
): Promise<CloudTask[]> {
    if (!normalizeWorkerUrl(config.workerUrl)) return [];
    try {
        const res = await cloudFetch(config, `/task/list?deviceId=${encodeURIComponent(config.deviceId)}`);
        if (!res.ok) return [];
        const data = await readJsonSafe<{ tasks?: CloudTask[] }>(res);
        return data?.tasks || [];
    } catch {
        return [];
    }
}

/** 每个角色只保留一条 interval 任务：用固定 id upsert，避免重开 app 越堆越多 */
export function intervalTaskId(deviceId: string, characterId: string): string {
    return `interval_${deviceId}_${characterId}`;
}

/**
 * 按当前设置对齐"自动主动消息"任务：
 * - 开启且间隔 > 0 的角色：确保云端有一条 interval 任务
 * - 关掉或间隔为 0 的角色：清掉它的云端任务
 * 已经存在且间隔没变的任务不动，避免每次打开 app 都把计时重置。
 */
export async function reconcileIntervalTasks(
    config: ProactiveCloudConfig = loadProactiveCloudConfig(),
): Promise<{ registered: number; cleared: number; reasons: string[] }> {
    const reasons: string[] = [];
    if (!isProactiveCloudReady(config)) return { registered: 0, cleared: 0, reasons };

    const pending = await listProactiveTasks(config);
    let registered = 0;
    let cleared = 0;

    for (const [characterId, settings] of Object.entries(config.perCharacter)) {
        const wanted = Math.max(0, Math.round(settings.intervalMinutes || 0));
        const existing = pending.find(item => item.character_id === characterId && item.kind === "interval");

        if (!settings.enabled || wanted <= 0) {
            if (existing || pending.some(item => item.character_id === characterId)) {
                if (await cancelCharacterTasks(characterId, config)) cleared++;
            }
            continue;
        }

        if (existing && Number(existing.interval_ms || 0) === wanted * 60 * 1000) continue;

        const synced = await syncProactiveMaterial(characterId, config);
        if (!synced.ok) {
            reasons.push(`${characterId}：${synced.reason}`);
            continue;
        }
        const result = await registerProactiveTask({
            taskId: intervalTaskId(config.deviceId, characterId),
            characterId,
            fireAt: Date.now() + wanted * 60 * 1000,
            intent: "按你平时的方式，主动找对方说句话；没什么想说的就保持沉默",
            kind: "interval",
            intervalMs: wanted * 60 * 1000,
        }, config);
        if (result.ok) registered++;
        else reasons.push(`${characterId}：${result.reason}`);
    }

    return { registered, cleared, reasons };
}

// ──────────────────────────── 推送订阅 ────────────────────────────

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(normalized);
    const out = new Uint8Array(new ArrayBuffer(raw.length));
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

export type PushSetupResult = { ok: boolean; reason?: string; endpoint?: string };

/**
 * 申请通知权限并建立推送订阅，然后把订阅登记到云端。
 * iOS 必须先"添加到主屏幕"成 PWA 才可能成功——失败时会把原因说清楚。
 */
export async function ensurePushSubscription(
    config: ProactiveCloudConfig = loadProactiveCloudConfig(),
): Promise<PushSetupResult> {
    if (typeof window === "undefined") return { ok: false, reason: "不在浏览器环境" };
    if (!normalizeWorkerUrl(config.workerUrl)) return { ok: false, reason: "还没填 Worker 地址" };
    if (!("serviceWorker" in navigator)) return { ok: false, reason: "这个浏览器不支持 Service Worker" };
    if (!("PushManager" in window)) return { ok: false, reason: "这个浏览器不支持推送（iOS 需要 16.4 以上，且必须「添加到主屏幕」）" };
    if (!("Notification" in window)) return { ok: false, reason: "这个浏览器不支持通知" };

    // iOS 非独立窗口（还在 Safari 标签页里）收不到推送
    const standalone = window.matchMedia?.("(display-mode: standalone)")?.matches
        || (navigator as unknown as { standalone?: boolean }).standalone === true;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as unknown as { MSStream?: unknown }).MSStream;
    if (isIOS && !standalone) {
        return { ok: false, reason: "iPhone 上要先点分享 → 添加到主屏幕，然后从主屏图标打开，推送才能用" };
    }

    if (Notification.permission === "denied") {
        return { ok: false, reason: "通知权限被拒绝了。iOS 到 设置 → 通知 里允许；浏览器到站点设置里改" };
    }
    if (Notification.permission !== "granted") {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") return { ok: false, reason: "没有拿到通知权限" };
    }

    let publicKey = "";
    try {
        const res = await cloudFetch(config, "/vapid-public-key");
        const data = await readJsonSafe<{ publicKey?: string }>(res);
        publicKey = data?.publicKey || "";
    } catch (error) {
        return { ok: false, reason: `拿不到推送公钥：${error instanceof Error ? error.message : String(error)}` };
    }
    if (!publicKey) return { ok: false, reason: "云端没有 VAPID 公钥，请先按部署清单把密钥填好" };

    try {
        // 本地开发环境不注册 Service Worker，navigator.serviceWorker.ready 会永远挂着——
        // 这里给它 5 秒，超时就说清原因，别让按钮一直转。
        const registration = await Promise.race([
            navigator.serviceWorker.ready,
            new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
        ]);
        if (!registration) {
            return { ok: false, reason: "没有可用的 Service Worker。线上（Vercel）才会注册，本地开发环境收不到推送" };
        }
        let subscription = await registration.pushManager.getSubscription();

        // 公钥换了（重新生成过 VAPID）时必须重订，否则推送会被浏览器拒收
        if (subscription) {
            const existingKey = subscription.options?.applicationServerKey;
            const currentKey = urlBase64ToUint8Array(publicKey);
            const same = existingKey && existingKey.byteLength === currentKey.byteLength
                && new Uint8Array(existingKey).every((byte, index) => byte === currentKey[index]);
            if (!same) {
                await subscription.unsubscribe().catch(() => {});
                subscription = null;
            }
        }

        if (!subscription) {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey),
            });
        }

        const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
        if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
            return { ok: false, reason: "订阅缺少 endpoint 或加密公钥" };
        }

        const res = await cloudFetch(config, "/subscribe", {
            method: "POST",
            body: JSON.stringify({
                deviceId: config.deviceId,
                subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
            }),
        });
        if (!res.ok) {
            const data = await readJsonSafe<{ error?: string }>(res);
            return { ok: false, reason: data?.error || `登记订阅失败：HTTP ${res.status}` };
        }
        return { ok: true, endpoint: json.endpoint };
    } catch (error) {
        return { ok: false, reason: `订阅失败：${error instanceof Error ? error.message : String(error)}` };
    }
}

export async function sendTestPush(
    config: ProactiveCloudConfig = loadProactiveCloudConfig(),
): Promise<{ ok: boolean; reason?: string }> {
    try {
        const res = await cloudFetch(config, "/test", { method: "POST", body: JSON.stringify({ deviceId: config.deviceId }) });
        const data = await readJsonSafe<{ ok?: boolean; error?: string }>(res);
        if (!res.ok || !data?.ok) return { ok: false, reason: data?.error || `HTTP ${res.status}` };
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

// ──────────────────────────── 收件箱 ────────────────────────────

/** 拉云端收件箱，把消息写进本地聊天记录（角色说的，记为 assistant） */
export async function pullProactiveInbox(
    config: ProactiveCloudConfig = loadProactiveCloudConfig(),
): Promise<{ added: number; skipped: number; reason?: string }> {
    if (!normalizeWorkerUrl(config.workerUrl)) return { added: 0, skipped: 0, reason: "还没填 Worker 地址" };
    await hydrateChatStorage();

    let items: Array<{ id: number; character_id: string; body: string }> = [];
    try {
        const res = await cloudFetch(config, `/pull?deviceId=${encodeURIComponent(config.deviceId)}`);
        if (!res.ok) return { added: 0, skipped: 0, reason: `云端返回 HTTP ${res.status}` };
        const data = await readJsonSafe<{ messages?: typeof items }>(res);
        items = data?.messages || [];
    } catch (error) {
        return { added: 0, skipped: 0, reason: error instanceof Error ? error.message : String(error) };
    }

    if (items.length === 0) {
        patchProactiveCloudConfig({ lastPullAt: Date.now() });
        return { added: 0, skipped: 0 };
    }

    const sessions = loadChatSessions();
    let added = 0;
    let skipped = 0;
    const touchedCharacters = new Set<string>();
    for (const item of items) {
        const session = sessions.find(s => !s.isGroup && s.contactId === item.character_id);
        const body = String(item.body || "").trim();
        if (!session || !body) { skipped++; continue; }
        pushChatMessage({
            sessionId: session.id,
            role: "assistant",
            content: body,
        });
        touchedCharacters.add(item.character_id);
        added++;
    }

    // 云端已经发出来了，本地那条"稍后发送"的记录就该清掉，不然它会一直挂着
    if (touchedCharacters.size > 0) {
        const now = Date.now();
        for (const schedule of loadTimedWakeSchedules()) {
            if (schedule.fireAt > now + 60 * 1000) continue;
            if (!touchedCharacters.has(schedule.characterId)) continue;
            removeTimedWakeSchedule(schedule.id);
        }
    }

    patchProactiveCloudConfig({ lastPullAt: Date.now() });
    return { added, skipped };
}

// ──────────────────────────── 定时同步与诊断 ────────────────────────────

let serviceTimer: ReturnType<typeof setInterval> | null = null;
let resyncCounter = 0;
let swMessageListener: ((event: MessageEvent) => void) | null = null;
let chatMessageListener: ((event: Event) => void) | null = null;
/** 每个角色上次因为"发了消息"而同步材料的时间，用来节流 */
const lastMessageSyncAt = new Map<string, number>();

/**
 * 有新消息就刷新这个角色的云端材料（节流）。
 * 云端到点生成时用的就是这份材料，所以它越新，主动消息越贴合最近的对话。
 * 节流是为了别每发一句就传一次（材料里含最近 20 条聊天和记忆，体积不小）。
 */
function onChatMessagePushed(event: Event): void {
    const detail = (event as CustomEvent<{ message?: { sessionId?: string } }>).detail;
    const sessionId = detail?.message?.sessionId;
    if (!sessionId) return;

    const config = loadProactiveCloudConfig();
    if (!isProactiveCloudReady(config)) return;

    const session = loadChatSessions().find(item => item.id === sessionId);
    const characterId = session?.contactId;
    if (!characterId) return;
    if (!config.perCharacter[characterId]?.enabled) return;

    const last = lastMessageSyncAt.get(characterId) ?? 0;
    if (Date.now() - last < MESSAGE_SYNC_THROTTLE_MS) return;
    lastMessageSyncAt.set(characterId, Date.now());
    void syncProactiveMaterial(characterId, config).catch(() => {});
}

/** SW 收到推送会 postMessage 过来：立刻拉一次收件箱，消息第一时间进聊天 */
function onServiceWorkerMessage(event: MessageEvent): void {
    const data = event.data as { type?: string } | undefined;
    if (data?.type !== "amsg-push") return;
    const config = loadProactiveCloudConfig();
    if (!isProactiveCloudReady(config)) return;
    void pullProactiveInbox(config).catch(() => {});
}

/**
 * 启动客户端轮询：可见时每分钟拉一次收件箱，每 15 分钟重新同步一次材料。
 * app 关着时它自然不跑——那段时间由云端负责生成与推送。
 */
export function startProactiveCloudService(): () => void {
    stopProactiveCloudService();
    const tick = async () => {
        const config = loadProactiveCloudConfig();
        if (!isProactiveCloudReady(config)) return;
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return;

        await pullProactiveInbox(config).catch(() => {});
        resyncCounter++;
        if (resyncCounter * PULL_INTERVAL_MS >= RESYNC_INTERVAL_MS) {
            resyncCounter = 0;
            for (const [characterId, settings] of Object.entries(config.perCharacter)) {
                if (settings.enabled) await syncProactiveMaterial(characterId, config).catch(() => {});
            }
        }
    };

    void tick();
    // 启动时对一次账：确保开启的角色在云端有任务、材料是最新的，并把离线期间攒下的收件箱拉回来。
    // reconcileIntervalTasks 内部会跳过"间隔没变"的任务，所以每次打开 app 不会把计时重置。
    void (async () => {
        const config = loadProactiveCloudConfig();
        if (!isProactiveCloudReady(config)) return;
        await reconcileIntervalTasks(config).catch(() => {});
        await pullProactiveInbox(config).catch(() => {});
    })();
    serviceTimer = setInterval(() => { void tick(); }, PULL_INTERVAL_MS);
    if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisibilityChange);
    }
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator && !swMessageListener) {
        swMessageListener = onServiceWorkerMessage;
        navigator.serviceWorker.addEventListener("message", swMessageListener);
    }
    if (typeof window !== "undefined" && !chatMessageListener) {
        chatMessageListener = onChatMessagePushed;
        window.addEventListener(CHAT_MESSAGE_PUSHED_EVENT, chatMessageListener);
    }
    return stopProactiveCloudService;
}

function onVisibilityChange(): void {
    if (document.visibilityState !== "visible") return;
    const config = loadProactiveCloudConfig();
    if (!isProactiveCloudReady(config)) return;
    void pullProactiveInbox(config).catch(() => {});
}

export function stopProactiveCloudService(): void {
    if (serviceTimer) {
        clearInterval(serviceTimer);
        serviceTimer = null;
    }
    if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    if (swMessageListener && typeof navigator !== "undefined" && "serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("message", swMessageListener);
        swMessageListener = null;
    }
    if (chatMessageListener && typeof window !== "undefined") {
        window.removeEventListener(CHAT_MESSAGE_PUSHED_EVENT, chatMessageListener);
        chatMessageListener = null;
    }
}

export type LocalPushStatus = {
    supported: boolean;
    hasServiceWorker: boolean;
    /** Notification.permission */
    permission: string;
    endpoint: string | null;
    isStandalone: boolean;
};

/** 只查本机的推送状态：支不支持、有没有授权、有没有订阅（不发任何网络请求） */
export async function getLocalPushStatus(): Promise<LocalPushStatus> {
    let endpoint: string | null = null;
    const hasServiceWorker = typeof navigator !== "undefined" && "serviceWorker" in navigator;
    try {
        if (hasServiceWorker) {
            const registration = await Promise.race([
                navigator.serviceWorker.ready,
                new Promise<null>(resolve => setTimeout(() => resolve(null), 1500)),
            ]);
            if (registration) {
                const sub = await registration.pushManager.getSubscription();
                endpoint = sub?.endpoint ?? null;
            }
        }
    } catch { /* 拿不到就当没订阅 */ }

    return {
        supported: typeof window !== "undefined" && "PushManager" in window,
        hasServiceWorker,
        permission: typeof Notification !== "undefined" ? Notification.permission : "unavailable",
        endpoint,
        isStandalone: typeof window !== "undefined" && (window.matchMedia?.("(display-mode: standalone)")?.matches ?? false),
    };
}

export type ProactiveDiagnostics = {
    local: {
        enabled: boolean;
        workerUrl: string;
        hasToken: boolean;
        deviceId: string;
        notificationPermission: string;
        hasServiceWorker: boolean;
        pushSupported: boolean;
        endpoint: string | null;
        isStandalone: boolean;
    };
    remote: {
        reachable: boolean;
        ok: boolean;
        message: string;
        warnings: string[];
        counts?: Record<string, number | null>;
        overdue?: number;
    };
};

export async function getProactiveDiagnostics(
    config: ProactiveCloudConfig = loadProactiveCloudConfig(),
): Promise<ProactiveDiagnostics> {
    const local = await getLocalPushStatus();
    const endpoint: string | null = local.endpoint;

    let remote: ProactiveDiagnostics["remote"] = {
        reachable: false, ok: false, message: "还没检查", warnings: [],
    };
    if (normalizeWorkerUrl(config.workerUrl)) {
        const check = await checkConnection(config);
        remote = { reachable: true, ok: check.ok, message: check.message, warnings: check.warnings };
        try {
            const res = await cloudFetch(config, "/debug");
            const data = await readJsonSafe<{ counts?: Record<string, number | null>; overdue?: number }>(res);
            if (data) {
                remote.counts = data.counts;
                remote.overdue = data.overdue;
            }
        } catch { /* /debug 失败不影响主结论 */ }
    }

    return {
        local: {
            enabled: config.enabled,
            workerUrl: config.workerUrl,
            hasToken: config.serverToken.trim().length > 0,
            deviceId: config.deviceId,
            notificationPermission: local.permission,
            hasServiceWorker: local.hasServiceWorker,
            pushSupported: local.supported,
            endpoint,
            isStandalone: local.isStandalone,
        },
        remote,
    };
}
