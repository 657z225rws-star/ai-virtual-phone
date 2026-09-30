// lib/realtime-context.ts
// 「现实世界与时效」提示块。
//
// 解决的问题：模型（尤其是 Gemini）遇到今年/最近的新闻时事时不会主动查证，
// 而是从记忆里翻出某一年份的旧闻当成今年的答案（典型：把往年台风名说成今年的），
// 语气还很确定。光靠预设里一句「当前系统时间」不够，它会读却不用。
//
// 这个块做三件事：
// 1. 把当前年月日/星期明确摆在它面前，并要求它在说「今年/最近」之前先换算成具体年份；
// 2. 明确它的知识有截止时间，时效类问题必须先查（联网搜索工具可用时）或直接承认不知道；
// 3. 明确禁止把往年旧闻当今年、禁止在没有依据时编具体名字/年份/数字。

import { WEB_SEARCH_CAPABILITY_ID, loadInternalCapabilities } from "./internal-capability-storage";

/** 「联网搜索」内置能力是否已开启（关着就没法要求它去查） */
export function isWebSearchCapabilityEnabled(): boolean {
    try {
        return loadInternalCapabilities().some(
            item => item.id === WEB_SEARCH_CAPABILITY_ID && item.enabled && item.mode !== "off",
        );
    } catch {
        return false;
    }
}

/**
 * 构建注入块。timeContext 直接复用 App 已有的时间上下文文本
 * （形如「当前系统时间：2026年9月30日10:45，星期三」），保证两处口径一致。
 */
export function buildRealtimeContextBlock(timeContext: string, searchEnabled: boolean): string {
    const lines = [
        "<现实世界与时效>",
        timeContext,
        "- 你的知识有截止时间，之后发生的事你并不知道，也不要装作知道。",
        searchEnabled
            ? "- 涉及新闻时事、赛事比分、台风/极端天气、股价、价格、软件版本、政策新规、人物近况这类时效问题：先用「联网搜索」工具查证，再开口回答。"
            : "- 涉及新闻时事、赛事比分、台风/极端天气、股价、价格、软件版本、政策新规、人物近况这类时效问题：不要凭记忆回答，直接说你不确定或需要查一下。",
        "- 说「今年」「最近」「现在」「上个月」之前，先按上面的日期换算出具体年份，再去想那一年发生了什么。",
        "- 严禁把往年的旧闻当成今年的事（例如把过去某年的台风名字说成今年的）；搜索结果与你的记忆冲突时，一律以搜索结果为准。",
        "- 查不到、没工具或结果不明确时，就用「我不确定」「我查一下」带过，绝不编具体名字、年份、数字。",
        "</现实世界与时效>",
    ];
    return lines.join("\n");
}
