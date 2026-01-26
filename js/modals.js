// 모달 및 입력 처리 관련 함수들
import { SLOTS, SATIETY_DATA, DEFAULT_ICONS, DEFAULT_SUB_TAGS } from './constants.js';
import { appState } from './state.js';
import { setVal, compressImage, getInputIdFromContainer, normalizeUrl } from './utils.js';
import { renderEntryChips, renderPhotoPreviews, renderTagManager } from './render/index.js';
import { dbOps } from './db.js';
import { showToast } from './ui.js';
import { renderTimeline, renderMiniCalendar, renderGallery, renderFeed } from './render/index.js';
import { getDashboardData } from './analytics.js';

// 설정 저장 디바운싱을 위한 타이머
let settingsSaveTimeout = null;

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
        
        // localhost는 HTTP 사용 (HTTPS는 인증서 문제로 실패할 수 있음)
        // 실제 배포 환경에서는 HTTPS 사용 권장
        const protocol = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? 'http:' : 'https:';
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
        
        ['placeInput', 'menuDetailInput', 'withWhomInput', 'snackDetailInput', 'generalCommentInput', 'snackCommentInput'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        
        // 카카오 검색 버튼 초기화 (숨김) 및 placeholder 초기화
        const kakaoSearchBtn = document.getElementById('kakaoSearchBtn');
        const placeInput = document.getElementById('placeInput');
        if (kakaoSearchBtn) {
            kakaoSearchBtn.classList.add('hidden');
        }
        if (placeInput) {
            placeInput.placeholder = '식당명이나 장소 (예: 스타벅스)';
            // 이전 모달 사용에서 남은 카카오 장소 정보 제거 (카카오 미선택인데 잘못된 주소·카카오맵 분류로 들어가는 것 방지)
            placeInput.removeAttribute('data-kakao-place-id');
            placeInput.removeAttribute('data-kakao-place-address');
            placeInput.removeAttribute('data-kakao-place-data');
            placeInput.removeAttribute('data-kakao-place-name');
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
                btnSave.className = 'flex-1 py-4 bg-emerald-600 text-white rounded-xl font-bold active:bg-emerald-700 shadow-lg transition-all';
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
                setVal('generalCommentInput', r.comment || "");
                setVal('snackCommentInput', r.comment || "");
                
                if (r.rating) window.setRating(r.rating);
                if (r.satiety) window.setSatiety(r.satiety);
                
                // 공유 인디케이터 표시
                updateShareIndicator();
                
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
                    
                    // 장소 (place) - sub-chip
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
                
                // 외식 또는 회식/술자리 선택 시 카카오 검색 버튼 표시 및 placeholder 변경
                if (r.mealType === '외식' || r.mealType === '회식/술자리') {
                    setTimeout(() => {
                        const kakaoSearchBtn = document.getElementById('kakaoSearchBtn');
                        const placeInput = document.getElementById('placeInput');
                        if (kakaoSearchBtn) {
                            kakaoSearchBtn.classList.remove('hidden');
                        }
                        if (placeInput) {
                            placeInput.placeholder = '돋보기 버튼을 선택하여 식당을 검색해보세요';
                        }
                    }, 200);
                }
                
                // 간식 타입 선택 시 추천 태그 업데이트
                if (isS && r.snackType) {
                    const subTags = window.userSettings.subTags.snack || [];
                    window.renderSecondary('snackSuggestions', subTags, 'snackDetailInput', r.snackType, 'snack');
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
        // 이벤트 리스너는 한 번만 추가하도록 개선
        const snackDetailInput = document.getElementById('snackDetailInput');
        if (snackDetailInput) {
            // 기존 핸들러 제거 (없어도 에러 안남)
            if (snackDetailInput._snackInputHandler) {
                snackDetailInput.removeEventListener('input', snackDetailInput._snackInputHandler);
            }
            
            // 새 핸들러 생성 및 저장
            const updateSnackSuggestions = () => {
                const subTags = window.userSettings.subTags.snack || [];
                const snackType = document.querySelector('#snackTypeChips button.active')?.innerText;
                window.renderSecondary('snackSuggestions', subTags, 'snackDetailInput', snackType || null, 'snack');
            };
            
            snackDetailInput._snackInputHandler = updateSnackSuggestions;
            snackDetailInput.addEventListener('input', updateSnackSuggestions);
        }
        
        const entryModal = document.getElementById('entryModal');
        if (entryModal) {
            entryModal.classList.remove('hidden');
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
        
        // 기존 기록에서 shareBanned 필드 가져오기 (수정 시 유지)
        const existingRecord = state.currentEditingId ? window.mealHistory.find(m => m.id === state.currentEditingId) : null;
        const shareBanned = existingRecord?.shareBanned === true;
        
        // 카카오맵 API로 입력된 식당 정보 확인
        const placeInput = document.getElementById('placeInput');
        const kakaoPlaceId = placeInput?.getAttribute('data-kakao-place-id');
        const kakaoPlaceAddress = placeInput?.getAttribute('data-kakao-place-address');
        const kakaoPlaceData = placeInput?.getAttribute('data-kakao-place-data');
        const kakaoPlaceName = placeInput?.getAttribute('data-kakao-place-name') || '';
        // 카카오에서 선택한 장소명을 수정한 경우: 주소·placeId를 저장하지 않음 (잘못된 주소 매칭 방지)
        const nameMatches = !kakaoPlaceName || (String(placeInputVal || '').trim() === String(kakaoPlaceName).trim());
        const shouldUseKakaoFields = kakaoPlaceId && !isSk && nameMatches;

        const record = {
            id: state.currentEditingId,
            date: state.currentEditingDate,
            slotId: state.currentEditingSlotId,
            mealType,
            withWhom: getT('withChips'),
            withWhomDetail: isSk ? '' : withInputVal,
            category: getT('categoryChips'),
            placeType: '',
            snackType: getT('snackTypeChips'),
            photos: state.currentPhotos,
            menuDetail: isSk ? '' : (isS ? snackInputVal : menuInputVal),
            place: isSk ? '' : placeInputVal,
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
        
        // 공유할 사진 목록 결정 (단순화: wantsToShare와 currentPhotos만 사용)
        const photosToShare = (!isShareBanned && state.wantsToShare && state.currentPhotos.length > 0)
            ? [...state.currentPhotos]  // 공유 활성화: 현재 사진 전체
            : [];                        // 공유 비활성화 또는 금지: 빈 배열
        
        // record에 sharedPhotos 필드 추가
        record.sharedPhotos = photosToShare;
        
        // 공유 관련 정보를 미리 저장 (상태 초기화 전에)
        const currentPhotos = [...state.currentPhotos];
        
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
            console.log('저장 완료');
            
            // 공유 처리 (ID 확보 후 실행)
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
                    try {
                        await dbOps.sharePhotos(photosToShare, record);
                        console.log('공유 처리 완료:', {
                            공유사진수: photosToShare.length,
                            recordId: record.id,
                            공유설정: hasPhotosToShare,
                            공유해제: !hasPhotosToShare && hadSharedPhotos
                        });
                        // 리스너가 자동으로 갤러리를 업데이트하므로 여기서 직접 호출하지 않음
                    } catch (e) {
                        console.error("공유 처리 실패:", e);
                        showToast("사진 공유 처리 중 오류가 발생했습니다.", 'error');
                        // 공유 실패 시에도 기록은 이미 저장되었으므로 계속 진행
                    }
                }
            }
        } catch (saveError) {
            console.error('dbOps.save 오류:', saveError);
            // dbOps.save()에서 이미 에러 토스트를 표시하므로 여기서는 추가 처리 불필요
            // 로딩 오버레이는 이미 숨겨졌으므로 추가 처리 불필요
            return; // 저장 실패 시 여기서 종료
        }
        
        // 탭에 따라 적절한 뷰 업데이트 (데이터가 Firestore 리스너를 통해 업데이트되므로 약간의 지연 후 렌더링)
        setTimeout(() => {
            if (currentTab === 'timeline' && editingDate) {
                // 타임라인 탭: 저장된 항목의 날짜로 이동
                try {
                    const wasScrolling = window.isScrolling;
                    if (window.isScrolling !== undefined) {
                        window.isScrolling = true; // jumpToDate의 자동 스크롤 방지
                    }
                    if (window.jumpToDate) {
                        window.jumpToDate(editingDate);
                    }
                    
                    // 공유 상태가 변경된 경우 리스너가 자동으로 타임라인을 업데이트하므로
                    // 여기서는 추가 렌더링 호출 불필요 (중복 방지)
                    // 리스너가 100ms 내에 자동으로 renderTimeline()을 호출함
                    
                    // 타임라인 상단으로 스크롤하여 새로 추가된 항목이 트래커 아래에 보이도록
                    setTimeout(() => {
                        try {
                            // 트래커 섹션과 헤더 높이 계산
                            const trackerSection = document.getElementById('trackerSection');
                            const trackerHeight = trackerSection ? trackerSection.offsetHeight : 0;
                            const headerHeight = 73; // 헤더 높이 (top-[73px])
                            const totalOffset = headerHeight + trackerHeight;
                            
                            // 날짜 섹션이 렌더링된 후 해당 섹션으로 스크롤 (트래커 높이만큼 오프셋)
                            setTimeout(() => {
                                try {
                                    const dateSection = document.getElementById(`date-${editingDate}`);
                                    if (dateSection) {
                                        // 섹션의 위치를 계산하여 트래커 아래에 보이도록 스크롤
                                        const elementTop = dateSection.getBoundingClientRect().top + window.pageYOffset;
                                        const offsetPosition = elementTop - totalOffset - 16; // 16px 여유 공간
                                        window.scrollTo({ top: Math.max(0, offsetPosition), behavior: 'smooth' });
                                        if (window.isScrolling !== undefined) {
                                            window.isScrolling = wasScrolling; // 원래 상태 복원
                                        }
                                    } else {
                                        // 섹션이 아직 렌더링되지 않았으면 다시 시도
                                        setTimeout(() => {
                                            try {
                                                const dateSection2 = document.getElementById(`date-${editingDate}`);
                                                if (dateSection2) {
                                                    const elementTop = dateSection2.getBoundingClientRect().top + window.pageYOffset;
                                                    const offsetPosition = elementTop - totalOffset - 16;
                                                    window.scrollTo({ top: Math.max(0, offsetPosition), behavior: 'smooth' });
                                                }
                                                if (window.isScrolling !== undefined) {
                                                    window.isScrolling = wasScrolling; // 원래 상태 복원
                                                }
                                            } catch (scrollError) {
                                                console.error('스크롤 오류:', scrollError);
                                            }
                                        }, 200);
                                    }
                                } catch (scrollError) {
                                    console.error('스크롤 오류:', scrollError);
                                }
                            }, 400);
                        } catch (scrollError) {
                            console.error('스크롤 오류:', scrollError);
                        }
                    }, 200);
                } catch (scrollError) {
                    console.error('날짜 이동 오류:', scrollError);
                }
            } else if (currentTab === 'gallery') {
                // 갤러리 탭: 갤러리 다시 렌더링 (데이터가 업데이트되었으므로)
                // 리스너가 업데이트될 시간을 주기 위해 약간의 지연 후 렌더링
                setTimeout(() => {
                    try {
                        renderGallery();
                        // 피드도 함께 렌더링 (피드가 갤러리 안에 있을 수 있음)
                        const feedContent = document.getElementById('feedContent');
                        if (feedContent) {
                            renderFeed();
                        }
                    } catch (e) {
                        console.error('갤러리/피드 렌더링 오류:', e);
                    }
                }, 500);
            } else {
                // 피드가 별도 탭이거나 갤러리와 함께 표시되는 경우
                const feedContent = document.getElementById('feedContent');
                if (feedContent) {
                    try {
                        renderFeed();
                    } catch (e) {
                        console.error('피드 렌더링 오류:', e);
                    }
                }
                // 갤러리도 함께 확인
                const galleryView = document.getElementById('galleryView');
                if (galleryView && !galleryView.classList.contains('hidden')) {
                    try {
                        renderGallery();
                    } catch (e) {
                        console.error('갤러리 렌더링 오류:', e);
                    }
                }
            }
        }, 100);
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
        
        // 외식 또는 회식/술자리 선택 시 카카오 검색 버튼 표시 및 placeholder 변경
        const kakaoSearchBtn = document.getElementById('kakaoSearchBtn');
        const placeInput = document.getElementById('placeInput');
        if (kakaoSearchBtn && placeInput) {
            if (selectedValue === '외식' || selectedValue === '회식/술자리') {
                kakaoSearchBtn.classList.remove('hidden');
                placeInput.placeholder = '돋보기 버튼을 선택하여 식당을 검색해보세요';
            } else {
                kakaoSearchBtn.classList.add('hidden');
                placeInput.placeholder = '식당명이나 장소 (예: 스타벅스)';
            }
        }
    }
    
    if (isPrimary && subTagKey && subContainerId) {
        const subTags = window.userSettings.subTags[subTagKey] || [];
        // 함께한 사람의 경우 inputId를 'withWhomInput'으로 설정 (메인 태그 선택 시 자동 입력 방지)
        const inputIdForSecondary = (subTagKey === 'people') ? 'withWhomInput' : 
            (document.getElementById(subContainerId).getAttribute('data-input-id') || getInputIdFromContainer(subContainerId));
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
    
    // 편집 취소를 위한 스냅샷 보관
    state._profileSettingsSnapshot = JSON.parse(JSON.stringify(window.userSettings || {}));
    state.isProfileEditing = false;

    state.tempSettings = JSON.parse(JSON.stringify(window.userSettings));
    
    const ic = document.getElementById('iconSelector');
    if (ic) {
        ic.innerHTML = DEFAULT_ICONS.map(i => 
            `<div onclick="window.selectIcon('${i}')" class="icon-option ${state.tempSettings.profile.icon === i ? 'selected' : ''}">${i}</div>`
        ).join('');
    }
    
    // 프로필 타입 초기화 (text | emoji | photo)
    const inferredType =
        state.tempSettings?.profile?.photoUrl ? 'photo' :
        (state.tempSettings?.profile?.icon ? 'emoji' : 'text');
    const profileType = state.tempSettings?.profile?.iconType || inferredType;
    window.settingsProfileType = profileType;
    setSettingsProfileType(profileType);
    
    // 사진 미리보기 설정
    const photoPreview = document.getElementById('photoPreview');
    if (photoPreview && state.tempSettings.profile.photoUrl) {
        photoPreview.style.backgroundImage = `url(${state.tempSettings.profile.photoUrl})`;
        photoPreview.style.backgroundSize = 'cover';
        photoPreview.style.backgroundPosition = 'center';
        photoPreview.innerHTML = '';
    } else if (photoPreview) {
        photoPreview.innerHTML = '<i class="fa-solid fa-camera text-slate-400 text-xl"></i>';
        photoPreview.style.backgroundImage = '';
    }
    
    const nicknameInput = document.getElementById('settingNickname');
    if (nicknameInput) {
        nicknameInput.value = state.tempSettings.profile.nickname || '';
        // 닉네임 입력 시 텍스트 미리보기 즉시 반영 (중복 리스너 방지)
        nicknameInput.removeEventListener('input', nicknameInput._profileNicknameHandler);
        nicknameInput._profileNicknameHandler = () => {
            if (window.settingsProfileType === 'text') {
                setSettingsProfileType('text');
            }
        };
        nicknameInput.addEventListener('input', nicknameInput._profileNicknameHandler);
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
        // 글자 수 카운터 업데이트 이벤트
        bioInput.addEventListener('input', function() {
            const count = this.value.length;
            if (bioCharCount) {
                bioCharCount.textContent = count;
            }
        });
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
        // 게스트 모드일 때 프로필 설정 섹션 숨기기
        if (profileSettingsSection) profileSettingsSection.classList.add('hidden');
    } else {
        // 일반 사용자일 때 모든 탭 표시
        if (tagsTab) tagsTab.classList.remove('hidden');
        if (shortcutsTab) shortcutsTab.classList.remove('hidden');
        if (profileSettingsSection) profileSettingsSection.classList.remove('hidden');
        // 기본 탭을 프로필로 설정
        switchSettingsTab('profile');
        // 최초 진입은 '보기' 모드로 (수정 버튼을 눌러야 편집 가능)
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
        } else {
            const email = window.currentUser.email || 'Google 계정';
            const providerIcon = window.currentUser.providerData[0]?.providerId === 'google.com' ? 
                '<i class="fa-brands fa-google"></i>' : '<i class="fa-solid fa-envelope"></i>';
            accountHtml = `<div class="bg-emerald-50 p-4 rounded-2xl border border-emerald-100 mb-6">
                <h3 class="text-xs font-black text-emerald-600 mb-2 uppercase tracking-widest">로그인 정보</h3>
                <div class="flex items-center gap-2 text-emerald-700 font-bold text-sm">${providerIcon} ${email}</div>
            </div>`;
            document.getElementById('logoutBtnArea').classList.remove('hidden');
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
    
    const settingsPage = document.getElementById('settingsPage');
    settingsPage.classList.remove('hidden');
    // 애니메이션을 위해 다음 프레임에서 클래스 추가
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            settingsPage.classList.add('settings-open');
        });
    });
}

