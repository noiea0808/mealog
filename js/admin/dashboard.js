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
import { SLOTS } from '../constants.js';

const RECORD_SLOT_7D_PREFIXES = SLOTS.map((s) => `statRecSlot_${s.id}_7d`);
const RECORD_SLOT_7_SUM_IDS = SLOTS.map((s) => `statRecSlot_${s.id}_7Sum`);

const DASHBOARD_7D_ROW_PREFIXES = [
    'statNewUsers7d', 'statActiveUsers7d', 'statRecords7d',
    ...RECORD_SLOT_7D_PREFIXES,
    'statShared7d'
];

const DASHBOARD_7_SUM_IDS = [
    'statNewUsers7Sum', 'statActiveUsers7Sum', 'statRecords7Sum',
    ...RECORD_SLOT_7_SUM_IDS,
    'statShared7Sum'
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
    const rbs = raw.recordsBySlot && typeof raw.recordsBySlot === 'object' ? raw.recordsBySlot : {};
    const recordsBySlot = {};
    for (const s of SLOTS) {
        recordsBySlot[s.id] = pick(rbs[s.id]);
    }
    return {
        dates: [...raw.dates],
        newUsers: pick(raw.newUsers),
        activeUsers: pick(raw.activeUsers),
        records: pick(raw.records),
        recordsBySlot,
        sharedPhotos: pick(raw.sharedPhotos)
    };
}

// 대시보드 통계 캐시 문서 (adminSettings 사용 — Firestore 규칙에서 관리자 쓰기 허용됨)
const DASHBOARD_STATS_REF = () => doc(db, 'artifacts', appId, 'adminSettings', 'dashboardStats');

/**
 * 컬렉션 그룹 `slotId` 인덱스가 없을 때(aggregation failed-precondition):
 * 각 사용자 `users/{uid}/meals`에서 슬롯별 count를 더해 전체 건수 산출 (통계 새로고침 1회당 읽기 다량).
 */
async function countMealsSlotAllViaUserSubcollections(userIds, countQFn) {
    const totals = SLOTS.map(() => 0);
    const UID_BATCH = 8;
    for (let i = 0; i < userIds.length; i += UID_BATCH) {
        const chunk = userIds.slice(i, i + UID_BATCH);
        const perUserArrays = await Promise.all(
            chunk.map(async (uid) => {
                const mc = collection(db, 'artifacts', appId, 'users', uid, 'meals');
                const counts = await Promise.all(
                    SLOTS.map(async (s) => {
                        try {
                            return await countQFn(query(mc, where('slotId', '==', s.id)));
                        } catch {
                            return 0;
                        }
                    })
                );
                return counts;
            })
        );
        perUserArrays.forEach((arr) => {
            arr.forEach((n, si) => {
                totals[si] += n;
            });
        });
    }
    return totals;
}

/** meals 문서 ref → users/{uid}/meals 경로에서 uid 추출 */
function userIdFromMealDocRef(ref) {
    const parts = ref.path.split('/');
    const i = parts.indexOf('users');
    return i >= 0 && parts[i + 1] ? parts[i + 1] : null;
}

function addLocalDays(date, delta) {
    const d = new Date(date.getTime());
    d.setDate(d.getDate() + delta);
    return d;
}

