'use strict';

const CACHE_NAME = 'tradejournal-v2.5.2';
const APP_SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/preferences.js',
  './js/i18n-en.js',
  './js/i18n.js',
  './js/desktop-bridge.js',
  './js/utils.js',
  './js/blobstore.js',
  './js/store.js',
  './js/sample.js',
  './js/csv.js',
  './js/zip.js',
  './js/pwa.js',
  './js/charts.js',
  './js/app.js',
  './manifest.webmanifest',
  './assets/og-image.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // Reload bypasses the browser HTTP cache so a freshly installed worker
      // never keeps stale scripts or styles from the previous release.
      const requests = APP_SHELL.map(function (url) {
        return new Request(url, { cache: 'reload' });
      });
      return cache.addAll(requests);
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (key) {
        return key !== CACHE_NAME;
      }).map(function (key) {
        return caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(function (response) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
        return response;
      }).catch(function () {
        return caches.match(request).then(function (cached) {
          return cached || caches.match('./index.html');
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(function (cached) {
      const network = fetch(request).then(function (response) {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      }).catch(function () {
        return cached;
      });
      return cached || network;
    })
  );
});