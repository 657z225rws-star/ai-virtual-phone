const CACHE_VERSION = "ai-phone-pwa-v7";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const PRECACHE_URLS = [
  "/",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => !key.startsWith(CACHE_VERSION))
          .map((key) => caches.delete(key))
      ))
      // 刷新预缓存的 "/" 快照：它是离线导航的最终兜底，若停留在旧部署版本，
      // 引用的旧 hash CSS/JS 已 404，会渲染出无样式页面（文字堆在左上角）。
      .then(() => caches.open(STATIC_CACHE))
      .then((cache) => cache.add(new Request("/", { cache: "reload" })).catch(() => {}))
      .then(() => self.clients.claim())
  );
});

function isCacheableRequest(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/api/")) return false;
  if (url.pathname.startsWith("/_next/static/")) return true;
  return ["font", "image", "script", "style", "worker"].includes(request.destination);
}

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    const fallback = await caches.match("/");
    if (fallback) return fallback;
    throw error;
  }
}

// 静态资源（字体/图片/脚本/样式/模型）用 cache-first：命中缓存直接返回，
// 不再每次都在后台把整份文件重新拉一遍校验。字体动辄 7~24MB，旧的
// stale-while-revalidate 会持续重下，是带宽爆掉的主因之一。
// 需要更新缓存内容时，升 CACHE_VERSION 即可让旧缓存在 activate 时清空。
async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

// ── 主动消息推送 ──
// 消息文本由云端 Worker 生成好放在 payload 里（{type:'amsg', title, body, characterId}），
// 这里只负责弹通知 + 通知页面去拉收件箱。app 没开时页面那半不会跑，但消息已经落在云端收件箱，
// 下次打开 app 会补进来，所以推送丢了也不会丢消息。
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || "新消息";
  const body = payload.body || "";
  const options = {
    body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: payload.taskId ? `amsg-${payload.taskId}` : `amsg-${Date.now()}`,
    renotify: true,
    data: { url: "/", characterId: payload.characterId || null },
  };

  event.waitUntil(
    self.registration.showNotification(title, options).then(async () => {
      try {
        const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const client of clients) client.postMessage({ type: "amsg-push", payload });
      } catch {
        /* 没有页面在跑就算了，收件箱兜底 */
      }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          return client.focus().catch(() => {});
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }
  if (isCacheableRequest(request)) {
    event.respondWith(cacheFirst(request));
  }
});
