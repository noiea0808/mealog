/**
 * 관리자 모니터링: 밀톡(게시판) 목록·상세·일괄 처리
 */
import { db, appId, callableFunctions, auth } from '../firebase.js';
import { boardOperations } from '../db/board.js';
import {
    deleteBoardPostByAdmin,
    setBoardPostHidden,
    getAdminDisplayName,
    getReportsAggregateByGroupKeys
} from '../db.js';
import { escapeHtml, runAdminRefreshAction } from './utils.js';
import { uploadBoardImages, getDisplayProfile } from '../utils.js';
import { renderFormattedContent } from '../render/utils.js';
import { fetchUserProfiles } from '../render/user-profiles.js';

/** 밀톡 상세 본문 — `board-notice.js`의 BOARD_DETAIL_BODY_CLASS 와 동일 (서식·줄바꿈 표시) */
const BOARD_DETAIL_BODY_CLASS =
    'board-detail-body text-sm text-slate-700 whitespace-pre-wrap leading-relaxed break-words [&_b]:font-bold [&_strong]:font-bold [&_u]:underline [&_s]:line-through [&_strike]:line-through';
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

const _adminBoardDetailCommentImages = { files: [], objectUrls: [] };
function _adminRevokeObjectUrls(list) {
    (list || []).forEach((u) => {
        try {
            if (u && String(u).startsWith('blob:')) URL.revokeObjectURL(u);
        } catch (_) {}
    });
}
function _adminSetBoardDetailCommentFiles(files) {
    _adminRevokeObjectUrls(_adminBoardDetailCommentImages.objectUrls);
    _adminBoardDetailCommentImages.files = Array.from(files || []).slice(0, 3);
    _adminBoardDetailCommentImages.objectUrls = _adminBoardDetailCommentImages.files.map((f) => URL.createObjectURL(f));
}
function _adminClearBoardDetailCommentFiles({ revoke = true } = {}) {
    if (revoke) _adminRevokeObjectUrls(_adminBoardDetailCommentImages.objectUrls);
    _adminBoardDetailCommentImages.files = [];
    _adminBoardDetailCommentImages.objectUrls = [];
    const input = document.getElementById('boardDetailCommentPhotoInput');
    if (input) input.value = '';
}
function _adminRenderBoardDetailCommentPreview() {
    const el = document.getElementById('boardDetailCommentPhotoPreview');
    if (!el) return;
    const urls = _adminBoardDetailCommentImages.objectUrls || [];
    if (!urls.length) {
        el.innerHTML = '';
        el.classList.add('hidden');
        return;
    }
    el.classList.remove('hidden');
    el.innerHTML = urls
        .map(
            (url, idx) => `
            <button type="button" class="board-detail-comment-photo-thumb" data-admin-board-comment-thumb="1" data-idx="${idx}" aria-label="첨부 이미지 미리보기">
                <img src="${url}" alt="" loading="lazy" />
            </button>
        `
        )
        .join('');
}

let _adminDetailCommentLightboxEl = null;
function _adminOpenDetailCommentLightbox(src) {
    const url = typeof src === 'string' ? src.trim() : '';
    if (!url) return;
    if (!_adminDetailCommentLightboxEl) {
        _adminDetailCommentLightboxEl = document.createElement('div');
        _adminDetailCommentLightboxEl.className = 'detail-comment-lightbox hidden';
        _adminDetailCommentLightboxEl.innerHTML = `
            <div class="detail-comment-lightbox__scrim" data-dclb-close="1" aria-label="닫기"></div>
            <div class="detail-comment-lightbox__stage" role="dialog" aria-modal="true" aria-label="이미지 확대">
                <button type="button" class="detail-comment-lightbox__close" data-dclb-close="1" aria-label="닫기">
                    <i class="fa-solid fa-times" aria-hidden="true"></i>
                </button>
                <img class="detail-comment-lightbox__img" alt="" />
            </div>
        `;
        document.body.appendChild(_adminDetailCommentLightboxEl);
        _adminDetailCommentLightboxEl.addEventListener('click', (e) => {
            const close = e.target?.closest?.('[data-dclb-close="1"]');
            if (close) {
                e.preventDefault();
                _adminDetailCommentLightboxEl.classList.add('hidden');
                _adminDetailCommentLightboxEl.querySelector('img')?.removeAttribute('src');
            }
        });
    }
    const img = _adminDetailCommentLightboxEl.querySelector('img');
    if (img) img.src = url;
    _adminDetailCommentLightboxEl.classList.remove('hidden');
}

