/**
 * 관리자 모니터링: 모먼트(타임라인) 공유·신고·일괄 처리
 */
import { db, appId, refreshAppCheckTokenBeforeFirestore } from '../firebase.js';
import { getReportsAggregateByGroupKeys } from '../db.js';
import { REPORT_REASONS } from '../constants.js';
import { escapeHtml, fetchAdminEmailsForUserIds, runAdminRefreshAction } from './utils.js';
import {
    collection,
    collectionGroup,
    getDocs,
    query,
    orderBy,
    limit,
    startAfter,
    doc,
    getDoc,
    getCountFromServer,
    where,
    writeBatch,
    deleteDoc,
    Timestamp
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

// 피드 관리 렌더링
let feedFilters = {
    shared: 'all', // 'all', 'yes', 'no'
    hasPhotos: 'all', // 'all', 'yes', 'no'
    banned: 'all' // 'all', 'yes', 'no'
};
let feedCurrentPage = 1;
const feedPageSize = 20;
let feedLastDocsByPage = {};
let feedTotalCount = 0;
/** false면 getCountFromServer 실패 등 — 목록은 있으나 전체 건수·번호 역산 불가 */
let feedMealTotalCountKnown = true;
/** 마지막 페이지 쿼리가 pageSize만큼 찼는지(다음 페이지 존재 추정) */
let feedLastPageHasMore = false;
/** 현재 페이지에 실제로 표시되는 행 수(필터 전 원본 페이지 기준은 getFeedPage에서 docs.length) */
let feedLastPageRowCount = 0;

function computeFeedAdminTotalPages() {
    if (feedMealTotalCountKnown) {
        return Math.max(1, Math.ceil(feedTotalCount / feedPageSize));
    }
    return Math.max(1, feedCurrentPage + (feedLastPageHasMore ? 1 : 0));
}

/** 모먼트 목록을 한 번이라도 성공적으로 불러온 뒤에만 필터·페이지 이동이 Firestore를 다시 칩니다 */
let adminFeedMonitoringLoaded = false;
// 공유 키 캐시 — ensureSharedKeysForMeals에서 채움; 무효화 시 null
let feedSharedKeysCache = null;

/** 모먼트: 페이지 쿼리·신고 집계·유저 설정 조회 TTL 캐시 (새로고침·데이터 변경 시 무효화) */
const ADMIN_FEED_CACHE_TTL_MS = 3 * 60 * 1000;
const feedQueryCache = new Map();
let feedReportsAggCache = { ts: 0, map: null };
const feedUserSettingsCache = new Map();

function invalidateAdminFeedMonitoringCache() {
    feedQueryCache.clear();
    feedReportsAggCache = { ts: 0, map: null };
    feedUserSettingsCache.clear();
    feedSharedKeysCache = null;
    feedMealTotalCountKnown = true;
}

/**
 * 모먼트 관리: 기록·공유 문서 삭제 (일반 = users/…/meals + sharedPhotos, 베스트/일간/인사이트 = sharedPhotos만)
 */
async function adminDeleteFeedPostInternal({ mealId, userId, isBest, isDaily, isInsight }) {
    if (!mealId || !userId) throw new Error('mealId 또는 userId가 없습니다.');
    await refreshAppCheckTokenBeforeFirestore();
    if (isBest || isDaily || isInsight) {
        await deleteDoc(doc(db, 'artifacts', appId, 'sharedPhotos', mealId));
        return;
    }
    const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
    const sharedQuery = query(sharedColl, where('userId', '==', userId), where('entryId', '==', mealId));
    const sharedSnap = await getDocs(sharedQuery);
    for (const d of sharedSnap.docs) {
        await deleteDoc(d.ref);
    }
    const mealRef = doc(db, 'artifacts', appId, 'users', userId, 'meals', mealId);
    await deleteDoc(mealRef);
}

function feedQueryCacheKey(page) {
    return `${mealsAdminUseDateTimeSort ? 'dt' : 'd'}_${page}`;
}

async function getReportsAggregateCached() {
    const now = Date.now();
    if (feedReportsAggCache.map && now - feedReportsAggCache.ts < ADMIN_FEED_CACHE_TTL_MS) {
        return feedReportsAggCache.map;
    }
    const map = await getReportsAggregateByGroupKeys();
    feedReportsAggCache = { ts: now, map };
    return map;
}

/**
 * 동일 정렬·페이지에 대해 TTL 내 재요청 시 getDocs/getCount 생략
 */
async function getFeedPageWithCache(page) {
    const key = feedQueryCacheKey(page);
    const ent = feedQueryCache.get(key);
    const now = Date.now();
    if (ent && now - ent.ts < ADMIN_FEED_CACHE_TTL_MS) {
        if (page === 1) feedTotalCount = ent.totalCount;
        if (ent.lastDoc) feedLastDocsByPage[page] = ent.lastDoc;
        if (typeof ent.countKnown === 'boolean') feedMealTotalCountKnown = ent.countKnown;
        feedLastPageHasMore = Array.isArray(ent.items) && ent.items.length >= feedPageSize;
        feedLastPageRowCount =
            typeof ent.rowCount === 'number' ? ent.rowCount : Array.isArray(ent.items) ? ent.items.length : 0;
        return ent.items;
    }
    const { items } = await getFeedPage({ page, pageSize: feedPageSize });
    feedQueryCache.set(key, {
        ts: now,
        items,
        totalCount: feedTotalCount,
        lastDoc: feedLastDocsByPage[page] ?? null,
        countKnown: feedMealTotalCountKnown,
        rowCount: feedLastPageRowCount
    });
    return items;
}

/**
 * true: collectionGroup(meals) 를 date DESC, time DESC 로 페이지네이션 (관리자 모니터링 기본).
 * false: 인덱스 미배포 등으로 실패 시 date DESC 만 사용 (폴백).
 */
let mealsAdminUseDateTimeSort = true;

// 피드: 전체 타임라인(meals) 페이지 단위 조회 — 사진 유무와 관계없이 모든 게시물 표시, 중복 없음
async function getFeedPage(options = {}) {
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? feedPageSize;
    const startAfterDoc = page === 1 ? null : (feedLastDocsByPage[page - 1] ?? null);
    const mealsGroup = collectionGroup(db, 'meals');

    const orderParts = mealsAdminUseDateTimeSort
        ? [orderBy('date', 'desc'), orderBy('time', 'desc')]
        : [orderBy('date', 'desc')];

    try {
        await refreshAppCheckTokenBeforeFirestore();
        if (page === 1) {
            try {
                const countSnap = await getCountFromServer(query(mealsGroup, ...orderParts));
                feedTotalCount = countSnap.data().count;
                feedMealTotalCountKnown = true;
            } catch (cntErr) {
                console.warn(
                    '[관리자 모먼트] 전체 개수 집계(getCount) 실패 — 목록만 조회합니다.',
                    cntErr?.code || cntErr?.message || cntErr
                );
                feedMealTotalCountKnown = false;
                feedTotalCount = 0;
            }
        }
        const listQ = startAfterDoc
            ? query(mealsGroup, ...orderParts, startAfter(startAfterDoc), limit(pageSize))
            : query(mealsGroup, ...orderParts, limit(pageSize));
        const snapshot = await getDocs(listQ);
        const docs = snapshot.docs;
        feedLastPageRowCount = docs.length;
        feedLastPageHasMore = docs.length === pageSize;
        const lastDoc = docs.length > 0 ? docs[docs.length - 1] : null;
        if (lastDoc) feedLastDocsByPage[page] = lastDoc;

        const items = [];
        for (const d of docs) {
            const pathParts = d.ref.path.split('/');
            const userId = pathParts.length >= 4 ? pathParts[pathParts.indexOf('users') + 1] : '';
            const mealId = d.id;
            const data = d.data();
            items.push({
                id: mealId,
                userId,
                ...data
            });
        }
        return { items, totalCount: feedTotalCount, lastDoc, hasMore: docs.length === pageSize };
    } catch (e) {
        if (page === 1 && mealsAdminUseDateTimeSort && e?.code === 'failed-precondition') {
            console.warn(
                '관리자 모먼트 피드: date+time 복합 인덱스가 없어 date만 사용합니다. `firebase deploy --only firestore:indexes` 적용 후 새로고침하면 기록 시각 순으로 정렬됩니다.',
                e?.message || e
            );
            mealsAdminUseDateTimeSort = false;
            feedLastDocsByPage = {};
            feedQueryCache.clear();
            return getFeedPage(options);
        }
        console.error('getFeedPage error:', e);
        throw e;
    }
}

/** 현재 페이지 meals 기준으로 공유 여부 조회. entryId+userId 일치 문서만 캐시에 넣음 (일간/베스트 등 타입은 기존과 동일 한계). */
async function ensureSharedKeysForMeals(meals) {
    if (!Array.isArray(meals) || meals.length === 0) return;
    if (!feedSharedKeysCache) feedSharedKeysCache = new Set();
    const byUser = new Map();
    for (const m of meals) {
        if (!m?.userId || !m?.id) continue;
        const key = `${m.userId}_${m.id}`;
        if (feedSharedKeysCache.has(key)) continue;
        if (!byUser.has(m.userId)) byUser.set(m.userId, new Set());
        byUser.get(m.userId).add(m.id);
    }
    if (byUser.size === 0) return;
    const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
    for (const [uid, idSet] of byUser) {
        const ids = [...idSet];
        for (let i = 0; i < ids.length; i += 10) {
            const chunk = ids.slice(i, i + 10);
            try {
                const q = query(
                    sharedColl,
                    where('userId', '==', uid),
                    where('entryId', 'in', chunk)
                );
                const snap = await getDocs(q);
                snap.docs.forEach((d) => {
                    const data = d.data();
                    const eid = data.entryId || data.mealId || null;
                    const u = data.userId;
                    if (u && eid) feedSharedKeysCache.add(`${u}_${eid}`);
                });
            } catch (e) {
                console.warn('ensureSharedKeysForMeals:', e?.message || e);
            }
        }
    }
}

async function renderFeedManagement() {
    const container = document.getElementById('feedManagementContainer');
    if (!container) return;
    
    container.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i><p>로딩 중...</p></div>';
    
    try {
        console.log('📋 피드 관리: 페이지', feedCurrentPage, '로드 중... (페이지 단위)');
        const allMeals = await getFeedPageWithCache(feedCurrentPage);
        await ensureSharedKeysForMeals(allMeals);
        
        // 필터 적용 (일반 게시물만 — 타임라인 전체 표시, 공유 여부는 캐시로 판별)
        console.log('🔍 필터 적용:', feedFilters);
        let filteredMeals = allMeals.filter(meal => {
            const isActuallyShared = feedSharedKeysCache && feedSharedKeysCache.has(`${meal.userId}_${meal.id}`);
            if (feedFilters.shared === 'yes' && !isActuallyShared) return false;
            if (feedFilters.shared === 'no' && isActuallyShared) return false;
            const hasPhotos = meal.photos && Array.isArray(meal.photos) && meal.photos.length > 0;
            if (feedFilters.hasPhotos === 'yes' && !hasPhotos) return false;
            if (feedFilters.hasPhotos === 'no' && hasPhotos) return false;
            const isBanned = meal.shareBanned === true;
            if (feedFilters.banned === 'yes' && !isBanned) return false;
            if (feedFilters.banned === 'no' && isBanned) return false;
            return true;
        });
        
        console.log(
            `✅ 필터 적용 후: ${filteredMeals.length}개 (페이지 ${feedCurrentPage}${feedMealTotalCountKnown ? ` / 총 ${feedTotalCount}개` : ' / 전체 수 집계 생략'})`
        );
        
        // 서버가 date+time 순이면 이미 맞음. 동일 시각·구문서 보정용으로 페이지 내 한 번 더 정렬
        filteredMeals.sort((a, b) => {
            // 모든 게시물을 동일한 기준으로 정렬: date + time 또는 timestamp에서 date 추출
            const getSortTime = (meal) => {
                // date 필드가 있으면 date + time 사용
                if (meal.date) {
                    const dateStr = meal.date;
                    const timeStr = meal.time || '23:59'; // time이 없으면 하루의 마지막 시간으로
                    try {
                        return new Date(`${dateStr}T${timeStr}:00`).getTime();
                    } catch (e) {
                        // 날짜 파싱 실패 시 date만 사용
                        return new Date(dateStr).getTime();
                    }
                }
                
                // date 필드가 없으면 timestamp에서 date 추출
                if (meal.timestamp) {
                    try {
                        const timestampDate = new Date(meal.timestamp);
                        // timestamp의 날짜 부분만 사용 (시간은 00:00:00으로)
                        const dateOnly = new Date(timestampDate.getFullYear(), timestampDate.getMonth(), timestampDate.getDate());
                        return dateOnly.getTime();
                    } catch (e) {
                        // timestamp 파싱 실패 시 timestamp 그대로 사용
                        return new Date(meal.timestamp).getTime();
                    }
                }
                
                return 0;
            };
            
            const timeA = getSortTime(a);
            const timeB = getSortTime(b);
            
            // 타임스탬프로 정렬 (최신순: 큰 값이 먼저)
            if (timeB !== timeA) {
                return timeB - timeA;
            }
            
            // 타임스탬프가 같으면 timestamp로 세부 정렬
            const timestampA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
            const timestampB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
            if (timestampB !== timestampA) {
                return timestampB - timestampA;
            }
            
            // 모두 같으면 date 문자열로 정렬
            const dateA = a.date || '';
            const dateB = b.date || '';
            return dateB.localeCompare(dateA);
        });
        
        // 페이지 단위 로드 결과에서만 표시
        const totalPages = computeFeedAdminTotalPages();
        const paginatedMeals = filteredMeals;
        
        // 사용자 정보 가져오기 (타임라인 게시물은 설정에서 닉네임/아이콘 조회)
        const userInfoMap = new Map();
        const userIdsToFetch = [...new Set(paginatedMeals.map(m => m.userId).filter(Boolean))];
        const [emailMap] = await Promise.all([
            fetchAdminEmailsForUserIds(userIdsToFetch),
            Promise.all(
                userIdsToFetch.map(async (uid) => {
                    if (userInfoMap.has(uid)) return;
                    const now = Date.now();
                    const hit = feedUserSettingsCache.get(uid);
                    if (hit && now - hit.ts < ADMIN_FEED_CACHE_TTL_MS) {
                        userInfoMap.set(uid, { nickname: hit.nickname, icon: hit.icon, email: '' });
                        return;
                    }
                    try {
                        const settingsSnap = await getDoc(doc(db, 'artifacts', appId, 'users', uid, 'config', 'settings'));
                        if (settingsSnap.exists()) {
                            const s = settingsSnap.data();
                            const row = {
                                nickname: s.profile?.nickname || '익명',
                                icon: s.profile?.icon || '🐻',
                                email: ''
                            };
                            feedUserSettingsCache.set(uid, { ts: now, nickname: row.nickname, icon: row.icon });
                            userInfoMap.set(uid, row);
                        }
                    } catch (e) {
                        console.warn('사용자 정보 조회 실패:', uid, e);
                    }
                })
            )
        ]);
        userIdsToFetch.forEach((uid) => {
            if (!userInfoMap.has(uid)) userInfoMap.set(uid, { nickname: '익명', icon: '🐻', email: '' });
            const row = userInfoMap.get(uid);
            row.email = emailMap.get(uid) || '';
        });
        
        if (paginatedMeals.length === 0) {
            container.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-images text-2xl mb-2"></i><p>게시물이 없습니다.</p></div>';
            adminFeedMonitoringLoaded = true;
            return;
        }
        
        const reportsMap = await getReportsAggregateCached();
        window._feedReportDetails = {};

        const fmtDateTimeParts = (meal) => {
            if (meal.date) {
                try {
                    const t = meal.time || '00:00';
                    const d = new Date(`${meal.date}T${t}`);
                    const datePart = d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });
                    const timePart = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
                    return { date: datePart, time: timePart };
                } catch (_) {
                    return { date: meal.date, time: meal.time || '-' };
                }
            }
            if (meal.timestamp) {
                try {
                    const d = new Date(meal.timestamp);
                    const datePart = d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });
                    const timePart = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
                    return { date: datePart, time: timePart };
                } catch (_) {}
            }
            return { date: '-', time: '-' };
        };

        const getCategoryCell = (major, minor) => {
            const m1 = (major || '').toString().trim();
            const m2 = (minor || '').toString().trim();
            if (!m1 && !m2) return '<span class="text-slate-300 text-xs">-</span>';
            return `
                <div class="text-xs leading-tight text-center">
                    ${m1 ? `<div class="font-bold text-slate-700 break-words">${escapeHtml(m1)}</div>` : ''}
                    ${m2 ? `<div class="text-slate-500 break-words mt-0.5">${escapeHtml(m2)}</div>` : ''}
                </div>
            `;
        };

        const rowsHtml = paginatedMeals.map((meal, rowIdx) => {
            const targetGroupKey = meal.isBestShare
                ? `best_${meal.id}`
                : meal.isDailyShare
                    ? `daily_${meal.date || ''}_${meal.userId}`
                    : meal.isInsightShare
                        ? `insight_${meal.dateRangeText || ''}_${meal.userId}`
                        : `entry_${meal.id}_${meal.userId}`;
            const reportInfo = reportsMap[targetGroupKey];
            if (reportInfo && reportInfo.count > 0) window._feedReportDetails[targetGroupKey] = reportInfo.byReason;
            const reportBadgeHtml = (reportInfo && reportInfo.count > 0)
                ? `<button type="button" class="px-2 py-0.5 bg-red-100 text-red-700 text-xs font-bold rounded hover:bg-red-200" onclick="window.showReportDetailPopup('${String(targetGroupKey).replace(/'/g, "\\'")}')">🚩 ${reportInfo.count}</button>`
                : '';

            const baseAuthor = userInfoMap.get(meal.userId) || { nickname: '익명', icon: '🐻', email: '' };
            const userInfo =
                meal.isBestShare || meal.isDailyShare || meal.isInsightShare
                    ? {
                          ...baseAuthor,
                          nickname: meal.userNickname || baseAuthor.nickname,
                          icon: meal.userIcon || baseAuthor.icon
                      }
                    : baseAuthor;

            const isShared = feedSharedKeysCache && feedSharedKeysCache.has(`${meal.userId}_${meal.id}`);
            const hasLocalSharedPhotos = meal.sharedPhotos && Array.isArray(meal.sharedPhotos) && meal.sharedPhotos.length > 0;
            const hasPhotos = (Array.isArray(meal.photos) && meal.photos.length > 0) || Boolean(meal.photoUrl);
            const isBanned = meal.shareBanned === true;
            const hasDataMismatch = hasLocalSharedPhotos && !isShared;

            const typeLabel = meal.isBestShare
                ? '베스트 공유'
                : meal.isDailyShare
                    ? '일간보기 공유'
                    : meal.isInsightShare
                        ? '인사이트 공유'
                        : '일반';

            const whereTag = meal.place || meal.snackPlace || '';
            const whereSubTag = meal.placeDetail || meal.placeMemo || '';
            const whatTag = meal.category || meal.mealType || meal.snackType || '';
            const whatSubTag = meal.menuDetail || meal.snackDetail || '';
            const withTag = meal.withWhom || '';
            const withSubTag = meal.withWhomDetail || '';
            const ratingVal = meal.snackRating ?? meal.rating;
            const satietyVal = meal.satiety;
            const photoUrls = (() => {
                if (Array.isArray(meal.photos) && meal.photos.length > 0) {
                    return meal.photos.map((u) => String(u || '').trim()).filter(Boolean);
                }
                if (meal.photoUrl && String(meal.photoUrl).trim()) {
                    return [String(meal.photoUrl).trim()];
                }
                return [];
            })();
            const firstPhoto = photoUrls[0] || '';
            const rowBg = hasDataMismatch ? 'bg-yellow-50' : (isBanned ? 'bg-red-50' : '');
            const dateTime = fmtDateTimeParts(meal);
            const newestOrder = (feedCurrentPage - 1) * feedPageSize + rowIdx + 1;
            const oldFirstNumber = feedMealTotalCountKnown
                ? Math.max(1, (feedTotalCount || 0) - newestOrder + 1)
                : '—';
            const slotKey = String(meal.slotId || '').toLowerCase();
            const slotLabelMap = {
                pre_morning: '아침전',
                morning: '아침',
                snack1: '오전간식',
                snack2: '오후간식',
                night: '야식',
                breakfast: '아침',
                lunch: '점심',
                dinner: '저녁',
                snack: '간식',
                before_breakfast: '아침전',
                after_breakfast: '아침후',
                before_lunch: '점심전',
                after_lunch: '점심후',
                before_dinner: '저녁전',
                after_dinner: '저녁후'
            };
            // 식사구분은 slotId만 기준으로 표시 (mealType/snackType은 '무엇을' 성격 데이터)
            const mealSlotLabel = slotLabelMap[slotKey] || '-';
            const mealDateLabel = (() => {
                const raw = String(meal.date || '').trim();
                if (!raw) return '';
                try {
                    const d = new Date(raw);
                    if (Number.isNaN(d.getTime())) return raw;
                    // ko-KR은 "2026. 03. 27." 형태 → 공백 제거해서 "2026.03.27."로
                    return d
                        .toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })
                        .replace(/\s+/g, '');
                } catch (_) {
                    return raw;
                }
            })();
            const mealSlotDisplay = { date: mealDateLabel, label: mealSlotLabel };

            return `
                <tr class="border-t border-slate-200 ${rowBg}">
                    <td class="px-3 py-3 align-middle text-center border-r border-slate-200">
                        <input type="checkbox" class="feed-item-checkbox" data-meal-id="${meal.id}" data-user-id="${meal.userId}" ${meal.isBestShare ? 'data-is-best="true"' : ''} ${meal.isDailyShare ? 'data-is-daily="true"' : ''} ${meal.isInsightShare ? 'data-is-insight="true"' : ''}>
                    </td>
                    <td class="px-2 py-3 align-middle text-center border-r border-slate-200 w-[56px] min-w-[56px]">
                        <div class="flex flex-col items-center gap-1">
                            <span class="text-xs font-bold text-slate-600">${oldFirstNumber}</span>
                            ${isShared ? '<span class="px-1.5 py-0.5 bg-emerald-100 text-emerald-700 text-[10px] font-bold rounded">공유</span>' : ''}
                        </div>
                    </td>
                    <td class="px-2 py-3 align-middle text-center w-[112px] min-w-[112px] max-w-[112px] border-r border-slate-200">
                        <div class="text-xs text-slate-700 font-semibold leading-tight whitespace-nowrap">${escapeHtml(dateTime.date)}</div>
                        <div class="text-[11px] text-slate-500 leading-tight mt-0.5 whitespace-nowrap">${escapeHtml(dateTime.time)}</div>
                        <div class="text-[10px] text-slate-400 break-all leading-tight mt-1 font-mono text-left px-0.5" title="게시물 ID">${escapeHtml(String(meal.id || '-'))}</div>
                    </td>
                    <td class="px-3 py-3 align-middle w-[176px] max-w-[176px] text-center border-r border-slate-200">
                        <div class="flex flex-col items-center gap-1 overflow-hidden">
                            <span class="text-sm font-semibold text-slate-800 break-words">${userInfo.icon} ${escapeHtml(userInfo.nickname)}</span>
                            ${userInfo.email ? `<span class="text-[11px] text-slate-500 break-all leading-tight">${escapeHtml(userInfo.email)}</span>` : ''}
                            <span class="px-2 py-0.5 bg-slate-100 text-slate-700 text-xs font-bold rounded">${typeLabel}</span>
                        </div>
                    </td>
                    <td class="px-2 py-3 align-middle w-[92px] max-w-[92px] text-center border-r border-slate-200 overflow-hidden">
                        <div class="inline-flex flex-col items-center justify-center px-2 py-1 rounded bg-slate-100 text-slate-700 text-xs font-bold leading-tight">
                            ${mealSlotDisplay.date ? `<span class="whitespace-nowrap">${escapeHtml(String(mealSlotDisplay.date))}</span>` : ''}
                            <span class="whitespace-nowrap">${escapeHtml(String(mealSlotDisplay.label))}</span>
                        </div>
                    </td>
                    <td class="px-3 py-3 align-middle w-[102px] max-w-[102px] text-center border-r border-slate-200 overflow-hidden">${getCategoryCell(whereTag, whereSubTag)}</td>
                    <td class="px-3 py-3 align-middle w-[102px] max-w-[102px] text-center border-r border-slate-200 overflow-hidden">${getCategoryCell(whatTag, whatSubTag)}</td>
                    <td class="px-3 py-3 align-middle w-[102px] max-w-[102px] text-center border-r border-slate-200 overflow-hidden">${getCategoryCell(withTag, withSubTag)}</td>
                    <td class="px-3 py-3 align-middle w-[92px] max-w-[92px] text-center border-r border-slate-200 overflow-hidden">
                        <div class="text-xs leading-tight">
                            <div class="font-bold text-slate-700 break-words">만족도 ${escapeHtml(String(ratingVal ?? '-'))}</div>
                            <div class="font-bold text-slate-600 break-words mt-0.5">포만감 ${escapeHtml(String(satietyVal ?? '-'))}</div>
                        </div>
                    </td>
                    <td class="px-2 py-3 align-middle text-center w-[208px] min-w-[208px] border-r border-slate-200">
                        ${photoUrls.length > 0
                            ? `<div class="relative inline-block mx-auto max-w-full">
                                <button type="button" class="group p-0 border-0 bg-transparent cursor-zoom-in rounded-lg" onclick='window.openAdminFeedPhotoViewer(${JSON.stringify(photoUrls)}, 0)' title="클릭하여 원본 크기로 보기" aria-label="사진 원본 보기">
                                    <span class="relative block mx-auto w-[200px] h-[200px] rounded-lg border border-slate-200 bg-white overflow-hidden">
                                        <img src="${escapeHtml(firstPhoto)}" alt="" class="absolute inset-0 w-full h-full object-contain pointer-events-none">
                                        ${
                                            photoUrls.length > 1
                                                ? `<span class="absolute top-1 right-1 z-10 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] font-bold leading-none pointer-events-none shadow-sm">1/${photoUrls.length}</span>`
                                                : ''
                                        }
                                    </span>
                                </button>
                            </div>`
                            : '<span class="text-slate-300 text-xs">-</span>'}
                    </td>
                    <td class="px-3 py-3 align-middle w-[240px] min-w-[240px] border-r border-slate-200">
                        ${meal.comment
                            ? `<div class="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto text-left">${escapeHtml(String(meal.comment))}</div>`
                            : '<span class="text-slate-300 text-xs">-</span>'}
                    </td>
                    <td class="px-2 py-3 align-middle text-center whitespace-nowrap w-[72px] min-w-[72px]">
                        <div class="inline-flex flex-wrap justify-center items-center gap-1">
                            ${isShared ? '<span class="px-2 py-0.5 bg-emerald-100 text-emerald-700 text-xs font-bold rounded">공유됨</span>' : ''}
                            ${isBanned ? '<span class="px-2 py-0.5 bg-red-100 text-red-700 text-xs font-bold rounded">금지됨</span>' : ''}
                            ${hasDataMismatch ? '<span class="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs font-bold rounded">데이터 불일치</span>' : ''}
                            ${reportBadgeHtml}
                            ${hasDataMismatch ? `<button onclick="window.syncSharedPhotos('${meal.id}', '${meal.userId}')" class="px-2 py-0.5 bg-yellow-600 text-white rounded text-xs font-bold hover:bg-yellow-700 transition-colors">동기화</button>` : ''}
                        </div>
                    </td>
                    <td class="px-2 py-3 align-middle text-center w-[56px] min-w-[56px]">
                        <button type="button" class="admin-feed-row-delete px-2 py-1 bg-red-50 text-red-700 text-xs font-bold rounded hover:bg-red-100 border border-red-200 transition-colors" data-meal-id="${meal.id}" data-user-id="${meal.userId}" ${meal.isBestShare ? 'data-is-best="true"' : ''} ${meal.isDailyShare ? 'data-is-daily="true"' : ''} ${meal.isInsightShare ? 'data-is-insight="true"' : ''}>삭제</button>
                    </td>
                </tr>
            `;
        }).join('');

        container.innerHTML = `
            <div class="overflow-x-auto border border-slate-200 rounded-xl bg-white">
                <table class="w-full table-fixed text-left">
                    <thead class="bg-slate-50">
                        <tr class="text-xs text-slate-500">
                            <th class="px-3 py-3 font-bold w-10 text-center whitespace-nowrap border-r border-slate-200">선택</th>
                            <th class="px-2 py-3 font-bold text-center whitespace-nowrap w-[56px] min-w-[56px] border-r border-slate-200">번호</th>
                            <th class="px-2 py-3 font-bold text-center whitespace-nowrap w-[112px] min-w-[112px] border-r border-slate-200">일시</th>
                            <th class="px-3 py-3 font-bold text-center w-[176px] whitespace-nowrap border-r border-slate-200">작성자</th>
                            <th class="px-2 py-3 font-bold text-center w-[92px] whitespace-nowrap border-r border-slate-200">식사구분</th>
                            <th class="px-3 py-3 font-bold text-center w-[102px] whitespace-nowrap border-r border-slate-200">어디서</th>
                            <th class="px-3 py-3 font-bold text-center w-[102px] whitespace-nowrap border-r border-slate-200">무엇을</th>
                            <th class="px-3 py-3 font-bold text-center w-[102px] whitespace-nowrap border-r border-slate-200">누구와</th>
                            <th class="px-3 py-3 font-bold text-center w-[92px] whitespace-nowrap border-r border-slate-200">만족도/포만감</th>
                            <th class="px-2 py-3 font-bold text-center whitespace-nowrap w-[208px] min-w-[208px] border-r border-slate-200">사진</th>
                            <th class="px-3 py-3 font-bold text-center whitespace-nowrap w-[240px] min-w-[240px] border-r border-slate-200">코멘트</th>
                            <th class="px-2 py-3 font-bold text-center whitespace-nowrap w-[72px] min-w-[72px] border-r border-slate-200">상태/신고</th>
                            <th class="px-2 py-3 font-bold text-center whitespace-nowrap w-[56px] min-w-[56px]">삭제</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>
        `;

        container.querySelectorAll('.admin-feed-row-delete').forEach((btn) => {
            btn.addEventListener('click', (ev) => {
                ev.preventDefault();
                void window.adminDeleteSingleFeedPost(btn);
            });
        });
        
        // 페이지네이션 렌더링
        renderFeedPagination(totalPages);
        
        // 토글 버튼 색상 업데이트
        updateFeedFilterToggleColors();
        adminFeedMonitoringLoaded = true;
    } catch (e) {
        adminFeedMonitoringLoaded = false;
        console.error("피드 관리 렌더링 실패:", e);
        const msg = e?.message || '';
        const isIndexError = /COLLECTION_GROUP.*index|requires.*index/i.test(msg);
        const createLink = (e?.message && /https:\/\/[^\s)]+/.exec(e.message))?.[0] || 'https://console.firebase.google.com/v1/r/project/mealog-r0/firestore/indexes?create_exemption=Cklwcm9qZWN0cy9tZWFsb2ctcjAvZGF0YWJhc2VzLyhkZWZhdWx0KS9jb2xsZWN0aW9uR3JvdXBzL21lYWxzL2ZpZWxkcy9kYXRlEAIaCAoEZGF0ZRAC';
        if (isIndexError) {
            container.innerHTML = `
                <div class="text-center py-8 px-4 max-w-lg mx-auto">
                    <i class="fa-solid fa-database text-4xl text-amber-500 mb-4"></i>
                    <p class="font-bold text-slate-800 mb-2">피드 조회용 인덱스가 필요합니다</p>
                    <p class="text-sm text-slate-600 mb-4">아래 버튼을 눌러 Firebase Console에서 <strong>meals</strong> 컬렉션 그룹의 <strong>date</strong> 필드(내림차순) 인덱스를 한 번만 생성해 주세요.</p>
                    <a href="${createLink}" target="_blank" rel="noopener" class="inline-block px-4 py-3 bg-emerald-600 text-white rounded-xl font-bold text-sm hover:bg-emerald-700 transition-colors">인덱스 만들기 (콘솔 열기)</a>
                    <p class="text-xs text-slate-500 mt-4">인덱스가 활성화되기까지 1~2분 걸릴 수 있습니다. 생성 후 피드를 새로고침하세요.</p>
                </div>`;
        } else {
            container.innerHTML = '<div class="text-center py-8 text-red-400"><i class="fa-solid fa-exclamation-triangle text-2xl mb-2"></i><p>게시물을 불러오는 중 오류가 발생했습니다.</p><p class="text-xs mt-2 text-slate-500">' + (msg ? escapeHtml(msg) : '') + '</p></div>';
        }
    }
}

