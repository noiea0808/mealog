// 모달 및 입력 처리 관련 함수들
import { SLOTS, SATIETY_DATA, DEFAULT_ICONS, DEFAULT_SUB_TAGS, DEFAULT_USER_SETTINGS } from '../constants.js';
import { appState } from '../state.js';
import { setVal, getInputIdFromContainer, normalizeUrl, addCompositionAwareInput, uploadBase64ToStorage, normalizeBirthdateRaw } from '../utils.js';
import { renderEntryChips, renderPhotoPreviews, renderTagManager } from '../render/index.js';
import { dbOps } from '../db.js';
import { showToast } from '../ui.js';
import { renderTimeline, renderMiniCalendar, updateTimelineShareIndicators, renderGallery, renderFeed } from '../render/index.js';
import { getDashboardData } from '../analytics.js';
import { callableFunctions } from '../firebase.js';
import { isDemoUser } from '../demo-account.js';
// ⚠️ initPushNotifications import 제거 - 크래시 문제로 인해 비활성화

// 설정 저장 디바운싱을 위한 타이머
let settingsSaveTimeout = null;

const PHOTO_ASPECT_OPTIONS = ['1:1', '3:4', '4:3'];

/** 기록 사진 비율 버튼 UI 동기화 + 카메라(등록) 버튼 비율 적용 */
function updatePhotoAspectButtons() {
    const ratio = appState.recordPhotoAspectRatio || '1:1';
    document.querySelectorAll('.photo-aspect-btn').forEach(btn => {
        const isActive = btn.getAttribute('data-aspect') === ratio;
        btn.classList.toggle('bg-emerald-100', isActive);
        btn.classList.toggle('border-emerald-300', isActive);
        btn.classList.toggle('text-emerald-700', isActive);
        btn.classList.toggle('border-slate-200', !isActive);
        btn.classList.toggle('text-slate-600', !isActive);
    });
    const aspectCss = ratio === '3:4' ? '3/4' : ratio === '4:3' ? '4/3' : '1';
    [document.getElementById('imageBtn'), document.getElementById('snackImageBtn')].forEach(btn => {
        if (btn) {
            btn.style.width = '80px';
            btn.style.minWidth = '80px';
            btn.style.aspectRatio = aspectCss;
            btn.style.height = '';
            btn.style.alignSelf = 'flex-start'; // flex 행에서 비율대로만 높이 유지
        }
    });
}

/** 기록 시 모먼트 사진 비율 설정 (1:1 / 3:4 / 4:3) */
export function setRecordPhotoAspectRatio(value) {
    if (!PHOTO_ASPECT_OPTIONS.includes(value)) return;
    appState.recordPhotoAspectRatio = value;
    updatePhotoAspectButtons();
    renderPhotoPreviews(); // 등록 화면 다중 미리보기도 선택 비율로 갱신
}

/** 끼니 등록 모달: 키보드 열림 시 모달 높이를 viewport에 맞추고, 닫힘 시 네비바 영역 복원 */
function initEntryModalKeyboardHandling(entryModal) {
    if (!entryModal || entryModal._keyboardHandlingInit) return;
    entryModal._keyboardHandlingInit = true;
    let baselineHeight = 0; // 모달 열릴 때 viewport 높이 (키보드 없음)
    let imeComposing = false; // 한글 등 IME 조합 중 여부 (조합 중 레이아웃 업데이트 시 텍스트 미표시 방지)
    entryModal.querySelectorAll('input, textarea').forEach(el => {
        el.addEventListener('compositionstart', () => { imeComposing = true; });
        el.addEventListener('compositionend', () => { imeComposing = false; });
    });
    const setKeyboardOpen = (open) => {
        if (open) {
            entryModal.classList.add('keyboard-open');
            const vv = window.visualViewport;
            const vh = vv?.height ?? window.innerHeight;
            const vtop = vv?.offsetTop ?? 0;
            entryModal.style.height = vh + 'px';
            entryModal.style.top = vtop + 'px';
        } else {
            entryModal.classList.remove('keyboard-open');
            entryModal.style.height = '';
            entryModal.style.top = '';
        }
    };
    // 모달 열릴 때 baseline 저장 (openModal에서 호출)
    const saveBaseline = () => {
        baselineHeight = Math.max(window.visualViewport?.height ?? window.innerHeight, window.innerHeight * 0.5);
    };
    entryModal.setKeyboardBaseline = saveBaseline;
    entryModal.addEventListener('focusin', (e) => {
        if (e.target.matches('input, textarea')) setKeyboardOpen(true);
    });
    entryModal.addEventListener('focusout', (e) => {
        if (e.target.matches('input, textarea')) {
            [100, 300, 500].forEach(ms => setTimeout(() => {
                if (entryModal.classList.contains('hidden')) return;
                const vh = window.visualViewport?.height ?? window.innerHeight;
                const threshold = (baselineHeight || window.innerHeight) * 0.85;
                if (vh >= threshold) setKeyboardOpen(false);
            }, ms));
        }
    });
    if (window.visualViewport) {
        let lastVh = 0, lastVtop = 0;
        const checkViewport = () => {
            if (entryModal.classList.contains('hidden')) return;
            const vh = window.visualViewport.height;
            const vtop = window.visualViewport?.offsetTop ?? 0;
            const active = document.activeElement;
            const isInputFocused = active && entryModal.contains(active) && (active.matches('input, textarea') || active.isContentEditable);
            const threshold = (baselineHeight || window.innerHeight) * 0.85;
            const viewportRestored = vh >= threshold;
            if (viewportRestored) {
                setKeyboardOpen(false);
            } else if (isInputFocused) {
                setKeyboardOpen(true);
                // 한글 IME 조합 중에는 레이아웃 업데이트 생략 → 조합 텍스트 미표시 이슈 방지
                if (imeComposing) return;
                // 값이 실제로 바뀐 경우에만 스타일 업데이트 (불필요한 reflow 감소)
                if (Math.abs(lastVh - vh) < 1 && Math.abs(lastVtop - vtop) < 1) return;
                lastVh = vh;
                lastVtop = vtop;
                entryModal.style.height = vh + 'px';
                entryModal.style.top = vtop + 'px';
            } else {
                setKeyboardOpen(false);
            }
        };
        const runCheck = () => {
            [0, 100, 250, 400].forEach(ms => setTimeout(checkViewport, ms));
        };
        window.visualViewport.addEventListener('resize', runCheck);
        window.visualViewport.addEventListener('scroll', runCheck);
    }
    window.addEventListener('resize', () => {
        if (!entryModal.classList.contains('hidden') && entryModal.classList.contains('keyboard-open')) {
            const vh = window.visualViewport?.height ?? window.innerHeight;
            const threshold = (baselineHeight || window.innerHeight) * 0.85;
            if (vh >= threshold) setKeyboardOpen(false);
        }
    });
}

// 카카오 SDK 로드 함수
function loadKakaoSDK() {
    // 이미 로드 중이거나 로드 완료된 경우 스킵
    if (window.kakaoSDKLoading || window.kakaoSDKLoaded) {
        return Promise.resolve();
    }
    
    // 이미 스크립트 태그가 있는지 확인
    const existingScript = document.querySelector('script[src*="dapi.kakao.com"]');
    if (existingScript) {
        // 스크립트가 있으면 로드 완료를 기다림
        return new Promise((resolve) => {
            if (window.kakaoSDKLoaded) {
                resolve();
                return;
            }
            
            // 최대 5초 대기
            let attempts = 0;
            const maxAttempts = 50;
            const checkInterval = setInterval(() => {
                attempts++;
                if (window.kakaoSDKLoaded || typeof kakao !== 'undefined') {
                    clearInterval(checkInterval);
                    resolve();
                } else if (attempts >= maxAttempts) {
                    clearInterval(checkInterval);
                    resolve(); // 타임아웃이어도 계속 진행
                }
            }, 100);
        });
    }
    
    // 로드 중 플래그 설정
    window.kakaoSDKLoading = true;
    
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.type = 'text/javascript';
        // Mealog JavaScript 키: 42dce12f04991c35775f3ce1081a3c76
        // 중요: JavaScript SDK는 반드시 JavaScript 키를 사용해야 함 (REST API 키 아님)
        const appkey = '42dce12f04991c35775f3ce1081a3c76';
        
        // 페이지와 동일한 프로토콜 사용 (Mixed Content 방지: HTTPS 페이지에서 HTTP 스크립트 차단됨)
        const protocol = window.location.protocol || 'https:';
        const scriptUrl = protocol + '//dapi.kakao.com/v2/maps/sdk.js?appkey=' + appkey + '&libraries=services&autoload=false';
        script.src = scriptUrl;
        script.async = true;
        
        script.onload = function() {
            // autoload=false를 사용했으므로 kakao.maps.load()를 명시적으로 호출해야 함
            if (typeof kakao !== 'undefined' && kakao && kakao.maps && typeof kakao.maps.load === 'function') {
                kakao.maps.load(function() {
                    // kakao.maps.load() 콜백 내에서 services 라이브러리가 완전히 준비됨
                    try {
                        if (kakao.maps.services && typeof kakao.maps.services.Places !== 'undefined') {
                            window.kakaoSDKLoaded = true;
                            window.kakaoSDKLoading = false;
                            console.log('✅ 카카오 SDK 로드 완료 (services 라이브러리 준비됨)');
                            if (typeof window.onKakaoSDKLoaded === 'function') {
                                window.onKakaoSDKLoaded();
                            }
                            resolve();
                        } else {
                            window.kakaoSDKLoaded = false;
                            window.kakaoSDKLoading = false;
                            console.warn('⚠️ 카카오 SDK 로드 후 services 라이브러리가 준비되지 않았습니다.');
                            console.warn('   - kakao 객체 상태:', {
                                defined: typeof kakao !== 'undefined',
                                maps: typeof kakao?.maps,
                                services: typeof kakao?.maps?.services
                            });
                            reject(new Error('카카오 SDK services 라이브러리 초기화 실패'));
                        }
                    } catch (e) {
                        window.kakaoSDKLoaded = false;
                        window.kakaoSDKLoading = false;
                        console.error('❌ kakao.maps.load 콜백에서 에러:', e);
                        reject(e);
                    }
                });
            } else {
                window.kakaoSDKLoaded = false;
                window.kakaoSDKLoading = false;
                console.error('❌ 카카오 SDK 스크립트는 로드되었지만 kakao.maps.load 함수를 찾을 수 없습니다.');
                reject(new Error('카카오 SDK load 함수를 찾을 수 없음'));
            }
        };
        
        script.onerror = function(e) {
            window.kakaoSDKLoaded = false;
            window.kakaoSDKLoading = false;
            console.error('❌ 카카오 지도 SDK 스크립트 로드 실패');
            console.error('   - 스크립트 URL:', scriptUrl);
            console.error('   - 현재 프로토콜:', window.location.protocol);
            console.error('   - 현재 호스트:', window.location.host);
            console.error('   - 가능한 원인:');
            console.error('     1. 네트워크 연결 문제');
            console.error('     2. 카카오 디벨로퍼스 플랫폼 도메인 미등록');
            console.error('     3. JavaScript 키 오류 또는 카카오맵 사용 설정 OFF');
            console.error('   - 브라우저 개발자 도구(F12) > Network 탭에서 스크립트 로드 상태 확인');
            reject(new Error('카카오 SDK 스크립트 로드 실패: ' + scriptUrl));
        };
        
        document.head.appendChild(script);
    });
}

