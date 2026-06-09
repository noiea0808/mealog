/**
 * 사진 편집 모달 (식사 기록 / 프로필)
 * render.js(미리보기)와 순환 의존을 피하기 위해 저장 후 `renderPhotoPreviews` 는 동적 import 로 호출합니다.
 */
import { appState } from '../state.js';

// 사진 편집 관련 변수
let editingPhotoIndex = null;
let editingPhotoImage = null;
let photoEditCanvas = null;
let photoEditCtx = null;
let photoEditScale = 1;
let photoEditOffsetX = 0;
let photoEditOffsetY = 0;
let photoEditRotation = 0; // 회전 각도 (도 단위)
let isDraggingPhoto = false;
let dragStartX = 0;
let dragStartY = 0;
/** 드래그 시 화면 델타를 회전된 좌표계로 변환하기 위해 저장 */
let dragStartClientX = 0;
let dragStartClientY = 0;
let dragStartOffsetX = 0;
let dragStartOffsetY = 0;
let isPinching = false;
let initialPinchDistance = 0;
let initialPinchScale = 1;
/** 'meal' | 'dailyJournal' | 'profile' | null */
let photoEditContext = null;

function getPhotoEditContextPhotos() {
    if (photoEditContext === 'dailyJournal') return appState.dailyJournalPhotos;
    if (photoEditContext === 'meal') return appState.currentPhotos;
    return [];
}

function isRecordPhotoEditContext() {
    return photoEditContext === 'meal' || photoEditContext === 'dailyJournal';
}

async function refreshPhotoEditContextPreviews() {
    if (photoEditContext === 'dailyJournal') {
        const { renderDailyJournalPhotoPreviews } = await import('../modals/daily-journal.js');
        renderDailyJournalPhotoPreviews();
        return;
    }
    const { renderPhotoPreviews } = await import('../render.js');
    renderPhotoPreviews();
}
/** 프로필 편집 시 취소/닫기 시 revoke용 */
let profilePhotoEditObjectUrl = null;
/** 'modal' — 전역 사진 편집 모달 | 'avatar' — 프로필 아바타 팝업 안 인라인 */
let photoEditSurface = 'modal';

function getPhotoEditCanvasEl() {
    return photoEditSurface === 'avatar'
        ? document.getElementById('accountAvatarEditCanvas')
        : document.getElementById('photoEditCanvas');
}

function getPhotoEditContainerEl() {
    return photoEditSurface === 'avatar'
        ? document.getElementById('accountAvatarEditCanvasContainer')
        : document.getElementById('photoEditCanvasContainer');
}

function setAvatarModalInlineEditVisible(visible) {
    const staticV = document.getElementById('accountAvatarModalStaticView');
    const editV = document.getElementById('accountAvatarModalEditView');
    const pick = document.getElementById('accountAvatarModalFooterPick');
    const confirm = document.getElementById('accountAvatarModalFooterConfirm');
    if (staticV) staticV.classList.toggle('hidden', !!visible);
    if (editV) editV.classList.toggle('hidden', !visible);
    if (visible) {
        pick?.classList.add('hidden');
        confirm?.classList.add('hidden');
    }
}
/** 여러 장 이동 중 이중 실행 방지 */
let photoEditNavigating = false;

// 사진 편집 모달 열기 (식사 사진)
export function editPhoto(idx) {
    if (idx < 0 || idx >= appState.currentPhotos.length) return;
    
    photoEditContext = 'meal';
    profilePhotoEditObjectUrl = null;
    editingPhotoIndex = idx;
    const photoSrc = appState.currentPhotos[idx];
    
    openPhotoEditModalWithImage(photoSrc);
}

/** 하루 기록 모달 사진 편집 */
export function editDailyJournalPhoto(idx) {
    if (idx < 0 || idx >= appState.dailyJournalPhotos.length) return;

    photoEditContext = 'dailyJournal';
    profilePhotoEditObjectUrl = null;
    editingPhotoIndex = idx;
    openPhotoEditModalWithImage(appState.dailyJournalPhotos[idx]);
}

