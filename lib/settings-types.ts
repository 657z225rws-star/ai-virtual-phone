export type SettingItemMeta = {
    id: string;
    name: string;
    description?: string;
    createdAt: number;
    updatedAt: number;
};

// --- WorldBook ---
export type WorldBookEntry = {
    uid: string;
    key: string;
    content: string;
    comment: string;
    use_regex: boolean;
    disable: boolean;
    constant: boolean;
    position: "before_char" | "after_char" | "before_em" | "after_em" | "before_an" | "after_an" | number;
    depth?: number;
    probability?: number;
    useProbability?: boolean;
    role?: number;
    insertion_order: number;
};

export type WorldBookConfig = SettingItemMeta & {
    entries: WorldBookEntry[];
};

// --- Preset ---
export type PromptOrderEntry = {
    identifier: string;
    enabled: boolean;
};

export type Prompt = {
    identifier: string;
    name: string;
    role: "system" | "user" | "assistant" | string;
    content: string;
    injection_depth: number;
    /** @deprecated Prompt order is determined by prompt_order / array order when depth matches. */
    injection_order?: number;
    enabled: boolean;
    system_prompt?: boolean;
    marker?: boolean;
    forbid_overrides?: boolean;
    injection_position?: number;
    /** @deprecated Use `tags` instead. */
    featureTag?: string;
    /** @deprecated Use `tags: [..., "followup"]` instead. */
    followUpOnly?: boolean;
    /** Multi-tag filtering. Entry is included only when ALL its tags are present in the active appTags. Empty/undefined = universal. */
    tags?: string[];
};

export type PresetConfig = SettingItemMeta & {
    builtIn?: boolean;
    builtInVersion?: number;
    /** 未设置（-1）时不发送该采样参数，由模型使用官方默认值 */
    temperature: number;
    top_p: number;
    top_k: number;
    frequency_penalty: number;
    presence_penalty: number;
    repetition_penalty: number;
    openai_max_tokens: number;
    openai_max_context: number;
    top_a?: number;
    min_p?: number;
    wrap_in_quotes?: boolean;
    names_behavior?: number;
    send_if_empty?: string;
    impersonation_prompt?: string;
    new_chat_prompt?: string;
    new_group_chat_prompt?: string;
    new_example_chat_prompt?: string;
    continue_nudge_prompt?: string;
    group_nudge_prompt?: string;
    bias_preset_selected?: string;
    max_context_unlocked?: boolean;
    wi_format?: string;
    scenario_format?: string;
    personality_format?: string;
    story_summary_tag?: string;
    prompt_order?: PromptOrderEntry[];
    prompts: Prompt[];
};

// --- Regex ---
// Regex rule config.
export type RegexRule = {
    id: string;
    scriptName: string;
    findRegex: string;
    replaceString: string;
    /** Multi-tag filtering. Rule is included only when ALL its tags are present in the active appTags. Empty/undefined = universal. */
    tags?: string[];
    trimStrings?: string[];       // Strings to remove from each capture-group match before replacement
    disabled: boolean;
    placement: number[];          // 1=USER_INPUT, 2=AI_OUTPUT, 3=SLASH_COMMAND, 5=WORLD_INFO, 6=REASONING
    markdownOnly?: boolean;       // true → only apply during display rendering (non-destructive)
    promptOnly?: boolean;         // true → only apply during prompt assembly (non-destructive)
    runOnEdit?: boolean;          // true → also apply when user edits an existing message
    substituteRegex?: number;     // 0=NONE, 1=RAW macro substitution in findRegex, 2=ESCAPED
    minDepth?: number;            // Minimum message depth (-1 = unlimited)
    maxDepth?: number;            // Maximum message depth
};

export type RegexConfig = SettingItemMeta & {
    builtIn?: boolean;
    rules: RegexRule[];
};

// Gemini 安全过滤阈值（原生协议专用）。值为 HarmBlockThreshold 枚举；
// "default" 维持旧行为 BLOCK_NONE；"do_not_send" 表示该类别不发送。
export type GeminiSafetyThreshold =
    | "default"
    | "do_not_send"
    | "OFF"
    | "BLOCK_NONE"
    | "BLOCK_ONLY_HIGH"
    | "BLOCK_MEDIUM_AND_ABOVE"
    | "BLOCK_LOW_AND_ABOVE";

