// ── 深链导航的"挂载竞态"保险丝 ──
// 快捷浮窗通过 open-app 事件切换 App，再延迟分发 settings-navigate / character-navigate-edit。
// 若目标 App 尚未挂载完成（首次编译慢），事件监听器未就位，深链会被静默丢弃。
// 因此在分发事件前先把导航意图存入模块级变量，目标 App mount 后主动领取（take*），彻底消除时序依赖。

export interface PendingSettingsNavigation {
    page: string;
    editingId?: string | null;
    returnApp?: string | null;
}

let pendingSettingsNav: PendingSettingsNavigation | null = null;

export function setPendingSettingsNavigation(detail: PendingSettingsNavigation) {
    pendingSettingsNav = detail;
}

/** 领取并清除待处理的设置页深链；无则返回 null */
export function takePendingSettingsNavigation(): PendingSettingsNavigation | null {
    const d = pendingSettingsNav;
    pendingSettingsNav = null;
    return d;
}

export interface PendingCharacterNavigation {
    characterId?: string | null;
    isEditing?: boolean;
    returnApp?: string | null;
}

let pendingCharacterNav: PendingCharacterNavigation | null = null;

export function setPendingCharacterNavigation(detail: PendingCharacterNavigation) {
    pendingCharacterNav = detail;
}

/** 领取并清除待处理的角色页深链；无则返回 null */
export function takePendingCharacterNavigation(): PendingCharacterNavigation | null {
    const d = pendingCharacterNav;
    pendingCharacterNav = null;
    return d;
}
