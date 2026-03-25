import { addCompositionAwareInput } from '../utils.js';
import { showToast } from '../ui.js';
import { callableFunctions } from '../firebase.js';

const KAKAO_SEARCH_MIN_LENGTH = 2;

export function openKakaoPlaceSearch(mode = 'meal') {
    const targetId = mode === 'snack' ? 'snackPlaceInput' : 'placeInput';
    const targetInput = document.getElementById(targetId);
    if (!targetInput) return;
    window._kakaoPlaceSearchTarget = targetId;
    createKakaoSearchModal();
}

// 카카오 검색 모달 생성 함수
function createKakaoSearchModal() {
    const targetId = window._kakaoPlaceSearchTarget || 'placeInput';
    const targetInput = document.getElementById(targetId);
    if (!targetInput) return;
    
    // 기존 모달이 있으면 제거
    const existingModal = document.getElementById('kakaoPlaceSearchModal');
    if (existingModal) {
        existingModal.remove();
    }
    
    // 모달 생성
    const modal = document.createElement('div');
    modal.id = 'kakaoPlaceSearchModal';
    modal.className = 'fixed inset-0 bg-slate-900/60 z-[400] flex items-end justify-center overflow-x-hidden';
    modal.innerHTML = `
        <div class="w-full max-w-md mx-auto bg-white rounded-t-[1.25rem] flex flex-col min-h-0 max-h-[min(80vh,100%)]">
            <div class="p-4 border-b flex justify-between items-center shrink-0">
                <h2 class="text-lg font-bold text-slate-800 tracking-tight">음식점 검색</h2>
                <button type="button" onclick="document.getElementById('kakaoPlaceSearchModal').remove()" class="flex items-center justify-center w-8 h-8 rounded-full hover:bg-slate-100 text-slate-400">
                    <i class="fa-solid fa-xmark text-xl"></i>
                </button>
            </div>
            <div class="p-4 flex-1 min-h-0 flex flex-col">
                <div class="relative mb-4 shrink-0">
                    <button type="button" onclick="window.searchKakaoPlaces()" class="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center bg-slate-100 text-slate-900 rounded-lg z-10 border border-slate-200 hover:bg-slate-200 transition-colors" aria-label="검색">
                        <i class="fa-solid fa-magnifying-glass text-sm"></i>
                    </button>
                    <input type="text" id="kakaoSearchInput" placeholder="음식점 이름을 2글자 이상 입력하세요" 
                        class="w-full p-3 pl-12 bg-slate-50 rounded-xl outline-none text-sm border border-transparent focus:border-slate-400 transition-all">
                </div>
                <div id="kakaoSearchResults" class="space-y-2 max-h-[50vh] min-h-0 overflow-y-auto flex-1"></div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // 검색 입력창에 이벤트 추가
    const searchInput = document.getElementById('kakaoSearchInput');
    if (searchInput) {
        // 엔터 키 이벤트
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                window.searchKakaoPlaces();
            }
        });
        
        // 자동완성 (입력 중 실시간 검색) - 디바운싱 + 조합 이벤트 처리
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
        resultsContainer.innerHTML = '<div class="text-center py-8 text-slate-400 text-sm">검색 결과가 없습니다.</div>';
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
        
        const placeDataObj = { id: placeId, name: placeName, address: roadAddress || address, roadAddress: roadAddress, category: category };
        let placeDataB64 = '';
        try {
            placeDataB64 = btoa(unescape(encodeURIComponent(JSON.stringify(placeDataObj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        } catch (e) {}
        
        return `
            <button onclick="window.selectKakaoPlace('${safePlaceName}', '${safeAddress}', '${safePlaceId}', '${placeDataB64}')" 
                class="w-full p-4 bg-white border border-slate-200 rounded-xl text-left hover:bg-slate-50 active:bg-slate-100 transition-colors">
                <div class="font-bold text-slate-800 mb-1">${placeName}</div>
                <div class="text-xs text-slate-500">${roadAddress || address}</div>
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
    resultsContainer.innerHTML = '<div class="text-center py-8 text-slate-400 text-sm">검색 중...</div>';
    
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
            restaurants = await new Promise((resolve) => {
                ps.keywordSearch(keyword, (data, status) => {
                    if (status === kakao.maps.services.Status.OK) {
                        resolve(data || []);
                    } else {
                        resolve([]);
                    }
                }, { category_group_code: 'FD6', size: 10 });
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
        resultsContainer.innerHTML = '<div class="text-center py-8 text-slate-400 text-sm">검색 중 오류가 발생했습니다.</div>';
        console.error('카카오 장소 검색 오류:', err);
    }
}

// 카카오 장소 선택
export function selectKakaoPlace(placeName, address, placeId = null, placeDataB64 = null) {
    const targetId = window._kakaoPlaceSearchTarget || 'placeInput';
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
    const modal = document.getElementById('kakaoPlaceSearchModal');
    if (modal) {
        modal.remove();
    }
    
    showToast("장소가 선택되었습니다.", 'success');
}



