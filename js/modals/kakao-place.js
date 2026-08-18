import { addCompositionAwareInput } from '../utils.js';
import { showToast } from '../ui.js';
import { callableFunctions } from '../firebase.js';
import { scheduleLucideIcons } from '../icons.js';
import { ENTRY_DOM } from './entry-form-config.js';
import { escapeHtml } from '../render/utils.js';
import { lockBodyScroll, unlockBodyScroll } from '../utils/scroll-lock.js';
import { isFoodRelatedKakaoPlace } from '../utils/place-type.js';
import { syncEntryContextPlaceFromInput } from './entry-context-predict.js';

const KAKAO_SEARCH_MIN_LENGTH = 2;

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
    resultsContainer.innerHTML = '<div class="kakao-place-sheet__empty">검색 중...</div>';
    
    try {
        let restaurants = [];
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
            restaurants = result?.data?.documents || [];
        }
        // 2) 웹 + SDK 로드됨: SDK 사용
        else if (window.kakaoSDKLoaded && typeof kakao !== 'undefined' && kakao?.maps?.services?.Places) {
            const ps = new kakao.maps.services.Places();
            // 카테고리 무필터 검색 후 식음 관련만 남긴다 — FD6 고정이면 카페(CE7)·편의점(CS2)이
            // 아예 안 와서 어디서 축 통합(장소 카테고리화)이 막힌다
            restaurants = await new Promise((resolve) => {
                ps.keywordSearch(keyword, (data, status) => {
                    if (status === kakao.maps.services.Status.OK) {
                        resolve((data || []).filter(isFoodRelatedKakaoPlace).slice(0, 10));
                    } else {
                        resolve([]);
                    }
                }, { size: 15 });
            });
        }
        // 3) 웹 + SDK 없음: Callable fallback
        else {
            const result = await callableFunctions.searchKakaoPlaces({ keyword });
            restaurants = result?.data?.documents || [];
        }

        if (seq !== kakaoSearchRequestSeq) return;

        renderKakaoSearchResults(restaurants);
    } catch (err) {
        if (seq !== kakaoSearchRequestSeq) return;

        const msg = err?.message || String(err);
        if (msg.includes('로그인이 필요')) {
            showToast('장소 검색을 사용하려면 로그인해주세요.', 'error');
        } else if (msg.includes('KAKAO_REST_API_KEY')) {
            showToast('장소 검색 서비스를 준비 중입니다.', 'error');
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


