/* myGang Service Worker — offline-first caching */
/* v7: Cache version bump alongside v4.5.0 app deploy. Forces SW reactivation
   so all devices receive the wipe-prevention patches and DATA_VERSION-driven
   localStorage cleanup. Network-first for HTML retained from v6. Supabase API
   calls still bypassed (v5 fix retained — never serve fake-200 stubs for data). */
const CACHE = 'mygang-v7';
const PRECACHE = [
  '/',
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800&family=DM+Sans:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => {
      return Promise.allSettled(PRECACHE.map(url => cache.add(url)));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function isAppHTML(req) {
  if (req.mode === 'navigate') return true;
  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/html')) {
    const u = new URL(req.url);
    if (u.origin === self.location.origin) return true;
  }
  return false;
}

self.addEventListener('fetch', event => {
  const url = event.request.url;

  /* Supabase API calls — DO NOT INTERCEPT. */
  if (url.includes('supabase.co')) {
    return;
  }

  /* App HTML — NETWORK-FIRST with cache fallback. Online users get fresh code. */
  if (isAppHTML(event.request)) {
    event.respondWith(
      fetch(event.request).then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(event.request, clone));
        }
        return res;
      }).catch(() =>
        caches.match(event.request).then(c => c || caches.match('/'))
      )
    );
    return;
  }

  /* Google Fonts — cache first */
  if (url.includes('fonts.g') || url.includes('fonts.googleapis') || url.includes('fonts.gstatic')) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(event.request, clone));
        return res;
      }).catch(() => new Response('')))
    );
    return;
  }

  /* Everything else — cache first */
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        if (res.ok && event.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(event.request, clone));
        }
        return res;
      }).catch(() => caches.match('/'));
    })
  );
});
