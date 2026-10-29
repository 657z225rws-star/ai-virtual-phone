import { useRef, useCallback, useEffect } from "react";

/**
 * High-performance grid-aware drag-to-reorder hook.
 *
 * Features:
 * 1. Mobile touch: long-press (default 300ms) with vibration to trigger drag.
 * 2. Desktop mouse: immediate drag on left-button hold with move threshold (>4px) or long-press.
 * 3. Drag vs Click isolation: sets a suppressClick window so ending a drag never triggers onClick.
 * 4. 60fps GPU-accelerated transforms and RAF-throttled position updates.
 */

interface GridDragItem {
    left: number;
    top: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
    el: HTMLElement;
}

interface GridDragState {
    active: boolean;
    hasMoved: boolean;
    index: number;
    currentIndex: number;
    startX: number;
    startY: number;
    latestX: number;
    latestY: number;
    items: GridDragItem[];
    timer: ReturnType<typeof setTimeout> | null;
    autoScrollFrame: number | null;
    rafUpdateFrame: number | null;
    scrollLock: {
        el: HTMLElement;
        overflowY: string;
        touchAction: string;
        scrollTop: number;
    } | null;
    bodyOverflow: string;
    bodyTouchAction: string;
}

const INITIAL_GRID_STATE: GridDragState = {
    active: false,
    hasMoved: false,
    index: -1,
    currentIndex: -1,
    startX: 0,
    startY: 0,
    latestX: 0,
    latestY: 0,
    items: [],
    timer: null,
    autoScrollFrame: null,
    rafUpdateFrame: null,
    scrollLock: null,
    bodyOverflow: "",
    bodyTouchAction: "",
};

const AUTO_SCROLL_EDGE = 56;
const AUTO_SCROLL_MAX_STEP = 14;

