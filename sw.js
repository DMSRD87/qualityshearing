/* myGang Service Worker — offline-first caching */
/* v5: Bypasses Supabase requests entirely so they aren't silently 
   swallowed with fake-200 stubs. Lets the browser handle Supabase 
   directly; app code's try/catch + withTimeout + queueWrite handle 
   real network failures correctly. */
const CACHE = 'mygang-v5';
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
/* Fetch — serve from cache, fall back to network */
self.addEventListener('fetch', event => {
  const url = event.request.url;
  /* Supabase API calls — DO NOT INTERCEPT.
     Previously this returned a fake-200 stub on network failure, which 
     caused the Supabase JS client to treat failures as silent successes 
     and never queue retries. By returning early without respondWith(),
     the browser handles these requests natively — failures throw real 
     errors that the app's try/catch can detect and queue. */
  if (url.includes('supabase.co')) {
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
  /* Everything else — cache first, network fallback */
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
