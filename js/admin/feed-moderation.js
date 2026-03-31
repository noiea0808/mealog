/**
 * 관리자 모니터링: 모먼트(타임라인) 공유·신고·일괄 처리
 */
import { db, appId } from '../firebase.js';
import { getReportsAggregateByGroupKeys } from '../db.js';
import { REPORT_REASONS } from '../constants.js';
import { escapeHtml } from './utils.js';
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
    Timestamp
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

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

// 피드: 전체 타임라인(meals) 페이지 단위 조회 — 사진 유무와 관계없이 모든 게시물 표시, 중복 없음
async function getFeedPage(options = {}) {
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? feedPageSize;
    const startAfterDoc = page === 1 ? null : (feedLastDocsByPage[page - 1] ?? null);
    const mealsGroup = collectionGroup(db, 'meals');
    try {
        if (page === 1) {
            const countSnap = await getCountFromServer(query(mealsGroup, orderBy('date', 'desc')));
            feedTotalCount = countSnap.data().count;
        }
        let q = query(mealsGroup, orderBy('date', 'desc'), limit(pageSize));
        if (startAfterDoc) q = query(mealsGroup, orderBy('date', 'desc'), limit(pageSize), startAfter(startAfterDoc));
        const snapshot = await getDocs(q);
        const docs = snapshot.docs;
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
        console.error('getFeedPage error:', e);
        throw e;
    }
}

// 공유된 게시물 키 캐시 (userId_entryId) — 피드 필터/배지용, 세션당 1회 로드. 전체 문서 페이지네이션으로 수집해 누락 방지
let feedSharedKeysCache = null;

async function ensureFeedSharedKeysCache() {
    if (feedSharedKeysCache) return;
    const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
    feedSharedKeysCache = new Set();
    try {
        const PAGE = 500;
        let lastDoc = null;
        let hasMore = true;
        while (hasMore) {
            let q = query(sharedColl, orderBy('timestamp', 'desc'), limit(PAGE));
            if (lastDoc) q = query(sharedColl, orderBy('timestamp', 'desc'), startAfter(lastDoc), limit(PAGE));
            const snap = await getDocs(q);
            snap.docs.forEach(d => {
                const data = d.data();
                const uid = data.userId;
                const eid = data.entryId || data.mealId || null;
                if (uid && eid) feedSharedKeysCache.add(`${uid}_${eid}`);
            });
            lastDoc = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;
            hasMore = snap.docs.length === PAGE;
        }
    } catch (e) {
        console.warn('ensureFeedSharedKeysCache orderBy 실패, 전체 조회로 폴백:', e?.message || e);
        const snap = await getDocs(sharedColl);
        snap.docs.forEach(d => {
            const data = d.data();
            const uid = data.userId;
            const eid = data.entryId || data.mealId || null;
            if (uid && eid) feedSharedKeysCache.add(`${uid}_${eid}`);
        });
    }
}