// 버전 정보 로드 함수
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
            
            // index.html 파일의 최종 수정 시간 가져오기
            try {
                const htmlResponse = await fetch('/index.html?t=' + Date.now());
                if (htmlResponse.ok) {
                    const lastModified = htmlResponse.headers.get('Last-Modified');
                    if (lastModified) {
                        const modifiedDate = new Date(lastModified);
                        const dateText = modifiedDate.toLocaleString('ko-KR', { 
                            year: 'numeric',
                            month: '2-digit', 
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit'
                        });
                        
                        if (buildDateEl) {
                            buildDateEl.textContent = dateText;
                            buildDateEl.title = modifiedDate.toLocaleString('ko-KR');
                        }
                    }
                }
            } catch (e) {
                console.debug('최종 수정 시간 로드 실패 (무시):', e);
                // Last-Modified 헤더가 없으면 buildDate 사용 (fallback)
                if (buildDateEl && data.buildDate) {
                    const buildDate = new Date(data.buildDate);
                    const dateText = buildDate.toLocaleString('ko-KR', { 
                        year: 'numeric',
                        month: '2-digit', 
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit'
                    });
                    
                    buildDateEl.textContent = dateText;
                    buildDateEl.title = buildDate.toLocaleString('ko-KR');
                }
            }
        }
    } catch (e) {
        console.debug('버전 정보 로드 실패 (무시):', e);
        // 버전 정보는 선택적이므로 실패해도 계속 진행
    }
}

