// Service worker: keeps a copy of the app's files on the phone so the
// app opens even without internet. It stores only the app's CODE.
// Your study data lives in localStorage and is never touched here.

// Name of our storage box for files. Only needs changing if the LIST
// of files below changes (e.g. a new file is added).
const CACHE_NAME = "studytracker-files-v1";

// Everything the app needs to start.
const APP_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

// First install: download all app files into the cache.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES))
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

// Every time the app asks for a file:
// 1. Answer immediately from the cache (fast, works offline).
// 2. At the same time, fetch a fresh copy and update the cache,
//    so the NEXT time you open the app you get the newest version.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return; // only cache normal downloads

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      // ignoreSearch: "index.html?x=1" still matches "index.html"
      const cached = await cache.match(event.request, { ignoreSearch: true });

      const fresh = fetch(event.request)
        .then((response) => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => cached); // offline: fall back to the cached copy

      return cached || fresh;
    })
  );
});
