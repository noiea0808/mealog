// 모달 및 입력 처리 관련 함수들
import { SLOTS, SATIETY_DATA, DEFAULT_ICONS, DEFAULT_SUB_TAGS } from './constants.js';
import { appState } from './state.js';
import { setVal, compressImage, getInputIdFromContainer } from './utils.js';
import { renderEntryChips, renderPhotoPreviews, renderTagManager } from './render.js';
import { dbOps } from './db.js';
import { showToast } from './ui.js';
import { renderTimeline, renderMiniCalendar, renderGallery, renderFeed } from './render.js';
import { getDashboardData } from './analytics.js';

// 설정 저장 디바운싱을 위한 타이머
let settingsSaveTimeout = null;

export function openModal(date, slotId, entryId = null) {
    try {
        const state = appState;
        if (!window.currentUser) return;
        if (!date || !slotId) {
            console.error('openModal: 필수 파라미터가 없습니다.', { date, slotId });
            return;
        }
        
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
        
        // 버튼 텍스트 설정 (수정 모드인 경우 "수정 완료", 새로 등록인 경우 "기록 완료")
        const btnSave = document.getElementById('btnSave');
        if (btnSave) {
            btnSave.innerText = entryId ? '수정 완료' : '기록 완료';
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
                state.wantsToShare = (state.sharedPhotos && state.sharedPhotos.length > 0); // 이미 공유된 사진이 있으면 공유 상태로
                // 필드 표시/숨김 처리 후에 renderPhotoPreviews 호출
                renderPhotoPreviews();
                // 공유 인디케이터 업데이트
                updateShareIndicator();
                setVal('placeInput', r.place || "");
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
                    // 식사 구분 (mealType)
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
                    
                    // 메뉴 상세 (menuDetail) - sub-chip
                    if (r.menuDetail) {
                        const menuSuggestions = document.getElementById('menuSuggestions');
                        if (menuSuggestions) {
                            menuSuggestions.querySelectorAll('button.sub-chip').forEach(ch => {
                                if (ch.innerText.trim() === r.menuDetail.trim()) {
                                    ch.classList.add('active');
                                }
                            });
                        }
                    }
                    
                    // 함께한 사람 상세 (withWhomDetail) - sub-chip
                    if (r.withWhomDetail) {
                        const peopleSuggestions = document.getElementById('peopleSuggestions');
                        if (peopleSuggestions) {
                            peopleSuggestions.querySelectorAll('button.sub-chip').forEach(ch => {
                                if (ch.innerText.trim() === r.withWhomDetail.trim()) {
                                    ch.classList.add('active');
                                }
                            });
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
        if (menuInputVal && !newSettings.subTags.menu.find(t => (t.text || t) === menuInputVal)) {
            newSettings.subTags.menu.push({ text: menuInputVal, parent: getT('categoryChips') });
            tagsChanged = true;
        }
        if (withInputVal && !newSettings.subTags.people.find(t => (t.text || t) === withInputVal)) {
            newSettings.subTags.people.push({ text: withInputVal, parent: getT('withChips') });
            tagsChanged = true;
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
        
        // 디버깅: 저장될 record 확인
        if (isS) {
            console.log('저장될 간식 record:', record);
        }
        
        if (loadingOverlay) loadingOverlay.classList.remove('hidden');
        // 삭제된 사진 찾기: 원래 공유되었던 사진 중 현재 currentPhotos에 없는 사진들
        // URL 비교 시 쿼리 파라미터 무시
        const normalizeUrl = (url) => (url || '').split('?')[0];
        const deletedPhotos = state.originalSharedPhotos.filter(originalPhoto => {
            const normalizedOriginal = normalizeUrl(originalPhoto);
            return !state.currentPhotos.some(currentPhoto => 
                normalizeUrl(currentPhoto) === normalizedOriginal
            );
        });
        
        // 삭제된 사진이 있고, 기록이 이미 존재하는 경우 피드에서 삭제
        if (deletedPhotos.length > 0 && record.id) {
            try {
                console.log('삭제된 사진 피드에서 제거:', deletedPhotos, 'entryId:', record.id);
                await dbOps.unsharePhotos(deletedPhotos, record.id);
                // 삭제된 사진을 sharedPhotos에서도 제거 (URL 정규화하여 비교)
                state.sharedPhotos = state.sharedPhotos.filter(p => {
                    const normalizedP = normalizeUrl(p);
                    return !deletedPhotos.some(dp => normalizeUrl(dp) === normalizedP);
                });
                console.log('삭제 후 sharedPhotos:', state.sharedPhotos);
            } catch (e) {
                console.error("삭제된 사진 피드 제거 실패:", e);
                // 실패해도 계속 진행
            }
        }
        
        // sharedPhotos 필드 추가 (현재 공유된 사진 목록 저장)
        // 삭제된 사진을 제거한 후의 최종 목록으로 업데이트
        record.sharedPhotos = state.sharedPhotos || [];
        
        // 공유 상태에 따라 처리
        if (state.wantsToShare && state.currentPhotos.length > 0) {
            // 공유를 원하는 경우: 새로 공유할 사진 찾기 (URL 정규화하여 비교)
            const newPhotosToShare = state.currentPhotos.filter(photo => {
                const normalizedPhoto = normalizeUrl(photo);
                return !state.sharedPhotos.some(sharedPhoto => 
                    normalizeUrl(sharedPhoto) === normalizedPhoto
                );
            });
            
            if (newPhotosToShare.length > 0) {
                try {
                    await dbOps.sharePhotos(newPhotosToShare, record);
                    // 공유 성공: 공유된 사진 목록 업데이트
                    state.sharedPhotos = [...state.sharedPhotos, ...newPhotosToShare];
                    record.sharedPhotos = state.sharedPhotos;
                    console.log('사진 공유 성공:', {
                        새로공유: newPhotosToShare.length,
                        전체공유: state.sharedPhotos.length,
                        recordSharedPhotos: record.sharedPhotos.length
                    });
                } catch (e) {
                    console.error("사진 공유 실패:", e);
                    // 사진 공유 실패 시에도 에러 토스트는 표시하지 않음 (이미 db.js나 다른 곳에서 표시했을 수 있음)
                    // 현재 상태는 유지하고 계속 진행
                    // (이미 state.currentPhotos에는 사진이 있으므로 다음에 다시 시도 가능)
                    record.sharedPhotos = state.sharedPhotos || [];
                }
            } else {
                // 이미 모두 공유된 경우: 현재 공유 상태 유지
                record.sharedPhotos = state.sharedPhotos || [];
            }
        } else if (!state.wantsToShare && state.sharedPhotos.length > 0 && record.id) {
            // 공유 해제한 경우: 피드에서 해당 사진들 삭제
            try {
                await dbOps.unsharePhotos(state.sharedPhotos, record.id);
                // 공유된 사진 목록 초기화
                state.sharedPhotos = [];
                record.sharedPhotos = [];
            } catch (e) {
                console.error("사진 공유 해제 실패:", e);
                // 공유 해제 실패 시 현재 상태 유지
                record.sharedPhotos = state.sharedPhotos || [];
                // dbOps.unsharePhotos에서 이미 에러 토스트를 표시함
                // 공유 해제 실패해도 기록 저장은 성공했으므로 계속 진행
            }
        } else {
            // 공유를 원하지 않는 경우: 현재 공유 상태 유지
            record.sharedPhotos = state.sharedPhotos || [];
        }
        
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
        
        // 상태 초기화 (모달 닫기 직후)
        state.currentEditingId = null;
        state.currentPhotos = [];
        state.sharedPhotos = [];
        state.originalSharedPhotos = [];
        state.wantsToShare = false;
        
        // 저장 실행 (모달과 로딩 오버레이가 이미 닫힌 상태에서)
        try {
            await dbOps.save(record);
            console.log('저장 완료');
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
    container.querySelectorAll(isPrimary ? '.chip' : '.sub-chip').forEach(c => c.classList.remove('active'));
    let selectedValue = value;
    
    if (isActive) {
        if (inputId !== 'null') {
            const input = document.getElementById(inputId);
            if (input) input.value = '';
        }
        btn.classList.remove('active');
        selectedValue = null;
    } else {
        btn.classList.add('active');
        if (inputId !== 'null') {
            const input = document.getElementById(inputId);
            if (input) input.value = value;
        }
    }
    
    // Skip 선택 시 필드 숨기기 처리 (typeChips에서만)
    // typeChips는 subTagKey가 'place'이고 inputId가 'null'인 경우
    if (isPrimary && inputId === 'null' && subTagKey === 'place') {
        const isSkip = (selectedValue === 'Skip' || selectedValue === '건너뜀');
        toggleFieldsForSkip(isSkip);
    }
    
    if (isPrimary && subTagKey && subContainerId) {
        const subTags = window.userSettings.subTags[subTagKey] || [];
        window.renderSecondary(subContainerId, subTags, 
            document.getElementById(subContainerId).getAttribute('data-input-id') || getInputIdFromContainer(subContainerId), 
            selectedValue, subTagKey);
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
    // 공유된 사진 목록에서도 제거
    if (state.sharedPhotos && state.sharedPhotos.includes(removedPhoto)) {
        state.sharedPhotos = state.sharedPhotos.filter(p => p !== removedPhoto);
    }
    renderPhotoPreviews();
    updateShareIndicator();
}

export function updateShareIndicator() {
    const state = appState;
    const shareIndicator = document.getElementById('sharePhotoIndicator');
    if (!shareIndicator) return;
    
    // 사진이 있으면 항상 인디케이터 표시 (공유 가능 상태)
    if (state.currentPhotos.length > 0) {
        // 공유된 사진이 있거나 공유를 원하는 경우 활성화 스타일
        if (state.sharedPhotos.length > 0 || state.wantsToShare) {
            shareIndicator.classList.remove('hidden');
            shareIndicator.classList.add('bg-emerald-100', 'border-emerald-300');
            shareIndicator.classList.remove('bg-slate-50', 'border-slate-200');
        } else {
            // 사진은 있지만 아직 공유하지 않은 경우도 표시 (비활성화 스타일)
            shareIndicator.classList.remove('hidden');
            shareIndicator.classList.add('bg-slate-50', 'border-slate-200');
            shareIndicator.classList.remove('bg-emerald-100', 'border-emerald-300');
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
    
    state.tempSettings = JSON.parse(JSON.stringify(window.userSettings));
    
    const ic = document.getElementById('iconSelector');
    if (ic) {
        ic.innerHTML = DEFAULT_ICONS.map(i => 
            `<div onclick="window.selectIcon('${i}')" class="icon-option ${state.tempSettings.profile.icon === i ? 'selected' : ''}">${i}</div>`
        ).join('');
    }
    
    document.getElementById('settingNickname').value = state.tempSettings.profile.nickname;
    
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
    
    const accountSection = document.getElementById('accountSection');
    if (accountSection) {
        let accountHtml = '';
        if (window.currentUser.isAnonymous) {
            accountHtml = `<div class="bg-indigo-50 p-4 rounded-2xl border border-indigo-100 mb-6 flex items-center gap-3">
                <div class="w-10 h-10 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-500">
                    <i class="fa-solid fa-user-secret"></i>
                </div>
                <div>
                    <div class="text-xs font-bold text-indigo-600">게스트 모드</div>
                    <div class="text-[10px] text-indigo-400">앱 삭제 시 데이터가 사라집니다.</div>
                </div>
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
    }
    
    document.getElementById('settingsPage').classList.remove('hidden');
}

export function closeSettings() {
    document.getElementById('settingsPage').classList.add('hidden');
}

export async function saveSettings() {
    const state = appState;
    try {
        state.tempSettings.profile.nickname = document.getElementById('settingNickname').value;
        await dbOps.saveSettings(state.tempSettings);
        window.closeSettings();
        showToast("설정이 저장되었습니다.", 'success');
    } catch (e) {
        console.error('설정 저장 실패:', e);
        // dbOps.saveSettings에서 이미 에러 토스트를 표시하므로 여기서는 추가 처리 불필요
        // 모달은 닫지 않고 사용자가 다시 시도할 수 있도록 함
    }
}

export function selectIcon(i) {
    const state = appState;
    state.tempSettings.profile.icon = i;
    document.querySelectorAll('.icon-option').forEach(el => el.classList.toggle('selected', el.innerText === i));
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
        mealType: { label: '식사 구분', subTagKey: 'place', mainTags: state.tempSettings.tags?.mealType || [] },
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
                <input type="text" id="newFavoriteTag-${mainTagKey}-${selectedMainTag || 'none'}" class="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs outline-none focus:border-emerald-500" placeholder="태그 입력" onkeypress="if(event.key==='Enter' && window.selectedFavoriteMainTag && window.selectedFavoriteMainTag['${mainTagKey}']) window.addFavoriteTag('${mainTagKey}', window.selectedFavoriteMainTag['${mainTagKey}'])">
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

export function addFavoriteTag(mainTagKey, mainTag) {
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
}

export function removeFavoriteTag(mainTagKey, mainTag, index) {
    const state = appState;
    if (!state.tempSettings.favoriteSubTags || !state.tempSettings.favoriteSubTags[mainTagKey]) return;
    
    if (!state.tempSettings.favoriteSubTags[mainTagKey][mainTag]) {
        state.tempSettings.favoriteSubTags[mainTagKey][mainTag] = [];
    }
    
    const favorites = state.tempSettings.favoriteSubTags[mainTagKey][mainTag];
    if (index >= 0 && index < favorites.length) {
        favorites.splice(index, 1);
        renderFavoriteTagsEditor();
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



