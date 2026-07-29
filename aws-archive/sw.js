// Service Worker for Offline PWA Support
const CACHE_NAME = 'calorie-tracker-v4';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './app-icon2.svg',
  'https://code.jquery.com/jquery-3.6.0.min.js',
  'https://cdn.jsdelivr.net/npm/select2@4.1.0-rc.0/dist/css/select2.min.css',
  'https://cdn.jsdelivr.net/npm/select2@4.1.0-rc.0/dist/js/select2.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css'
];

// Install event - cache assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Service Worker: Caching app shell');
        return cache.addAll(urlsToCache);
      })
      .then(() => self.skipWaiting()) // Activate immediately
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== CACHE_NAME) {
            console.log('Service Worker: Clearing old cache');
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim()) // Take control immediately
  );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // CRITICAL: Navigation requests (opening the app) - always serve cached index.html when offline
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Cache the response for next time
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, responseClone);
          });
          return response;
        })
        .catch(() => {
          // Offline: serve cached index.html for any navigation
          return caches.match('/index.html').then(cachedResponse => {
            if (cachedResponse) {
              console.log('Service Worker: Serving cached app (offline mode)');
              return cachedResponse;
            }
            // Fallback if nothing cached (shouldn't happen after first load)
            return caches.match('/');
          });
        })
    );
    return;
  }

  // Network-first for API calls (always try to get fresh data)
  if (url.hostname.includes('amazonaws.com') || url.pathname.startsWith('/auth/')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Cache successful GET requests
          if (response && response.ok && request.method === 'GET') {
             // Clone response before caching
             const responseClone = response.clone();
             caches.open(CACHE_NAME).then(cache => {
               cache.put(request, responseClone);
             });
          }
          return response;
        })
        .catch(() => {
          // If network fails, try cache
          return caches.match(request);
        })
    );
  } 
  // Cache-first for static assets (app shell)
  else {
    event.respondWith(
      caches.match(request)
        .then(response => {
          return response || fetch(request).then(fetchResponse => {
            // Cache new resources as we fetch them (GET only)
            if (fetchResponse.ok && request.method === 'GET') {
                const responseToCache = fetchResponse.clone();
                caches.open(CACHE_NAME).then(cache => {
                  cache.put(request, responseToCache);
                });
            }
            return fetchResponse;
          });
        })
        .catch(() => {
          // Offline and not in cache
          console.log('Service Worker: Offline and resource not cached');
        })
    );
  }
});