export function closeSettings() {
    const settingsPage = document.getElementById('settingsPage');
    // 닫기 애니메이션
    settingsPage.classList.remove('settings-open');
    setTimeout(() => {
        settingsPage.classList.add('hidden');
    }, 300); // 애니메이션 시간과 동일
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

    // 탭 버튼 및 선택 UI 비활성화
    const textBtn = document.getElementById('profileTypeText');
    const emojiBtn = document.getElementById('profileTypeEmoji');
    const photoBtn = document.getElementById('profileTypePhoto');
    [textBtn, emojiBtn, photoBtn].forEach(btn => {
        if (!btn) return;
        btn.disabled = !isEditing;
        btn.classList.toggle('opacity-60', !isEditing);
        btn.classList.toggle('cursor-not-allowed', !isEditing);
    });

    const iconSelector = document.getElementById('iconSelector');
    if (iconSelector) {
        iconSelector.classList.toggle('pointer-events-none', !isEditing);
        iconSelector.classList.toggle('opacity-60', !isEditing);
    }

    const photoSelectBtn = document.getElementById('photoSelectBtn');
    if (photoSelectBtn) {
        photoSelectBtn.disabled = !isEditing;
        photoSelectBtn.classList.toggle('opacity-60', !isEditing);
        photoSelectBtn.classList.toggle('cursor-not-allowed', !isEditing);
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
    const inferredType =
        state.tempSettings?.profile?.photoUrl ? 'photo' :
        (state.tempSettings?.profile?.icon ? 'emoji' : 'text');
    const profileType = state.tempSettings?.profile?.iconType || inferredType;
    window.settingsProfileType = profileType;
    setSettingsProfileType(profileType);

    const nicknameInput = document.getElementById('settingNickname');
    if (nicknameInput) nicknameInput.value = state.tempSettings?.profile?.nickname || '';
    const bioInput = document.getElementById('settingBio');
    if (bioInput) bioInput.value = state.tempSettings?.profile?.bio || '';

    const photoPreview = document.getElementById('photoPreview');
    if (photoPreview && state.tempSettings?.profile?.photoUrl) {
        photoPreview.style.backgroundImage = `url(${state.tempSettings.profile.photoUrl})`;
        photoPreview.style.backgroundSize = 'cover';
        photoPreview.style.backgroundPosition = 'center';
        photoPreview.innerHTML = '';
    } else if (photoPreview) {
        photoPreview.innerHTML = '<i class="fa-solid fa-camera text-slate-400 text-xl"></i>';
        photoPreview.style.backgroundImage = '';
    }

    const emojiPreview = document.getElementById('emojiPreview');
    if (emojiPreview) emojiPreview.textContent = state.tempSettings?.profile?.icon || '🐻';

    setProfileSettingsEditMode(false);
};

// 설정 페이지 프로필 타입 설정
export function setSettingsProfileType(type) {
    window.settingsProfileType = type;
    
    // tempSettings에도 iconType 반영 (취소/저장에 사용)
    if (appState?.tempSettings?.profile) {
        appState.tempSettings.profile.iconType = type;
    }
    
    const textBtn = document.getElementById('profileTypeText');
    const emojiBtn = document.getElementById('profileTypeEmoji');
    const photoBtn = document.getElementById('profileTypePhoto');
    const textSection = document.getElementById('textSection');
    const emojiSection = document.getElementById('emojiSection');
    const photoSection = document.getElementById('photoSection');
    
    const setActive = (btn, active) => {
        if (!btn) return;
        // index.html의 컴팩트 탭 UI와 동일한 스펙으로 유지 (클래스 덮어쓰기 방지)
        btn.className = active
            ? 'flex-1 h-6 bg-emerald-600 text-white rounded-xl text-[12px] font-bold leading-none active:bg-emerald-700 transition-colors'
            : 'flex-1 h-6 bg-transparent text-slate-600 rounded-xl text-[12px] font-bold leading-none active:bg-slate-200 transition-colors';
    };

    setActive(textBtn, type === 'text');
    setActive(emojiBtn, type === 'emoji');
    setActive(photoBtn, type === 'photo');

    if (textSection) textSection.classList.toggle('hidden', type !== 'text');
    if (emojiSection) emojiSection.classList.toggle('hidden', type !== 'emoji');
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

    // 이모지 미리보기 업데이트
    const emojiPreview = document.getElementById('emojiPreview');
    if (emojiPreview) {
        emojiPreview.textContent = appState?.tempSettings?.profile?.icon || window.userSettings?.profile?.icon || '🐻';
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
        
        if (typeof window.openProfilePhotoEdit === 'function') {
            window.openProfilePhotoEdit(photoUrl);
        } else {
            showToast("사진 편집 기능을 불러올 수 없습니다.", "error");
            URL.revokeObjectURL(photoUrl);
        }
    } catch (e) {
        console.error("사진 업로드 처리 실패:", e);
        showToast("사진 업로드 중 오류가 발생했습니다.", "error");
    }
}

export async function saveProfileSettings() {
    const state = appState;
    try {
        if (!state.isProfileEditing) {
            showToast("수정 버튼을 누른 뒤 저장할 수 있습니다.", "info");
            return;
        }
        // 생년월일 / 라이프스타일
        const newBirthdate = (document.getElementById('settingBirthdate')?.value || '').trim();
        const newLifestyle = (document.getElementById('settingLifestyle')?.value || '').trim();
        if (!newBirthdate) {
            showToast("생년월일을 입력해주세요.", "error");
            return;
        }
        if (!newLifestyle) {
            showToast("라이프 스타일을 선택해주세요.", "error");
            return;
        }

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

        // 생년월일 변경 1회 제한
        const existingBirthdate = (window.userSettings?.profile?.birthdate || '').trim();
        const existingCount = Number(window.userSettings?.profile?.birthdateChangeCount || 0);
        const isBirthdateChanged = existingBirthdate && newBirthdate && existingBirthdate !== newBirthdate;
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
        state.tempSettings.profile.birthdate = newBirthdate;
        state.tempSettings.profile.lifestyle = newLifestyle;
        
        // 프로필 완료 플래그: 닉네임이 실제 값이면 완료로 처리
        const finalNickname = (state.tempSettings.profile.nickname || '').trim();
        if (finalNickname && finalNickname !== '게스트') {
            state.tempSettings.profileCompleted = true;
            state.tempSettings.profileCompletedAt = state.tempSettings.profileCompletedAt || new Date().toISOString();
        }
        
        // 아이콘 타입 저장 (text | emoji | photo)
        state.tempSettings.profile.iconType = window.settingsProfileType || 'text';

        // 프로필 타입에 따라 icon/photoUrl 저장
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
            state.tempSettings.profile.icon = null;
        } else if (window.settingsProfileType === 'emoji') {
            state.tempSettings.profile.icon = state.tempSettings.profile.icon || '🐻';
            state.tempSettings.profile.photoUrl = null;
            window.settingsPhotoFile = null;
            window.settingsPhotoUrl = null;
        } else {
            // text: 닉네임 첫 글자 표시 (저장은 nickname만으로 충분)
            state.tempSettings.profile.icon = null;
            state.tempSettings.profile.photoUrl = null;
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
        mealType: { label: '식사 방식', subTagKey: 'place', mainTags: state.tempSettings.tags?.mealType || [] },
        category: { label: '메뉴 카테고리', subTagKey: 'menu', mainTags: state.tempSettings.tags?.category || [] },
        withWhom: { label: '함께한 사람', subTagKey: 'people', mainTags: state.tempSettings.tags?.withWhom || [] },
        snackType: { label: '간식 유형', subTagKey: 'snack', mainTags: state.tempSettings.tags?.snackType || [] }
    };
    
    let html = '';
    Object.entries(tagConfigs).forEach(([mainTagKey, config]) => {
        const favoritesByMainTag = state.tempSettings.favoriteSubTags[mainTagKey] || {};
        const selectedMainTag = state.selectedFavoriteMainTag[mainTagKey] || null;
        const selectedFavorites = selectedMainTag ? (favoritesByMainTag[selectedMainTag] || []) : [];
        
        html += `<div class="bg-slate-50 p-4 rounded-2xl border border-slate-100 mb-6">
            <div class="text-xs font-bold text-slate-600 mb-3 uppercase">${config.label}</div>
            <div id="favoriteMainTags-${mainTagKey}" class="flex flex-wrap gap-2 mb-3">
                ${config.mainTags.map(mainTag => {
                    const isSelected = selectedMainTag === mainTag;
                    const favorites = favoritesByMainTag[mainTag] || [];
                    return `<button onclick="window.selectFavoriteMainTag('${mainTagKey}', '${mainTag.replace(/'/g, "\\'")}')" 
                        class="chip ${isSelected ? 'active' : ''}">
                        <span class="font-bold">${mainTag}</span> <span class="text-[10px] opacity-70">(${favorites.length}/5)</span>
                    </button>`;
                }).join('')}
            </div>
            <div class="flex gap-2 mb-3">
                <input type="text" id="newFavoriteTag-${mainTagKey}-${selectedMainTag || 'none'}" class="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs outline-none focus:border-slate-400" placeholder="태그 입력" onkeypress="if(event.key==='Enter' && window.selectedFavoriteMainTag && window.selectedFavoriteMainTag['${mainTagKey}']) window.addFavoriteTag('${mainTagKey}', window.selectedFavoriteMainTag['${mainTagKey}'])">
                <button onclick="if(window.selectedFavoriteMainTag && window.selectedFavoriteMainTag['${mainTagKey}']) window.addFavoriteTag('${mainTagKey}', window.selectedFavoriteMainTag['${mainTagKey}'])" class="bg-emerald-600 text-white px-4 py-1.5 rounded-lg text-xs font-bold ${selectedMainTag ? '' : 'opacity-50 cursor-not-allowed'}" ${selectedMainTag ? '' : 'disabled'}>추가</button>
            </div>
            ${selectedMainTag ? `
                ${selectedFavorites.length >= 5 ? '<div class="text-[10px] text-slate-500 mb-3">최대 5개까지 입력 가능합니다</div>' : ''}
                <div class="mt-3">
                    <div class="text-[10px] text-slate-400 mb-2">나만의 태그 (최대 5개)</div>
                    <div class="flex flex-wrap gap-2" id="favoriteTags-${mainTagKey}-${selectedMainTag}">
                        ${selectedFavorites.map((text, idx) => `
                            <div class="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-bold">
                                <span>${text}</span>
                                <button onclick="window.removeFavoriteTag('${mainTagKey}', '${selectedMainTag.replace(/'/g, "\\'")}', ${idx})" class="ml-1 hover:bg-emerald-700 rounded-full w-4 h-4 flex items-center justify-center transition-colors">
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
    
    // 즉시 저장
    try {
        await dbOps.saveSettings(state.tempSettings);
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
        
        // 즉시 저장
        try {
            await dbOps.saveSettings(state.tempSettings);
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

// 카카오 장소 검색 함수
export function openKakaoPlaceSearch() {
    console.log('카카오 장소 검색 함수 호출');
    console.log('현재 상태:', {
        kakao: typeof kakao,
        windowKakaoSDKLoaded: window.kakaoSDKLoaded,
        location: window.location.href
    });
    
    // 카카오 API 로드 확인 및 대기
    const checkKakaoAPI = () => {
        try {
            const isReady = typeof kakao !== 'undefined' && 
                           kakao.maps && 
                           kakao.maps.services &&
                           typeof kakao.maps.services.Places !== 'undefined';
            if (isReady) {
                console.log('✅ 카카오 API 준비 완료');
            }
            return isReady;
        } catch (e) {
            console.log('카카오 API 체크 중 에러:', e);
            return false;
        }
    };
    
    // 즉시 확인
    if (checkKakaoAPI()) {
        createKakaoSearchModal();
        return;
    }
    
    // 로딩 표시
    showToast("카카오 지도 API를 불러오는 중...", 'info');
    
    // 아직 로드되지 않았으면 대기 (최대 5초)
    let attempts = 0;
    const maxAttempts = 50; // 5초 (100ms * 50)
    
    const waitForKakao = setInterval(() => {
        attempts++;
        
        try {
            if (checkKakaoAPI()) {
                clearInterval(waitForKakao);
                createKakaoSearchModal();
                return;
            }
        } catch (e) {
            // kakao가 정의되지 않았을 때 에러 무시
        }
        
        if (attempts >= maxAttempts) {
            clearInterval(waitForKakao);
            console.error('카카오 API 로드 실패: kakao 객체가 정의되지 않았습니다.');
            
            // 안전하게 상태 확인
            let statusInfo = {
                windowKakaoSDKLoaded: window.kakaoSDKLoaded,
                kakaoDefined: typeof kakao !== 'undefined'
            };
            
            try {
                if (typeof kakao !== 'undefined') {
                    statusInfo.maps = typeof kakao.maps;
                    statusInfo.services = typeof kakao.maps?.services;
                }
            } catch (e) {
                statusInfo.error = 'kakao 객체 접근 불가';
            }
            
            console.error('═══════════════════════════════════════');
            console.error('현재 상태:', statusInfo);
            console.error('현재 URL:', window.location.href);
            console.error('현재 호스트명:', window.location.hostname);
            console.error('═══════════════════════════════════════');
            console.error('');
            console.error('💡 카카오 디벨로퍼스에서 다음을 확인하세요:');
            console.error('');
            console.error('1️⃣ JavaScript 키 확인 (중요!)');
            console.error('   - 앱 설정 > 앱 키 > JavaScript 키 사용');
            console.error('   - 현재 사용 중인 키: 42dce12f04991c35775f3ce1081a3c76');
            console.error('   - ⚠️ REST API 키가 아닌 JavaScript 키여야 함!');
            console.error('');
            console.error('2️⃣ 플랫폼 등록 확인');
            console.error('   - 앱 설정 > 플랫폼 > Web 플랫폼 추가');
            console.error('   - 사이트 도메인에 현재 도메인 등록 필요');
            console.error('');
            console.error('3️⃣ 도메인 등록 확인');
            console.error('   - Web 플랫폼 > 사이트 도메인에 추가:');
            console.error('     * ' + window.location.hostname);
            console.error('     * ' + window.location.host);
            if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
                console.error('     * localhost');
                console.error('     * 127.0.0.1');
            }
            console.error('');
            console.error('4️⃣ 카카오맵 사용 설정 확인');
            console.error('   - 앱 설정 > 제품 설정 > 카카오맵 > 사용 설정 ON');
            console.error('   - 링크: https://developers.kakao.com/console/app/1366360/product/kakao-map');
            console.error('');
            console.error('5️⃣ 브라우저 네트워크 확인');
            console.error('   - F12 > Network 탭 > "dapi.kakao.com" 검색');
            console.error('   - 요청의 Status Code 확인 (403, 401 등)');
            console.error('   - Response 탭에서 에러 메시지 확인');
            console.error('');
            console.error('🔗 빠른 링크:');
            console.error('   - 앱 설정: https://developers.kakao.com/console/app/1366360');
            console.error('   - 플랫폼 설정: https://developers.kakao.com/console/app/1366360/platform');
            console.error('   - 카카오맵 설정: https://developers.kakao.com/console/app/1366360/product/kakao-map');
            console.error('═══════════════════════════════════════');
            
            showToast("카카오 지도 API를 불러올 수 없습니다. 브라우저 콘솔(F12)을 확인해주세요.", 'error');
        }
    }, 100);
}

// 카카오 검색 모달 생성 함수
function createKakaoSearchModal() {
    
    const placeInput = document.getElementById('placeInput');
    if (!placeInput) return;
    
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
                    <button onclick="window.searchKakaoPlaces()" class="absolute left-2 top-1/2 -translate-y-1/2 bg-emerald-600 text-white rounded-lg p-2 z-10 hover:bg-emerald-700 transition-colors">
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
        
        // 자동완성 (입력 중 실시간 검색) - 디바운싱 적용
        let searchTimeout = null;
        searchInput.addEventListener('input', (e) => {
            const keyword = e.target.value.trim();
            
            // 이전 타이머 취소
            if (searchTimeout) {
                clearTimeout(searchTimeout);
            }
            
            // 빈 문자열이면 결과 초기화
            if (!keyword) {
                const resultsContainer = document.getElementById('kakaoSearchResults');
                if (resultsContainer) {
                    resultsContainer.innerHTML = '';
                }
                return;
            }
            
            // 500ms 후 자동 검색 실행 (디바운싱)
            searchTimeout = setTimeout(() => {
                window.searchKakaoPlaces();
            }, 500);
        });
        
        searchInput.focus();
    }
}

// 카카오 장소 검색 실행
export function searchKakaoPlaces() {
    const searchInput = document.getElementById('kakaoSearchInput');
    const resultsContainer = document.getElementById('kakaoSearchResults');
    
    if (!searchInput || !resultsContainer) return;
    
    const keyword = searchInput.value.trim();
    if (!keyword) {
        showToast("검색어를 입력해주세요.", 'info');
        return;
    }
    
    if (typeof kakao === 'undefined' || !kakao.maps || !kakao.maps.services) {
        showToast("카카오 지도 API를 불러올 수 없습니다. 브라우저 콘솔을 확인해주세요.", 'error');
        console.error('카카오 API 로드 실패');
        return;
    }
    
    // 로딩 표시
    resultsContainer.innerHTML = '<div class="text-center py-8 text-slate-400 text-sm">검색 중...</div>';
    
    // 장소 검색 객체 생성
    const ps = new kakao.maps.services.Places();
    
    // 키워드로 장소 검색 (카테고리 제한 없이 검색하여 더 많은 결과 포함)
    ps.keywordSearch(keyword, (data, status) => {
        if (status === kakao.maps.services.Status.OK) {
            // 음식점 필터링 (더 포괄적인 카테고리 체크)
            const restaurants = data.filter(place => {
                const category = place.category_name || '';
                const categoryGroup = place.category_group_code || '';
                
                // 카테고리 그룹 코드로 필터링 (FD6: 음식점)
                if (categoryGroup === 'FD6') {
                    return true;
                }
                
                // 카테고리명으로 필터링 (더 포괄적으로)
                const categoryLower = category.toLowerCase();
                return categoryLower.includes('음식점') || 
                       categoryLower.includes('식당') || 
                       categoryLower.includes('카페') || 
                       categoryLower.includes('레스토랑') || 
                       categoryLower.includes('맛집') ||
                       categoryLower.includes('요리') ||
                       categoryLower.includes('식음료') ||
                       categoryLower.includes('제과') ||
                       categoryLower.includes('베이커리') ||
                       categoryLower.includes('술집') ||
                       categoryLower.includes('바') ||
                       (categoryLower.includes('펜션') && categoryLower.includes('식당')) ||
                       (categoryLower.includes('호텔') && categoryLower.includes('레스토랑'));
            });
            
            if (restaurants.length === 0) {
                resultsContainer.innerHTML = '<div class="text-center py-8 text-slate-400 text-sm">검색 결과가 없습니다.</div>';
                return;
            }
            
            // 결과 표시
            resultsContainer.innerHTML = restaurants.slice(0, 10).map((place, index) => {
                const placeName = place.place_name || '';
                const address = place.address_name || '';
                const roadAddress = place.road_address_name || '';
                const placeId = place.id || '';
                const category = place.category_name || '';
                
                // 안전한 이스케이프 함수 (따옴표와 백슬래시 처리)
                const escapeForAttr = (str) => {
                    if (!str) return '';
                    return String(str)
                        .replace(/\\/g, '\\\\')
                        .replace(/'/g, "\\'")
                        .replace(/"/g, '&quot;')
                        .replace(/\n/g, ' ')
                        .replace(/\r/g, '');
                };
                
                const safePlaceName = escapeForAttr(placeName);
                const safeAddress = escapeForAttr(roadAddress || address);
                const safePlaceId = escapeForAttr(placeId);
                const safeCategory = escapeForAttr(category);
                
                // data 속성에 저장할 JSON 데이터 (Base64 인코딩)
                const placeDataObj = {
                    id: placeId,
                    name: placeName,
                    address: roadAddress || address,
                    roadAddress: roadAddress,
                    category: category
                };
                
                let placeDataB64 = '';
                try {
                    placeDataB64 = btoa(unescape(encodeURIComponent(JSON.stringify(placeDataObj))))
                        .replace(/\+/g, '-')
                        .replace(/\//g, '_')
                        .replace(/=/g, '');
                } catch (e) {
                    console.warn('placeData 인코딩 실패:', e);
                }
                
                return `
                    <button onclick="window.selectKakaoPlace('${safePlaceName}', '${safeAddress}', '${safePlaceId}', '${placeDataB64}')" 
                        class="w-full p-4 bg-white border border-slate-200 rounded-xl text-left hover:bg-slate-50 active:bg-slate-100 transition-colors">
                        <div class="font-bold text-slate-800 mb-1">${placeName}</div>
                        <div class="text-xs text-slate-500">${roadAddress || address}</div>
                    </button>
                `;
            }).join('');
        } else if (status === kakao.maps.services.Status.ZERO_RESULT) {
            resultsContainer.innerHTML = '<div class="text-center py-8 text-slate-400 text-sm">검색 결과가 없습니다.</div>';
        } else {
            resultsContainer.innerHTML = '<div class="text-center py-8 text-slate-400 text-sm">검색 중 오류가 발생했습니다.</div>';
            console.error('카카오 장소 검색 오류:', status);
        }
    });
}

// 카카오 장소 선택
export function selectKakaoPlace(placeName, address, placeId = null, placeDataB64 = null) {
    const placeInput = document.getElementById('placeInput');
    if (placeInput) {
        placeInput.value = placeName;
    }
    
    // 카카오맵 API로 입력된 식당임을 표시하기 위해 데이터 속성에 저장
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



