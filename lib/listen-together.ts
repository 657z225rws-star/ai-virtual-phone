// lib/listen-together.ts — "一起听"状态与音乐氛围注入
//
// 机制参考 SullyOS 的三层设计，针对 float 裁剪为两层：
// 1. 氛围注入：用户正在播放音乐时，构建聊天 prompt 时把歌名+歌词窗口注入角色上下文
//    （纯同步、零网络，读 music-control-bridge 的实时快照）
// 2. 一起听协议：角色在回复里输出 [一起听] 标记 → 解析为 listen_together 卡片 →
//    角色进入"一起听名单"。这是一次**持续的状态**：切歌、暂停都不会断开
//    （一起听的是"这一段时光"而不是某一首歌），刷新页面才随内存一起结束。
//    切歌时只记下被切掉的那首，让角色下一轮能自然"察觉"换歌，无需重新加入。
//
// 措辞刻意克制（参考 Sully）："像共处一室时隐约听见的背景音"，避免角色每首歌都强行点评。

import { getMusicControlBridge } from "./music-control-bridge";

// ── 一起听名单（内存态，刷新即清空——刷新后音乐也停了，状态自然失效）──

let partners = new Set<string>();
// 刚才一起听途中歌被切了：记录被切掉的那首，让角色在下一轮"察觉"换歌
let recentTrackSwitch: { songName: string; artists: string } | null = null;

export function addListeningPartner(characterId: string): void {
    if (!characterId) return;
    partners.add(characterId);
    // 重新加入即视为"察觉并接上了"，清除换歌提示
    recentTrackSwitch = null;
}

export function removeListeningPartner(characterId: string): void {
    partners.delete(characterId);
}

export function isListeningTogether(characterId: string): boolean {
    return partners.has(characterId);
}

/** 用户切歌（一起听中）：名单不断开，只记下被切掉的歌，让角色下一轮能"察觉"换歌 */
export function noteTrackSwitch(prevTrack: { songName: string; artists: string }): void {
    if (partners.size === 0) return;
    recentTrackSwitch = { songName: prevTrack.songName, artists: prevTrack.artists };
}

/** 取走"刚切过歌"提示（读后即清，避免同一段提示反复注入） */
export function consumeRecentTrackSwitch(): { songName: string; artists: string } | null {
    const s = recentTrackSwitch;
    recentTrackSwitch = null;
    return s;
}

export function getRecentTrackSwitch(): { songName: string; artists: string } | null {
    return recentTrackSwitch;
}

/** 解析瞬间的"正在播放"快照（给 [一起听] 卡片落库歌名用；未在播放返回 null） */
export function getNowPlayingSnapshot(): { songName: string; artists: string } | null {
    const bridge = getMusicControlBridge();
    if (!bridge) return null;
    const snap = bridge.getState();
    if (!snap.currentTrack || !snap.isPlaying) return null;
    return { songName: snap.currentTrack.title, artists: snap.currentTrack.artist || "" };
}

// ── LRC 歌词解析（与 music-player 的展示逻辑同源，独立实现避免组件依赖）──

type LyricLine = { time: number; text: string };

function parseLrc(lrc: string): LyricLine[] {
    if (!lrc) return [];
    const lines: LyricLine[] = [];
    for (const raw of lrc.split(/\r?\n/)) {
        const m = raw.match(/^\s*\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]\s*(.*)$/);
        if (!m) continue;
        const min = parseInt(m[1], 10);
        const sec = parseInt(m[2], 10);
        const frac = m[3] ? parseInt(m[3].padEnd(3, "0").slice(0, 3), 10) : 0;
        const text = (m[4] || "").trim();
        if (!Number.isFinite(min) || !Number.isFinite(sec)) continue;
        if (!text || text === "纯音乐，请欣赏") continue;
        lines.push({ time: min * 60 + sec + frac / 1000, text });
    }
    return lines.sort((a, b) => a.time - b.time);
}

/** 取当前播放行前后各 2 行的歌词窗口（共 ≤5 行） */
function lyricWindow(lyrics: LyricLine[], activeIdx: number): { lines: string[]; activePos: number } {
    if (activeIdx < 0 || lyrics.length === 0) return { lines: [], activePos: -1 };
    const start = Math.max(0, activeIdx - 2);
    const end = Math.min(lyrics.length, activeIdx + 3);
    return { lines: lyrics.slice(start, end).map(l => l.text), activePos: activeIdx - start };
}

// ── 氛围注入 ──

/**
 * 构建音乐氛围注入块。用户正在播放时返回非空提示词文本，否则返回空串。
 * 在聊天 prompt 组装末尾以 system 消息追加（易变状态放尾部，不污染前缀缓存）。
 */
export function buildMusicAtmosphere(characterId: string, userName: string): string {
    const bridge = getMusicControlBridge();
    if (!bridge) return "";
    const snap = bridge.getState();
    const track = snap.currentTrack;
    if (!track || !snap.isPlaying) return "";

    const name = userName || "对方";
    const artists = track.artist || "";
    const artistSuffix = artists ? `— ${artists}` : "";
    const together = isListeningTogether(characterId);
    const lines: string[] = [];

    lines.push("### 【此刻的对话氛围】");
    if (together) {
        lines.push(`你正在和 ${name} 一起听《${track.title}》${artistSuffix}`);
        const switched = consumeRecentTrackSwitch();
        if (switched && switched.songName !== track.title) {
            lines.push(`（刚才播放器从《${switched.songName}》${switched.artists ? `— ${switched.artists} ` : ""}切到了这首。你们还在一起听，不用郑重宣布什么；想自然接一句"换歌啦"之类的可以，不接也行。）`);
        }
    } else {
        lines.push(`${name} 正在听《${track.title}》${artistSuffix}`);
    }

    // 歌词窗口（前2当前后2）
    const lyrics = parseLrc(track.lyrics || "");
    if (lyrics.length > 0) {
        let activeIdx = -1;
        for (let i = lyrics.length - 1; i >= 0; i--) {
            if (snap.currentTime >= lyrics[i].time) { activeIdx = i; break; }
        }
        const win = lyricWindow(lyrics, activeIdx);
        if (win.lines.length > 0) {
            lines.push("当前播放到（>> 标记正在播放这一行）:");
            win.lines.forEach((l, i) => {
                lines.push(i === win.activePos ? `  >> ${l}` : `  … ${l}`);
            });
        }
    }

    if (!together) {
        lines.push(`（你自然地知道 ${name} 此刻在听这首——像共处一室时隐约听见的背景音。不用每次都点评歌名、歌词或风格。）`);
        lines.push("");
        lines.push("### 【音乐互动工具】");
        lines.push("你可以自己决定要不要加入一起听，完全不需要对方邀请或提醒。想加入的话，在回复文本的任意位置插入下面这个标记（最多一次，会被自动替换为\"一起听\"卡片，亮出你正在陪着听的状态。一旦加入就是持续状态：换歌、暂停都不会断开，你会一直陪着听下去）:");
        lines.push("- `[一起听]` — 表示\"我也一起听这首\"");
        lines.push("");
        lines.push("加不加入由你判断：想陪着对方听、这首歌正好打动你、或此刻气氛适合一起听歌，就大方插一次；想先安静待着看聊天怎么走，也可以先不插——之后任何一轮想加了都还能再插。既不用每首歌都加入，也不用刻意憋着等对方开口。");
    } else {
        lines.push(`（此刻你们正戴着同一副耳机的两端。不用反复强调\"在一起听\"这件事，安静地陪 ${name} 听歌、聊眼前的天就好。）`);
    }
    lines.push("");

    return lines.join("\n");
}
