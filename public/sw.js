/* ================================================================
   ITS Driver - Service Worker
   - Cache offline per /driver e dati /api/ops/driver-data
   - Coda IndexedDB per aggiornamenti stato autista offline
   - Push notifications
================================================================ */

const CACHE_NAME = 'its-driver-v3';
const OFFLINE_PAGE = '/driver';
const DRIVER_DATA_PATH = '/api/ops/driver-data';
const DRIVER_STATUS_PATH = '/api/ops/driver-status';
const DRIVER_DATA_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const DB_NAME = 'its-driver-offline';
const DB_VERSION = 1;
const QUEUE_STORE = 'statusQueue';
const META_HEADER = 'x-its-cached-at';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, callback) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, mode);
    const store = tx.objectStore(QUEUE_STORE);
    const result = callback(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }).finally(() => db.close());
}

async function readQueueFromIndexedDB() {
  return withStore('readonly', (store) => {
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  });
}

async function addToQueue(request) {
  const headers = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = await request.clone().text();
  const row = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    url: request.url,
    options: {
      method: request.method,
      headers,
      body,
      credentials: 'include'
    },
    queuedAt: new Date().toISOString()
  };
  await withStore('readwrite', (store) => store.put(row));
  await broadcastQueueState();
  return row;
}

async function removeFromQueue(id) {
  await withStore('readwrite', (store) => store.delete(id));
  await broadcastQueueState();
}

async function queueCount() {
  const queue = await readQueueFromIndexedDB();
  return queue.length;
}

async function broadcastQueueState() {
  const count = await queueCount().catch(() => 0);
  try {
    const bc = new BroadcastChannel('its-driver-offline');
    bc.postMessage({ type: 'queue-count', count });
    bc.close();
  } catch (_) {
    // BroadcastChannel non disponibile.
  }
  return count;
}

async function syncQueuedRequests() {
  const queue = await readQueueFromIndexedDB();
  for (const row of queue) {
    try {
      const response = await fetch(row.url, row.options);
      if (response.ok) await removeFromQueue(row.id);
    } catch (_) {
      // Rimane in coda per il prossimo tentativo.
    }
  }
  return broadcastQueueState();
}

function withCachedAt(response) {
  const headers = new Headers(response.headers);
  headers.set(META_HEADER, String(Date.now()));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function cachedAt(response) {
  const raw = response.headers.get(META_HEADER);
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) ? value : 0;
}

async function cacheDriverData(request) {
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, withCachedAt(response.clone()));
  }
  return response;
}

async function handleDriverData(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached && Date.now() - cachedAt(cached) < DRIVER_DATA_MAX_AGE_MS) {
    eventWait(cacheDriverData(request));
    return cached;
  }
  try {
    return await cacheDriverData(request);
  } catch (_) {
    if (cached) return cached;
    return Response.json({ ok: false, error: 'Offline: dati driver non ancora disponibili.' }, { status: 503 });
  }
}

function eventWait(promise) {
  promise.catch(() => undefined);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll([OFFLINE_PAGE]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method === 'POST' && url.pathname === DRIVER_STATUS_PATH) {
    event.respondWith((async () => {
      try {
        return await fetch(event.request.clone());
      } catch (_) {
        await addToQueue(event.request);
        return Response.json({ ok: true, queued: true }, { status: 202 });
      }
    })());
    return;
  }

  if (event.request.method !== 'GET') return;
  if (!url.pathname.startsWith('/driver') && url.pathname !== DRIVER_DATA_PATH) return;
  if (url.pathname.startsWith('/_next/') || url.searchParams.has('_rsc') || url.searchParams.has('__nextSuspense')) return;

  if (url.pathname === DRIVER_DATA_PATH) {
    event.respondWith(handleDriverData(event.request));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && url.pathname.startsWith('/driver') && !url.pathname.includes('.')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached ?? caches.match(OFFLINE_PAGE)))
  );
});

self.addEventListener('online', (event) => {
  const syncPromise = syncQueuedRequests();
  if (typeof event.waitUntil === 'function') event.waitUntil(syncPromise);
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'its-driver-status-sync') {
    event.waitUntil(syncQueuedRequests());
  }
});

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
      } catch (_) {
        // BroadcastChannel non disponibile.
      }
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || '/driver';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          if (client.url.includes('/driver') && 'focus' in client) {
            void client.navigate(targetUrl);
            return client.focus();
          }
        }
        return self.clients.openWindow(targetUrl);
      })
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data?.type === 'PREFETCH_DRIVER_DATA' && data.token) {
    event.waitUntil(cacheDriverData(new Request(DRIVER_DATA_PATH, {
      headers: { Authorization: `Bearer ${data.token}` },
      credentials: 'include'
    })).catch(() => undefined));
    return;
  }
  if (data?.type === 'SYNC_DRIVER_STATUS_QUEUE') {
    event.waitUntil(syncQueuedRequests());
    return;
  }
  if (data?.type === 'GET_DRIVER_STATUS_QUEUE_COUNT') {
    event.waitUntil(broadcastQueueState());
  }
});