// 피드 필터 토글 버튼 색상 업데이트
function updateFeedFilterToggleColors() {
    ['shared', 'hasPhotos', 'banned'].forEach(filterType => {
        const toggleBtn = document.getElementById(`feed-filter-${filterType}-toggle`);
        if (toggleBtn) {
            const currentValue = feedFilters[filterType];
            if (currentValue === 'all') {
                toggleBtn.className = 'feed-filter-toggle px-4 py-2 bg-blue-100 text-blue-700 rounded-lg text-xs font-bold transition-colors';
                toggleBtn.textContent = '전체';
            } else if (currentValue === 'yes') {
                toggleBtn.className = 'feed-filter-toggle px-4 py-2 bg-emerald-100 text-emerald-700 rounded-lg text-xs font-bold transition-colors';
                toggleBtn.textContent = '예';
            } else {
                toggleBtn.className = 'feed-filter-toggle px-4 py-2 bg-red-100 text-red-700 rounded-lg text-xs font-bold transition-colors';
                toggleBtn.textContent = '아니오';
            }
        }
    });
}

// 피드 페이지네이션 렌더링 (1,2,3… + 이전/다음 — 클릭 시 해당 페이지 조회)
function renderFeedPagination(totalPages) {
    const paginationContainer = document.getElementById('feedPagination');
    if (!paginationContainer) return;
    if (totalPages <= 0) {
        paginationContainer.innerHTML = '';
        return;
    }
    const start = (feedCurrentPage - 1) * feedPageSize + 1;
    const end = feedMealTotalCountKnown
        ? Math.min(feedCurrentPage * feedPageSize, feedTotalCount)
        : start + Math.max(0, feedLastPageRowCount - 1);
    const rangeLabel = feedMealTotalCountKnown
        ? `${start}-${end} / ${feedTotalCount}개`
        : `${start}-${end} (전체 수 미집계)`;
    let html = `<span class="text-sm text-slate-500 mr-2">${rangeLabel}</span>`;
    if (feedCurrentPage > 1) {
        html += `<button onclick="window.feedGoToPage(${feedCurrentPage - 1})" class="px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg text-sm font-bold hover:bg-slate-200 transition-colors">이전</button>`;
    }
    const maxButtons = 9;
    let from = Math.max(1, feedCurrentPage - Math.floor(maxButtons / 2));
    let to = Math.min(totalPages, from + maxButtons - 1);
    if (to - from + 1 < maxButtons) from = Math.max(1, to - maxButtons + 1);
    for (let i = from; i <= to; i++) {
        if (i === feedCurrentPage) {
            html += `<span class="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm font-bold mx-0.5">${i}</span>`;
        } else {
            html += `<button onclick="window.feedGoToPage(${i})" class="px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg text-sm font-bold hover:bg-slate-200 transition-colors mx-0.5">${i}</button>`;
        }
    }
    if (feedCurrentPage < totalPages) {
        html += `<button onclick="window.feedGoToPage(${feedCurrentPage + 1})" class="px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg text-sm font-bold hover:bg-slate-200 transition-colors">다음</button>`;
    }
    paginationContainer.innerHTML = html;
}