// 프로필 사진 편집 모달 열기 (사진 직접 등록 시)
export function openProfilePhotoEdit(objectUrl) {
    if (!objectUrl) return;
    photoEditContext = 'profile';
    profilePhotoEditObjectUrl = objectUrl;
    editingPhotoIndex = null;

    if (window.profilePhotoEditFromAvatarModal) {
        openAvatarInlinePhotoEdit(objectUrl);
    } else {
        photoEditSurface = 'modal';
        openPhotoEditModalWithImage(objectUrl);
    }
}

function openAvatarInlinePhotoEdit(photoSrc) {
    photoEditSurface = 'avatar';
    document.getElementById('photoEditModal')?.classList.add('hidden');
    setAvatarModalInlineEditVisible(true);
    photoEditCanvas = getPhotoEditCanvasEl();
    if (!photoEditCanvas) return;
    photoEditCtx = photoEditCanvas.getContext('2d');

    editingPhotoImage = new Image();
    const src = String(photoSrc || '');
    const isLocalLike = src.startsWith('data:') || src.startsWith('blob:');
    if (!isLocalLike) {
        editingPhotoImage.crossOrigin = 'anonymous';
    }
    editingPhotoImage.onload = () => {
        initializePhotoEdit();
    };
    editingPhotoImage.onerror = () => {
        if (typeof window.showToast === 'function') window.showToast('이미지를 불러올 수 없습니다.', 'error');
        closePhotoEditModal();
    };
    editingPhotoImage.src = photoSrc;
}

function getPhotoEditAspectRatioCss() {
    let ratio = '1:1';
    if (photoEditContext === 'profile') {
        ratio = '1:1';
    } else if (photoEditContext === 'dailyJournal') {
        ratio = appState.dailyJournalPhotoAspectRatio || '1:1';
    } else {
        ratio = appState.recordPhotoAspectRatio || '1:1';
    }
    if (ratio === '3:4') return '3/4';
    if (ratio === '4:3') return '4/3';
    return '1';
}

/** 기록 등록 화면·편집 화면 공통: 선택된 사진 비율의 CSS aspect-ratio 값 */
function getRecordPhotoAspectRatioCss() {
    const ratio = appState.recordPhotoAspectRatio || '1:1';
    if (ratio === '3:4') return '3/4';
    if (ratio === '4:3') return '4/3';
    return '1';
}

function openPhotoEditModalWithImage(photoSrc) {
    photoEditSurface = 'modal';
    const modal = document.getElementById('photoEditModal');
    if (!modal) return;

    const wrapper = document.getElementById('photoEditAspectWrapper');
    if (wrapper) wrapper.style.aspectRatio = getPhotoEditAspectRatioCss();

    modal.classList.remove('hidden');
    updatePhotoEditNavUI();

    photoEditCanvas = getPhotoEditCanvasEl();
    if (!photoEditCanvas) return;

    photoEditCtx = photoEditCanvas.getContext('2d');
    
    editingPhotoImage = new Image();
    // Firebase Storage 같은 외부 URL 편집 시 canvas taint로 저장 실패하는 케이스를 줄임
    const src = String(photoSrc || '');
    const isLocalLike = src.startsWith('data:') || src.startsWith('blob:');
    if (!isLocalLike) {
        editingPhotoImage.crossOrigin = 'anonymous';
    }
    editingPhotoImage.onload = () => {
        initializePhotoEdit();
    };
    editingPhotoImage.onerror = () => {
        if (typeof window.showToast === 'function') window.showToast('이미지를 불러올 수 없습니다.', 'error');
        closePhotoEditModal();
    };
    editingPhotoImage.src = photoSrc;
}

