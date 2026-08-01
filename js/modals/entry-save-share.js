/**
 * 기록 저장 후 모먼트 공유 동기화 — sharedPhotos 컬렉션 쓰기 + 로컬 피드 캐시 반영
 * 공유 상태가 바뀌었을 때만 호출된다. 실패해도 throw하지 않고 플래그로 알린다.
 */
import { appState } from '../state.js';
import { dbOps } from '../db.js';
import { updateTimelineShareIndicators, renderGallery, renderFeed } from '../render/index.js';
import { showToast } from '../ui.js';
import { getUserFacingErrorMessage } from '../utils/user-facing-error.js';

/**
 * 공유 목록이 바뀌거나, 이미 공유 중인데 사진 비율만 바뀐 경우 모먼트 재동기화.
 * 코멘트·메뉴 등만 수정한 경우에는 재공유하지 않아 모먼트 정렬 시각(sharedAt)이 유지되고,
 * 그 결과 피드 순서가 통째로 뒤섞이지 않는다.
 *
 * @param {string[]} photosToShare
 * @param {string[]} originalShareList closeModal 전에 캡처한 스냅샷
 * @param {boolean} photoAspectChanged
 */
function shouldResyncMomentShare(photosToShare, originalShareList, photoAspectChanged) {
    const hasPhotosToShare = photosToShare && photosToShare.length > 0;
    const shareListChanged =
        photosToShare.length !== originalShareList.length ||
        photosToShare.some((url, i) => url !== originalShareList[i]);
    // 비율만 바꿔도 모먼트 프레임이 갱신되도록 — 공유 중(또는 공유할) 사진이 있으면 재동기화
    return shareListChanged || (hasPhotosToShare && photoAspectChanged);
}

/**
 * 모먼트 공유 상태를 서버·로컬 캐시에 반영한다.
 * sharePhotos: sharedPhotos 컬렉션 쓰기 + 서버가 meals.sharedPhotos 미러링.
 *
 * @param {object} args
 * @param {object} args.record 저장된 record (id 확보 후)
 * @param {string[]} args.photosToShare
 * @param {string[]} args.originalShareList
 * @param {boolean} args.hadSharedPhotos
 * @param {boolean} args.photoAspectChanged
 * @returns {Promise<{ shareSyncFailed: boolean }>} 실패 시 호출부가 공유 성공 토스트를 건너뛴다
 */
export async function syncMomentShareAfterSave({
    record,
    photosToShare,
    originalShareList,
    hadSharedPhotos,
    photoAspectChanged,
}) {
    if (!record.id) return { shareSyncFailed: false };

    // 현재 공유할 사진이 있는지 확인
    const hasPhotosToShare = photosToShare && photosToShare.length > 0;
    if (!shouldResyncMomentShare(photosToShare, originalShareList, photoAspectChanged)) {
        return { shareSyncFailed: false };
    }

    // 공유 화살표는 먼저 낙관 반영하고, sharePhotos는 백그라운드로 보내서 체감 지연 감소
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

    try {
        const { buildOptimisticMomentPostV2 } = await import('../utils/moment-post-v2.js');
        const { mergeMomentPostIntoFeed, removeMomentPostFromFeed } = await import('../utils/moment-feed-cache.js');
        const profile = window.userSettings?.profile || {};
        const uid = window.currentUser?.uid;

        await dbOps.sharePhotos(photosToShare, record);
        console.log('공유 처리 완료:', { recordId: record.id, 공유설정: hasPhotosToShare });

        if (record.id && window.mealHistory && Array.isArray(window.mealHistory)) {
            const hi = window.mealHistory.findIndex((m) => m && m.id === record.id);
            if (hi >= 0) {
                window.mealHistory[hi] = {
                    ...window.mealHistory[hi],
                    sharedPhotos: hasPhotosToShare ? [...photosToShare] : []
                };
            }
        }

        if (hasPhotosToShare && photosToShare?.length) {
            window.sharedPhotosFeed = mergeMomentPostIntoFeed(
                window.sharedPhotosFeed,
                buildOptimisticMomentPostV2(record, photosToShare, profile, uid)
            );
        } else if (record?.id) {
            window.sharedPhotosFeed = removeMomentPostFromFeed(window.sharedPhotosFeed, record.id, uid);
        }

        if (appState.currentTab === 'gallery') renderGallery();
        if (document.getElementById('feedContent')) renderFeed();

        import('../db.js').then(({ loadSharedPhotosPage }) =>
            loadSharedPhotosPage(10).then(({ docs, lastDoc, hasMore }) => {
                if (typeof appState !== 'undefined') {
                    appState.sharedPhotosFeedLastDoc = lastDoc;
                    appState.sharedPhotosFeedHasMore = hasMore;
                }
                if (!hasPhotosToShare || !record?.id) return;
                const serverPost = docs.find(
                    (d) => d.schemaVersion === 2 && d.entryId === record.id
                );
                if (serverPost) {
                    window.sharedPhotosFeed = mergeMomentPostIntoFeed(window.sharedPhotosFeed, serverPost);
                    if (appState.currentTab === 'gallery') renderGallery();
                    if (document.getElementById('feedContent')) renderFeed();
                }
            })
        ).catch(() => {});
    } catch (e) {
        console.error("공유 처리 실패:", e);
        showToast(getUserFacingErrorMessage(e, 'share'), 'error');
        return { shareSyncFailed: true };
    }

    return { shareSyncFailed: false };
}
