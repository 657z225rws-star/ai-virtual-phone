"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type CSSProperties } from "react";
import { BookOpen, Check, ChevronDown, Code2, SlidersHorizontal, UserRound, X, Fingerprint, Pencil } from "lucide-react";
import { CHAT_APP_SETTINGS_UPDATED_EVENT, loadChatAppSettings } from "@/lib/chat-storage";
import { useSwipeDirectTrigger } from "@/lib/use-swipe-direct-trigger";
import {
    getCharacterBinding,
    loadApiConfigs,
    loadBindingConfig,
    loadPresets,
    loadWorldBooks,
    saveBindingConfig,
    setCharacterBinding,
} from "@/lib/settings-storage";
import type { ApiConfig, BindingConfig, BindingSlot, PresetConfig, WorldBookConfig } from "@/lib/settings-types";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { loadFloatPosition, saveFloatPosition } from "@/lib/float-position-storage";
import { setPendingCharacterNavigation, setPendingSettingsNavigation } from "@/lib/pending-navigation";
import { useQuickSectionSort } from "@/lib/use-quick-section-sort";
import { loadQuickSectionOrder, saveQuickSectionOrder, DEFAULT_SECTION_ORDER, type QuickSectionId } from "@/lib/quick-action-section-order";

type QuickScope = "global" | "character";
type FloatingPosition = { left: number; top: number };
type PopoverPosition = { left: number; top: number };
type FloatingDragState = {
    pointerId: number;
    startClientX: number;
    startClientY: number;
    left: number;
    top: number;
    maxLeft: number;
    maxTop: number;
    moved: boolean;
};

const EMPTY_BINDING_CONFIG: BindingConfig = { globalDefaults: {}, characterBindings: [] };

function clampFloatingPosition(value: number, max: number): number {
    return Math.min(Math.max(12, value), max);
}

function itemName<T extends { id: string; name?: string }>(items: T[], id?: string): string {
    if (!id) return "";
    return items.find(item => item.id === id)?.name || "已删除的配置";
}

function getStatusSafeTop(element: HTMLElement): number {
    const raw = window.getComputedStyle(element).getPropertyValue("--safe-area-top");
    const safeAreaTop = Number.parseFloat(raw);
    return Math.max(72, (Number.isFinite(safeAreaTop) ? safeAreaTop : 48) + 18);
}

