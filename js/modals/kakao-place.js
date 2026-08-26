import { addCompositionAwareInput } from '../utils.js';
import { showToast } from '../ui.js';
import { callableFunctions } from '../firebase.js';
import { scheduleLucideIcons } from '../icons.js';
import { ENTRY_DOM } from './entry-form-config.js';
import { escapeHtml } from '../render/utils.js';
import { lockBodyScroll, unlockBodyScroll } from '../utils/scroll-lock.js';
import { isFoodRelatedKakaoPlace, sortKakaoPlacesByNameMatch } from '../utils/place-type.js';
import { syncEntryContextPlaceFromInput } from './entry-context-predict.js';
import { withDeadline, DeadlineError } from '../utils/with-deadline.js';

const KAKAO_SEARCH_MIN_LENGTH = 2;

/**
 * 검색 응답 상한.
 *
 * 다른 경로(DEADLINE.DOC=8초)보다 길다. 앱은 카카오 SDK 대신 Cloud Function 을 프록시로
 * 타는데(shouldUseKakaoCallable) 그 함수가 us-central1 에 있고 minInstances 가 없다 —
 * 태평양을 두 번 건너고(폰→미국→카카오(한국)→미국→폰) 콜드 스타트까지 겹치면 수 초가 걸린다.
 * 여기서 인색하게 굴면 느리지만 정상인 응답을 버리게 되므로, 목적은 빨리 끊는 것이 아니라
 * **반드시 끝나게 하는 것**이다. 근본 해결(리전 이전·minInstances)은 서버 쪽 일이다.
 */
const KAKAO_SEARCH_DEADLINE_MS = 12000;

/**
 * 키워드 → { at, restaurants }. 지웠다 다시 치거나 오타를 고쳐 되돌아오는 흐름이 흔해
 * 적중률이 높다. 모듈 수준이라 검색 모달을 닫았다 열어도 남는다.
 *
 * 이 캐시가 막는 것은 지연만이 아니다 — 서버의 분당 15회 제한
 * (functions/index.js RATE_LIMITS.kakaoSearch)을 같은 검색어로 헛되이 깎는 것을 함께 막는다.
 */
const KAKAO_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const KAKAO_SEARCH_CACHE_MAX = 40;
/** @type {Map<string, { at: number, restaurants: any[] }>} */
const kakaoSearchCache = new Map();

/**
 * 같은 키워드로 이미 나간 요청. 디바운스(320ms)를 통과한 요청이 겹치면 결과를 나눠 쓴다.
 *
 * callable 은 취소할 방법이 없다(httpsCallable 에 AbortSignal 이 없다). 그래서 예전에는
 * 중복 요청이 그대로 날아가고 **결과만 버려졌다** — 서버 호출·요금·분당 제한은 그대로 쓰면서.
 * 데드라인을 이 공유 약속 **바깥에** 걸어, 상한을 넘겨도 원래 호출은 살려 둔다. 사용자가
 * 다시 검색하면 그 호출에 다시 올라타므로 제한을 두 번 깎지 않는다.
 * @type {Map<string, Promise<any[]>>}
 */
const kakaoSearchInFlight = new Map();

/** @param {string} keyword */
function readKakaoSearchCache(keyword) {
    const hit = kakaoSearchCache.get(keyword);
    if (!hit) return null;
    if (Date.now() - hit.at > KAKAO_SEARCH_CACHE_TTL_MS) {
        kakaoSearchCache.delete(keyword);
        return null;
    }
    // 최근 쓴 것을 뒤로 보내 LRU 로 유지 (Map 은 삽입 순서를 지킨다)
    kakaoSearchCache.delete(keyword);
    kakaoSearchCache.set(keyword, hit);
    return hit.restaurants;
}

/**
 * @param {string} keyword
 * @param {any[]} restaurants
 */
function writeKakaoSearchCache(keyword, restaurants) {
    kakaoSearchCache.set(keyword, { at: Date.now(), restaurants });
    while (kakaoSearchCache.size > KAKAO_SEARCH_CACHE_MAX) {
        const oldest = kakaoSearchCache.keys().next().value;
        kakaoSearchCache.delete(oldest);
    }
}

