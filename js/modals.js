// 모달 및 입력 처리 관련 함수들
import { SLOTS, SATIETY_DATA, DEFAULT_ICONS, DEFAULT_SUB_TAGS } from './constants.js';
import { appState } from './state.js';
import { setVal, compressImage, getInputIdFromContainer } from './utils.js';
import { renderEntryChips, renderPhotoPreviews, renderTagManager } from './render.js';
import { dbOps } from './db.js';
import { showToast } from './ui.js';
import { renderTimeline, renderMiniCalendar } from './render.js';
import { getDashboardData } from './analytics.js';

export function openModal(date, slotId, entryId = null) {
    const state = appState;
    if (!window.currentUser) return;
    
    document.querySelectorAll('.chip, .sub-chip').forEach(el => el.classList.remove('active'));
    state.currentEditingId = entryId;
    state.currentEditingDate = date;
    state.currentEditingSlotId = slotId;
    state.currentPhotos = [];
    state.sharedPhotos = []; // 이미 공유된 사진 목록
    state.originalSharedPhotos = []; // 원본 공유 사진 목록 (삭제 추적용)
    state.wantsToShare = false; // 공유를 원하는지 여부
    
    document.getElementById('modalTitle').innerText = SLOTS.find(s => s.id === slotId).label;
    renderEntryChips();
    
    // 공유 인디케이터 숨기기
    const shareIndicator = document.getElementById('sharePhotoIndicator');
    if (shareIndicator) shareIndicator.classList.add('hidden');
    
    ['placeInput', 'menuDetailInput', 'withWhomInput', 'snackDetailInput', 'generalCommentInput'].forEach(id => {
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
    
    const isS = SLOTS.find(s => s.id === slotId).type === 'snack';
    document.getElementById('optionalFields')?.classList.toggle('hidden', isS);
    document.getElementById('reviewSection')?.classList.remove('hidden');
    document.getElementById('btnDelete')?.classList.add('hidden');
    document.getElementById('satietySection').classList.toggle('hidden', isS);
    
    // 필드 표시/숨김 처리를 먼저 수행 (renderPhotoPreviews가 올바른 컨테이너를 찾을 수 있도록)
    document.getElementById('mainMealFields').classList.toggle('hidden', isS);
    document.getElementById('snackFields').classList.toggle('hidden', !isS);
    
    // 버튼 텍스트 설정 (수정 모드인 경우 "수정 완료", 새로 등록인 경우 "기록 완료")
    const btnSave = document.getElementById('btnSave');
    if (btnSave) {
        btnSave.innerText = entryId ? '수정 완료' : '기록 완료';
    }
    
    if (entryId) {
        const r = window.mealHistory.find(m => m.id === entryId);
        if (r) {
            // photos가 배열인지 확인하고, 배열이 아니면 배열로 변환
            state.currentPhotos = Array.isArray(r.photos) ? r.photos : (r.photos ? [r.photos] : []);
            // sharedPhotos도 배열인지 확인
            state.sharedPhotos = Array.isArray(r.sharedPhotos) ? r.sharedPhotos : (r.sharedPhotos ? [r.sharedPhotos] : []);
            state.originalSharedPhotos = Array.isArray(r.sharedPhotos) ? [...r.sharedPhotos] : (r.sharedPhotos ? [r.sharedPhotos] : []); // 원본 복사 (삭제 추적용)
            state.wantsToShare = (state.sharedPhotos && state.sharedPhotos.length > 0); // 이미 공유된 사진이 있으면 공유 상태로
            // 필드 표시/숨김 처리 후에 renderPhotoPreviews 호출
            renderPhotoPreviews();
            setVal('placeInput', r.place || "");
            setVal('menuDetailInput', r.menuDetail || "");
            setVal('withWhomInput', r.withWhomDetail || "");
            setVal('snackDetailInput', r.menuDetail || "");
            setVal('generalCommentInput', r.comment || "");
            
            if (r.rating) window.setRating(r.rating);
            if (r.satiety) window.setSatiety(r.satiety);
            
            // 공유 인디케이터 표시
            updateShareIndicator();
            
            // 태그 활성화 처리
            ['typeChips', 'restaurantSuggestions', 'withChips', 'peopleSuggestions', 'categoryChips', 'menuSuggestions', 'snackTypeChips', 'snackSuggestions'].forEach(id => {
                const c = document.getElementById(id);
                if (c) {
                    c.querySelectorAll('button').forEach(ch => {
                        const checkValues = [r.mealType, r.category, r.withWhom, r.snackType, r.place, r.menuDetail, r.withWhomDetail];
                        if (checkValues.includes(ch.innerText)) {
                            ch.classList.add('active');
                        }
                    });
                }
            });
            
            // 간식 타입 선택 시 추천 태그 업데이트
            if (isS && r.snackType) {
                const subTags = window.userSettings.subTags.snack || [];
                window.renderSecondary('snackSuggestions', subTags, 'snackDetailInput', r.snackType, 'snack');
            }
            
            if (r.mealType === 'Skip' || r.mealType === '???') {
                document.getElementById('optionalFields')?.classList.add('hidden');
                document.getElementById('reviewSection')?.classList.add('hidden');
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
    
    document.getElementById('entryModal').classList.remove('hidden');
}

export function closeModal() {
    document.getElementById('entryModal').classList.add('hidden');
}

export async function saveEntry() {
    const state = appState;
    const getT = (id) => document.getElementById(id)?.querySelector('.chip.active')?.innerText || '';
    const isS = SLOTS.find(s => s.id === state.currentEditingSlotId).type === 'snack';
    const mealType = getT('typeChips');
    const isSk = mealType === 'Skip' || mealType === '???';
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
        await dbOps.saveSettings(window.userSettings);
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
        comment: isSk ? '' : (document.getElementById('generalCommentInput')?.value || ''),
        rating: (isSk) ? null : state.currentRating,
        satiety: (isSk || isS) ? null : state.currentSatiety,
        time: new Date().toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' })
    };
    
    // 디버깅: 저장될 record 확인
    if (isS) {
        console.log('저장될 간식 record:', record);
    }
    
    document.getElementById('loadingOverlay').classList.remove('hidden');
    try {
        // 삭제된 사진 찾기: 원래 공유되었던 사진 중 현재 currentPhotos에 없는 사진들
        const deletedPhotos = state.originalSharedPhotos.filter(photo => 
            !state.currentPhotos.includes(photo)
        );
        
        // 삭제된 사진이 있고, 기록이 이미 존재하는 경우 피드에서 삭제
        if (deletedPhotos.length > 0 && record.id) {
            try {
                console.log('삭제된 사진 피드에서 제거:', deletedPhotos, 'entryId:', record.id);
                await dbOps.unsharePhotos(deletedPhotos, record.id);
                // 삭제된 사진을 sharedPhotos에서도 제거 (이미 removePhoto에서 제거되었지만 확실히 하기 위해)
                state.sharedPhotos = state.sharedPhotos.filter(p => !deletedPhotos.includes(p));
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
            // 공유를 원하는 경우: 새로 공유할 사진 찾기
            const newPhotosToShare = state.currentPhotos.filter(photo => 
                !state.sharedPhotos.includes(photo)
            );
            
            if (newPhotosToShare.length > 0) {
                try {
                    await dbOps.sharePhotos(newPhotosToShare, record);
                    // 공유된 사진 목록 업데이트
                    state.sharedPhotos = [...state.sharedPhotos, ...newPhotosToShare];
                    record.sharedPhotos = state.sharedPhotos;
                } catch (e) {
                    console.error("사진 공유 실패:", e);
                    // 사진 공유 실패해도 기록 저장은 성공했으므로 계속 진행
                }
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
                // 공유 해제 실패해도 기록 저장은 성공했으므로 계속 진행
            }
        }
        
        await dbOps.save(record);
        window.closeModal();
        
        // 저장된 항목의 날짜로 이동 (스크롤 없이 렌더링만)
        const wasScrolling = window.isScrolling;
        window.isScrolling = true; // jumpToDate의 자동 스크롤 방지
        window.jumpToDate(state.currentEditingDate);
        
        // 타임라인 상단으로 스크롤하여 새로 추가된 항목이 트래커 아래에 보이도록
        setTimeout(() => {
            // 트래커 섹션과 헤더 높이 계산
            const trackerSection = document.getElementById('trackerSection');
            const trackerHeight = trackerSection ? trackerSection.offsetHeight : 0;
            const headerHeight = 73; // 헤더 높이 (top-[73px])
            const totalOffset = headerHeight + trackerHeight;
            
            // 날짜 섹션이 렌더링된 후 해당 섹션으로 스크롤 (트래커 높이만큼 오프셋)
            setTimeout(() => {
                const dateSection = document.getElementById(`date-${state.currentEditingDate}`);
                if (dateSection) {
                    // 섹션의 위치를 계산하여 트래커 아래에 보이도록 스크롤
                    const elementTop = dateSection.getBoundingClientRect().top + window.pageYOffset;
                    const offsetPosition = elementTop - totalOffset - 16; // 16px 여유 공간
                    window.scrollTo({ top: Math.max(0, offsetPosition), behavior: 'smooth' });
                    window.isScrolling = wasScrolling; // 원래 상태 복원
                } else {
                    // 섹션이 아직 렌더링되지 않았으면 다시 시도
                    setTimeout(() => {
                        const dateSection2 = document.getElementById(`date-${state.currentEditingDate}`);
                        if (dateSection2) {
                            const elementTop = dateSection2.getBoundingClientRect().top + window.pageYOffset;
                            const offsetPosition = elementTop - totalOffset - 16;
                            window.scrollTo({ top: Math.max(0, offsetPosition), behavior: 'smooth' });
                        }
                        window.isScrolling = wasScrolling; // 원래 상태 복원
                    }, 200);
                }
            }, 400);
        }, 200);
    } catch (e) {
        showToast("저장 실패", 'error');
    } finally {
        document.getElementById('loadingOverlay').classList.add('hidden');
        state.currentEditingId = null;
        state.currentPhotos = [];
    }
}

export async function deleteEntry() {
    const state = appState;
    if (state.currentEditingId) {
        await dbOps.delete(state.currentEditingId);
        window.closeModal();
    }
}

export function setRating(s) {
    appState.currentRating = s;
    const sts = document.getElementById('starContainer').children;
    for (let i = 0; i < 5; i++) {
        sts[i].className = i < s ? 'star-btn text-2xl text-yellow-400' : 'star-btn text-2xl text-slate-200';
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
        if (container.id === 'typeChips' && (value === 'Skip' || value === '???')) {
            document.getElementById('optionalFields')?.classList.remove('hidden');
            document.getElementById('reviewSection')?.classList.remove('hidden');
        }
    } else {
        btn.classList.add('active');
        if (inputId !== 'null') {
            const input = document.getElementById(inputId);
            if (input) input.value = value;
        }
        if (container.id === 'typeChips') {
            const isSkip = value === 'Skip' || value === '???';
            document.getElementById('optionalFields')?.classList.toggle('hidden', isSkip);
            document.getElementById('reviewSection')?.classList.toggle('hidden', isSkip);
        }
    }
    
    if (isPrimary && subTagKey && subContainerId) {
        const subTags = window.userSettings.subTags[subTagKey] || [];
        window.renderSecondary(subContainerId, subTags, 
            document.getElementById(subContainerId).getAttribute('data-input-id') || getInputIdFromContainer(subContainerId), 
            selectedValue, subTagKey);
    }
}

export function handleMultipleImages(e) {
    const state = appState;
    const maxPhotos = 5;
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
    ['mealType', 'withWhom', 'category', 'snackType'].forEach(k => renderTagManager(k, false, state.tempSettings));
    
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
    state.tempSettings.profile.nickname = document.getElementById('settingNickname').value;
    await dbOps.saveSettings(state.tempSettings);
    window.closeSettings();
    showToast("설정이 저장되었습니다.", 'success');
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