// 피드 필터 토글
window.toggleFeedFilter = function(filterType) {
    const currentValue = feedFilters[filterType];
    const toggleBtn = document.getElementById(`feed-filter-${filterType}-toggle`);
    
    if (currentValue === 'all') {
        feedFilters[filterType] = 'yes';
        if (toggleBtn) {
            toggleBtn.textContent = '예';
            toggleBtn.className = 'feed-filter-toggle px-4 py-2 bg-emerald-100 text-emerald-700 rounded-lg text-xs font-bold transition-colors';
        }
    } else if (currentValue === 'yes') {
        feedFilters[filterType] = 'no';
        if (toggleBtn) {
            toggleBtn.textContent = '아니오';
            toggleBtn.className = 'feed-filter-toggle px-4 py-2 bg-red-100 text-red-700 rounded-lg text-xs font-bold transition-colors';
        }
    } else {
        feedFilters[filterType] = 'all';
        if (toggleBtn) {
            toggleBtn.textContent = '전체';
            toggleBtn.className = 'feed-filter-toggle px-4 py-2 bg-blue-100 text-blue-700 rounded-lg text-xs font-bold transition-colors';
        }
    }
    
    if (!adminFeedMonitoringLoaded) return;
    feedCurrentPage = 1;
    renderFeedManagement();
}

