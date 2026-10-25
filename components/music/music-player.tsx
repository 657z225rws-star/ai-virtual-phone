// components/music/music-player.tsx — Full-screen immersive music player
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMusicPlayer, type PlayMode } from "@/lib/music-context";
import { pushMusicAction } from "@/lib/music-action-queue";
import { scrollElementWithinContainer } from "@/lib/dom-scroll";
import {
    getUserPlaylists, addTracksToPlaylist, removeTracksFromPlaylist, getNeteasePlayUrl,
    isNeteaseConfigured, recordTrackPlaylist, removeTrackPlaylistRecord, getTrackPlaylistId,
    type NeteasePlaylist,
} from "@/lib/music-service";

const PLAY_MODE_ICONS: Record<PlayMode, { svg: string; label: string }> = {
    sequence: {
        svg: `<path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
        label: "顺序播放",
    },
    shuffle: {
        svg: `<path d="M18 4l3 3-3 3M18 14l3 3-3 3M3 7h3a5 5 0 0 1 5 5 5 5 0 0 0 5 5h5M21 7h-5a5 5 0 0 0-3.16 1.13M3 17h3a5 5 0 0 0 3.16-1.13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
        label: "随机播放",
    },
    "repeat-one": {
        svg: `<path d="M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><text x="12" y="15" text-anchor="middle" fill="currentColor" font-size="8" font-weight="bold">1</text>`,
        label: "单曲循环",
    },
};

