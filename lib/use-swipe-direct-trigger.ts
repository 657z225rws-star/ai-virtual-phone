import { useRef, useState, useCallback } from "react";

/**
 * Swipe to trigger direct action hook (e.g. left swipe to auto-trigger edit).
 * When dragged left beyond threshold (e.g. 50px or velocity), it triggers onTrigger(id).
 */

interface SwipeDirectGesture {
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    locked: boolean;
    offset: number;
}

export function useSwipeDirectTrigger(
    onTrigger: (id: string) => void,
    threshold = 55,
) {
    const gestureRef = useRef<SwipeDirectGesture | null>(null);
    const suppressClickRef = useRef(false);
    const [swipingId, setSwipingId] = useState<string | null>(null);

    const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>, id: string) => {
        suppressClickRef.current = false;
        gestureRef.current = {
            id,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            locked: false,
            offset: 0,
        };
    }, []);

    const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        const g = gestureRef.current;
        if (!g || g.pointerId !== e.pointerId) return;

        const dx = e.clientX - g.startX;
        const dy = e.clientY - g.startY;

        if (!g.locked) {
            // Cancel swipe if movement is primarily vertical
            if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
                gestureRef.current = null;
                return;
            }
            // Only lock when swiping left with significant horizontal intent
            if (dx < -8 && Math.abs(dx) > Math.abs(dy)) {
                g.locked = true;
                setSwipingId(g.id);
                try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                } catch (_) {}
            } else if (dx > 8) {
                gestureRef.current = null;
                return;
            }
        }

        if (g.locked) {
            if (e.cancelable) e.preventDefault();
            const content = e.currentTarget.querySelector(":scope > .quick-action-swipe-content") as HTMLElement | null;
            if (!content) return;
            // Only allow dragging left, with dampening beyond threshold
            const rawOffset = Math.min(0, dx);
            const clampedOffset = rawOffset < -threshold
                ? -threshold - Math.pow(Math.abs(rawOffset) - threshold, 0.7)
                : rawOffset;
            g.offset = clampedOffset;
            content.style.transition = "none";
            content.style.transform = `translate3d(${clampedOffset}px, 0, 0)`;
        }
    }, [threshold]);

    const onPointerEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        const g = gestureRef.current;
        if (!g || g.pointerId !== e.pointerId) return;
        gestureRef.current = null;

        if (!g.locked) return;
        suppressClickRef.current = true;

        const content = e.currentTarget.querySelector(":scope > .quick-action-swipe-content") as HTMLElement | null;
        const shouldTrigger = g.offset <= -threshold;
        const targetId = g.id;

        if (content) {
            content.style.transition = "transform 0.22s cubic-bezier(0.2, 0, 0, 1)";
            content.style.transform = "translate3d(0, 0, 0)";
        }

        setSwipingId(null);

        if (shouldTrigger) {
            if (typeof navigator !== "undefined" && navigator.vibrate) {
                try { navigator.vibrate(20); } catch (_) {}
            }
            onTrigger(targetId);
        }
    }, [onTrigger, threshold]);

    const consumeClickSuppression = useCallback(() => {
        if (!suppressClickRef.current) return false;
        suppressClickRef.current = false;
        return true;
    }, []);

    return {
        onPointerDown,
        onPointerMove,
        onPointerEnd,
        consumeClickSuppression,
        isSwiping: (id: string) => swipingId === id,
    };
}
