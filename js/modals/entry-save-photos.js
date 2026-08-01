/**
 * 기록 저장 사진 단계 — 로컬(base64/blob) 사진 Storage 업로드 + https URL로 재저장
 * 실패를 내부에서 삼키고 결과 플래그로 알린다. 타임아웃·UI 복구는 호출부(saveEntry)가 담당.
 */
import { uploadMealPhotoVariants } from '../utils.js';
import { dbOps, unwrapMealSaveResult } from '../db.js';
import {
    markMealEntrySaveFailedById,
    onMealDocFirestoreServerAcknowledged,
} from '../utils/meal-entry-pending.js';
import { showToast } from '../ui.js';
import { getUserFacingErrorMessage } from '../utils/user-facing-error.js';
import { isLocalPendingPhoto } from './entry-save-record.js';

/** blob: URL을 Storage 업로드 가능한 data URL로 변환 (data:image·https는 그대로) */
export async function ensureDataUrlForStorage(photo) {
    if (typeof photo !== 'string' || !photo) return photo;
    if (photo.startsWith('data:image')) return photo;
    if (photo.startsWith('blob:')) {
        const blob = await (await fetch(photo)).blob();
        return await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(new Error('blob 이미지 읽기 실패'));
            r.readAsDataURL(blob);
        });
    }
    return photo;
}

