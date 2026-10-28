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
/* v13 (28 Oct 2026) — VERSION WATCH. The app now asks /version.json whether the
   served build differs from the one it is running. That file must never come
   from this cache: it is passed straight through, like the API calls. CACHE
   bumped so every device reactivates and drops any copy the old rule stored. */
const CACHE = 'mygang-v13'; /* v11: Xero catalog purge; v13: version.json pass-through */
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
  /* v11 (22 Oct 2026) — Xero broker and any /api/ call — DO NOT INTERCEPT.
     The cache-first rule at the bottom was caching GET /api/xero/catalog and
     /api/xero/mappings the first time the Xero screen opened, so a bookkeeper's
     laptop kept showing the Xero employee list as it was that day: new starters
     added in Xero never appeared and the push stayed blocked. Live data is never
     served from cache. */
  if (url.includes('mygangxero') || url.includes('/api/')) {
    return;
  }
  /* v13 — the build marker is live data too */
  if (url.includes('/version.json')) {
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

/* ── v12 (27 Oct 2026) — WEB PUSH for Team chat ──
   The broker (mygangxero /api/push/notify) sends {title, body, url, badge, tag}
   when someone posts. Show it, set the icon badge, and on tap focus the open app
   (it opens Team chat on the mg-open-chat message) or open /#chat cold. */
self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  const title = d.title || 'myGang';
  const opts = { body: d.body || '', tag: d.tag || 'mg-chat', renotify: true, data: { url: d.url || '/#chat' } };
  if (d.ts) { const t = Date.parse(d.ts); if (t) opts.timestamp = t; }
  const work = [self.registration.showNotification(title, opts)];
  if (d.badge != null && 'setAppBadge' in self.navigator) work.push(self.navigator.setAppBadge(Number(d.badge) || 0).catch(() => {}));
  event.waitUntil(Promise.all(work));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/#chat';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const c = list.find(x => x.url && x.url.indexOf(self.location.origin) === 0);
    if (c) { try { c.postMessage({ type: 'mg-open-chat' }); } catch (e) {} return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
/* the push service rotated this device's subscription: re-subscribe and ask the
   open app (if any) to save the new endpoint; the next boot saves it otherwise */
self.addEventListener('pushsubscriptionchange', event => {
  const key = 'BLaVGElCp6Q35hW98M8x2_o_Ny8Cg0lE7oIQFVNivP3bHOi8k-PgW0AaKgwiG5QG0zGB05EKYDajnIU_HyjrWHA';
  const pad = '='.repeat((4 - key.length % 4) % 4);
  const raw = atob((key + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const u8 = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
  event.waitUntil(self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u8 })
    .then(() => self.clients.matchAll({ type: 'window' }))
    .then(list => list.forEach(c => { try { c.postMessage({ type: 'mg-push-resub' }); } catch (e) {} }))
    .catch(() => {}));
});