// 사진 편집 초기화
function initializePhotoEdit() {
    if (!photoEditCanvas || !photoEditCtx || !editingPhotoImage) return;

    const container = getPhotoEditContainerEl();
    if (!container) return;

    // 모달이 완전히 렌더링된 후 크기 계산
    setTimeout(() => {
        // 모달이 닫힌 경우(이미지 로드 중 사용자가 닫음) 스킵
        if (!photoEditCanvas || !photoEditCtx || !editingPhotoImage) return;
        const containerAgain = getPhotoEditContainerEl();
        if (!containerAgain) return;

        const containerRect = containerAgain.getBoundingClientRect();
        const containerWidth = containerRect.width || containerAgain.offsetWidth;
        const containerHeight = containerRect.height || containerAgain.offsetHeight;
        
        // Canvas 크기 설정
        photoEditCanvas.width = containerWidth;
        photoEditCanvas.height = containerHeight;
        containerAgain.style.touchAction = 'none';

        // 이미지 비율 계산
        const imgAspect = editingPhotoImage.width / editingPhotoImage.height;
        const containerAspect = containerWidth / containerHeight;
    
    let drawWidth, drawHeight;
    if (imgAspect > containerAspect) {
        // 이미지가 더 넓음 - 높이에 맞춤
        drawHeight = containerHeight;
        drawWidth = drawHeight * imgAspect;
    } else {
        // 이미지가 더 높음 - 너비에 맞춤
        drawWidth = containerWidth;
        drawHeight = drawWidth / imgAspect;
    }
    
    photoEditScale = drawWidth / editingPhotoImage.width;
    photoEditOffsetX = (containerWidth - drawWidth) / 2;
    photoEditOffsetY = (containerHeight - drawHeight) / 2;
    photoEditRotation = 0; // 초기 회전 각도
    
        // 초기 렌더링
        drawPhotoEdit();
        
        // 드래그 이벤트 추가
        setupPhotoEditDrag();
        
        // 줌 및 회전 이벤트 추가
        setupPhotoEditZoomAndRotate();
        updatePhotoEditNavUI();
    }, 100);
}

/**
 * 편집 미리보기와 동일한 줌·이동·회전으로 대상 캔버스에 그림.
 * 저장 시에도 이 경로를 써야 확대/위치가 결과 이미지와 일치한다.
 */
function drawPhotoEditToContext(ctx, width, height, backgroundColor) {
    if (!ctx || !editingPhotoImage) return;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = backgroundColor || '#f1f5f9';
    ctx.fillRect(0, 0, width, height);

    const drawWidth = editingPhotoImage.width * photoEditScale;
    const drawHeight = editingPhotoImage.height * photoEditScale;

    const useCenterX = drawWidth < width;
    const useCenterY = drawHeight < height;
    const drawOffsetX = useCenterX ? (width - drawWidth) / 2 : photoEditOffsetX;
    const drawOffsetY = useCenterY ? (height - drawHeight) / 2 : photoEditOffsetY;

    const centerX = width / 2;
    const centerY = height / 2;

    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate((photoEditRotation * Math.PI) / 180);
    ctx.translate(-centerX, -centerY);
    ctx.drawImage(editingPhotoImage, drawOffsetX, drawOffsetY, drawWidth, drawHeight);
    ctx.restore();
}

/** 미리보기(저해상도 캔버스)와 동일한 구도로, 저장·보내기용 고해상도 크기 계산 */
function getPhotoEditExportDimensions(logicalW, logicalH) {
    if (!logicalW || !logicalH || !editingPhotoImage) {
        return { outW: logicalW, outH: logicalH, scaleX: 1, scaleY: 1 };
    }
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
    const drawWidth = editingPhotoImage.width * photoEditScale;
    const drawHeight = editingPhotoImage.height * photoEditScale;
    // 확대 시 그려지는 이미지가 뷰포트보다 크면, 출력 픽셀을 키워 원본 샘플링이 거치지 않게 함
    const zoomBoost = Math.max(1, drawWidth / logicalW, drawHeight / logicalH);
    const MAX_EDGE = 4096;
    const maxByEdge = MAX_EDGE / Math.max(logicalW, logicalH, 1);
    let m = Math.min(4, Math.max(dpr, zoomBoost), maxByEdge);
    if (m < 1) m = 1;
    const outW = Math.max(1, Math.round(logicalW * m));
    const outH = Math.max(1, Math.round(logicalH * m));
    return { outW, outH, scaleX: outW / logicalW, scaleY: outH / logicalH };
}

