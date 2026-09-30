// lib/weather.ts
// 「体感」感知层：把真实天气降维成身体感受的维度标签，措辞交给模型当场自己写。
//
// 三条硬规则（整个模块的设计红线）：
// 1. 不出地名——定位只取经纬度并四舍五入到约 1 公里，全程不反查、不缓存、不注入任何城市名。
// 2. 不出数字——气温/湿度/风速只在本模块内部流动，注入给模型的文本里没有任何数值。
// 3. 不替模型造句——本地只给「很热/潮/没风/阴」这类日常白话标签（事实，非台词、
//    不造修饰词、不掺情绪），具体怎么开口由模型结合角色语气自己写，避免每天同一句话术。
//    另配禁用词规则压住"念天气预报"的腔调。
//
// 数据来源：Open-Meteo（免费、无需注册、无需 API key、CORS 全开，浏览器可直连）。
// 定位失败（拒绝授权/超时/不支持）一律静默跳过，聊天完全不受影响。

import { loadChatAppSettings } from "./chat-storage";

const WX_FEEL_CACHE_KEY = "ai_phone_weather_feel_v2";
const WX_COORD_KEY = "ai_phone_weather_coord_v2";

/** 体感缓存时长：10 分钟（天气是 15 分钟一步的模式值，取太密没有意义） */
const CACHE_MS = 10 * 60 * 1000;
/** 坐标缓存时长：6 小时（人不会瞬移；超过重新定位，兼顾出差旅行） */
const COORD_MS = 6 * 60 * 60 * 1000;
/** 注入提示词时最多等多久；超时本轮跳过，后台继续跑完写缓存 */
const PROMPT_WAIT_MS = 4000;
/** 单个网络请求超时 */
const FETCH_TIMEOUT_MS = 6000;
/** 与上一条消息间隔超过这么久，就算作新一段对话的「开场」 */
export const WEATHER_OPENING_GAP_MS = 6 * 60 * 60 * 1000;

export type WeatherFeel = {
    /** 降维后的感受维度标签（不含地名与数字）；措辞由模型自己写 */
    spec: FeelSpec;
    /** 定位精度（米），仅用于设置页展示，不注入 */
    accuracyM: number | null;
    /** 取到数据的时间戳 */
    updatedAt: number;
};

export type WeatherFeelStatus =
    | { state: "ok"; feel: WeatherFeel }
    | { state: "disabled" }
    | { state: "idle" }          // 还没定位过（设置页不主动弹授权）
    | { state: "denied" }        // 用户明确拒绝了定位
    | { state: "ignored" }       // 授权弹窗没被处理（被忽略/关掉/一直没点）
    | { state: "unavailable" }   // 定位超时 / 定位服务不可用
    | { state: "unsupported" }   // 环境不支持定位（如非安全上下文、服务端）
    | { state: "error" };        // 定位成功但天气请求失败

// ──────────────────────────── 基础工具 ────────────────────────────