/** 업로드 직후 첫 사진을 미리 받아 타임라인 깜빡임을 줄임 (실패해도 무시) */
function preloadImage(url, timeoutMs = 1500) {
    return new Promise((resolve) => {
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
}

/**
 * base64/blob 사진을 Storage에 올리고 record.photos를 https URL로 치환한 뒤 재저장한다.
 * record는 그 자리에서 변경된다(photos·photoMeta·photoDisplayUrls·photoThumbUrls).
 * 업로드 실패 시에도 throw하지 않고 base64 원본을 유지한 채 재저장을 시도한다 —
 * 네트워크 복구 후 재전송할 수 있도록.
 *
 * @param {object} args
 * @param {object} args.record buildEntrySaveRecord가 만든 record (in-place 변경됨)
 * @param {string[]} args.base64Photos 업로드 대상 로컬 사진
 * @param {string[]} args.sourcePhotos 시트에 있던 전체 사진(순서 유지용)
 * @param {{takenAt: string|null}[]} args.sourcePhotoMeta
 * @param {string[]} args.existingPhotoUrls 이미 Storage에 있던 URL (실패 시 폴백)
 * @param {boolean} args.isShareBanned
 * @param {boolean} args.wantsToShare
 * @param {string[]} args.photosToShare 현재 공유 대상 (실패 시 폴백 기준)
 * @param {string|null} args.optimisticTempId
 * @param {string} args.uid window.currentUser.uid
 * @returns {Promise<{ photoUploadPhaseFailed: boolean, photoPhaseSavedViaCallable: boolean, photosToShare: string[] }>}
 */
export async function uploadEntryPhotosAndResave({
    record,
    base64Photos,
    sourcePhotos,
    sourcePhotoMeta,
    existingPhotoUrls,
    isShareBanned,
    wantsToShare,
    photosToShare,
    optimisticTempId,
    uid,
}) {
    let photoUploadPhaseFailed = false;
    let photoPhaseSavedViaCallable = false;
    let nextPhotosToShare = photosToShare;

    try {
        const dataUrlsForUpload = await Promise.all(
            base64Photos.map((photo) => ensureDataUrlForStorage(photo))
        );
        // 신규 업로드: 원본 + 표시용(800px) + 썸네일(200px) 파생본 동시 생성. 파생본은 best-effort.
        const uploadedVariants = await Promise.all(
            dataUrlsForUpload.map((photo) =>
                uploadMealPhotoVariants(photo, uid, record.id)
            )
        );
        let uploadedIndex = 0;
        let metaIndex = 0;
        const finalPhotoUrls = [];
        const finalPhotoMeta = [];
        // photos와 index 정렬 유지. 기존 URL(수정 건)은 파생본 미상 → '' (원본 fallback)
        const finalDisplayUrls = [];
        const finalThumbUrls = [];
        sourcePhotos.forEach((photo) => {
            const meta = sourcePhotoMeta[metaIndex++] || { takenAt: null };
            if (isLocalPendingPhoto(photo)) {
                const variant = uploadedVariants[uploadedIndex++];
                if (variant && variant.url) {
                    finalPhotoUrls.push(variant.url);
                    finalPhotoMeta.push(meta);
                    finalDisplayUrls.push(variant.displayUrl || '');
                    finalThumbUrls.push(variant.thumbUrl || '');
                }
                return;
            }
            if (typeof photo === 'string' && photo) {
                finalPhotoUrls.push(photo);
                finalPhotoMeta.push(meta);
                finalDisplayUrls.push('');
                finalThumbUrls.push('');
            }
        });

        record.photos = finalPhotoUrls;
        record.photoMeta = finalPhotoMeta;
        // 파생본이 하나라도 있을 때만 신규 필드 저장(기존 데이터 스키마 오염 방지)
        if (finalDisplayUrls.some(Boolean)) {
            record.photoDisplayUrls = finalDisplayUrls;
        }
        if (finalThumbUrls.some(Boolean)) {
            record.photoThumbUrls = finalThumbUrls;
        }
        nextPhotosToShare = (!isShareBanned && wantsToShare && finalPhotoUrls.length > 0)
            ? [...finalPhotoUrls]
            : [];

        const photoSaveRes = unwrapMealSaveResult(await dbOps.save(record, true));
        photoPhaseSavedViaCallable = photoSaveRes.savedViaCallableFallback;
        if (photoSaveRes.savedViaCallableFallback && record.id) {
            onMealDocFirestoreServerAcknowledged(String(record.id), optimisticTempId);
        }
        await preloadImage(finalPhotoUrls[0]);
        if (window.mealHistory && Array.isArray(window.mealHistory)) {
            const localIdx = window.mealHistory.findIndex(m => m.id === record.id);
            if (localIdx >= 0) {
                window.mealHistory[localIdx] = {
                    ...window.mealHistory[localIdx],
                    photos: [...finalPhotoUrls],
                    photoMeta: record.photoMeta,
                    ...(record.photoDisplayUrls ? { photoDisplayUrls: [...record.photoDisplayUrls] } : {}),
                    ...(record.photoThumbUrls ? { photoThumbUrls: [...record.photoThumbUrls] } : {})
                };
            }
        }
    } catch (uploadError) {
        photoUploadPhaseFailed = true;
        if (record.id) markMealEntrySaveFailedById(String(record.id));
        console.error('사진 업로드 실패:', uploadError);
        showToast(getUserFacingErrorMessage(uploadError, 'save'), 'error');
        // 네트워크 복구 후 재전송할 수 있도록 base64 원본 유지(URL만 있던 수정 건은 기존 URL 유지)
        const preserve = sourcePhotos.filter((p) => typeof p === 'string' && p);
        record.photos = preserve.length ? preserve : existingPhotoUrls;
        nextPhotosToShare = (!isShareBanned && wantsToShare && existingPhotoUrls.length > 0)
            ? [...existingPhotoUrls]
            : [];
        if (window.mealHistory && record.id) {
            const hi = window.mealHistory.findIndex((m) => m && m.id === record.id);
            if (hi >= 0) {
                window.mealHistory[hi] = {
                    ...window.mealHistory[hi],
                    photos: [...record.photos],
                    _localSaveFailed: true
                };
            }
        }
        try {
            const recoverRes = unwrapMealSaveResult(await dbOps.save(record, true));
            photoPhaseSavedViaCallable = recoverRes.savedViaCallableFallback;
            if (recoverRes.savedViaCallableFallback && record.id) {
                onMealDocFirestoreServerAcknowledged(String(record.id), optimisticTempId);
            }
        } catch (recoverErr) {
            console.warn('사진 유지 상태 재저장 실패(로컬 보존):', recoverErr?.message || recoverErr);
        }
    }

    return { photoUploadPhaseFailed, photoPhaseSavedViaCallable, photosToShare: nextPhotosToShare };
}
