// ADMIN 대시보드 통계 관련 함수들
import { db, appId } from '../firebase.js';
import {
    collection,
    collectionGroup,
    getDocs,
    query,
    orderBy,
    limit,
    doc,
    getDoc,
    setDoc,
    where,
    getCountFromServer,
    Timestamp,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { getSharedPhotoGroupKey, dateKeyFromLocalDate, getLast7DateKeys, getTodayDateString, escapeHtml, runAdminRefreshAction } from './utils.js';

const DASHBOARD_7D_ROW_PREFIXES = [
    'statGuestVisits7d', 'statNewUsers7d', 'statActiveUsers7d', 'statRecords7d', 'statShared7d'
];

const DASHBOARD_7_SUM_IDS = [
    'statGuestVisits7Sum', 'statNewUsers7Sum', 'statActiveUsers7Sum', 'statRecords7Sum', 'statShared7Sum'
];

/** 일별 7칸이 있으면 합계, 없으면 null */
function sumSevenDaily(values) {
    if (!values || values.length !== 7) return null;
    return values.reduce((a, b) => a + (Number(b) || 0), 0);
}

function getDashboard7dCellIds() {
    const ids = [...DASHBOARD_7_SUM_IDS];
    DASHBOARD_7D_ROW_PREFIXES.forEach((p) => {
        for (let i = 0; i < 7; i++) ids.push(`${p}${i}`);
    });
    return ids;
}

/** 최근 7일 날짜 헤더 (컬럼 7개, 과거 → 오늘) */
function renderDashboard7dHeaders(dates) {
    for (let i = 0; i < 7; i++) {
        const th = document.getElementById(`dashboard7dHead${i}`);
        if (!th) continue;
        if (dates && dates.length === 7 && dates[i]) {
            const parts = String(dates[i]).split('-');
            const m = parts[1] ? parseInt(parts[1], 10) : 0;
            const day = parts[2] ? parseInt(parts[2], 10) : 0;
            th.innerHTML = `<span class="block leading-tight text-xs">${m}/${day}</span>`;
            th.title = dates[i];
        } else {
            th.textContent = '—';
            th.removeAttribute('title');
        }
    }
}

/** 한 지표의 7개 컬럼 (baseId + 0..6) */
function fillDashboard7dNumericRow(baseId, values, fallbackTotal) {
    const tip = (fallbackTotal != null && Number.isFinite(Number(fallbackTotal)))
        ? `7일 범위 합(캐시): ${Number(fallbackTotal).toLocaleString()} — 「통계 새로고침」으로 일별`
        : '「통계 새로고침」으로 일별 집계';
    for (let i = 0; i < 7; i++) {
        const el = document.getElementById(`${baseId}${i}`);
        if (!el) continue;
        if (values && values.length === 7) {
            el.textContent = Number(values[i] || 0).toLocaleString();
            el.removeAttribute('title');
        } else {
            el.textContent = '—';
            el.title = tip;
        }
    }
}

/** Firestore 캐시의 last7Breakdown을 안전하게 복사 (길이 7 정규화) */
function cloneLast7Breakdown(raw) {
    if (!raw || !Array.isArray(raw.dates) || raw.dates.length !== 7) return null;
    const pick = (arr) => {
        const a = Array.isArray(arr) ? arr.map(v => Number(v) || 0) : [];
        while (a.length < 7) a.push(0);
        return a.slice(0, 7);
    };
    return {
        dates: [...raw.dates],
        guestVisits: pick(raw.guestVisits),
        newUsers: pick(raw.newUsers),
        activeUsers: pick(raw.activeUsers),
        records: pick(raw.records),
        sharedPhotos: pick(raw.sharedPhotos)
    };
}

// 대시보드 통계 캐시 문서 (adminSettings 사용 — Firestore 규칙에서 관리자 쓰기 허용됨)
const DASHBOARD_STATS_REF = () => doc(db, 'artifacts', appId, 'adminSettings', 'dashboardStats');

/** meals 문서 ref → users/{uid}/meals 경로에서 uid 추출 */
function userIdFromMealDocRef(ref) {
    const parts = ref.path.split('/');
    const i = parts.indexOf('users');
    return i >= 0 && parts[i + 1] ? parts[i + 1] : null;
}

function startOfLocalDayFromYmd(ymd) {
    const p = String(ymd || '').split('-').map(Number);
    if (p.length !== 3 || !p[0]) return null;
    return new Date(p[0], p[1] - 1, p[2], 0, 0, 0, 0);
}

function addLocalDays(date, delta) {
    const d = new Date(date.getTime());
    d.setDate(d.getDate() + delta);
    return d;
}

/**
 * 관리자 「통계 새로고침」 전용 집계.
 * 이전: sharedPhotos/users/guestVisits 전체 getDocs + 사용자별 meals 전체 getDocs → 읽기 폭발.
 * 현재: collectionGroup·getCountFromServer·최근 30일 meals만 getDocs + 사용자당 meals 존재는 count 1회.
 * 공유 지표는 논리 포스트 dedupe 대신 sharedPhotos 「문서 수」(기간·일별 동일)로 집계해 읽기를 줄임.
 */
export async function getUserStatistics() {
    try {
        const usersColl = collection(db, 'artifacts', appId, 'users');
        const usersSnapshot = await getDocs(usersColl);
        const usersFromCollection = usersSnapshot.size;

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const last7FirstDay = new Date(todayStart);
        last7FirstDay.setDate(last7FirstDay.getDate() - 6);
        const last30Start = new Date(todayStart);
        last30Start.setDate(last30Start.getDate() - 30);

        const last7DateKeys = getLast7DateKeys(todayStart);
        const last7IndexMap = new Map(last7DateKeys.map((k, i) => [k, i]));
        const last7DayIndex = (dateOnly) => {
            const k = dateKeyFromLocalDate(dateOnly);
            return k != null && last7IndexMap.has(k) ? last7IndexMap.get(k) : -1;
        };

        const todayStr = dateKeyFromLocalDate(todayStart);
        const last7FirstStr = dateKeyFromLocalDate(last7FirstDay);
        const last30Str = dateKeyFromLocalDate(last30Start);
        const tomorrowStart = addLocalDays(todayStart, 1);

        const z7 = () => [0, 0, 0, 0, 0, 0, 0];
        const guestVisitsByDay = z7();
        const newUsersByDay = z7();
        const recordsByDay = z7();
        const activeSetsByDay = Array.from({ length: 7 }, () => new Set());
        const sharedByDayCounts = z7();

        const inPeriod = (dateOnly, period) => {
            if (!dateOnly) return false;
            if (period === 'all') return true;
            if (period === 'today') return dateOnly.getTime() >= todayStart.getTime();
            if (period === 'last7') return dateOnly.getTime() >= last7FirstDay.getTime();
            if (period === 'last30') return dateOnly.getTime() >= last30Start.getTime();
            return false;
        };

        const stats = {
            guestVisits: { all: 0, last30: 0, last7: 0, today: 0 },
            newUsers: { all: 0, last30: 0, last7: 0, today: 0 },
            activeUsers: { all: 0, last30: 0, last7: 0, today: 0 },
            records: { all: 0, last30: 0, last7: 0, today: 0 },
            sharedPhotos: { all: 0, last30: 0, last7: 0, today: 0 },
            totalUsers: 0,
            totalMeals: 0,
            totalSharedPhotos: 0,
            recentActivity: { last7Days: 0, last30Days: 0 }
        };

        const activeUserSets = { all: new Set(), last30: new Set(), last7: new Set(), today: new Set() };

        const mealsCg = collectionGroup(db, 'meals');
        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
        const guestVisitsColl = collection(db, 'artifacts', appId, 'guestVisits');

        const countQ = async (q) => (await getCountFromServer(q)).data().count ?? 0;

        const [recordsAllCount, mealsLast30Snap] = await Promise.all([
            countQ(query(mealsCg)),
            getDocs(query(mealsCg, where('date', '>=', last30Str), where('date', '<=', todayStr)))
        ]);

        stats.records.all = recordsAllCount;
        let recordsToday = 0;
        let recordsLast7 = 0;
        let recordsLast30 = 0;

        mealsLast30Snap.forEach((docSnap) => {
            const mealData = docSnap.data();
            const dateStr = mealData.date;
            const uid = userIdFromMealDocRef(docSnap.ref);
            if (!dateStr || typeof dateStr !== 'string' || !uid) return;

            recordsLast30++;
            if (dateStr === todayStr) {
                recordsToday++;
                activeUserSets.today.add(uid);
            }
            if (dateStr >= last7FirstStr && dateStr <= todayStr) {
                recordsLast7++;
                const rdi = last7IndexMap.get(dateStr);
                if (rdi != null && rdi >= 0) {
                    recordsByDay[rdi]++;
                    activeSetsByDay[rdi].add(uid);
                }
                activeUserSets.last7.add(uid);
            }
            activeUserSets.last30.add(uid);
        });

        stats.records.today = recordsToday;
        stats.records.last7 = recordsLast7;
        stats.records.last30 = recordsLast30;

        const userIds = usersSnapshot.docs.map((d) => d.id);
        const UID_BATCH = 30;
        for (let i = 0; i < userIds.length; i += UID_BATCH) {
            const chunk = userIds.slice(i, i + UID_BATCH);
            await Promise.all(
                chunk.map(async (uid) => {
                    try {
                        const mc = collection(db, 'artifacts', appId, 'users', uid, 'meals');
                        const n = await countQ(query(mc));
                        if (n > 0) activeUserSets.all.add(uid);
                    } catch (_) {}
                })
            );
        }

        try {
            stats.guestVisits.all = await countQ(query(guestVisitsColl));
            const tsTomorrow = Timestamp.fromDate(tomorrowStart);
            stats.guestVisits.today = await countQ(
                query(
                    guestVisitsColl,
                    where('lastVisitedAt', '>=', Timestamp.fromDate(todayStart)),
                    where('lastVisitedAt', '<', tsTomorrow)
                )
            );
            stats.guestVisits.last7 = await countQ(
                query(
                    guestVisitsColl,
                    where('lastVisitedAt', '>=', Timestamp.fromDate(last7FirstDay)),
                    where('lastVisitedAt', '<', tsTomorrow)
                )
            );
            stats.guestVisits.last30 = await countQ(
                query(
                    guestVisitsColl,
                    where('lastVisitedAt', '>=', Timestamp.fromDate(last30Start)),
                    where('lastVisitedAt', '<', tsTomorrow)
                )
            );

            for (let di = 0; di < 7; di++) {
                const ymd = last7DateKeys[di];
                const d0 = startOfLocalDayFromYmd(ymd);
                if (!d0) continue;
                const d1 = addLocalDays(d0, 1);
                guestVisitsByDay[di] = await countQ(
                    query(
                        guestVisitsColl,
                        where('lastVisitedAt', '>=', Timestamp.fromDate(d0)),
                        where('lastVisitedAt', '<', Timestamp.fromDate(d1))
                    )
                );
            }
        } catch (ge) {
            console.warn('⚠️ guestVisits 집계 실패, 전체 문서 스캔으로 폴백:', ge?.message || ge);
            try {
                const guestVisitsSnap = await getDocs(guestVisitsColl);
                guestVisitsSnap.docs.forEach((docSnap) => {
                    const d = docSnap.data();
                    let lastAt = null;
                    if (d.lastVisitedAt) {
                        lastAt = d.lastVisitedAt.toDate ? d.lastVisitedAt.toDate() : new Date(d.lastVisitedAt);
                    }
                    if (lastAt) {
                        const dateOnly = new Date(lastAt.getFullYear(), lastAt.getMonth(), lastAt.getDate());
                        stats.guestVisits.all++;
                        if (inPeriod(dateOnly, 'today')) stats.guestVisits.today++;
                        if (inPeriod(dateOnly, 'last7')) stats.guestVisits.last7++;
                        if (inPeriod(dateOnly, 'last30')) stats.guestVisits.last30++;
                        const gdi = last7DayIndex(dateOnly);
                        if (gdi >= 0) guestVisitsByDay[gdi]++;
                    }
                });
            } catch (e2) {
                console.warn('⚠️ guestVisits 폴백도 실패:', e2?.message || e2);
            }
        }

        usersSnapshot.docs.forEach((userDoc) => {
            const userData = userDoc.data();
            let createdAt = null;
            if (userData.createdAt) {
                createdAt = userData.createdAt.toDate ? userData.createdAt.toDate() : new Date(userData.createdAt);
            }
            if (createdAt) {
                const createdDateOnly = new Date(createdAt.getFullYear(), createdAt.getMonth(), createdAt.getDate());
                stats.newUsers.all++;
                if (inPeriod(createdDateOnly, 'today')) stats.newUsers.today++;
                if (inPeriod(createdDateOnly, 'last7')) stats.newUsers.last7++;
                if (inPeriod(createdDateOnly, 'last30')) stats.newUsers.last30++;
                const ndi = last7DayIndex(createdDateOnly);
                if (ndi >= 0) newUsersByDay[ndi]++;
            }
        });
        stats.totalUsers = Math.max(usersFromCollection, stats.newUsers.all);

        try {
            stats.sharedPhotos.all = await countQ(query(sharedColl));
            stats.totalSharedPhotos = stats.sharedPhotos.all;
            const tsTodayLo = Timestamp.fromDate(todayStart);
            const tsTodayHi = Timestamp.fromDate(tomorrowStart);
            const tsLast7Lo = Timestamp.fromDate(last7FirstDay);
            const tsLast30Lo = Timestamp.fromDate(last30Start);
            const tsEnd = Timestamp.fromDate(tomorrowStart);

            stats.sharedPhotos.today = await countQ(
                query(sharedColl, where('timestamp', '>=', tsTodayLo), where('timestamp', '<', tsTodayHi))
            );
            stats.sharedPhotos.last7 = await countQ(
                query(sharedColl, where('timestamp', '>=', tsLast7Lo), where('timestamp', '<', tsEnd))
            );
            stats.sharedPhotos.last30 = await countQ(
                query(sharedColl, where('timestamp', '>=', tsLast30Lo), where('timestamp', '<', tsEnd))
            );

            for (let di = 0; di < 7; di++) {
                const ymd = last7DateKeys[di];
                const d0 = startOfLocalDayFromYmd(ymd);
                if (!d0) continue;
                const d1 = addLocalDays(d0, 1);
                sharedByDayCounts[di] = await countQ(
                    query(
                        sharedColl,
                        where('timestamp', '>=', Timestamp.fromDate(d0)),
                        where('timestamp', '<', Timestamp.fromDate(d1))
                    )
                );
            }
        } catch (se) {
            console.warn('⚠️ sharedPhotos 집계 실패:', se?.message || se);
        }

        stats.recentActivity.last7Days = stats.sharedPhotos.last7;
        stats.recentActivity.last30Days = stats.sharedPhotos.last30;

        stats.activeUsers.all = activeUserSets.all.size;
        stats.activeUsers.last30 = activeUserSets.last30.size;
        stats.activeUsers.last7 = activeUserSets.last7.size;
        stats.activeUsers.today = activeUserSets.today.size;
        stats.totalMeals = stats.records.all;

        stats.last7Breakdown = {
            dates: last7DateKeys,
            guestVisits: [...guestVisitsByDay],
            newUsers: [...newUsersByDay],
            activeUsers: activeSetsByDay.map((s) => s.size),
            records: [...recordsByDay],
            sharedPhotos: [...sharedByDayCounts]
        };

        console.log('📊 대시보드 통계(최적화 집계):', stats);
        return stats;
    } catch (e) {
        console.error("❌ Get user statistics error:", e);
        console.error("오류 코드:", e.code);
        console.error("오류 메시지:", e.message);
        throw e;
    }
}

// 공유 게시물 조회 (최신순)
export async function getSharedPhotos(pageSize = 100) {
    try {
        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
        const q = query(sharedColl, orderBy('timestamp', 'desc'), limit(pageSize));
        const snapshot = await getDocs(q);
        
        return snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
    } catch (e) {
        console.error("Get shared photos error:", e);
        throw e;
    }
}

/** 통계 객체를 화면에 반영 + 마지막 업데이트 문구 */
export function renderDashboardStats(stats, updatedAt, last7BreakdownOverride = null) {
    const set = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value != null ? Number(value).toLocaleString() : '-';
    };
    const bdRaw = last7BreakdownOverride != null ? last7BreakdownOverride : stats?.last7Breakdown;
    const bd = bdRaw && bdRaw.dates?.length === 7 ? bdRaw : null;
    if (stats) {
        set('statGuestVisitsAll', stats.guestVisits?.all);
        set('statGuestVisits30', stats.guestVisits?.last30);
        set('statNewUsersAll', stats.newUsers?.all);
        set('statNewUsers30', stats.newUsers?.last30);
        set('statActiveUsersAll', stats.activeUsers?.all);
        set('statActiveUsers30', stats.activeUsers?.last30);
        set('statRecordsAll', stats.records?.all);
        set('statRecords30', stats.records?.last30);
        set('statSharedAll', stats.sharedPhotos?.all);
        set('statShared30', stats.sharedPhotos?.last30);

        renderDashboard7dHeaders(bd?.dates);
        fillDashboard7dNumericRow('statGuestVisits7d', bd?.guestVisits, stats.guestVisits?.last7);
        fillDashboard7dNumericRow('statNewUsers7d', bd?.newUsers, stats.newUsers?.last7);
        fillDashboard7dNumericRow('statActiveUsers7d', bd?.activeUsers, stats.activeUsers?.last7);
        fillDashboard7dNumericRow('statRecords7d', bd?.records, stats.records?.last7);
        fillDashboard7dNumericRow('statShared7d', bd?.sharedPhotos, stats.sharedPhotos?.last7);

        set('statGuestVisits7Sum', sumSevenDaily(bd?.guestVisits) ?? stats.guestVisits?.last7);
        set('statNewUsers7Sum', sumSevenDaily(bd?.newUsers) ?? stats.newUsers?.last7);
        set('statActiveUsers7Sum', stats.activeUsers?.last7);
        set('statRecords7Sum', sumSevenDaily(bd?.records) ?? stats.records?.last7);
        set('statShared7Sum', sumSevenDaily(bd?.sharedPhotos) ?? stats.sharedPhotos?.last7);
    } else {
        ['statGuestVisitsAll', 'statGuestVisits30',
            'statNewUsersAll', 'statNewUsers30',
            'statActiveUsersAll', 'statActiveUsers30',
            'statRecordsAll', 'statRecords30',
            'statSharedAll', 'statShared30'].forEach(id => set(id, null));
        renderDashboard7dHeaders(null);
        getDashboard7dCellIds().forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.textContent = '—';
                el.removeAttribute('title');
            }
        });
    }
    const label = document.getElementById('dashboardStatsUpdatedAt');
    if (label) {
        if (updatedAt) {
            const d = updatedAt && (updatedAt.toDate ? updatedAt.toDate() : new Date(updatedAt));
            label.textContent = '마지막 업데이트: ' + d.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
        } else {
            label.textContent = '캐시된 통계가 없습니다. 「통계 새로고침」을 눌러 주세요.';
        }
    }
}

