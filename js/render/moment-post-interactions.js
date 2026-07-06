/**
 * 모먼트 피드 카드의 좋아요/댓글 지연 로드 (Intersection Observer 큐)
 */
import { getDisplayProfile } from '../utils.js';
import { escapeHtml } from './utils.js';
import { fetchUserProfiles } from './user-profiles.js';

/**
 * 사진 위 소셜 댓글 스택 아이콘: 본인 댓글 여부(`data-post-user-commented`) + 휠/팝업 댓글 패널 열림
 * @param {string} postId
 */
export function applyStackCommentBtnVisual(postId) {
    const pid = String(postId || '');
    if (!pid) return;
    const mealO = document.getElementById('timelineMealPhotosOverlay');
    const panelOpen =
        mealO &&
        !mealO.classList.contains('hidden') &&
        mealO._mealPhotoPostCommentsOpen &&
        String(mealO._mealPhotoPostCommentsPostId) === pid;
    document.querySelectorAll('.post-comment-btn[data-post-id]').forEach((btn) => {
        if (btn.getAttribute('data-post-id') !== pid) return;
        if (!btn.querySelector('.post-comment-fill')) return;
        const icon = btn.querySelector('.post-comment-icon');
        if (icon) {
            icon.classList.remove('fa-solid');
            icon.classList.add('fa-regular', 'fa-comment', 'text-white/95', 'post-comment-icon', 'timeline-meal-photo-moment-social-icon');
        }
        const uc = btn.getAttribute('data-post-user-commented') === '1';
        btn.classList.toggle('post-social-state-on', uc || panelOpen);
    });
}

export const MAX_CONCURRENT_LOADS = 2;
export const BATCH_DELAY = 200;
export const loadedPostIds = new Set();
export let postLoadQueue = [];
export let postLoadBatchTimer = null;

export function clearMomentPostInteractionQueue() {
    postLoadQueue = [];
    if (postLoadBatchTimer) {
        clearTimeout(postLoadBatchTimer);
        postLoadBatchTimer = null;
    }
    loadedPostIds.clear();
}

/** Intersection Observer 콜백에서 호출 — 가져온 모듈에서 타이머·큐 갱신 */
export function enqueuePostInteractionLoad(postEl, postId, abortSignal) {
    if (!postId || loadedPostIds.has(postId)) return;
    loadedPostIds.add(postId);
    postLoadQueue.push({ postEl, postId });
    if (!postLoadBatchTimer && (!abortSignal || !abortSignal.aborted)) {
        postLoadBatchTimer = setTimeout(() => {
            if (!abortSignal || !abortSignal.aborted) {
                processPostLoadQueue();
            }
        }, BATCH_DELAY);
    }
}

export function processPostLoadQueue() {
    if (postLoadQueue.length === 0) {
        return;
    }
    
    // 최대 동시 로드 수만큼만 처리
    const toProcess = postLoadQueue.splice(0, MAX_CONCURRENT_LOADS);
    
    toProcess.forEach(({ postEl, postId }) => {
        // DOM이 여전히 존재하는지 확인
        if (!document.contains(postEl)) {
            return;
        }
        
        loadPostInteractions(postEl, postId).catch(err => {
            console.error(`포스트 ${postId} 상호작용 데이터 로드 실패:`, err);
            // 실패 시 캐시에서 제거하여 재시도 가능하게
            loadedPostIds.delete(postId);
        });
    });
    
    // 큐에 남은 항목이 있으면 다음 배치 예약
    if (postLoadQueue.length > 0) {
        postLoadBatchTimer = setTimeout(processPostLoadQueue, BATCH_DELAY);
    } else {
        postLoadBatchTimer = null;
    }
}

