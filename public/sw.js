// Orion service worker — offline-capable app shell, never caches the API.
'use strict';

const VERSION = 'orion-v6';
const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/js/dictation.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];
// App code: always try the network first so deploys land without a hard
// refresh; fall back to cache when offline. Icons are immutable blobs,
// so they stay cache-first.
const NETWORK_FIRST = new Set(['/', '/index.html', '/css/app.css', '/js/app.js', '/js/dictation.js', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL).catch(() => {})) // icons may not exist yet
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  // API traffic is always live — never serve or store it.
  if (url.pathname.startsWith('/api/')) return;
  // Vault secret forms are single-use: a cached copy could render a dead form.
  if (url.pathname.startsWith('/vault/')) return;
  // Never cache-bust the query string off cache lookups for versioned assets.
  if (NETWORK_FIRST.has(url.pathname)) {
    event.respondWith(
      fetch(event.request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        }
        return res;
      }).catch(() => caches.match(event.request).then((cached) => {
        if (cached) return cached;
        throw new Error('offline');
      }))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request, { ignoreSearch: false }).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        // Cache successful same-origin GETs for offline use.
        if (res && res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        }
        return res;
      });
    })
  );
});

// ---- push notifications -----------------------------------------------------
self.addEventListener('push', (event) => {
  let data = { title: 'Orion', body: 'Something needs your attention.', url: '/' };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch { /* malformed payload: show the fallback */ }
  // Per-conversation notification tags: concurrent pings from different
  // chats no longer collapse into one. Falls back to the shared tag when
  // the payload carries no conversation reference.
  const convId = data.conversation_id || data.conversationId ||
    (String(data.url || '').match(/\/chat\/([^\/?#]+)/) || [])[1];
  event.waitUntil(
    self.registration.showNotification(data.title || 'Orion', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || (convId ? 'orion-chat-' + convId : 'orion-note'),
      renotify: true,
      // No requireInteraction: pings behave like normal notifications and
      // auto-dismiss instead of camping on screen until closed.
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus an already-open Orion tab if there is one, and take it to the chat.
      for (const c of clients) {
        if (c.url.includes(self.location.origin) && 'focus' in c) {
          c.focus();
          c.postMessage({ type: 'orion-navigate', url });
          return;
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

// Deep-link pings from an open tab's push handler: the service worker routes
// them to the router through the focused client above.