/** 당일(오늘 00:00~) 데이터만 경량 조회 — 캐시가 전일 기준일 때 오늘 숫자만 보정용 (읽기 최소화). 공유는 게시물 수로 카운트 */
async function getTodayOnlyStats() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTimestamp = Timestamp.fromDate(todayStart);
    try {
        const [
            guestCountSnap,
            newUsersCountSnap,
            sharedDocsSnap
        ] = await Promise.all([
            getCountFromServer(query(
                collection(db, 'artifacts', appId, 'guestVisits'),
                where('lastVisitedAt', '>=', todayTimestamp)
            )),
            getCountFromServer(query(
                collection(db, 'artifacts', appId, 'users'),
                where('createdAt', '>=', todayTimestamp)
            )),
            getDocs(query(
                collection(db, 'artifacts', appId, 'sharedPhotos'),
                where('timestamp', '>=', todayTimestamp)
            ))
        ]);
        const todayPostKeys = new Set();
        (sharedDocsSnap.docs || []).forEach(d => {
            todayPostKeys.add(getSharedPhotoGroupKey(d.data()));
        });
        return {
            guestVisitsToday: guestCountSnap.data().count ?? 0,
            newUsersToday: newUsersCountSnap.data().count ?? 0,
            sharedPhotosToday: todayPostKeys.size
        };
    } catch (e) {
        console.warn('당일 통계 조회 실패 (캐시값만 표시):', e?.message || e);
        return { guestVisitsToday: 0, newUsersToday: 0, sharedPhotosToday: 0 };
    }
}

