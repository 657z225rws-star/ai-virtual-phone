// components/music/music-float.tsx — Floating music control widget (draggable vinyl)
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMusicControlsOptional } from "@/lib/music-context";

const DRAG_START_THRESHOLD = 6;
const SWIPE_DISMISS_EDGE_X = 4;
const SWIPE_DISMISS_SPEED = 1.5; // px/ms
const SWIPE_DISMISS_ARMING_X = 88;
const SWIPE_INERTIA_MS = 140;
const SWIPE_VELOCITY_RECENT_MS = 180;
// 与 music.css 中 .music-float / [data-expanded] 的尺寸保持一致
const COLLAPSED_W = 72;
const COLLAPSED_H = 72;
const EXPANDED_W = 260;
const EXPANDED_H = 84;

export default function MusicFloat({ hidden }: { hidden?: boolean }) {
    const player = useMusicControlsOptional();
    const floatRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ x: 310, y: 680 });
    const dragRef = useRef<{
        pointerId: number | null; active: boolean;
        startX: number; startY: number; origX: number; origY: number;
        lastX: number; lastTime: number;
        lastLeftSpeed: number; lastLeftSpeedTime: number;
        moved: boolean; startedOnInfo: boolean; dragging: boolean;
    }>({
        pointerId: null,
        active: false,
        startX: 0,
        startY: 0,
        origX: 0,
        origY: 0,
        lastX: 0,
        lastTime: 0,
        lastLeftSpeed: 0,
        lastLeftSpeedTime: 0,
        moved: false,
        startedOnInfo: false,
        dragging: false,
    });
    const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [expanded, setExpanded] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [dismissing, setDismissing] = useState(false);

    const clampPos = useCallback((x: number, y: number) => {
        const el = floatRef.current;
        const parent = el?.closest("[data-ui='phone-screen']") as HTMLElement | null;
        if (!el || !parent) return { x, y };
        const pw = parent.clientWidth;
        const ph = parent.clientHeight;
        const ew = el.offsetWidth;
        const eh = el.offsetHeight;
        return {
            x: Math.max(0, Math.min(x, pw - ew)),
            y: Math.max(0, Math.min(y, ph - eh)),
        };
    }, []);

    // 展开/收起按悬浮球所在半屏对齐：左半屏左对齐（朝右生长）、右半屏右对齐（朝左生长），
    // 保证卡片始终完整留在屏幕内，不会超出屏幕。
    const toggleExpanded = useCallback(() => {
        setExpanded(prev => {
            const next = !prev;
            setPos(p => {
                const el = floatRef.current;
                const parent = el?.closest("[data-ui='phone-screen']") as HTMLElement | null;
                if (!el || !parent) return p;
                const pw = parent.clientWidth;
                const ph = parent.clientHeight;
                const curW = prev ? EXPANDED_W : COLLAPSED_W;
                const nextW = next ? EXPANDED_W : COLLAPSED_W;
                const nextH = next ? EXPANDED_H : COLLAPSED_H;
                const alignLeft = p.x + curW / 2 < pw / 2;
                const nx = alignLeft
                    ? Math.max(0, Math.min(p.x, pw - nextW))
                    : Math.max(0, Math.min(p.x + curW - nextW, pw - nextW));
                const ny = Math.max(0, Math.min(p.y, ph - nextH));
                return { x: nx, y: ny };
            });
            return next;
        });
    }, []);

    const collapseExpanded = useCallback(() => {
        setExpanded(prev => {
            if (!prev) return prev;
            setPos(p => {
                const el = floatRef.current;
                const parent = el?.closest("[data-ui='phone-screen']") as HTMLElement | null;
                if (!el || !parent) return p;
                const pw = parent.clientWidth;
                const ph = parent.clientHeight;
                const curW = EXPANDED_W;
                const nextW = COLLAPSED_W;
                const nextH = COLLAPSED_H;
                const alignLeft = p.x + curW / 2 < pw / 2;
                const nx = alignLeft
                    ? Math.max(0, Math.min(p.x, pw - nextW))
                    : Math.max(0, Math.min(p.x + curW - nextW, pw - nextW));
                const ny = Math.max(0, Math.min(p.y, ph - nextH));
                return { x: nx, y: ny };
            });
            return false;
        });
    }, []);

    // 展开状态下点击任意空白处也能收起：在 document 捕获阶段监听 pointerdown，
    // 落点不在悬浮球内部就收起。悬浮球自身的点击不经过这里，走原有的 toggle 逻辑。
    useEffect(() => {
        if (!expanded) return;
        const onDocPointerDown = (e: PointerEvent) => {
            const el = floatRef.current;
            if (!el) return;
            const target = e.target as Node | null;
            if (target && el.contains(target)) return;
            collapseExpanded();
        };
        document.addEventListener("pointerdown", onDocPointerDown, true);
        return () => document.removeEventListener("pointerdown", onDocPointerDown, true);
    }, [expanded, collapseExpanded]);

    const dismissFloat = useCallback(() => {
        if (!player) return;
        if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
        setDismissing(true);
        dismissTimerRef.current = setTimeout(() => {
            player.dismissFloat();
            setDismissing(false);
            setExpanded(false);
            dismissTimerRef.current = null;
        }, 250);
    }, [player]);

    useEffect(() => () => {
        if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    }, []);

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        const target = e.target as HTMLElement;
        // Let transport buttons keep their native click behavior.
        if (target.closest("button")) return;
        e.preventDefault();
        e.stopPropagation();
        floatRef.current?.setPointerCapture?.(e.pointerId);
        const now = performance.now();
        dragRef.current = {
            pointerId: e.pointerId,
            active: true,
            startX: e.clientX, startY: e.clientY,
            origX: pos.x, origY: pos.y,
            lastX: e.clientX,
            lastTime: now,
            lastLeftSpeed: 0,
            lastLeftSpeedTime: 0,
            moved: false,
            startedOnInfo: Boolean(target.closest(".music-float-info")),
            dragging: false,
        };
    }, [pos]);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        const d = dragRef.current;
        if (!d.active || d.pointerId !== e.pointerId) return;
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (Math.abs(dx) > DRAG_START_THRESHOLD || Math.abs(dy) > DRAG_START_THRESHOLD) d.moved = true;
        if (d.moved) {
            if (!d.dragging) { d.dragging = true; setDragging(true); }
            const nextPos = clampPos(d.origX + dx, d.origY + dy);
            const now = performance.now();
            const dt = Math.max(1, now - d.lastTime);
            const stepDx = e.clientX - d.lastX;
            const leftSpeed = stepDx < 0 ? Math.abs(stepDx) / dt : 0;
            if (leftSpeed > 0) {
                d.lastLeftSpeed = leftSpeed;
                d.lastLeftSpeedTime = now;
            }
            d.lastX = e.clientX;
            d.lastTime = now;
            setPos(nextPos);
        }
    }, [clampPos]);

    const finishPointer = useCallback((e: React.PointerEvent) => {
        const d = dragRef.current;
        if (!d.active || d.pointerId !== e.pointerId) return;
        if (floatRef.current?.hasPointerCapture?.(e.pointerId)) {
            floatRef.current.releasePointerCapture(e.pointerId);
        }
        d.active = false;
        d.pointerId = null;
        if (d.dragging) { d.dragging = false; setDragging(false); }
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        const finalPos = clampPos(d.origX + dx, d.origY + dy);
        const now = performance.now();
        const dt = Math.max(1, now - d.lastTime);
        const stepDx = e.clientX - d.lastX;
        const leftSpeed = stepDx < 0 ? Math.abs(stepDx) / dt : 0;
        const recentMoveSpeed = now - d.lastLeftSpeedTime <= SWIPE_VELOCITY_RECENT_MS ? d.lastLeftSpeed : 0;
        const effectiveLeftSpeed = Math.max(leftSpeed, recentMoveSpeed);
        const inertialX = finalPos.x - effectiveLeftSpeed * SWIPE_INERTIA_MS;
        const shouldDismiss = d.moved
            && finalPos.x <= SWIPE_DISMISS_ARMING_X
            && effectiveLeftSpeed >= SWIPE_DISMISS_SPEED
            && inertialX <= SWIPE_DISMISS_EDGE_X;

        if (shouldDismiss) {
            dismissFloat();
            return;
        }

        if (d.moved) {
            setPos(finalPos);
            return;
        }

        if (!d.moved && player) {
            if (d.startedOnInfo) {
                player.openFullPlayer();
                return;
            }

            toggleExpanded();
        }
    }, [player, clampPos, dismissFloat, toggleExpanded]);

    const handlePointerUp = useCallback((e: React.PointerEvent) => finishPointer(e), [finishPointer]);
    const handlePointerCancel = useCallback((e: React.PointerEvent) => finishPointer(e), [finishPointer]);

    if (!player || !player.currentTrack || hidden || player.floatDismissed) return null;

    const track = player.currentTrack;

    return (
        <div
            ref={floatRef}
            className="music-float"
            {...(expanded ? { "data-expanded": "" } : {})}
            {...(dragging ? { "data-dragging": "" } : {})}
            {...(dismissing ? { "data-dismissing": "" } : {})}
            style={{ left: pos.x, top: pos.y }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
        >
            <div className="music-float-inner">
                {/* Cover art */}
                <div className="music-float-cover-wrap" {...(player.isPlaying ? { "data-playing": "" } : {})}>
                    <div className="music-float-vinyl-groove music-float-vinyl-groove-1" />
                    <div className="music-float-vinyl-groove music-float-vinyl-groove-2" />
                    <div className="music-float-vinyl-center">
                        {track.coverUrl ? (
                            <img src={track.coverUrl} alt="" className="music-float-cover-img" draggable={false} />
                        ) : (
                            <div className="music-float-cover-placeholder">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                    <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                                </svg>
                            </div>
                        )}
                    </div>
                </div>

                {/* Track Info */}
                <div className="music-float-info">
                    <div className="music-float-title">{track.title}</div>
                    <div className="music-float-artist">{track.artist}</div>
                </div>

                {/* Compact Controls */}
                <div className="music-float-controls">
                    <button className="music-float-btn" onClick={(e) => { e.stopPropagation(); player.prev(); }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
                        </svg>
                    </button>
                    <button className="music-float-btn music-float-btn-play" onClick={(e) => { e.stopPropagation(); player.togglePlay(); }}>
                        {player.isPlaying ? (
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M6 4h4v16H6zm8 0h4v16h-4z" />
                            </svg>
                        ) : (
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M8 5v14l11-7z" />
                            </svg>
                        )}
                    </button>
                    <button className="music-float-btn" onClick={(e) => { e.stopPropagation(); player.next(); }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M6 18l8.5-6L6 6v12zm8.5 0h2V6h-2v12z" />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    );
}