export function openModal(date, slotId, entryId = null) {
    try {
        const state = appState;
        if (!window.currentUser) return;
        
        if (!date || !slotId) {
            console.error('openModal: 필수 파라미터가 없습니다.', { date, slotId });
            return;
        }
        
        // 카카오 SDK 로드 (비동기, 백그라운드에서 로드)
        loadKakaoSDK().catch(err => {
            console.warn('카카오 SDK 로드 실패 (무시):', err);
        });
        
        state.currentEditingId = entryId;
        state.currentEditingDate = date;
        state.currentEditingSlotId = slotId;
        state.currentPhotos = [];
        state.sharedPhotos = []; // 이미 공유된 사진 목록
        state.originalSharedPhotos = []; // 원본 공유 사진 목록 (삭제 추적용)
        state.wantsToShare = false; // 공유를 원하는지 여부
        // 새 기록 시 비율은 전역 선택값 사용 (수정 시에는 아래에서 기존 기록값으로 덮어씀)
        state.recordPhotoAspectRatio = appState.recordPhotoAspectRatio || '1:1';
        
        const modalTitle = document.getElementById('modalTitle');
        if (modalTitle) {
            const slot = SLOTS.find(s => s.id === slotId);
            if (slot) {
                modalTitle.innerText = slot.label;
            }
        }
        
        // entryId가 있으면 저장된 태그 정보를 미리 저장
        let savedRecord = null;
        if (entryId) {
            savedRecord = window.mealHistory.find(m => m.id === entryId);
        }
        
        // 모든 칩의 active 클래스 제거 (renderEntryChips 전에)
        document.querySelectorAll('.chip, .sub-chip').forEach(el => el.classList.remove('active'));
        
        // 공유 인디케이터 숨기기
        const shareIndicator = document.getElementById('sharePhotoIndicator');
        if (shareIndicator) shareIndicator.classList.add('hidden');
        
        ['placeInput', 'menuDetailInput', 'withWhomInput', 'snackDetailInput', 'snackPlaceInput', 'generalCommentInput', 'snackCommentInput'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        
        // 카카오 검색 버튼 및 placeholder 초기화
        const placeInput = document.getElementById('placeInput');
        const snackPlaceInput = document.getElementById('snackPlaceInput');
        if (placeInput) {
            placeInput.placeholder = '돋보기 버튼으로 장소 검색 또는 직접 입력';
            placeInput.removeAttribute('data-kakao-place-id');
            placeInput.removeAttribute('data-kakao-place-address');
            placeInput.removeAttribute('data-kakao-place-data');
            placeInput.removeAttribute('data-kakao-place-name');
        }
        if (snackPlaceInput) {
            snackPlaceInput.placeholder = '돋보기 버튼으로 장소 검색 또는 직접 입력';
            snackPlaceInput.removeAttribute('data-kakao-place-id');
            snackPlaceInput.removeAttribute('data-kakao-place-address');
            snackPlaceInput.removeAttribute('data-kakao-place-data');
            snackPlaceInput.removeAttribute('data-kakao-place-name');
        }
        
        const mainPhotoContainer = document.getElementById('photoPreviewContainer');
        const snackPhotoContainer = document.getElementById('snackPhotoPreviewContainer');
        if (mainPhotoContainer) mainPhotoContainer.innerHTML = "";
        if (snackPhotoContainer) snackPhotoContainer.innerHTML = "";
        
        window.setRating(3);
        window.setSatiety(3);
        
        const resetModalScrollTop = () => {
            const scrollArea = document.getElementById('modalScrollArea');
            if (!scrollArea) return;
            scrollArea.scrollTop = 0;
            if (typeof scrollArea.scrollTo === 'function') {
                scrollArea.scrollTo({ top: 0, left: 0, behavior: 'auto' });
            }
        };
        // 모달 내부 스크롤 복원 이슈 대응: 즉시 + 다음 프레임 + 짧은 지연에 걸쳐 상단 고정
        resetModalScrollTop();
        
        ['restaurantSuggestions', 'menuSuggestions', 'peopleSuggestions', 'snackSuggestions'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.classList.add('no-scrollbar');
                el.classList.remove('scrollbar-hide');
            }
        });
        
        const slot = SLOTS.find(s => s.id === slotId);
        if (!slot) {
            console.error('슬롯을 찾을 수 없습니다:', slotId);
            return;
        }
        const isS = slot.type === 'snack';
        document.getElementById('optionalFields')?.classList.toggle('hidden', isS);
        const reviewSection = document.getElementById('reviewSection');
        const snackReviewSection = document.getElementById('snackReviewSection');
        if (reviewSection) {
            reviewSection.classList.toggle('hidden', isS);
        }
        if (snackReviewSection) {
            snackReviewSection.classList.toggle('hidden', !isS);
        }
        document.getElementById('btnDelete')?.classList.add('hidden');
        const satietySection = document.getElementById('satietySection');
        if (satietySection) {
            satietySection.classList.toggle('hidden', isS);
        }
        
        // 필드 표시/숨김 처리를 먼저 수행 (renderPhotoPreviews가 올바른 컨테이너를 찾을 수 있도록)
        document.getElementById('mainMealFields')?.classList.toggle('hidden', isS);
        document.getElementById('snackFields')?.classList.toggle('hidden', !isS);
        
        updatePhotoAspectButtons();
        
        if (isS) {
            appState.selectedSnackPlaceMainTag = null;
        }
        
        // 필드 활성화 상태 초기화 (Skip이 아닌 경우 활성화)
        if (!isS) {
            toggleFieldsForSkip(false);
        }
        
        // 버튼 상태 설정 (게스트 모드 체크 포함)
        const btnSave = document.getElementById('btnSave');
        if (btnSave) {
            if (window.currentUser && window.currentUser.isAnonymous) {
                // 게스트 모드: 버튼 비활성화
                btnSave.disabled = true;
                btnSave.className = 'flex-[1.7] flex flex-col items-center justify-center px-3 py-4 bg-slate-300 text-slate-500 text-base font-bold transition-colors cursor-not-allowed';
                btnSave.innerText = '로그인 후 사용할 수 있어요';
            } else {
                // 일반 모드: 버튼 활성화 및 텍스트 설정
                btnSave.disabled = false;
                btnSave.className = 'flex-[1.7] flex flex-col items-center justify-center px-3 py-4 bg-slate-900 text-white text-base font-bold hover:bg-slate-800 active:bg-slate-800 transition-colors';
                btnSave.innerText = entryId ? '수정 완료' : '기록 완료';
            }
        }
        
        // 칩 렌더링 (필드 표시/숨김 처리 후)
        renderEntryChips();
        
        if (entryId && savedRecord) {
            const r = savedRecord;
            if (r) {
                // photos가 배열인지 확인하고, 배열이 아니면 배열로 변환
                state.currentPhotos = Array.isArray(r.photos) ? r.photos : (r.photos ? [r.photos] : []);
                // sharedPhotos도 배열인지 확인
                state.sharedPhotos = Array.isArray(r.sharedPhotos) ? r.sharedPhotos : (r.sharedPhotos ? [r.sharedPhotos] : []);
                state.originalSharedPhotos = Array.isArray(r.sharedPhotos) ? [...r.sharedPhotos] : (r.sharedPhotos ? [r.sharedPhotos] : []); // 원본 복사 (삭제 추적용)
                state.recordPhotoAspectRatio = (r.photoAspectRatio && PHOTO_ASPECT_OPTIONS.includes(r.photoAspectRatio)) ? r.photoAspectRatio : '1:1';
                
                // 공유 금지 체크
                const isShareBanned = r.shareBanned === true;
                if (isShareBanned) {
                    // 공유 금지된 경우 공유 상태를 false로 설정
                    state.wantsToShare = false;
                } else {
                    state.wantsToShare = (state.sharedPhotos && state.sharedPhotos.length > 0); // 이미 공유된 사진이 있으면 공유 상태로
                }
                
                // 필드 표시/숨김 처리 후에 renderPhotoPreviews 호출
                renderPhotoPreviews();
                // 공유 인디케이터 업데이트
                updateShareIndicator();
                setVal('placeInput', r.place || "");
                // 수정 시 기존 기록에 카카오맵 정보가 있으면 placeInput에 복원 (저장 시 유지)
                const _pi = document.getElementById('placeInput');
                if (_pi && (r.placeId || r.placeAddress || r.placeData)) {
                    if (r.placeId) _pi.setAttribute('data-kakao-place-id', r.placeId);
                    _pi.setAttribute('data-kakao-place-address', (r.placeAddress != null && r.placeAddress !== undefined) ? String(r.placeAddress) : '');
                    if (r.placeData && typeof r.placeData === 'object') _pi.setAttribute('data-kakao-place-data', JSON.stringify(r.placeData));
                    _pi.setAttribute('data-kakao-place-name', (r.placeData && r.placeData.name) || r.place || '');
                }
                setVal('menuDetailInput', r.menuDetail || "");
                setVal('withWhomInput', r.withWhomDetail || "");
                setVal('snackDetailInput', r.menuDetail || "");
                setVal('snackPlaceInput', r.place || "");
                // 간식 수정 시 카카오맵 정보가 있으면 snackPlaceInput에 복원
                const _spi = document.getElementById('snackPlaceInput');
                if (isS && _spi && (r.placeId || r.placeAddress || r.placeData)) {
                    if (r.placeId) _spi.setAttribute('data-kakao-place-id', r.placeId);
                    _spi.setAttribute('data-kakao-place-address', (r.placeAddress != null && r.placeAddress !== undefined) ? String(r.placeAddress) : '');
                    if (r.placeData && typeof r.placeData === 'object') _spi.setAttribute('data-kakao-place-data', JSON.stringify(r.placeData));
                    _spi.setAttribute('data-kakao-place-name', (r.placeData && r.placeData.name) || r.place || '');
                }
                setVal('generalCommentInput', r.comment || "");
                setVal('snackCommentInput', r.comment || "");
                
                if (r.rating) window.setRating(r.rating);
                if (r.satiety) window.setSatiety(r.satiety);
                
                // 공유 인디케이터 표시
                updateShareIndicator();

                // meal 문서에는 sharedPhotos가 있는데 sharedPhotos 컬렉션(모먼트)에 없으면 동기화 시도
                if (r.id && r.sharedPhotos && Array.isArray(r.sharedPhotos) && r.sharedPhotos.length > 0 && !r.shareBanned) {
                    const inSharedColl = window.sharedPhotos?.some?.(p => p.entryId === r.id);
                    if (!inSharedColl) {
                        dbOps.sharePhotos(r.sharedPhotos, r).then(() => {
                            if (!window.sharedPhotos) window.sharedPhotos = [];
                            const newEntries = r.sharedPhotos.map(url => ({ entryId: r.id, photoUrl: url, userId: window.currentUser?.uid }));
                            window.sharedPhotos = (window.sharedPhotos || []).filter(p => p.entryId !== r.id).concat(newEntries);
                            updateTimelineShareIndicators();
                            if (appState.currentTab === 'gallery') renderGallery();
                            showToast('모먼트에 반영되었습니다.', 'success');
                        }).catch((e) => {
                            console.warn('모먼트 동기화 실패 (무시):', e);
                        });
                    }
                }

                // 태그 활성화 처리 함수
                const activateTags = () => {
                    // 식사 방식 (mealType)
                    if (r.mealType) {
                        const typeChips = document.getElementById('typeChips');
                        if (typeChips) {
                            typeChips.querySelectorAll('button.chip').forEach(ch => {
                                if (ch.innerText.trim() === r.mealType.trim()) {
                                    ch.classList.add('active');
                                }
                            });
                        }
                    }
                    
                    // 메뉴 카테고리 (category)
                    if (r.category) {
                        const categoryChips = document.getElementById('categoryChips');
                        if (categoryChips) {
                            categoryChips.querySelectorAll('button.chip').forEach(ch => {
                                if (ch.innerText.trim() === r.category.trim()) {
                                    ch.classList.add('active');
                                }
                            });
                        }
                    }
                    
                    // 함께한 사람 (withWhom)
                    if (r.withWhom) {
                        const withChips = document.getElementById('withChips');
                        if (withChips) {
                            withChips.querySelectorAll('button.chip').forEach(ch => {
                                if (ch.innerText.trim() === r.withWhom.trim()) {
                                    ch.classList.add('active');
                                }
                            });
                        }
                    }
                    
                    // 간식 타입 (snackType)
                    if (r.snackType) {
                        const snackTypeChips = document.getElementById('snackTypeChips');
                        if (snackTypeChips) {
                            snackTypeChips.querySelectorAll('button.chip').forEach(ch => {
                                if (ch.innerText.trim() === r.snackType.trim()) {
                                    ch.classList.add('active');
                                }
                            });
                        }
                    }
                    
                    // 간식 어디서 (snackPlace): 메인칩 선택 시 개별 추천 표시
                    if (isS && r.place) {
                        const snackPlaceMain = window.userSettings?.tags?.snackPlaceMain || ['집', '사무실', '카페'];
                        if (snackPlaceMain.includes(r.place.trim())) {
                            appState.selectedSnackPlaceMainTag = r.place.trim();
                            const subTags = window.userSettings?.subTags?.place || [];
                            window.renderSecondary('snackPlaceSuggestions', subTags, 'snackPlaceInput', r.place.trim(), 'place');
                        }
                        const snackPlaceTypeChips = document.getElementById('snackPlaceTypeChips');
                        if (snackPlaceTypeChips) {
                            snackPlaceTypeChips.querySelectorAll('button.chip').forEach(ch => {
                                if (ch.innerText.trim() === r.place.trim()) {
                                    ch.classList.add('active');
                                }
                            });
                        }
                        const snackPlaceSuggestions = document.getElementById('snackPlaceSuggestions');
                        if (snackPlaceSuggestions) {
                            snackPlaceSuggestions.querySelectorAll('button.sub-chip').forEach(ch => {
                                if (ch.innerText.trim().replace(/\s*★\s*$/, '') === r.place.trim()) {
                                    ch.classList.add('active');
                                }
                            });
                        }
                    }
                    
                    // 장소 (place) - sub-chip (본식)
                    if (r.place) {
                        const restaurantSuggestions = document.getElementById('restaurantSuggestions');
                        if (restaurantSuggestions) {
                            restaurantSuggestions.querySelectorAll('button.sub-chip').forEach(ch => {
                                if (ch.innerText.trim() === r.place.trim()) {
                                    ch.classList.add('active');
                                }
                            });
                        }
                    }
                    
                    // 메뉴 상세 (menuDetail) - sub-chip (다중 선택 가능, 쉼표로 구분)
                    if (r.menuDetail) {
                        const menuSuggestions = document.getElementById('menuSuggestions');
                        const menuDetailInput = document.getElementById('menuDetailInput');
                        if (menuSuggestions && menuDetailInput) {
                            // 쉼표로 구분된 여러 값 처리
                            const detailValues = r.menuDetail.split(',').map(v => v.trim()).filter(v => v);
                            const activeValues = [];
                            menuSuggestions.querySelectorAll('button.sub-chip').forEach(ch => {
                                const chipText = ch.innerText.trim();
                                if (detailValues.includes(chipText)) {
                                    ch.classList.add('active');
                                    activeValues.push(chipText);
                                }
                            });
                            // input에 선택된 값들 저장
                            if (activeValues.length > 0) {
                                menuDetailInput.value = activeValues.join(', ');
                            } else {
                                // 자주 사용한 태그에 없는 경우 입력값 그대로 표시
                                menuDetailInput.value = r.menuDetail;
                            }
                        }
                    }
                    
                    // 함께한 사람 상세 (withWhomDetail) - sub-chip (다중 선택 가능)
                    if (r.withWhomDetail) {
                        const peopleSuggestions = document.getElementById('peopleSuggestions');
                        const withWhomInput = document.getElementById('withWhomInput');
                        if (peopleSuggestions && withWhomInput) {
                            // 쉼표로 구분된 여러 값 처리
                            const detailValues = r.withWhomDetail.split(',').map(v => v.trim()).filter(v => v);
                            const activeValues = [];
                            peopleSuggestions.querySelectorAll('button.sub-chip').forEach(ch => {
                                const chipText = ch.innerText.trim();
                                if (detailValues.includes(chipText)) {
                                    ch.classList.add('active');
                                    activeValues.push(chipText);
                                }
                            });
                            // input에 선택된 값들 저장
                            if (activeValues.length > 0) {
                                withWhomInput.value = activeValues.join(', ');
                            }
                        }
                    }
                };
                
                // DOM 렌더링 완료 후 태그 활성화 (여러 번 시도)
                const tryActivateTags = (attempts = 0) => {
                    if (attempts > 20) {
                        console.warn('태그 활성화 실패: 최대 시도 횟수 초과');
                        return;
                    }
                    
                    requestAnimationFrame(() => {
                        const typeChips = document.getElementById('typeChips');
                        const hasChips = typeChips && typeChips.querySelectorAll('button.chip').length > 0;
                        
                        if (hasChips || attempts > 10) {
                            activateTags();
                            // sub-chip은 나중에 렌더링될 수 있으므로 여러 번 재시도
                            setTimeout(() => {
                                activateTags();
                                setTimeout(() => activateTags(), 100);
                            }, 100);
                        } else {
                            setTimeout(() => tryActivateTags(attempts + 1), 50);
                        }
                    });
                };
                
                // 즉시 한 번 시도하고, 그 다음 재시도
                setTimeout(() => tryActivateTags(), 50);
                
                // Skip 선택 시 필드 숨기기 처리
                if (r.mealType === 'Skip' || r.mealType === '건너뜀') {
                    setTimeout(() => {
                        toggleFieldsForSkip(true);
                    }, 100);
                }
                
                // 간식 타입 선택 시 추천 태그 업데이트
                if (isS && r.snackType) {
                    const subTags = window.userSettings.subTags.snack || [];
                    window.renderSecondary('snackSuggestions', subTags, 'snackDetailInput', r.snackType, 'snack');
                }
                // 간식 어디서: place가 메인태그에 있으면 선택 상태로 추천 표시
                if (isS && r.place) {
                    const snackPlaceMain = window.userSettings?.tags?.snackPlaceMain || ['집', '사무실', '카페'];
                    if (snackPlaceMain.includes(r.place.trim())) {
                        appState.selectedSnackPlaceMainTag = r.place.trim();
                        const subTags = window.userSettings?.subTags?.place || [];
                        window.renderSecondary('snackPlaceSuggestions', subTags, 'snackPlaceInput', r.place.trim(), 'place');
                    }
                }
                
                document.getElementById('btnDelete')?.classList.remove('hidden');
            }
        }
        
        // 간식 모드일 때 초기 추천 태그 표시
        if (isS) {
            // 필드가 보이는 상태로 만든 후 추천 태그 표시
            const snackFields = document.getElementById('snackFields');
            if (snackFields) snackFields.classList.remove('hidden');
            
            const subTags = window.userSettings.subTags.snack || [];
            const snackType = document.querySelector('#snackTypeChips button.active')?.innerText;
            window.renderSecondary('snackSuggestions', subTags, 'snackDetailInput', snackType || null, 'snack');
        }
        
        // 입력 필드에 이벤트 리스너 추가 (간식 입력 시 추천 태그 업데이트)
        // 조합(composition) 중에는 DOM 업데이트 지연 → 한글 IME 모바일 텍스트 미표시 이슈 방지
        const snackDetailInput = document.getElementById('snackDetailInput');
        if (snackDetailInput) {
            if (snackDetailInput._snackCompositionInit) {
                // 이미 초기화됨 (모달 재오픈 시 중복 방지)
            } else {
                const updateSnackSuggestions = () => {
                    const subTags = window.userSettings.subTags.snack || [];
                    const snackType = document.querySelector('#snackTypeChips button.active')?.innerText;
                    window.renderSecondary('snackSuggestions', subTags, 'snackDetailInput', snackType || null, 'snack');
                };
                addCompositionAwareInput(snackDetailInput, updateSnackSuggestions);
                snackDetailInput._snackCompositionInit = true;
            }
        }
        
        const entryModal = document.getElementById('entryModal');
        if (entryModal) {
            entryModal.classList.remove('hidden');
            entryModal.classList.remove('keyboard-open');
            entryModal.style.height = '';
            entryModal.style.top = '';
            resetModalScrollTop();
            requestAnimationFrame(resetModalScrollTop);
            setTimeout(resetModalScrollTop, 60);
            initEntryModalKeyboardHandling(entryModal);
            if (typeof entryModal.setKeyboardBaseline === 'function') {
                entryModal.setKeyboardBaseline();
            }
        } else {
            console.error('entryModal 요소를 찾을 수 없습니다.');
        }
    } catch (error) {
        console.error('openModal 오류:', error);
        const loadingOverlay = document.getElementById('loadingOverlay');
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
}

