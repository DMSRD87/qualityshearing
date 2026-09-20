/* myGang Service Worker — offline-first caching */
/* v9: PRECACHE now covers every library URL in use across the fleet, not just
   the ones the newest app requests. The list had drifted: it precached
   react@18 while 13 of 16 contractors load react@18.3.1, and supabase-js@2.112.3
   while three older builds still load the floating @2. Those entries are keyed
   by URL, so a mismatch meant the precache was largely dead weight and the
   "install once and you're ready offline" guarantee was not real — a freshly
   installed app opened first in a dead spot would fail. Runtime cache-first
   covered it after one successful online load, which is why nobody noticed.
   Listing both the pinned and floating URLs is a superset: harmless where an
   entry is unused, and correct for old and new builds from one file. Install
   already uses allSettled over individual adds, so one bad URL cannot take the
   whole precache down with it. */
/* v8: supabase-js pinned to 2.112.3 (was floating @2 — a breaking release
   inside the major would have hit all contractors at once, mid-shed, with no
   rollback). CACHE bumped so devices purge the old floating copy. */
/* v7: Cache version bump alongside v4.5.0 app deploy. Forces SW reactivation
   so all devices receive the wipe-prevention patches and DATA_VERSION-driven
   localStorage cleanup. Network-first for HTML retained from v6. Supabase API
   calls still bypassed (v5 fix retained — never serve fake-200 stubs for data). */
/* v10 — HTML fetch now has a 3s TIMEOUT. Network-first was right but had no
   ceiling: on a link that is up but not passing packets (one bar in a shed) the
   navigation request sat in the OS queue for a minute or more before rejecting,
   and only THEN did the cache fallback fire. Fully offline was fine (instant
   reject) and full signal was fine; poor signal was the case nothing handled.
   Now the fetch races a 3s timer. Network wins → fresh code as before. Timer
   wins → cached app served immediately, and the in-flight fetch is kept alive
   via waitUntil so it still refreshes the cache for the NEXT open.
   Cost, stated plainly: a slow-but-live link may serve the previous build once.
   No cache means no fallback, so a first-ever install still needs signal — that
   has always been true. CACHE bumped so every device reactivates. */
const CACHE = 'mygang-v10';
const PRECACHE = [
  '/',
  /* pinned — what current builds request */
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.3',
  /* floating — still requested by builds not yet caught up */
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
    const HTML_TIMEOUT_MS = 3000;
    const net = fetch(event.request).then(res => {
      if (res && res.ok) {
        const clone = res.clone();
        return caches.open(CACHE).then(c => c.put(event.request, clone)).then(() => res, () => res);
      }
      return res;
    });
    /* keep the fetch alive past respondWith so a late arrival still lands in cache */
    event.waitUntil(net.catch(() => {}));
    event.respondWith(
      caches.match(event.request)
        .then(c => c || caches.match('/'))
        .then(cached => {
          if (!cached) return net;  /* nothing to fall back to — let the network decide */
          const timer = new Promise(resolve => setTimeout(() => resolve('timeout'), HTML_TIMEOUT_MS));
          return Promise.race([net.catch(() => null), timer]).then(winner => {
            if (winner && winner !== 'timeout' && winner.ok) return winner;
            return cached;
          });
        })
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
