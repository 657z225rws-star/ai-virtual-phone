// components/chat/tts-speak-button.tsx — 消息气泡旁的「朗读」小圆钮
// 点击后用当前角色绑定的语音 API 合成该条消息文本并播放；播放中再点一次停止。
"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Volume2, Loader2, Square } from "lucide-react";
import { resolveVoiceConfig, synthesizeSpeech } from "@/lib/tts-service";
import { splitBilingualText } from "@/lib/bilingual-text";
import type { ContentAppId } from "@/lib/settings-types";

type TtsState = "idle" | "loading" | "playing";

/** 轻量清洗：剥掉会让 TTS 逐字朗读的符号——
 *  剧情折叠块（think/summary 等思维链与摘要，渲染为 <!--RHR-FOLD: --> 标记）、
 *  HTML 标签、代码围栏、行内反引号、强调星号、标题井号、引用箭头、双语对照译文段。 */
function toSpeechText(raw: string): string {
    const stripped = splitBilingualText(raw)?.original || raw;
    return stripped
        .replace(/<!--RHR-FOLD:[^>]*-->[\s\S]*?<!--\/RHR-FOLD-->/g, " ")
        .replace(/<(summary|think|thinking)>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<!--RHR-FOLD:[^>]*-->/g, " ")
        .replace(/<!--\/RHR-FOLD-->/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^>\s?/gm, "")
        .replace(/\[(.*?)\]\(.*?\)/g, "$1")
        .replace(/\uFFFD/g, "")
        .trim();
}

export const TtsSpeakButton = memo(function TtsSpeakButton({
    text,
    characterId,
    appId,
}: {
    text: string;
    characterId?: string;
    appId?: ContentAppId;
}) {
    const [state, setState] = useState<TtsState>("idle");
    const audioRef = useRef<HTMLAudioElement | null>(null);

    const hasVoiceConfig = useMemo(() => {
        if (typeof window === "undefined") return false;
        try {
            return !!resolveVoiceConfig(characterId || "", appId);
        } catch {
            return false;
        }
    }, [characterId, appId]);

    const stopAudio = () => {
        if (audioRef.current) {
            const audio = audioRef.current;
            audioRef.current = null;
            try { audio.pause(); audio.removeAttribute("src"); audio.load(); } catch { /* ignore */ }
        }
    };

    useEffect(() => () => { stopAudio(); }, []);

    if (!hasVoiceConfig) return null;

    const handleSpeak = async () => {
        if (state === "playing") {
            stopAudio();
            setState("idle");
            return;
        }
        if (state === "loading") return;
        const speechText = toSpeechText(text);
        if (!speechText) return;
        setState("loading");
        try {
            const config = resolveVoiceConfig(characterId || "", appId);
            if (!config) { setState("idle"); return; }
            const blob = await synthesizeSpeech(speechText, config);
            if (!blob) { setState("idle"); return; }
            const url = URL.createObjectURL(blob);
            // 用 <audio> 元素播放：iOS 静音拨键不会掐掉媒体元素的声音（Web Audio 会）
            const audio = new Audio(url);
            audioRef.current = audio;
            const finalize = () => {
                if (audioRef.current === audio) {
                    try { audio.pause(); audio.removeAttribute("src"); audio.load(); } catch { /* ignore */ }
                    audioRef.current = null;
                    URL.revokeObjectURL(url);
                }
                setState("idle");
            };
            audio.onended = finalize;
            audio.onerror = finalize;
            audio.play().then(() => setState("playing")).catch(finalize);
        } catch (err) {
            console.warn("[TtsSpeakButton] synthesize failed:", err);
            setState("idle");
        }
    };

    return (
        <button
            type="button"
            className="chat-tts-speak-btn"
            aria-label={state === "playing" ? "停止朗读" : "朗读消息"}
            title={state === "playing" ? "停止朗读" : "朗读消息"}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); void handleSpeak(); }}
        >
            {state === "loading" ? (
                <Loader2 size={11} strokeWidth={2.6} className="cp-spin" />
            ) : state === "playing" ? (
                <Square size={8} strokeWidth={2.6} fill="currentColor" />
            ) : (
                <Volume2 size={11} strokeWidth={2.2} />
            )}
        </button>
    );
});