/**
 * 편집 결과를 고해상도로 래스터화한 뒤 Blob 생성 (미리보기 캔버스 크기와 무관)
 * @param {'image/jpeg'|string} mime
 * @param {number} quality JPEG 품질
 */
function exportPhotoEditToBlob(mime = 'image/jpeg', quality = 0.92) {
    return new Promise((resolve, reject) => {
        if (!photoEditCanvas || !editingPhotoImage) {
            reject(new Error('no canvas'));
            return;
        }
        const logicalW = photoEditCanvas.width;
        const logicalH = photoEditCanvas.height;
        const { outW, outH, scaleX, scaleY } = getPhotoEditExportDimensions(logicalW, logicalH);
        const outputCanvas = document.createElement('canvas');
        outputCanvas.width = outW;
        outputCanvas.height = outH;
        const outputCtx = outputCanvas.getContext('2d');
        outputCtx.imageSmoothingEnabled = true;
        outputCtx.imageSmoothingQuality = 'high';
        outputCtx.scale(scaleX, scaleY);
        drawPhotoEditToContext(outputCtx, logicalW, logicalH, '#ffffff');
        outputCtx.setTransform(1, 0, 0, 1, 0, 0);
        outputCanvas.toBlob(
            (blob) => {
                if (!blob) reject(new Error('toBlob failed'));
                else resolve(blob);
            },
            mime,
            quality
        );
    });
}

// 사진 편집 화면 그리기
function drawPhotoEdit() {
    if (!photoEditCanvas || !photoEditCtx || !editingPhotoImage) return;
    drawPhotoEditToContext(photoEditCtx, photoEditCanvas.width, photoEditCanvas.height, '#f1f5f9');
}

// 사진 편집 드래그 설정
function setupPhotoEditDrag() {
    if (!photoEditCanvas) return;
    
    photoEditCanvas.style.cursor = 'grab';
    // 터치 드래그가 스크롤로 가로채지 않도록 (모바일)
    photoEditCanvas.style.touchAction = 'none';
    
    photoEditCanvas.addEventListener('mousedown', handlePhotoEditMouseDown);
    photoEditCanvas.addEventListener('mousemove', handlePhotoEditMouseMove);
    photoEditCanvas.addEventListener('mouseup', handlePhotoEditMouseUp);
    photoEditCanvas.addEventListener('mouseleave', handlePhotoEditMouseUp);
    
    // 터치 이벤트는 setupPhotoEditZoomAndRotate에서 통합 처리
}

/** 사진 편집 offset: 축소 시 중앙 정렬 강제, 확대 시 좌우/상하에 맞춰 클램프 (인스타 스타일) */
function clampPhotoEditOffset() {
    if (!photoEditCanvas || !editingPhotoImage) return;
    const drawWidth = editingPhotoImage.width * photoEditScale;
    const drawHeight = editingPhotoImage.height * photoEditScale;
    if (drawWidth < photoEditCanvas.width) {
        photoEditOffsetX = (photoEditCanvas.width - drawWidth) / 2;
    } else {
        const minX = Math.min(0, photoEditCanvas.width - drawWidth);
        const maxX = Math.max(0, photoEditCanvas.width - drawWidth);
        photoEditOffsetX = Math.min(maxX, Math.max(minX, photoEditOffsetX));
    }
    if (drawHeight < photoEditCanvas.height) {
        photoEditOffsetY = (photoEditCanvas.height - drawHeight) / 2;
    } else {
        const minY = Math.min(0, photoEditCanvas.height - drawHeight);
        const maxY = Math.max(0, photoEditCanvas.height - drawHeight);
        photoEditOffsetY = Math.min(maxY, Math.max(minY, photoEditOffsetY));
    }
}