// 피드 페이지 이동 (해당 페이지로 가기 위해 필요한 커서가 없으면 이전 페이지들 순차 로드)
window.feedGoToPage = async function(page) {
    if (!adminFeedMonitoringLoaded) return;
    if (page < 1) return;
    const totalPages = computeFeedAdminTotalPages();
    const targetPage = Math.min(page, totalPages);
    for (let p = 2; p < targetPage; p++) {
        if (!feedLastDocsByPage[p]) await getFeedPageWithCache(p);
    }
    feedCurrentPage = targetPage;
    renderFeedManagement();
}

// 피드 관리 새로고침
window.refreshFeedManagement = async function () {
    await runAdminRefreshAction(document.getElementById('adminRefreshFeedBtn'), async () => {
        adminFeedMonitoringLoaded = false;
        invalidateAdminFeedMonitoringCache();
        feedCurrentPage = 1;
        feedLastDocsByPage = {};
        feedTotalCount = 0;
        mealsAdminUseDateTimeSort = true;
        await renderFeedManagement();
    });
};

// 신고 상세 팝업 (사유별 건수)
window.showReportDetailPopup = function(targetGroupKey) {
    const byReason = (window._feedReportDetails && window._feedReportDetails[targetGroupKey]) || {};
    const entries = Object.entries(byReason);
    if (entries.length === 0) return;
    
    const existing = document.getElementById('reportDetailModal');
    if (existing) existing.remove();
    
    const overlay = document.createElement('div');
    overlay.id = 'reportDetailModal';
    overlay.className = 'fixed inset-0 z-[600] flex items-center justify-center p-4';
    
    const bg = document.createElement('div');
    bg.className = 'absolute inset-0 bg-black/50';
    bg.onclick = () => overlay.remove();
    
    const getReasonLabel = (key) => {
        if (String(key).startsWith('기타:')) return key;
        return (REPORT_REASONS.find(r => r.id === key) || {}).label || key;
    };
    
    const listHtml = entries.map(([reason, count]) => `<div class="flex justify-between py-2 border-b border-slate-100 last:border-0"><span class="text-slate-700">${escapeHtml(getReasonLabel(reason))}</span><span class="font-bold text-slate-800">${count}건</span></div>`).join('');
    const total = entries.reduce((s, [, c]) => s + c, 0);
    
    const panel = document.createElement('div');
    panel.className = 'relative w-full max-w-sm bg-white rounded-2xl p-6 shadow-xl';
    panel.innerHTML = `
        <h3 class="text-lg font-bold text-slate-800 mb-4">🚩 신고 사유</h3>
        <p class="text-sm text-slate-600 mb-4">총 <strong>${total}</strong>건의 신고</p>
        <div class="max-h-64 overflow-y-auto">${listHtml}</div>
        <button type="button" class="mt-4 w-full py-3 rounded-xl font-bold text-slate-600 bg-slate-100 hover:bg-slate-200">닫기</button>
    `;
    panel.querySelector('button').onclick = () => overlay.remove();
    
    overlay.appendChild(bg);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
};

