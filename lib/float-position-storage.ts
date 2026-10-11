// lib/float-position-storage.ts — 悬浮球位置记忆
//
// 三个悬浮球（提示词查看器 / 快捷操作 / 音乐播放）拖动后把位置写进 kv-db，
// 下次打开 float 时恢复，不再每次都弹回默认的右下角。按球分 key 各存各的。

import { kvGet, kvSet } from "./kv-db";

export type FloatPosition = { left: number; top: number };

const KEY_PREFIX = "ai_phone_float_pos_";

/** 读取某个悬浮球上次记住的位置；没存过或数据损坏时返回 null（走默认位置） */
export function loadFloatPosition(ballKey: string): FloatPosition | null {
    try {
        const raw = kvGet(KEY_PREFIX + ballKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<FloatPosition> | null;
        if (parsed && typeof parsed.left === "number" && typeof parsed.top === "number") {
            return { left: parsed.left, top: parsed.top };
        }
    } catch {
        // 存储数据损坏就当作没存过，回默认位置
    }
    return null;
}

/** 拖动结束后记住位置；存储失败静默忽略，不影响拖动本身 */
export function saveFloatPosition(ballKey: string, position: FloatPosition): void {
    try {
        kvSet(KEY_PREFIX + ballKey, JSON.stringify({ left: position.left, top: position.top }));
    } catch {
        // 忽略
    }
}