// --- ApiConfig (migrated from api-settings.tsx) ---
export type ApiConfig = {
    id: string;
    name?: string;
    provider: string;
    apiKey: string;
    baseUrl?: string;
    defaultModel: string;
    enableNativeTools?: boolean;
    enableImageRecognition: boolean;
    enableImageGeneration: boolean;
    preventEmptyGenerateRambling?: boolean;
    geminiSafetyThresholds?: Partial<Record<"HARM_CATEGORY_HARASSMENT" | "HARM_CATEGORY_HATE_SPEECH" | "HARM_CATEGORY_SEXUALLY_EXPLICIT" | "HARM_CATEGORY_DANGEROUS_CONTENT", GeminiSafetyThreshold>>;
    geminiThinkingLevel?: "minimal" | "low" | "medium" | "high";
    /** true 时请求 includeThoughts，模型返回思维链文本；未设置视为开启 */
    geminiIncludeThoughts?: boolean;
    /** true 时启用 Gemini 原生联网检索（googleSearch 工具） */
    geminiGoogleSearch?: boolean;
};

// --- VoiceApiConfig (migrated from voice-settings.tsx) ---
export type VoiceApiConfig = {
    id: string;
    name?: string;
    provider: string;
    apiKey: string;
    baseUrl?: string;
    region?: string;
    model?: string;
    sttModel?: string;
    defaultVoice: string;
    languageBoost?: string;
    customVoices?: { id: string; name: string; createdAt?: number }[];
    enableSTT: boolean;
    enableTTS: boolean;
};

// --- Image Generation ---
export type ImageGenerationRequestMode = "server" | "direct";

export type ImageHostingProvider = "none" | "imgbb";

export type ImageHostingSettings = {
    provider: ImageHostingProvider;
    imgbbApiKey: string;
    defaultExpirationSeconds: number;
    maxUploadBytes: number;
    autoConvertToWebp: boolean;
    allowMascotUpload: boolean;
};

export type ImageGenerationSettings = {
    enabled: boolean;
    requestMode: ImageGenerationRequestMode;
    apiKey: string;
    baseUrl: string;
    model: string;
    size: string;
    quality: string;
    extraPrompt: string;
    characterReferences: Record<string, {
        assetId: string;
        updatedAt: number;
    }>;
    imageHosting: ImageHostingSettings;
};

// --- Configuration Binding System ---

// Content apps that can have per-character bindings.
export type ContentAppId =
    | "chat" | "diary" | "music" | "reading"
    | "forum" | "cocreate" | "story" | "game" | "xiaohongshu" | "dwelling"
    | "checkphone" | "shopping" | "calendar" | "interview_magazine"
    | "moments" | "group_chat" | "vn" | "adventure";

export const CONTENT_APP_IDS: ContentAppId[] = [
    "chat", "diary", "music", "reading",
    "cocreate", "story", "game", "xiaohongshu", "dwelling",
    "checkphone", "shopping", "calendar", "interview_magazine",
    "moments", "group_chat", "vn", "adventure"
];

export const CONTENT_APP_LABELS: Record<ContentAppId, string> = {
    chat: "聊天",
    diary: "手记",
    music: "音乐",
    reading: "阅读",
    forum: "论坛（旧）",
    cocreate: "共创",
    story: "剧情",
    game: "游戏",
    xiaohongshu: "小红书",
    dwelling: "栖所",
    checkphone: "查手机",
    shopping: "购物",
    calendar: "日历",
    interview_magazine: "在场",
    moments: "朋友圈",
    group_chat: "群聊",
    vn: "漫卷",
    adventure: "冒险",
};

// Binding slot — config selections for a given scope
export type BindingSlot = {
    apiConfigId?: string;
    voiceConfigId?: string;
    presetId?: string;
    userIdentityId?: string;
    worldBookIds?: string[];
    regexIds?: string[];
};

// Character binding: character defaults + per-app overrides
export type CharacterBinding = {
    characterId: string;
    defaults: BindingSlot;
    appOverrides: Partial<Record<string, BindingSlot>>;
};