/** 화면(캔버스) 좌표계의 이동량을 회전된 이미지 좌표계로 변환 (드래그 방향이 보이는 대로 동작하도록) */
function screenDeltaToRotatedOffset(dx, dy) {
    const rad = (photoEditRotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return {
        x: cos * dx + sin * dy,
        y: -sin * dx + cos * dy
    };
}

// 마우스 이벤트 핸들러
function handlePhotoEditMouseDown(e) {
    isDraggingPhoto = true;
    dragStartClientX = e.clientX;
    dragStartClientY = e.clientY;
    dragStartOffsetX = photoEditOffsetX;
    dragStartOffsetY = photoEditOffsetY;
    dragStartX = e.clientX - photoEditOffsetX;
    dragStartY = e.clientY - photoEditOffsetY;
    if (photoEditCanvas) {
        photoEditCanvas.style.cursor = 'grabbing';
    }
}

function handlePhotoEditMouseMove(e) {
    if (!isDraggingPhoto) return;
    
    const dx = e.clientX - dragStartClientX;
    const dy = e.clientY - dragStartClientY;
    const rotated = screenDeltaToRotatedOffset(dx, dy);
    photoEditOffsetX = dragStartOffsetX + rotated.x;
    photoEditOffsetY = dragStartOffsetY + rotated.y;
    
    // 경계 체크: 이미지가 화면보다 클 때는 빈 공간 없이, 작을 때는 자유롭게 이동 가능하도록 min/max로 클램프
    clampPhotoEditOffset();
    drawPhotoEdit();
}

function handlePhotoEditMouseUp() {
    isDraggingPhoto = false;
    if (photoEditCanvas) {
        photoEditCanvas.style.cursor = 'grab';
    }
}

// 터치 이벤트 핸들러
function handlePhotoEditTouchStart(e) {
    // 핀치 줌이면 드래그 무시
    if (e.touches.length === 2) {
        return;
    }
    e.preventDefault();
    const touch = e.touches[0];
    isDraggingPhoto = true;
    dragStartClientX = touch.clientX;
    dragStartClientY = touch.clientY;
    dragStartOffsetX = photoEditOffsetX;
    dragStartOffsetY = photoEditOffsetY;
    dragStartX = touch.clientX - photoEditOffsetX;
    dragStartY = touch.clientY - photoEditOffsetY;
}

function handlePhotoEditTouchMove(e) {
    // 핀치 줌이면 드래그 무시
    if (e.touches.length === 2 || isPinching) {
        return;
    }
    if (!isDraggingPhoto) return;
    e.preventDefault();
    
    const touch = e.touches[0];
    const dx = touch.clientX - dragStartClientX;
    const dy = touch.clientY - dragStartClientY;
    const rotated = screenDeltaToRotatedOffset(dx, dy);
    photoEditOffsetX = dragStartOffsetX + rotated.x;
    photoEditOffsetY = dragStartOffsetY + rotated.y;
    
    clampPhotoEditOffset();
    drawPhotoEdit();
}

function handlePhotoEditTouchEnd() {
    isDraggingPhoto = false;
    isPinching = false;
}

// 줌 및 회전 기능 설정
function setupPhotoEditZoomAndRotate() {
    if (!photoEditCanvas) return;
    
    // 휠 줌 (데스크톱)
    photoEditCanvas.addEventListener('wheel', handlePhotoEditWheel, { passive: false });
    
    // 터치 이벤트 (드래그 + 핀치 줌 통합) - capture로 터치 확실히 수신
    photoEditCanvas.addEventListener('touchstart', handlePhotoEditTouchStart, { passive: false, capture: true });
    photoEditCanvas.addEventListener('touchmove', handlePhotoEditTouchMove, { passive: false, capture: true });
    photoEditCanvas.addEventListener('touchend', handlePhotoEditTouchEnd, { capture: true });
    photoEditCanvas.addEventListener('touchcancel', handlePhotoEditTouchEnd, { capture: true });
}

// 휠 줌 핸들러
function handlePhotoEditWheel(e) {
    e.preventDefault();
    
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    const newScale = Math.max(0.1, Math.min(3, photoEditScale + delta));
    
    // 줌 중심점 계산
    const rect = photoEditCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // 줌 중심점 기준으로 스케일 조정
    const scaleChange = newScale / photoEditScale;
    photoEditOffsetX = x - (x - photoEditOffsetX) * scaleChange;
    photoEditOffsetY = y - (y - photoEditOffsetY) * scaleChange;
    
    photoEditScale = newScale;
    clampPhotoEditOffset();
    drawPhotoEdit();
}

// 줌인
export function zoomInPhotoEdit() {
    const newScale = Math.min(3, photoEditScale * 1.2);
    const centerX = photoEditCanvas.width / 2;
    const centerY = photoEditCanvas.height / 2;
    
    const scaleChange = newScale / photoEditScale;
    photoEditOffsetX = centerX - (centerX - photoEditOffsetX) * scaleChange;
    photoEditOffsetY = centerY - (centerY - photoEditOffsetY) * scaleChange;
    
    photoEditScale = newScale;
    clampPhotoEditOffset();
    drawPhotoEdit();
}

// 줌아웃 (최소 0.1 — 초기 fit 스케일이 0.5 미만일 수 있어 축소 버튼이 확대되던 문제 수정)
export function zoomOutPhotoEdit() {
    const newScale = Math.max(0.1, photoEditScale / 1.2);
    const centerX = photoEditCanvas.width / 2;
    const centerY = photoEditCanvas.height / 2;
    
    const scaleChange = newScale / photoEditScale;
    photoEditOffsetX = centerX - (centerX - photoEditOffsetX) * scaleChange;
    photoEditOffsetY = centerY - (centerY - photoEditOffsetY) * scaleChange;
    
    photoEditScale = newScale;
    clampPhotoEditOffset();
    drawPhotoEdit();
}

// 회전 (90도씩)
export function rotatePhotoEdit() {
    photoEditRotation = (photoEditRotation + 90) % 360;
    drawPhotoEdit();
}

// 사진 편집 초기화 (리셋)
export function resetPhotoEdit() {
    if (!editingPhotoImage) return;

    const container = getPhotoEditContainerEl();
    if (!container) return;
    
    const containerRect = container.getBoundingClientRect();
    const containerWidth = containerRect.width;
    const containerHeight = containerRect.height;
    
    const imgAspect = editingPhotoImage.width / editingPhotoImage.height;
    const containerAspect = containerWidth / containerHeight;
    
    let drawWidth, drawHeight;
    if (imgAspect > containerAspect) {
        drawHeight = containerHeight;
        drawWidth = drawHeight * imgAspect;
    } else {
        drawWidth = containerWidth;
        drawHeight = drawWidth / imgAspect;
    }
    
    photoEditScale = drawWidth / editingPhotoImage.width;
    photoEditOffsetX = (containerWidth - drawWidth) / 2;
    photoEditOffsetY = (containerHeight - drawHeight) / 2;
    photoEditRotation = 0;
    
    drawPhotoEdit();
}

function detachPhotoEditCanvasListeners() {
    if (!photoEditCanvas) return;
    photoEditCanvas.removeEventListener('mousedown', handlePhotoEditMouseDown);
    photoEditCanvas.removeEventListener('mousemove', handlePhotoEditMouseMove);
    photoEditCanvas.removeEventListener('mouseup', handlePhotoEditMouseUp);
    photoEditCanvas.removeEventListener('mouseleave', handlePhotoEditMouseUp);
    photoEditCanvas.removeEventListener('touchstart', handlePhotoEditTouchStart, true);
    photoEditCanvas.removeEventListener('touchmove', handlePhotoEditTouchMove, true);
    photoEditCanvas.removeEventListener('touchend', handlePhotoEditTouchEnd, true);
    photoEditCanvas.removeEventListener('touchcancel', handlePhotoEditTouchEnd, true);
    photoEditCanvas.removeEventListener('wheel', handlePhotoEditWheel);
}

/** 편집 결과를 고해상도 JPEG data URL로 내보냄 (식사 저장·장 간 이동 시 공통) */
function exportPhotoEditCanvasToDataUrl() {
    return exportPhotoEditToBlob('image/jpeg', 0.92).then(
        (blob) =>
            new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(new Error('read failed'));
                reader.readAsDataURL(blob);
            })
    );
}

