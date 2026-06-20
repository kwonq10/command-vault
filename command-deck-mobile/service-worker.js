// service-worker.js — Command Deck PWA
const CACHE_NAME = 'command-deck-v2';

// オフライン時にキャッシュから返すファイル一覧
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// ─── Install: 静的ファイルを事前キャッシュ ───────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  // 新しい SW をすぐに有効化
  self.skipWaiting();
});

// ─── Activate: 古いキャッシュを削除 ─────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  // 既存のクライアントをすぐ制御下に置く
  self.clients.claim();
});

// ─── Fetch: Network First → Cache Fallback ──────────────────────
self.addEventListener('fetch', (event) => {
  // Chrome拡張など chrome-extension:// スキームは無視
  if (!event.request.url.startsWith('http')) return;

  // Firebase / Fonts などの外部リクエストはネットワーク優先・失敗時はキャッシュ
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // 正常レスポンスをキャッシュに保存してから返す
        if (
          response.ok &&
          event.request.method === 'GET' &&
          !event.request.url.includes('firestore.googleapis.com')
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // ネットワーク失敗 → キャッシュから返す
        return caches.match(event.request).then(
          (cached) => cached || caches.match('/index.html')
        );
      })
  );
});