/**
 * 같은 키워드의 요청을 하나로 합쳐 실행한다. 캐시 기록도 여기서 한다 —
 * 데드라인에 걸려 화면이 포기한 뒤에 응답이 와도 다음 검색이 그 결과를 쓴다.
 * @param {string} keyword
 * @returns {Promise<any[]>}
 */
function fetchKakaoPlacesShared(keyword) {
    const existing = kakaoSearchInFlight.get(keyword);
    if (existing) return existing;

    const work = fetchKakaoPlaces(keyword)
        .then((restaurants) => {
            writeKakaoSearchCache(keyword, restaurants);
            return restaurants;
        })
        .finally(() => {
            kakaoSearchInFlight.delete(keyword);
        });

    kakaoSearchInFlight.set(keyword, work);
    return work;
}

/**
 * 앱/스테이징은 Callable, 로컬 웹은 SDK(없으면 Callable) — 경로만 고르고 상한·캐시는 호출부가 건다.
 * @param {string} keyword
 * @returns {Promise<any[]>}
 */
async function fetchKakaoPlaces(keyword) {
    const useCallable = shouldUseKakaoCallable();

    if (!useCallable) {
        // 웹: SDK 로딩 중이면 최대 3초 대기
        if (window.kakaoSDKLoading && !window.kakaoSDKLoaded) {
            await new Promise((resolve) => {
                let waited = 0;
                const iv = setInterval(() => {
                    waited += 200;
                    if (window.kakaoSDKLoaded || waited >= 3000) {
                        clearInterval(iv);
                        resolve();
                    }
                }, 200);
            });
        }
    }

    // 1) 앱: Callable 즉시 사용 (WebView에서 SDK 불안정·도메인 제한 회피)
    if (useCallable) {
        const result = await callableFunctions.searchKakaoPlaces({ keyword });
        return result?.data?.documents || [];
    }

    // 2) 웹 + SDK 로드됨: SDK 사용
    if (window.kakaoSDKLoaded && typeof kakao !== 'undefined' && kakao?.maps?.services?.Places) {
        const ps = new kakao.maps.services.Places();
        // 카테고리 무필터 검색 후 식음 관련만 남긴다 — FD6 고정이면 카페(CE7)·편의점(CS2)이
        // 아예 안 와서 어디서 축 통합(장소 카테고리화)이 막힌다
        return await new Promise((resolve) => {
            ps.keywordSearch(keyword, (data, status) => {
                if (status === kakao.maps.services.Status.OK) {
                    // 상호명이 맞는 가게를 위로 올린 뒤 자른다 — 자르고 정렬하면 뒤쪽의 일치가 잘려 나간다
                    const food = (data || []).filter(isFoodRelatedKakaoPlace);
                    resolve(sortKakaoPlacesByNameMatch(food, keyword).slice(0, 10));
                } else {
                    resolve([]);
                }
            }, { size: 15 });
        });
    }

    // 3) 웹 + SDK 없음: Callable fallback
    const result = await callableFunctions.searchKakaoPlaces({ keyword });
    return result?.data?.documents || [];
}

/** 검색 모달 닫기 — remove() 호출 지점 전부 이걸 거쳐야 배경 잠금이 풀림 */
export function closeKakaoPlaceSearchModal() {
    const modal = document.getElementById('kakaoPlaceSearchModal');
    if (modal) modal.remove();
    unlockBodyScroll('kakaoPlaceSearchModal');
}
window.closeKakaoPlaceSearchModal = closeKakaoPlaceSearchModal;

export function openKakaoPlaceSearch(mode = 'meal') {
    const targetId =
        mode === 'deliveryVendor' ? 'deliveryVendorInput' : ENTRY_DOM.whereInput;
    const targetInput = document.getElementById(targetId);
    if (!targetInput) return;
    window._kakaoPlaceSearchTarget = targetId;
    createKakaoSearchModal();
}

