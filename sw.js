// Service Worker for MEALOG
const CACHE_NAME = 'mealog-v2';
// 상대 경로 사용 (서브디렉토리 배포 대응)
const basePath = self.location.pathname.replace(/\/sw\.js$/, '') || '/';
const urlsToCache = [
  basePath + '/',
  basePath + '/index.html',
  basePath + '/css/style.css',
  basePath + '/js/main.js',
  basePath + '/js/config.default.js'
];

// Install event - 캐시 저장
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Service Worker: 캐시 열기');
        return cache.addAll(urlsToCache);
      })
      .catch((error) => {
        console.error('Service Worker: 캐시 저장 실패', error);
      })
  );
});

// Activate event - 오래된 캐시 삭제
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Service Worker: 오래된 캐시 삭제', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// Fetch event - 네트워크 우선, 실패 시 캐시 사용
self.addEventListener('fetch', (event) => {
  // 외부 도메인 요청은 Service Worker를 우회하도록 함 (CORS 문제 방지)
  try {
    const url = new URL(event.request.url);
    const isExternalDomain = url.hostname !== self.location.hostname && 
                            url.hostname !== 'localhost' && 
                            url.hostname !== '127.0.0.1';
    
    if (isExternalDomain) {
      return; // 외부 도메인 요청은 intercept하지 않음
    }
  } catch (e) {
    // URL 파싱 실패 시에도 계속 진행
  }
  
  // GET 요청만 처리 (POST, PUT, DELETE 등은 캐시하지 않음)
  if (event.request.method !== 'GET') {
    return;
  }
  
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // 네트워크 응답이 성공하면 캐시에 저장하고 반환 (GET 요청만 캐시)
        if (response && response.status === 200) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME)
            .then((cache) => {
              cache.put(event.request, responseToCache);
            })
            .catch((err) => {
              console.error('Service Worker: 캐시 저장 실패', err);
            });
        }
        return response;
      })
      .catch(() => {
        // 네트워크 실패 시 캐시에서 찾기
        return caches.match(event.request);
      })
  );
});

