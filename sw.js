// Service worker: keeps a copy of the app's files on the phone so the
// app opens even without internet. It stores only the app's CODE.
// Your study data lives in localStorage and is never touched here.

// Name of our storage box for files. Change it when the LIST of files
// below changes (e.g. a new file is added), so old copies get cleaned up.
const CACHE_NAME = "telos-files-v8"; // v8: tablet and desktop layouts

// Everything the app needs to start.
const APP_FILES = [
  "./",
  "./index.html",
  "./style.css?v=8",
  "./app.js?v=8",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/icon-maskable-512.png",
  "./icons/favicon-32.png",
  "./fonts/inter-latin.woff2",
  "./fonts/inter-latin-ext.woff2",
  "./fonts/manrope-extrabold-latin.woff2",
  "./fonts/inter-greek.woff2",
];

// How long to wait for the network before using the saved copy instead.
const NETWORK_TIMEOUT_MS = 3000;

// First install: download all app files into the cache.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // cache: "reload" = download fresh from GitHub, skip the browser's own copy
      cache.addAll(APP_FILES.map((url) => new Request(url, { cache: "reload" })))
    )
  );
  self.skipWaiting(); // start using this version straight away
});

// When a new version takes over: delete caches with an old name.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Every time the app asks for a file: NETWORK FIRST.
// 1. Try to download the newest version (and save it for offline use).
// 2. If there's no internet, or it takes longer than 3 seconds,
//    use the saved copy instead.
// This way all files always come from the same (newest) version when
// you're online, and the app still opens in airplane mode.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return; // only handle normal downloads

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      // cache: "no-cache" = check with GitHub every time. GitHub lets browsers reuse
      // files for 10 minutes, each file separately; right after an update that could
      // mix a NEW page with an OLD stylesheet and scramble the layout.
      // (We fetch by address: browsers don't allow adding options to a page-navigation request.)
      const fromNetwork = fetch(event.request.url, { cache: "no-cache" }).then((response) => {
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      });

      // Whichever comes first: the network answer, or "too slow" after 3 s.
      const tooSlow = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS, null));
      try {
        const response = await Promise.race([fromNetwork, tooSlow]);
        if (response) return response;
      } catch (error) {
        // offline: fall through to the saved copy
      }

      // ignoreSearch: "index.html?x=1" still matches "index.html"
      const cached = await cache.match(event.request, { ignoreSearch: true });
      return cached || fromNetwork; // nothing saved yet: keep waiting for the network
    })
  );
});