function lsGet(key: string): string | null {
    try {
        if (typeof window === "undefined" || !window.localStorage) return null;
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function lsSet(key: string, value: string): void {
    try {
        if (typeof window === "undefined" || !window.localStorage) return;
        window.localStorage.setItem(key, value);
    } catch {
        /* 存储不可用时静默跳过，天气属于锦上添花 */
    }
}

function lsRemove(key: string): void {
    try {
        if (typeof window === "undefined" || !window.localStorage) return;
        window.localStorage.removeItem(key);
    } catch { /* noop */ }
}

function readJsonLS<T>(key: string): T | null {
    const raw = lsGet(key);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

/** 带超时的 fetch：任何卡住的请求最多占用 FETCH_TIMEOUT_MS */
async function fetchJsonWithTimeout<T>(url: string): Promise<T | null> {
    if (typeof fetch !== "function") return null;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
        if (!res.ok) return null;
        return (await res.json()) as T;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ──────────────────────────── 开关 ────────────────────────────

/** 开关在设置面板（默认开启） */
export function isWeatherEnabled(): boolean {
    return loadChatAppSettings().weatherAware !== false;
}

// ──────────────────────────── 定位（只取坐标，不要地名） ────────────────────────────

type Coords = { latitude: number; longitude: number; accuracyM: number | null };
type LocateFailure = "denied" | "unavailable" | "unsupported";

let lastLocateFailure: LocateFailure | null = null;
let inflightLocate: Promise<Coords | null> | null = null;

function readCachedCoords(): Coords | null {
    const cached = readJsonLS<{ coords: Coords; ts: number }>(WX_COORD_KEY);
    if (!cached || typeof cached.ts !== "number") return null;
    if (Date.now() - cached.ts >= COORD_MS) return null;
    return cached.coords ?? null;
}

function locateOnce(): Promise<Coords | null> {
    if (inflightLocate) return inflightLocate;
    inflightLocate = new Promise<Coords | null>(resolve => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            lastLocateFailure = "unsupported";
            resolve(null);
            return;
        }
        navigator.geolocation.getCurrentPosition(
            pos => {
                // 四舍五入到约 1 公里：天气格点用不到更高精度，隐私上也更稳妥
                const coords: Coords = {
                    latitude: Math.round(pos.coords.latitude * 100) / 100,
                    longitude: Math.round(pos.coords.longitude * 100) / 100,
                    accuracyM: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null,
                };
                lsSet(WX_COORD_KEY, JSON.stringify({ coords, ts: Date.now() }));
                lastLocateFailure = null;
                resolve(coords);
            },
            err => {
                lastLocateFailure = err.code === 1 ? "denied" : err.code === 3 ? "unavailable" : "unavailable";
                resolve(null);
            },
            // 天气不需要高精度：WiFi 级定位更快更省电，且完全不受 VPN / 代理影响
            { enableHighAccuracy: false, timeout: 8000, maximumAge: COORD_MS },
        );
    }).then(result => {
        inflightLocate = null;
        return result;
    });
    return inflightLocate;
}

async function resolveCoords(allowPrompt: boolean): Promise<Coords | null> {
    const cached = readCachedCoords();
    if (cached) return cached;
    if (!allowPrompt) return null;
    return locateOnce();
}

// ──────────────────────────── 取原始数据 ────────────────────────────

type RawWeather = {
    temperature: number;   // 气温 °C（冷热档位按它划）
    apparent: number;      // 体感温度 °C（仅保留作参考，不参与档位）
    humidity: number;      // 相对湿度 %
    wind: number;          // 风速 m/s
    gust: number;          // 阵风 m/s
    code: number;          // WMO 天气码
    precipNow: number;     // 当前降水量 mm
    precipPast3h: number;  // 近 3 小时降水量 mm
    precipPast6h: number;  // 近 6 小时降水量 mm
    isDay: boolean;
};

async function fetchRawWeather(coords: Coords): Promise<RawWeather | null> {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.latitude}&longitude=${coords.longitude}`
        + "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m,precipitation,is_day"
        + "&hourly=precipitation&past_hours=6&forecast_hours=1&timezone=auto";
    const data = await fetchJsonWithTimeout<{
        current?: Record<string, number>;
        hourly?: { precipitation?: number[] };
    }>(url);
    const cur = data?.current;
    if (!cur || typeof cur.temperature_2m !== "number") return null;

    const series = (data?.hourly?.precipitation ?? []).filter((n): n is number => typeof n === "number");
    const tail = (count: number) => series.slice(Math.max(0, series.length - count));
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

    return {
        temperature: Math.round(cur.temperature_2m),
        apparent: Math.round(cur.apparent_temperature ?? cur.temperature_2m),
        humidity: Math.round(cur.relative_humidity_2m ?? 0),
        wind: Number.isFinite(cur.wind_speed_10m) ? cur.wind_speed_10m : 0,
        gust: Number.isFinite(cur.wind_gusts_10m) ? cur.wind_gusts_10m : 0,
        code: Number.isFinite(cur.weather_code) ? cur.weather_code : 0,
        precipNow: Number.isFinite(cur.precipitation) ? cur.precipitation : 0,
        precipPast3h: sum(tail(3)),
        precipPast6h: sum(tail(6)),
        isDay: cur.is_day === 1,
    };
}

// ──────────────────────────── 降维层：数字 → 白话单字 ────────────────────────────
// 这里是"不出数字"的关键：数值只在本文件内部流动。
// 出去的全是日常白话里就有的单字（很热/热/潮/没风/阴），
// 不造修饰词（不用"偏重""较重""显著"这类没人这么说的词），不成句，也不掺情绪
// （"难受""难受"这种判断留给模型自己下）。具体怎么开口由模型自己写。

export type FeelSpec = {
    /** 冷热，只用日常说法：热得吓人 / 酷热 / 很热 / 热 / 有点热 / 不冷不热 / 凉 / 冷 / 很冷 / 冻手冻脚 / 冷得刺骨
     *  狂风天不报冷热（那时候没人关心几度），此时为 null */
    thermal: string | null;
    /** 潮湿：很潮湿 / 潮湿 / 干燥；正常时留空，不必说 */
    moisture: string | null;
    /** 风：狂风 / 风很大 / 风大 / 有风 / 没风；普通时留空 */
    wind: string | null;
    /** 降水：下着小雨 / 刚停过，地上还湿 / 在打雷 …… */
    precipitation: string | null;
    /** 天：晴 / 多云 / 阴 / 有雾 */
    sky: string | null;
};

// 冷热档位按【气温】划，不按体感温度：
// 体感在潮湿天会比气温高 5~7 度（实测：气温 30°C、湿度 69% 时体感 36°C），
// 若按体感划档，用户在天气 App 上看到的 33°C 会被说成"热得吓人"，与直觉不符。
// 湿度带来的"闷"由 moisture 维度单独体现，交给模型自己组合。
function thermalLabel(temperature: number): string {
    if (temperature >= 40) return "热得吓人";
    if (temperature >= 36) return "酷热";
    if (temperature >= 32) return "很热";
    if (temperature >= 28) return "热";
    if (temperature >= 24) return "有点热";
    if (temperature >= 20) return "不冷不热";
    if (temperature >= 15) return "凉";
    if (temperature >= 9) return "冷";
    if (temperature >= 3) return "很冷";
    if (temperature >= -4) return "冻手冻脚";
    return "冷得刺骨";
}

function moistureLabel(weather: RawWeather): string | null {
    if (weather.humidity >= 85) return "很潮湿";
    if (weather.humidity >= 75) return "潮湿";
    if (weather.humidity <= 35) return "干燥";
    return null;
}

function windLabel(wind: number, gust: number): string | null {
    // 阵风更能反映"狂风"体感；台风级别只能靠风速推断，无法确认是不是台风
    if (wind >= 24.5 || gust >= 32.7) return "狂风";
    if (wind >= 17.2) return "风很大";
    if (wind >= 10.8) return "风大";
    if (wind >= 6.5) return "有风";
    if (wind <= 1.5) return "没风";
    return null;
}

function precipitationLabel(weather: RawWeather, now: Date): string | null {
    const { code } = weather;
    if ([99].includes(code)) return "下着冰雹";
    if ([96].includes(code)) return "在打雷，下着冰雹";
    if ([95].includes(code)) return "在打雷";
    if ([66, 67, 56, 57].includes(code)) return "下着冻雨";
    if ([51, 53, 55, 61, 80].includes(code)) return "下着小雨";
    if ([63, 81].includes(code)) return "下着雨";
    if ([65].includes(code)) return "下着大雨";
    if ([82].includes(code)) return "下着暴雨";
    if ([71, 73, 77, 85].includes(code)) return "在下雪";
    if ([75, 86].includes(code)) return "下着大雪";
    if (weather.precipNow > 0) return "在下雨";
    if (weather.precipPast3h >= 0.3) return now.getHours() < 11 ? "昨晚下过，地上还湿" : "刚停过，地上还湿";
    if (weather.precipPast6h >= 0.8) return "地上还是湿的";
    return null;
}

function skyLabel(weather: RawWeather): string | null {
    if ([45, 48].includes(weather.code)) return "有雾";
    if (weather.code === 3) return "阴";
    if (weather.code === 2) return "多云";
    if (weather.code === 0 && weather.isDay) return "晴";
    return null;
}

/** 原始天气 → 白话标签（不含地名、不含数字、不成句） */
function buildFeelSpec(weather: RawWeather, now: Date): FeelSpec {
    const precipitation = precipitationLabel(weather, now);
    const wind = windLabel(weather.wind, weather.gust);
    return {
        // 狂风天（台风级）不报冷热：那时候"有点热"是噪音
        thermal: wind === "狂风" ? null : thermalLabel(weather.temperature),
        moisture: moistureLabel(weather),
        wind,
        precipitation,
        // 已经在说下雨/下雪时就不再单独描述天空，避免信息重复
        sky: precipitation ? null : skyLabel(weather),
    };
}

/**
 * 把标签拼成一行大白话，例如「热、很潮、没风、阴」。
 * 注入文本和设置页预览共用这个函数，保证两边完全一致。
 */
export function feelSummary(spec: FeelSpec): string {
    return [spec.thermal, spec.moisture, spec.wind, spec.precipitation, spec.sky]
        .filter((part): part is string => Boolean(part))
        .join("、");
}

/** 注入时轮换的表达倾向，避免每次开场都是同一种口气 */
const STYLE_HINTS = [
    "随口一句就行，不用展开。",
    "可以顺带关心一下对方。",
    "像自己小声嘀咕一句。",
];

function pickStyleHint(now: Date): string {
    // 按半小时轮换：同一时段内稳定，不同时段自然换口气
    return STYLE_HINTS[Math.floor(now.getTime() / (30 * 60 * 1000)) % STYLE_HINTS.length];
}

// ──────────────────────────── 体感缓存与获取 ────────────────────────────

type FeelCache = { feel: WeatherFeel; ts: number };

function readFreshFeel(): WeatherFeel | null {
    const cached = readJsonLS<FeelCache>(WX_FEEL_CACHE_KEY);
    if (!cached || typeof cached.ts !== "number" || !cached.feel) return null;
    if (Date.now() - cached.ts >= CACHE_MS) return null;
    return cached.feel;
}

let inflightFeel: Promise<WeatherFeel | null> | null = null;

async function loadFeel(allowPrompt: boolean): Promise<WeatherFeel | null> {
    if (!isWeatherEnabled()) return null;
    const cached = readFreshFeel();
    if (cached) return cached;
    if (inflightFeel) return inflightFeel;

    inflightFeel = (async () => {
        const coords = await resolveCoords(allowPrompt);
        if (!coords) return null;
        const raw = await fetchRawWeather(coords);
        if (!raw) return null;
        const feel: WeatherFeel = {
            spec: buildFeelSpec(raw, new Date()),
            accuracyM: coords.accuracyM,
            updatedAt: Date.now(),
        };
        lsSet(WX_FEEL_CACHE_KEY, JSON.stringify({ feel, ts: Date.now() } satisfies FeelCache));
        return feel;
    })().then(result => {
        inflightFeel = null;
        return result;
    });

    return inflightFeel;
}

/** 同步读取已有缓存（不触发定位、不发请求），设置页首屏用 */
export function peekCachedFeel(): WeatherFeel | null {
    return readFreshFeel();
}

/** 查询浏览器定位权限状态；不支持 Permissions API 的环境返回 "unknown" */
async function queryGeoPermission(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
    try {
        const permissions = typeof navigator !== "undefined" ? (navigator as Navigator & { permissions?: Permissions }).permissions : undefined;
        if (!permissions?.query) return "unknown";
        const status = await permissions.query({ name: "geolocation" as PermissionName });
        return status.state as "granted" | "denied" | "prompt";
    } catch {
        return "unknown";
    }
}

/**
 * 供设置页使用：区分「没授权」「弹窗被忽略」「不支持」「请求失败」等状态，便于给出人话提示。
 * allowPrompt=false 时绝不弹定位授权，只用已有缓存。
 */
export async function getWeatherFeelStatus(allowPrompt: boolean): Promise<WeatherFeelStatus> {
    if (!isWeatherEnabled()) return { state: "disabled" };
    const cached = readFreshFeel();
    if (cached) return { state: "ok", feel: cached };
    if (!allowPrompt && !readCachedCoords()) return { state: "idle" };

    const feel = await loadFeel(allowPrompt);
    if (feel) return { state: "ok", feel };
    if (lastLocateFailure === "denied") return { state: "denied" };
    if (lastLocateFailure === "unsupported") return { state: "unsupported" };

    // 有坐标 → 说明定位成功过，失败的是天气请求
    if (readCachedCoords()) return { state: "error" };

    // 没坐标：分清是"明确拒绝"还是"弹窗没被处理"，这两种处理方式完全不同
    const permission = await queryGeoPermission();
    if (permission === "denied") return { state: "denied" };
    if (permission === "prompt") return { state: "ignored" };
    return { state: "unavailable" };
}

// ──────────────────────────── 开场判定与注入块 ────────────────────────────

type HistoryLike = { role?: string | null; createdAt?: string | null };

function partOfDay(hour: number): string {
    if (hour < 5) return "深夜";
    if (hour < 9) return "早上";
    if (hour < 12) return "上午";
    if (hour < 14) return "中午";
    if (hour < 18) return "下午";
    if (hour < 23) return "晚上";
    return "深夜";
}

/**
 * 判断这一轮是不是「对话开场」，并给出开场语境。
 * 返回 null 表示不是开场 —— 此时整块体感都不注入，这是"不复读"的关键闸门。
 *
 * 规则（和用户确认过的频率一致）：跨天，或距角色上一次开口超过 6 小时，才算开场。
 *
 * 注意这里刻意只看「角色自己上一条回复」的时间，不看最后一条消息：
 * 调用方传进来的 history 已经包含用户刚发的那条（createdAt ≈ 现在），
 * 若按最后一条消息判断，闸门会永远不触发。
 */
export function describeWeatherOpening(history: HistoryLike[], now: Date = new Date()): string | null {
    const hour = now.getHours();
    const when = partOfDay(hour);
    const lastSpoken = [...history].reverse().find(item => item?.role === "assistant" && item?.createdAt);
    if (!lastSpoken?.createdAt) {
        // 新会话 / 还没聊过
        return `现在是${when}。`;
    }
    const lastTs = new Date(lastSpoken.createdAt).getTime();
    if (!Number.isFinite(lastTs)) return null;

    const sameDay = new Date(lastTs).toDateString() === now.toDateString();
    const gap = now.getTime() - lastTs;

    if (sameDay) {
        if (gap < WEATHER_OPENING_GAP_MS) return null;
        return `你们隔了几个小时没说话了，现在是${when}。`;
    }
    return hour >= 5 && hour < 11
        ? "现在是早上，你们今天还没说过话。"
        : `你们隔了一天没聊，现在是${when}。`;
}

// ──────────────────────────── 状态变化检测（可选注入） ────────────────────────────
// 开场注入完整状态后，把"模型此刻已经知道的状态"按会话记下来；
// 之后的轮次只有真正发生变化时才补一句，避免每轮重复同一句天气。

const WX_KNOWN_KEY = "ai_phone_weather_known_v2";
/** 只记最近这么多个会话，避免本地存储无限膨胀 */
const KNOWN_SESSION_LIMIT = 30;

type KnownFeel = { spec: FeelSpec; ts: number };

function readKnownFeelMap(): Record<string, KnownFeel> {
    return readJsonLS<Record<string, KnownFeel>>(WX_KNOWN_KEY) ?? {};
}

function rememberFeel(sessionId: string | undefined, feel: WeatherFeel): void {
    if (!sessionId) return;
    try {
        const map = readKnownFeelMap();
        map[sessionId] = { spec: feel.spec, ts: Date.now() };
        const kept = Object.entries(map)
            .sort((a, b) => (b[1]?.ts ?? 0) - (a[1]?.ts ?? 0))
            .slice(0, KNOWN_SESSION_LIMIT);
        lsSet(WX_KNOWN_KEY, JSON.stringify(Object.fromEntries(kept)));
    } catch {
        /* 记不住就算了，最坏只是少一次变化提示 */
    }
}

const THERMAL_RANK: Record<string, number> = {
    "冷得刺骨": 0, "冻手冻脚": 1, "很冷": 2, "冷": 3, "凉": 4,
    "不冷不热": 5, "有点热": 6, "热": 7, "很热": 8, "酷热": 9, "热得吓人": 10,
};
const WIND_RANK: Record<string, number> = { "没风": 0, "有风": 1, "风大": 2, "风很大": 3, "狂风": 4 };

const PRECIP_START_TEXT: Record<string, string> = {
    "下着小雨": "外面开始下小雨了",
    "下着雨": "外面开始下雨了",
    "下着大雨": "外面开始下大雨了",
    "下着暴雨": "外面下起暴雨了",
    "下着冻雨": "外面下起冻雨了",
    "下着冰雹": "外面下起冰雹了",
    "在打雷，下着冰雹": "外面又打雷又下冰雹",
    "在打雷": "外面打雷了",
    "在下雪": "外面开始下雪了",
    "下着大雪": "外面下起大雪了",
    "昨晚下过，地上还湿": "刚下过雨，地上还湿着",
    "刚停过，地上还湿": "雨刚停，地上还湿着",
    "地上还是湿的": "地上还是湿的",
};

const SKY_CHANGE_TEXT: Record<string, string> = {
    "晴": "天放晴了",
    "阴": "天阴下来了",
    "多云": "云多起来了",
    "有雾": "起雾了",
};

function precipStopText(prev: string): string {
    if (prev.includes("雪")) return "雪停了";
    if (prev.includes("冰雹")) return "冰雹停了";
    if (prev.includes("打雷")) return "雷声停了";
    if (prev.includes("冻雨")) return "冻雨停了";
    return "雨停了";
}

/**
 * 比对"模型上次知道的状态"和当前状态，只挑人会立刻察觉的变化。
 * 温度在档位内浮动不算变化；最多返回两条，保持注入文本极短。
 */
function diffFeel(prev: FeelSpec | null, next: FeelSpec): string[] {
    if (!prev) return [];
    const notes: string[] = [];

    if (prev.precipitation !== next.precipitation) {
        if (next.precipitation && !prev.precipitation) {
            notes.push(PRECIP_START_TEXT[next.precipitation] ?? "外面下起雨了");
        } else if (!next.precipitation && prev.precipitation) {
            notes.push(precipStopText(prev.precipitation));
        } else if (next.precipitation && prev.precipitation) {
            notes.push(PRECIP_START_TEXT[next.precipitation] ?? "雨势变了");
        }
    }

    if (notes.length < 2 && prev.sky !== next.sky && prev.sky && next.sky) {
        notes.push(SKY_CHANGE_TEXT[next.sky] ?? `天${next.sky}了`);
    }

    if (notes.length < 2 && prev.thermal && next.thermal && prev.thermal !== next.thermal) {
        const before = THERMAL_RANK[prev.thermal] ?? 5;
        const after = THERMAL_RANK[next.thermal] ?? 5;
        // 带上主语，不然模型看不出"什么"热起来了
        if (after > before) notes.push("天气变热了");
        else if (after < before) notes.push("天气变凉快了");
    }

    if (notes.length < 2 && prev.wind !== next.wind) {
        const before = prev.wind ? (WIND_RANK[prev.wind] ?? 0) : 0;
        const after = next.wind ? (WIND_RANK[next.wind] ?? 0) : 0;
        if (after > before) notes.push("风变大了");
        else if (after < before) notes.push("风变小了");
    }

    return notes.slice(0, 2);
}

// ──────────────────────────── 注入块 ────────────────────────────

function fullFeelBlock(opening: string, feel: WeatherFeel, now: Date): string {
    return [
        "<此刻的体感>",
        opening,
        `此刻的感觉：${feelSummary(feel.spec)}`,
        "</此刻的体感>",
        "（这是事实，不是要你转述的台词。用你自己的话带出来，别照抄上面的词；不提城市地名，不出现任何数字，也别用「温度」「湿度」「风力」这类说法。）",
        "把它化进开场问候就好，像同城朋友随口一句「起床啦，今天有点热哦」。",
        "只在自然贴着话题时提这一次，之后别再提，也别给穿衣、带伞之类的叮嘱；大多数回复根本不提它。",
        pickStyleHint(now),
    ].join("\n");
}

function changeFeelBlock(notes: string[]): string {
    return [
        "<此刻的体感>",
        `（${notes.join("；")}。这是刚刚发生的变化，想顺口说一句就说，没有自然时机就别提；别提城市地名，别说数字。）`,
        "</此刻的体感>",
    ].join("\n");
}

/**
 * 生成注入 system prompt 的体感块。三种结果：
 * 1. 对话开场（跨天 / 距角色上次开口 ≥6 小时）→ 注入完整状态块；
 * 2. 非开场但状态真的变了 → 只补一条极短的变化提示（雨开始下 / 放晴 / 冷热跨档…）；
 * 3. 其余情况 → 返回 null，一个字都不注入。
 *
 * 注入文本里保证没有地名、没有数字、没有预报口吻。
 * 非开场轮次绝不阻塞回复：缓存过期时只在后台刷新，下一轮才用得上。
 */
export async function getWeatherFeelPromptBlock(params: {
    history: HistoryLike[];
    sessionId?: string;
    now?: Date;
    waitMs?: number;
}): Promise<string | null> {
    const { history, sessionId, now = new Date(), waitMs = PROMPT_WAIT_MS } = params;
    if (!isWeatherEnabled()) return null;

    const opening = describeWeatherOpening(history, now);
    let feel = readFreshFeel();

    if (!feel) {
        if (typeof window === "undefined") return null;
        if (!opening) {
            // 非开场：只后台刷新，绝不拖慢这一轮回复
            void loadFeel(true);
            return null;
        }
        // 开场：最多等 waitMs，超时就这一轮不给，后台继续跑完写缓存
        feel = await Promise.race([
            loadFeel(true),
            new Promise<null>(resolve => setTimeout(() => resolve(null), waitMs)),
        ]);
    }
    if (!feel) return null;

    if (opening) {
        rememberFeel(sessionId, feel);
        return fullFeelBlock(opening, feel, now);
    }

    const previous = sessionId ? readKnownFeelMap()[sessionId]?.spec ?? null : null;
    const notes = diffFeel(previous, feel.spec);
    if (notes.length === 0) return null;
    rememberFeel(sessionId, feel);
    return changeFeelBlock(notes);
}

/** 清掉体感、坐标与"已知状态"缓存（想立刻重新定位/刷新时用） */
export function clearWeatherCache(): void {
    lsRemove(WX_FEEL_CACHE_KEY);
    lsRemove(WX_COORD_KEY);
    lsRemove(WX_KNOWN_KEY);
}

export { clearWeatherCache as clearWeatherFeelCache };
