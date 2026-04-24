/* ================================================================
   ITS Driver — Service Worker
   - Cache offline per sezione /driver
   - Ricezione notifiche push
   - Gestione click notifica
================================================================ */

const CACHE_NAME = 'its-driver-v1';
const OFFLINE_PAGE = '/driver';

// ---------------------------------------------------------------- install
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll([OFFLINE_PAGE]))
      .then(() => self.skipWaiting())
  );
});

// ---------------------------------------------------------------- activate
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------- fetch
// Network-first per la sezione driver; cache come fallback offline
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith('/driver') && !url.pathname.startsWith('/api/ops/driver-data')) return;
  // Lascia passare le richieste interne di Next.js (RSC, prefetch, data routes)
  if (url.pathname.startsWith('/_next/') || url.searchParams.has('_rsc') || url.searchParams.has('__nextSuspense')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Metti in cache solo le risposte HTML della pagina driver
        if (response.ok && url.pathname.startsWith('/driver') && !url.pathname.includes('.')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached ?? caches.match(OFFLINE_PAGE)))
  );
});

// ---------------------------------------------------------------- push
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'ITS Driver', body: event.data.text() };
  }

  const title = payload.title || 'ITS Driver';
  const isSlaAlert = String(payload.tag || '').startsWith('sla-');

  const options = {
    body: payload.body || '',
    icon: '/brand/logo-ischia-transfer-email.png',
    badge: '/brand/logo-ischia-transfer-email.png',
    data: { url: payload.url || '/driver', isSlaAlert },
    vibrate: isSlaAlert
      ? [500, 100, 500, 100, 500, 100, 500]
      : [200, 100, 200, 100, 200],
    requireInteraction: true,
    tag: payload.tag || 'its-driver-notification',
    renotify: true,
    actions: payload.url
      ? [{ action: 'open', title: 'Apri' }, { action: 'dismiss', title: 'Ignora' }]
      : []
  };

  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    if (isSlaAlert) {
      try {
        const bc = new BroadcastChannel('its-sla');
        bc.postMessage({ type: 'sla_alert', title, body: payload.body || '' });
        bc.close();
      } catch (_) { /* BroadcastChannel non disponibile */ }
    }
  })());
});

// ---------------------------------------------------------------- notificationclick
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || '/driver';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        // Trova finestra già aperta sulla sezione driver
        for (const client of windowClients) {
          if (client.url.includes('/driver') && 'focus' in client) {
            void client.navigate(targetUrl);
            return client.focus();
          }
        }
        // Nessuna finestra aperta: aprine una nuova
        return self.clients.openWindow(targetUrl);
      })
  );
});

// ---------------------------------------------------------------- message
// Canale per forzare un aggiornamento del SW dal client
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