function updatePhotoEditNavUI() {
    const row = document.getElementById('photoEditNavRow');
    const label = document.getElementById('photoEditNavLabel');
    const prev = document.getElementById('photoEditPrevBtn');
    const next = document.getElementById('photoEditNextBtn');
    if (!row || !label || !prev || !next) return;
    const photos = getPhotoEditContextPhotos();
    const len = photos.length;
    const show = isRecordPhotoEditContext() && len > 1 && editingPhotoIndex !== null;
    row.classList.toggle('hidden', !show);
    if (!show) return;
    label.textContent = `${editingPhotoIndex + 1} / ${len}`;
    prev.disabled = editingPhotoIndex <= 0;
    next.disabled = editingPhotoIndex >= len - 1;
}

async function switchRecordPhotoEditToIndex(newIndex) {
    if (!isRecordPhotoEditContext() || editingPhotoIndex === null) return;
    const photos = getPhotoEditContextPhotos();
    const len = photos.length;
    if (newIndex < 0 || newIndex >= len || newIndex === editingPhotoIndex) return;
    if (!photoEditCanvas || !photoEditCtx || !editingPhotoImage) return;

    let dataUrl;
    try {
        dataUrl = await exportPhotoEditCanvasToDataUrl();
    } catch (e) {
        console.error('사진 편집 내보내기 실패:', e);
        if (typeof window.showToast === 'function') {
            window.showToast('사진을 저장할 수 없습니다. 다시 시도해주세요.', 'error');
        }
        return;
    }

    photos[editingPhotoIndex] = dataUrl;
    await refreshPhotoEditContextPreviews();

    detachPhotoEditCanvasListeners();
    editingPhotoIndex = newIndex;
    updatePhotoEditNavUI();
    const photoSrc = photos[newIndex];

    editingPhotoImage = new Image();
    const src = String(photoSrc || '');
    const isLocalLike = src.startsWith('data:') || src.startsWith('blob:');
    if (!isLocalLike) {
        editingPhotoImage.crossOrigin = 'anonymous';
    }
    editingPhotoImage.onload = () => {
        initializePhotoEdit();
    };
    editingPhotoImage.onerror = () => {
        if (typeof window.showToast === 'function') window.showToast('이미지를 불러올 수 없습니다.', 'error');
        closePhotoEditModal();
    };
    editingPhotoImage.src = photoSrc;
}

