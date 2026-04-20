/**
 * 모먼트 피드 카드의 좋아요/댓글 지연 로드 (Intersection Observer 큐)
 */
import { getDisplayProfile } from '../utils.js';
import { escapeHtml } from './utils.js';
import { fetchUserProfiles } from './user-profiles.js';

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
    
    // 로그인한 사용자는 좋아요/북마크 상태도 확인, 비로그인 사용자는 좋아요 수와 댓글만 가져오기
    const alternatePostIds = (postEl.getAttribute('data-post-id-alternates') || '').split(',').filter(Boolean);
    const promiseArray = [
        window.postInteractions.getLikes(postId).catch(e => {
            console.error(`좋아요 목록 가져오기 실패 (postId: ${postId}):`, e);
            return [];
        }),
        window.postInteractions.getComments(postId, alternatePostIds).catch(e => {
            console.error(`댓글 목록 가져오기 실패 (postId: ${postId}):`, e);
            return [];
        })
    ];
    
    // 로그인한 사용자만 좋아요/북마크 상태 확인
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
        const results = await Promise.all(promiseArray);
        let isLiked = false;
        let isBookmarked = false;
        let likes = [];
        let comments = [];
        
        if (isLoggedIn) {
            [isLiked, isBookmarked, likes, comments] = results;
        } else {
            [likes, comments] = results;
        }
        
        // DOM이 여전히 존재하는지 확인
        if (!document.contains(postEl)) {
            return; // 포스트가 DOM에서 제거되었으면 업데이트하지 않음
        }
        
        // 로그인한 사용자만 좋아요/북마크 버튼 상태 업데이트
        if (isLoggedIn) {
            // 좋아요 버튼 업데이트
            const likeBtn = postEl.querySelector(`.post-like-btn[data-post-id="${postId}"]`);
            const likeIcon = likeBtn?.querySelector('.post-like-icon');
            if (likeBtn && likeIcon) {
                if (isLiked) {
                    likeIcon.classList.remove('fa-regular', 'fa-heart', 'text-slate-800');
                    likeIcon.classList.add('fa-solid', 'fa-heart', 'text-red-500');
                } else {
                    likeIcon.classList.remove('fa-solid', 'fa-heart', 'text-red-500');
                    likeIcon.classList.add('fa-regular', 'fa-heart', 'text-slate-800');
                }
            }
            
            // 북마크 버튼 업데이트
            const bookmarkBtn = postEl.querySelector(`.post-bookmark-btn[data-post-id="${postId}"]`);
            const bookmarkIcon = bookmarkBtn?.querySelector('.post-bookmark-icon');
            if (bookmarkBtn && bookmarkIcon) {
                if (isBookmarked) {
                    bookmarkIcon.classList.remove('fa-regular', 'fa-bookmark');
                    bookmarkIcon.classList.add('fa-solid', 'fa-bookmark', 'text-slate-800');
                } else {
                    bookmarkIcon.classList.remove('fa-solid', 'fa-bookmark', 'text-slate-800');
                    bookmarkIcon.classList.add('fa-regular', 'fa-bookmark');
                }
            }
        }
        
        // 좋아요 수 업데이트
        const likeCountEl = postEl.querySelector(`.post-like-count[data-post-id="${postId}"]`);
        if (likeCountEl) {
            const likeCount = likes && Array.isArray(likes) ? likes.length : 0;
            likeCountEl.textContent = likeCount > 0 ? likeCount : '';
        }
        
        // 댓글 수 업데이트
        const commentCountEl = postEl.querySelector(`.post-comment-count[data-post-id="${postId}"]`);
        if (commentCountEl) {
            const commentCount = comments && Array.isArray(comments) ? comments.length : 0;
            commentCountEl.textContent = commentCount > 0 ? commentCount : '';
        }
        
        // 댓글 아이콘: 사용자가 댓글 단 경우 채우기 (fa-solid)
        const commentIcon = postEl.querySelector(`.post-comment-icon`);
        if (commentIcon && isLoggedIn && comments && Array.isArray(comments)) {
            const hasCommented = comments.some(c => (c.userId || c.authorId) === window.currentUser?.uid);
            if (hasCommented) {
                commentIcon.classList.remove('fa-regular');
                commentIcon.classList.add('fa-solid');
            } else {
                commentIcon.classList.remove('fa-solid');
                commentIcon.classList.add('fa-regular');
            }
        }
        
        // 댓글 표시 (최대 2개) — 등록 시간 포함
        const commentsListEl = postEl.querySelector(`.post-comments-list[data-post-id="${postId}"]`);
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
                        ${dateStr && timeStr ? `<span class="text-xs text-slate-400 ml-2">${dateStr} ${timeStr}</span>` : ''}
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
            } else {
                commentsListEl.innerHTML = '';
                const viewCommentsBtn = postEl.querySelector(`#view-comments-${CSS.escape(postId)}`);
                if (viewCommentsBtn) {
                    viewCommentsBtn.classList.add('hidden');
                }
                if (commentSection) commentSection.classList.add('comments-empty');
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