// 카카오 검색 모달 생성 함수
function createKakaoSearchModal() {
    const targetId = window._kakaoPlaceSearchTarget || ENTRY_DOM.whereInput;
    const targetInput = document.getElementById(targetId);
    if (!targetInput) return;

    const existingModal = document.getElementById('kakaoPlaceSearchModal');
    if (existingModal) {
        existingModal.remove();
    }

    const modal = document.createElement('div');
    modal.id = 'kakaoPlaceSearchModal';
    modal.className = 'kakao-place-sheet';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'kakaoPlaceSearchTitle');
    modal.innerHTML = `
        <div class="kakao-place-sheet__panel">
            <div class="kakao-place-sheet__handle" aria-hidden="true"></div>
            <div class="kakao-place-sheet__header">
                <h2 id="kakaoPlaceSearchTitle" class="kakao-place-sheet__title">장소 검색</h2>
                <button type="button" class="kakao-place-sheet__close" onclick="window.closeKakaoPlaceSearchModal()" aria-label="닫기">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
            <div class="kakao-place-sheet__body">
                <div class="kakao-place-sheet__search">
                    <button type="button" class="kakao-place-sheet__search-btn" onclick="window.searchKakaoPlaces()" aria-label="검색">
                        <i data-lucide="search" aria-hidden="true"></i>
                    </button>
                    <input type="text" id="kakaoSearchInput" class="kakao-place-sheet__input" placeholder="식당·카페 등 장소를 2글자 이상 입력하세요" autocomplete="off">
                    <button type="button" class="kakao-place-sheet__apply-btn" onclick="window.applyKakaoPlaceManualText()" aria-label="검색어를 그대로 장소로 입력">입력</button>
                </div>
                <p class="kakao-place-sheet__hint">목록에서 고르거나, 오른쪽 <strong>입력</strong>으로 그대로 넣을 수 있어요.</p>
                <div id="kakaoSearchResults" class="kakao-place-sheet__results"></div>
            </div>
        </div>
    `;

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeKakaoPlaceSearchModal();
    });

    document.body.appendChild(modal);
    lockBodyScroll('kakaoPlaceSearchModal');
    scheduleLucideIcons(modal);

    const searchInput = document.getElementById('kakaoSearchInput');
    if (searchInput) {
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                window.searchKakaoPlaces();
            }
        });

        let searchTimeout = null;
        if (!searchInput._kakaoSearchCompositionInit) {
            const resultsContainer = document.getElementById('kakaoSearchResults');
            addCompositionAwareInput(searchInput, () => {
                const keyword = searchInput.value.trim();
                if (searchTimeout) clearTimeout(searchTimeout);
                if (!keyword) {
                    if (resultsContainer) resultsContainer.innerHTML = '';
                    return;
                }
                if (keyword.length < KAKAO_SEARCH_MIN_LENGTH) {
                    if (resultsContainer) resultsContainer.innerHTML = '';
                    return;
                }
                searchTimeout = setTimeout(() => window.searchKakaoPlaces(), 320);
            });
            searchInput._kakaoSearchCompositionInit = true;
        }

        searchInput.focus();
    }
}