export async function goToPrevPhotoEdit() {
    if (photoEditNavigating) return;
    if (!isRecordPhotoEditContext() || editingPhotoIndex === null || editingPhotoIndex <= 0) return;
    photoEditNavigating = true;
    try {
        await switchRecordPhotoEditToIndex(editingPhotoIndex - 1);
    } finally {
        photoEditNavigating = false;
    }
}

export async function goToNextPhotoEdit() {
    if (photoEditNavigating) return;
    if (!isRecordPhotoEditContext() || editingPhotoIndex === null) return;
    const len = getPhotoEditContextPhotos().length;
    if (editingPhotoIndex >= len - 1) return;
    photoEditNavigating = true;
    try {
        await switchRecordPhotoEditToIndex(editingPhotoIndex + 1);
    } finally {
        photoEditNavigating = false;
    }
}

// 사진 편집 저장 — 구도는 미리보기와 동일, 출력은 DPR·줌에 맞춰 고해상도 래스터화
export function savePhotoEdit() {
    if (!photoEditCanvas || !editingPhotoImage) return;

    try {
        if (photoEditContext === 'profile') {
            exportPhotoEditToBlob('image/jpeg', 0.92)
                .then((blob) => {
                    window.settingsPhotoFile = blob;
                    window.settingsPhotoUrl = URL.createObjectURL(blob);
                    if (profilePhotoEditObjectUrl) {
                        URL.revokeObjectURL(profilePhotoEditObjectUrl);
                        profilePhotoEditObjectUrl = null;
                    }
                    const photoPreview = document.getElementById('photoPreview');
                    const photoDeleteBtn = document.getElementById('photoDeleteBtn');
                    if (photoPreview) {
                        photoPreview.style.backgroundImage = `url(${window.settingsPhotoUrl})`;
                        photoPreview.style.backgroundSize = 'cover';
                        photoPreview.style.backgroundPosition = 'center';
                        photoPreview.innerHTML = '';
                        if (photoDeleteBtn) {
                            photoDeleteBtn.classList.toggle(
                                'hidden',
                                !appState.isProfileEditing || appState.profileEditScope !== 'full'
                            );
                        }
                    }
                    if (typeof window.setSettingsProfileType === 'function') {
                        window.setSettingsProfileType('photo');
                    }
                    if (typeof window.renderSettingsProfileAvatarPreview === 'function') {
                        window.renderSettingsProfileAvatarPreview();
                    }
                    window.__profilePhotoEditSaved = true;
                    closePhotoEditModal();
                    if (typeof window.showToast === 'function' && !window.profilePhotoEditFromAvatarModal) {
                        window.showToast('사진이 적용되었습니다.', 'success');
                    }
                })
                .catch(() => {
                    if (typeof window.showToast === 'function') {
                        window.showToast('사진 저장에 실패했습니다. 다시 시도해주세요.', 'error');
                    }
                });
            return;
        }

        if (editingPhotoIndex === null || !isRecordPhotoEditContext()) return;
        exportPhotoEditCanvasToDataUrl()
            .then(async (dataUrl) => {
                const photos = getPhotoEditContextPhotos();
                photos[editingPhotoIndex] = dataUrl;
                await refreshPhotoEditContextPreviews();
                closePhotoEditModal();
            })
            .catch((e) => {
                console.error('사진 편집 저장 실패:', e);
                if (typeof window.showToast === 'function') {
                    window.showToast('사진 저장에 실패했습니다. 다시 시도해주세요.', 'error');
                }
            });
    } catch (e) {
        console.error('사진 편집 저장 실패:', e);
        if (typeof window.showToast === 'function') {
            window.showToast('사진 저장 중 오류가 발생했습니다.', 'error');
        }
    }
}