async function renderFeedManagement() {
    const container = document.getElementById('feedManagementContainer');
    if (!container) return;
    
    container.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i><p>로딩 중...</p></div>';
    
    try {
        await ensureFeedSharedKeysCache();
        console.log('📋 피드 관리: 페이지', feedCurrentPage, '로드 중... (페이지 단위)');
        const { items } = await getFeedPage({ page: feedCurrentPage, pageSize: feedPageSize });
        const allMeals = items;
        
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
        
        console.log(`✅ 필터 적용 후: ${filteredMeals.length}개 (페이지 ${feedCurrentPage} / 총 ${feedTotalCount}개)`);
        
        // 최신 업로드 순 정렬 (현재 페이지 내)
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
        const totalPages = Math.max(1, Math.ceil(feedTotalCount / feedPageSize));
        const paginatedMeals = filteredMeals;
        
        // 사용자 정보 가져오기 (타임라인 게시물은 설정에서 닉네임/아이콘 조회)
        const userInfoMap = new Map();
        const userIdsToFetch = [...new Set(paginatedMeals.map(m => m.userId).filter(Boolean))];
        await Promise.all(userIdsToFetch.map(async (uid) => {
            if (userInfoMap.has(uid)) return;
            try {
                const settingsSnap = await getDoc(doc(db, 'artifacts', appId, 'users', uid, 'config', 'settings'));
                if (settingsSnap.exists()) {
                    const s = settingsSnap.data();
                    userInfoMap.set(uid, { nickname: s.profile?.nickname || '익명', icon: s.profile?.icon || '🐻' });
                }
            } catch (e) { console.warn('사용자 정보 조회 실패:', uid, e); }
        }));
        
        if (paginatedMeals.length === 0) {
            container.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-images text-2xl mb-2"></i><p>게시물이 없습니다.</p></div>';
            return;
        }
        
        const reportsMap = await getReportsAggregateByGroupKeys();
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

            const userInfo = meal.isBestShare || meal.isDailyShare || meal.isInsightShare
                ? { nickname: meal.userNickname || '익명', icon: meal.userIcon || '🐻' }
                : (userInfoMap.get(meal.userId) || { nickname: '익명', icon: '🐻' });

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
            const firstPhoto = meal.photoUrl || (Array.isArray(meal.photos) ? meal.photos[0] : '');
            const rowBg = hasDataMismatch ? 'bg-yellow-50' : (isBanned ? 'bg-red-50' : '');
            const dateTime = fmtDateTimeParts(meal);
            const newestOrder = (feedCurrentPage - 1) * feedPageSize + rowIdx + 1;
            const oldFirstNumber = Math.max(1, (feedTotalCount || 0) - newestOrder + 1);
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
                    <td class="px-2 py-3 align-middle whitespace-nowrap text-center w-[96px] min-w-[96px] border-r border-slate-200">
                        <div class="text-xs text-slate-700 font-semibold leading-tight">${escapeHtml(dateTime.date)}</div>
                        <div class="text-[11px] text-slate-500 leading-tight mt-0.5">${escapeHtml(dateTime.time)}</div>
                    </td>
                    <td class="px-3 py-3 align-middle w-[136px] max-w-[136px] text-center border-r border-slate-200">
                        <div class="flex flex-col items-center gap-1 overflow-hidden">
                            <span class="text-sm font-semibold text-slate-800 break-words">${userInfo.icon} ${escapeHtml(userInfo.nickname)}</span>
                            <span class="text-[11px] text-slate-400">${escapeHtml(String(meal.id || '-'))}</span>
                            <span class="px-2 py-0.5 bg-slate-100 text-slate-700 text-xs font-bold rounded">${typeLabel}</span>
                        </div>
                    </td>
                    <td class="px-2 py-3 align-middle w-[92px] max-w-[92px] text-center border-r border-slate-200 overflow-hidden">
                        <span class="inline-flex px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-xs font-bold whitespace-nowrap">${escapeHtml(String(mealSlotLabel))}</span>
                    </td>
                    <td class="px-3 py-3 align-middle w-[102px] max-w-[102px] text-center border-r border-slate-200 overflow-hidden">${getCategoryCell(whereTag, whereSubTag)}</td>
                    <td class="px-3 py-3 align-middle w-[102px] max-w-[102px] text-center border-r border-slate-200 overflow-hidden">${getCategoryCell(whatTag, whatSubTag)}</td>
                    <td class="px-3 py-3 align-middle w-[102px] max-w-[102px] text-center border-r border-slate-200 overflow-hidden">${getCategoryCell(withTag, withSubTag)}</td>
                    <td class="px-3 py-3 align-middle w-[120px] max-w-[120px] text-center border-r border-slate-200 overflow-hidden">
                        <div class="text-xs leading-tight">
                            <div class="font-bold text-slate-700 break-words">만족도 ${escapeHtml(String(ratingVal ?? '-'))}</div>
                            <div class="font-bold text-slate-600 break-words mt-0.5">포만감 ${escapeHtml(String(satietyVal ?? '-'))}</div>
                        </div>
                    </td>
                    <td class="px-2 py-3 align-middle text-center w-[208px] min-w-[208px] border-r border-slate-200">
                        ${hasPhotos && firstPhoto
                            ? `<img src="${firstPhoto}" alt="사진" class="mx-auto w-[200px] h-[200px] object-contain rounded-lg border border-slate-200 bg-white">`
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
                            <th class="px-2 py-3 font-bold text-center whitespace-nowrap w-[96px] min-w-[96px] border-r border-slate-200">일시</th>
                            <th class="px-3 py-3 font-bold text-center w-[136px] whitespace-nowrap border-r border-slate-200">작성자</th>
                            <th class="px-2 py-3 font-bold text-center w-[92px] whitespace-nowrap border-r border-slate-200">식사구분</th>
                            <th class="px-3 py-3 font-bold text-center w-[102px] whitespace-nowrap border-r border-slate-200">어디서</th>
                            <th class="px-3 py-3 font-bold text-center w-[102px] whitespace-nowrap border-r border-slate-200">무엇을</th>
                            <th class="px-3 py-3 font-bold text-center w-[102px] whitespace-nowrap border-r border-slate-200">누구와</th>
                            <th class="px-3 py-3 font-bold text-center w-[120px] whitespace-nowrap border-r border-slate-200">만족도/포만감</th>
                            <th class="px-2 py-3 font-bold text-center whitespace-nowrap w-[208px] min-w-[208px] border-r border-slate-200">사진</th>
                            <th class="px-3 py-3 font-bold text-center whitespace-nowrap w-[240px] min-w-[240px] border-r border-slate-200">코멘트</th>
                            <th class="px-2 py-3 font-bold text-center whitespace-nowrap w-[72px] min-w-[72px]">상태/신고</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>
        `;
        
        // 페이지네이션 렌더링
        renderFeedPagination(totalPages);
        
        // 토글 버튼 색상 업데이트
        updateFeedFilterToggleColors();
        
    } catch (e) {
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
    const end = Math.min(feedCurrentPage * feedPageSize, feedTotalCount);
    let html = `<span class="text-sm text-slate-500 mr-2">${start}-${end} / ${feedTotalCount}개</span>`;
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
    
    feedCurrentPage = 1;
    renderFeedManagement();
}

// 피드 페이지 이동 (해당 페이지로 가기 위해 필요한 커서가 없으면 이전 페이지들 순차 로드)
window.feedGoToPage = async function(page) {
    if (page < 1) return;
    const totalPages = Math.max(1, Math.ceil(feedTotalCount / feedPageSize));
    const targetPage = Math.min(page, totalPages);
    for (let p = 2; p < targetPage; p++) {
        if (!feedLastDocsByPage[p]) await getFeedPage({ page: p });
    }
    feedCurrentPage = targetPage;
    renderFeedManagement();
}

// 피드 관리 새로고침
window.refreshFeedManagement = function() {
    feedCurrentPage = 1;
    feedLastDocsByPage = {};
    feedTotalCount = 0;
    feedSharedKeysCache = null;
    renderFeedManagement();
}

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
        
        feedSharedKeysCache = null;
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
        
        feedSharedKeysCache = null;
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
        feedSharedKeysCache = null;
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
            feedSharedKeysCache = null;
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
        feedSharedKeysCache = null;
        alert(`${count}개의 게시물 공유 금지가 해제되었습니다.`);
        renderFeedManagement();
    } catch (e) {
        console.error("일괄 금지 해제 실패:", e);
        alert("일괄 금지 해제 중 오류가 발생했습니다.");
    }
}

export { renderFeedManagement };
