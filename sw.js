// Service Worker for MEALOG
// v23: 요리 종류에 '패스트푸드' 추가 — 햄버거·피자·치킨이 집밥으로 추측되던 문제.
// CSS·JS 조합이 갈리지 않도록 캐시 세대를 올린다.
const CACHE_NAME = 'mealog-v23';
/*
 * 상대 경로 사용 (서브디렉토리 배포 대응)
 * 루트 배포면 '', 서브디렉토리면 '/foo' — 뒤에 '/...' 를 붙이므로 여기서 '/' 로 폴백하면
 * '//index.html' 이 되어 프로토콜 상대 URL(다른 호스트)로 해석된다.
 */
const basePath = self.location.pathname.replace(/\/sw\.js$/, '');
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

// Fetch event - Stale-While-Revalidate (캐시 우선 응답 + 백그라운드 네트워크 갱신)
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

  // config.js는 항상 네트워크에서 로드 (배포 시 시크릿 반영을 위해 캐시하지 않음)
  try {
    const url = new URL(event.request.url);
    if (url.pathname.endsWith('/config.js') || url.pathname.endsWith('config.js')) {
      event.respondWith(fetch(event.request));
      return;
    }
  } catch (_) {}

  // Stale-While-Revalidate: 캐시가 있으면 즉시 응답(부팅 체감 속도),
  // 동시에 네트워크로 갱신해 다음 방문부터 최신 반영. 캐시가 없으면(첫 방문) 네트워크를 기다림.
  // 배포 후 새 콘텐츠 반영은 위 updatefound → reload 흐름(index.html)이 담당.
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(event.request).then((cachedResponse) => {
        const networkUpdate = fetch(event.request)
          .then((response) => {
            if (response && response.status === 200) {
              cache.put(event.request, response.clone());
            }
            return response;
          })
          .catch((err) => {
            if (!cachedResponse) console.error('Service Worker: 네트워크 요청 실패', err);
            return cachedResponse;
          });
        // 캐시를 즉시 반환한 뒤에도 SW가 살아서 백그라운드 갱신을 마치도록 보장
        event.waitUntil(networkUpdate.catch(() => {}));
        return cachedResponse || networkUpdate;
      })
    )
  );
});

