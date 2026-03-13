// 모달 및 입력 처리 관련 함수들
import { SLOTS, SATIETY_DATA, DEFAULT_ICONS, DEFAULT_SUB_TAGS, DEFAULT_USER_SETTINGS } from './constants.js';
import { appState } from './state.js';
import { setVal, compressImage, getInputIdFromContainer, normalizeUrl, addCompositionAwareInput, uploadBase64ToStorage, normalizeBirthdateRaw } from './utils.js';
import { renderEntryChips, renderPhotoPreviews, renderTagManager } from './render/index.js';
import { dbOps } from './db.js';
import { showToast } from './ui.js';
import { renderTimeline, renderMiniCalendar, updateTimelineShareIndicators, renderGallery, renderFeed } from './render/index.js';
import { getDashboardData } from './analytics.js';
import { callableFunctions } from './firebase.js';

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
        
        const scrollArea = document.getElementById('modalScrollArea');
        if (scrollArea) scrollArea.scrollTop = 0;
        
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
                btnSave.className = 'flex-1 py-4 bg-slate-300 text-slate-500 rounded-xl font-bold shadow-lg transition-all cursor-not-allowed';
                btnSave.innerText = '로그인 후 사용할 수 있어요';
            } else {
                // 일반 모드: 버튼 활성화 및 텍스트 설정
                btnSave.disabled = false;
                btnSave.className = 'flex-1 py-4 bg-slate-900 text-white rounded-xl font-bold active:bg-slate-800 shadow-lg transition-all';
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
                        const { loadSharedPhotosPage } = await import('./db.js');
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
                                    timestamp: now, photoIndex: idx
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
        
        // 탭에 따라 적절한 뷰 업데이트 (setTimeout 0으로 지연 없이 다음 틱에서 실행)
        setTimeout(() => {
            const tabNow = appState.currentTab;
            if (tabNow === 'timeline' && editingDate) {
                // 타임라인 탭: 등록화면-카드 동기화를 위해 즉시 렌더 후 jumpToDate
                const wasScrolling = window.isScrolling;
                try {
                    if (window.isScrolling !== undefined) {
                        window.isScrolling = true; // jumpToDate 내부 스크롤 방지
                    }
                    // 저장 직후 mealHistory 반영을 위해 먼저 렌더 (list/page 모드 모두)
                    renderTimeline();
                    renderMiniCalendar();
                    if (window.jumpToDate) {
                        window.jumpToDate(editingDate);
                    }
                    updateTimelineShareIndicators();
                    // 렌더·이미지 로딩·레이아웃 확정 후, 브라우저가 그린 직후(rAF) 정확한 좌표로 한 번만 스크롤
                    const scrollEditedDateToTop = () => {
                        const dateSection = document.getElementById(`date-${editingDate}`);
                        const trackerSection = document.getElementById('trackerSection');
                        if (!dateSection || !trackerSection) {
                            if (window.isScrolling !== undefined) window.isScrolling = wasScrolling;
                            return;
                        }
                        const tr = trackerSection.getBoundingClientRect();
                        const ds = dateSection.getBoundingClientRect();
                        const goalY = tr.bottom + 16;
                        const scrollDelta = ds.top - goalY;
                        const top = Math.max(0, window.scrollY + scrollDelta);
                        window.scrollTo({ top, behavior: 'instant' });
                        if (window.isScrolling !== undefined) window.isScrolling = wasScrolling;
                    };
                    const imgs = document.querySelectorAll(`#date-${editingDate} img`);
                    const imageLoadPromise = imgs.length === 0 ? Promise.resolve() : Promise.race([
                        Promise.all(Array.from(imgs).map(img =>
                            img.complete ? Promise.resolve() : new Promise(r => { img.onload = r; img.onerror = r; })
                        )),
                        new Promise(r => setTimeout(r, 400))
                    ]);
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            imageLoadPromise.then(() => {
                                requestAnimationFrame(() => {
                                    requestAnimationFrame(scrollEditedDateToTop);
                                });
                            });
                        });
                    });
                } catch (scrollError) {
                    console.error('날짜 이동 오류:', scrollError);
                    if (window.isScrolling !== undefined) {
                        window.isScrolling = wasScrolling;
                    }
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
    
    // 함께한 사람 상세 태그(peopleSuggestions)는 다중 선택 가능
    const isMultiSelect = !isPrimary && subContainerId === 'peopleSuggestions';
    
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
    
    filesToProcess.forEach(f => {
        const r = new FileReader();
        r.onload = (ev) => {
            compressImage(ev.target.result).then(compressed => {
                if (state.currentPhotos.length < maxPhotos) {
                    state.currentPhotos.push(compressed);
                    renderPhotoPreviews();
                    updateShareIndicator();
                }
            });
        };
        r.readAsDataURL(f);
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

export function openSettings() {
    const state = appState;
    if (!window.currentUser) return;
    
    // 게스트(익명)는 userSettings가 없을 수 있음 → 기본값 사용해 설정 모달은 열고, 로그인하기 노출
    const sourceSettings = window.userSettings || DEFAULT_USER_SETTINGS;
    state._profileSettingsSnapshot = JSON.parse(JSON.stringify(sourceSettings));
    state.isProfileEditing = false;
    state.tempSettings = JSON.parse(JSON.stringify(sourceSettings));
    
    // 프로필 타입 초기화 (text | photo)
    const inferredType = state.tempSettings?.profile?.photoUrl ? 'photo' : 'text';
    const profileType = state.tempSettings?.profile?.iconType || inferredType;
    // 이모지 타입이면 text로 변환
    window.settingsProfileType = profileType === 'emoji' ? 'text' : profileType;
    setSettingsProfileType(window.settingsProfileType);
    
    // 사진 미리보기 설정
    const photoPreview = document.getElementById('photoPreview');
    const photoDeleteBtn = document.getElementById('photoDeleteBtn');
    if (photoPreview && state.tempSettings?.profile?.photoUrl) {
        photoPreview.style.backgroundImage = `url(${state.tempSettings.profile.photoUrl})`;
        photoPreview.style.backgroundSize = 'cover';
        photoPreview.style.backgroundPosition = 'center';
        photoPreview.innerHTML = '';
        if (photoDeleteBtn) {
            photoDeleteBtn.classList.toggle('hidden', !state.isProfileEditing);
        }
    } else if (photoPreview) {
        photoPreview.innerHTML = '<i class="fa-solid fa-camera text-slate-400 text-xl"></i>';
        photoPreview.style.backgroundImage = '';
        if (photoDeleteBtn) {
            photoDeleteBtn.classList.add('hidden');
        }
    }
    
    const nicknameInput = document.getElementById('settingNickname');
    if (nicknameInput) {
        nicknameInput.value = state.tempSettings.profile.nickname || '';
        // 닉네임 입력 시 텍스트 미리보기 즉시 반영 (조합 중 지연 → 한글 IME 이슈 방지)
        if (!nicknameInput._nicknameCompositionInit) {
            addCompositionAwareInput(nicknameInput, () => {
                if (window.settingsProfileType === 'text') setSettingsProfileType('text');
            });
            nicknameInput._nicknameCompositionInit = true;
        }
    }
    const bioInput = document.getElementById('settingBio');
    // 생년월일 / 라이프스타일 초기화
    const birthdateInput = document.getElementById('settingBirthdate');
    if (birthdateInput) {
        birthdateInput.value = state.tempSettings?.profile?.birthdate || '';
    }
    const lifestyleInput = document.getElementById('settingLifestyle');
    if (lifestyleInput) {
        lifestyleInput.value = state.tempSettings?.profile?.lifestyle || '';
    }
    // 라이프스타일 버튼 선택 상태 복원
    const selectedLifestyle = (state.tempSettings?.profile?.lifestyle || '').trim();
    document.querySelectorAll('.settings-lifestyle-btn').forEach(btn => {
        const v = btn.getAttribute('data-value') || '';
        const active = v === selectedLifestyle;
        btn.classList.toggle('bg-emerald-600', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('border-emerald-600', active);
        btn.classList.toggle('bg-white', !active);
        btn.classList.toggle('text-slate-600', !active);
        btn.classList.toggle('border-slate-200', !active);
    });
    // 성별 선택 상태 복원
    const selectedGender = (state.tempSettings?.profile?.gender || '').trim();
    const settingGenderEl = document.getElementById('settingGender');
    if (settingGenderEl) settingGenderEl.value = selectedGender;
    document.querySelectorAll('.setting-gender-btn').forEach(btn => {
        const v = btn.getAttribute('data-value') || '';
        const active = v === selectedGender;
        btn.classList.toggle('bg-emerald-600', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('bg-slate-50', !active);
        btn.classList.toggle('text-slate-600', !active);
    });

    // 생년월일 힌트 업데이트 (이미 1회 수정했으면 안내)
    const birthdateHint = document.getElementById('birthdateHint');
    const changeCount = Number(state.tempSettings?.profile?.birthdateChangeCount || 0);
    if (birthdateHint) {
        birthdateHint.textContent = changeCount >= 1 ? '이미 1회 수정 완료 (추가 변경 불가)' : '가입 후 1회만 수정 가능';
    }
    if (bioInput) {
        bioInput.value = state.tempSettings.profile.bio || '';
        const bioCharCount = document.getElementById('bioCharCount');
        if (bioCharCount) {
            bioCharCount.textContent = (state.tempSettings.profile.bio || '').length;
        }
        // 글자 수 카운터 업데이트 (조합 중 지연 → 한글 IME 이슈 방지)
        if (!bioInput._bioCompositionInit) {
            addCompositionAwareInput(bioInput, () => {
                const count = bioInput.value.length;
                if (bioCharCount) bioCharCount.textContent = count;
            });
            bioInput._bioCompositionInit = true;
        }
    }
    
    // 밀당 메모 입력 필드 초기화
    const shortcutsInput = document.getElementById('shortcutsInput');
    if (shortcutsInput) {
        shortcutsInput.value = state.tempSettings.shortcuts || '';
    }
    
    // 밀당 메모 저장 버튼 이벤트 리스너
    const saveShortcutsBtn = document.getElementById('saveShortcutsBtn');
    if (saveShortcutsBtn) {
        saveShortcutsBtn.onclick = async () => {
            if (shortcutsInput) {
                state.tempSettings.shortcuts = shortcutsInput.value.trim();
                window.userSettings = JSON.parse(JSON.stringify(state.tempSettings));
                try {
                    await dbOps.saveSettings(window.userSettings);
                    showToast("밀당 메모가 저장되었습니다.", 'success');
                } catch (e) {
                    console.error('밀당 메모 저장 실패:', e);
                    showToast("밀당 메모 저장 중 오류가 발생했습니다.", 'error');
                }
            }
        };
    }
    
    // 자주 사용하는 태그 초기화 (없으면 빈 객체로)
    if (!state.tempSettings.favoriteSubTags) {
        state.tempSettings.favoriteSubTags = {
            mealType: {},
            category: {},
            withWhom: {},
            snackType: {}
        };
    }
    
    // 자주 사용하는 태그 편집 UI 렌더링
    renderFavoriteTagsEditor();
    
    // 사진 선택 및 삭제 버튼 이벤트 리스너 설정 (이미 선언된 photoDeleteBtn 재사용)
    const photoSelectBtn = document.getElementById('photoSelectBtn');
    const photoInput = document.getElementById('photoInput');
    const textSectionPhotoBtn = document.getElementById('textSectionPhotoBtn');
    
    // 텍스트 섹션의 사진 설정 버튼
    if (textSectionPhotoBtn && photoInput) {
        textSectionPhotoBtn.onclick = () => {
            if (appState.isProfileEditing) {
                photoInput.click();
            } else {
                showToast("수정 버튼을 누른 뒤 변경할 수 있습니다.", "info");
            }
        };
    }
    
    // 사진 섹션의 사진 선택 버튼
    if (photoSelectBtn && photoInput) {
        photoSelectBtn.onclick = () => {
            if (appState.isProfileEditing) {
                photoInput.click();
            } else {
                showToast("수정 버튼을 누른 뒤 변경할 수 있습니다.", "info");
            }
        };
    }
    
    if (photoDeleteBtn) {
        photoDeleteBtn.onclick = () => {
            handlePhotoDelete();
        };
    }
    
    // 버전 정보 로드 및 표시
    loadVersionInfo();
    
    // 게스트 모드일 때 태그 관리 및 밀당 메모 탭 숨기기
    const tagsTab = document.getElementById('settingsTabTags');
    const shortcutsTab = document.getElementById('settingsTabShortcuts');
    const profileSettingsSection = document.querySelector('#settingsTabContentProfile .space-y-3');
    
    if (window.currentUser && window.currentUser.isAnonymous) {
        // 게스트 모드일 때 태그 관리 및 밀당 메모 탭 숨기기
        if (tagsTab) tagsTab.classList.add('hidden');
        if (shortcutsTab) shortcutsTab.classList.add('hidden');
        // 게스트 모드일 때 프로필 설정 폼만 숨기기 (계정/로그인하기는 프로필 탭에 표시)
        if (profileSettingsSection) profileSettingsSection.classList.add('hidden');
        switchSettingsTab('profile'); // 프로필 탭으로 이동해 '로그인하기' 노출
    } else {
        // 일반 사용자일 때 모든 탭 표시
        if (tagsTab) tagsTab.classList.remove('hidden');
        if (shortcutsTab) shortcutsTab.classList.remove('hidden');
        if (profileSettingsSection) profileSettingsSection.classList.remove('hidden');
        switchSettingsTab('profile');
        setProfileSettingsEditMode(false);
    }
        
        const accountSection = document.getElementById('accountSection');
    if (accountSection) {
        let accountHtml = '';
        if (window.currentUser.isAnonymous) {
            accountHtml = `<div class="bg-indigo-50 p-4 rounded-2xl border border-indigo-100 mb-6">
                <div class="flex items-center gap-3 mb-3">
                    <div class="w-10 h-10 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-500">
                        <i class="fa-solid fa-user-secret"></i>
                    </div>
                    <div>
                        <div class="text-xs font-bold text-indigo-600">게스트 모드</div>
                        <div class="text-[10px] text-indigo-400">앱 삭제 시 데이터가 사라집니다.</div>
                    </div>
                </div>
                <button id="switchToLoginBtn" class="w-full py-2.5 bg-indigo-600 text-white rounded-xl text-xs font-bold active:bg-indigo-700 transition-colors">
                    <i class="fa-solid fa-right-to-bracket mr-1"></i>로그인하기
                </button>
            </div>`;
            document.getElementById('logoutBtnArea').classList.add('hidden');
            const deleteArea = document.getElementById('deleteAccountBtnArea');
            if (deleteArea) deleteArea.classList.add('hidden');
        } else {
            const email = window.currentUser.email || 'Google 계정';
            const providerIcon = window.currentUser.providerData[0]?.providerId === 'google.com' ? 
                '<i class="fa-brands fa-google"></i>' : '<i class="fa-solid fa-envelope"></i>';
            accountHtml = `<div class="bg-emerald-50 p-4 rounded-2xl border border-emerald-100 mb-6">
                <h3 class="text-xs font-black text-emerald-600 mb-2 uppercase tracking-widest">로그인 정보</h3>
                <div class="flex items-center gap-2 text-emerald-700 font-bold text-sm">${providerIcon} ${email}</div>
            </div>`;
            document.getElementById('logoutBtnArea').classList.remove('hidden');
            const deleteArea = document.getElementById('deleteAccountBtnArea');
            if (deleteArea) deleteArea.classList.remove('hidden');
        }
        accountSection.innerHTML = accountHtml;
        
        // 게스트 모드일 때 로그인하기 버튼에 이벤트 리스너 추가
        if (window.currentUser && window.currentUser.isAnonymous) {
            // 약간의 지연을 두고 버튼을 찾아서 이벤트 리스너 추가 (innerHTML 후 DOM 업데이트 대기)
            setTimeout(() => {
                const switchToLoginBtn = document.getElementById('switchToLoginBtn');
                if (switchToLoginBtn) {
                    switchToLoginBtn.addEventListener('click', async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        try {
                            if (window.switchToLogin) {
                                await window.switchToLogin();
                            } else {
                                console.error('switchToLogin 함수를 찾을 수 없습니다.');
                                showToast("로그인 기능을 사용할 수 없습니다.", "error");
                            }
                        } catch (error) {
                            console.error('로그인하기 버튼 클릭 오류:', error);
                            showToast("로그인 페이지로 이동하는 중 오류가 발생했습니다.", "error");
                        }
                    });
                }
            }, 100);
        }
    }
    
    // 사용자 설정을 탭으로 전환 (밀려오는 방식 없이 다른 탭과 동일하게)
    if (typeof window.switchMainTab === 'function') {
        window.switchMainTab('settings');
    }
}

// 버전 정보 로드 함수
// - 프로덕션(1.0.0): 배포일자만 표시 (2026.02.19)
// - 스테이징(1.0.0_1): 기준일 (배포일) 형식 (2026.02.18 (2026.02.19))
function formatVersionDate(isoStr) {
    const d = new Date(isoStr);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}.${m}.${day}`;
}

async function loadVersionInfo() {
    try {
        const response = await fetch('/version.json?t=' + Date.now());
        if (response.ok) {
            const data = await response.json();
            const versionNumberEl = document.getElementById('versionNumber');
            const buildDateEl = document.getElementById('buildDate');

            if (versionNumberEl && data.version) {
                versionNumberEl.textContent = data.version;
            }

            if (buildDateEl && data.buildDate) {
                const buildDate = new Date(data.buildDate);
                const isStaging = /_\d+$/.test(String(data.version || ''));

                if (isStaging && data.baseBuildDate) {
                    // 스테이징: 기준일 (배포일) 형식
                    const baseStr = formatVersionDate(data.baseBuildDate);
                    const deployStr = formatVersionDate(data.buildDate);
                    buildDateEl.textContent = `${baseStr} (${deployStr})`;
                    buildDateEl.title = `기준: ${new Date(data.baseBuildDate).toLocaleString('ko-KR')} / 배포: ${buildDate.toLocaleString('ko-KR')}`;
                } else {
                    // 프로덕션: 배포일자만
                    buildDateEl.textContent = formatVersionDate(data.buildDate);
                    buildDateEl.title = buildDate.toLocaleString('ko-KR');
                }
            }
        }
    } catch (e) {
        console.debug('버전 정보 로드 실패 (무시):', e);
    }
}

export function closeSettings() {
    // 설정 탭일 때는 타임라인 탭으로 전환
    if (typeof appState !== 'undefined' && appState.currentTab === 'settings' && typeof window.switchMainTab === 'function') {
        window.switchMainTab('timeline');
    }
}

// 설정 페이지 탭 전환 함수 (바 타입)
export function switchSettingsTab(tab) {
    const profileTab = document.getElementById('settingsTabProfile');
    const tagsTab = document.getElementById('settingsTabTags');
    const shortcutsTab = document.getElementById('settingsTabShortcuts');
    const profileContent = document.getElementById('settingsTabContentProfile');
    const tagsContent = document.getElementById('settingsTabContentTags');
    const shortcutsContent = document.getElementById('settingsTabContentShortcuts');
    
    // 모든 탭 비활성화
    [profileTab, tagsTab, shortcutsTab].forEach(t => {
        if (t) {
            t.className = 'settings-tab px-4 py-3 text-sm font-bold text-slate-500 border-b-2 border-transparent hover:text-slate-700 hover:border-slate-300 transition-colors';
        }
    });
    
    // 모든 콘텐츠 숨기기
    [profileContent, tagsContent, shortcutsContent].forEach(c => {
        if (c) c.classList.add('hidden');
    });
    
    if (tab === 'profile') {
        // 프로필 탭 활성화
        if (profileTab) {
            profileTab.className = 'settings-tab active px-4 py-3 text-sm font-bold text-emerald-600 border-b-2 border-emerald-600 transition-colors';
            profileTab.innerHTML = '<i class="fa-solid fa-user mr-2"></i>프로필';
        }
        if (profileContent) profileContent.classList.remove('hidden');
    } else if (tab === 'tags') {
        // 태그 관리 탭 활성화
        if (tagsTab) {
            tagsTab.className = 'settings-tab active px-4 py-3 text-sm font-bold text-emerald-600 border-b-2 border-emerald-600 transition-colors';
            tagsTab.innerHTML = '<i class="fa-solid fa-tags mr-2"></i>태그 관리';
        }
        if (tagsContent) tagsContent.classList.remove('hidden');
    } else if (tab === 'shortcuts') {
        // 밀당 메모 탭 활성화
        if (shortcutsTab) {
            shortcutsTab.className = 'settings-tab active px-4 py-3 text-sm font-bold text-emerald-600 border-b-2 border-emerald-600 transition-colors';
            shortcutsTab.innerHTML = '<i class="fa-solid fa-keyboard mr-2"></i>밀당 메모';
        }
        if (shortcutsContent) shortcutsContent.classList.remove('hidden');
    }
}

function setProfileSettingsEditMode(isEditing) {
    const state = appState;
    state.isProfileEditing = !!isEditing;

    const editBtn = document.getElementById('editProfileSettingsBtn');
    const cancelBtn = document.getElementById('cancelProfileSettingsBtn');
    const saveBtn = document.getElementById('saveProfileSettingsBtn');
    if (editBtn) editBtn.classList.toggle('hidden', isEditing);
    if (cancelBtn) cancelBtn.classList.toggle('hidden', !isEditing);
    if (saveBtn) saveBtn.classList.toggle('hidden', !isEditing);

    const nicknameInput = document.getElementById('settingNickname');
    const bioInput = document.getElementById('settingBio');
    const birthdateInput = document.getElementById('settingBirthdate');
    const lifestyleInput = document.getElementById('settingLifestyle');
    if (nicknameInput) nicknameInput.disabled = !isEditing;
    if (bioInput) bioInput.disabled = !isEditing;
    if (birthdateInput) birthdateInput.disabled = !isEditing;
    if (lifestyleInput) lifestyleInput.disabled = !isEditing;

    /* 프로필 사진: 수정 모드일 때만 사진 설정/사진 선택/삭제 버튼 표시 */
    const photoSelectBtn = document.getElementById('photoSelectBtn');
    const textSectionPhotoBtn = document.getElementById('textSectionPhotoBtn');
    const photoDeleteBtn = document.getElementById('photoDeleteBtn');
    if (photoSelectBtn) {
        photoSelectBtn.disabled = !isEditing;
        photoSelectBtn.classList.toggle('hidden', !isEditing);
    }
    if (textSectionPhotoBtn) {
        textSectionPhotoBtn.disabled = !isEditing;
        textSectionPhotoBtn.classList.toggle('hidden', !isEditing);
    }
    if (photoDeleteBtn) {
        photoDeleteBtn.disabled = !isEditing;
        photoDeleteBtn.classList.toggle('hidden', !isEditing);
    }

    // 라이프스타일 버튼 비활성화
    document.querySelectorAll('.settings-lifestyle-btn').forEach(btn => {
        btn.disabled = !isEditing;
        btn.classList.toggle('opacity-60', !isEditing);
        btn.classList.toggle('cursor-not-allowed', !isEditing);
    });
}

window.startProfileSettingsEdit = () => setProfileSettingsEditMode(true);

window.cancelProfileSettingsEdit = () => {
    const state = appState;
    // snapshot으로 원복
    if (state._profileSettingsSnapshot) {
        state.tempSettings = JSON.parse(JSON.stringify(state._profileSettingsSnapshot));
        window.userSettings = JSON.parse(JSON.stringify(state._profileSettingsSnapshot));
    }

    // 편집 중 선택한 사진(미저장) 상태 초기화
    window.settingsPhotoFile = null;
    window.settingsPhotoUrl = null;
    const photoInput = document.getElementById('photoInput');
    if (photoInput) photoInput.value = '';

    // UI 재적용
    const inferredType = state.tempSettings?.profile?.photoUrl ? 'photo' : 'text';
    const profileType = state.tempSettings?.profile?.iconType || inferredType;
    // 이모지 타입이면 text로 변환
    window.settingsProfileType = profileType === 'emoji' ? 'text' : profileType;
    setSettingsProfileType(window.settingsProfileType);

    const nicknameInput = document.getElementById('settingNickname');
    if (nicknameInput) nicknameInput.value = state.tempSettings?.profile?.nickname || '';
    const bioInput = document.getElementById('settingBio');
    if (bioInput) bioInput.value = state.tempSettings?.profile?.bio || '';

    const photoPreview = document.getElementById('photoPreview');
    const photoDeleteBtn = document.getElementById('photoDeleteBtn');
    if (photoPreview && state.tempSettings?.profile?.photoUrl) {
        photoPreview.style.backgroundImage = `url(${state.tempSettings.profile.photoUrl})`;
        photoPreview.style.backgroundSize = 'cover';
        photoPreview.style.backgroundPosition = 'center';
        photoPreview.innerHTML = '';
        if (photoDeleteBtn) {
            photoDeleteBtn.classList.toggle('hidden', !state.isProfileEditing);
        }
    } else if (photoPreview) {
        photoPreview.innerHTML = '<i class="fa-solid fa-camera text-slate-400 text-xl"></i>';
        photoPreview.style.backgroundImage = '';
        if (photoDeleteBtn) {
            photoDeleteBtn.classList.add('hidden');
        }
    }

    setProfileSettingsEditMode(false);
};

// 설정 페이지 프로필 타입 설정
export function setSettingsProfileType(type) {
    // 이모지 타입이면 text로 변환
    if (type === 'emoji') {
        type = 'text';
    }
    window.settingsProfileType = type;
    
    // tempSettings에도 iconType 반영 (취소/저장에 사용)
    if (appState?.tempSettings?.profile) {
        appState.tempSettings.profile.iconType = type;
    }
    
    const textSection = document.getElementById('textSection');
    const photoSection = document.getElementById('photoSection');
    const photoPreview = document.getElementById('photoPreview');
    const photoDeleteBtn = document.getElementById('photoDeleteBtn');

    if (textSection) textSection.classList.toggle('hidden', type !== 'text');
    if (photoSection) photoSection.classList.toggle('hidden', type !== 'photo');

    // 텍스트 미리보기 업데이트
    const textPreview = document.getElementById('textPreview');
    const nicknameVal = (
        document.getElementById('settingNickname')?.value ||
        appState?.tempSettings?.profile?.nickname ||
        window.userSettings?.profile?.nickname ||
        ''
    ).trim();
    if (textPreview) {
        const initial = Array.from(nicknameVal || '?')[0] || '?';
        textPreview.textContent = initial;
    }

    // 사진 미리보기 및 삭제 버튼 업데이트 (수정 모드일 때만 삭제 버튼 표시)
    if (type === 'photo' && photoPreview) {
        const photoUrl = appState?.tempSettings?.profile?.photoUrl || window.settingsPhotoUrl || window.userSettings?.profile?.photoUrl;
        if (photoUrl) {
            photoPreview.style.backgroundImage = `url(${photoUrl})`;
            photoPreview.style.backgroundSize = 'cover';
            photoPreview.style.backgroundPosition = 'center';
            photoPreview.innerHTML = '';
            if (photoDeleteBtn) {
                photoDeleteBtn.classList.toggle('hidden', !appState.isProfileEditing);
            }
        } else {
            photoPreview.innerHTML = '<i class="fa-solid fa-camera text-slate-400 text-xl"></i>';
            photoPreview.style.backgroundImage = '';
            if (photoDeleteBtn) {
                photoDeleteBtn.classList.add('hidden');
            }
        }
    }
}

// 전역 노출 (탭 클릭용)
window.setSettingsProfileType = setSettingsProfileType;

// 설정 페이지 사진 업로드 처리 (선택 → 편집 모달 → 저장 시 미리보기 반영)
export async function handlePhotoUpload(event) {
    if (!appState.isProfileEditing) {
        showToast("수정 버튼을 누른 뒤 변경할 수 있습니다.", "info");
        if (event?.target) event.target.value = '';
        return;
    }
    const file = event.target.files[0];
    if (!file) return;
    
    if (!file.type.startsWith('image/')) {
        showToast("이미지 파일만 업로드할 수 있습니다.", "error");
        return;
    }
    
    try {
        const { compressImageToBlob } = await import('./utils.js');
        const compressedBlob = await compressImageToBlob(file);
        const photoUrl = URL.createObjectURL(compressedBlob);
        
        if (window.settingsProfileType !== 'photo') {
            setSettingsProfileType('photo');
        }
        
        // 미리보기 업데이트
        const photoPreview = document.getElementById('photoPreview');
        const photoDeleteBtn = document.getElementById('photoDeleteBtn');
        if (photoPreview) {
            photoPreview.style.backgroundImage = `url(${photoUrl})`;
            photoPreview.style.backgroundSize = 'cover';
            photoPreview.style.backgroundPosition = 'center';
            photoPreview.innerHTML = '';
            if (photoDeleteBtn) {
                photoDeleteBtn.classList.remove('hidden');
            }
        }
        
        window.settingsPhotoUrl = photoUrl;
        window.settingsPhotoFile = compressedBlob;
        
        if (typeof window.openProfilePhotoEdit === 'function') {
            window.openProfilePhotoEdit(photoUrl);
        } else {
            // 편집 기능이 없으면 바로 저장 가능하도록 설정
            appState.tempSettings.profile.photoUrl = photoUrl;
        }
    } catch (e) {
        console.error("사진 업로드 처리 실패:", e);
        showToast("사진 업로드 중 오류가 발생했습니다.", "error");
    }
}

// 사진 삭제 처리
export function handlePhotoDelete() {
    const state = appState;
    if (!state.isProfileEditing) {
        showToast("수정 버튼을 누른 뒤 변경할 수 있습니다.", "info");
        return;
    }
    
    // 사진 관련 변수 초기화
    state.tempSettings.profile.photoUrl = null;
    window.settingsPhotoFile = null;
    window.settingsPhotoUrl = null;
    
    // 텍스트 모드로 전환
    setSettingsProfileType('text');
    
    // 파일 입력 초기화
    const photoInput = document.getElementById('photoInput');
    if (photoInput) photoInput.value = '';
    
    showToast("사진이 삭제되었습니다.", "success");
}

export async function saveProfileSettings() {
    const state = appState;
    try {
        if (!state.isProfileEditing) {
            showToast("수정 버튼을 누른 뒤 저장할 수 있습니다.", "info");
            return;
        }
        // 생년월일 / 라이프스타일 (선택사항)
        const newBirthdate = (document.getElementById('settingBirthdate')?.value || '').trim();
        const newLifestyle = (document.getElementById('settingLifestyle')?.value || '').trim();
        const newGenderRaw = (document.getElementById('settingGender')?.value || '').trim();
        const newGender = (newGenderRaw === 'male' || newGenderRaw === 'female') ? newGenderRaw : null;

        const newNickname = (document.getElementById('settingNickname')?.value || '').trim();
        const existingNickname = (window.userSettings?.profile?.nickname || '').trim();
        const nicknameChanged = newNickname !== existingNickname;
        
        if (nicknameChanged) {
            if (!newNickname) {
                showToast("닉네임을 입력해주세요.", "error");
                return;
            }
            if (newNickname.length > 20) {
                showToast("닉네임은 20자 이하로 입력해주세요.", "error");
                return;
            }
            const { containsProfanity, isNicknameDuplicate, canChangeNickname, updateNicknameChangeDate } = await import('./utils/nickname.js');
            if (containsProfanity(newNickname)) {
                showToast("사용할 수 없는 닉네임입니다. 다른 닉네임을 입력해주세요.", "error");
                return;
            }
            const duplicate = await isNicknameDuplicate(newNickname, window.currentUser?.uid || null);
            if (duplicate) {
                showToast("이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해주세요.", "error");
                return;
            }
            const { canChange, daysUntilNextChange } = await canChangeNickname(window.currentUser?.uid || null);
            if (!canChange) {
                showToast(`닉네임은 한 달에 한 번만 변경할 수 있습니다. ${daysUntilNextChange}일 후에 다시 시도해주세요.`, "error");
                return;
            }
        }
        
        state.tempSettings.profile.nickname = newNickname || existingNickname || '게스트';
        state.tempSettings.profile.bio = document.getElementById('settingBio').value.trim() || '';

        // 생년월일 변경 1회 제한 (값이 입력된 경우에만 체크)
        const existingBirthdate = (window.userSettings?.profile?.birthdate || '').trim();
        const existingLifestyle = (window.userSettings?.profile?.lifestyle || '').trim();
        const existingCount = Number(window.userSettings?.profile?.birthdateChangeCount || 0);
        
        // 생년월일: 값이 입력된 경우에만 저장 및 변경 체크 (숫자 8자리도 자동 포맷 후 검증)
        if (newBirthdate) {
            const { formatted: formattedBirthdate, valid } = normalizeBirthdateRaw(newBirthdate);
            if (!valid) {
                showToast("입력한 생년월일이 올바르지 않습니다. 숫자 8자리(예: 19900115)로 입력해주세요.", "error");
                return;
            }
            const isBirthdateChanged = existingBirthdate && formattedBirthdate && existingBirthdate !== formattedBirthdate;
            if (isBirthdateChanged) {
                if (existingCount >= 1) {
                    showToast("생년월일은 가입 후 1회만 변경할 수 있습니다.", "error");
                    return;
                }
                state.tempSettings.profile.birthdateChangeCount = existingCount + 1;
                state.tempSettings.profile.birthdateChangedAt = new Date().toISOString();
            } else {
                // 기존 값 유지 (또는 최초 설정이면 0 유지)
                state.tempSettings.profile.birthdateChangeCount = Number(state.tempSettings.profile.birthdateChangeCount || existingCount || 0);
                state.tempSettings.profile.birthdateChangedAt = state.tempSettings.profile.birthdateChangedAt || window.userSettings?.profile?.birthdateChangedAt || null;
            }
            state.tempSettings.profile.birthdate = formattedBirthdate;
        } else {
            // 값이 없으면 기존 값 유지
            state.tempSettings.profile.birthdate = existingBirthdate || '';
            state.tempSettings.profile.birthdateChangeCount = Number(state.tempSettings.profile.birthdateChangeCount || existingCount || 0);
            state.tempSettings.profile.birthdateChangedAt = state.tempSettings.profile.birthdateChangedAt || window.userSettings?.profile?.birthdateChangedAt || null;
        }
        
        // 라이프스타일: 값이 입력된 경우에만 저장, 없으면 기존 값 유지
        state.tempSettings.profile.lifestyle = newLifestyle || existingLifestyle || '';
        // 성별: 선택 입력, 기가입자 강제 아님
        state.tempSettings.profile.gender = newGender;
        
        // 프로필 완료 플래그: 닉네임이 실제 값이면 완료로 처리
        const finalNickname = (state.tempSettings.profile.nickname || '').trim();
        if (finalNickname && finalNickname !== '게스트') {
            state.tempSettings.profileCompleted = true;
            state.tempSettings.profileCompletedAt = state.tempSettings.profileCompletedAt || new Date().toISOString();
        }
        
        // 아이콘 타입 저장 (text | photo)
        state.tempSettings.profile.iconType = window.settingsProfileType || 'text';

        // 프로필 타입에 따라 photoUrl 저장
        if (window.settingsProfileType === 'photo') {
            // 사진 파일이 있으면 업로드, 없으면 기존 photoUrl 유지
            if (window.settingsPhotoFile) {
                const { storage } = await import('./firebase.js');
                const { ref, uploadBytes, getDownloadURL } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-storage.js");
                const timestamp = Date.now();
                const fileName = `photo_${timestamp}.jpg`;
                const photoRef = ref(storage, `users/${window.currentUser.uid}/profile/${fileName}`);
                
                await uploadBytes(photoRef, window.settingsPhotoFile);
                const photoUrl = await getDownloadURL(photoRef);
                
                state.tempSettings.profile.photoUrl = photoUrl;
                // 업로드 후 변수 초기화
                window.settingsPhotoFile = null;
                window.settingsPhotoUrl = null;
            }
            // icon은 항상 null (사진 또는 닉네임 첫글자만 사용)
            state.tempSettings.profile.icon = null;
        } else {
            // text: 닉네임 첫 글자 표시 (저장은 nickname만으로 충분)
            state.tempSettings.profile.icon = null;
            state.tempSettings.profile.photoUrl = null;
            state.tempSettings.profile.iconType = 'text';
            window.settingsPhotoFile = null;
            window.settingsPhotoUrl = null;
        }
        
        await dbOps.saveSettings(state.tempSettings);
        if (nicknameChanged && window.currentUser?.uid) {
            const { updateNicknameChangeDate } = await import('./utils/nickname.js');
            await updateNicknameChangeDate(window.currentUser.uid);
        }
        showToast("설정이 저장되었습니다.", 'success');
        
        // 헤더 업데이트
        updateHeaderUI();

        // 저장 후 보기 모드로 전환 및 스냅샷 갱신
        state._profileSettingsSnapshot = JSON.parse(JSON.stringify(state.tempSettings));
        setProfileSettingsEditMode(false);
    } catch (e) {
        console.error('프로필 저장 실패:', e);
        showToast("설정 저장 중 오류가 발생했습니다: " + (e.message || e), 'error');
    }
}

// 레거시 함수 (호환성 유지)
export async function saveSettings() {
    await saveProfileSettings();
}

export function selectIcon(i) {
    const state = appState;
    if (!state.isProfileEditing) {
        showToast("수정 버튼을 누른 뒤 변경할 수 있습니다.", "info");
        return;
    }
    state.tempSettings.profile.icon = i;
    document.querySelectorAll('.icon-option').forEach(el => el.classList.toggle('selected', el.innerText === i));
    const emojiPreview = document.getElementById('emojiPreview');
    if (emojiPreview) emojiPreview.textContent = i;
}

export function addTag(k, isSub) {
    const state = appState;
    const inputId = `newTag-${isSub ? 'sub-' : ''}${k}`;
    const i = document.getElementById(inputId);
    if (i && i.value.trim()) {
        if (isSub) {
            state.tempSettings.subTags[k].push({ text: i.value.trim(), parent: null });
        } else {
            state.tempSettings.tags[k].push(i.value.trim());
        }
        renderTagManager(k, isSub, state.tempSettings);
        i.value = '';
        requestAnimationFrame(() => {
            document.getElementById(inputId)?.focus();
        });
    }
}

export function removeTag(k, idx, isSub) {
    const state = appState;
    if (!confirm("이 태그를 삭제하시겠습니까?")) return;
    if (isSub) {
        state.tempSettings.subTags[k].splice(idx, 1);
    } else {
        state.tempSettings.tags[k].splice(idx, 1);
    }
    renderTagManager(k, isSub, state.tempSettings);
}

function renderFavoriteTagsEditor() {
    const state = appState;
    const container = document.getElementById('favoriteTagsSection');
    if (!container) return;
    
    // 현재 선택된 메인 태그 추적
    if (!state.selectedFavoriteMainTag) {
        state.selectedFavoriteMainTag = {};
    }
    
    const tagConfigs = {
        mealType: { prefix: '본식: ', label: '어떻게', subTagKey: 'place', mainTags: state.tempSettings.tags?.mealType || [] },
        category: { prefix: '본식: ', label: '무엇을', subTagKey: 'menu', mainTags: state.tempSettings.tags?.category || [] },
        withWhom: { prefix: '본식: ', label: '누구와', subTagKey: 'people', mainTags: state.tempSettings.tags?.withWhom || [] },
        snackType: { prefix: '간식: ', label: '무엇을', subTagKey: 'snack', mainTags: state.tempSettings.tags?.snackType || [] },
        snackPlace: { prefix: '간식: ', label: '어디서', subTagKey: 'place', mainTags: state.tempSettings.tags?.snackPlaceMain || ['집', '사무실', '카페'] }
    };
    
    let html = '';
    Object.entries(tagConfigs).forEach(([sectionId, config]) => {
        const sectionKey = config.sectionKey || sectionId;
        const storageKey = config.storageKey || sectionId;
        const favoritesByMainTag = state.tempSettings.favoriteSubTags[storageKey] || {};
        const selectedMainTag = state.selectedFavoriteMainTag[sectionKey] || null;
        const selectedFavorites = selectedMainTag ? (favoritesByMainTag[selectedMainTag] || []) : [];
        const sectionTitle = (config.prefix || '') + config.label;
        
        html += `<div class="bg-slate-50 p-4 rounded-2xl border border-slate-100 mb-6">
            <div class="text-xs font-bold text-slate-600 mb-3 uppercase">${sectionTitle}</div>
            <div id="favoriteMainTags-${sectionKey}" class="flex flex-wrap gap-2 mb-3">
                ${config.mainTags.map(mainTag => {
                    const isSelected = selectedMainTag === mainTag;
                    const favorites = favoritesByMainTag[mainTag] || [];
                    return `<button onclick="window.selectFavoriteMainTag('${sectionKey}', '${mainTag.replace(/'/g, "\\'")}')" 
                        class="chip ${isSelected ? 'active' : ''}">
                        <span class="font-bold">${mainTag}</span> <span class="text-[10px] opacity-70">(${favorites.length}/5)</span>
                    </button>`;
                }).join('')}
            </div>
            <div class="flex gap-2 mb-3">
                <input type="text" id="newFavoriteTag-${sectionKey}-${selectedMainTag || 'none'}" class="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs outline-none focus:border-slate-400" placeholder="태그 입력" onkeypress="if(event.key==='Enter' && window.selectedFavoriteMainTag && window.selectedFavoriteMainTag['${sectionKey}']) window.addFavoriteTag('${storageKey}', window.selectedFavoriteMainTag['${sectionKey}'])">
                <button ontouchstart="event.preventDefault()" ontouchend="event.preventDefault(); if(window.selectedFavoriteMainTag && window.selectedFavoriteMainTag['${sectionKey}']) window.addFavoriteTag('${storageKey}', window.selectedFavoriteMainTag['${sectionKey}'])" onclick="if(window.selectedFavoriteMainTag && window.selectedFavoriteMainTag['${sectionKey}']) window.addFavoriteTag('${storageKey}', window.selectedFavoriteMainTag['${sectionKey}'])" class="bg-slate-800 text-white px-4 py-1.5 rounded-lg text-xs font-bold ${selectedMainTag ? '' : 'opacity-50 cursor-not-allowed'}" ${selectedMainTag ? '' : 'disabled'}>추가</button>
            </div>
            ${selectedMainTag ? `
                ${selectedFavorites.length >= 5 ? '<div class="text-[10px] text-slate-500 mb-3">최대 5개까지 입력 가능합니다</div>' : ''}
                <div class="mt-3">
                    <div class="text-[10px] text-slate-400 mb-2">나만의 태그 (최대 5개)</div>
                    <div class="flex flex-wrap gap-2" id="favoriteTags-${sectionKey}-${selectedMainTag}">
                        ${selectedFavorites.map((text, idx) => `
                            <div class="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-bold">
                                <span>${text}</span>
                                <button onclick="window.removeFavoriteTag('${storageKey}', '${selectedMainTag.replace(/'/g, "\\'")}', ${idx})" class="ml-1 hover:bg-emerald-700 rounded-full w-4 h-4 flex items-center justify-center transition-colors">
                                    <i class="fa-solid fa-xmark text-[8px]"></i>
                                </button>
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : '<div class="text-[10px] text-slate-400 mt-3">메인 태그를 선택하세요</div>'}
        </div>`;
    });
    
    container.innerHTML = html;
}

export function selectFavoriteMainTag(mainTagKey, mainTag) {
    const state = appState;
    if (!state.selectedFavoriteMainTag) {
        state.selectedFavoriteMainTag = {};
    }
    
    // 같은 태그를 다시 클릭하면 선택 해제, 다른 태그를 클릭하면 선택 변경
    if (state.selectedFavoriteMainTag[mainTagKey] === mainTag) {
        state.selectedFavoriteMainTag[mainTagKey] = null;
    } else {
        state.selectedFavoriteMainTag[mainTagKey] = mainTag;
    }
    
    // 전역 변수로도 저장 (입력창에서 접근 가능하도록)
    if (!window.selectedFavoriteMainTag) {
        window.selectedFavoriteMainTag = {};
    }
    window.selectedFavoriteMainTag[mainTagKey] = state.selectedFavoriteMainTag[mainTagKey];
    
    renderFavoriteTagsEditor();
}

export async function addFavoriteTag(mainTagKey, mainTag) {
    const state = appState;
    if (!state.tempSettings.favoriteSubTags) {
        state.tempSettings.favoriteSubTags = {
            mealType: {},
            category: {},
            withWhom: {},
            snackType: {}
        };
    }
    
    if (!state.tempSettings.favoriteSubTags[mainTagKey]) {
        state.tempSettings.favoriteSubTags[mainTagKey] = {};
    }
    
    // 메인 태그가 선택되지 않았으면 입력 불가
    if (!mainTag || mainTag === 'none') {
        showToast("메인 태그를 먼저 선택해주세요.", 'info');
        return;
    }
    
    const input = document.getElementById(`newFavoriteTag-${mainTagKey}-${mainTag}`);
    if (!input) return;
    
    const text = input.value.trim();
    if (!text) {
        showToast("태그를 입력해주세요.", 'info');
        return;
    }
    
    if (!state.tempSettings.favoriteSubTags[mainTagKey][mainTag]) {
        state.tempSettings.favoriteSubTags[mainTagKey][mainTag] = [];
    }
    
    const favorites = state.tempSettings.favoriteSubTags[mainTagKey][mainTag];
    
    if (favorites.includes(text)) {
        showToast("이미 추가된 태그입니다.", 'info');
        input.value = '';
        return;
    }
    
    if (favorites.length >= 5) {
        showToast("나만의 태그는 최대 5개까지 입력할 수 있습니다.", 'info');
        return;
    }
    
    favorites.push(text);
    input.value = '';
    renderFavoriteTagsEditor();
    requestAnimationFrame(() => {
        document.getElementById(`newFavoriteTag-${mainTagKey}-${mainTag}`)?.focus();
    });
    
    // 즉시 저장 후 화면(기록 모달 등)에서 쓰는 userSettings에도 반영
    try {
        await dbOps.saveSettings(state.tempSettings);
        if (!window.userSettings) window.userSettings = {};
        window.userSettings.favoriteSubTags = JSON.parse(JSON.stringify(state.tempSettings.favoriteSubTags || {}));
        showToast("태그가 저장되었습니다.", 'success');
    } catch (e) {
        console.error('태그 저장 실패:', e);
        // dbOps.saveSettings에서 이미 에러 토스트를 표시하므로 여기서는 추가 처리 불필요
    }
}

export async function removeFavoriteTag(mainTagKey, mainTag, index) {
    const state = appState;
    if (!state.tempSettings.favoriteSubTags || !state.tempSettings.favoriteSubTags[mainTagKey]) return;
    
    if (!state.tempSettings.favoriteSubTags[mainTagKey][mainTag]) {
        state.tempSettings.favoriteSubTags[mainTagKey][mainTag] = [];
    }
    
    const favorites = state.tempSettings.favoriteSubTags[mainTagKey][mainTag];
    if (index >= 0 && index < favorites.length) {
        favorites.splice(index, 1);
        renderFavoriteTagsEditor();
        
        // 즉시 저장 후 화면(기록 모달 등)에서 쓰는 userSettings에도 반영
        try {
            await dbOps.saveSettings(state.tempSettings);
            if (!window.userSettings) window.userSettings = {};
            window.userSettings.favoriteSubTags = JSON.parse(JSON.stringify(state.tempSettings.favoriteSubTags || {}));
            showToast("태그가 삭제되었습니다.", 'success');
        } catch (e) {
            console.error('태그 삭제 저장 실패:', e);
            // dbOps.saveSettings에서 이미 에러 토스트를 표시하므로 여기서는 추가 처리 불필요
        }
    }
}

export async function deleteSubTag(key, text, containerId, inputId, parentFilter) {
    const newSettings = JSON.parse(JSON.stringify(window.userSettings));
    if (newSettings.subTags && newSettings.subTags[key]) {
        const idx = newSettings.subTags[key].findIndex(t => (typeof t === 'string' ? t : t.text) === text);
        if (idx > -1) {
            newSettings.subTags[key].splice(idx, 1);
            window.userSettings = newSettings;
            try {
                await dbOps.saveSettings(newSettings);
                showToast("태그가 삭제되었습니다.", 'success');
                if (containerId) {
                    const realParentFilter = (parentFilter === 'null' || !parentFilter) ? null : parentFilter;
                    window.renderSecondary(containerId, newSettings.subTags[key], inputId, realParentFilter, key);
                }
            } catch (e) {
                console.error(e);
                showToast("삭제 실패", 'error');
            }
        }
    }
}

// 카카오 장소 검색 함수 (백엔드 프록시 사용 - SDK 불필요)
// mode: 'meal' | 'snack' - 식사 어디서 vs 간식 어디서
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
    modal.className = 'fixed inset-0 bg-slate-900/60 z-[400] flex items-end';
    modal.innerHTML = `
        <div class="w-full bg-white rounded-t-[2.5rem] flex flex-col max-h-[80vh]">
            <div class="p-6 border-b flex justify-between items-center">
                <h2 class="text-lg font-bold text-slate-800 tracking-tight">음식점 검색</h2>
                <button onclick="document.getElementById('kakaoPlaceSearchModal').remove()">
                    <i class="fa-solid fa-xmark text-xl text-slate-400"></i>
                </button>
            </div>
            <div class="p-4">
                <div class="relative mb-4">
                    <button onclick="window.searchKakaoPlaces()" class="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center bg-emerald-600 text-white rounded-lg z-10 hover:bg-emerald-700 transition-colors">
                        <i class="fa-solid fa-magnifying-glass text-sm"></i>
                    </button>
                    <input type="text" id="kakaoSearchInput" placeholder="음식점 이름을 입력하세요" 
                        class="w-full p-3 pl-12 bg-slate-50 rounded-xl outline-none text-sm border border-transparent focus:border-slate-400 transition-all">
                </div>
                <div id="kakaoSearchResults" class="space-y-2 max-h-[50vh] overflow-y-auto"></div>
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
                searchTimeout = setTimeout(() => window.searchKakaoPlaces(), 500);
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

// 카카오 장소 검색 실행
// 앱/스테이징: Callable / 로컬웹: SDK 또는 Callable fallback
export async function searchKakaoPlaces() {
    const searchInput = document.getElementById('kakaoSearchInput');
    const resultsContainer = document.getElementById('kakaoSearchResults');
    
    if (!searchInput || !resultsContainer) return;
    
    const keyword = searchInput.value.trim();
    if (!keyword) {
        showToast("검색어를 입력해주세요.", 'info');
        return;
    }
    
    // 로딩 표시
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
                }, { category_group_code: 'FD6', size: 15 });
            });
        }
        // 3) 웹 + SDK 없음: Callable fallback
        else {
            const result = await callableFunctions.searchKakaoPlaces({ keyword });
            restaurants = result?.data?.documents || [];
        }
        
        renderKakaoSearchResults(restaurants);
    } catch (err) {
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