// 일괄 공유 취소
window.bulkUnsharePosts = async function() {
    const checkedBoxes = document.querySelectorAll('.feed-item-checkbox:checked');
    if (checkedBoxes.length === 0) {
        alert('선택된 게시물이 없습니다.');
        return;
    }
    
    if (!confirm(`${checkedBoxes.length}개의 게시물 공유를 취소하시겠습니까?`)) return;
    
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    
    try {
        const batch = writeBatch(db);
        let count = 0;
        let sharedPhotosDeleteCount = 0;
        
        for (const checkbox of checkedBoxes) {
            const mealId = checkbox.dataset.mealId;
            const userId = checkbox.dataset.userId;
            const isBest = checkbox.dataset.isBest === 'true';
            const isDaily = checkbox.dataset.isDaily === 'true';
            const isInsight = checkbox.dataset.isInsight === 'true';
            
            if (!mealId || !userId) continue;
            
            try {
                // 베스트 공유 게시물인 경우
                if (isBest) {
                    // sharedPhotos 컬렉션에서 해당 문서 직접 삭제
                    try {
                        const sharedDocRef = doc(db, 'artifacts', appId, 'sharedPhotos', mealId);
                        batch.delete(sharedDocRef);
                        sharedPhotosDeleteCount++;
                        count++;
                    } catch (e) {
                        console.error(`베스트 공유 게시물 ${mealId} 삭제 실패:`, e);
                    }
                    continue;
                }
                
                // 일간보기 공유 게시물인 경우
                if (isDaily) {
                    // sharedPhotos 컬렉션에서 해당 문서 직접 삭제
                    try {
                        const sharedDocRef = doc(db, 'artifacts', appId, 'sharedPhotos', mealId);
                        batch.delete(sharedDocRef);
                        sharedPhotosDeleteCount++;
                        count++;
                    } catch (e) {
                        console.error(`일간보기 공유 게시물 ${mealId} 삭제 실패:`, e);
                    }
                    continue;
                }
                
                // 인사이트 공유 게시물인 경우
                if (isInsight) {
                    // sharedPhotos 컬렉션에서 해당 문서 직접 삭제
                    try {
                        const sharedDocRef = doc(db, 'artifacts', appId, 'sharedPhotos', mealId);
                        batch.delete(sharedDocRef);
                        sharedPhotosDeleteCount++;
                        count++;
                    } catch (e) {
                        console.error(`인사이트 공유 게시물 ${mealId} 삭제 실패:`, e);
                    }
                    continue;
                }
                
                // 일반 게시물 처리
                // meal 문서 가져오기
                const mealDocRef = doc(db, 'artifacts', appId, 'users', userId, 'meals', mealId);
                const mealSnap = await getDoc(mealDocRef);
                
                if (mealSnap.exists()) {
                    // meal 문서의 sharedPhotos 필드 빈 배열로 업데이트
                    batch.update(mealDocRef, { sharedPhotos: [] });
                    count++;
                    
                    // sharedPhotos 컬렉션에서 해당 entryId의 모든 문서 삭제
                    try {
                        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
                        const sharedQuery = query(
                            sharedColl,
                            where('userId', '==', userId),
                            where('entryId', '==', mealId)
                        );
                        const sharedSnapshot = await getDocs(sharedQuery);
                        
                        sharedSnapshot.forEach(docSnap => {
                            const sharedDocRef = doc(db, 'artifacts', appId, 'sharedPhotos', docSnap.id);
                            batch.delete(sharedDocRef);
                            sharedPhotosDeleteCount++;
                        });
                    } catch (e) {
                        console.error(`게시물 ${mealId}의 sharedPhotos 삭제 실패:`, e);
                        // 에러가 발생해도 계속 진행
                    }
                }
            } catch (e) {
                console.error(`게시물 ${mealId} 공유 취소 실패:`, e);
                // 에러가 발생해도 계속 진행
            }
        }
        
        // 배치 커밋 (meal 문서 업데이트 + sharedPhotos 컬렉션 삭제 모두 포함)
        await batch.commit();
        
        invalidateAdminFeedMonitoringCache();
        alert(`${count}개의 게시물 공유가 취소되었습니다. (${sharedPhotosDeleteCount}개의 공유 사진 삭제)`);
        await renderFeedManagement();
    } catch (e) {
        console.error("일괄 공유 취소 실패:", e);
        alert("일괄 공유 취소 중 오류가 발생했습니다: " + e.message);
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
}

// 일괄 공유 금지
window.bulkBanPosts = async function() {
    const checkedBoxes = document.querySelectorAll('.feed-item-checkbox:checked');
    if (checkedBoxes.length === 0) {
        alert('선택된 게시물이 없습니다.');
        return;
    }
    
    if (!confirm(`${checkedBoxes.length}개의 게시물을 공유 금지하시겠습니까? 공유된 게시물은 공유 컬렉션에서도 삭제됩니다.`)) return;
    
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    
    try {
        const batch = writeBatch(db);
        let count = 0;
        let sharedPhotosDeleteCount = 0;
        
        for (const checkbox of checkedBoxes) {
            const mealId = checkbox.dataset.mealId;
            const userId = checkbox.dataset.userId;
            const isBest = checkbox.dataset.isBest === 'true';
            const isDaily = checkbox.dataset.isDaily === 'true';
            const isInsight = checkbox.dataset.isInsight === 'true';
            
            if (!mealId || !userId) continue;
            
            try {
                // 베스트 공유 또는 일간보기 공유 또는 인사이트 공유는 sharedPhotos 컬렉션에서만 삭제
                if (isBest || isDaily || isInsight) {
                    try {
                        const sharedDocRef = doc(db, 'artifacts', appId, 'sharedPhotos', mealId);
                        batch.delete(sharedDocRef);
                        sharedPhotosDeleteCount++;
                        count++;
                    } catch (e) {
                        const typeName = isBest ? '베스트' : isDaily ? '일간보기' : '인사이트';
                        console.error(`${typeName} 공유 게시물 ${mealId} 삭제 실패:`, e);
                    }
                    continue;
                }
                
                // 일반 게시물 처리
                // meal 문서 가져오기
                const mealDocRef = doc(db, 'artifacts', appId, 'users', userId, 'meals', mealId);
                const mealSnap = await getDoc(mealDocRef);
                
                if (mealSnap.exists()) {
                    // meal 문서에 shareBanned: true 설정 및 sharedPhotos 필드 빈 배열로 업데이트
                    batch.update(mealDocRef, { shareBanned: true, sharedPhotos: [] });
                    count++;
                    
                    // sharedPhotos 컬렉션에서 해당 entryId의 모든 문서 삭제
                    try {
                        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
                        const sharedQuery = query(
                            sharedColl,
                            where('userId', '==', userId),
                            where('entryId', '==', mealId)
                        );
                        const sharedSnapshot = await getDocs(sharedQuery);
                        
                        sharedSnapshot.forEach(docSnap => {
                            const sharedDocRef = doc(db, 'artifacts', appId, 'sharedPhotos', docSnap.id);
                            batch.delete(sharedDocRef);
                            sharedPhotosDeleteCount++;
                        });
                    } catch (e) {
                        console.error(`게시물 ${mealId}의 sharedPhotos 삭제 실패:`, e);
                        // 에러가 발생해도 계속 진행
                    }
                }
            } catch (e) {
                console.error(`게시물 ${mealId} 공유 금지 실패:`, e);
                // 에러가 발생해도 계속 진행
            }
        }
        
        // 배치 커밋 (meal 문서 업데이트 + sharedPhotos 컬렉션 삭제 모두 포함)
        await batch.commit();
        
        invalidateAdminFeedMonitoringCache();
        alert(`${count}개의 게시물이 공유 금지되었습니다. (공유 컬렉션에서 ${sharedPhotosDeleteCount}개 삭제)`);
        renderFeedManagement();
    } catch (e) {
        console.error("일괄 공유 금지 실패:", e);
        alert("일괄 공유 금지 중 오류가 발생했습니다.");
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
}

// 공유 사진 동기화 (meal.sharedPhotos 배열을 sharedPhotos 컬렉션에 추가)
// 자동 동기화 함수 (confirm/alert 없이 조용히 처리)
async function autoSyncSharedPhotos(mealId, userId) {
    try {
        // meal 문서 가져오기
        const mealDoc = doc(db, 'artifacts', appId, 'users', userId, 'meals', mealId);
        const mealSnap = await getDoc(mealDoc);
        
        if (!mealSnap.exists()) {
            console.warn(`자동 동기화: 게시물을 찾을 수 없습니다 (${mealId})`);
            return;
        }
        
        const mealData = mealSnap.data();
        const sharedPhotos = mealData.sharedPhotos;
        
        if (!sharedPhotos || !Array.isArray(sharedPhotos) || sharedPhotos.length === 0) {
            return;
        }
        
        // 사용자 정보 가져오기
        let userNickname = '익명';
        let userIcon = '🐻';
        try {
            const settingsDoc = doc(db, 'artifacts', appId, 'users', userId, 'config', 'settings');
            const settingsSnap = await getDoc(settingsDoc);
            if (settingsSnap.exists()) {
                const settings = settingsSnap.data();
                userNickname = settings.profile?.nickname || '익명';
                userIcon = settings.profile?.icon || '🐻';
            }
        } catch (e) {
            console.warn('사용자 정보 조회 실패:', e);
        }
        
        // sharedPhotos 컬렉션에 같은 entryId의 기존 문서 모두 삭제 후 새로 추가 (중복 방지)
        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
        const batch = writeBatch(db);
        
        // 같은 entryId의 기존 문서 모두 삭제
        try {
            const existingQuery = query(
                sharedColl,
                where('userId', '==', userId),
                where('entryId', '==', mealId)
            );
            const existingSnapshot = await getDocs(existingQuery);
            existingSnapshot.docs.forEach(docSnap => {
                batch.delete(docSnap.ref);
            });
            if (existingSnapshot.docs.length > 0) {
                console.log(`자동 동기화: 기존 ${existingSnapshot.docs.length}개 문서 삭제 (entryId: ${mealId})`);
            }
        } catch (e) {
            console.warn('기존 문서 삭제 중 오류 (무시하고 계속 진행):', e);
        }
        
        // meal의 date+time으로 timestamp 생성 (공유 시점 반영, 최신이 위로 오도록)
        const mealDate = String(mealData.date || '').trim();
        let mealTime = String(mealData.time || '12:00:00').trim();
        if (mealTime && mealTime.split(':').length === 2) mealTime += ':00';
        let mealTimestamp = Timestamp.now();
        if (mealDate && mealDate.length >= 10) {
            try {
                const d = new Date(mealDate + 'T' + (mealTime || '12:00:00'));
                if (!isNaN(d.getTime())) mealTimestamp = Timestamp.fromDate(d);
            } catch (_) {}
        }

        // 새로운 사진들을 추가
        sharedPhotos.forEach(photoUrl => {
            const docRef = doc(sharedColl);
            batch.set(docRef, {
                photoUrl,
                userId: userId,
                userNickname: userNickname,
                userIcon: userIcon,
                mealType: mealData.mealType || '',
                place: mealData.place || '',
                menuDetail: mealData.menuDetail || '',
                snackType: mealData.snackType || '',
                date: mealData.date || '',
                slotId: mealData.slotId || '',
                time: mealData.time || new Date().toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }),
                timestamp: mealTimestamp,
                entryId: mealId
            });
        });
        
        await batch.commit();
        console.log(`✅ 자동 동기화 완료: ${mealId} (${sharedPhotos.length}개 사진 추가)`);
        return true;
    } catch (e) {
        console.error(`자동 동기화 오류 (${mealId}):`, e);
        return false;
    }
}

