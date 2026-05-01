/* myGang Service Worker — offline-first caching */
/* v6: Network-first for app HTML so deploys reach users without force-close.
   Cache-first remains for React/Supabase libs and fonts. Supabase API calls
   still bypassed entirely (v5 fix retained — never serve fake-200 stubs for
   data calls). */
const CACHE = 'mygang-v6';
const PRECACHE = [
  '/',
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800&family=DM+Sans:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap',
];

/* Install — cache all static assets */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => {
      return Promise.allSettled(PRECACHE.map(url => cache.add(url)));
    })
  );
  self.skipWaiting();
});

/* Activate — clean up old caches */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

/* Detect requests for the app's own HTML.
   Same-origin, navigation requests, or explicit Accept: text/html. */
function isAppHTML(req) {
  if (req.mode === 'navigate') return true;
  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/html')) {
    const u = new URL(req.url);
    if (u.origin === self.location.origin) return true;
  }
  return false;
}

/* Fetch handler */
self.addEventListener('fetch', event => {
  const url = event.request.url;

  /* Supabase API calls — DO NOT INTERCEPT.
     Returning a fake-200 stub on network failure caused the Supabase JS
     client to treat failures as silent successes and never queue retries.
     By returning early without respondWith(), the browser handles these
     requests natively — failures throw real errors that the app's
     try/catch can detect and queue. */
  if (url.includes('supabase.co')) {
    return;
  }

  /* App HTML — NETWORK-FIRST with cache fallback.
     This means online users always get the latest deployed code without
     needing to force-close. Offline users still work via the cached copy. */
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

  /* Everything else (React, Supabase JS lib, misc assets) — cache first */
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