// 좋아요/북마크/댓글 데이터 로드 함수 (단일 포스트용 - Intersection Observer에서 호출)
export async function loadPostInteractions(postEl, postId) {
    if (!window.postInteractions || !postEl || !postId) {
        return;
    }
    
    const isLoggedIn = window.currentUser && !window.currentUser.isAnonymous;

    // 화면2(v2): 좋아요/댓글 "개수"는 문서 시드값(likeCount/commentCount)으로 이미 표시되고,
    // 댓글 본문은 패널이 숨겨져 있어 사용자가 시트를 열 때 viewAllComments가 로드한다.
    // → 스크롤 중에는 전체 목록 조회(getLikes/getComments)를 생략해 Firestore 읽기·DOM 갱신을 줄인다.
    //    (v1은 하단에 댓글 미리보기가 노출되므로 기존대로 전체 조회 유지)
    const isV2Card = postEl.getAttribute('data-moment-card-layout') === '2';

    // 로그인한 사용자는 좋아요/북마크 상태도 확인, 비로그인 사용자는 좋아요 수와 댓글만 가져오기
    const alternatePostIds = (postEl.getAttribute('data-post-id-alternates') || '').split(',').filter(Boolean);
    const promiseArray = isV2Card
        ? []
        : [
              window.postInteractions.getLikes(postId).catch(e => {
                  console.error(`좋아요 목록 가져오기 실패 (postId: ${postId}):`, e);
                  return [];
              }),
              window.postInteractions.getComments(postId, alternatePostIds).catch(e => {
                  console.error(`댓글 목록 가져오기 실패 (postId: ${postId}):`, e);
                  return [];
              })
          ];
    
    // 로그인한 사용자만 좋아요/북마크 상태 확인 (v2도 버튼 on/off 표시엔 필요)
    if (isLoggedIn) {
        promiseArray.unshift(
            window.postInteractions.isLiked(postId, window.currentUser.uid).catch(e => {
                console.error(`좋아요 상태 확인 실패 (postId: ${postId}):`, e);
                return false;
            }),
            window.postInteractions.isBookmarked(postId, window.currentUser.uid).catch(e => {
                console.error(`북마크 상태 확인 실패 (postId: ${postId}):`, e);
                return false;
            })
        );
    }
    
    try {
        const seedLikeRaw = postEl.getAttribute('data-seed-like-count');
        const seedCommentRaw = postEl.getAttribute('data-seed-comment-count');
        if (seedLikeRaw !== null && seedLikeRaw !== '') {
            postEl.querySelectorAll(`.post-like-count[data-post-id="${postId}"]`).forEach((el) => {
                const n = Number(seedLikeRaw);
                el.textContent = n > 0 ? String(n) : '';
            });
        }
        if (seedCommentRaw !== null && seedCommentRaw !== '') {
            postEl.querySelectorAll(`.post-comment-count[data-post-id="${postId}"]`).forEach((el) => {
                const n = Number(seedCommentRaw);
                el.textContent = n > 0 ? String(n) : '';
            });
        }

        const results = await Promise.all(promiseArray);
        let isLiked = false;
        let isBookmarked = false;
        // v2는 목록을 조회하지 않으므로 null → 이후 카운트/댓글 갱신을 건너뛰고 시드값을 유지
        let likes = null;
        let comments = null;
        
        if (isLoggedIn && !isV2Card) {
            [isLiked, isBookmarked, likes, comments] = results;
        } else if (isLoggedIn && isV2Card) {
            [isLiked, isBookmarked] = results;
        } else if (!isLoggedIn && !isV2Card) {
            [likes, comments] = results;
        }
        
        // DOM이 여전히 존재하는지 확인
        if (!document.contains(postEl)) {
            return; // 포스트가 DOM에서 제거되었으면 업데이트하지 않음
        }
        
        // 로그인한 사용자만 좋아요/북마크 버튼 상태 업데이트
        if (isLoggedIn) {
            postEl.querySelectorAll(`.post-like-btn[data-post-id="${postId}"]`).forEach((likeBtn) => {
                const likeIcon = likeBtn.querySelector('.post-like-icon');
                if (!likeIcon) return;
                const stackFill = likeBtn.querySelector('.post-like-fill');
                const inPhoto = likeIcon.classList.contains('timeline-meal-photo-moment-social-icon');
                if (stackFill) {
                    likeIcon.classList.remove('fa-solid', 'fa-heart', 'text-red-500', 'text-red-400', 'text-slate-800', 'text-white', 'text-white/95');
                    likeIcon.classList.add('fa-regular', 'fa-heart', 'timeline-meal-photo-moment-social-icon');
                    likeIcon.classList.add(inPhoto ? 'text-white/95' : 'text-slate-800');
                    likeBtn.classList.toggle('post-social-state-on', isLiked);
                    return;
                }
                if (isLiked) {
                    likeIcon.classList.remove('fa-regular', 'fa-heart', 'text-slate-800', 'text-white/95');
                    likeIcon.classList.add('fa-solid', 'fa-heart');
                    if (inPhoto) {
                        likeIcon.classList.add('text-white/95');
                    } else {
                        likeIcon.classList.add('text-red-500');
                    }
                } else {
                    likeIcon.classList.remove('fa-solid', 'fa-heart', 'text-red-500', 'text-slate-800');
                    likeIcon.classList.add('fa-regular', 'fa-heart');
                    if (inPhoto) {
                        likeIcon.classList.add('text-white/95');
                    } else {
                        likeIcon.classList.add('text-slate-800');
                    }
                }
            });

            postEl.querySelectorAll(`.post-bookmark-btn[data-post-id="${postId}"]`).forEach((bookmarkBtn) => {
                const bookmarkIcon = bookmarkBtn.querySelector('.post-bookmark-icon');
                if (!bookmarkIcon) return;
                const stackFill = bookmarkBtn.querySelector('.post-bookmark-fill');
                const inPhoto = bookmarkIcon.classList.contains('timeline-meal-photo-moment-social-icon');
                if (stackFill) {
                    bookmarkIcon.classList.remove('fa-solid', 'fa-bookmark', 'text-slate-800', 'text-white', 'text-white/95');
                    bookmarkIcon.classList.add('fa-regular', 'fa-bookmark', 'timeline-meal-photo-moment-social-icon');
                    if (!inPhoto) bookmarkIcon.classList.add('text-slate-800');
                    else bookmarkIcon.classList.add('text-white/95');
                    bookmarkBtn.classList.toggle('post-social-state-on', isBookmarked);
                    return;
                }
                if (isBookmarked) {
                    bookmarkIcon.classList.remove('fa-regular', 'fa-bookmark', 'text-slate-800');
                    bookmarkIcon.classList.add('fa-solid', 'fa-bookmark');
                    if (!inPhoto) bookmarkIcon.classList.add('text-slate-800');
                } else {
                    bookmarkIcon.classList.remove('fa-solid', 'fa-bookmark', 'text-slate-800');
                    bookmarkIcon.classList.add('fa-regular', 'fa-bookmark');
                }
            });
        }

        // 좋아요 수 업데이트 (v2는 likes 미조회 → 시드값 유지)
        if (Array.isArray(likes)) {
            const likeCount = likes.length;
            postEl.querySelectorAll(`.post-like-count[data-post-id="${postId}"]`).forEach((likeCountEl) => {
                likeCountEl.textContent = likeCount > 0 ? likeCount : '';
            });
        }

        // 댓글 수 업데이트 (v2는 comments 미조회 → 시드값 유지)
        if (Array.isArray(comments)) {
            const commentCount = comments.length;
            postEl.querySelectorAll(`.post-comment-count[data-post-id="${postId}"]`).forEach((commentCountEl) => {
                commentCountEl.textContent = commentCount > 0 ? commentCount : '';
            });
        }

        // 댓글 아이콘: 사용자가 댓글 단 경우 채우기 (fa-solid)
        if (isLoggedIn && comments && Array.isArray(comments)) {
            const hasCommented = comments.some((c) => (c.userId || c.authorId) === window.currentUser?.uid);
            postEl.querySelectorAll(`.post-comment-btn[data-post-id="${postId}"]`).forEach((btn) => {
                const icon = btn.querySelector('.post-comment-icon');
                if (!icon) return;
                const stackFill = btn.querySelector('.post-comment-fill');
                if (stackFill) {
                    if (hasCommented) btn.setAttribute('data-post-user-commented', '1');
                    else btn.removeAttribute('data-post-user-commented');
                    return;
                }
                if (icon.classList.contains('timeline-meal-photo-moment-social-icon')) {
                    if (hasCommented) {
                        icon.classList.remove('fa-regular');
                        icon.classList.add('fa-solid', 'text-white/95');
                    } else {
                        icon.classList.remove('fa-solid');
                        icon.classList.add('fa-regular', 'text-white/95');
                    }
                } else if (hasCommented) {
                    icon.classList.remove('fa-regular', 'text-slate-800');
                    icon.classList.add('fa-solid', 'text-slate-800');
                } else {
                    icon.classList.remove('fa-solid', 'text-slate-800');
                    icon.classList.add('fa-regular', 'text-slate-800');
                }
            });
            applyStackCommentBtnVisual(postId);
        }
        
        // 댓글 표시 (최대 2개) — 등록 시간 포함 (v2는 comments 미조회 → 시트 열 때 로드하므로 건너뜀)
        const commentsListEl = Array.isArray(comments)
            ? postEl.querySelector(`.post-comments-list[data-post-id="${postId}"]`)
            : null;
        if (commentsListEl) {
            const commentSection = postEl.querySelector(`#comment-section-${CSS.escape(postId)}`);
            if (comments.length > 0) {
                if (commentSection) commentSection.classList.remove('comments-empty');
                // 댓글 작성자들의 최신 프로필 로드
                const commentAuthorIds = [...new Set(comments.map(c => c.userId || c.authorId).filter(Boolean))];
                await fetchUserProfiles(commentAuthorIds);
                // 댓글 목록은 흰색 배경 유지 (앨범 스타일)
                const displayComments = comments.slice(0, 2);
                commentsListEl.innerHTML = displayComments.map(c => {
                    let dateStr = '', timeStr = '';
                    if (c.timestamp) {
                        try {
                            const commentDate = c.timestamp instanceof Date
                                ? c.timestamp
                                : (c.timestamp.toDate ? c.timestamp.toDate() : new Date(c.timestamp));
                            if (!isNaN(commentDate.getTime())) {
                                dateStr = commentDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
                                timeStr = commentDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
                            }
                        } catch (_) {}
                    }
                    const commentDisplay = getDisplayProfile(
                            c.userId,
                            { nickname: c.userNickname, icon: c.userIcon },
                            { preferStoredNickname: true }
                        );
                    return `
                    <div class="mb-1 text-sm">
                        <span class="font-bold text-slate-800">${commentDisplay.nickname}</span>
                        <span class="text-slate-800">${escapeHtml(c.comment)}</span>
                        ${dateStr && timeStr ? `<span class="text-xs text-slate-500 ml-2">${dateStr} ${timeStr}</span>` : ''}
                        ${isLoggedIn && c.userId === window.currentUser?.uid ? `<button onclick="window.deleteCommentFromPost('${c.id}', '${postId}')" class="ml-2 text-slate-400 text-xs hover:text-red-500">삭제</button>` : ''}
                    </div>
                `;
                }).join('');
                
                // 댓글이 2개보다 많으면 "댓글 모두 보기" 버튼 표시
                if (comments.length > 2) {
                    const viewCommentsBtn = postEl.querySelector(`#view-comments-${CSS.escape(postId)}`);
                    if (viewCommentsBtn) {
                        viewCommentsBtn.classList.remove('hidden');
                        viewCommentsBtn.textContent = `댓글 ${comments.length}개 모두 보기`;
                    }
                } else {
                    const viewCommentsBtn = postEl.querySelector(`#view-comments-${CSS.escape(postId)}`);
                    if (viewCommentsBtn) {
                        viewCommentsBtn.classList.add('hidden');
                    }
                }
                window.Mealog?.syncMomentV2SocialCommentEmptyOverlay?.(postId);
            } else {
                commentsListEl.innerHTML = '';
                const viewCommentsBtn = postEl.querySelector(`#view-comments-${CSS.escape(postId)}`);
                if (viewCommentsBtn) {
                    viewCommentsBtn.classList.add('hidden');
                }
                if (commentSection) commentSection.classList.add('comments-empty');
                window.Mealog?.syncMomentV2SocialCommentEmptyOverlay?.(postId);
            }
        } else {
            const commentSection = postEl.querySelector(`#comment-section-${CSS.escape(postId)}`);
            if (commentSection) commentSection.classList.add('comments-empty');
        }
    } catch (err) {
        console.error(`포스트 ${postId}의 좋아요/북마크/댓글 로드 실패:`, err);
        // 실패 시 캐시에서 제거하여 재시도 가능하게
        loadedPostIds.delete(postId);
    }
}