window.syncSharedPhotos = async function(mealId, userId) {
    if (!confirm('이 게시물의 공유 상태를 동기화하시겠습니까?')) return;
    
    try {
        // meal 문서 가져오기
        const mealDoc = doc(db, 'artifacts', appId, 'users', userId, 'meals', mealId);
        const mealSnap = await getDoc(mealDoc);
        
        if (!mealSnap.exists()) {
            alert('게시물을 찾을 수 없습니다.');
            return;
        }
        
        const mealData = mealSnap.data();
        const sharedPhotos = mealData.sharedPhotos;
        
        if (!sharedPhotos || !Array.isArray(sharedPhotos) || sharedPhotos.length === 0) {
            alert('공유할 사진이 없습니다.');
            return;
        }
        
        // 사용자 정보 가져오기
        let userNickname = '익명';
        let userIcon = '🐻';
        try {
            const settingsDoc = doc(db, 'artifacts', appId, 'users', userId, 'config', 'settings');
            const settingsSnap = await getDoc(settingsDoc);
            if (settingsSnap.exists()) {
                const settings = settingsSnap.data();
                userNickname = settings.profile?.nickname || '익명';
                userIcon = settings.profile?.icon || '🐻';
            }
        } catch (e) {
            console.warn('사용자 정보 조회 실패:', e);
        }
        
        // sharedPhotos 컬렉션에 이미 존재하는지 확인
        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
        const existingQuery = query(
            sharedColl,
            where('userId', '==', userId),
            where('entryId', '==', mealId)
        );
        const existingSnapshot = await getDocs(existingQuery);
        const existingUrls = new Set();
        existingSnapshot.docs.forEach(doc => {
            const data = doc.data();
            const urlBase = (data.photoUrl || '').split('?')[0];
            existingUrls.add(urlBase);
        });
        
        // 중복이 아닌 사진만 필터링
        const newPhotos = sharedPhotos.filter(photoUrl => {
            const urlBase = (photoUrl || '').split('?')[0];
            return !existingUrls.has(urlBase);
        });
        
        if (newPhotos.length === 0) {
            alert('이미 모든 사진이 공유되어 있습니다.');
            return;
        }
        
        // meal의 date+time으로 timestamp 생성 (공유 시점 반영)
        const mealDate = String(mealData.date || '').trim();
        let mealTime = String(mealData.time || '12:00:00').trim();
        if (mealTime && mealTime.split(':').length === 2) mealTime += ':00';
        let mealTimestamp = Timestamp.now();
        if (mealDate && mealDate.length >= 10) {
            try {
                const d = new Date(mealDate + 'T' + (mealTime || '12:00:00'));
                if (!isNaN(d.getTime())) mealTimestamp = Timestamp.fromDate(d);
            } catch (_) {}
        }

        // sharedPhotos 컬렉션에 추가
        const batch = writeBatch(db);
        newPhotos.forEach(photoUrl => {
            const docRef = doc(sharedColl);
            batch.set(docRef, {
                photoUrl,
                userId: userId,
                userNickname: userNickname,
                userIcon: userIcon,
                mealType: mealData.mealType || '',
                place: mealData.place || '',
                menuDetail: mealData.menuDetail || '',
                snackType: mealData.snackType || '',
                date: mealData.date || '',
                slotId: mealData.slotId || '',
                time: mealData.time || new Date().toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }),
                timestamp: mealTimestamp,
                entryId: mealId
            });
        });
        
        await batch.commit();
        invalidateAdminFeedMonitoringCache();
        alert(`${newPhotos.length}개의 사진이 공유 컬렉션에 추가되었습니다.`);
        renderFeedManagement();
    } catch (e) {
        console.error("공유 사진 동기화 실패:", e);
        alert("동기화 중 오류가 발생했습니다: " + e.message);
    }
};

