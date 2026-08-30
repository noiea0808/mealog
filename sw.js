// Service Worker for MEALOG
// v32: 기록 시트 개편(test)을 staging 으로 합치면서 세대를 올린다.
//      '무엇을' 회상 줄·추천 분류 기본 사용·나만의 태그 제거·분석 '무엇을' 축 전환까지
//      index.html 구조가 여러 번 바뀌었다. 두 갈래가 각자 번호를 올려와(staging v12,
//      test v31) 여기서 더 큰 쪽 위로 잇는다 — 양쪽 사용자 모두에게 새 세대여야 한다.
// v37: '슬롯 설정' → '기록 항목 설정'. 도움말 팝업(slotPlanHelpModal)이 새로
//      붙어 index.html 구조가 바뀐다.
// v38: 사용자 메모 — 기록 시트·항목 만들기 팝업이 index.html 에 더 붙는다.
// v39: 메모 설정 팝업 — index.html 의 메모 팝업 구조가 바뀐다.
// v40: 메모 설정 — 목록과 새 항목을 한 화면으로 합치며 팝업 구조가 바뀐다.
// v41: 메모 설정 시트 전환 + 기본 메모(체중·혈당) + 숫자 값 칸.
// v42: 하루 소감에서 체중·혈당 입력기를 걷었다 — index.html 구조가 바뀐다.
// v43: 하루 소감이 메모 항목이 되고 피커 메모 구역이 4열로 — 구조가 바뀐다.
// v44: 메모 기록 시트의 시각 칸이 끜니와 같은 꺼데기로 바뀐다.
const CACHE_NAME = 'mealog-v44';
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
            /**
             * respondWith 는 Response 를 요구한다. 캐시도 없고 네트워크도 실패한 상황에서
             * undefined 를 넘기면 "Failed to convert value to Response" 로 요청 자체가 깨진다 —
             * 브라우저가 네트워크 오류로 처리하는 것보다 나쁘다.
             *
             * 오프라인 첫 방문에서 나고, 배포 보호(SSO)가 정적 파일을 로그인 페이지로
             * 돌려보낼 때도 난다.
             */
            return (
              cachedResponse ||
              new Response('', { status: 504, statusText: 'Service Worker: offline' })
            );
          });
        // 캐시를 즉시 반환한 뒤에도 SW가 살아서 백그라운드 갱신을 마치도록 보장
        event.waitUntil(networkUpdate.catch(() => {}));
        return cachedResponse || networkUpdate;
      })
    )
  );
});