(function bindAdminBoardDetailCommentPhotoComposer() {
    const attachBtn = document.getElementById('boardDetailCommentAttachBtn');
    const input = document.getElementById('boardDetailCommentPhotoInput');
    if (attachBtn && input && !attachBtn.dataset.bound) {
        attachBtn.dataset.bound = '1';
        attachBtn.addEventListener('click', () => input.click());
        input.addEventListener('change', () => {
            _adminSetBoardDetailCommentFiles(input.files);
            _adminRenderBoardDetailCommentPreview();
        });
    }
    if (!document.documentElement.dataset.adminBoardDetailLbBound) {
        document.documentElement.dataset.adminBoardDetailLbBound = '1';
        document.addEventListener('click', (e) => {
            const del = e.target?.closest?.('[data-admin-board-delete-comment="1"]');
            if (del) {
                e.preventDefault();
                const cid = del.getAttribute('data-comment-id') || '';
                const pid = del.getAttribute('data-post-id') || '';
                const aid = del.getAttribute('data-comment-author') || '';
                if (cid && pid && typeof window.deleteAdminBoardComment === 'function') {
                    window.deleteAdminBoardComment(cid, pid, aid);
                }
                return;
            }
            const thumb = e.target?.closest?.('[data-admin-board-comment-thumb="1"]');
            if (thumb) {
                const idx = parseInt(thumb.getAttribute('data-idx') || '0', 10) || 0;
                const src = _adminBoardDetailCommentImages.objectUrls?.[idx] || '';
                if (src) _adminOpenDetailCommentLightbox(src);
                return;
            }
            const btn = e.target?.closest?.('[data-detail-comment-image="1"]');
            if (btn) {
                const src = btn.getAttribute('data-src') || '';
                if (src) _adminOpenDetailCommentLightbox(src);
            }
        });
    }
})();

const ADMIN_BOARD_CACHE_TTL_MS = 3 * 60 * 1000;
const boardListCache = new Map();

/** HTML 본문에서 평문 한 줄 미리보기 (목록용) */
const BOARD_CATEGORY_LABELS = {
    serious: '무거운',
    chat: '가벼운',
    food: '먹는',
    admin: '치프에게'
};

