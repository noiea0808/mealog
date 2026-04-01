/**
 * 관리자 > 모니터링 > 밀톡 관리 (feedPosts 실시간 대화)
 */
import { db, appId } from '../firebase.js';
import {
    attachReactionCountsToPosts,
    setFeedPostHiddenByAdmin,
    deleteFeedPostByAdmin
} from '../db/feed-posts.js';
import { escapeHtml, fetchAdminEmailsForUserIds, runAdminRefreshAction } from './utils.js';
import {
    collection,
    query,
    orderBy,
    limit,
    startAfter,
    getDocs,
    getCountFromServer
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

const LOUNGE_PAGE_SIZE = 50;
const ADMIN_LOUNGE_CACHE_TTL_MS = 3 * 60 * 1000;
const loungePageCache = new Map();

function invalidateLoungeMonitoringCache() {
    loungePageCache.clear();
}

let loungeCurrentPage = 1;
/** 전체 feedPosts 문서 수(집계) — 번호 1=첫 메시지 계산용 */
let loungeTotalCount = null;
/** 페이지별 마지막 문서 스냅샷 — desc 페이지에서 이 문서 다음(더 과거)부터 이어짐 */
const loungeLastSnapByPage = {};
/** 밀톡 목록을 한 번이라도 성공적으로 불러온 뒤에만 페이지 이동 등이 이어집니다 */
let adminLoungeMonitoringLoaded = false;

function resetLoungePagination() {
    loungeCurrentPage = 1;
    loungeTotalCount = null;
    Object.keys(loungeLastSnapByPage).forEach((k) => delete loungeLastSnapByPage[k]);
}

async function fetchLoungeChatPageFromNetwork(page) {
    const postsColl = collection(db, 'artifacts', appId, 'feedPosts');

    if (page === 1) {
        const countSnap = await getCountFromServer(query(postsColl));
        loungeTotalCount = countSnap.data().count;
        if (!loungeTotalCount) {
            return { items: [], hasMore: false, empty: true };
        }
    } else if (loungeTotalCount == null || loungeTotalCount < 1) {
        return { items: [], hasMore: false, empty: true };
    }

    let q = query(postsColl, orderBy('timestamp', 'desc'), limit(LOUNGE_PAGE_SIZE));
    if (page > 1) {
        const prevLast = loungeLastSnapByPage[page - 1];
        if (!prevLast) return { items: [], hasMore: false, empty: true };
        q = query(postsColl, orderBy('timestamp', 'desc'), startAfter(prevLast), limit(LOUNGE_PAGE_SIZE));
    }
    const snapshot = await getDocs(q);
    const list = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (snapshot.docs.length > 0) {
        loungeLastSnapByPage[page] = snapshot.docs[snapshot.docs.length - 1];
    }
    const withReactions = await attachReactionCountsToPosts(list);
    const hasMore = snapshot.docs.length === LOUNGE_PAGE_SIZE;
    return { items: withReactions, hasMore, empty: snapshot.docs.length === 0 };
}

/** TTL 내 동일 페이지는 getDocs/getCount 생략 */
async function fetchLoungeChatPage(page) {
    const ent = loungePageCache.get(page);
    const now = Date.now();
    if (ent && now - ent.ts < ADMIN_LOUNGE_CACHE_TTL_MS) {
        loungeTotalCount = ent.totalCount;
        if (ent.lastSnap) loungeLastSnapByPage[page] = ent.lastSnap;
        return {
            items: ent.items,
            hasMore: ent.hasMore,
            empty: ent.empty
        };
    }
    const res = await fetchLoungeChatPageFromNetwork(page);
    loungePageCache.set(page, {
        ts: now,
        totalCount: loungeTotalCount,
        lastSnap: loungeLastSnapByPage[page] ?? null,
        items: res.items,
        hasMore: res.hasMore,
        empty: res.empty
    });
    return res;
}

function formatTs(post) {
    const ts = post.timestamp;
    if (!ts) return '-';
    try {
        const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
        return Number.isFinite(d.getTime()) ? d.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '-';
    } catch (_) {
        return '-';
    }
}

function reactionLabel(rc) {
    const c = rc || { like: 0, thumbs: 0, check: 0 };
    const parts = [];
    if (c.like) parts.push(`❤${c.like}`);
    if (c.thumbs) parts.push(`👍${c.thumbs}`);
    if (c.check) parts.push(`✓${c.check}`);
    return parts.length ? parts.join(' ') : '—';
}

/** 관리자 목록: 첨부 사진 썸네일(최대 4장 + 나머지 건수) */
function loungeImageThumbsHtml(urls) {
    if (!Array.isArray(urls) || !urls.length) return '';
    const maxShow = 4;
    const slice = urls.slice(0, maxShow);
    const rest = urls.length > maxShow ? urls.length - maxShow : 0;
    const imgs = slice
        .map((u) => {
            const src = escapeHtml(String(u));
            return `<img src="${src}" alt="" class="inline-block h-24 w-auto max-w-[140px] rounded-md border border-slate-200 object-contain bg-slate-50 align-top mr-1.5 mb-1" loading="lazy" decoding="async">`;
        })
        .join('');
    const more =
        rest > 0
            ? `<span class="inline-flex items-center rounded border border-slate-200 bg-slate-100 px-1.5 py-2 text-xs font-bold text-slate-600">+${rest}</span>`
            : '';
    return `<div class="mt-1.5 flex flex-wrap items-start gap-0">${imgs}${more}</div>`;
}

export async function renderLoungeChatManagement() {
    const container = document.getElementById('loungeChatManagementTableWrap');
    const pagEl = document.getElementById('loungeChatPagination');
    if (!container) return;

    container.innerHTML =
        '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i><p>로딩 중...</p></div>';

    try {
        let { items, hasMore, empty } = await fetchLoungeChatPage(loungeCurrentPage);
        if (empty && loungeCurrentPage > 1) {
            loungeCurrentPage = Math.max(1, loungeCurrentPage - 1);
            await renderLoungeChatManagement();
            return;
        }

        const total = loungeTotalCount ?? 0;

        const authorIds = [...new Set(items.map((p) => String(p.authorId || '').trim()).filter(Boolean))];
        const authorEmailMap = await fetchAdminEmailsForUserIds(authorIds);

        if (empty && loungeCurrentPage === 1) {
            container.innerHTML = '<p class="text-center py-8 text-slate-400">밀톡 메시지가 없습니다.</p>';
            if (pagEl) pagEl.innerHTML = '';
            adminLoungeMonitoringLoaded = true;
            return;
        }

        /* 목록은 최신순(desc). 번호는 1=가장 오래된 첫 메시지 → n = total - 페이지오프셋 - 행인덱스 */
        const rows = items
            .map((p, idx) => {
                const n = total - (loungeCurrentPage - 1) * LOUNGE_PAGE_SIZE - idx;
                const text = String(p.text || p.content || '').trim();
                const previewRaw = text.slice(0, 120) + (text.length > 120 ? '…' : '');
                const thumbs = loungeImageThumbsHtml(p.imageUrls);
                const hidden = p.isHidden === true;
                const aid = String(p.authorId || '').trim();
                const authorEmail = aid ? authorEmailMap.get(aid) || '' : '';
                const authorSub = authorEmail
                    ? `<span class="block text-xs text-slate-500 mt-0.5 break-all">${escapeHtml(authorEmail)}</span>`
                    : aid
                      ? `<span class="text-xs text-slate-400">(${escapeHtml(aid.slice(0, 8))}…)</span>`
                      : '';
                const pid = escapeHtml(p.id);
                return `<tr class="border-b border-slate-100 ${hidden ? 'bg-slate-50' : ''} hover:bg-slate-50/80">
                <td class="px-2 py-2 whitespace-nowrap"><input type="checkbox" class="lounge-chat-row-cb w-4 h-4 rounded border-slate-300" data-post-id="${pid}"></td>
                <td class="px-2 py-2 text-sm text-slate-600 tabular-nums">${n}</td>
                <td class="px-2 py-2 text-sm text-slate-700 whitespace-nowrap">${escapeHtml(formatTs(p))}</td>
                <td class="px-2 py-2 text-sm text-slate-800 min-w-0"><div class="min-w-0">${escapeHtml(p.authorNickname || '익명')}${authorSub ? `<div class="mt-0.5">${authorSub}</div>` : ''}</div></td>
                <td class="px-2 py-2 text-sm text-slate-700 whitespace-nowrap">${reactionLabel(p.reactionCounts)}</td>
                <td class="px-2 py-2 text-sm text-slate-700 max-w-md min-w-[12rem] align-top"><div class="min-w-0 space-y-1"><div class="truncate" title="${escapeHtml(previewRaw)}">${escapeHtml(previewRaw)}</div>${thumbs}</div>${
                    hidden ? ' <span class="text-xs font-bold text-amber-600">숨김</span>' : ''
                }</td>
            </tr>`;
            })
            .join('');

        container.innerHTML = `
            <div class="overflow-x-auto border border-slate-200 rounded-xl">
                <table class="w-full text-left border-collapse min-w-[760px]">
                    <thead>
                        <tr class="bg-slate-100 text-slate-700 text-xs font-black uppercase tracking-wide">
                            <th class="px-2 py-2 w-10">선택</th>
                            <th class="px-2 py-2 w-14">번호</th>
                            <th class="px-2 py-2">일시</th>
                            <th class="px-2 py-2 min-w-[9rem]">작성자</th>
                            <th class="px-2 py-2 w-32">반응</th>
                            <th class="px-2 py-2">내용</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;

        renderLoungePagination(hasMore);
        adminLoungeMonitoringLoaded = true;
    } catch (e) {
        adminLoungeMonitoringLoaded = false;
        console.error('renderLoungeChatManagement', e);
        container.innerHTML = '<p class="text-center py-8 text-red-500">불러오지 못했습니다.</p>';
        if (pagEl) pagEl.innerHTML = '';
    }
}

function renderLoungePagination(hasMore) {
    const pagEl = document.getElementById('loungeChatPagination');
    if (!pagEl) return;
    const prevDisabled = loungeCurrentPage <= 1 ? 'opacity-40 pointer-events-none' : '';
    const nextDisabled = !hasMore ? 'opacity-40 pointer-events-none' : '';
    pagEl.innerHTML = `
        <div class="flex items-center justify-center gap-3 flex-wrap">
            <button type="button" class="lounge-pag-prev px-4 py-2 rounded-xl text-sm font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 ${prevDisabled}">이전</button>
            <span class="text-sm font-bold text-slate-600">페이지 <span class="tabular-nums">${loungeCurrentPage}</span> · ${LOUNGE_PAGE_SIZE}건씩 · 위쪽이 최신 · 번호 1=첫 메시지</span>
            <button type="button" class="lounge-pag-next px-4 py-2 rounded-xl text-sm font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 ${nextDisabled}">다음</button>
        </div>`;
    const prev = pagEl.querySelector('.lounge-pag-prev');
    const next = pagEl.querySelector('.lounge-pag-next');
    if (prev && !prev.classList.contains('pointer-events-none')) {
        prev.onclick = () => {
            if (loungeCurrentPage <= 1) return;
            loungeCurrentPage -= 1;
            void renderLoungeChatManagement();
        };
    }
    if (next && !next.classList.contains('pointer-events-none')) {
        next.onclick = () => {
            loungeCurrentPage += 1;
            void renderLoungeChatManagement();
        };
    }
}

function getSelectedLoungePostIds() {
    return Array.from(document.querySelectorAll('.lounge-chat-row-cb:checked'))
        .map((el) => el.getAttribute('data-post-id'))
        .filter(Boolean);
}

window.refreshLoungeChatManagement = async function () {
    await runAdminRefreshAction(document.getElementById('adminRefreshLoungeBtn'), async () => {
        adminLoungeMonitoringLoaded = false;
        invalidateLoungeMonitoringCache();
        resetLoungePagination();
        await renderLoungeChatManagement();
    });
};

window.adminLoungeBulkHide = async function () {
    const ids = getSelectedLoungePostIds();
    if (!ids.length) {
        alert('숨길 메시지를 선택해주세요.');
        return;
    }
    try {
        for (const id of ids) await setFeedPostHiddenByAdmin(id, true);
        invalidateLoungeMonitoringCache();
        alert(`${ids.length}건을 숨겼습니다.`);
        await renderLoungeChatManagement();
    } catch (e) {
        console.error(e);
        alert('실패: ' + (e?.message || e));
    }
};

window.adminLoungeBulkUnhide = async function () {
    const ids = getSelectedLoungePostIds();
    if (!ids.length) {
        alert('숨김 해제할 메시지를 선택해주세요.');
        return;
    }
    try {
        for (const id of ids) await setFeedPostHiddenByAdmin(id, false);
        invalidateLoungeMonitoringCache();
        alert(`${ids.length}건 숨김을 해제했습니다.`);
        await renderLoungeChatManagement();
    } catch (e) {
        console.error(e);
        alert('실패: ' + (e?.message || e));
    }
};

window.adminLoungeBulkDelete = async function () {
    const ids = getSelectedLoungePostIds();
    if (!ids.length) {
        alert('삭제할 메시지를 선택해주세요.');
        return;
    }
    if (!confirm(`선택한 ${ids.length}건을 삭제하시겠습니까?`)) return;
    try {
        for (const id of ids) await deleteFeedPostByAdmin(id);
        invalidateLoungeMonitoringCache();
        alert(`${ids.length}건을 삭제했습니다.`);
        resetLoungePagination();
        await renderLoungeChatManagement();
    } catch (e) {
        console.error(e);
        alert('실패: ' + (e?.message || e));
    }
};
