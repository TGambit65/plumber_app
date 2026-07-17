/* Trade-Ops service worker — offline app shell (spec §9).
 *
 * Strategy:
 *   • Navigations (HTML): network-first, fall back to the last cached shell,
 *     then to /offline. Keeps the field app openable with no signal.
 *   • Static assets (/_next/static, icons, manifest): cache-first (immutable).
 *   • API + sync + uploads: network-only (never cache tenant data or auth).
 *
 * The offline DATA layer is IndexedDB (see src/lib/offline) — the SW only
 * caches the shell so the app can boot offline; data comes from IDB.
 */
const VERSION = "v1";
const SHELL_CACHE = `tradeops-shell-${VERSION}`;
const STATIC_CACHE = `tradeops-static-${VERSION}`;
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll([OFFLINE_URL]).catch(() => undefined))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

function isStatic(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/uploads/") === false && // uploads are tenant data → not cached below
    (url.pathname === "/manifest.json" ||
      url.pathname.startsWith("/icon") ||
      /\.(?:css|js|woff2?|png|jpg|jpeg|svg|ico)$/.test(url.pathname))
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API, auth, sync, or tenant uploads.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/auth/") ||
    url.pathname.startsWith("/uploads/") ||
    url.pathname.startsWith("/login")
  ) {
    return; // default network handling
  }

  // Navigations → network-first with shell/offline fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
          return res;
        })
        .catch(async () => (await caches.match(req)) || (await caches.match(OFFLINE_URL)) || Response.error())
    );
    return;
  }

  // Static assets → cache-first.
  if (isStatic(url)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
            return res;
          })
      )
    );
  }
});