function boardPostPlainPreview(html, maxLen) {
    const div = document.createElement('div');
    div.innerHTML = html || '';
    const t = (div.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return t.length > maxLen ? `${t.slice(0, maxLen)}...` : t;
}

/** Firestore Timestamp·ISO 문자열·{seconds,nanoseconds} 맵 등 혼재 시 정렬용 ms */
function boardPostTimestampMs(ts) {
    if (ts == null || ts === '') return 0;
    if (typeof ts?.toDate === 'function') {
        const ms = ts.toDate().getTime();
        return Number.isFinite(ms) ? ms : 0;
    }
    if (typeof ts === 'string') {
        const ms = new Date(ts).getTime();
        return Number.isFinite(ms) ? ms : 0;
    }
    if (ts instanceof Date) {
        const ms = ts.getTime();
        return Number.isFinite(ms) ? ms : 0;
    }
    if (typeof ts === 'number' && Number.isFinite(ts)) {
        return ts > 1e12 ? ts : ts * 1000;
    }
    if (typeof ts === 'object' && typeof ts.seconds === 'number') {
        return ts.seconds * 1000 + (ts.nanoseconds || 0) / 1e6;
    }
    const ms = new Date(ts).getTime();
    return Number.isFinite(ms) ? ms : 0;
}

function formatBoardPostDateTimeLines(ts) {
    const ms = boardPostTimestampMs(ts);
    if (!ms) return { dateLine: '-', timeLine: '' };
    const d = new Date(ms);
    return {
        dateLine: d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric' }),
        timeLine: d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
    };
}

function sortBoardPostRowsByTimestampDesc(rows) {
    return [...rows].sort((a, b) => boardPostTimestampMs(b.post?.timestamp) - boardPostTimestampMs(a.post?.timestamp));
}

function resolveBoardPostAuthorLabel(post) {
    const display = getDisplayProfile(post?.authorId, {
        nickname: post?.authorNickname,
        icon: post?.authorIcon,
        photoUrl: post?.authorPhotoUrl
    });
    return display.nickname || '익명';
}

function boardCategoryLabel(category) {
    const key = category != null && category in BOARD_CATEGORY_LABELS ? category : '';
    return key ? BOARD_CATEGORY_LABELS[key] : String(category || '');
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
    const bodyRows = rows
        .map(({ id: postId, post }) => {
            const { dateLine, timeLine } = formatBoardPostDateTimeLines(post.timestamp);
            const authorLabel = resolveBoardPostAuthorLabel(post);
            const reportInfo = reportsMap['board_' + postId];
            if (reportInfo && reportInfo.count > 0) {
                window._feedReportDetails['board_' + postId] = reportInfo.byReason;
            }
            const reportBadgeHtml =
                reportInfo && reportInfo.count > 0
                    ? `<span class="px-2 py-0.5 bg-red-100 text-red-700 text-xs font-bold rounded cursor-pointer hover:bg-red-200" onclick="event.stopPropagation(); window.showReportDetailPopup('board_${String(postId).replace(/'/g, "\\'")}')">🚩 신고 ${reportInfo.count}</span>`
                    : '';
            const isHidden = post.isHidden === true;
            const safePostId = String(postId).replace(/'/g, "\\'");
            const legacyTitle = post.title && String(post.title).trim() ? String(post.title).trim() : '';
            const bodyPreview = boardPostPlainPreview(post.content, 160) || '(내용 없음)';
            const catLabel = boardCategoryLabel(post.category);
            const views = post.views != null ? Number(post.views) : 0;
            const comments = post.comments != null ? Number(post.comments) : 0;
            const metaBadges = [
                isHidden ? '<span class="px-2 py-0.5 bg-slate-300 text-slate-600 text-xs font-bold rounded">가려짐</span>' : '',
                reportBadgeHtml
            ]
                .filter(Boolean)
                .join(' ');
            return `<tr class="border-b border-slate-100 ${isHidden ? 'bg-slate-50' : ''} hover:bg-slate-50/80 board-list-row" data-post-id="${escapeHtml(String(postId))}">
                <td class="px-3 py-2.5 align-top whitespace-nowrap">
                    <input type="checkbox" class="board-item-checkbox w-4 h-4 rounded border-slate-300" data-post-id="${escapeHtml(String(postId))}" title="선택" onclick="event.stopPropagation()">
                </td>
                <td class="px-3 py-2.5 text-sm text-slate-600 tabular-nums whitespace-nowrap align-top leading-snug">
                    <div>${escapeHtml(dateLine)}</div>
                    ${timeLine ? `<div class="text-xs text-slate-400 mt-0.5">${escapeHtml(timeLine)}</div>` : ''}
                </td>
                <td class="px-3 py-2.5 text-sm text-slate-800 min-w-[7rem] align-top">${escapeHtml(authorLabel)}</td>
                <td class="px-3 py-2.5 text-sm text-slate-700 whitespace-nowrap align-top">${catLabel ? escapeHtml(catLabel) : '—'}</td>
                <td class="px-3 py-2.5 text-sm text-slate-700 min-w-[14rem] max-w-xl align-top">
                    <div class="board-post-title-link cursor-pointer min-w-0 hover:underline" onclick="window.selectBoardPost('${safePostId}')">
                        ${legacyTitle ? `<div class="font-bold text-slate-800 mb-0.5">${escapeHtml(legacyTitle)}</div>` : ''}
                        <div class="line-clamp-2 break-words" title="${escapeHtml(bodyPreview)}">${escapeHtml(bodyPreview)}</div>
                        ${metaBadges ? `<div class="flex flex-wrap items-center gap-1 mt-1.5">${metaBadges}</div>` : ''}
                    </div>
                </td>
                <td class="px-3 py-2.5 text-sm text-slate-600 tabular-nums text-right whitespace-nowrap align-top">${Number.isFinite(views) ? views : 0}</td>
                <td class="px-3 py-2.5 text-sm text-slate-600 tabular-nums text-right whitespace-nowrap align-top">${Number.isFinite(comments) ? comments : 0}</td>
            </tr>`;
        })
        .join('');

    container.innerHTML = `
        <div class="overflow-x-auto border border-slate-200 rounded-xl">
            <table class="w-full text-left border-collapse min-w-[720px] admin-board-posts-table">
                <thead>
                    <tr class="bg-slate-100 text-slate-700 text-xs font-black">
                        <th class="px-3 py-2.5 w-10 font-bold">선택</th>
                        <th class="px-3 py-2.5 whitespace-nowrap font-bold">날짜·시간</th>
                        <th class="px-3 py-2.5 min-w-[7rem] font-bold">작성자</th>
                        <th class="px-3 py-2.5 w-24 font-bold">카테고리</th>
                        <th class="px-3 py-2.5 min-w-[14rem] font-bold">글내용</th>
                        <th class="px-3 py-2.5 w-16 text-right font-bold">조회</th>
                        <th class="px-3 py-2.5 w-16 text-right font-bold">댓글</th>
                    </tr>
                </thead>
                <tbody>${bodyRows}</tbody>
            </table>
        </div>
        <p class="text-xs text-slate-400 mt-2">최신 글이 위에 표시됩니다. 글내용을 누르면 상세를 볼 수 있습니다.</p>`;
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
                const authorIds = cached.rows.map((r) => r.post?.authorId).filter(Boolean);
                await fetchUserProfiles(authorIds);
                paintBoardPostsList(container, sortBoardPostRowsByTimestampDesc(cached.rows), cached.reportsMap);
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

        let rows = postsSnapshot.docs.map((d) => ({ id: d.id, post: d.data() }));
        rows = sortBoardPostRowsByTimestampDesc(rows);
        const authorIds = rows.map((r) => r.post?.authorId).filter(Boolean);
        await fetchUserProfiles(authorIds);
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
    _adminClearBoardDetailCommentFiles();
    _adminRenderBoardDetailCommentPreview();
    await renderBoardPostDetail(postId);
}

window.backToBoardList = function() {
    currentSelectedBoardPostId = null;
    const listPage = document.getElementById('boardListPage');
    const detailPage = document.getElementById('boardDetailPage');
    if (listPage) listPage.classList.remove('hidden');
    if (detailPage) detailPage.classList.add('hidden');
}

/** 관리자 댓글 등록 버튼: 업로드·Callable 중 작은 스피너 + 입력 비활성화 */
function setAdminBoardCommentSubmitBusy(isBusy) {
    const idle = document.getElementById('boardDetailCommentSubmitIdle');
    const spin = document.getElementById('boardDetailCommentSubmitSpinner');
    const btn = document.getElementById('boardDetailCommentSubmitBtn');
    const attach = document.getElementById('boardDetailCommentAttachBtn');
    const inputEl = document.getElementById('boardDetailCommentInput');
    const fileInput = document.getElementById('boardDetailCommentPhotoInput');
    if (idle) idle.classList.toggle('hidden', !!isBusy);
    if (spin) spin.classList.toggle('hidden', !isBusy);
    if (btn) {
        btn.disabled = !!isBusy;
        btn.setAttribute('aria-busy', isBusy ? 'true' : 'false');
    }
    [attach, inputEl, fileInput].forEach((el) => {
        if (el) el.disabled = !!isBusy;
    });
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
        const { dateLine, timeLine } = formatBoardPostDateTimeLines(post.timestamp);
        const dateStr = timeLine ? `${dateLine} ${timeLine}` : dateLine;
        if (post.authorId) await fetchUserProfiles([post.authorId]);
        const authorLabel = resolveBoardPostAuthorLabel(post);
        const catLabel = boardCategoryLabel(post.category) || String(post.category || '');
        container.innerHTML = `
            <div class="mb-2">
                <span class="px-2 py-0.5 bg-slate-100 text-slate-700 text-xs font-bold rounded">${escapeHtml(catLabel)}</span>
                ${post.isHidden === true ? '<span class="px-2 py-0.5 bg-slate-300 text-slate-600 text-xs font-bold rounded ml-1">가려짐</span>' : ''}
            </div>
            ${legacyTitle ? `<div class="text-lg font-bold text-slate-800 mb-2">${escapeHtml(legacyTitle)}</div>` : ''}
            <div class="text-xs text-slate-400 mb-3">${escapeHtml(authorLabel)} · ${escapeHtml(dateStr)} · 조회 ${post.views || 0}</div>
            <div class="${BOARD_DETAIL_BODY_CLASS}">${renderFormattedContent(post.content || '')}</div>
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
                    const body = String(c.content || '').trim();
                    const imgs = Array.isArray(c.imageUrls) ? c.imageUrls.filter(Boolean).slice(0, 3) : [];
                    const safeCid = escapeHtml(String(c.id || ''));
                    const safePostIdAttr = escapeHtml(String(postId));
                    const safeAuthorIdAttr = escapeHtml(String(c.authorId || ''));
                    const deleteBtn =
                        c.isAdminComment === true
                            ? `<button type="button" class="text-xs font-semibold text-slate-400 hover:text-red-600 transition-colors shrink-0" data-admin-board-delete-comment="1" data-comment-id="${safeCid}" data-post-id="${safePostIdAttr}" data-comment-author="${safeAuthorIdAttr}">삭제</button>`
                            : '';
                    return `<div class="p-2 bg-white rounded-lg border border-slate-100">
                        <div class="flex items-start justify-between gap-2">
                            <div class="min-w-0 flex items-baseline gap-2 flex-wrap">
                                <span class="font-bold text-slate-700 text-sm">${escapeHtml(displayName)}</span>
                                <span class="text-slate-500 text-xs">${timeStr}</span>
                            </div>
                            ${deleteBtn}
                        </div>
                        ${body ? `<p class="text-slate-600 text-sm mt-1 whitespace-pre-wrap break-words">${escapeHtml(body)}</p>` : ''}
                        ${imgs.length ? `
                            <div class="board-detail-comment-images mt-2 flex flex-wrap gap-2">
                                ${imgs
                                    .map((url) => {
                                        const esc = escapeHtml(String(url || '').trim());
                                        if (!esc) return '';
                                        return `<button type="button" class="board-detail-comment-image-btn" data-detail-comment-image="1" data-kind="board" data-src="${esc}" aria-label="댓글 이미지 확대">
                                            <img src="${esc}" alt="" loading="lazy" />
                                        </button>`;
                                    })
                                    .join('')}
                            </div>
                        ` : ''}
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
    const hasImages = _adminBoardDetailCommentImages.files && _adminBoardDetailCommentImages.files.length > 0;
    if (!content && !hasImages) {
        alert('댓글 내용을 입력해주세요.');
        return;
    }
    if (hasImages) {
        const uid = auth.currentUser?.uid;
        if (!uid) {
            alert('로그인 정보를 확인할 수 없습니다. 다시 로그인한 뒤 시도해 주세요.');
            return;
        }
    }
    setAdminBoardCommentSubmitBusy(true);
    try {
        let imageUrls = [];
        if (hasImages) {
            const uid = auth.currentUser.uid;
            const filesToUpload = Array.from(_adminBoardDetailCommentImages.files || []);
            _adminClearBoardDetailCommentFiles({ revoke: false });
            _adminRenderBoardDetailCommentPreview();
            imageUrls = await uploadBoardImages(filesToUpload, uid);
        } else {
            _adminClearBoardDetailCommentFiles();
            _adminRenderBoardDetailCommentPreview();
        }
        const result = await callableFunctions.addBoardCommentAsAdmin({
            postId,
            content,
            imageUrls,
            displayName: await getAdminDisplayName()
        });
        if (result?.data) {
            inputEl.value = '';
            _adminClearBoardDetailCommentFiles();
            _adminRenderBoardDetailCommentPreview();
            await renderBoardPostDetail(postId);
        }
    } catch (e) {
        console.error('관리자 댓글 등록 실패:', e);
        alert('댓글 등록에 실패했습니다: ' + (e?.message || e));
    } finally {
        setAdminBoardCommentSubmitBusy(false);
    }
}

/**
 * 본인이 단 관리자 댓글(authorId === 로그인 UID)은 이미 배포된 deleteBoardComment로 삭제합니다.
 * 다른 관리자가 단 댓글만 deleteBoardCommentAsAdmin 필요(Functions 배포).
 */
window.deleteAdminBoardComment = async function(commentId, postId, commentAuthorUid) {
    if (!commentId || !postId) return;
    if (!confirm('운영 관리창으로 등록한 이 댓글을 삭제할까요?')) return;
    const selfUid = auth.currentUser?.uid;
    if (!selfUid) {
        alert('로그인 정보를 확인할 수 없습니다.');
        return;
    }
    setAdminBoardCommentSubmitBusy(true);
    try {
        const author = String(commentAuthorUid || '').trim();
        /** 본인이 단 댓글: 오래 문서 등 author 비어 있어도 먼저 deleteBoardComment 시도 가능 */
        const preferSelfDelete = !author || author === selfUid;
        if (preferSelfDelete) {
            await callableFunctions.deleteBoardComment({ commentId, postId });
        } else {
            await callableFunctions.deleteBoardCommentAsAdmin({ commentId, postId });
        }
        await renderBoardPostDetail(postId);
    } catch (e) {
        console.error('관리자 댓글 삭제 실패:', e);
        alert('댓글 삭제에 실패했습니다: ' + (e?.message || e));
    } finally {
        setAdminBoardCommentSubmitBusy(false);
    }
};

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
