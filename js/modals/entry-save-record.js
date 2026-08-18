/**
 * 기록 저장 payload 조립 — 상태·DOM → Firestore record 객체 + 공유 스냅샷
 * 부수효과 없음. 낙관 반영·서버 저장은 호출부(saveEntry)가 담당한다.
 */
import { syncPhotoMetaLength } from '../photo-meta.js';
import { PHOTO_ASPECT_OPTIONS } from './entry-form-config.js';
import { getEntryCategorySuggestResult } from './entry-category-suggest.js';
import { getEntryContextPredictResult } from './entry-context-predict.js';
import { placeTypeFromKakaoCategory } from '../utils/place-type.js';

/** 아직 Storage에 없는 로컬 이미지(data URL 또는 일부 환경의 blob URL) */
export function isLocalPendingPhoto(photo) {
    return (
        typeof photo === 'string' &&
        Boolean(photo) &&
        (photo.startsWith('data:image') || photo.startsWith('blob:'))
    );
}

/**
 * 기록 시트 입력을 Firestore에 저장할 record 객체로 조립한다.
 *
 * @param {object} args
 * @param {object} args.state appState
 * @param {import('./entry-form-state.js').EntryFormValues} args.form
 * @param {ReturnType<import('./entry-form-state.js').resolveEntrySaveFields>} args.resolved
 * @param {'meal'|'snack'} args.entryMode
 * @param {{ rateOn: boolean, satOn: boolean, timeOn: boolean, normalizedClock: string }} args.gauges
 * @param {any[]} args.mealHistory window.mealHistory
 * @returns {{ record: object, sourcePhotos: string[], sourcePhotoMeta: {takenAt: string|null}[], existingPhotoUrls: string[] }}
 */
