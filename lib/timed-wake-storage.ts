import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const TIMED_WAKE_SCHEDULES_KEY = "ai_phone_timed_wake_schedules_v1";

registerKvMigration(TIMED_WAKE_SCHEDULES_KEY);

export type TimedWakeSchedule = {
    id: string;
    sessionId: string;
    characterId: string;
    fireAt: number;
    createdAt: number;
    delayMinutes: number;
    intent: string;
    /**
     * 已在云端登记的任务 id（值等于本 id）。
     * 有它就说明这次唤醒交给云端了：本地轮询不再重复发，避免 app 开着时发两条。
     * 云端消息到达后本条目会被自动清掉（见 lib/proactive-cloud.ts 的 pullProactiveInbox）。
     */
    cloudTaskId?: string;
};

export function makeTimedWakeId(sessionId: string): string {
    return `timed_wake_${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function loadTimedWakeSchedules(): TimedWakeSchedule[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(TIMED_WAKE_SCHEDULES_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isTimedWakeSchedule);
    } catch {
        return [];
    }
}

function saveTimedWakeSchedules(schedules: TimedWakeSchedule[]): void {
    if (typeof window === "undefined") return;
    kvSet(TIMED_WAKE_SCHEDULES_KEY, JSON.stringify(schedules));
}

export function saveTimedWakeSchedule(schedule: TimedWakeSchedule): void {
    const all = loadTimedWakeSchedules();
    const next = all.filter(item => item.sessionId !== schedule.sessionId);
    next.push(schedule);
    saveTimedWakeSchedules(next);
}

export function clearTimedWakeSchedule(sessionId: string): void {
    saveTimedWakeSchedules(loadTimedWakeSchedules().filter(item => item.sessionId !== sessionId));
}

export function removeTimedWakeSchedule(id: string): void {
    saveTimedWakeSchedules(loadTimedWakeSchedules().filter(item => item.id !== id));
}

function isTimedWakeSchedule(value: unknown): value is TimedWakeSchedule {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<TimedWakeSchedule>;
    return typeof item.id === "string"
        && typeof item.sessionId === "string"
        && typeof item.characterId === "string"
        && typeof item.fireAt === "number"
        && typeof item.createdAt === "number"
        && typeof item.delayMinutes === "number"
        && typeof item.intent === "string";
}