// 통계 업데이트: 전일까지는 캐시 1회 읽기, 당일만 필요 시 경량 쿼리로 보정 (DB 읽기 최소화)
export async function updateStatistics() {
    const btn = document.getElementById('dashboardStatsRefreshBtn');
    try {
        if (btn) btn.disabled = true;
        const snap = await getDoc(DASHBOARD_STATS_REF());
        if (!snap.exists()) {
            renderDashboardStats(null, null);
            return;
        }
        const data = snap.data();
        const asOfDate = data.asOfDate || null; // YYYY-MM-DD, 전일까지 집계된 기준일
        const todayStr = getTodayDateString();
        const stats = {
            guestVisits: data.guestVisits || { all: 0, last30: 0, last7: 0, today: 0 },
            newUsers: data.newUsers || { all: 0, last30: 0, last7: 0, today: 0 },
            activeUsers: data.activeUsers || { all: 0, last30: 0, last7: 0, today: 0 },
            records: data.records || { all: 0, last30: 0, last7: 0, today: 0 },
            sharedPhotos: data.sharedPhotos || { all: 0, last30: 0, last7: 0, today: 0 }
        };
        let last7Breakdown = cloneLast7Breakdown(data.last7Breakdown);
        // 캐시가 오늘 이전 기준이면 당일 숫자만 경량 조회해서 보정 (전일까지는 캐시 유지)
        if (asOfDate && asOfDate !== todayStr) {
            const todayOnly = await getTodayOnlyStats();
            if (last7Breakdown && last7Breakdown.dates) {
                const ti = last7Breakdown.dates.indexOf(todayStr);
                if (ti >= 0) {
                    last7Breakdown.guestVisits[ti] = todayOnly.guestVisitsToday;
                    last7Breakdown.newUsers[ti] = todayOnly.newUsersToday;
                    last7Breakdown.sharedPhotos[ti] = todayOnly.sharedPhotosToday;
                }
            }
            // records/activeUsers·7일 일별의 오늘 칸은 집계 비용상 캐시 유지 (통계 새로고침 시 반영)
        }
        renderDashboardStats(stats, data.updatedAt, last7Breakdown);
    } catch (e) {
        console.error("대시보드 통계 로드 실패:", e);
        renderDashboardStats(null, null);
    } finally {
        if (btn) btn.disabled = false;
    }
}

