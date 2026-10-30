import { useRef, useCallback, useEffect, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from "react";

/**
 * Vertical drag-to-reorder hook for stacked sections (long-press on section heading).
 * Mechanics cloned from use-grid-touch-sort.ts, adapted for Y-only slot shifting:
 * 1. Mobile touch: long-press (300ms) triggers drag; finger scroll is locked during drag.
 * 2. Desktop mouse: drag starts after >5px move while button held (or 150ms hold).
 * 3. Drag vs click isolation: suppressClick window so ending a drag never triggers heading onClick.
 * 4. RAF-throttled 60fps GPU transforms; other sections shift ± the dragged section's height.
 *
 * Move tracking is done at WINDOW level (not element level): a 30px-tall heading loses
 * element mousemove events as soon as the pointer leaves it, which would freeze the drag.
 * Touch events fire on the original target so window bubbling covers both.
 */

interface SectionDragItem {
    top: number;
    left: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
    el: HTMLElement;
    id: string;
}

interface SectionDragState {
    active: boolean;
    hasMoved: boolean;
    index: number;
    currentIndex: number;
    /** 拖动中心当前是否落在目标槽位的下半侧（决定插到目标前还是后） */
    insertAfter: boolean;
    startX: number;
    startY: number;
    latestX: number;
    latestY: number;
    items: SectionDragItem[];
    timer: ReturnType<typeof setTimeout> | null;
    autoScrollFrame: number | null;
    rafUpdateFrame: number | null;
    scrollLock: {
        el: HTMLElement;
        touchAction: string;
        scrollTop: number;
    } | null;
}

const INITIAL_STATE: SectionDragState = {
    active: false,
    hasMoved: false,
    index: -1,
    currentIndex: -1,
    insertAfter: false,
    startX: 0,
    startY: 0,
    latestX: 0,
    latestY: 0,
    items: [],
    timer: null,
    autoScrollFrame: null,
    rafUpdateFrame: null,
    scrollLock: null,
};

const AUTO_SCROLL_EDGE = 48;
const AUTO_SCROLL_MAX_STEP = 12;

export function useQuickSectionSort(
    onReorder: (draggedId: string, targetId: string, insertAfter: boolean) => void,
) {
    const dragRef = useRef<SectionDragState>({ ...INITIAL_STATE });
    const containerRef = useRef<HTMLDivElement>(null);
    const documentTouchMoveCleanupRef = useRef<(() => void) | null>(null);
    const suppressClickUntilRef = useRef(0);
    const windowListenersRef = useRef<{ moveMouse: EventListener; moveTouch: EventListener; end: EventListener } | null>(null);

    const stopPreventingDocumentScroll = useCallback(() => {
        documentTouchMoveCleanupRef.current?.();
        documentTouchMoveCleanupRef.current = null;
    }, []);

    const startPreventingDocumentScroll = useCallback(() => {
        if (documentTouchMoveCleanupRef.current) return;
        const preventScrollDuringDrag = (event: TouchEvent) => {
            if (!dragRef.current.active) return;
            if (event.cancelable) event.preventDefault();
        };
        document.addEventListener("touchmove", preventScrollDuringDrag, { passive: false });
        documentTouchMoveCleanupRef.current = () => {
            document.removeEventListener("touchmove", preventScrollDuringDrag);
        };
    }, []);

    const cleanup = useCallback(() => {
        const d = dragRef.current;
        if (d.timer) {
            clearTimeout(d.timer);
            d.timer = null;
        }
        if (d.autoScrollFrame !== null) {
            cancelAnimationFrame(d.autoScrollFrame);
            d.autoScrollFrame = null;
        }
        if (d.rafUpdateFrame !== null) {
            cancelAnimationFrame(d.rafUpdateFrame);
            d.rafUpdateFrame = null;
        }
        d.items.forEach(({ el }) => {
            el.style.transition = "";
            el.style.transform = "";
            el.style.zIndex = "";
            el.style.boxShadow = "";
            el.style.willChange = "";
        });
        if (d.scrollLock) {
            d.scrollLock.el.style.touchAction = d.scrollLock.touchAction;
            d.scrollLock = null;
        }
        stopPreventingDocumentScroll();
        d.active = false;
        d.hasMoved = false;
        d.insertAfter = false;
        d.items = [];
    }, [stopPreventingDocumentScroll]);

    const lockScroll = useCallback((container: HTMLElement) => {
        const d = dragRef.current;
        const scrollEl = (container.closest(".quick-action-body") ||
            document.scrollingElement ||
            document.documentElement) as HTMLElement;
        d.scrollLock = {
            el: scrollEl,
            touchAction: scrollEl.style.touchAction,
            scrollTop: scrollEl.scrollTop,
        };
        scrollEl.style.touchAction = "none";
    }, []);

    const getScrollDelta = useCallback((d: SectionDragState) => (
        d.scrollLock ? d.scrollLock.el.scrollTop - d.scrollLock.scrollTop : 0
    ), []);

    const performLayoutCalculation = useCallback((clientX: number, clientY: number) => {
        const d = dragRef.current;
        const dragged = d.items[d.index];
        if (!d.active || !dragged) return;

        const deltaY = clientY - d.startY;
        const scrollDelta = getScrollDelta(d);

        // Move dragged section with GPU translate; X stays put (vertical slot reorder)
        dragged.el.style.transition = "box-shadow 150ms";
        dragged.el.style.transform = `translate3d(0, ${deltaY + scrollDelta}px, 0) scale(1.02)`;

        const currentCenterX = dragged.centerX;
        const currentCenterY = dragged.centerY + deltaY + scrollDelta;

        // Find closest target slot (Y distance decides)
        let closestIndex = d.index;
        let minDistance = Infinity;
        for (let i = 0; i < d.items.length; i++) {
            const target = d.items[i];
            const dy = Math.abs(currentCenterY - target.centerY);
            if (dy < minDistance) {
                minDistance = dy;
                closestIndex = i;
            }
        }

        // Shift non-dragged sections according to slot permutation
        for (let i = 0; i < d.items.length; i++) {
            if (i === d.index) continue;
            const el = d.items[i].el;
            el.style.transition = "transform 200ms cubic-bezier(0.2, 0, 0, 1)";

            let targetSlotIndex = i;
            if (d.index < closestIndex) {
                if (i > d.index && i <= closestIndex) targetSlotIndex = i - 1;
            } else if (d.index > closestIndex) {
                if (i >= closestIndex && i < d.index) targetSlotIndex = i + 1;
            }

            if (targetSlotIndex !== i) {
                const orig = d.items[i];
                const dest = d.items[targetSlotIndex];
                el.style.transform = `translate3d(0, ${dest.top - orig.top}px, 0)`;
            } else {
                el.style.transform = "";
            }
        }

        d.currentIndex = closestIndex;
        d.insertAfter = closestIndex !== d.index
            ? currentCenterY >= d.items[closestIndex].centerY
            : false;
    }, [getScrollDelta]);

    const queueDragUpdate = useCallback((clientX: number, clientY: number) => {
        const d = dragRef.current;
        d.latestX = clientX;
        d.latestY = clientY;
        if (d.rafUpdateFrame === null) {
            d.rafUpdateFrame = requestAnimationFrame(() => {
                d.rafUpdateFrame = null;
                performLayoutCalculation(d.latestX, d.latestY);
            });
        }
    }, [performLayoutCalculation]);

    const startAutoScroll = useCallback(() => {
        const step = () => {
            const d = dragRef.current;
            const lock = d.scrollLock;
            if (!d.active || !lock) {
                d.autoScrollFrame = null;
                return;
            }
            const rect = lock.el.getBoundingClientRect();
            const distanceToTop = d.latestY - rect.top;
            const distanceToBottom = rect.bottom - d.latestY;
            let scrollStep = 0;
            if (distanceToTop < AUTO_SCROLL_EDGE) {
                const ratio = Math.max(0, Math.min(1, 1 - distanceToTop / AUTO_SCROLL_EDGE));
                scrollStep = -Math.ceil(ratio * AUTO_SCROLL_MAX_STEP);
            } else if (distanceToBottom < AUTO_SCROLL_EDGE) {
                const ratio = Math.max(0, Math.min(1, 1 - distanceToBottom / AUTO_SCROLL_EDGE));
                scrollStep = Math.ceil(ratio * AUTO_SCROLL_MAX_STEP);
            }
            if (scrollStep !== 0) {
                const maxScroll = lock.el.scrollHeight - lock.el.clientHeight;
                const nextScrollTop = Math.max(0, Math.min(maxScroll, lock.el.scrollTop + scrollStep));
                if (nextScrollTop !== lock.el.scrollTop) {
                    lock.el.scrollTop = nextScrollTop;
                    queueDragUpdate(d.latestX, d.latestY);
                }
            }
            d.autoScrollFrame = requestAnimationFrame(step);
        };
        const d = dragRef.current;
        if (d.autoScrollFrame === null) d.autoScrollFrame = requestAnimationFrame(step);
    }, [queueDragUpdate]);

    const detachWindowListeners = useCallback(() => {
        const listeners = windowListenersRef.current;
        if (!listeners) return;
        window.removeEventListener("mousemove", listeners.moveMouse);
        window.removeEventListener("mouseup", listeners.end);
        window.removeEventListener("touchmove", listeners.moveTouch);
        window.removeEventListener("touchend", listeners.end);
        window.removeEventListener("touchcancel", listeners.end);
        windowListenersRef.current = null;
    }, []);

    const finishDrag = useCallback(() => {
        const d = dragRef.current;
        if (d.timer) {
            clearTimeout(d.timer);
            d.timer = null;
        }
        const wasActive = d.active;
        const hasMoved = d.hasMoved;
        const draggedId = d.items[d.index]?.id ?? null;
        const targetId = d.items[d.currentIndex]?.id ?? null;
        const insertAfter = d.insertAfter;

        detachWindowListeners();

        if (wasActive && hasMoved) {
            suppressClickUntilRef.current = Date.now() + 400;
        }

        cleanup();

        if (wasActive && draggedId && targetId && draggedId !== targetId) {
            onReorder(draggedId, targetId, insertAfter);
        }
    }, [onReorder, cleanup, detachWindowListeners]);

    const beginDrag = useCallback(() => {
        const d = dragRef.current;
        const container = containerRef.current;
        if (!container || d.index < 0) return;

        d.active = true;
        const children = Array.from(
            container.querySelectorAll(":scope > section.quick-action-section[data-section]")
        ) as HTMLElement[];
        d.items = children.map(el => {
            const rect = el.getBoundingClientRect();
            el.style.willChange = "transform";
            return {
                top: rect.top,
                left: rect.left,
                width: rect.width,
                height: rect.height,
                centerX: rect.left + rect.width / 2,
                centerY: rect.top + rect.height / 2,
                el,
                id: el.dataset.section || "",
            };
        });

        const el = children[d.index];
        if (!el) return;
        el.style.zIndex = "100";
        el.style.transition = "box-shadow 200ms, transform 150ms";
        el.style.transform = "scale(1.02)";
        el.style.boxShadow = "0 10px 26px rgba(0,0,0,0.22)";

        lockScroll(container);
        startPreventingDocumentScroll();
        startAutoScroll();

        if (typeof navigator !== "undefined" && navigator.vibrate) {
            try {
                navigator.vibrate(30);
            } catch (_) {}
        }
    }, [lockScroll, startAutoScroll, startPreventingDocumentScroll]);

    // ── Window-level move/end handlers（指针离开标题后仍持续跟踪）──
    const onWindowMouseMove = useCallback((e: MouseEvent) => {
        const d = dragRef.current;
        if (!d.active) {
            if (e.buttons === 1 && d.index >= 0) {
                const dx = Math.abs(e.clientX - d.startX);
                const dy = Math.abs(e.clientY - d.startY);
                if (dx > 5 || dy > 5) {
                    if (d.timer) {
                        clearTimeout(d.timer);
                        d.timer = null;
                    }
                    beginDrag();
                }
            }
            return;
        }
        const dx = Math.abs(e.clientX - d.startX);
        const dy = Math.abs(e.clientY - d.startY);
        if (dx > 3 || dy > 3) d.hasMoved = true;
        e.preventDefault();
        queueDragUpdate(e.clientX, e.clientY);
    }, [beginDrag, queueDragUpdate]);

    const onWindowTouchMove = useCallback((e: TouchEvent) => {
        const d = dragRef.current;
        const touch = e.touches[0];
        if (!touch) return;
        if (!d.active) {
            const dx = Math.abs(touch.clientX - d.startX);
            const dy = Math.abs(touch.clientY - d.startY);
            if ((dx > 8 || dy > 8) && d.timer) {
                clearTimeout(d.timer);
                d.timer = null;
                d.index = -1; // 长按前就滑动 → 取消本次排序意图
            }
            return;
        }
        const dx = Math.abs(touch.clientX - d.startX);
        const dy = Math.abs(touch.clientY - d.startY);
        if (dx > 4 || dy > 4) d.hasMoved = true;
        if (e.cancelable) e.preventDefault();
        queueDragUpdate(touch.clientX, touch.clientY);
    }, [queueDragUpdate]);

    const attachWindowListeners = useCallback(() => {
        if (windowListenersRef.current) return;
        const moveMouse = onWindowMouseMove as EventListener;
        const moveTouch = onWindowTouchMove as EventListener;
        const end = () => finishDrag();
        window.addEventListener("mousemove", moveMouse);
        window.addEventListener("mouseup", end);
        window.addEventListener("touchmove", moveTouch, { passive: false });
        window.addEventListener("touchend", end);
        window.addEventListener("touchcancel", end);
        windowListenersRef.current = { moveMouse, moveTouch, end };
    }, [onWindowMouseMove, onWindowTouchMove, finishDrag]);

    useEffect(() => {
        return () => {
            detachWindowListeners();
            stopPreventingDocumentScroll();
        };
    }, [detachWindowListeners, stopPreventingDocumentScroll]);

    // ── 起点：标题上的按下（长按 300ms 触发拖动，移动阈值可提前）──
    const onTouchStart = useCallback((e: ReactTouchEvent<HTMLElement>) => {
        const target = e.target as HTMLElement;
        if (target.closest("button") || target.closest("a") || target.closest("input")) return;
        const heading = (e.currentTarget as HTMLElement).closest("section.quick-action-section");
        if (!heading || !containerRef.current) return;
        const index = Array.from(
            containerRef.current.querySelectorAll(":scope > section.quick-action-section[data-section]")
        ).indexOf(heading);
        if (index < 0) return;

        const d = dragRef.current;
        if (d.timer) clearTimeout(d.timer);
        const touch = e.touches[0];
        d.startX = touch.clientX;
        d.startY = touch.clientY;
        d.latestX = touch.clientX;
        d.latestY = touch.clientY;
        d.index = index;
        d.currentIndex = index;
        d.hasMoved = false;
        d.timer = setTimeout(() => beginDrag(), 300);
        attachWindowListeners();
    }, [beginDrag, attachWindowListeners]);

    const onMouseDown = useCallback((e: ReactMouseEvent<HTMLElement>) => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement;
        if (target.closest("button") || target.closest("a") || target.closest("input")) return;
        const heading = (e.currentTarget as HTMLElement).closest("section.quick-action-section");
        if (!heading || !containerRef.current) return;
        const index = Array.from(
            containerRef.current.querySelectorAll(":scope > section.quick-action-section[data-section]")
        ).indexOf(heading);
        if (index < 0) return;

        const d = dragRef.current;
        if (d.timer) clearTimeout(d.timer);
        d.startX = e.clientX;
        d.startY = e.clientY;
        d.latestX = e.clientX;
        d.latestY = e.clientY;
        d.index = index;
        d.currentIndex = index;
        d.hasMoved = false;
        d.timer = setTimeout(() => beginDrag(), 150);
        attachWindowListeners();
    }, [beginDrag, attachWindowListeners]);

    const shouldAllowClick = useCallback(() => {
        return Date.now() > suppressClickUntilRef.current;
    }, []);

    return {
        containerRef,
        onTouchStart,
        onMouseDown,
        shouldAllowClick,
    };
}