// 특정 게시물의 중복 문서 확인 및 정리
window.checkAndCleanDuplicates = async function(mealId) {
    try {
        // 모든 사용자에서 해당 entryId를 찾기
        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
        const sharedQuery = query(
            sharedColl,
            where('entryId', '==', mealId)
        );
        const sharedSnapshot = await getDocs(sharedQuery);
        
        if (sharedSnapshot.empty) {
            alert(`게시물 ${mealId}에 대한 공유 문서를 찾을 수 없습니다.`);
            return;
        }
        
        const docs = sharedSnapshot.docs;
        console.log(`📋 게시물 ${mealId}: 총 ${docs.length}개의 문서 발견`);
        
        // photoUrl 기반으로 중복 확인
        const urlMap = new Map(); // urlBase -> [docIds]
        docs.forEach(docSnap => {
            const data = docSnap.data();
            const urlBase = (data.photoUrl || '').split('?')[0];
            if (!urlMap.has(urlBase)) {
                urlMap.set(urlBase, []);
            }
            urlMap.get(urlBase).push({
                docId: docSnap.id,
                timestamp: data.timestamp || '',
                photoUrl: data.photoUrl || ''
            });
        });
        
        // 중복 발견
        const duplicates = [];
        urlMap.forEach((docInfos, urlBase) => {
            if (docInfos.length > 1) {
                // 같은 photoUrl이 여러 개인 경우
                duplicates.push({
                    urlBase,
                    count: docInfos.length,
                    docs: docInfos
                });
            }
        });
        
        if (duplicates.length === 0) {
            alert(`게시물 ${mealId}: 중복 문서가 없습니다. (총 ${docs.length}개 문서)`);
            return;
        }
        
        // 중복 정보 표시
        let message = `게시물 ${mealId}에서 중복 문서를 발견했습니다:\n\n`;
        duplicates.forEach((dup, idx) => {
            message += `${idx + 1}. 같은 사진이 ${dup.count}개 문서에 존재\n`;
        });
        message += `\n총 ${duplicates.length}개의 중복 사진\n`;
        message += `중복 문서를 정리하시겠습니까? (가장 오래된 문서만 남기고 나머지 삭제)`;
        
        if (!confirm(message)) return;
        
        // 중복 문서 정리: 각 photoUrl에 대해 가장 오래된 문서만 남기고 나머지 삭제
        const batch = writeBatch(db);
        let deleteCount = 0;
        
        duplicates.forEach(dup => {
            // timestamp 기준으로 정렬 (오래된 것 먼저)
            const sorted = dup.docs.sort((a, b) => {
                const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
                const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
                return timeA - timeB;
            });
            
            // 첫 번째(가장 오래된) 문서는 유지하고, 나머지는 삭제
            for (let i = 1; i < sorted.length; i++) {
                const docRef = doc(sharedColl, sorted[i].docId);
                batch.delete(docRef);
                deleteCount++;
            }
        });
        
        if (deleteCount > 0) {
            await batch.commit();
            invalidateAdminFeedMonitoringCache();
            alert(`중복 문서 ${deleteCount}개가 삭제되었습니다.`);
            renderFeedManagement();
        } else {
            alert('삭제할 문서가 없습니다.');
        }
    } catch (e) {
        console.error("중복 문서 확인/정리 실패:", e);
        alert("중복 문서 확인/정리 중 오류가 발생했습니다: " + e.message);
    }
};

// 일괄 금지 해제
window.bulkUnbanPosts = async function() {
    const checkedBoxes = document.querySelectorAll('.feed-item-checkbox:checked');
    if (checkedBoxes.length === 0) {
        alert('선택된 게시물이 없습니다.');
        return;
    }
    
    if (!confirm(`${checkedBoxes.length}개의 게시물 공유 금지를 해제하시겠습니까?`)) return;
    
    const batch = writeBatch(db);
    let count = 0;
    
    for (const checkbox of checkedBoxes) {
        const mealId = checkbox.dataset.mealId;
        const userId = checkbox.dataset.userId;
        
        try {
            const mealDoc = doc(db, 'artifacts', appId, 'users', userId, 'meals', mealId);
            await batch.update(mealDoc, { shareBanned: false });
            count++;
        } catch (e) {
            console.error(`게시물 ${mealId} 금지 해제 실패:`, e);
        }
    }
    
    try {
        await batch.commit();
        invalidateAdminFeedMonitoringCache();
        alert(`${count}개의 게시물 공유 금지가 해제되었습니다.`);
        renderFeedManagement();
    } catch (e) {
        console.error("일괄 금지 해제 실패:", e);
        alert("일괄 금지 해제 중 오류가 발생했습니다.");
    }
};