export function closeModal() {
    const entryModal = document.getElementById('entryModal');
    if (entryModal) {
        entryModal.classList.remove('keyboard-open');
        entryModal.style.height = '';
        entryModal.style.top = '';
        entryModal.classList.add('hidden');
    }
    // 모달을 닫을 때 로딩 오버레이도 숨김
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) {
        loadingOverlay.classList.add('hidden');
    }
    // 상태 초기화
    const state = appState;
    if (state) {
        state.currentEditingId = null;
        state.currentPhotos = [];
        state.sharedPhotos = [];
        state.originalSharedPhotos = [];
        state.wantsToShare = false;
    }
}

export async function saveEntry() {
    // 로딩 오버레이 참조를 함수 시작 부분에서 가져옴
    const loadingOverlay = document.getElementById('loadingOverlay');
    const entryModal = document.getElementById('entryModal');
    
    // 모바일 IME(한글 등) 조합 중인 텍스트가 input.value에 반영되도록 blur 후 대기
    // 스페이스/선택 전에 '기록 완료'를 누르면 조합 중인 글자가 누락되는 문제 방지
    const active = document.activeElement;
    if (active && entryModal?.contains(active) && (active.matches('input, textarea') || active.isContentEditable)) {
        active.blur();
        await new Promise(r => setTimeout(r, 80));
    }
    
    try {
        const state = appState;
        
        // 게스트 모드에서는 저장 불가
        if (window.currentUser && window.currentUser.isAnonymous) {
            showToast("게스트 모드에서는 기록할 수 없습니다. 로그인 후 이용해주세요.", "error");
            if (loadingOverlay) loadingOverlay.classList.add('hidden');
            return;
        }
        if (window.currentUser && isDemoUser(window.currentUser)) {
            showToast('샘플 계정에서는 기록을 저장할 수 없습니다. 로그인 후 이용해 주세요.', 'error');
            if (loadingOverlay) loadingOverlay.classList.add('hidden');
            return;
        }
        
        // 필수 상태 확인
        if (!state.currentEditingSlotId || !state.currentEditingDate) {
            console.error('저장 실패: 필수 정보가 없습니다.', { 
                slotId: state.currentEditingSlotId, 
                date: state.currentEditingDate 
            });
            showToast("저장할 정보가 없습니다.", 'error');
            if (loadingOverlay) loadingOverlay.classList.add('hidden');
            return;
        }
        
        const getT = (id) => document.getElementById(id)?.querySelector('.chip.active')?.innerText || '';
        const slot = SLOTS.find(s => s.id === state.currentEditingSlotId);
        if (!slot) {
            console.error('저장 실패: 슬롯을 찾을 수 없습니다.', state.currentEditingSlotId);
            showToast("저장할 정보가 없습니다.", 'error');
            if (loadingOverlay) loadingOverlay.classList.add('hidden');
            return;
        }
        const isS = slot.type === 'snack';
        const mealType = getT('typeChips');
        const isSk = mealType === 'Skip' || mealType === '건너뜀';
        const placeInputVal = document.getElementById('placeInput')?.value || '';
        const menuInputVal = document.getElementById('menuDetailInput')?.value || '';
        const withInputVal = document.getElementById('withWhomInput')?.value || '';
        
        // 간식 입력값 가져오기 (hidden 상태여도 값을 가져올 수 있음)
        const snackDetailInput = document.getElementById('snackDetailInput');
        const snackInputVal = snackDetailInput ? snackDetailInput.value.trim() : '';
        const snackPlaceInputVal = document.getElementById('snackPlaceInput')?.value?.trim() || '';
        
        // 디버깅: 간식 입력값 확인
        if (isS) {
            console.log('간식 저장 시도:', {
                isS,
                snackInputVal,
                snackDetailInput: snackDetailInput ? 'found' : 'not found',
                snackInputElementValue: snackDetailInput?.value,
                snackFieldsVisible: !document.getElementById('snackFields')?.classList.contains('hidden')
            });
        }
        
        const newSettings = JSON.parse(JSON.stringify(window.userSettings));
        if (!newSettings.subTags) newSettings.subTags = JSON.parse(JSON.stringify(DEFAULT_SUB_TAGS));
        
        // subTags의 각 배열이 정의되어 있는지 확인
        if (!newSettings.subTags.place) newSettings.subTags.place = [];
        if (!newSettings.subTags.menu) newSettings.subTags.menu = [];
        if (!newSettings.subTags.people) newSettings.subTags.people = [];
        if (!newSettings.subTags.snack) newSettings.subTags.snack = [];
        
        let tagsChanged = false;
        if (placeInputVal && !newSettings.subTags.place.find(t => (t.text || t) === placeInputVal)) {
            newSettings.subTags.place.push({ text: placeInputVal, parent: mealType });
            tagsChanged = true;
        }
        const selectedSnackPlaceMain = appState.selectedSnackPlaceMainTag || null;
        if (isS && snackPlaceInputVal && !newSettings.subTags.place.find(t => (t.text || t) === snackPlaceInputVal)) {
            newSettings.subTags.place.push({ text: snackPlaceInputVal, parent: selectedSnackPlaceMain || snackPlaceInputVal });
            tagsChanged = true;
        }
        // 메뉴 상세 태그는 다중 선택 가능 (쉼표로 구분)
        if (menuInputVal) {
            const menuValues = menuInputVal.split(',').map(v => v.trim()).filter(v => v);
            menuValues.forEach(val => {
                if (!newSettings.subTags.menu.find(t => (t.text || t) === val)) {
                    newSettings.subTags.menu.push({ text: val, parent: getT('categoryChips') });
                    tagsChanged = true;
                }
            });
        }
        // 함께한 사람 상세 태그는 다중 선택 가능 (쉼표로 구분)
        if (withInputVal) {
            const withValues = withInputVal.split(',').map(v => v.trim()).filter(v => v);
            withValues.forEach(val => {
                if (!newSettings.subTags.people.find(t => (t.text || t) === val)) {
                    newSettings.subTags.people.push({ text: val, parent: getT('withChips') });
                    tagsChanged = true;
                }
            });
        }
        if (isS && snackInputVal && !newSettings.subTags.snack.find(t => (t.text || t) === snackInputVal)) {
            newSettings.subTags.snack.push({ text: snackInputVal, parent: getT('snackTypeChips') });
            tagsChanged = true;
        }
        
        if (tagsChanged) {
            window.userSettings = newSettings;
            // 디바운싱: 1초 내 여러 태그 변경을 묶어서 한 번만 저장
            clearTimeout(settingsSaveTimeout);
            settingsSaveTimeout = setTimeout(async () => {
                try {
                    await dbOps.saveSettings(window.userSettings);
                    console.log('디바운싱된 설정 저장 완료');
                } catch (e) {
                    console.error('설정 저장 실패:', e);
                    // dbOps.saveSettings에서 이미 에러 토스트를 표시하므로 여기서는 로그만
                }
            }, 1000);
        }
        
        // main 끼니: 동일 (date, slotId)에 이미 기록이 있으면 수정 모드로 전환 (중복 방지)
        let idToUse = state.currentEditingId;
        if (!idToUse && !isS && state.currentEditingDate && state.currentEditingSlotId && window.mealHistory?.length > 0) {
            const existing = window.mealHistory.find(m =>
                m.date === state.currentEditingDate &&
                m.slotId === state.currentEditingSlotId &&
                ['morning', 'lunch', 'dinner'].includes(m.slotId)
            );
            if (existing) idToUse = existing.id;
        }
        // 기존 기록에서 shareBanned 필드 가져오기 (수정 시 유지)
        const existingRecord = idToUse ? window.mealHistory.find(m => m.id === idToUse) : null;
        const shareBanned = existingRecord?.shareBanned === true;
        
        // 카카오맵 API로 입력된 장소 정보 확인 (식사: placeInput, 간식: snackPlaceInput)
        const placeInput = document.getElementById('placeInput');
        const snackPlaceInput = document.getElementById('snackPlaceInput');
        const kakaoSourceInput = isS ? snackPlaceInput : placeInput;
        const kakaoPlaceId = kakaoSourceInput?.getAttribute('data-kakao-place-id');
        const kakaoPlaceAddress = kakaoSourceInput?.getAttribute('data-kakao-place-address');
        const kakaoPlaceData = kakaoSourceInput?.getAttribute('data-kakao-place-data');
        const kakaoPlaceName = kakaoSourceInput?.getAttribute('data-kakao-place-name') || '';
        const placeValForKakao = isS ? snackPlaceInputVal : placeInputVal;
        // 카카오에서 선택한 장소명을 수정한 경우: 주소·placeId를 저장하지 않음 (잘못된 주소 매칭 방지)
        const nameMatches = !kakaoPlaceName || (String(placeValForKakao || '').trim() === String(kakaoPlaceName).trim());
        const shouldUseKakaoFields = kakaoPlaceId && !isSk && nameMatches;

        const sourcePhotos = Array.isArray(state.currentPhotos) ? [...state.currentPhotos] : [];
        const isBase64Photo = (photo) => typeof photo === 'string' && photo.startsWith('data:image');
        const existingPhotoUrls = sourcePhotos.filter(photo => typeof photo === 'string' && photo && !isBase64Photo(photo));

        const record = {
            id: idToUse,
            date: state.currentEditingDate,
            slotId: state.currentEditingSlotId,
            mealType,
            withWhom: getT('withChips'),
            withWhomDetail: isSk ? '' : withInputVal,
            category: getT('categoryChips'),
            placeType: '',
            snackType: getT('snackTypeChips'),
            photoAspectRatio: state.recordPhotoAspectRatio || '1:1',
            // Firestore에는 URL만 저장하고, base64는 저장 직후 Storage로 업로드 후 치환한다.
            photos: existingPhotoUrls,
            menuDetail: isSk ? '' : (isS ? snackInputVal : menuInputVal),
            place: isSk ? '' : (isS ? (snackPlaceInputVal || appState.selectedSnackPlaceMainTag || '') : placeInputVal),
            comment: isSk ? '' : (isS ? (document.getElementById('snackCommentInput')?.value || '') : (document.getElementById('generalCommentInput')?.value || '')),
            rating: (isSk) ? null : state.currentRating,
            satiety: (isSk || isS) ? null : state.currentSatiety,
            time: new Date().toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' })
        };
        
        // 카카오맵 API로 입력된 식당인 경우 추가 정보 저장 (선택한 장소명을 수정한 경우는 제외 → 잘못된 주소 매칭 방지)
        if (shouldUseKakaoFields) {
            record.placeId = kakaoPlaceId;
            record.kakaoPlaceId = kakaoPlaceId;
            record.placeAddress = kakaoPlaceAddress || '';
            if (kakaoPlaceData) {
                try {
                    record.placeData = JSON.parse(kakaoPlaceData);
                } catch (e) {
                    console.warn('카카오 장소 데이터 파싱 실패:', e);
                }
            }
            record.kakaoPlace = true; // 카카오맵으로 입력된 식당임을 표시
        }
        
        // shareBanned 필드 추가 (기존 값 유지)
        if (shareBanned) {
            record.shareBanned = true;
        }
        
        // 디버깅: 저장될 record 확인
        if (isS) {
            console.log('저장될 간식 record:', record);
        }
        
        if (loadingOverlay) loadingOverlay.classList.remove('hidden');
        
        // 공유 금지 체크
        const isShareBanned = record.id ? (window.mealHistory.find(m => m.id === record.id)?.shareBanned === true) : false;
        
        // 상태 초기화 전에 공유 의사를 보존한다. (수정 저장 + 사진 업로드 시 필요)
        const wantsToShare = Boolean(state.wantsToShare);
        
        // 공유할 사진 목록 결정 (단순화: wantsToShare와 currentPhotos만 사용)
        let photosToShare = (!isShareBanned && wantsToShare && existingPhotoUrls.length > 0)
            ? [...existingPhotoUrls]    // 공유 활성화: 현재 URL 사진 전체
            : [];                        // 공유 비활성화 또는 금지: 빈 배열
        
        // record에 sharedPhotos 필드 추가
        record.sharedPhotos = photosToShare;
        
        console.log('저장 시작:', record);
        
        // 모달과 로딩 오버레이를 먼저 닫기 (저장 전에 닫아서 사용자 경험 개선)
        if (entryModal) {
            entryModal.classList.add('hidden');
            console.log('모달 닫기 완료');
        }
        
        // 로딩 오버레이 숨김 (모달 닫기 직후)
        if (loadingOverlay) {
            loadingOverlay.classList.add('hidden');
            console.log('로딩 오버레이 숨김');
        }
        
        // 현재 탭과 편집 날짜를 미리 저장 (상태 초기화 전에)
        const currentTab = state.currentTab;
        const editingDate = state.currentEditingDate;
        
        // 서버 저장 전 UI를 먼저 갱신하기 위한 낙관 반영용 임시 레코드
        const wasNewRecord = !record.id;
        const optimisticTempId = wasNewRecord ? `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : null;
        const optimisticSlotKey = `${record.date || ''}__${record.slotId || ''}`;
        const hasPendingBase64Photos = sourcePhotos.some(isBase64Photo);
        if (!window._pendingPhotoUploadByEntryId) window._pendingPhotoUploadByEntryId = {};
        if (!window._pendingPhotoUploadBySlotKey) window._pendingPhotoUploadBySlotKey = {};
        if (hasPendingBase64Photos) {
            if (record.id || optimisticTempId) window._pendingPhotoUploadByEntryId[record.id || optimisticTempId] = true;
            window._pendingPhotoUploadBySlotKey[optimisticSlotKey] = true;
        }
        const optimisticRecord = {
            ...record,
            id: record.id || optimisticTempId,
            photos: [...sourcePhotos]
        };
        const applyOptimisticMealRecord = () => {
            if (!window.mealHistory || !Array.isArray(window.mealHistory) || !optimisticRecord.id) return;
            const byId = window.mealHistory.findIndex(m => m.id === optimisticRecord.id);
            if (byId >= 0) {
                window.mealHistory[byId] = optimisticRecord;
            } else if (!record.id && !isS) {
                // main 끼니 신규 등록은 같은 날짜/슬롯 카드 교체
                const sameSlot = window.mealHistory.findIndex(m => m.date === optimisticRecord.date && m.slotId === optimisticRecord.slotId);
                if (sameSlot >= 0) window.mealHistory[sameSlot] = optimisticRecord;
                else window.mealHistory.push(optimisticRecord);
            } else {
                window.mealHistory.push(optimisticRecord);
            }
            window.mealHistory.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.time || '').localeCompare(a.time || ''));
        };
        applyOptimisticMealRecord();
        // 공유 아이콘도 서버 반영 전에 즉시 낙관 반영
        if (optimisticRecord.id && !isShareBanned) {
            if (!window.sharedPhotos || !Array.isArray(window.sharedPhotos)) window.sharedPhotos = [];
            if (wantsToShare) {
                const optimisticShared = (sourcePhotos.length > 0 ? sourcePhotos : ['']).map(url => ({
                    entryId: optimisticRecord.id,
                    photoUrl: url || '',
                    userId: window.currentUser?.uid
                }));
                window.sharedPhotos = window.sharedPhotos.filter(p => p.entryId !== optimisticRecord.id).concat(optimisticShared);
            } else {
                window.sharedPhotos = window.sharedPhotos.filter(p => p.entryId !== optimisticRecord.id);
            }
            updateTimelineShareIndicators();
        }
        // 리스너 재렌더가 즉시 덮어쓰지 않도록 짧게 프리즈
        window._timelineRerenderFreezeUntil = Date.now() + 1200;
        if (currentTab === 'timeline' && editingDate) {
            try {
                if (window.jumpToDate) window.jumpToDate(editingDate);
                updateTimelineShareIndicators();
            } catch (e) {
                console.warn('저장 직후 타임라인 낙관 반영 실패:', e);
            }
        } else if (currentTab === 'gallery') {
            try {
                renderGallery();
                const feedContent = document.getElementById('feedContent');
                if (feedContent) renderFeed();
            } catch (e) {
                console.warn('저장 직후 갤러리 낙관 반영 실패:', e);
            }
        } else if (currentTab === 'feed') {
            try {
                const feedContent = document.getElementById('feedContent');
                if (feedContent) renderFeed();
            } catch (e) {
                console.warn('저장 직후 피드 낙관 반영 실패:', e);
            }
        }
        
        // 공유 상태 변경 여부 추적 변수 (함수 스코프)
        // 상태 초기화 전에 originalSharedPhotos 확인
        const hadSharedPhotos = state.originalSharedPhotos && state.originalSharedPhotos.length > 0;
        let sharedPhotosUpdated = false;
        
        // 상태 초기화 (모달 닫기 직후)
        state.currentEditingId = null;
        state.currentPhotos = [];
        state.sharedPhotos = [];
        state.originalSharedPhotos = [];
        state.wantsToShare = false;
        
        // 저장 실행 (모달과 로딩 오버레이가 이미 닫힌 상태에서)
        // 새 레코드인 경우 ID를 먼저 확보해야 공유 시 entryId를 올바르게 설정할 수 있음
        try {
            const savedId = await dbOps.save(record);
            // 새 레코드인 경우 생성된 ID를 record에 설정
            if (!record.id && savedId) {
                record.id = savedId;
                console.log('새 레코드 ID 확보:', savedId);
            }
            // 신규 등록 시 임시 ID를 실제 ID로 치환 (이후 URL 반영 merge가 정상 동작하도록)
            if (wasNewRecord && optimisticTempId && savedId && window.mealHistory && Array.isArray(window.mealHistory)) {
                const tempIdx = window.mealHistory.findIndex(m => m.id === optimisticTempId);
                if (tempIdx >= 0) {
                    window.mealHistory[tempIdx] = { ...window.mealHistory[tempIdx], id: savedId };
                }
            }
            if (hasPendingBase64Photos && wasNewRecord && optimisticTempId && savedId) {
                window._pendingPhotoUploadByEntryId[savedId] = true;
                delete window._pendingPhotoUploadByEntryId[optimisticTempId];
            }
            if (wasNewRecord && optimisticTempId && savedId && window.sharedPhotos && Array.isArray(window.sharedPhotos)) {
                window.sharedPhotos = window.sharedPhotos.map(p => (
                    p.entryId === optimisticTempId ? { ...p, entryId: savedId } : p
                ));
                updateTimelineShareIndicators();
            }

            // 새로 추가한 base64 사진은 문서 ID 확보 후 Storage 업로드 -> URL로 record.photos 치환
            const base64Photos = sourcePhotos.filter(isBase64Photo);
            if (base64Photos.length > 0 && record.id && window.currentUser?.uid) {
                const preloadImage = (url, timeoutMs = 1500) => new Promise((resolve) => {
                    if (!url || typeof url !== 'string') {
                        resolve(false);
                        return;
                    }
                    const img = new Image();
                    let done = false;
                    const finish = (ok) => {
                        if (done) return;
                        done = true;
                        resolve(ok);
                    };
                    const timer = setTimeout(() => finish(false), timeoutMs);
                    img.onload = () => { clearTimeout(timer); finish(true); };
                    img.onerror = () => { clearTimeout(timer); finish(false); };
                    img.src = url;
                });
                try {
                    const uploadedUrls = await Promise.all(
                        base64Photos.map((photo) => uploadBase64ToStorage(photo, window.currentUser.uid, record.id))
                    );
                    let uploadedIndex = 0;
                    const finalPhotoUrls = sourcePhotos.reduce((acc, photo) => {
                        if (isBase64Photo(photo)) {
                            const uploaded = uploadedUrls[uploadedIndex++];
                            if (uploaded) acc.push(uploaded);
                            return acc;
                        }
                        if (typeof photo === 'string' && photo) acc.push(photo);
                        return acc;
                    }, []);

                    record.photos = finalPhotoUrls;
                    photosToShare = (!isShareBanned && wantsToShare && finalPhotoUrls.length > 0)
                        ? [...finalPhotoUrls]
                        : [];
                    record.sharedPhotos = photosToShare;

                    // 1차 저장 후 URL 기준으로 조용히 한 번 더 저장해 base64 잔존을 방지
                    await dbOps.save(record, true);
                    
                    // URL 이미지가 실제 로드된 뒤에 로컬 카드 사진을 URL로 바꿔 전환 깜빡임을 줄임
                    await preloadImage(finalPhotoUrls[0]);
                    if (window.mealHistory && Array.isArray(window.mealHistory)) {
                        const localIdx = window.mealHistory.findIndex(m => m.id === record.id);
                        if (localIdx >= 0) {
                            window.mealHistory[localIdx] = { ...window.mealHistory[localIdx], photos: [...finalPhotoUrls] };
                        }
                    }
                } catch (uploadError) {
                    console.error('사진 업로드 실패:', uploadError);
                    showToast("사진 업로드 중 오류가 발생해 일부 사진이 저장되지 않았습니다.", 'error');
                    // 업로드 실패 시 기존 URL 사진만 유지하여 저장
                    record.photos = existingPhotoUrls;
                    photosToShare = (!isShareBanned && wantsToShare && existingPhotoUrls.length > 0)
                        ? [...existingPhotoUrls]
                        : [];
                    record.sharedPhotos = photosToShare;
                    await dbOps.save(record, true);
                } finally {
                    if (record.id) delete window._pendingPhotoUploadByEntryId[record.id];
                    if (optimisticTempId) delete window._pendingPhotoUploadByEntryId[optimisticTempId];
                    delete window._pendingPhotoUploadBySlotKey[optimisticSlotKey];
                }
            }

            console.log('저장 완료');
            // 낙관적 반영: 리스너 도착 전에 mealHistory에 즉시 반영해 스크롤·렌더가 최신 데이터 기준으로 동작
            if (record.id && window.mealHistory && Array.isArray(window.mealHistory)) {
                const idx = window.mealHistory.findIndex(m => m.id === record.id);
                const merged = { ...record };
                if (idx >= 0) {
                    window.mealHistory[idx] = merged;
                } else {
                    window.mealHistory.push(merged);
                }
                window.mealHistory.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.time || '').localeCompare(a.time || ''));
            }
            // 저장 직후 잠깐 타임라인 전체 재렌더를 막아, jumpToDate·스크롤이 리스너 재렌더에 덮이지 않게 함
            window._timelineRerenderFreezeUntil = Date.now() + 800;
            
            // 공유 처리 (ID 확보 후 실행, 비동기로 떼어 두어 체감 속도 개선)
            // sharePhotos 함수가 기존 문서 삭제 + 새 문서 추가 + record.sharedPhotos 필드 업데이트를 모두 처리
            // 공유 상태가 변경되었을 때만 호출 (공유 설정 또는 공유 해제)
            if (record.id) {
                // 현재 공유할 사진이 있는지 확인
                const hasPhotosToShare = photosToShare && photosToShare.length > 0;
                
                // 공유 상태가 변경된 경우에만 호출
                // 1. 공유할 사진이 있는 경우 (공유 설정)
                // 2. 기존에 공유된 사진이 있었는데 지금은 없는 경우 (공유 해제)
                if (hasPhotosToShare || hadSharedPhotos) {
                    sharedPhotosUpdated = true;
                    // 공유 화살표는 먼저 낙관 반영하고, sharePhotos는 백그라운드로 보내서 체감 지연 감소
                    if (record.id) {
                        if (hasPhotosToShare && photosToShare?.length) {
                            if (!window.sharedPhotos) window.sharedPhotos = [];
                            const newEntries = photosToShare.map(url => ({ entryId: record.id, photoUrl: url, userId: window.currentUser?.uid }));
                            window.sharedPhotos = (window.sharedPhotos || []).filter(p => p.entryId !== record.id).concat(newEntries);
                        } else if (hadSharedPhotos && !hasPhotosToShare) {
                            if (window.sharedPhotos && Array.isArray(window.sharedPhotos)) {
                                window.sharedPhotos = window.sharedPhotos.filter(p => p.entryId !== record.id);
                            }
                        }
                        updateTimelineShareIndicators();
                    }
                    try {
                        await dbOps.sharePhotos(photosToShare, record);
                        console.log('공유 처리 완료:', { recordId: record.id, 공유설정: hasPhotosToShare });
                        // 모먼트 피드에 즉시 반영되도록 sharedPhotosFeed 새로고침 (공유/해제 모두)
                        const { loadSharedPhotosPage } = await import('../db.js');
                        const { docs, lastDoc, hasMore } = await loadSharedPhotosPage(10);
                        let finalDocs = docs;
                        if (hasPhotosToShare && photosToShare?.length && record?.id) {
                            // Firestore 전파 지연 시 새 공유가 안 보이는 문제 방지: 낙관적 병합
                            const hasOurEntry = docs.some(p => p.entryId === record.id);
                            if (!hasOurEntry) {
                                const now = new Date().toISOString();
                                const profile = window.userSettings?.profile || {};
                                const optimistic = photosToShare.map((url, idx) => ({
                                    entryId: record.id, photoUrl: url, userId: window.currentUser?.uid,
                                    userNickname: profile.nickname || '익명', userIcon: profile.icon || '🐻', userPhotoUrl: profile.photoUrl || null,
                                    date: record.date || '', slotId: record.slotId || '', time: record.time || '',
                                    timestamp: now, photoIndex: idx,
                                    photoAspectRatio: (record.photoAspectRatio === '3:4' || record.photoAspectRatio === '4:3') ? record.photoAspectRatio : '1:1'
                                }));
                                finalDocs = [...optimistic, ...docs];
                            }
                        } else if (hadSharedPhotos && !hasPhotosToShare && record?.id) {
                            // 공유 해제: 전파 지연 시에도 즉시 피드에서 제거
                            finalDocs = docs.filter(p => p.entryId !== record.id);
                        }
                        window.sharedPhotosFeed = finalDocs;
                        if (typeof appState !== 'undefined') {
                            appState.sharedPhotosFeedLastDoc = lastDoc;
                            appState.sharedPhotosFeedHasMore = hasMore;
                        }
                        if (appState.currentTab === 'gallery') renderGallery();
                        if (document.getElementById('feedContent')) renderFeed();
                    } catch (e) {
                        console.error("공유 처리 실패:", e);
                        showToast("사진 공유 처리 중 오류가 발생했습니다.", 'error');
                    }
                }
            }
        } catch (saveError) {
            console.error('dbOps.save 오류:', saveError);
            // dbOps.save()에서 이미 에러 토스트를 표시하므로 여기서는 추가 처리 불필요
            // 로딩 오버레이는 이미 숨겨졌으므로 추가 처리 불필요
            return; // 저장 실패 시 여기서 종료
        }
        
        // 서버 저장 완료 후 Firestore 리스너가 떨어져 onDataUpdate가 재렌더·스크롤을 유발하지 않도록 프리즈 연장
        window._timelineRerenderFreezeUntil = Math.max(window._timelineRerenderFreezeUntil || 0, Date.now() + 3500);
        
        // 탭에 따라 적절한 뷰 업데이트 (setTimeout 0으로 지연 없이 다음 틱에서 실행)
        setTimeout(() => {
            const tabNow = appState.currentTab;
            if (tabNow === 'timeline' && editingDate) {
                // 낙관 반영 시 이미 jumpToDate·스크롤 완료됨. 서버 반영 후 추가 스크롤/모달 액션 없이 ID만 동기화
                try {
                    const savedScrollY = window.scrollY;
                    renderTimeline();
                    renderMiniCalendar();
                    window.scrollTo({ top: savedScrollY, behavior: 'instant' });
                    updateTimelineShareIndicators();
                } catch (e) {
                    console.warn('저장 후 타임라인 ID 동기화 실패:', e);
                }
            } else if (tabNow === 'gallery') {
                // 갤러리 탭: 낙관 반영을 즉시 보여주고, 리스너 동기화를 위해 한 번 더 갱신
                const renderGalleryNow = () => {
                    try {
                        renderGallery();
                        const feedContent = document.getElementById('feedContent');
                        if (feedContent) renderFeed();
                    } catch (e) {
                        console.error('갤러리/피드 렌더링 오류:', e);
                    }
                };
                renderGalleryNow();
                setTimeout(() => {
                    if (appState.currentTab !== 'gallery') return; // 대기 중 탭 바뀌면 스킵
                    renderGalleryNow();
                }, 500);
            } else if (tabNow === 'dashboard') {
                // 분석 탭: 리스너가 타임라인/갤러리만 갱신하므로 여기서 추가 작업 없음. 탭 전환 시 최신 데이터 반영됨.
            } else if (tabNow === 'feed') {
                const feedContent = document.getElementById('feedContent');
                if (feedContent) {
                    try { renderFeed(); } catch (e) { console.error('피드 렌더링 오류:', e); }
                }
            } else {
                // 기타: 보이는 뷰만 갱신 (피드/갤러리 노출 시)
                const feedContent = document.getElementById('feedContent');
                if (feedContent) {
                    try { renderFeed(); } catch (e) { console.error('피드 렌더링 오류:', e); }
                }
                const galleryView = document.getElementById('galleryView');
                if (galleryView && !galleryView.classList.contains('hidden')) {
                    try { renderGallery(); } catch (e) { console.error('갤러리 렌더링 오류:', e); }
                }
            }
        }, 0);
    } catch (e) {
        console.error('saveEntry 오류:', e);
        console.error('오류 스택:', e.stack);
        showToast("저장 실패", 'error');
        // 오류 발생 시에도 로딩 오버레이 숨김
        if (loadingOverlay) {
            loadingOverlay.classList.add('hidden');
            console.log('오류 발생 후 로딩 오버레이 숨김');
        }
        // 오류 발생 시에도 모달 닫기
        const entryModal = document.getElementById('entryModal');
        if (entryModal) {
            entryModal.classList.add('hidden');
            console.log('오류 발생 후 모달 닫기');
        }
        const state = appState;
        state.currentEditingId = null;
        state.currentPhotos = [];
    } finally {
        // finally 블록에서도 한 번 더 확인
        if (loadingOverlay && !loadingOverlay.classList.contains('hidden')) {
            loadingOverlay.classList.add('hidden');
            console.log('finally 블록에서 로딩 오버레이 숨김');
        }
        // finally 블록에서도 모달이 열려있으면 닫기
        const entryModal = document.getElementById('entryModal');
        if (entryModal && !entryModal.classList.contains('hidden')) {
            entryModal.classList.add('hidden');
            console.log('finally 블록에서 모달 닫기');
        }
    }
}

export async function deleteEntry() {
    const state = appState;
    if (!state.currentEditingId) {
        showToast("삭제할 항목이 없습니다.", 'error');
        return;
    }
    
    // 삭제 확인 다이얼로그
    if (!confirm("정말 이 기록을 삭제하시겠습니까?")) {
        return;
    }
    
    // 삭제할 ID를 미리 저장 (모달 닫기 전에)
    const entryIdToDelete = state.currentEditingId;
    
    // 로그인 상태 확인
    if (!window.currentUser) {
        showToast("로그인이 필요합니다.", 'error');
        return;
    }
    
    // 모달을 먼저 닫기 (사용자 경험 개선)
    window.closeModal();
    
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    
    try {
        await dbOps.delete(entryIdToDelete);
        // 삭제 성공 - Firestore 리스너가 자동으로 타임라인을 업데이트함
        // 모먼트 캐시에서도 해당 기록 제거 (즉시 반영)
        if (window.sharedPhotos && Array.isArray(window.sharedPhotos)) {
            window.sharedPhotos = window.sharedPhotos.filter((p) => p.entryId !== entryIdToDelete);
        }
        if (window.sharedPhotosFeed && Array.isArray(window.sharedPhotosFeed)) {
            window.sharedPhotosFeed = window.sharedPhotosFeed.filter((p) => p.entryId !== entryIdToDelete);
        }
        if (appState.currentTab === 'gallery') {
            try { renderGallery(); } catch (e) { console.warn('갤러리 갱신:', e); }
        }
        showToast("기록이 삭제되었습니다.", 'success');
    } catch (error) {
        console.error('삭제 오류:', error);
        let errorMessage = "삭제 실패: ";
        if (error.code === 'permission-denied') {
            errorMessage += "권한이 없습니다.";
        } else if (error.code === 'unavailable') {
            errorMessage += "네트워크 연결을 확인해주세요.";
        } else if (error.message && error.message.includes('로그인이 필요')) {
            errorMessage = "로그인이 필요합니다.";
        } else if (error.message) {
            errorMessage += error.message;
        } else {
            errorMessage += "알 수 없는 오류가 발생했습니다.";
        }
        showToast(errorMessage, 'error');
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
}

export function setRating(s) {
    appState.currentRating = s;
    const starContainer = document.getElementById('starContainer');
    if (starContainer) {
        const sts = starContainer.children;
        for (let i = 0; i < 5; i++) {
            sts[i].className = i < s ? 'star-btn text-2xl text-yellow-400' : 'star-btn text-2xl text-slate-200';
        }
    }
    const snackStarContainer = document.getElementById('snackStarContainer');
    if (snackStarContainer) {
        const sts = snackStarContainer.children;
        for (let i = 0; i < 5; i++) {
            sts[i].className = i < s ? 'star-btn text-2xl text-yellow-400' : 'star-btn text-2xl text-slate-200';
        }
    }
}

export function setSatiety(s) {
    const state = appState;
    state.currentSatiety = s;
    const container = document.getElementById('satietyContainer');
    if (container) {
        container.innerHTML = SATIETY_DATA.map(d => 
            `<button onclick="window.setSatiety(${d.val})" class="flex-1 flex flex-col items-center gap-1 p-2 rounded-xl transition-all ${d.val === s ? 'bg-white shadow-sm ring-1 ring-slate-200 scale-105 opacity-100' : 'opacity-40 grayscale hover:grayscale-0 hover:opacity-100'}">
                <i class="fa-solid ${d.icon} text-2xl ${d.color}"></i>
                <span class="text-[10px] font-bold ${d.val === s ? 'text-slate-800' : 'text-slate-400'}">${d.label}</span>
            </button>`
        ).join('');
    }
}

export function selectTag(inputId, value, btn, isPrimary, subTagKey = null, subContainerId = null) {
    const container = btn.parentElement.closest('.sub-chip-wrapper') ? btn.parentElement.parentElement : btn.parentElement;
    const isActive = btn.classList.contains('active');
    
    // 함께한 사람 상세 태그(peopleSuggestions), 메뉴 상세 태그(menuSuggestions)는 다중 선택 가능 (쉼표로 구분)
    const isMultiSelect = !isPrimary && (subContainerId === 'peopleSuggestions' || subContainerId === 'menuSuggestions');
    
    if (!isMultiSelect) {
        // 단일 선택: 다른 태그 선택 해제
        container.querySelectorAll(isPrimary ? '.chip' : '.sub-chip').forEach(c => c.classList.remove('active'));
    }
    
    let selectedValue = value;
    
    if (isActive) {
        btn.classList.remove('active');
        if (inputId !== 'null') {
            const input = document.getElementById(inputId);
            if (input) {
                if (isMultiSelect) {
                    // 다중 선택: 현재 값에서 제거
                    const currentValues = input.value.split(',').map(v => v.trim()).filter(v => v);
                    const newValues = currentValues.filter(v => v !== value);
                    input.value = newValues.join(', ');
                } else {
                    input.value = '';
                }
            }
        }
        selectedValue = null;
    } else {
        btn.classList.add('active');
        if (inputId !== 'null') {
            const input = document.getElementById(inputId);
            if (input) {
                if (isMultiSelect) {
                    // 다중 선택: 현재 값에 추가
                    const currentValues = input.value.split(',').map(v => v.trim()).filter(v => v);
                    if (!currentValues.includes(value)) {
                        currentValues.push(value);
                    }
                    input.value = currentValues.join(', ');
                } else {
                    input.value = value;
                }
            }
        }
    }
    
    // Skip 선택 시 필드 숨기기 처리 (typeChips에서만)
    // typeChips는 subTagKey가 'place'이고 inputId가 'null'인 경우
    if (isPrimary && inputId === 'null' && subTagKey === 'place') {
        const isSkip = (selectedValue === 'Skip' || selectedValue === '건너뜀');
        toggleFieldsForSkip(isSkip);
        
    }
    
    if (isPrimary && subTagKey && subContainerId) {
        if (subContainerId === 'snackPlaceSuggestions') {
            appState.selectedSnackPlaceMainTag = selectedValue;
        }
        const subTags = window.userSettings.subTags[subTagKey] || [];
        const inputIdForSecondary = (subTagKey === 'people') ? 'withWhomInput' : 
            (document.getElementById(subContainerId)?.getAttribute('data-input-id') || getInputIdFromContainer(subContainerId));
        window.renderSecondary(subContainerId, subTags, inputIdForSecondary, selectedValue, subTagKey);
    }
}

function toggleFieldsForSkip(isSkip) {
    // 메뉴정보 섹션 (optionalFields) - 완전히 숨기기
    const optionalFields = document.getElementById('optionalFields');
    if (optionalFields) {
        if (isSkip) {
            optionalFields.classList.add('hidden');
        } else {
            optionalFields.classList.remove('hidden');
        }
    }
    
    // 만족도 섹션 (ratingSection) - 완전히 숨기기
    const ratingSection = document.getElementById('ratingSection');
    if (ratingSection) {
        if (isSkip) {
            ratingSection.classList.add('hidden');
        } else {
            ratingSection.classList.remove('hidden');
        }
    }
}

export function handleMultipleImages(e) {
    const state = appState;
    const maxPhotos = 10;
    const currentCount = state.currentPhotos.length;
    const remainingSlots = maxPhotos - currentCount;
    
    if (remainingSlots <= 0) {
        showToast(`사진은 최대 ${maxPhotos}개까지 추가할 수 있습니다.`, 'error');
        e.target.value = ''; // 파일 입력 초기화
        return;
    }
    
    const files = Array.from(e.target.files);
    const filesToProcess = files.slice(0, remainingSlots);
    
    if (files.length > remainingSlots) {
        showToast(`사진은 최대 ${maxPhotos}개까지 가능합니다. ${remainingSlots}개만 추가됩니다.`, 'info');
    }
    
    // ⚠️ 중요: 파일 선택 순서를 보존하기 위해 Promise 배열로 처리
    // 각 파일을 인덱스와 함께 처리하여 순서 보장
    const filePromises = filesToProcess.map((f, index) => {
        return new Promise((resolve) => {
            const r = new FileReader();
            r.onload = (ev) => {
                // 편집·미리보기는 원본 data URL 유지. Storage 업로드 시 uploadBase64ToStorage에서만 압축.
                resolve({ index, dataUrl: ev.target.result });
            };
            r.onerror = () => {
                console.error('파일 읽기 실패:', f.name);
                resolve(null); // 실패한 파일은 null로 처리
            };
            r.readAsDataURL(f);
        });
    });
    
    // ⚠️ 중요: 모든 파일이 로드된 후 선택 순서대로 정렬하여 추가
    Promise.all(filePromises).then(results => {
        // null 제거 및 인덱스 순서대로 정렬
        const sortedResults = results
            .filter(r => r !== null)
            .sort((a, b) => a.index - b.index);
        
        // 현재 사진 개수 확인 (다른 작업으로 인해 변경되었을 수 있음)
        const currentPhotosCount = state.currentPhotos.length;
        const availableSlots = maxPhotos - currentPhotosCount;
        
        // 선택 순서대로 추가
        sortedResults.slice(0, availableSlots).forEach(({ dataUrl }) => {
            if (state.currentPhotos.length < maxPhotos) {
                state.currentPhotos.push(dataUrl);
            }
        });
        
        renderPhotoPreviews();
        updateShareIndicator();
    }).catch(err => {
        console.error('파일 처리 중 오류 발생:', err);
        showToast('사진 처리 중 오류가 발생했습니다.', 'error');
    });
    
    e.target.value = ''; // 파일 입력 초기화
}

export function removePhoto(idx) {
    const state = appState;
    const removedPhoto = state.currentPhotos[idx];
    state.currentPhotos.splice(idx, 1);
    renderPhotoPreviews();
    updateShareIndicator();
}

export function updateShareIndicator() {
    const state = appState;
    const shareIndicator = document.getElementById('sharePhotoIndicator');
    if (!shareIndicator) return;
    
    // 공유 금지 체크
    const isShareBanned = state.currentEditingId ? (window.mealHistory.find(m => m.id === state.currentEditingId)?.shareBanned === true) : false;
    
    // 사진이 있으면 항상 인디케이터 표시 (공유 가능 상태)
    if (state.currentPhotos.length > 0) {
        if (isShareBanned) {
            // 공유 금지된 경우: 비활성화 스타일로 표시
            shareIndicator.classList.remove('hidden');
            shareIndicator.classList.add('bg-red-50', 'border-red-300', 'text-red-400', 'cursor-not-allowed');
            shareIndicator.classList.remove('bg-emerald-100', 'border-emerald-300', 'bg-slate-50', 'border-slate-200', 'text-emerald-600', 'text-slate-400');
            shareIndicator.title = '공유가 금지된 게시물입니다';
        } else if (state.wantsToShare) {
            // 공유를 원하는 경우 활성화 스타일
            shareIndicator.classList.remove('hidden');
            shareIndicator.classList.add('bg-emerald-100', 'border-emerald-300', 'text-emerald-600');
            shareIndicator.classList.remove('bg-slate-50', 'border-slate-200', 'bg-red-50', 'border-red-300', 'text-slate-400', 'text-red-400', 'cursor-not-allowed');
            shareIndicator.title = '';
        } else {
            // 사진은 있지만 아직 공유하지 않은 경우도 표시 (비활성화 스타일)
            shareIndicator.classList.remove('hidden');
            shareIndicator.classList.add('bg-slate-50', 'border-slate-200', 'text-slate-400');
            shareIndicator.classList.remove('bg-emerald-100', 'border-emerald-300', 'bg-red-50', 'border-red-300', 'text-emerald-600', 'text-red-400', 'cursor-not-allowed');
            shareIndicator.title = '';
        }
    } else {
        shareIndicator.classList.add('hidden');
    }
}

export function toggleSharePhoto() {
    const state = appState;
    const shareIndicator = document.getElementById('sharePhotoIndicator');
    if (!shareIndicator) return;
    
    if (state.currentPhotos.length === 0) {
        showToast("공유할 사진이 없습니다.", 'error');
        return;
    }
    
    // 공유 금지 체크
    const isShareBanned = state.currentEditingId ? (window.mealHistory.find(m => m.id === state.currentEditingId)?.shareBanned === true) : false;
    if (isShareBanned) {
        showToast("공유가 금지된 게시물입니다.", 'error');
        return;
    }
    
    const isCurrentlySharing = shareIndicator.classList.contains('bg-emerald-100');
    
    if (isCurrentlySharing) {
        // 공유 해제
        state.wantsToShare = false;
        shareIndicator.classList.remove('bg-emerald-100', 'border-emerald-300', 'text-emerald-600');
        shareIndicator.classList.add('bg-slate-50', 'border-slate-200', 'text-slate-400');
    } else {
        // 공유 설정
        state.wantsToShare = true;
        shareIndicator.classList.remove('bg-slate-50', 'border-slate-200', 'text-slate-400');
        shareIndicator.classList.add('bg-emerald-100', 'border-emerald-300', 'text-emerald-600');
    }
}