// 사진 편집 모달 닫기
export function closePhotoEditModal() {
    const modal = document.getElementById('photoEditModal');
    const ctx = photoEditContext;
    const surface = photoEditSurface;
    const savedFromEdit = window.__profilePhotoEditSaved === true;
    window.__profilePhotoEditSaved = false;

    if (modal && surface === 'modal') {
        modal.classList.add('hidden');
    }

    detachPhotoEditCanvasListeners();

    if (ctx === 'profile') {
        if (profilePhotoEditObjectUrl) {
            URL.revokeObjectURL(profilePhotoEditObjectUrl);
            profilePhotoEditObjectUrl = null;
        }
        const photoInput = document.getElementById('photoInput');
        if (photoInput) photoInput.value = '';
    }

    if (surface === 'avatar') {
        setAvatarModalInlineEditVisible(false);
    }

    editingPhotoIndex = null;
    editingPhotoImage = null;
    photoEditCanvas = null;
    photoEditCtx = null;
    photoEditScale = 1;
    photoEditOffsetX = 0;
    photoEditOffsetY = 0;
    photoEditRotation = 0;
    isPinching = false;
    isDraggingPhoto = false;
    photoEditContext = null;
    photoEditSurface = 'modal';

    if (ctx === 'profile' && typeof window.notifyProfilePhotoEditClosed === 'function') {
        window.notifyProfilePhotoEditClosed(savedFromEdit);
    }
}

// 전역 함수로 노출
window.editPhoto = editPhoto;
window.editDailyJournalPhoto = editDailyJournalPhoto;
window.openProfilePhotoEdit = openProfilePhotoEdit;
window.closePhotoEditModal = closePhotoEditModal;
window.resetPhotoEdit = resetPhotoEdit;
window.savePhotoEdit = savePhotoEdit;
window.zoomInPhotoEdit = zoomInPhotoEdit;
window.zoomOutPhotoEdit = zoomOutPhotoEdit;
window.rotatePhotoEdit = rotatePhotoEdit;
window.goToPrevPhotoEdit = goToPrevPhotoEdit;
window.goToNextPhotoEdit = goToNextPhotoEdit;