export function QuickActionFloat({ activeApp }: { activeApp?: string | null } = {}) {
    const [enabled, setEnabled] = useState(false);
    const [open, setOpen] = useState(false);
    const [scope, setScope] = useState<QuickScope>("character");
    const [selectedCharId, setSelectedCharId] = useState("");
    const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({
        worldbook: true,
    });
    const [sectionOrder, setSectionOrder] = useState<QuickSectionId[]>(DEFAULT_SECTION_ORDER);
    const [config, setConfig] = useState<BindingConfig>(EMPTY_BINDING_CONFIG);
    const [apiConfigs, setApiConfigs] = useState<ApiConfig[]>([]);
    const [presets, setPresets] = useState<PresetConfig[]>([]);
    const [worldBooks, setWorldBooks] = useState<WorldBookConfig[]>([]);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [floatingPosition, setFloatingPosition] = useState<FloatingPosition | null>(null);
    const [popoverPosition, setPopoverPosition] = useState<PopoverPosition | null>(null);
    const [draggingFloatingButton, setDraggingFloatingButton] = useState(false);
    const layerRef = useRef<HTMLDivElement | null>(null);
    const floatingButtonRef = useRef<HTMLButtonElement | null>(null);
    const floatingDragRef = useRef<FloatingDragState | null>(null);
    const suppressFloatingClickRef = useRef(false);

    const reloadData = useCallback(() => {
        const nextCharacters = loadCharacters();
        setConfig(loadBindingConfig());
        setApiConfigs(loadApiConfigs());
        setPresets(loadPresets());
        setWorldBooks(loadWorldBooks());
        setCharacters(nextCharacters);
        setSelectedCharId(prev => {
            if (prev && nextCharacters.some(character => character.id === prev)) return prev;
            return nextCharacters[0]?.id || "";
        });
    }, []);

    useEffect(() => {
        const syncEnabled = (event?: Event) => {
            const detail = (event as CustomEvent | undefined)?.detail;
            const nextEnabled = typeof detail?.quickActionEnabled === "boolean"
                ? detail.quickActionEnabled
                : loadChatAppSettings().quickActionEnabled === true;
            setEnabled(nextEnabled);
            if (!nextEnabled) setOpen(false);
        };
        syncEnabled();
        window.addEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, syncEnabled);
        return () => window.removeEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, syncEnabled);
    }, []);

    useEffect(() => {
        if (!enabled) return;
        reloadData();
        setSectionOrder(loadQuickSectionOrder());
        const handleBindingsUpdated = () => reloadData();
        const handleFocus = () => reloadData();
        window.addEventListener("settings-bindings-updated", handleBindingsUpdated);
        window.addEventListener("focus", handleFocus);
        return () => {
            window.removeEventListener("settings-bindings-updated", handleBindingsUpdated);
            window.removeEventListener("focus", handleFocus);
        };
    }, [enabled, reloadData]);

    useEffect(() => {
        if (!open) return;
        const handlePointerDown = (event: PointerEvent) => {
            if (!layerRef.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener("pointerdown", handlePointerDown);
        return () => document.removeEventListener("pointerdown", handlePointerDown);
    }, [open]);

    // 板块拖动排序：提交时把被拖板块插到目标板块前/后，并持久化
    const handleSectionReorder = useCallback((draggedId: string, targetId: string, insertAfter: boolean) => {
        setSectionOrder(prev => {
            const next = prev.filter(id => id !== draggedId);
            const at = next.indexOf(targetId as QuickSectionId);
            if (at < 0) return prev;
            next.splice(insertAfter ? at + 1 : at, 0, draggedId as QuickSectionId);
            saveQuickSectionOrder(next);
            return next;
        });
    }, []);
    const sectionSort = useQuickSectionSort(handleSectionReorder);

    // 各板块在 flex 容器里的视觉顺序（角色板块仅在角色 scope 渲染）
    const sectionOrderIndex = useCallback((id: QuickSectionId) => {
        const visible = sectionOrder.filter(entry => entry !== "character" || scope === "character");
        return visible.indexOf(id);
    }, [sectionOrder, scope]);
    const sectionDragHandlers = {
        onTouchStart: sectionSort.onTouchStart,
        onMouseDown: sectionSort.onMouseDown,
    };

    // 位置记忆：悬浮球显示出来后恢复上次拖放的位置（按当前父容器夹取，防止跑出屏）
    useEffect(() => {
        if (!enabled) return;
        const saved = loadFloatPosition("quick-action");
        if (!saved) return;
        const button = floatingButtonRef.current;
        if (!button) return;
        const bounds = getFloatingButtonBounds(button);
        setFloatingPosition({
            left: clampFloatingPosition(saved.left, bounds.maxLeft),
            top: clampFloatingPosition(saved.top, bounds.maxTop),
        });
    }, [enabled]);

    useLayoutEffect(() => {
        const layer = layerRef.current;
        const button = floatingButtonRef.current;
        if (!open || !layer || !button) {
            setPopoverPosition(null);
            return;
        }
        const rect = layer.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        const anchor = floatingPosition ?? {
            left: buttonRect.left - rect.left,
            top: buttonRect.top - rect.top,
        };
        const width = Math.min(344, rect.width - 32);
        const statusSafeTop = getStatusSafeTop(layer);
        const estimatedHeight = Math.min(520, Math.max(240, rect.height - statusSafeTop - 12));
        const left = anchor.left - width - 8;
        const top = anchor.top - estimatedHeight - 8;
        const maxTop = Math.max(statusSafeTop, rect.height - estimatedHeight - 12);
        setPopoverPosition({
            left: Math.min(Math.max(12, left), Math.max(12, rect.width - width - 12)),
            top: Math.min(Math.max(statusSafeTop, top), maxTop),
        });
    }, [open, floatingPosition]);

    const currentSlot: BindingSlot = useMemo(() => {
        if (scope === "global") return config.globalDefaults || {};
        if (!selectedCharId) return {};
        return getCharacterBinding(config, selectedCharId).defaults;
    }, [config, scope, selectedCharId]);

    const selectedCharacter = useMemo(
        () => characters.find(character => character.id === selectedCharId) || null,
        [characters, selectedCharId]
    );
    const selectedWorldBookIds = currentSlot.worldBookIds || [];
    const selectedWorldBookNames = selectedWorldBookIds.map(id => itemName(worldBooks, id)).filter(Boolean);
    const inheritedApiName = scope === "character" ? itemName(apiConfigs, config.globalDefaults.apiConfigId) : "";
    const inheritedPresetName = scope === "character" ? itemName(presets, config.globalDefaults.presetId) : "";
    const inheritedWorldBookNames = scope === "character"
        ? (config.globalDefaults.worldBookIds || []).map(id => itemName(worldBooks, id)).filter(Boolean)
        : [];

    const persistConfig = useCallback((next: BindingConfig) => {
        setConfig(next);
        saveBindingConfig(next);
    }, []);

    const updateApiConfig = useCallback((apiConfigId: string | undefined) => {
        if (scope === "global") {
            persistConfig({ ...config, globalDefaults: { ...config.globalDefaults, apiConfigId: apiConfigId || undefined } });
            return;
        }
        if (!selectedCharId) return;
        const binding = getCharacterBinding(config, selectedCharId);
        persistConfig(setCharacterBinding(config, {
            ...binding,
            defaults: { ...binding.defaults, apiConfigId: apiConfigId || undefined },
        }));
    }, [config, persistConfig, scope, selectedCharId]);

    const updatePreset = useCallback((presetId: string | undefined) => {
        if (scope === "global") {
            persistConfig({ ...config, globalDefaults: { ...config.globalDefaults, presetId: presetId || undefined } });
            return;
        }
        if (!selectedCharId) return;
        const binding = getCharacterBinding(config, selectedCharId);
        persistConfig(setCharacterBinding(config, {
            ...binding,
            defaults: { ...binding.defaults, presetId: presetId || undefined },
        }));
    }, [config, persistConfig, scope, selectedCharId]);

    const navigateToSettings = useCallback((page: string, editingId?: string) => {
        setOpen(false);
        const returnApp = activeApp && activeApp !== "settings" ? activeApp : null;
        setPendingSettingsNavigation({ page, editingId: editingId ?? null, returnApp });
        window.dispatchEvent(new CustomEvent("open-app", { detail: { appId: "settings" } }));
        setTimeout(() => {
            window.dispatchEvent(new CustomEvent("settings-navigate", { detail: { page, editingId, returnApp } }));
        }, 60);
    }, [activeApp]);

    const navigateToCharacters = useCallback((characterId?: string) => {
        setOpen(false);
        const returnApp = activeApp && activeApp !== "characters" ? activeApp : null;
        setPendingCharacterNavigation({ characterId: characterId ?? null, isEditing: Boolean(characterId), returnApp });
        window.dispatchEvent(new CustomEvent("open-app", { detail: { appId: "characters" } }));
        if (characterId) {
            setTimeout(() => {
                window.dispatchEvent(new CustomEvent("character-navigate-edit", { detail: { characterId, isEditing: true, returnApp } }));
            }, 60);
        }
    }, [activeApp]);

    const handleSwipeDirectEdit = useCallback((targetTypeAndId: string) => {
        const [type, id] = targetTypeAndId.split(":");
        if (type === "char") {
            navigateToCharacters(id);
        } else if (type === "api") {
            navigateToSettings("api", id);
        } else if (type === "preset") {
            navigateToSettings("presets", id);
        } else if (type === "worldbook") {
            navigateToSettings("worldbook", id);
        }
    }, [navigateToCharacters, navigateToSettings]);

    const swipeTrigger = useSwipeDirectTrigger(handleSwipeDirectEdit, 52);

    const updateWorldBooks = useCallback((worldBookIds: string[]) => {
        const nextIds = worldBookIds.length > 0 ? worldBookIds : undefined;
        if (scope === "global") {
            persistConfig({ ...config, globalDefaults: { ...config.globalDefaults, worldBookIds: nextIds } });
            return;
        }
        if (!selectedCharId) return;
        const binding = getCharacterBinding(config, selectedCharId);
        persistConfig(setCharacterBinding(config, {
            ...binding,
            defaults: { ...binding.defaults, worldBookIds: nextIds },
        }));
    }, [config, persistConfig, scope, selectedCharId]);

    const toggleWorldBook = useCallback((worldBookId: string) => {
        const next = selectedWorldBookIds.includes(worldBookId)
            ? selectedWorldBookIds.filter(id => id !== worldBookId)
            : [...selectedWorldBookIds, worldBookId];
        updateWorldBooks(next);
    }, [selectedWorldBookIds, updateWorldBooks]);

    function getFloatingButtonBounds(button: HTMLButtonElement) {
        const parent = button.offsetParent instanceof HTMLElement ? button.offsetParent : null;
        const parentRect = parent?.getBoundingClientRect() ?? {
            left: 0,
            top: 0,
            width: window.innerWidth,
            height: window.innerHeight,
        };
        const rect = button.getBoundingClientRect();
        return {
            left: rect.left - parentRect.left,
            top: rect.top - parentRect.top,
            maxLeft: Math.max(12, parentRect.width - rect.width - 12),
            maxTop: Math.max(12, parentRect.height - rect.height - 12),
        };
    }

    function handleFloatingPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
        event.stopPropagation();
        const button = event.currentTarget;
        const bounds = getFloatingButtonBounds(button);
        floatingDragRef.current = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            left: bounds.left,
            top: bounds.top,
            maxLeft: bounds.maxLeft,
            maxTop: bounds.maxTop,
            moved: false,
        };
        setDraggingFloatingButton(true);
        button.setPointerCapture(event.pointerId);
    }

    function handleFloatingPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
        const drag = floatingDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.stopPropagation();
        const deltaX = event.clientX - drag.startClientX;
        const deltaY = event.clientY - drag.startClientY;
        if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) drag.moved = true;
        setFloatingPosition({
            left: clampFloatingPosition(drag.left + deltaX, drag.maxLeft),
            top: clampFloatingPosition(drag.top + deltaY, drag.maxTop),
        });
    }

    function handleFloatingPointerEnd(event: ReactPointerEvent<HTMLButtonElement>) {
        const drag = floatingDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.stopPropagation();
        if (drag.moved) {
            suppressFloatingClickRef.current = true;
            // 拖完记住位置（floatingPosition 来自最近一次渲染，即最后一次移动的结果）
            if (floatingPosition) saveFloatPosition("quick-action", floatingPosition);
        }
        floatingDragRef.current = null;
        setDraggingFloatingButton(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    }

    function handleFloatingButtonClick(event: ReactMouseEvent<HTMLButtonElement>) {
        event.stopPropagation();
        if (suppressFloatingClickRef.current) {
            suppressFloatingClickRef.current = false;
            return;
        }
        reloadData();
        setOpen(prev => !prev);
    }

    if (!enabled) return null;

    const characterDisabled = scope === "character" && characters.length === 0;
    const inheritApiLabel = scope === "global"
        ? "未设置"
        : inheritedApiName
            ? `继承全局：${inheritedApiName}`
            : "继承全局";
    const inheritPresetLabel = scope === "global"
        ? "未设置（默认预设）"
        : inheritedPresetName
            ? `继承全局：${inheritedPresetName}`
            : "继承全局";
    const inheritWorldBookLabel = scope === "global"
        ? "未设置"
        : inheritedWorldBookNames.length > 0
            ? `继承全局：${inheritedWorldBookNames.join("、")}`
            : "继承全局";
    const popoverStyle: CSSProperties | undefined = popoverPosition
        ? { left: popoverPosition.left, top: popoverPosition.top }
        : undefined;

    return (
        <div className="quick-action-layer" ref={layerRef}>
            <button
                ref={floatingButtonRef}
                type="button"
                className="prompt-viewer-float-button quick-action-float-button"
                aria-label="打开快捷操作"
                data-positioned={floatingPosition ? "" : undefined}
                data-dragging={draggingFloatingButton ? "" : undefined}
                onPointerDown={handleFloatingPointerDown}
                onPointerMove={handleFloatingPointerMove}
                onPointerUp={handleFloatingPointerEnd}
                onPointerCancel={handleFloatingPointerEnd}
                onClick={handleFloatingButtonClick}
                style={floatingPosition ? { left: floatingPosition.left, top: floatingPosition.top } : undefined}
            >
                <SlidersHorizontal size={24} strokeWidth={1.9} />
            </button>

            {open ? (
                <div
                    className="quick-action-popover"
                    data-positioned={popoverPosition ? "" : undefined}
                    style={popoverStyle}
                    role="dialog"
                    aria-label="快捷操作"
                    onClick={event => event.stopPropagation()}
                >
                    <div className="quick-action-header">
                        <div className="quick-action-title">
                            <span className="quick-action-title-icon"><SlidersHorizontal size={18} /></span>
                            <div>
                                <h3>快捷操作</h3>
                                <p>{scope === "global" ? "全局默认" : selectedCharacter?.name || "角色默认"}</p>
                            </div>
                        </div>
                        <button type="button" className="quick-action-icon-btn" onClick={() => setOpen(false)} aria-label="关闭快捷操作">
                            <X size={18} />
                        </button>
                    </div>

                    <div className="quick-action-body" ref={sectionSort.containerRef}>
                        <div className="quick-action-tabs" role="tablist" aria-label="绑定范围">
                            <button
                                type="button"
                                data-active={scope === "global"}
                                onClick={() => setScope("global")}
                            >
                                全局
                            </button>
                            <button
                                type="button"
                                data-active={scope === "character"}
                                onClick={() => setScope("character")}
                            >
                                角色
                            </button>
                        </div>

                        {scope === "character" ? (
                            <section
                                className="quick-action-section"
                                data-section="character"
                                style={{ order: sectionOrderIndex("character") }}
                            >
                                <div
                                    className="quick-action-section-heading cursor-pointer select-none"
                                    onClick={() => {
                                        if (!sectionSort.shouldAllowClick()) return;
                                        setCollapsedSections(prev => ({ ...prev, character: !prev.character }));
                                    }}
                                    {...sectionDragHandlers}
                                >
                                    <span><UserRound size={16} />角色卡 ({characters.length})</span>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        <button
                                            type="button"
                                            className="quick-action-heading-btn"
                                            title="进入角色管理"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                navigateToCharacters();
                                            }}
                                        >
                                            <Pencil size={12} />
                                        </button>
                                        <small className="max-w-[80px] truncate">{selectedCharacter?.name || "未选择"}</small>
                                        <ChevronDown size={14} className="transition-transform duration-200" style={{ transform: collapsedSections.character ? "rotate(-90deg)" : "rotate(0deg)" }} />
                                    </div>
                                </div>
                                {!collapsedSections.character ? (
                                    <div className="quick-action-option-list mt-1">
                                        {characters.length === 0 ? (
                                            <div className="quick-action-empty">暂无角色卡</div>
                                        ) : characters.map(char => (
                                            <div
                                                key={char.id}
                                                className="quick-action-swipe-wrapper"
                                                data-armed={swipeTrigger.isSwiping(`char:${char.id}`) ? "" : undefined}
                                                onPointerDown={(e) => swipeTrigger.onPointerDown(e, `char:${char.id}`)}
                                                onPointerMove={swipeTrigger.onPointerMove}
                                                onPointerUp={swipeTrigger.onPointerEnd}
                                                onPointerCancel={swipeTrigger.onPointerEnd}
                                            >
                                                <div className="quick-action-swipe-bg">
                                                    <Pencil size={13} strokeWidth={2.2} />
                                                    <span>编辑</span>
                                                </div>
                                                <div
                                                    className="quick-action-swipe-content quick-action-option"
                                                    data-selected={selectedCharId === char.id}
                                                    onClick={() => {
                                                        if (swipeTrigger.consumeClickSuppression()) return;
                                                        setSelectedCharId(char.id);
                                                    }}
                                                >
                                                    <div className="flex items-center gap-2 min-w-0 flex-1">
                                                        {char.avatar ? (
                                                            <img src={char.avatar} alt={char.name} className="w-5 h-5 rounded-full object-cover shrink-0" />
                                                        ) : (
                                                            <UserRound size={14} className="shrink-0 opacity-60" />
                                                        )}
                                                        <span className="truncate">{char.name}</span>
                                                    </div>
                                                    {selectedCharId === char.id ? <Check size={15} /> : null}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : null}
                            </section>
                        ) : null}

                        <section
                            className="quick-action-section"
                            data-disabled={characterDisabled ? "" : undefined}
                            data-section="api"
                            style={{ order: sectionOrderIndex("api") }}
                        >
                            <div
                                className="quick-action-section-heading cursor-pointer select-none"
                                onClick={() => {
                                    if (!sectionSort.shouldAllowClick()) return;
                                    setCollapsedSections(prev => ({ ...prev, api: !prev.api }));
                                }}
                                {...sectionDragHandlers}
                            >
                                <span><Code2 size={16} />API ({apiConfigs.length})</span>
                                <div className="flex items-center gap-1.5 shrink-0">
                                    <button
                                        type="button"
                                        className="quick-action-heading-btn"
                                        title="进入 API 管理"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            navigateToSettings("api");
                                        }}
                                    >
                                        <Pencil size={12} />
                                    </button>
                                    <small className="max-w-[80px] truncate">{currentSlot.apiConfigId ? itemName(apiConfigs, currentSlot.apiConfigId) : (scope === "global" ? "未设置" : "继承")}</small>
                                    <ChevronDown size={14} className="transition-transform duration-200" style={{ transform: collapsedSections.api ? "rotate(-90deg)" : "rotate(0deg)" }} />
                                </div>
                            </div>
                            {!collapsedSections.api ? (
                                <div className="quick-action-option-list mt-1">
                                    <button
                                        type="button"
                                        className="quick-action-option"
                                        data-selected={!currentSlot.apiConfigId}
                                        disabled={characterDisabled}
                                        onClick={() => updateApiConfig(undefined)}
                                    >
                                        <span>{inheritApiLabel}</span>
                                        {!currentSlot.apiConfigId ? <Check size={15} /> : null}
                                    </button>
                                    {apiConfigs.length === 0 ? (
                                        <div className="quick-action-empty">暂无 API 配置</div>
                                    ) : apiConfigs.map(api => (
                                        <div
                                            key={api.id}
                                            className="quick-action-swipe-wrapper"
                                            data-armed={swipeTrigger.isSwiping(`api:${api.id}`) ? "" : undefined}
                                            onPointerDown={(e) => swipeTrigger.onPointerDown(e, `api:${api.id}`)}
                                            onPointerMove={swipeTrigger.onPointerMove}
                                            onPointerUp={swipeTrigger.onPointerEnd}
                                            onPointerCancel={swipeTrigger.onPointerEnd}
                                        >
                                            <div className="quick-action-swipe-bg">
                                                <Pencil size={13} strokeWidth={2.2} />
                                                <span>编辑</span>
                                            </div>
                                            <div
                                                className="quick-action-swipe-content quick-action-option"
                                                data-selected={currentSlot.apiConfigId === api.id}
                                                onClick={() => {
                                                    if (swipeTrigger.consumeClickSuppression()) return;
                                                    updateApiConfig(api.id);
                                                }}
                                            >
                                                <span className="truncate flex-1">{api.name || api.defaultModel || api.provider}</span>
                                                {currentSlot.apiConfigId === api.id ? <Check size={15} /> : null}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : null}
                        </section>

                        <section
                            className="quick-action-section"
                            data-disabled={characterDisabled ? "" : undefined}
                            data-section="preset"
                            style={{ order: sectionOrderIndex("preset") }}
                        >
                            <div
                                className="quick-action-section-heading cursor-pointer select-none"
                                onClick={() => {
                                    if (!sectionSort.shouldAllowClick()) return;
                                    setCollapsedSections(prev => ({ ...prev, preset: !prev.preset }));
                                }}
                                {...sectionDragHandlers}
                            >
                                <span><Fingerprint size={16} />预设 ({presets.length})</span>
                                <div className="flex items-center gap-1.5 shrink-0">
                                    <button
                                        type="button"
                                        className="quick-action-heading-btn"
                                        title="进入预设管理"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            navigateToSettings("presets");
                                        }}
                                    >
                                        <Pencil size={12} />
                                    </button>
                                    <small className="max-w-[80px] truncate">{currentSlot.presetId ? itemName(presets, currentSlot.presetId) : (scope === "global" ? "默认预设" : "继承")}</small>
                                    <ChevronDown size={14} className="transition-transform duration-200" style={{ transform: collapsedSections.preset ? "rotate(-90deg)" : "rotate(0deg)" }} />
                                </div>
                            </div>
                            {!collapsedSections.preset ? (
                                <div className="quick-action-option-list mt-1">
                                    <button
                                        type="button"
                                        className="quick-action-option"
                                        data-selected={!currentSlot.presetId}
                                        disabled={characterDisabled}
                                        onClick={() => updatePreset(undefined)}
                                    >
                                        <span>{inheritPresetLabel}</span>
                                        {!currentSlot.presetId ? <Check size={15} /> : null}
                                    </button>
                                    {presets.length === 0 ? (
                                        <div className="quick-action-empty">暂无预设</div>
                                    ) : presets.map(p => (
                                        <div
                                            key={p.id}
                                            className="quick-action-swipe-wrapper"
                                            data-armed={swipeTrigger.isSwiping(`preset:${p.id}`) ? "" : undefined}
                                            onPointerDown={(e) => swipeTrigger.onPointerDown(e, `preset:${p.id}`)}
                                            onPointerMove={swipeTrigger.onPointerMove}
                                            onPointerUp={swipeTrigger.onPointerEnd}
                                            onPointerCancel={swipeTrigger.onPointerEnd}
                                        >
                                            <div className="quick-action-swipe-bg">
                                                <Pencil size={13} strokeWidth={2.2} />
                                                <span>编辑</span>
                                            </div>
                                            <div
                                                className="quick-action-swipe-content quick-action-option"
                                                data-selected={currentSlot.presetId === p.id}
                                                onClick={() => {
                                                    if (swipeTrigger.consumeClickSuppression()) return;
                                                    updatePreset(p.id);
                                                }}
                                            >
                                                <span className="truncate flex-1">{p.name}</span>
                                                {currentSlot.presetId === p.id ? <Check size={15} /> : null}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : null}
                        </section>

                        <section
                            className="quick-action-section"
                            data-disabled={characterDisabled ? "" : undefined}
                            data-section="worldbook"
                            style={{ order: sectionOrderIndex("worldbook") }}
                        >
                            <div
                                className="quick-action-section-heading cursor-pointer select-none"
                                onClick={() => {
                                    if (!sectionSort.shouldAllowClick()) return;
                                    setCollapsedSections(prev => ({ ...prev, worldbook: !prev.worldbook }));
                                }}
                                {...sectionDragHandlers}
                            >
                                <span><BookOpen size={16} />世界书 ({worldBooks.length})</span>
                                <div className="flex items-center gap-1.5 shrink-0">
                                    <button
                                        type="button"
                                        className="quick-action-heading-btn"
                                        title="进入世界书管理"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            navigateToSettings("worldbook");
                                        }}
                                    >
                                        <Pencil size={12} />
                                    </button>
                                    <button
                                        type="button"
                                        className="quick-action-clear-btn"
                                        disabled={characterDisabled || selectedWorldBookIds.length === 0}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            updateWorldBooks([]);
                                        }}
                                    >
                                        清空
                                    </button>
                                    <ChevronDown size={14} className="transition-transform duration-200" style={{ transform: collapsedSections.worldbook ? "rotate(-90deg)" : "rotate(0deg)" }} />
                                </div>
                            </div>
                            {!collapsedSections.worldbook ? (
                                <div className="mt-1 flex flex-col gap-2">
                                    <button
                                        type="button"
                                        className="quick-action-option quick-action-inherit-option"
                                        data-selected={selectedWorldBookIds.length === 0}
                                        disabled={characterDisabled}
                                        onClick={() => updateWorldBooks([])}
                                    >
                                        <span className="truncate">{selectedWorldBookIds.length === 0 ? inheritWorldBookLabel : selectedWorldBookNames.join("、")}</span>
                                        {selectedWorldBookIds.length === 0 ? <Check size={15} /> : null}
                                    </button>
                                    {worldBooks.length === 0 ? (
                                        <div className="quick-action-empty">暂无世界书</div>
                                    ) : (
                                        <div className="quick-action-chip-grid">
                                            {worldBooks.map(book => {
                                                const selected = selectedWorldBookIds.includes(book.id);
                                                return (
                                                    <div
                                                        key={book.id}
                                                        className="quick-action-chip group flex items-center gap-1.5 cursor-pointer"
                                                        data-selected={selected}
                                                        onClick={() => toggleWorldBook(book.id)}
                                                    >
                                                        <span className="truncate">{book.name}</span>
                                                        {selected ? <Check size={14} /> : null}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            ) : null}
                        </section>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