// 통계 새로고침: 전체 집계 후 캐시 문서에 저장 (이때만 DB 다량 읽기)
export async function refreshDashboardStats() {
    try {
        await runAdminRefreshAction(
            document.getElementById('dashboardStatsRefreshBtn'),
            async () => {
                const stats = await getUserStatistics();
                const payload = {
                    guestVisits: stats.guestVisits,
                    newUsers: stats.newUsers,
                    activeUsers: stats.activeUsers,
                    records: stats.records,
                    sharedPhotos: stats.sharedPhotos,
                    last7Breakdown: stats.last7Breakdown || null,
                    asOfDate: getTodayDateString(),
                    updatedAt: serverTimestamp()
                };
                await setDoc(DASHBOARD_STATS_REF(), payload);
                renderDashboardStats(stats, new Date(), stats.last7Breakdown);
            },
            { loadingText: '집계 중…' }
        );
    } catch (e) {
        console.error('통계 새로고침 실패:', e);
        alert('통계 새로고침 중 오류가 발생했습니다: ' + (e.message || e));
    }
}

// 공유 게시물 렌더링
export async function renderSharedPhotos() {
    const container = document.getElementById('sharedPhotosContainer');
    if (!container) return;
    
    container.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i><p>로딩 중...</p></div>';
    
    try {
        const photos = await getSharedPhotos(100);
        
        if (photos.length === 0) {
            container.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-images text-2xl mb-2"></i><p>공유된 게시물이 없습니다.</p></div>';
            return;
        }
        
        // 문서에 userNickname이 비어 있는 작성자들은 사용자 설정에서 닉네임 조회 (관리번호에 닉네임이 안 보이는 문제 방지)
        const userIdsNeedingNickname = [...new Set(photos.filter(p => !(p.userNickname && p.userNickname.trim()) && p.userId).map(p => p.userId))];
        const nicknameFallbackMap = new Map();
        for (const uid of userIdsNeedingNickname) {
            try {
                const settingsRef = doc(db, 'artifacts', appId, 'users', uid, 'config', 'settings');
                const snap = await getDoc(settingsRef);
                if (snap.exists()) {
                    const nn = snap.data()?.profile?.nickname;
                    if (nn && String(nn).trim()) nicknameFallbackMap.set(uid, String(nn).trim());
                }
            } catch (e) {
                console.warn(`관리자 공유 게시물: 사용자 ${uid} 설정 조회 실패`, e);
            }
        }
        const resolveNickname = (photo) => (photo.userNickname && String(photo.userNickname).trim()) ? photo.userNickname : (nicknameFallbackMap.get(photo.userId) || '익명');
        
        container.innerHTML = photos.map(photo => {
            const displayNickname = resolveNickname(photo);
            const date = photo.timestamp ? new Date(photo.timestamp) : new Date();
            const dateStr = date.toLocaleString('ko-KR', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
            
            return `
                <div class="border border-slate-200 rounded-xl p-4 hover:shadow-md transition-shadow">
                    <div class="flex gap-4">
                        ${photo.photoUrl ? `
                            <div class="flex-shrink-0">
                                <img src="${photo.photoUrl}" alt="공유 사진" class="w-20 h-20 object-cover rounded-xl">
                            </div>
                        ` : ''}
                        <div class="flex-1 min-w-0">
                            <div class="flex items-start justify-between mb-2">
                                <div class="flex items-center gap-2">
                                    <span class="text-lg">${photo.userIcon || '🐻'}</span>
                                    <span class="font-bold text-slate-800">${escapeHtml(displayNickname)}</span>
                                    ${photo.type === 'best' ? '<span class="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs font-bold rounded">베스트</span>' : ''}
                                    ${photo.type === 'daily' ? '<span class="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs font-bold rounded">일간</span>' : ''}
                                    <span class="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs font-bold rounded">관리번호: ${photo.id}</span>
                                </div>
                                <button onclick="window.openDeleteModal('${photo.id}')" class="px-3 py-1.5 bg-red-50 text-red-600 rounded-lg text-xs font-bold hover:bg-red-100 transition-colors">
                                    <i class="fa-solid fa-trash mr-1"></i>삭제
                                </button>
                            </div>
                            <div class="text-sm text-slate-600 mb-1">
                                ${photo.menuDetail || photo.place || photo.snackType || '내용 없음'}
                            </div>
                            <div class="text-xs text-slate-400">${dateStr}</div>
                            ${photo.comment ? `<div class="mt-2 text-sm text-slate-700 bg-slate-50 p-2 rounded">${photo.comment}</div>` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error("공유 게시물 렌더링 실패:", e);
        container.innerHTML = '<div class="text-center py-8 text-red-400"><i class="fa-solid fa-exclamation-triangle text-2xl mb-2"></i><p>게시물을 불러오는 중 오류가 발생했습니다.</p></div>';
    }
}