export function useGridTouchSort(
    onReorder: (from: number, to: number) => void,
    longPressMs = 300,
) {
    const dragRef = useRef<GridDragState>({ ...INITIAL_GRID_STATE });
    const containerRef = useRef<HTMLDivElement>(null);
    const documentTouchMoveCleanupRef = useRef<(() => void) | null>(null);
    const suppressClickUntilRef = useRef<number>(0);

    const stopPreventingDocumentScroll = useCallback(() => {
        documentTouchMoveCleanupRef.current?.();
        documentTouchMoveCleanupRef.current = null;
    }, []);

    const startPreventingDocumentScroll = useCallback(() => {
        if (documentTouchMoveCleanupRef.current) return;

        const preventScrollDuringDrag = (event: TouchEvent) => {
            const d = dragRef.current;
            if (!d.active) return;
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
            el.style.position = "";
            el.style.pointerEvents = "";
            el.style.willChange = "";
        });
        if (d.scrollLock) {
            d.scrollLock.el.style.overflowY = d.scrollLock.overflowY;
            d.scrollLock.el.style.touchAction = d.scrollLock.touchAction;
            d.scrollLock = null;
        }
        document.body.style.overflow = d.bodyOverflow;
        document.body.style.touchAction = d.bodyTouchAction;
        stopPreventingDocumentScroll();
        d.active = false;
        d.hasMoved = false;
        d.items = [];
    }, [stopPreventingDocumentScroll]);

    const lockScroll = useCallback((container: HTMLElement) => {
        const d = dragRef.current;
        const scrollEl = (
            container.closest(".page-body") ||
            container.closest(".modal-body") ||
            document.scrollingElement ||
            document.documentElement
        ) as HTMLElement;

        d.scrollLock = {
            el: scrollEl,
            overflowY: scrollEl.style.overflowY,
            touchAction: scrollEl.style.touchAction,
            scrollTop: scrollEl.scrollTop,
        };
        d.bodyOverflow = document.body.style.overflow;
        d.bodyTouchAction = document.body.style.touchAction;

        scrollEl.style.touchAction = "none";
        document.body.style.touchAction = "none";
    }, []);

    const getScrollDelta = useCallback((d: GridDragState) => (
        d.scrollLock ? d.scrollLock.el.scrollTop - d.scrollLock.scrollTop : 0
    ), []);

    const performLayoutCalculation = useCallback((clientX: number, clientY: number) => {
        const d = dragRef.current;
        const dragged = d.items[d.index];
        if (!d.active || !dragged) return;

        const deltaX = clientX - d.startX;
        const deltaY = clientY - d.startY;
        const scrollDelta = getScrollDelta(d);

        // Move dragged item smoothly with GPU translate3d
        dragged.el.style.transition = "box-shadow 150ms";
        dragged.el.style.transform = `translate3d(${deltaX}px, ${deltaY + scrollDelta}px, 0) scale(1.05)`;

        // Calculate current center of dragged item in page coordinates
        const currentCenterX = dragged.centerX + deltaX;
        const currentCenterY = dragged.centerY + deltaY + scrollDelta;

        // Find closest target slot by Euclidean distance between centers
        let closestIndex = d.index;
        let minDistanceSq = Infinity;

        for (let i = 0; i < d.items.length; i++) {
            const target = d.items[i];
            const dx = currentCenterX - target.centerX;
            const dy = currentCenterY - target.centerY;
            const distSq = dx * dx + dy * dy;

            if (distSq < minDistanceSq) {
                minDistanceSq = distSq;
                closestIndex = i;
            }
        }

        // Shift non-dragged items according to reorder permutation
        for (let i = 0; i < d.items.length; i++) {
            if (i === d.index) continue;
            const el = d.items[i].el;
            el.style.transition = "transform 200ms cubic-bezier(0.2, 0, 0, 1)";

            let targetSlotIndex = i;
            if (d.index < closestIndex) {
                if (i > d.index && i <= closestIndex) {
                    targetSlotIndex = i - 1;
                }
            } else if (d.index > closestIndex) {
                if (i >= closestIndex && i < d.index) {
                    targetSlotIndex = i + 1;
                }
            }

            if (targetSlotIndex !== i) {
                const origPos = d.items[i];
                const destPos = d.items[targetSlotIndex];
                const tx = destPos.left - origPos.left;
                const ty = destPos.top - origPos.top;
                el.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
            } else {
                el.style.transform = "";
            }
        }

        d.currentIndex = closestIndex;
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

    const getScrollViewport = useCallback((el: HTMLElement) => {
        if (el === document.scrollingElement || el === document.documentElement || el === document.body) {
            return { top: 0, bottom: window.innerHeight };
        }
        const rect = el.getBoundingClientRect();
        const header = el.closest(".page-shell")?.querySelector(".page-header");
        const headerBottom = header instanceof HTMLElement ? header.getBoundingClientRect().bottom : rect.top;
        return { top: Math.max(rect.top, headerBottom - AUTO_SCROLL_EDGE), bottom: rect.bottom };
    }, []);

    const startAutoScroll = useCallback(() => {
        const step = () => {
            const d = dragRef.current;
            const lock = d.scrollLock;
            if (!d.active || !lock) {
                d.autoScrollFrame = null;
                return;
            }

            const { top, bottom } = getScrollViewport(lock.el);
            const distanceToTop = d.latestY - top;
            const distanceToBottom = bottom - d.latestY;
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
    }, [queueDragUpdate, getScrollViewport]);

    const finishDrag = useCallback(() => {
        const d = dragRef.current;
        if (d.timer) {
            clearTimeout(d.timer);
            d.timer = null;
        }

        const wasActive = d.active;
        const hasMoved = d.hasMoved;
        const from = d.index;
        const to = d.currentIndex;

        if (wasActive && hasMoved) {
            // Block click event triggered right after mouseup / touchend
            suppressClickUntilRef.current = Date.now() + 400;
        }

        cleanup();

        if (wasActive && from >= 0 && to >= 0 && from !== to) {
            onReorder(from, to);
        }
    }, [onReorder, cleanup]);

    useEffect(() => {
        const handleEnd = () => finishDrag();

        window.addEventListener("touchend", handleEnd);
        window.addEventListener("touchcancel", handleEnd);
        window.addEventListener("mouseup", handleEnd);
        return () => {
            window.removeEventListener("touchend", handleEnd);
            window.removeEventListener("touchcancel", handleEnd);
            window.removeEventListener("mouseup", handleEnd);
            stopPreventingDocumentScroll();
        };
    }, [finishDrag, stopPreventingDocumentScroll]);

    const beginDrag = useCallback((index: number) => {
        const d = dragRef.current;
        const container = containerRef.current;
        if (!container) return;

        d.active = true;
        const children = Array.from(container.children) as HTMLElement[];
        if (index < 0 || index >= children.length) return;

        d.items = children.map(el => {
            const rect = el.getBoundingClientRect();
            el.style.willChange = "transform";
            return {
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                centerX: rect.left + rect.width / 2,
                centerY: rect.top + rect.height / 2,
                el,
            };
        });

        const el = children[index];
        el.style.zIndex = "100";
        el.style.transition = "box-shadow 200ms, transform 150ms";
        el.style.transform = "scale(1.05)";
        el.style.boxShadow = "0 12px 32px rgba(0,0,0,0.3)";
        el.style.position = "relative";

        lockScroll(container);
        startPreventingDocumentScroll();
        startAutoScroll();

        if (typeof navigator !== "undefined" && navigator.vibrate) {
            try {
                navigator.vibrate(30);
            } catch (_) {}
        }
    }, [lockScroll, startAutoScroll, startPreventingDocumentScroll]);

    // Touch event handlers (Mobile)
    const onTouchStart = useCallback((index: number, e: React.TouchEvent) => {
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

        d.timer = setTimeout(() => beginDrag(index), longPressMs);
    }, [longPressMs, beginDrag]);

    const onTouchMove = useCallback((e: React.TouchEvent) => {
        const d = dragRef.current;
        const touch = e.touches[0];

        const dx = Math.abs(touch.clientX - d.startX);
        const dy = Math.abs(touch.clientY - d.startY);

        if (!d.active) {
            // Cancel long-press if finger moved before time threshold
            if ((dx > 8 || dy > 8) && d.timer) {
                clearTimeout(d.timer);
                d.timer = null;
            }
            return;
        }

        if (dx > 4 || dy > 4) {
            d.hasMoved = true;
        }

        if (e.cancelable) e.preventDefault();
        queueDragUpdate(touch.clientX, touch.clientY);
    }, [queueDragUpdate]);

    const onTouchEnd = useCallback(() => finishDrag(), [finishDrag]);

    // Mouse event handlers (Desktop)
    const onMouseDown = useCallback((index: number, e: React.MouseEvent) => {
        if (e.button !== 0) return; // Only primary left-click
        const target = e.target as HTMLElement;
        // Don't drag if clicking buttons or actions inside the card
        if (target.closest("button") || target.closest("a") || target.closest("input")) return;

        const d = dragRef.current;
        if (d.timer) clearTimeout(d.timer);

        d.startX = e.clientX;
        d.startY = e.clientY;
        d.latestX = e.clientX;
        d.latestY = e.clientY;
        d.index = index;
        d.currentIndex = index;
        d.hasMoved = false;

        // Desktop mouse: short timer (120ms) or move threshold to distinguish click vs drag
        d.timer = setTimeout(() => beginDrag(index), 150);
    }, [beginDrag]);

    const onMouseMove = useCallback((e: React.MouseEvent) => {
        const d = dragRef.current;
        const dx = Math.abs(e.clientX - d.startX);
        const dy = Math.abs(e.clientY - d.startY);

        if (!d.active) {
            // If moved > 5px while mouse button held, immediately begin drag
            if (e.buttons === 1 && (dx > 5 || dy > 5) && d.index >= 0) {
                if (d.timer) {
                    clearTimeout(d.timer);
                    d.timer = null;
                }
                beginDrag(d.index);
            }
            return;
        }

        if (dx > 3 || dy > 3) {
            d.hasMoved = true;
        }

        e.preventDefault();
        queueDragUpdate(e.clientX, e.clientY);
    }, [beginDrag, queueDragUpdate]);

    const onMouseUp = useCallback(() => finishDrag(), [finishDrag]);

    const shouldAllowClick = useCallback(() => {
        return Date.now() > suppressClickUntilRef.current;
    }, []);

    return {
        containerRef,
        onTouchStart,
        onTouchMove,
        onTouchEnd,
        onMouseDown,
        onMouseMove,
        onMouseUp,
        shouldAllowClick,
    };
}