export default function MusicPlayer() {
    const player = useMusicPlayer();
    const progressRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [dragTime, setDragTime] = useState(0);
    const [showLyrics, setShowLyrics] = useState(false);
    const [showQueue, setShowQueue] = useState(false);
    const [musicToast, setMusicToast] = useState<string | null>(null);
    const [pendingPlayTrackId, setPendingPlayTrackId] = useState<string | null>(null);
    const musicToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const musicLoadingFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const currentTime = isDragging ? dragTime : player.currentTime;
    const progress = player.duration > 0 ? currentTime / player.duration : 0;

    const formatTime = (s: number) => {
        if (!s || !isFinite(s)) return "0:00";
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${sec.toString().padStart(2, "0")}`;
    };

    const clearMusicToast = useCallback(() => {
        if (musicToastTimerRef.current) clearTimeout(musicToastTimerRef.current);
        if (musicLoadingFallbackRef.current) clearTimeout(musicLoadingFallbackRef.current);
        musicToastTimerRef.current = null;
        musicLoadingFallbackRef.current = null;
        setMusicToast(null);
        setPendingPlayTrackId(null);
    }, []);

    const showMusicToast = useCallback((text: string, duration = 2000) => {
        if (musicToastTimerRef.current) clearTimeout(musicToastTimerRef.current);
        if (musicLoadingFallbackRef.current) clearTimeout(musicLoadingFallbackRef.current);
        musicToastTimerRef.current = null;
        musicLoadingFallbackRef.current = null;
        setPendingPlayTrackId(null);
        setMusicToast(text);
        if (duration > 0) {
            musicToastTimerRef.current = setTimeout(() => {
                setMusicToast(null);
                musicToastTimerRef.current = null;
            }, duration);
        }
    }, []);

    const beginMusicLoadingToast = useCallback((trackId: string) => {
        if (musicToastTimerRef.current) clearTimeout(musicToastTimerRef.current);
        if (musicLoadingFallbackRef.current) clearTimeout(musicLoadingFallbackRef.current);
        musicToastTimerRef.current = null;
        setPendingPlayTrackId(trackId);
        setMusicToast("加载音乐中...");
        musicLoadingFallbackRef.current = setTimeout(() => {
            setMusicToast(null);
            setPendingPlayTrackId(null);
            musicLoadingFallbackRef.current = null;
        }, 8000);
    }, []);

    useEffect(() => {
        if (!pendingPlayTrackId || player.currentTrack?.id !== pendingPlayTrackId) return;
        clearMusicToast();
    }, [clearMusicToast, pendingPlayTrackId, player.currentTrack?.id]);

    useEffect(() => () => {
        if (musicToastTimerRef.current) clearTimeout(musicToastTimerRef.current);
        if (musicLoadingFallbackRef.current) clearTimeout(musicLoadingFallbackRef.current);
    }, []);

    const getTimeFromEvent = useCallback((clientX: number) => {
        const bar = progressRef.current;
        if (!bar || !player.duration) return 0;
        const rect = bar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        return ratio * player.duration;
    }, [player.duration]);

    const handleProgressDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const time = getTimeFromEvent(e.clientX);
        setDragTime(time);
        setIsDragging(true);
    }, [getTimeFromEvent]);

    const handleProgressMove = useCallback((e: React.PointerEvent) => {
        if (!isDragging) return;
        setDragTime(getTimeFromEvent(e.clientX));
    }, [isDragging, getTimeFromEvent]);

    const handleProgressUp = useCallback((e: React.PointerEvent) => {
        if (!isDragging) return;
        const time = getTimeFromEvent(e.clientX);
        setDragTime(time);
        player.seek(time);
        setIsDragging(false);
    }, [isDragging, getTimeFromEvent, player]);

    const cyclePlayMode = useCallback(() => {
        const modes: PlayMode[] = ["sequence", "shuffle", "repeat-one"];
        const idx = modes.indexOf(player.playMode);
        player.setPlayMode(modes[(idx + 1) % modes.length]);
    }, [player]);

    // Parse LRC lyrics
    const parsedLyrics = useRef<{ time: number; text: string }[]>([]);
    const [activeLyricIdx, setActiveLyricIdx] = useState(-1);
    const lyricsContainerRef = useRef<HTMLDivElement>(null);

    // 歌词滑动定位跳播状态
    const [isScrollingLyrics, setIsScrollingLyrics] = useState(false);
    const [scrolledLyricIdx, setScrolledLyricIdx] = useState<number | null>(null);
    const isUserScrollingRef = useRef(false);
    const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const userTouchActiveRef = useRef(false);

    useEffect(() => {
        const lrc = player.currentTrack?.lyrics || "";
        if (!lrc) {
            parsedLyrics.current = [];
            return;
        }
        const lines: { time: number; text: string }[] = [];
        for (const line of lrc.split("\n")) {
            const match = line.match(/\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
            if (match) {
                const mins = parseInt(match[1], 10);
                const secs = parseFloat(match[2]);
                lines.push({ time: mins * 60 + secs, text: match[3].trim() });
            }
        }
        lines.sort((a, b) => a.time - b.time);
        parsedLyrics.current = lines;
    }, [player.currentTrack?.lyrics]);

    useEffect(() => {
        const lyrics = parsedLyrics.current;
        if (lyrics.length === 0) { setActiveLyricIdx(-1); return; }
        let idx = -1;
        for (let i = lyrics.length - 1; i >= 0; i--) {
            if (player.currentTime >= lyrics[i].time) {
                idx = i;
                break;
            }
        }
        setActiveLyricIdx(idx);
    }, [player.currentTime]);

    // 居中计算辅助：找出最靠近容器视口垂直中线的歌词行
    const updateScrolledLyricIndex = useCallback(() => {
        const container = lyricsContainerRef.current;
        if (!container || parsedLyrics.current.length === 0) return;
        const containerRect = container.getBoundingClientRect();
        const centerY = containerRect.top + containerRect.height / 2;
        let closestIdx = 0;
        let minDistance = Infinity;

        const children = container.children;
        for (let i = 0; i < children.length; i++) {
            const el = children[i] as HTMLElement;
            if (!el.classList.contains("music-player-lyric-line")) continue;
            const rect = el.getBoundingClientRect();
            const elCenterY = rect.top + rect.height / 2;
            const dist = Math.abs(elCenterY - centerY);
            if (dist < minDistance) {
                minDistance = dist;
                closestIdx = i;
            }
        }
        setScrolledLyricIdx(closestIdx);
    }, []);

    // 歌词容器滚动监听
    const handleLyricsScroll = useCallback(() => {
        if (!isUserScrollingRef.current) return;
        updateScrolledLyricIndex();
        if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
        // 如果用户手指还在拖动，不启动恢复倒计时
        if (!userTouchActiveRef.current) {
            scrollTimeoutRef.current = setTimeout(() => {
                isUserScrollingRef.current = false;
                setIsScrollingLyrics(false);
                setScrolledLyricIdx(null);
            }, 3500);
        }
    }, [updateScrolledLyricIndex]);

    const handleLyricsPointerDown = useCallback(() => {
        userTouchActiveRef.current = true;
        isUserScrollingRef.current = true;
        setIsScrollingLyrics(true);
        if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
        updateScrolledLyricIndex();
    }, [updateScrolledLyricIndex]);

    const handleLyricsPointerUp = useCallback(() => {
        userTouchActiveRef.current = false;
        if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
        scrollTimeoutRef.current = setTimeout(() => {
            isUserScrollingRef.current = false;
            setIsScrollingLyrics(false);
            setScrolledLyricIdx(null);
        }, 3500);
    }, []);

    // 点击某一句歌词跳播
    const handleSeekToLyric = useCallback((e: React.MouseEvent, time: number) => {
        e.stopPropagation();
        player.seek(time);
        if (!player.isPlaying) player.resume();
        if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
        isUserScrollingRef.current = false;
        userTouchActiveRef.current = false;
        setIsScrollingLyrics(false);
        setScrolledLyricIdx(null);
    }, [player]);

    // Auto-scroll lyrics（仅当非用户拖拽状态时自动居中当前播放行）
    useEffect(() => {
        if (isUserScrollingRef.current || activeLyricIdx < 0 || !lyricsContainerRef.current) return;
        const el = lyricsContainerRef.current.children[activeLyricIdx] as HTMLElement;
        if (el) {
            scrollElementWithinContainer(lyricsContainerRef.current, el, { behavior: "smooth", block: "center" });
        }
    }, [activeLyricIdx]);

    const [liked, setLiked] = useState(false);
    const [showPlaylistPicker, setShowPlaylistPicker] = useState(false);
    const [showSleepPicker, setShowSleepPicker] = useState(false);
    const [playlists, setPlaylists] = useState<NeteasePlaylist[]>([]);
    const [loadingPlaylists, setLoadingPlaylists] = useState(false);
    const [addResult, setAddResult] = useState<{ ok: boolean; message: string } | null>(null);

    // Sync liked state with current track
    useEffect(() => {
        setLiked(player.currentTrack?.liked ?? false);
    }, [player.currentTrack?.id, player.currentTrack?.liked]);

    // Clear add result: 成功 2.5s，失败留 12s（错误信息较长，方便看清/截图）
    useEffect(() => {
        if (!addResult) return;
        const t = setTimeout(() => setAddResult(null), addResult.ok ? 2500 : 12000);
        return () => clearTimeout(t);
    }, [addResult]);

    const isNeteaseTrack = player.currentTrack?.id?.startsWith("netease_") ?? false;
    const neteaseId = isNeteaseTrack ? parseInt(player.currentTrack!.id.replace("netease_", ""), 10) : 0;

    const handleLike = useCallback(async () => {
        if (!player.currentTrack) return;
        const newLiked = !liked;
        setLiked(newLiked);
        if (newLiked) {
            // For Netease tracks, open playlist picker to add to a playlist
            if (isNeteaseTrack && isNeteaseConfigured()) {
                setShowPlaylistPicker(true);
                setLoadingPlaylists(true);
                getUserPlaylists().then(p => { setPlaylists(p); setLoadingPlaylists(false); });
            }
        } else {
            // Unlike — remove from Netease playlist if previously added
            if (isNeteaseTrack && neteaseId) {
                const pid = getTrackPlaylistId(neteaseId);
                if (pid) {
                    const result = await removeTracksFromPlaylist(pid, [neteaseId]);
                    removeTrackPlaylistRecord(neteaseId);
                    setAddResult(result);
                }
            }
        }
    }, [liked, player.currentTrack, isNeteaseTrack, neteaseId]);

    const handleAddToPlaylist = useCallback(async (playlist: NeteasePlaylist) => {
        if (!neteaseId) return;
        const result = await addTracksToPlaylist(playlist.id, [neteaseId]);
        if (result.ok) {
            recordTrackPlaylist(neteaseId, playlist.id);
        }
        setAddResult(result);
        setShowPlaylistPicker(false);
    }, [neteaseId]);

    const openShareViaChat = useCallback(() => {
        if (!player.currentTrack) return;
        window.dispatchEvent(new CustomEvent("open-mini-chat", {
            detail: { share: { type: "music", title: player.currentTrack.title, artist: player.currentTrack.artist } },
        }));
    }, [player.currentTrack]);

    if (!player.currentTrack) return null;

    const track = player.currentTrack;
    const hasLyrics = parsedLyrics.current.length > 0;
    const modeInfo = PLAY_MODE_ICONS[player.playMode];

    const getAdjacentTrack = (direction: "prev" | "next") => {
        if (player.queue.length === 0 || !player.currentTrack) return null;
        const idx = player.queue.findIndex(t => t.id === player.currentTrack!.id);
        if (idx < 0) return null;
        if (player.playMode === "shuffle") {
            return player.queue[Math.floor(Math.random() * player.queue.length)] ?? null;
        }
        const offset = direction === "next" ? 1 : -1;
        const nextIdx = (idx + offset + player.queue.length) % player.queue.length;
        return player.queue[nextIdx] ?? null;
    };

    const handleSwitchToTrack = useCallback(async (target: typeof player.currentTrack) => {
        if (!target) return;
        if (target.id.startsWith("netease_")) {
            beginMusicLoadingToast(target.id);
            const nid = parseInt(target.id.replace("netease_", ""), 10);
            const url = await getNeteasePlayUrl(nid);
            if (!url) {
                showMusicToast("加载失败，请稍后重试");
                return;
            }
            player.playUrl(url, target);
            return;
        }
        player.playTrack(target);
    }, [beginMusicLoadingToast, player, showMusicToast]);

    const handlePrev = useCallback(() => {
        const target = getAdjacentTrack("prev");
        if (target?.id.startsWith("netease_")) {
            void handleSwitchToTrack(target);
            return;
        }
        player.prev();
    }, [handleSwitchToTrack, player]);

    const handleNext = useCallback(() => {
        const target = getAdjacentTrack("next");
        if (target?.id.startsWith("netease_")) {
            void handleSwitchToTrack(target);
            return;
        }
        player.next();
    }, [handleSwitchToTrack, player]);

    return (
        <div className="music-player">
            {musicToast && (
                <div className="music-toast-overlay">
                    <div className="music-toast-chip">
                        {musicToast === "加载音乐中..." ? (
                            <span className="ui-loading-toast-content">
                                <span className="ui-loading-spinner" />
                                <span>{musicToast}</span>
                            </span>
                        ) : musicToast}
                    </div>
                </div>
            )}
            {/* Background blur glow */}
            <div className="music-player-bg" />

            {/* Header */}
            <div className="music-player-header">
                <button className="music-player-close" onClick={player.closeFullPlayer}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <path d="M19 12H5M12 19l-7-7 7-7" />
                    </svg>
                </button>
                <div className="music-player-header-info">
                    <div className="music-player-header-title">{track.title}</div>
                    <div className="music-player-header-artist">{track.artist}</div>
                </div>
                {player.queue.length > 0 ? (
                    <button
                        className="music-player-lyrics-toggle"
                        {...(showQueue ? { "data-active": "" } : {})}
                        onClick={() => setShowQueue(!showQueue)}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                            <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                        </svg>
                    </button>
                ) : (
                    <div style={{ width: 36, height: 36, flexShrink: 0 }} />
                )}
            </div>

            {/* Main content area — tap to toggle lyrics */}
            <div
                className={showLyrics ? "music-player-body music-player-body--lyrics" : "music-player-body"}
                onClick={() => {
                    // 仅当非歌词拖动浏览状态下点击空白才切换黑胶/歌词
                    if (!isScrollingLyrics) {
                        setShowLyrics(v => !v);
                    }
                }}
            >
                {showLyrics ? (
                    /* Lyrics view */
                    hasLyrics ? (
                        <div
                            className="music-player-lyrics"
                            ref={lyricsContainerRef}
                            onScroll={handleLyricsScroll}
                            onPointerDown={handleLyricsPointerDown}
                            onPointerUp={handleLyricsPointerUp}
                            onPointerCancel={handleLyricsPointerUp}
                        >
                            {/* 网易云同款中心准心瞄准线（在滑动歌词时显现） */}
                            {isScrollingLyrics && (
                                <div className="music-player-lyric-aim-line" />
                            )}
                            {parsedLyrics.current.map((line, i) => {
                                const isCurrentPlaying = i === activeLyricIdx;
                                const isFocusedByScroll = isScrollingLyrics && i === scrolledLyricIdx;
                                return (
                                    <div
                                        key={i}
                                        className={`music-player-lyric-line ${isFocusedByScroll ? "music-player-lyric-line--focused" : ""}`}
                                        {...(isCurrentPlaying ? { "data-active": "" } : {})}
                                        onClick={(e) => {
                                            // 点击该行直接跳播
                                            handleSeekToLyric(e, line.time);
                                        }}
                                    >
                                        {/* 滑动至当前焦点行时，左侧显示时间 */}
                                        {isFocusedByScroll && (
                                            <span className="music-player-lyric-aim-time">
                                                {formatTime(line.time)}
                                            </span>
                                        )}
                                        <span className="music-player-lyric-text">
                                            {line.text || "\u00A0"}
                                        </span>
                                        {/* 滑动至当前焦点行时，右侧显示小播放键 */}
                                        {isFocusedByScroll && (
                                            <button
                                                type="button"
                                                className="music-player-lyric-aim-play"
                                                onClick={(e) => handleSeekToLyric(e, line.time)}
                                                aria-label="从这里播放"
                                                title="从这里播放"
                                            >
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                                    <path d="M8 5v14l11-7z" />
                                                </svg>
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="music-player-lyrics" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <div className="music-player-lyric-line" data-active="">{"暂无歌词"}</div>
                        </div>
                    )
                ) : (
                    /* Vinyl view */
                    <div className="music-player-vinyl-area">
                        <div className="music-player-vinyl-glow" />
                        <div className="music-player-vinyl" {...(player.isPlaying ? { "data-spinning": "" } : {})}>
                            <div className="music-player-vinyl-groove music-player-vinyl-groove-1" />
                            <div className="music-player-vinyl-groove music-player-vinyl-groove-2" />
                            <div className="music-player-vinyl-groove music-player-vinyl-groove-3" />
                            <div className="music-player-vinyl-center">
                                {track.coverUrl ? (
                                    <img src={track.coverUrl} alt="" className="music-player-vinyl-cover" />
                                ) : (
                                    <div className="music-player-vinyl-cover-placeholder">
                                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                                            <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                                        </svg>
                                    </div>
                                )}
                            </div>
                            <div className="music-player-vinyl-dot" />
                        </div>
                        {/* Tonearm */}
                        <div className="music-player-tonearm" {...(player.isPlaying ? { "data-playing": "" } : {})}>
                            <div className="music-player-tonearm-pivot" />
                            <div className="music-player-tonearm-arm" />
                            <div className="music-player-tonearm-joint" />
                            <div className="music-player-tonearm-head" />
                        </div>
                    </div>
                )}
            </div>

            {/* Progress bar */}
            <div className="music-player-progress-area">
                {/* Share + Chat + Sleep Timer — absolute positioned above progress */}
                <div className="music-player-share-row">
                    <button className="music-player-ctrl-btn music-player-ctrl-side" onClick={openShareViaChat} title="分享到聊天">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                        </svg>
                    </button>
                    <button className="music-player-ctrl-btn music-player-ctrl-side" onClick={() => window.dispatchEvent(new CustomEvent("open-mini-chat"))} title="聊天">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        </svg>
                    </button>
                    <button
                        className="music-player-ctrl-btn music-player-ctrl-side music-player-sleep-btn"
                        onClick={() => setShowSleepPicker(true)}
                        title="定时关闭"
                        aria-label="定时关闭"
                    >
                        {/* 网易云同款小闹钟图标 */}
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="2" x2="12" y2="4" />
                            <circle cx="12" cy="14" r="8" />
                            <polyline points="12 10 12 14 15 15.5" />
                        </svg>
                        {player.sleepTimerOption !== "off" && (
                            <span className="music-player-sleep-badge">
                                {player.sleepTimerOption === "end-of-song"
                                    ? "单曲"
                                    : player.sleepTimerRemaining !== null
                                        ? formatTime(player.sleepTimerRemaining)
                                        : `${player.sleepTimerOption}:00`}
                            </span>
                        )}
                    </button>
                </div>
                <span className="music-player-time">{formatTime(currentTime)}</span>
                <div
                    ref={progressRef}
                    className="music-player-progress"
                    onPointerDown={handleProgressDown}
                    onPointerMove={handleProgressMove}
                    onPointerUp={handleProgressUp}
                    onPointerCancel={handleProgressUp}
                >
                    <div className="music-player-progress-fill" style={{ width: `${progress * 100}%` }}>
                        <div className="music-player-progress-thumb" />
                    </div>
                </div>
                <span className="music-player-time">{formatTime(player.duration)}</span>
            </div>

            {/* Controls */}
            <div className="music-player-controls">
                <button className="music-player-ctrl-btn music-player-ctrl-side" onClick={cyclePlayMode} title={modeInfo.label}>
                    <svg width="20" height="20" viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: modeInfo.svg }} />
                </button>
                <button className="music-player-ctrl-btn" onClick={handlePrev}>
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
                    </svg>
                </button>
                <button className="music-player-ctrl-btn music-player-ctrl-play" onClick={player.togglePlay}>
                    {player.isPlaying ? (
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M6 4h4v16H6zm8 0h4v16h-4z" />
                        </svg>
                    ) : (
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z" />
                        </svg>
                    )}
                </button>
                <button className="music-player-ctrl-btn" onClick={handleNext}>
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 18l8.5-6L6 6v12zm8.5 0h2V6h-2v12z" />
                    </svg>
                </button>
                <button
                    className="music-player-ctrl-btn music-player-ctrl-side music-player-ctrl-like"
                    {...(liked ? { "data-liked": "" } : {})}
                    onClick={handleLike}
                >
                    {liked ? (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                        </svg>
                    ) : (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                        </svg>
                    )}
                </button>
            </div>

            {/* Queue drawer */}
            {showQueue && (
                <div className="music-queue-overlay" onClick={() => setShowQueue(false)}>
                    <div className="music-queue-drawer" onClick={e => e.stopPropagation()}>
                        <div className="music-queue-header">
                            <span>播放列表</span>
                            <span className="music-queue-count">{player.queue.length}首</span>
                            <button className="music-playlist-picker-close" onClick={() => setShowQueue(false)}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                            </button>
                        </div>
                        <div className="music-queue-list">
                            {player.queue.map((t, idx) => {
                                const isCurrent = t.id === track.id;
                                return (
                                    <div
                                        key={t.id}
                                        className="music-queue-item"
                                        role="button"
                                        tabIndex={0}
                                        {...(isCurrent ? { "data-current": "" } : {})}
                                        onClick={() => { void handleSwitchToTrack(t); }}
                                    >
                                        <span className="music-queue-item-idx">{idx + 1}</span>
                                        <div className="music-queue-item-info">
                                            <div className="music-queue-item-title">{t.title}</div>
                                            <div className="music-queue-item-artist">{t.artist}</div>
                                        </div>
                                        {isCurrent && player.isPlaying && (
                                            <div className="music-wave music-queue-wave">{[0, 1, 2].map(i => <span key={i} className="music-wave-bar" style={{ animationDelay: `${i * 0.15}s` }} />)}</div>
                                        )}
                                        {!isCurrent && (
                                            <button
                                                className="music-queue-item-del"
                                                onClick={e => { e.stopPropagation(); player.removeFromQueue(t.id); }}
                                            >
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}

            {/* Sleep Timer Picker overlay */}
            {showSleepPicker && (
                <div className="music-playlist-picker-overlay" onClick={() => setShowSleepPicker(false)}>
                    <div className="music-playlist-picker" onClick={e => e.stopPropagation()}>
                        <div className="music-playlist-picker-header">
                            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="12" y1="2" x2="12" y2="4" />
                                    <circle cx="12" cy="14" r="8" />
                                    <polyline points="12 10 12 14 15 15.5" />
                                </svg>
                                <span>定时关闭</span>
                            </span>
                            <button className="music-playlist-picker-close" onClick={() => setShowSleepPicker(false)}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                            </button>
                        </div>
                        <div className="music-playlist-picker-list" style={{ padding: "6px 0 16px" }}>
                            {[
                                { id: "off", label: "不开启" },
                                { id: "15", label: "15 分钟后" },
                                { id: "30", label: "30 分钟后" },
                                { id: "45", label: "45 分钟后" },
                                { id: "60", label: "60 分钟后" },
                                { id: "end-of-song", label: "播完当前歌曲后" },
                            ].map(item => {
                                const active = player.sleepTimerOption === item.id;
                                return (
                                    <button
                                        key={item.id}
                                        type="button"
                                        className="music-sleep-picker-item"
                                        data-active={active ? "true" : undefined}
                                        onClick={() => {
                                            player.setSleepTimer(item.id as any);
                                            setShowSleepPicker(false);
                                            showMusicToast(
                                                item.id === "off"
                                                    ? "已关闭定时"
                                                    : item.id === "end-of-song"
                                                        ? "将在当前歌曲播完后关闭"
                                                        : `将在 ${item.id} 分钟后关闭`
                                            );
                                        }}
                                    >
                                        <span>{item.label}</span>
                                        {active && (
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                                <polyline points="20 6 9 17 4 12" />
                                            </svg>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}

            {/* Playlist picker overlay */}
            {showPlaylistPicker && (
                <div className="music-playlist-picker-overlay" onClick={() => setShowPlaylistPicker(false)}>
                    <div className="music-playlist-picker" onClick={e => e.stopPropagation()}>
                        <div className="music-playlist-picker-header">
                            <span>收藏到歌单</span>
                            <button className="music-playlist-picker-close" onClick={() => setShowPlaylistPicker(false)}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                            </button>
                        </div>
                        <div className="music-playlist-picker-list">
                            {loadingPlaylists ? (
                                <div className="music-playlist-picker-loading">加载歌单...</div>
                            ) : playlists.length === 0 ? (
                                <div className="music-playlist-picker-loading">没有找到歌单</div>
                            ) : playlists.map(pl => (
                                <button key={pl.id} className="music-playlist-picker-item" onClick={() => handleAddToPlaylist(pl)}>
                                    <img src={pl.coverUrl} alt="" className="music-playlist-picker-cover" />
                                    <div className="music-playlist-picker-info">
                                        <div className="music-playlist-picker-name">{pl.name}</div>
                                        <div className="music-playlist-picker-count">{pl.trackCount}首</div>
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Add result toast */}
            {addResult && (
                <div className={`music-toast ${addResult.ok ? "music-toast-ok" : "music-toast-err"}`}>
                    {addResult.ok ? "✓ " : "✗ "}{addResult.message}
                </div>
            )}

        </div>
    );
}