/** 행의 삭제 버튼(data-*) 기준 단일 삭제 */
window.adminDeleteSingleFeedPost = async function (btn) {
    if (!(btn instanceof HTMLElement)) return;
    const mealId = btn.dataset.mealId;
    const userId = btn.dataset.userId;
    const isBest = btn.dataset.isBest === 'true';
    const isDaily = btn.dataset.isDaily === 'true';
    const isInsight = btn.dataset.isInsight === 'true';
    if (!mealId || !userId) {
        alert('식별 정보가 없습니다.');
        return;
    }
    const onlyShared = isBest || isDaily || isInsight;
    const msg = onlyShared
        ? '이 모먼트(베스트·일간·인사이트) 전용 공유 문서를 삭제합니다. 복구할 수 없습니다. 진행할까요?'
        : '이 기록의 사용자 meals 문서와 모먼트 공유 문서를 삭제합니다. 사용자 타임라인에서도 사라집니다. 복구할 수 없습니다. 진행할까요?';
    if (!confirm(msg)) return;
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    try {
        await adminDeleteFeedPostInternal({ mealId, userId, isBest, isDaily, isInsight });
        invalidateAdminFeedMonitoringCache();
        await renderFeedManagement();
    } catch (e) {
        console.error('모먼트 삭제 실패:', e);
        alert('삭제 중 오류가 발생했습니다: ' + (e?.message || e));
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
};

/** 체크된 행 일괄 삭제 */
window.bulkDeleteFeedPosts = async function () {
    const checkedBoxes = document.querySelectorAll('.feed-item-checkbox:checked');
    if (checkedBoxes.length === 0) {
        alert('선택된 게시물이 없습니다.');
        return;
    }
    if (
        !confirm(
            `선택한 ${checkedBoxes.length}건을 삭제합니다.\n\n일반 기록: 사용자 meals 문서와 모먼트 공유 문서가 삭제됩니다.\n베스트·일간·인사이트: 모먼트 전용 공유 문서만 삭제됩니다.\n모두 복구할 수 없습니다. 계속하시겠습니까?`
        )
    ) {
        return;
    }
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    let ok = 0;
    let fail = 0;
    try {
        for (const checkbox of checkedBoxes) {
            const mealId = checkbox.dataset.mealId;
            const userId = checkbox.dataset.userId;
            const isBest = checkbox.dataset.isBest === 'true';
            const isDaily = checkbox.dataset.isDaily === 'true';
            const isInsight = checkbox.dataset.isInsight === 'true';
            if (!mealId || !userId) continue;
            try {
                await adminDeleteFeedPostInternal({ mealId, userId, isBest, isDaily, isInsight });
                ok++;
            } catch (e) {
                console.error(`삭제 실패 (${mealId}):`, e);
                fail++;
            }
        }
        invalidateAdminFeedMonitoringCache();
        await renderFeedManagement();
        alert(`삭제 완료: ${ok}건${fail ? `, 실패: ${fail}건` : ''}`);
    } catch (e) {
        console.error('일괄 삭제 실패:', e);
        alert('일괄 삭제 중 오류가 발생했습니다: ' + (e?.message || e));
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
};

let adminFeedPhotoViewerState = { urls: [], index: 0 };

function ensureAdminFeedPhotoViewerModal() {
    let el = document.getElementById('adminFeedPhotoViewerModal');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'adminFeedPhotoViewerModal';
    el.className = 'fixed inset-0 z-[9999] hidden';
    el.innerHTML = `
        <div class="admin-feed-photo-viewer-backdrop absolute inset-0 bg-black/80" data-close="1"></div>
        <div class="absolute inset-0 flex flex-col items-center justify-center p-4 pointer-events-none">
            <div class="pointer-events-auto max-w-full max-h-full flex flex-col items-center gap-2">
                <div class="flex items-center justify-end w-full max-w-[min(96vw,1200px)] px-1 min-h-[2rem]">
                    <button type="button" id="adminFeedPhotoViewerClose" class="px-3 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white">닫기</button>
                </div>
                <div class="relative flex items-center justify-center max-h-[85vh] max-w-[96vw]">
                    <button type="button" id="adminFeedPhotoViewerPrev" class="absolute left-0 z-10 p-3 rounded-full bg-black/50 text-white hover:bg-black/70 hidden" aria-label="이전 사진"><i class="fa-solid fa-chevron-left"></i></button>
                    <div class="relative inline-block max-w-[96vw] max-h-[85vh]">
                        <img id="adminFeedPhotoViewerImg" src="" alt="" class="max-w-[96vw] max-h-[85vh] w-auto h-auto object-contain rounded-lg shadow-2xl bg-black/20 block">
                        <span id="adminFeedPhotoViewerCounter" class="absolute top-2 right-2 z-20 px-2 py-1 rounded-md bg-black/70 text-white text-xs font-bold leading-none pointer-events-none shadow-sm"></span>
                    </div>
                    <button type="button" id="adminFeedPhotoViewerNext" class="absolute right-0 z-10 p-3 rounded-full bg-black/50 text-white hover:bg-black/70 hidden" aria-label="다음 사진"><i class="fa-solid fa-chevron-right"></i></button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(el);
    el.querySelector('.admin-feed-photo-viewer-backdrop')?.addEventListener('click', () => closeAdminFeedPhotoViewer());
    el.querySelector('#adminFeedPhotoViewerClose')?.addEventListener('click', () => closeAdminFeedPhotoViewer());
    el.querySelector('#adminFeedPhotoViewerPrev')?.addEventListener('click', (e) => {
        e.stopPropagation();
        adminFeedPhotoViewerStep(-1);
    });
    el.querySelector('#adminFeedPhotoViewerNext')?.addEventListener('click', (e) => {
        e.stopPropagation();
        adminFeedPhotoViewerStep(1);
    });
    document.addEventListener('keydown', adminFeedPhotoViewerKeydown);
    return el;
}

function adminFeedPhotoViewerKeydown(e) {
    const modal = document.getElementById('adminFeedPhotoViewerModal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (e.key === 'Escape') closeAdminFeedPhotoViewer();
    if (e.key === 'ArrowLeft') adminFeedPhotoViewerStep(-1);
    if (e.key === 'ArrowRight') adminFeedPhotoViewerStep(1);
}

function closeAdminFeedPhotoViewer() {
    const el = document.getElementById('adminFeedPhotoViewerModal');
    if (el) el.classList.add('hidden');
}

function adminFeedPhotoViewerStep(delta) {
    const s = adminFeedPhotoViewerState;
    if (!s.urls.length) return;
    s.index = (s.index + delta + s.urls.length) % s.urls.length;
    updateAdminFeedPhotoViewer();
}

function updateAdminFeedPhotoViewer() {
    const img = document.getElementById('adminFeedPhotoViewerImg');
    const counter = document.getElementById('adminFeedPhotoViewerCounter');
    const prev = document.getElementById('adminFeedPhotoViewerPrev');
    const next = document.getElementById('adminFeedPhotoViewerNext');
    const s = adminFeedPhotoViewerState;
    if (!img || !s.urls.length) return;
    img.src = s.urls[s.index];
    const n = s.urls.length;
    if (counter) {
        if (n > 1) {
            counter.textContent = `${s.index + 1}/${n}`;
            counter.classList.remove('hidden');
        } else {
            counter.textContent = '';
            counter.classList.add('hidden');
        }
    }
    const showNav = n > 1;
    if (prev) prev.classList.toggle('hidden', !showNav);
    if (next) next.classList.toggle('hidden', !showNav);
}

window.openAdminFeedPhotoViewer = function (urls, startIndex = 0) {
    if (!urls || !Array.isArray(urls) || urls.length === 0) return;
    const list = urls.map((u) => String(u || '').trim()).filter(Boolean);
    if (!list.length) return;
    adminFeedPhotoViewerState = {
        urls: list,
        index: Math.max(0, Math.min(Number(startIndex) || 0, list.length - 1)),
    };
    const modal = ensureAdminFeedPhotoViewerModal();
    modal.classList.remove('hidden');
    updateAdminFeedPhotoViewer();
};

/** 모니터링에서 '모먼트' 탭으로 들어올 때 호출: date+time 인덱스 배포 후에도 폴백만 쓰던 세션을 한 번 되살림 */
export function refreshAdminMealsFeedSortMode() {
    if (!mealsAdminUseDateTimeSort) {
        mealsAdminUseDateTimeSort = true;
        feedLastDocsByPage = {};
        feedCurrentPage = 1;
    }
}

export { renderFeedManagement };
