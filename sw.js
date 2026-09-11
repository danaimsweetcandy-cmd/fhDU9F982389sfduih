const CACHE_NAME = "worklog-cache-v5";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Apps Script 요청은 네트워크 우선, 실패 시 통과(오프라인 큐는 app.js가 처리)
  if (url.hostname.includes("script.google.com")) {
    event.respondWith(
      fetch(event.request).catch(() => new Response(JSON.stringify({ ok: false, logs: [], reflections: {} }), { headers: { "Content-Type": "application/json" } }))
    );
    return;
  }

  // 앱 셸은 캐시 우선
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