// Overall binding configuration
export type BindingConfig = {
    globalDefaults: BindingSlot;
    /** App-level defaults shared by every character; character app overrides still win. */
    appDefaults?: Partial<Record<string, BindingSlot>>;
    characterBindings: CharacterBinding[];
    /** Auxiliary API: used for memory summarization (global, not per-character) */
    memorySummaryApiConfigId?: string;
    /** Auxiliary API: used for embedding/vector recall (global, not per-character) */
    embeddingApiConfigId?: string;
    /** Auxiliary API: used by the mascot assistant (global, not per-character) */
    mascotApiConfigId?: string;
    /** Auxiliary API: used to translate reasoning/chain-of-thought text (global, not per-character) */
    reasoningTranslateApiConfigId?: string;
};

// --- Chat Toolbox ---
export type RestToolPackageConfig = {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    builtIn?: boolean;
    createdBy?: "user" | "ai";
    createdAt: number;
    updatedAt: number;
};

export type RestToolConfig = {
    id: string;
    packageId?: string;
    name: string;
    description: string;
    endpoint: string;
    method: "GET" | "POST";
    headers?: Record<string, string>;
    bodyTemplate?: string;        // Optional JSON body template with {{param}} placeholders
    parameterSchema: string;       // JSON Schema for LLM-visible params only
    fixedParams?: Record<string, string>;  // auto-injected params (api_key etc), hidden from LLM
    enabled: boolean;
    builtIn?: boolean;
    directFetch?: boolean;         // true = browser direct fetch, false = server proxy
    createdBy?: "user" | "ai";
    createdAt: number;
    updatedAt: number;
};

export type CompositeToolStep = {
    id: string;
    name?: string;
    toolType?: "auto" | "rest" | "internal" | "mcp" | "composite" | "script";
    toolId?: string;
    serverId?: string;
    toolName?: string;
    argsTemplate?: string;        // JSON object template. Supports {{input.xxx}}, {{steps.key.data}}, {{last.data}}
    script?: string;              // Arbitrary async JS for script steps. Receives input, steps, last, args, context.
    saveAs?: string;
};

export type CompositeToolPackageConfig = {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    builtIn?: boolean;
    createdBy?: "user" | "ai";
    createdAt: number;
    updatedAt: number;
};

export type CompositeToolConfig = {
    id: string;
    packageId?: string;
    name: string;
    description: string;
    parameterSchema: string;
    steps: CompositeToolStep[];
    outputTemplate?: string;
    enabled: boolean;
    builtIn?: boolean;
    createdBy?: "user" | "ai";
    createdAt: number;
    updatedAt: number;
};

export type McpDiscoveredTool = {
    name: string;
    description: string;
    inputSchema: object;
};

export type McpServerConfig = {
    id: string;
    name: string;
    description?: string;
    url: string;
    enabled: boolean;
    headers?: Record<string, string>;
    discoveredTools?: McpDiscoveredTool[];
    // Session state (runtime, not persisted across page refresh)
    sessionId?: string;
    // OAuth tokens (persisted)
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
    oauthClientId?: string;
    oauthClientSecret?: string;
    oauthTokenEndpoint?: string;
    oauthAuthorizationEndpoint?: string;
    oauthRegistrationEndpoint?: string;
    oauthAuthorizationServer?: string;
    oauthProtectedResourceMetadataUrl?: string;
    createdAt: number;
    updatedAt: number;
};

// --- Internal Capabilities ---
export type InternalCapabilityMode = "off" | "confirm" | "auto";

export type InternalCapabilityConfig = {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    mode: InternalCapabilityMode;
    createdAt: number;
    updatedAt: number;
};

/** 联网搜索能力的渠道配置（跟随 InternalCapabilityConfig 存储扩展，缺省字段向后兼容） */
export type WebSearchCapabilitySettings = {
    /** tavily = 官方预设渠道；custom = 自定义兼容渠道 */
    provider: "tavily" | "custom";
    /** Tavily API Key（provider=tavily 时使用） */
    tavilyApiKey?: string;
    /** 自定义渠道（provider=custom 时使用）：POST JSON 返回 { results: [{ title, url, content }] } */
    customEndpoint?: string;
    customApiKey?: string;
    /** 自定义渠道的鉴权头名称，默认 Authorization */
    customAuthHeader?: string;
};
