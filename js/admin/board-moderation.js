/**
 * 관리자 모니터링: 밀톡(게시판) 목록·상세·일괄 처리
 */
import { db, appId, callableFunctions } from '../firebase.js';
import { boardOperations } from '../db/board.js';
import {
    deleteBoardPostByAdmin,
    setBoardPostHidden,
    getAdminDisplayName,
    getReportsAggregateByGroupKeys
} from '../db.js';
import { escapeHtml, runAdminRefreshAction } from './utils.js';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    query,
    where,
    orderBy,
    limit
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

const ADMIN_BOARD_CACHE_TTL_MS = 3 * 60 * 1000;
const boardListCache = new Map();

/** HTML 본문에서 평문 한 줄 미리보기 (목록용) */
function boardPostPlainPreview(html, maxLen) {
    const div = document.createElement('div');
    div.innerHTML = html || '';
    const t = (div.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return t.length > maxLen ? `${t.slice(0, maxLen)}...` : t;
}

function invalidateBoardMonitoringCache() {
    boardListCache.clear();
}

// 게시판 게시물 렌더링 (기본 구현)
let currentAdminBoardCategory = 'all';
/** 목록을 한 번이라도 성공적으로 불러온 뒤에만 카테고리 전환이 Firestore를 다시 칩니다 */
let adminBoardMonitoringLoaded = false;

function paintBoardPostsList(container, rows, reportsMap) {
    window._feedReportDetails = window._feedReportDetails || {};
    container.innerHTML = rows
        .map(({ id: postId, post }) => {
            const ts = post.timestamp;
            const date = ts
                ? (() => {
                      const d = typeof ts?.toDate === 'function' ? ts.toDate() : new Date(ts);
                      return Number.isFinite(d.getTime()) ? d.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '-';
                  })()
                : '-';
            const reportInfo = reportsMap['board_' + postId];
            if (reportInfo && reportInfo.count > 0) {
                window._feedReportDetails['board_' + postId] = reportInfo.byReason;
            }
            const reportBadgeHtml =
                reportInfo && reportInfo.count > 0
                    ? `<span class="px-2 py-0.5 bg-red-100 text-red-700 text-xs font-bold rounded cursor-pointer hover:bg-red-200" onclick="window.showReportDetailPopup('board_${String(postId).replace(/'/g, "\\'")}')">🚩 신고 ${reportInfo.count}</span>`
                    : '';
            const isHidden = post.isHidden === true;
            const safePostId = String(postId).replace(/'/g, "\\'");
            const legacyTitle = post.title && String(post.title).trim() ? String(post.title).trim() : '';
            const bodyPreview = boardPostPlainPreview(post.content, 120) || '(내용 없음)';
            return `
                <div class="border border-slate-200 rounded-xl p-4 ${isHidden ? 'bg-slate-50 opacity-90' : ''} board-list-row hover:bg-slate-50 transition-colors" data-post-id="${postId}">
                    <div class="flex items-start gap-4">
                        <div class="flex-shrink-0 pt-0.5">
                            <input type="checkbox" class="board-item-checkbox w-4 h-4 rounded border-slate-300" data-post-id="${postId}" title="선택">
                        </div>
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2 mb-2 flex-wrap">
                                <div class="flex-1 min-w-0">
                                    <div class="board-post-title-link cursor-pointer hover:underline" onclick="event.stopPropagation(); window.selectBoardPost('${safePostId}')">
                                        ${legacyTitle ? `<div class="font-bold text-slate-800">${escapeHtml(legacyTitle)}</div>` : ''}
                                        <p class="text-sm text-slate-600 ${legacyTitle ? 'mt-1' : ''}">${escapeHtml(bodyPreview)}</p>
                                    </div>
                                </div>
                                <span class="px-2 py-0.5 bg-slate-100 text-slate-700 text-xs font-bold rounded">${escapeHtml(post.category || '')}</span>
                                ${isHidden ? '<span class="px-2 py-0.5 bg-slate-300 text-slate-600 text-xs font-bold rounded">가려짐</span>' : ''}
                                ${reportBadgeHtml}
                            </div>
                            <div class="flex items-center gap-4 text-xs text-slate-400">
                                <span>${escapeHtml(post.authorNickname || '익명')}</span>
                                <span>${date}</span>
                                <span>조회 ${post.views || 0}</span>
                                <span>댓글 ${post.comments || 0}</span>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        })
        .join('');
}

async function renderBoardPosts(category = 'all') {
    const container = document.getElementById('boardPostsContainer');
    if (!container) return;

    currentAdminBoardCategory = category;
    container.innerHTML =
        '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i><p>로딩 중...</p></div>';

    try {
        const cached = boardListCache.get(category);
        const now = Date.now();
        if (cached && now - cached.ts < ADMIN_BOARD_CACHE_TTL_MS) {
            if (!cached.rows.length) {
                container.innerHTML =
                    '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-comments text-2xl mb-2"></i><p>게시물이 없습니다.</p></div>';
            } else {
                paintBoardPostsList(container, cached.rows, cached.reportsMap);
            }
            adminBoardMonitoringLoaded = true;
            return;
        }

        const [postsSnapshot, reportsMap] = await Promise.all([
            (() => {
                const postsColl = collection(db, 'artifacts', appId, 'boardPosts');
                let q;
                if (category === 'all') {
                    q = query(postsColl, orderBy('timestamp', 'desc'), limit(50));
                } else {
                    q = query(postsColl, where('category', '==', category), orderBy('timestamp', 'desc'), limit(50));
                }
                return getDocs(q);
            })(),
            getReportsAggregateByGroupKeys()
        ]);

        const rows = postsSnapshot.docs.map((d) => ({ id: d.id, post: d.data() }));
        boardListCache.set(category, { ts: now, rows, reportsMap });

        if (rows.length === 0) {
            container.innerHTML =
                '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-comments text-2xl mb-2"></i><p>게시물이 없습니다.</p></div>';
            adminBoardMonitoringLoaded = true;
            return;
        }

        paintBoardPostsList(container, rows, reportsMap);
        adminBoardMonitoringLoaded = true;
    } catch (e) {
        adminBoardMonitoringLoaded = false;
        console.error('게시판 게시물 렌더링 실패:', e);
        container.innerHTML =
            '<div class="text-center py-8 text-red-400"><i class="fa-solid fa-exclamation-triangle text-2xl mb-2"></i><p>게시물을 불러오는 중 오류가 발생했습니다.</p></div>';
    }
}

function getSelectedBoardPostIds() {
    return Array.from(document.querySelectorAll('.board-item-checkbox:checked')).map(el => el.getAttribute('data-post-id')).filter(Boolean);
}

window.adminBoardBulkHide = async function() {
    const ids = getSelectedBoardPostIds();
    if (ids.length === 0) { alert('가릴 게시물을 선택해주세요.'); return; }
    try {
        for (const id of ids) await setBoardPostHidden(id, true);
        invalidateBoardMonitoringCache();
        alert(ids.length + '건이 가려졌습니다.');
        renderBoardPosts(currentAdminBoardCategory);
    } catch (e) {
        console.error(e);
        alert('가리기 실패: ' + (e?.message || e));
    }
};

window.adminBoardBulkUnhide = async function() {
    const ids = getSelectedBoardPostIds();
    if (ids.length === 0) { alert('가리기 해제할 게시물을 선택해주세요.'); return; }
    try {
        for (const id of ids) await setBoardPostHidden(id, false);
        invalidateBoardMonitoringCache();
        alert(ids.length + '건의 가리기가 해제되었습니다.');
        renderBoardPosts(currentAdminBoardCategory);
    } catch (e) {
        console.error(e);
        alert('가리기 해제 실패: ' + (e?.message || e));
    }
};

window.adminBoardBulkDelete = async function() {
    const ids = getSelectedBoardPostIds();
    if (ids.length === 0) { alert('삭제할 게시물을 선택해주세요.'); return; }
    if (!confirm('선택한 ' + ids.length + '건을 삭제하시겠습니까?')) return;
    try {
        for (const id of ids) await deleteBoardPostByAdmin(id);
        invalidateBoardMonitoringCache();
        alert(ids.length + '건이 삭제되었습니다.');
        renderBoardPosts(currentAdminBoardCategory);
    } catch (e) {
        console.error(e);
        alert('삭제 실패: ' + (e?.message || e));
    }
};

// 게시판 게시물 새로고침
window.refreshBoardPosts = async function () {
    await runAdminRefreshAction(document.getElementById('adminRefreshBoardBtn'), async () => {
        invalidateBoardMonitoringCache();
        adminBoardMonitoringLoaded = false;
        await renderBoardPosts(currentAdminBoardCategory);
    });
};

// 게시판 글 선택 → 상세(본문+댓글) 보기
let currentSelectedBoardPostId = null;
window.selectBoardPost = async function(postId) {
    currentSelectedBoardPostId = postId;
    const listPage = document.getElementById('boardListPage');
    const detailPage = document.getElementById('boardDetailPage');
    if (listPage) listPage.classList.add('hidden');
    if (detailPage) detailPage.classList.remove('hidden');
    const inputEl = document.getElementById('boardDetailCommentInput');
    if (inputEl) inputEl.value = '';
    await renderBoardPostDetail(postId);
}

window.backToBoardList = function() {
    currentSelectedBoardPostId = null;
    const listPage = document.getElementById('boardListPage');
    const detailPage = document.getElementById('boardDetailPage');
    if (listPage) listPage.classList.remove('hidden');
    if (detailPage) detailPage.classList.add('hidden');
}

async function renderBoardPostDetail(postId) {
    const container = document.getElementById('boardDetailContainer');
    const commentsContainer = document.getElementById('boardDetailCommentsList');
    if (!container || !postId) return;
    container.innerHTML = '<div class="text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>로딩 중...</div>';
    if (commentsContainer) commentsContainer.innerHTML = '';
    try {
        const postRef = doc(db, 'artifacts', appId, 'boardPosts', postId);
        const postSnap = await getDoc(postRef);
        if (!postSnap.exists()) {
            container.innerHTML = '<p class="text-red-400">게시글을 찾을 수 없습니다.</p>';
            return;
        }
        const post = postSnap.data();
        const legacyTitle = post.title && String(post.title).trim() ? String(post.title).trim() : '';
        const ts = post.timestamp;
        const dateStr = ts ? (() => {
            const d = typeof ts?.toDate === 'function' ? ts.toDate() : new Date(ts);
            return Number.isFinite(d.getTime()) ? d.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '-';
        })() : '-';
        container.innerHTML = `
            <div class="mb-2">
                <span class="px-2 py-0.5 bg-slate-100 text-slate-700 text-xs font-bold rounded">${escapeHtml(post.category || '')}</span>
                ${post.isHidden === true ? '<span class="px-2 py-0.5 bg-slate-300 text-slate-600 text-xs font-bold rounded ml-1">가려짐</span>' : ''}
            </div>
            ${legacyTitle ? `<div class="text-lg font-bold text-slate-800 mb-2">${escapeHtml(legacyTitle)}</div>` : ''}
            <div class="text-xs text-slate-400 mb-3">${escapeHtml(post.authorNickname || '익명')} · ${dateStr} · 조회 ${post.views || 0}</div>
            <div class="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">${escapeHtml(post.content || '').replace(/\n/g, '<br>')}</div>
        `;
        const [comments, adminDisplayName] = await Promise.all([
            boardOperations.getComments(postId),
            getAdminDisplayName()
        ]);
        if (commentsContainer) {
            if (comments.length === 0) {
                commentsContainer.innerHTML = '<p class="text-slate-400 text-sm py-2">댓글이 없습니다.</p>';
            } else {
                commentsContainer.innerHTML = comments.map(c => {
                    const ct = c.timestamp;
                    const cd = ct ? (typeof ct?.toDate === 'function' ? ct.toDate() : new Date(ct)) : null;
                    const timeStr = cd && Number.isFinite(cd.getTime()) ? cd.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '-';
                    const displayName = c.isAdminComment === true ? adminDisplayName : (c.authorNickname || '익명');
                    return `<div class="flex gap-2 p-2 bg-white rounded-lg border border-slate-100">
                        <span class="font-bold text-slate-700 text-sm">${escapeHtml(displayName)}</span>
                        <span class="text-slate-500 text-xs">${timeStr}</span>
                        <p class="text-slate-600 text-sm flex-1">${escapeHtml(c.content || '')}</p>
                    </div>`;
                }).join('');
            }
        }
    } catch (e) {
        console.error('게시글 상세 로드 실패:', e);
        container.innerHTML = '<p class="text-red-400">본문을 불러오는 중 오류가 발생했습니다.</p>';
    }
}

window.submitBoardCommentAsAdmin = async function() {
    const postId = currentSelectedBoardPostId;
    const inputEl = document.getElementById('boardDetailCommentInput');
    if (!postId || !inputEl) return;
    const content = inputEl.value.trim();
    if (!content) {
        alert('댓글 내용을 입력해주세요.');
        return;
    }
    try {
        const result = await callableFunctions.addBoardCommentAsAdmin({
            postId,
            content,
            displayName: await getAdminDisplayName()
        });
        if (result?.data) {
            inputEl.value = '';
            await renderBoardPostDetail(postId);
        }
    } catch (e) {
        console.error('관리자 댓글 등록 실패:', e);
        alert('댓글 등록에 실패했습니다: ' + (e?.message || e));
    }
}

// 게시판 카테고리 설정
window.setAdminBoardCategory = function(category) {
    // 모든 카테고리 버튼 비활성화
    document.querySelectorAll('.admin-board-category-btn').forEach(btn => {
        btn.classList.remove('active', 'bg-emerald-600', 'text-white');
        btn.classList.add('bg-slate-100', 'text-slate-600');
    });
    
    // 선택한 카테고리 버튼 활성화
    const activeBtn = document.getElementById(`admin-board-category-${category}`);
    if (activeBtn) {
        activeBtn.classList.add('active', 'bg-emerald-600', 'text-white');
        activeBtn.classList.remove('bg-slate-100', 'text-slate-600');
    }

    currentAdminBoardCategory = category;
    if (!adminBoardMonitoringLoaded) return;
    renderBoardPosts(category);
}

/** 모니터링 사이드바에서 '게시판' 탭 전환 시 현재 필터 유지용 */
export function getCurrentAdminBoardCategory() {
    return currentAdminBoardCategory;
}

export { renderBoardPosts };