/**
 * 관리자 「통계 새로고침」 전용 집계.
 * 이전: sharedPhotos/users 전체 getDocs + 사용자별 meals 전체 getDocs → 읽기 폭발.
 * 현재: collectionGroup·getCountFromServer·최근 30일 meals만 getDocs + 슬롯별 전체 건수는 slotId당 count 1회 + 사용자당 meals 존재는 count 1회.
 * 공유 지표: 최근 30일·7일·일별·오늘은 sharedPhotos 문서를 한 번 읽고 getSharedPhotoGroupKey로 고유 「게시물」수 집계.
 * (한 포스트에 사진이 여러 장이면 문서가 여러 개이므로 count 쿼리만 쓰면 장수로 부풀려짐.)
 * 전체(all)는 여전히 Firestore 문서 수(읽기 1회) — 전역 고유 게시물 수는 전체 스캔 없이는 불가.
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

        const emptySlotAgg = () => ({ last30: 0, last7: 0, today: 0, byDay: z7() });
        const slotAgg = {};
        for (const s of SLOTS) slotAgg[s.id] = emptySlotAgg();

        const stats = {
            newUsers: { all: 0, last30: 0, last7: 0, today: 0 },
            activeUsers: { all: 0, last30: 0, last7: 0, today: 0 },
            records: { all: 0, last30: 0, last7: 0, today: 0 },
            /** 슬롯별 기록 건수 (앱 SLOTS·meal.slotId와 동일) */
            recordsBySlot: {},
            sharedPhotos: { all: 0, last30: 0, last7: 0, today: 0 },
            totalUsers: 0,
            totalMeals: 0,
            totalSharedPhotos: 0,
            recentActivity: { last7Days: 0, last30Days: 0 }
        };

        const activeUserSets = { all: new Set(), last30: new Set(), last7: new Set(), today: new Set() };

        const mealsCg = collectionGroup(db, 'meals');
        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
        const countQ = async (q) => (await getCountFromServer(q)).data().count ?? 0;

        const [recordsAllCount, mealsLast30Snap] = await Promise.all([
            countQ(query(mealsCg)),
            getDocs(query(mealsCg, where('date', '>=', last30Str), where('date', '<=', todayStr)))
        ]);

        const userIdsForSlots = usersSnapshot.docs.map((d) => d.id);
        let slotAllArr;
        try {
            slotAllArr = await Promise.all(
                SLOTS.map((s) => countQ(query(mealsCg, where('slotId', '==', s.id))))
            );
        } catch (e) {
            if (e?.code === 'failed-precondition') {
                console.warn(
                    '⚠️ meals 컬렉션 그룹(slotId) 인덱스가 아직 없습니다. 사용자별 meals로 슬롯「전체」건수를 집계합니다. 배포: firebase deploy --only firestore:indexes',
                    e.message || e
                );
                slotAllArr = await countMealsSlotAllViaUserSubcollections(userIdsForSlots, countQ);
            } else {
                throw e;
            }
        }

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

            const sid = mealData.slotId;
            if (sid && slotAgg[sid]) {
                slotAgg[sid].last30++;
                if (dateStr === todayStr) slotAgg[sid].today++;
                if (dateStr >= last7FirstStr && dateStr <= todayStr) {
                    slotAgg[sid].last7++;
                    const sdi = last7IndexMap.get(dateStr);
                    if (sdi != null && sdi >= 0) slotAgg[sid].byDay[sdi]++;
                }
            }
        });

        stats.records.today = recordsToday;
        stats.records.last7 = recordsLast7;
        stats.records.last30 = recordsLast30;

        SLOTS.forEach((s, i) => {
            const a = slotAgg[s.id];
            stats.recordsBySlot[s.id] = {
                all: slotAllArr[i] ?? 0,
                last30: a.last30,
                last7: a.last7,
                today: a.today
            };
        });

        const userIds = userIdsForSlots;
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
            const tsLast7Lo = Timestamp.fromDate(last7FirstDay);
            const tsLast30Lo = Timestamp.fromDate(last30Start);
            const tsEnd = Timestamp.fromDate(tomorrowStart);

            const tToday0 = todayStart.getTime();
            const tLast7 = last7FirstDay.getTime();
            const tLast30 = last30Start.getTime();
            const tTomorrow = tomorrowStart.getTime();

            const keysToday = new Set();
            const keysLast7 = new Set();
            const keysLast30 = new Set();
            const keysByDay7 = Array.from({ length: 7 }, () => new Set());

            const sharedLast30Snap = await getDocs(
                query(sharedColl, where('timestamp', '>=', tsLast30Lo), where('timestamp', '<', tsEnd))
            );
            sharedLast30Snap.forEach((docSnap) => {
                const data = docSnap.data();
                const rawTs = data.timestamp;
                const ts = rawTs && rawTs.toDate ? rawTs.toDate() : null;
                if (!ts || Number.isNaN(ts.getTime())) return;
                const t = ts.getTime();
                const gk = getSharedPhotoGroupKey(data);
                if (t >= tLast30 && t < tTomorrow) keysLast30.add(gk);
                if (t >= tLast7 && t < tTomorrow) {
                    keysLast7.add(gk);
                    const dk = dateKeyFromLocalDate(new Date(ts.getFullYear(), ts.getMonth(), ts.getDate()));
                    const idx = dk != null ? last7IndexMap.get(dk) : -1;
                    if (idx != null && idx >= 0) keysByDay7[idx].add(gk);
                }
                if (t >= tToday0 && t < tTomorrow) keysToday.add(gk);
            });

            stats.sharedPhotos.today = keysToday.size;
            stats.sharedPhotos.last7 = keysLast7.size;
            stats.sharedPhotos.last30 = keysLast30.size;
            for (let di = 0; di < 7; di++) {
                sharedByDayCounts[di] = keysByDay7[di].size;
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

        const recordsBySlotBreakdown = {};
        for (const s of SLOTS) {
            recordsBySlotBreakdown[s.id] = [...slotAgg[s.id].byDay];
        }
        stats.last7Breakdown = {
            dates: last7DateKeys,
            newUsers: [...newUsersByDay],
            activeUsers: activeSetsByDay.map((s) => s.size),
            records: [...recordsByDay],
            recordsBySlot: recordsBySlotBreakdown,
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
        set('statNewUsersAll', stats.newUsers?.all);
        set('statNewUsers30', stats.newUsers?.last30);
        set('statActiveUsersAll', stats.activeUsers?.all);
        set('statActiveUsers30', stats.activeUsers?.last30);
        set('statRecordsAll', stats.records?.all);
        set('statRecords30', stats.records?.last30);
        set('statSharedAll', stats.sharedPhotos?.all);
        set('statShared30', stats.sharedPhotos?.last30);

        renderDashboard7dHeaders(bd?.dates);
        fillDashboard7dNumericRow('statNewUsers7d', bd?.newUsers, stats.newUsers?.last7);
        fillDashboard7dNumericRow('statActiveUsers7d', bd?.activeUsers, stats.activeUsers?.last7);
        fillDashboard7dNumericRow('statRecords7d', bd?.records, stats.records?.last7);
        fillDashboard7dNumericRow('statShared7d', bd?.sharedPhotos, stats.sharedPhotos?.last7);

        set('statNewUsers7Sum', sumSevenDaily(bd?.newUsers) ?? stats.newUsers?.last7);
        set('statActiveUsers7Sum', stats.activeUsers?.last7);
        set('statRecords7Sum', sumSevenDaily(bd?.records) ?? stats.records?.last7);
        set('statShared7Sum', sumSevenDaily(bd?.sharedPhotos) ?? stats.sharedPhotos?.last7);

        SLOTS.forEach((s) => {
            const d = stats.recordsBySlot?.[s.id] || { all: 0, last30: 0, last7: 0, today: 0 };
            set(`statRecSlot_${s.id}_all`, d.all);
            set(`statRecSlot_${s.id}_30`, d.last30);
            const bdSlot = bd?.recordsBySlot?.[s.id];
            fillDashboard7dNumericRow(`statRecSlot_${s.id}_7d`, bdSlot, d.last7);
            set(`statRecSlot_${s.id}_7Sum`, sumSevenDaily(bdSlot) ?? d.last7);
        });
    } else {
        const recordSlotAll30 = SLOTS.flatMap((s) => [`statRecSlot_${s.id}_all`, `statRecSlot_${s.id}_30`]);
        ['statNewUsersAll', 'statNewUsers30',
            'statActiveUsersAll', 'statActiveUsers30',
            'statRecordsAll', 'statRecords30',
            ...recordSlotAll30,
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
            newUsersCountSnap,
            sharedDocsSnap
        ] = await Promise.all([
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
            newUsersToday: newUsersCountSnap.data().count ?? 0,
            sharedPhotosToday: todayPostKeys.size
        };
    } catch (e) {
        console.warn('당일 통계 조회 실패 (캐시값만 표시):', e?.message || e);
        return { newUsersToday: 0, sharedPhotosToday: 0 };
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
            newUsers: data.newUsers || { all: 0, last30: 0, last7: 0, today: 0 },
            activeUsers: data.activeUsers || { all: 0, last30: 0, last7: 0, today: 0 },
            records: data.records || { all: 0, last30: 0, last7: 0, today: 0 },
            recordsBySlot: data.recordsBySlot && typeof data.recordsBySlot === 'object' ? data.recordsBySlot : {},
            sharedPhotos: data.sharedPhotos || { all: 0, last30: 0, last7: 0, today: 0 }
        };
        let last7Breakdown = cloneLast7Breakdown(data.last7Breakdown);
        // 캐시가 오늘 이전 기준이면 당일 숫자만 경량 조회해서 보정 (전일까지는 캐시 유지)
        if (asOfDate && asOfDate !== todayStr) {
            const todayOnly = await getTodayOnlyStats();
            if (last7Breakdown && last7Breakdown.dates) {
                const ti = last7Breakdown.dates.indexOf(todayStr);
                if (ti >= 0) {
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
                    newUsers: stats.newUsers,
                    activeUsers: stats.activeUsers,
                    records: stats.records,
                    recordsBySlot: stats.recordsBySlot,
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
