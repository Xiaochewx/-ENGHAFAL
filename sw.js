/**
 * Service Worker - 不背英语 PWA 离线服务工作线程
 * 
 * 功能：
 * 1. 预缓存核心静态资产 (HTML, JS, 词库, 图标, Tailwind CDN)
 * 2. 离线拦截策略：Stale-While-Revalidate + Cache-First 动静结合
 * 3. 导航离线兜底：断网时刷新或进入页面依然秒级加载已缓存的 index.html
 */

const CACHE_NAME = 'bubei-vocab-pwa-v10';

// 核心预缓存资源列表（仅包含同源高稳定静态资源，避免跨域 CDN 在 install 阶段因 CORS 报错）
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './data-service.js',
  './words.js',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

// 监听客户端 skipWaiting 消息，支持无缝版本热更新
self.addEventListener('message', (event) => {
  if (event.data && event.data.action === 'skipWaiting') {
    self.skipWaiting();
  }
});

// 1. Install 阶段：预缓存核心静态资源并跳过等待
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const asset of PRECACHE_ASSETS) {
        try {
          await cache.add(asset);
        } catch (err) {
          console.warn('[SW] 预缓存资源跳过:', asset, err);
        }
      }
    }).then(() => self.skipWaiting())
  );
});

// 2. Activate 阶段：清除旧版本缓存，立即接管所有客户端页面
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] 清理过期的旧缓存版本:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 3. Fetch 阶段：拦截请求并应用离线策略
self.addEventListener('fetch', (event) => {
  const request = event.request;

  // 仅处理 GET 请求以及 http/https 协议
  if (request.method !== 'GET' || !request.url.startsWith('http')) {
    return;
  }

  // 策略 A：HTML 导航请求 (网页入口) -> 网络优先，网络故障时回退至本地缓存 index.html
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
          }
          return networkResponse;
        })
        .catch(async () => {
          const cached = await caches.match('./index.html') || await caches.match('./');
          if (cached) return cached;
          return new Response('离线状态：请确认曾打开过应用', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        })
    );
    return;
  }

  // 策略 B：静态资源 (JS/CSS/CDN/图片/数据) -> Stale-While-Revalidate
  // 优先从 Cache 返回提升秒开速度，同时后台静默向网络拉取并更新缓存
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
          }
          return networkResponse;
        })
        .catch(() => {
          // 网络异常时不抛出错误，继续以缓存为主
          return cachedResponse;
        });

      return cachedResponse || fetchPromise;
    })
  );
});