// 카카오 장소 검색 결과를 리스트로 렌더링 (SDK/callable 공통)
function renderKakaoSearchResults(restaurants) {
    const resultsContainer = document.getElementById('kakaoSearchResults');
    if (!resultsContainer) return;
    
    if (restaurants.length === 0) {
        resultsContainer.innerHTML = '<div class="kakao-place-sheet__empty">검색 결과가 없습니다.</div>';
        return;
    }

    resultsContainer.innerHTML = restaurants.map((place) => {
        const placeName = place.place_name || '';
        const address = place.address_name || '';
        const roadAddress = place.road_address_name || '';
        const placeId = place.id || '';
        const category = place.category_name || '';

        const escapeForAttr = (str) => {
            if (!str) return '';
            return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/\n/g, ' ').replace(/\r/g, '');
        };

        const safePlaceName = escapeForAttr(placeName);
        const safeAddress = escapeForAttr(roadAddress || address);
        const safePlaceId = escapeForAttr(placeId);

        // categoryGroupCode: placeType(식당/카페/편의점/술집) 파생용 — 저장 시 place-type.js가 읽는다
        const placeDataObj = { id: placeId, name: placeName, address: roadAddress || address, roadAddress: roadAddress, category: category, categoryGroupCode: place.category_group_code || '' };
        let placeDataB64 = '';
        try {
            placeDataB64 = btoa(unescape(encodeURIComponent(JSON.stringify(placeDataObj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        } catch (e) {}

        // "음식점 > 한식 > 냉면" → 마지막 마디만 결과 행에 표시 (선택 전 카테고리 확인용)
        const categoryTail = category ? category.split('>').pop().trim() : '';

        return `
            <button type="button" onclick="window.selectKakaoPlace('${safePlaceName}', '${safeAddress}', '${safePlaceId}', '${placeDataB64}')"
                class="kakao-place-sheet__result">
                <div class="kakao-place-sheet__result-name">${escapeHtml(placeName)}${categoryTail ? `<span class="kakao-place-sheet__result-cat">${escapeHtml(categoryTail)}</span>` : ''}</div>
                <div class="kakao-place-sheet__result-addr">${escapeHtml(roadAddress || address)}</div>
            </button>
        `;
    }).join('');
}

// Callable 사용 대상: 앱(Capacitor) 또는 스테이징 (카카오 도메인/WebView 이슈 회피)
function shouldUseKakaoCallable() {
    if (window.Capacitor?.isNativePlatform?.()) return true;
    if (window.APP_ENV === 'staging') return true;
    return false;
}

let kakaoSearchRequestSeq = 0;

// 카카오 장소 검색 실행
// 앱/스테이징: Callable / 로컬웹: SDK 또는 Callable fallback
export async function searchKakaoPlaces() {
    const searchInput = document.getElementById('kakaoSearchInput');
    const resultsContainer = document.getElementById('kakaoSearchResults');
    
    if (!searchInput || !resultsContainer) return;
    
    const keyword = searchInput.value.trim();
    if (!keyword) {
        showToast('검색어를 입력해주세요.', 'error');
        return;
    }
    if (keyword.length < KAKAO_SEARCH_MIN_LENGTH) {
        showToast(`검색어는 ${KAKAO_SEARCH_MIN_LENGTH}글자 이상 입력해주세요.`, 'error');
        return;
    }

    const seq = ++kakaoSearchRequestSeq;

    // 캐시 적중은 네트워크를 타지 않으므로 '검색 중...' 을 깜빡이지 않고 바로 그린다
    const cached = readKakaoSearchCache(keyword);
    if (cached) {
        renderKakaoSearchResults(cached);
        return;
    }

    resultsContainer.innerHTML = '<div class="kakao-place-sheet__empty">검색 중...</div>';

    try {
        const restaurants = await withDeadline(
            fetchKakaoPlacesShared(keyword),
            KAKAO_SEARCH_DEADLINE_MS,
            'kakao-place-search'
        );

        if (seq !== kakaoSearchRequestSeq) return;

        renderKakaoSearchResults(restaurants);
    } catch (err) {
        if (seq !== kakaoSearchRequestSeq) return;

        /**
         * 상한을 넘긴 것은 오류가 아니라 **아직 안 온 것**이다 — 원래 호출은 살아 있다.
         * 같은 검색어로 다시 누르면 그 호출에 다시 올라타므로 재시도가 헛되지 않다.
         */
        if (err instanceof DeadlineError) {
            resultsContainer.innerHTML =
                '<div class="kakao-place-sheet__empty">응답이 늦어지고 있어요. 잠시 후 다시 검색하거나, 오른쪽 <strong>입력</strong>으로 그대로 넣어 주세요.</div>';
            return;
        }

        const msg = err?.message || String(err);
        if (msg.includes('로그인이 필요')) {
            showToast('장소 검색을 사용하려면 로그인해주세요.', 'error');
        } else if (msg.includes('KAKAO_REST_API_KEY')) {
            showToast('장소 검색 서비스를 준비 중입니다.', 'error');
        } else if (msg.includes('너무 빠르게') || err?.code === 'functions/resource-exhausted') {
            // 느린 것과 막힌 것은 다르다 — 한 문구로 뭉뚱그리면 사용자가 계속 다시 누른다
            showToast('검색이 잠시 제한되었습니다. 조금 뒤에 다시 시도해 주세요.', 'error');
        } else {
            showToast('검색 중 오류가 발생했습니다.', 'error');
        }
        resultsContainer.innerHTML = '<div class="kakao-place-sheet__empty">검색 중 오류가 발생했습니다.</div>';
        console.error('카카오 장소 검색 오류:', err);
    }
}

/** 검색 모달의 텍스트를 카카오 결과 없이 그대로 장소명으로 반영 (직접 입력) */
export function applyKakaoPlaceManualText() {
    const searchInput = document.getElementById('kakaoSearchInput');
    const targetId = window._kakaoPlaceSearchTarget || ENTRY_DOM.whereInput;
    const placeInput = document.getElementById(targetId);
    if (!searchInput || !placeInput) return;
    const text = searchInput.value.trim();
    if (!text) {
        showToast('입력할 장소명을 적어주세요.', 'error');
        return;
    }
    placeInput.value = text;
    placeInput.removeAttribute('data-kakao-place-id');
    placeInput.removeAttribute('data-kakao-place-address');
    placeInput.removeAttribute('data-kakao-place-data');
    placeInput.removeAttribute('data-kakao-place-name');
    closeKakaoPlaceSearchModal();
    // 프로그램적 value 설정은 change 이벤트를 발화시키지 않으므로 맥락 줄에 직접 알린다
    if (targetId === ENTRY_DOM.whereInput) syncEntryContextPlaceFromInput();
    showToast('장소명이 입력되었습니다.', 'success');
}

// 카카오 장소 선택
export function selectKakaoPlace(placeName, address, placeId = null, placeDataB64 = null) {
    const targetId = window._kakaoPlaceSearchTarget || ENTRY_DOM.whereInput;
    const placeInput = document.getElementById(targetId);
    if (placeInput) {
        placeInput.value = placeName;
    }
    
    // 카카오맵 API로 입력된 장소임을 표시하기 위해 데이터 속성에 저장
    // data-kakao-place-name: 저장 시 '장소명 수정' 여부 검사용 (다르면 주소·placeId 미적용)
    if (placeInput && placeId) {
        placeInput.setAttribute('data-kakao-place-id', placeId);
        placeInput.setAttribute('data-kakao-place-address', address || '');
        placeInput.setAttribute('data-kakao-place-name', placeName || '');
        if (placeDataB64) {
            try {
                // Base64 디코딩 (URL-safe Base64)
                const base64 = placeDataB64.replace(/-/g, '+').replace(/_/g, '/');
                const decoded = decodeURIComponent(escape(atob(base64)));
                const parsed = JSON.parse(decoded);
                placeInput.setAttribute('data-kakao-place-data', JSON.stringify(parsed));
            } catch (e) {
                console.warn('카카오 장소 데이터 파싱 실패:', e);
                // 파싱 실패해도 기본 정보는 저장
                if (placeId) {
                    placeInput.setAttribute('data-kakao-place-data', JSON.stringify({
                        id: placeId,
                        name: placeName,
                        address: address
                    }));
                }
            }
        } else if (placeId) {
            // placeDataB64가 없어도 기본 정보 저장
            placeInput.setAttribute('data-kakao-place-data', JSON.stringify({
                id: placeId,
                name: placeName,
                address: address
            }));
        }
    }
    
    // 모달 닫기
    closeKakaoPlaceSearchModal();

    if (targetId === ENTRY_DOM.whereInput) syncEntryContextPlaceFromInput();
    showToast("장소가 선택되었습니다.", 'success');
}

/** 카카오 장소 검색 모달이 열린 뒤 검색어를 넣고(선택) 검색을 실행. 모달이 없으면 no-op. */
export function applyKakaoSearchText(text, runSearch = true) {
    const searchInput = document.getElementById('kakaoSearchInput');
    if (!searchInput) return;
    const s = text == null ? '' : String(text).trim();
    searchInput.value = s;
    if (runSearch && s.length >= KAKAO_SEARCH_MIN_LENGTH) {
        return searchKakaoPlaces();
    }
}


