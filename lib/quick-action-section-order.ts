// lib/quick-action-section-order.ts — 快捷操作浮窗板块排序记忆
//
// 长按板块标题可拖动重排四个板块（角色卡/API/预设/世界书），
// 排序结果写进 kv-db，重开浮窗/重启应用后保持。

import { kvGet, kvSet } from "./kv-db";

const KEY = "ai_phone_quick_action_section_order_v1";

export type QuickSectionId = "character" | "api" | "preset" | "worldbook";

export const DEFAULT_SECTION_ORDER: QuickSectionId[] = ["character", "api", "preset", "worldbook"];

const KNOWN_IDS: readonly string[] = DEFAULT_SECTION_ORDER;

/** 读取板块顺序；没存过/数据损坏/缺板块时补全为默认相对顺序 */
export function loadQuickSectionOrder(): QuickSectionId[] {
    let stored: string[] | null = null;
    try {
        const raw = kvGet(KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.every(id => typeof id === "string")) {
                stored = parsed;
            }
        }
    } catch {
        // 存储数据损坏就当作没存过
    }
    if (!stored) return [...DEFAULT_SECTION_ORDER];
    // 只保留合法 id，按存量顺序；缺失的板块按默认顺序补在末尾
    const filtered = stored.filter(id => KNOWN_IDS.includes(id));
    for (const id of DEFAULT_SECTION_ORDER) {
        if (!filtered.includes(id)) filtered.push(id);
    }
    return filtered as QuickSectionId[];
}

/** 拖动结束后保存顺序；失败静默忽略 */
export function saveQuickSectionOrder(order: QuickSectionId[]): void {
    try {
        kvSet(KEY, JSON.stringify(order));
    } catch {
        // 忽略
    }
}