export function buildEntrySaveRecord({ state, form, resolved, entryMode, gauges, mealHistory }) {
    const isS = entryMode === 'snack';
    const {
        isSkip: isSk,
        mealTypeResolved,
        categoryResolved,
        withWhomResolved,
        snackTypeResolved,
        snackPlaceMainResolved,
    } = resolved;
    const { rateOn, satOn, timeOn, normalizedClock } = gauges;

    const entryWhereInputVal = form.placeInput;
    const menuInputVal = form.whatInput;
    const withInputVal = form.withInput;
    const mealType = form.axis1Chip;

    const deliveryVendorEl = document.getElementById('deliveryVendorInput');
    const deliveryVendorVal = (!isS && !isSk && mealType === '배달/포장' && deliveryVendorEl)
        ? form.deliveryVendor
        : '';

    // main 끼니: 동일 (date, slotId)에 이미 기록이 있어도 신규 문서로 추가 (다건 표시)
    const idToUse = state.currentEditingId;
    // 기존 기록에서 shareBanned 필드 가져오기 (수정 시 유지)
    const existingRecord = idToUse ? (mealHistory || []).find(m => m.id === idToUse) : null;
    const shareBanned = existingRecord?.shareBanned === true;

    // 카카오맵 API로 입력된 장소 정보 확인 (식사: entryWhereInput, 간식: entryWhereInput)
    const kakaoSourceInput = document.getElementById('entryWhereInput');
    const kakaoPlaceId = kakaoSourceInput?.getAttribute('data-kakao-place-id');
    const kakaoPlaceAddress = kakaoSourceInput?.getAttribute('data-kakao-place-address');
    const kakaoPlaceData = kakaoSourceInput?.getAttribute('data-kakao-place-data');
    const kakaoPlaceName = kakaoSourceInput?.getAttribute('data-kakao-place-name') || '';
    const placeValForKakao = entryWhereInputVal;
    // 카카오에서 선택한 장소명을 수정한 경우: 주소·placeId를 저장하지 않음 (잘못된 주소 매칭 방지)
    const nameMatches = !kakaoPlaceName || (String(placeValForKakao || '').trim() === String(kakaoPlaceName).trim());
    const shouldUseKakaoFields = kakaoPlaceId && !isSk && nameMatches;

    let shouldUseDeliveryKakao = false;
    let deliveryKakaoPlaceId = '';
    let deliveryKakaoPlaceAddress = '';
    let deliveryKakaoPlaceDataStr = '';
    if (!isS && !isSk && mealType === '배달/포장' && deliveryVendorEl) {
        const dvId = deliveryVendorEl.getAttribute('data-kakao-place-id');
        const dvName = deliveryVendorEl.getAttribute('data-kakao-place-name') || '';
        const dvNameMatches = !dvName || (String(deliveryVendorVal || '').trim() === String(dvName).trim());
        if (dvId && dvNameMatches) {
            shouldUseDeliveryKakao = true;
            deliveryKakaoPlaceId = dvId;
            deliveryKakaoPlaceAddress = deliveryVendorEl.getAttribute('data-kakao-place-address') || '';
            deliveryKakaoPlaceDataStr = deliveryVendorEl.getAttribute('data-kakao-place-data') || '';
        }
    }

    const sourcePhotos = Array.isArray(state.currentPhotos) ? [...state.currentPhotos] : [];
    const sourcePhotoMeta = syncPhotoMetaLength(state.currentPhotoMeta, sourcePhotos.length);
    const existingPhotoUrls = sourcePhotos.filter(
        (photo) => typeof photo === 'string' && photo && !isLocalPendingPhoto(photo)
    );

    /** getMealClock24FromModal(isMain) — 간식이 아닐 때 본식 입력, 간식일 때 간식 입력을 읽음 */
    const mealClockVal = !isSk && timeOn ? (normalizedClock || null) : null;
    const nowLocaleTime = () =>
        new Date().toLocaleTimeString('ko-KR', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    let timeSortStr = nowLocaleTime();
    if (!isSk && timeOn && normalizedClock) {
        timeSortStr = `${normalizedClock}:00`;
    }
    const slotChanged = Boolean(
        idToUse && existingRecord && existingRecord.slotId !== state.currentEditingSlotId
    );
    const dateChanged = Boolean(
        idToUse && existingRecord && existingRecord.date !== state.currentEditingDate
    );

    /**
     * 카테고리 자동 분류 (docs/food-category-auto-classification.md §2)
     * - 칩 직접 선택 or 제안 확정 → category, source='user'
     * - 제안 무시하고 저장 → categoryAuto, source='local' (사실-유도라 자동 기록 OK)
     * - 제안 거부(✕) → 모두 빈 값, source='dismissed' (서버 backfill도 건너뜀)
     * - 제안 없음 → 모두 빈 값, source=null (서버 backfill 대상)
     * 분류기는 동기·no-throw — 이 블록은 저장 경로에 fallible한 단계를 더하지 않는다.
     */
    let categoryFinal = categoryResolved;
    let snackTypeFinal = snackTypeResolved;
    let categoryAuto = '';
    let categorySource = null;
    /**
     * 분류기가 뭐라고 했는지 — **사용자가 다른 값으로 고쳤어도** 남긴다.
     *
     * 예전에는 확정하는 순간 categoryAuto 가 비어서 "제안이 틀렸다"는 사실이 흔적 없이
     * 사라졌다. 맞힌 경우(source='local')만 데이터에 남으니 교정률을 계산할 방법이 없었다.
     * category ≠ categorySuggested 인 기록 수가 곧 오분류다.
     *
     * 읽기 계층은 category/snackType 을 먼저 보므로(js/analytics/meal-analytics-tags.js)
     * 이 필드가 채워져도 집계에는 영향이 없다.
     */
    let categorySuggested = '';
    /**
     * 요리 종류(한식·중식…)는 음식 이름에서 도출되는 사실이라 사용자에게 묻지 않고
     * 자동 저장한다 (placeType 과 같은 사실-유도). 형태 축(category)과 짝을 이뤄
     * "면을 얼마나 먹나"와 "중식을 얼마나 먹나"를 둘 다 답할 수 있게 한다.
     */
    let cuisineAuto = '';
    if (!isSk) {
        const suggest = getEntryCategorySuggestResult();
        cuisineAuto = suggest.cuisine || '';
        categorySuggested = suggest.top || '';
        // 끼니는 category, 간식은 snackType — 같은 자동 분류 필드 쌍을 공유한다
        const userPicked = isS ? snackTypeFinal : categoryFinal;
        if (userPicked) {
            categorySource = 'user';
        } else if (suggest.confirmed) {
            if (isS) snackTypeFinal = suggest.confirmed;
            else categoryFinal = suggest.confirmed;
            categorySource = 'user';
        } else if (suggest.dismissed) {
            categorySource = 'dismissed';
        } else if (suggest.top) {
            categoryAuto = suggest.top;
            categorySource = 'local';
        }
    }

    /**
     * 어떻게·어디서·누구와 예측 "맞아요" 병합 (docs/entry-sheet-redesign.md §2 2층).
     * 확정값은 사용자가 명시적으로 탭한 것만 존재한다 — 탭 없이는 항상 빈 값.
     * 칩이 렌더돼 있으면 apply 시 이미 chip.click()으로 반영됐고(resolved 값이 채워짐),
     * 칩이 접혀 있던 경우만 여기서 병합된다. (place는 input 값으로 흐르므로 병합 불필요)
     */
    /**
     * 맥락 줄 병합 — 자동 적용 모델 (docs/entry-axes-and-tags-direction.md §5).
     * 추측(점선)도 저장 시 그대로 적용된다. 대신 자동 적용된 필드명을 autoContext에
     * 남겨 사용자 입력과 구분한다 — 예측 표본 제외(자기강화 루프 차단)와
     * 교정률 측정의 근거. categoryAuto/categorySource와 같은 원칙의 확장이다.
     *
     * '기타'도 덮어쓴다 — resolveEntrySaveFields는 칩이 비어 있는데 다른 축에 값이 있으면
     * mealType·withWhom을 '기타'로 채우는데, 빠른입력이 꺼져 있으면 칩 자체가
     * 렌더되지 않아(entry-chips.js) 맥락 줄 값이 그 폴백에 가려진다.
     * withWhom은 간식에도 있는 필드라 두 모드 모두 병합하고, mealType(어떻게)은 끼니 전용.
     */
    let withWhomFinal = withWhomResolved;
    let mealTypeFinal = mealTypeResolved;
    const autoContext = [];
    const ctxResult = isSk ? null : getEntryContextPredictResult();
    if (ctxResult) {
        const isFallback = (v) => !(v || '').trim() || v === '기타';
        if (ctxResult.withWhom.value && isFallback(withWhomFinal)) {
            withWhomFinal = ctxResult.withWhom.value;
            if (ctxResult.withWhom.source === 'auto') autoContext.push('withWhom');
        }
        if (!isS && ctxResult.mealType.value && isFallback(mealTypeFinal)) {
            mealTypeFinal = ctxResult.mealType.value;
            if (ctxResult.mealType.source === 'auto') autoContext.push('mealType');
        }
    }

    const record = {
        id: idToUse,
        date: state.currentEditingDate,
        slotId: state.currentEditingSlotId,
        mealType: mealTypeFinal,
        withWhom: withWhomFinal,
        withWhomDetail: isSk ? '' : withInputVal,
        category: categoryFinal,
        categoryAuto,
        categorySuggested,
        categorySource,
        cuisineAuto,
        placeType: '',
        snackType: snackTypeFinal,
        photoAspectRatio: state.recordPhotoAspectRatio || '1:1',
        // Firestore에는 URL만 저장하고, base64는 저장 직후 Storage로 업로드 후 치환한다.
        photos: existingPhotoUrls,
        photoMeta: sourcePhotoMeta,
        menuDetail: isSk ? '' : menuInputVal,
        place: isSk ? '' : (isS ? (entryWhereInputVal || state.selectedSnackPlaceMainTag || '') : entryWhereInputVal),
        comment: isSk ? '' : (isS ? (document.getElementById('snackCommentInput')?.value || '') : (document.getElementById('generalCommentInput')?.value || '')),
        rating: isSk ? null : (rateOn && state.currentRating != null && Number(state.currentRating) > 0 ? Number(state.currentRating) : null),
        satiety: isSk ? null : (satOn && state.currentSatiety != null && Number(state.currentSatiety) > 0 ? Number(state.currentSatiety) : null),
        mealClock: mealClockVal,
        // 분 단위만 쓰면 같은 슬롯·같은 분 간식이 정렬·뒷번호(간식1,2…)에서 뒤섞일 수 있어 초 포함
        time: timeSortStr,
    };
    /**
     * 수정 시각. 아웃박스가 며칠씩 버틸 수 있게 되면서 새로 필요해졌다 —
     * 오래된 큐 항목이 다른 기기의 최신 수정을 덮어쓰지 않도록, 워커가 밀어 올리기 직전
     * 서버본과 이 값을 비교한다 (docs/sync-outbox-design.md §4.5).
     *
     * recordedAt 은 생성 시각이라 대용할 수 없다(슬롯·날짜 변경 시에만 갱신된다).
     * 기존 문서에는 이 필드가 없으므로 워커가 recordedAt 으로 폴백한다.
     */
    /**
     * 어디서 자동 적용 — 사용자가 피커에서 직접 고른 place는 입력란(writeThrough)을 거쳐
     * 위에서 이미 record.place에 들어왔다. 여기 오는 것은 **적용만 되고 입력란에는
     * 안 쓴 추측**뿐이다 (추측은 사용자 입력란을 건드리지 않는다는 원칙).
     */
    if (ctxResult && !record.place && ctxResult.place.value) {
        record.place = ctxResult.place.value;
        if (ctxResult.place.source === 'auto') autoContext.push('place');
    }
    if (autoContext.length > 0) {
        record.autoContext = autoContext;
    }

    record.updatedAt = new Date().toISOString();
    if (!idToUse) {
        record.recordedAt = new Date().toISOString();
    } else if (slotChanged || dateChanged) {
        // 슬롯·날짜 변경 시 해당 슬롯에서 뒷번호(맨 뒤)로 쌓이도록 기록 시각 갱신
        record.recordedAt = new Date().toISOString();
    } else if (existingRecord?.recordedAt) {
        record.recordedAt = existingRecord.recordedAt;
    }
    if (isS && !isSk && snackPlaceMainResolved) {
        record.snackPlaceMain = snackPlaceMainResolved;
    }

    if (!isS && !isSk && mealType === '배달/포장') {
        record.deliveryVendor = deliveryVendorVal;
        if (shouldUseDeliveryKakao) {
            record.deliveryPlaceId = deliveryKakaoPlaceId;
            record.deliveryPlaceAddress = deliveryKakaoPlaceAddress || '';
            record.deliveryKakaoPlace = true;
            if (deliveryKakaoPlaceDataStr) {
                try {
                    record.deliveryPlaceData = JSON.parse(deliveryKakaoPlaceDataStr);
                } catch (_) {
                    record.deliveryPlaceData = null;
                }
            } else {
                record.deliveryPlaceData = null;
            }
        } else {
            record.deliveryPlaceId = '';
            record.deliveryPlaceAddress = '';
            record.deliveryPlaceData = null;
            record.deliveryKakaoPlace = false;
        }
    } else {
        record.deliveryVendor = '';
        record.deliveryPlaceId = '';
        record.deliveryPlaceAddress = '';
        record.deliveryPlaceData = null;
        record.deliveryKakaoPlace = false;
    }

    // 카카오맵 API로 입력된 식당인 경우 추가 정보 저장 (선택한 장소명을 수정한 경우는 제외 → 잘못된 주소 매칭 방지)
    if (shouldUseKakaoFields) {
        record.placeId = kakaoPlaceId;
        record.kakaoPlaceId = kakaoPlaceId;
        record.placeAddress = kakaoPlaceAddress || '';
        if (kakaoPlaceData) {
            try {
                record.placeData = JSON.parse(kakaoPlaceData);
                /**
                 * placeType 파생 (식당/카페/편의점/술집) — 사용자가 고른 장소의 객관 속성이라
                 * 사실-유도로 자동 저장한다. 어디서 통계의 집계 축이 상호명 파편 대신
                 * 이 카테고리가 되는 것이 목적 (docs/entry-axes-and-tags-direction.md §5).
                 * 판정 불가는 빈 문자열 그대로 — 기존 스키마의 예약 필드를 채우는 것뿐이다.
                 */
                record.placeType = placeTypeFromKakaoCategory(
                    record.placeData?.categoryGroupCode,
                    record.placeData?.category
                );
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

    return { record, sourcePhotos, sourcePhotoMeta, existingPhotoUrls };
}

/**
 * 공유 관련 비교 기준을 모달이 닫히기 전에 스냅샷으로 고정한다.
 * closeModal()이 originalSharedPhotos를 비우므로 여기서 값을 떠 둬야 한다.
 *
 * @param {object} args
 * @param {object} args.state appState
 * @param {object} args.record buildEntrySaveRecord가 만든 record
 * @param {string[]} args.existingPhotoUrls
 * @param {any[]} args.mealHistory window.mealHistory
 * @returns {{ isShareBanned: boolean, wantsToShare: boolean, photosToShare: string[], originalShareList: string[], hadSharedPhotos: boolean, photoAspectChanged: boolean }}
 */
export function buildEntryShareSnapshot({ state, record, existingPhotoUrls, mealHistory }) {
    // 공유 금지 체크
    const isShareBanned = record.id
        ? (mealHistory || []).find(m => m.id === record.id)?.shareBanned === true
        : false;

    // 상태 초기화 전에 공유 의사를 보존한다. (수정 저장 + 사진 업로드 시 필요)
    const wantsToShare = Boolean(state.wantsToShare);

    // 공유할 사진 목록 결정 (단순화: wantsToShare와 currentPhotos만 사용)
    const photosToShare = (!isShareBanned && wantsToShare && existingPhotoUrls.length > 0)
        ? [...existingPhotoUrls]    // 공유 활성화: 현재 URL 사진 전체
        : [];                        // 공유 비활성화 또는 금지: 빈 배열
    // sharedPhotos 필드는 sharedPhotos 컬렉션(서버 sharePhotos)이 canonical — meal save에 포함하지 않음
    const originalShareList = Array.isArray(state.originalSharedPhotos) ? [...state.originalSharedPhotos] : [];
    const hadSharedPhotos = originalShareList.length > 0;
    const originalPhotoAspect =
        state.originalPhotoAspectRatio && PHOTO_ASPECT_OPTIONS.includes(state.originalPhotoAspectRatio)
            ? state.originalPhotoAspectRatio
            : '1:1';
    const nextPhotoAspect =
        record.photoAspectRatio && PHOTO_ASPECT_OPTIONS.includes(record.photoAspectRatio)
            ? record.photoAspectRatio
            : '1:1';
    const photoAspectChanged = originalPhotoAspect !== nextPhotoAspect;

    return {
        isShareBanned,
        wantsToShare,
        photosToShare,
        originalShareList,
        hadSharedPhotos,
        photoAspectChanged,
    };
}
