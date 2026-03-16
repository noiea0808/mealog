// ADMIN 관리자 페이지 관련 함수들
import { app, db, appId, functions, callableFunctions } from './firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js';
import { boardOperations } from './db/board.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";

// Firestore 규칙·Callable은 기본 Auth만 인식하므로 관리자도 기본 Auth 사용 (admin 페이지는 별도 URL)
const adminAuth = getAuth(app);
import { collection, collectionGroup, getDocs, query, orderBy, limit, startAfter, doc, deleteDoc, getDoc, setDoc, where, writeBatch, addDoc, serverTimestamp, getCountFromServer, Timestamp, deleteField } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { uploadImageToStorage, uploadPersonaImageToStorage, uploadNoticeImages, uploadPopupImages, uploadLoginBannerImage } from './utils.js';
import { getReportsAggregateByGroupKeys, deleteBoardPostByAdmin, setBoardPostHidden, getAdminDisplayName, invalidateAdminDisplayNameCache } from './db.js';
import { REPORT_REASONS } from './constants.js';
import { getCurrentTermsVersion, invalidateTermsVersionCache } from './utils-terms.js';
import { sanitizeFormattedText, renderFormattedContent, stripDangerousTagsOnly } from './render/utils.js';

let currentDeletePhotoId = null;

/** sharedPhotos 문서를 게시물(포스트) 단위로 그룹하기 위한 키 (listeners.js와 동일 로직) */
function getSharedPhotoGroupKey(data) {
    if (data.type === 'daily') return `daily_${data.date || 'no-date'}_${data.userId}`;
    if (data.type === 'best') return `best_${data.id || 'no-id'}_${data.userId}`;
    if (data.type === 'insight') return `insight_${data.dateRangeText || 'no-range'}_${data.userId}`;
    if (data.entryId) return `${data.entryId}_${data.userId}`;
    return `no-entry_${data.userId}`;
}

// 사용자 테이블 정렬 상태/캐시
let usersCache = null; // 마지막으로 로드된 사용자 목록 (정렬 전 원본)
let usersSortState = { key: 'createdAt', dir: 'desc' };

const USERS_SORT_DEFAULT_DIR = {
    loginMethod: 'asc',
    email: 'asc',
    nickname: 'asc',
    terms: 'desc',
    timelineCount: 'desc',
    albumShareCount: 'desc',
    talkCount: 'desc',
    userId: 'asc',
    createdAt: 'desc',
    lastLoginAt: 'desc'
};

function normalizeString(v) {
    return (v === undefined || v === null) ? '' : String(v);
}

function normalizeNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function normalizeDateValue(v) {
    if (!v) return null;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'string') {
        const t = new Date(v).getTime();
        return Number.isFinite(t) ? t : null;
    }
    // Firestore Timestamp 대응
    if (typeof v === 'object' && typeof v.toDate === 'function') {
        try {
            return v.toDate().getTime();
        } catch {
            return null;
        }
    }
    return null;
}

function compareWithNullsLast(a, b, dir) {
    const aNull = a === null || a === undefined || (typeof a === 'number' && !Number.isFinite(a));
    const bNull = b === null || b === undefined || (typeof b === 'number' && !Number.isFinite(b));
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    
    if (typeof a === 'number' && typeof b === 'number') {
        return dir === 'asc' ? a - b : b - a;
    }
    const aStr = normalizeString(a);
    const bStr = normalizeString(b);
    const cmp = aStr.localeCompare(bStr, 'ko');
    return dir === 'asc' ? cmp : -cmp;
}

function getTermsRank(user, currentVersion) {
    // 2: 최신 동의(또는 앱에서 재동의를 요구하지 않는 기존 사용자), 1: 구버전 동의(재동의 필요), 0: 미동의
    const agreed = user?.termsAgreed === true;
    if (!agreed) return 0;
    // termsVersion 없음 = 앱과 동일하게 기존 사용자로 간주 → 동의함
    const ver = user?.termsVersion;
    if (ver === null || ver === undefined || String(ver).trim() === '') return 2;
    if (currentVersion && ver === currentVersion) return 2;
    // 앱 정책: 식사 기록이 있는 사용자(기존 사용자)는 약관 버전을 검사하지 않고 동의한 것으로 처리 → 관리자 표시 일치
    if ((user?.timelineCount ?? 0) > 0) return 2;
    return 1;
}

function sortUsersForTable(users, currentVersion) {
    const { key, dir } = usersSortState;
    const sorted = [...users];
    sorted.sort((a, b) => {
        let av;
        let bv;
        switch (key) {
            case 'timelineCount':
            case 'albumShareCount':
            case 'talkCount':
                av = normalizeNumber(a?.[key]);
                bv = normalizeNumber(b?.[key]);
                return compareWithNullsLast(av, bv, dir);
            case 'createdAt':
            case 'lastLoginAt':
                av = normalizeDateValue(a?.[key]);
                bv = normalizeDateValue(b?.[key]);
                return compareWithNullsLast(av, bv, dir);
            case 'terms':
                av = getTermsRank(a, currentVersion);
                bv = getTermsRank(b, currentVersion);
                return compareWithNullsLast(av, bv, dir);
            default:
                av = normalizeString(a?.[key]);
                bv = normalizeString(b?.[key]);
                return compareWithNullsLast(av, bv, dir);
        }
    });
    return sorted;
}

function updateUsersSortHeaderUI() {
    const buttons = document.querySelectorAll('.admin-users-sort');
    buttons.forEach(btn => {
        const key = btn.getAttribute('data-sort-key');
        const indicator = btn.querySelector('.admin-users-sort-indicator');
        if (!indicator) return;
        if (key === usersSortState.key) {
            indicator.textContent = usersSortState.dir === 'asc' ? '▲' : '▼';
            indicator.classList.remove('text-slate-400');
            indicator.classList.add('text-slate-700');
        } else {
            indicator.textContent = '↕';
            indicator.classList.remove('text-slate-700');
            indicator.classList.add('text-slate-400');
        }
    });
}

function initUsersSortHandlers() {
    const buttons = document.querySelectorAll('.admin-users-sort');
    if (!buttons || buttons.length === 0) return;
    
    buttons.forEach(btn => {
        if (btn.dataset.sortBound === '1') return;
        btn.dataset.sortBound = '1';
        btn.addEventListener('click', () => {
            const key = btn.getAttribute('data-sort-key');
            if (!key) return;
            if (usersSortState.key === key) {
                usersSortState.dir = usersSortState.dir === 'asc' ? 'desc' : 'asc';
            } else {
                usersSortState.key = key;
                usersSortState.dir = USERS_SORT_DEFAULT_DIR[key] || 'asc';
            }
            updateUsersSortHeaderUI();
            // 캐시를 재정렬하여 즉시 반영 (재조회 없음)
            renderUsers({ useCacheOnly: true });
        });
    });
    updateUsersSortHeaderUI();
}

// ADMIN 권한 확인
async function checkAdminStatus(userId) {
    if (!userId) {
        console.log('❌ ADMIN 체크: userId가 없습니다.');
        return false;
    }
    
    try {
        const adminDocRef = doc(db, 'artifacts', appId, 'admins', userId);
        console.log('🔍 ADMIN 체크 중:', {
            userId: userId,
            path: `artifacts/${appId}/admins/${userId}`
        });
        
        const adminDoc = await getDoc(adminDocRef);
        
        if (!adminDoc.exists()) {
            console.log('❌ ADMIN 문서가 존재하지 않습니다:', userId);
            console.log('💡 Firebase 콘솔에서 확인하세요: artifacts/mealog-r0/admins/{사용자UID}');
            return false;
        }
        
        const adminData = adminDoc.data();
        console.log('📄 ADMIN 문서 데이터:', adminData);
        
        const isAdmin = adminData.isAdmin === true;
        if (!isAdmin) {
            console.log('❌ isAdmin 필드가 true가 아닙니다:', adminData.isAdmin);
        } else {
            console.log('✅ ADMIN 권한 확인됨!');
        }
        
        return isAdmin;
    } catch (e) {
        console.error("❌ ADMIN 체크 오류:", e);
        return false;
    }
}

// 사용자 통계 조회
async function getUserStatistics() {
    try {
        // 공유 게시물에서 사용자 정보 먼저 추출
        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
        const sharedSnapshot = await getDocs(sharedColl);
        const uniqueUserIds = new Set();
        const userMap = new Map(); // userId -> { email, nickname, icon, lastActivity }
        
        sharedSnapshot.forEach(doc => {
            const data = doc.data();
            if (data.userId) {
                uniqueUserIds.add(data.userId);
                if (!userMap.has(data.userId)) {
                    userMap.set(data.userId, {
                        userId: data.userId,
                        email: null,
                        nickname: data.userNickname || '익명',
                        icon: data.userIcon || '🐻',
                        lastActivity: data.timestamp ? new Date(data.timestamp) : null
                    });
                } else {
                    // 마지막 활동 업데이트
                    const userInfo = userMap.get(data.userId);
                    if (data.timestamp) {
                        const ts = new Date(data.timestamp);
                        if (!userInfo.lastActivity || ts > userInfo.lastActivity) {
                            userInfo.lastActivity = ts;
                        }
                    }
                }
            }
        });
        
        console.log('📸 공유 게시물에서 발견된 사용자:', uniqueUserIds.size, '명');
        console.log('   사용자 ID 목록:', Array.from(uniqueUserIds));
        
        // users 컬렉션 조회 시도
        let usersSnapshot;
        let usersFromCollection = 0;
        try {
            const usersColl = collection(db, 'artifacts', appId, 'users');
            usersSnapshot = await getDocs(usersColl);
            usersFromCollection = usersSnapshot.size;
            console.log('✅ users 컬렉션 조회 성공:', usersFromCollection, '개 문서');
            
            // users 컬렉션의 사용자 정보 업데이트
            usersSnapshot.forEach(userDoc => {
                const userId = userDoc.id;
                const userData = userDoc.data();
                if (userMap.has(userId)) {
                    const userInfo = userMap.get(userId);
                    if (userData.config && userData.config.settings && userData.config.settings.profile) {
                        userInfo.nickname = userData.config.settings.profile.nickname || userInfo.nickname;
                        userInfo.icon = userData.config.settings.profile.icon || userInfo.icon;
                    }
                }
            });
        } catch (usersError) {
            console.warn('⚠️ users 컬렉션 조회 실패 (공유 게시물 데이터 사용):', usersError);
            usersSnapshot = { docs: [], size: 0 };
        }
        
        // 통계 계산을 위한 날짜 설정 (자정 기준)
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const last7Start = new Date(todayStart);
        last7Start.setDate(last7Start.getDate() - 7);
        const last30Start = new Date(todayStart);
        last30Start.setDate(last30Start.getDate() - 30);

        const inPeriod = (dateOnly, period) => {
            if (!dateOnly) return false;
            if (period === 'all') return true;
            if (period === 'today') return dateOnly.getTime() >= todayStart.getTime();
            if (period === 'last7') return dateOnly.getTime() >= last7Start.getTime();
            if (period === 'last30') return dateOnly.getTime() >= last30Start.getTime();
            return false;
        };

        const stats = {
            guestVisits: { all: 0, last30: 0, last7: 0, today: 0 },
            newUsers: { all: 0, last30: 0, last7: 0, today: 0 },
            activeUsers: { all: 0, last30: 0, last7: 0, today: 0 },
            records: { all: 0, last30: 0, last7: 0, today: 0 },
            sharedPhotos: { all: 0, last30: 0, last7: 0, today: 0 },
            // 하위 호환 (게시물 수 기준)
            totalUsers: 0,
            totalMeals: 0,
            totalSharedPhotos: 0,
            recentActivity: { last7Days: 0, last30Days: 0 }
        };

        const activeUserSets = { all: new Set(), last30: new Set(), last7: new Set(), today: new Set() };

        // 0) 둘러보기(게스트) 방문: guestVisits 컬렉션의 lastVisitedAt 기준
        try {
            const guestVisitsColl = collection(db, 'artifacts', appId, 'guestVisits');
            const guestVisitsSnap = await getDocs(guestVisitsColl);
            guestVisitsSnap.docs.forEach(docSnap => {
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
                }
            });
        } catch (e) {
            console.warn('⚠️ guestVisits 조회 실패:', e?.message || e);
        }

        // 1) 신규 사용자: users 컬렉션의 createdAt 기준
        if (usersSnapshot.docs) {
            usersSnapshot.docs.forEach(userDoc => {
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
                }
            });
        }
        stats.totalUsers = Math.max(usersFromCollection, uniqueUserIds.size, stats.newUsers.all);

        // 2) 공유 게시물 기간별 (게시물 수로 카운트 — 같은 entryId/daily/best/insight는 1건)
        const postKeysByPeriod = { all: new Set(), today: new Set(), last7: new Set(), last30: new Set() };
        sharedSnapshot.docs.forEach(d => {
            const data = d.data();
            const key = getSharedPhotoGroupKey(data);
            let ts = null;
            if (data.timestamp) {
                ts = data.timestamp.toDate ? data.timestamp.toDate() : new Date(data.timestamp);
            }
            if (ts) {
                const dateOnly = new Date(ts.getFullYear(), ts.getMonth(), ts.getDate());
                postKeysByPeriod.all.add(key);
                if (inPeriod(dateOnly, 'today')) postKeysByPeriod.today.add(key);
                if (inPeriod(dateOnly, 'last7')) postKeysByPeriod.last7.add(key);
                if (inPeriod(dateOnly, 'last30')) postKeysByPeriod.last30.add(key);
            }
        });
        stats.sharedPhotos.all = postKeysByPeriod.all.size;
        stats.recentActivity.last7Days = postKeysByPeriod.today.size;
        stats.recentActivity.last30Days = postKeysByPeriod.last30.size;
        stats.sharedPhotos.today = postKeysByPeriod.today.size;
        stats.sharedPhotos.last7 = postKeysByPeriod.last7.size;
        stats.sharedPhotos.last30 = postKeysByPeriod.last30.size;
        stats.totalSharedPhotos = postKeysByPeriod.all.size;

        // 3) 각 사용자의 meals로 기록 수 + 활성 사용자 집계
        const userIdsToCheck = usersFromCollection > 0
            ? usersSnapshot.docs.map(doc => doc.id)
            : Array.from(uniqueUserIds);
        let processedUsers = 0;

        for (const userId of userIdsToCheck) {
            processedUsers++;
            try {
                const mealsColl = collection(db, 'artifacts', appId, 'users', userId, 'meals');
                const mealsSnapshot = await getDocs(mealsColl);
                let userHasInAll = false, userHasIn30 = false, userHasIn7 = false, userHasInToday = false;

                mealsSnapshot.forEach((mealDoc) => {
                    const mealData = mealDoc.data();
                    let mealDate = null;
                    if (mealData.date) {
                        const dateParts = mealData.date.split('-');
                        if (dateParts.length === 3) {
                            mealDate = new Date(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]));
                        }
                    } else if (mealData.timestamp) {
                        mealDate = mealData.timestamp.toDate ? mealData.timestamp.toDate() : new Date(mealData.timestamp);
                    }
                    if (mealDate) {
                        const mealDateOnly = new Date(mealDate.getFullYear(), mealDate.getMonth(), mealDate.getDate());
                        stats.records.all++;
                        if (inPeriod(mealDateOnly, 'today')) { stats.records.today++; userHasInToday = true; }
                        if (inPeriod(mealDateOnly, 'last7')) { stats.records.last7++; userHasIn7 = true; }
                        if (inPeriod(mealDateOnly, 'last30')) { stats.records.last30++; userHasIn30 = true; stats.recentActivity.last30Days++; }
                        userHasInAll = true;
                        if (inPeriod(mealDateOnly, 'last7')) stats.recentActivity.last7Days++;
                    }
                });

                if (userHasInAll) activeUserSets.all.add(userId);
                if (userHasIn30) activeUserSets.last30.add(userId);
                if (userHasIn7) activeUserSets.last7.add(userId);
                if (userHasInToday) activeUserSets.today.add(userId);
            } catch (e) {
                console.warn(`  ⚠️ 사용자 ${userId}의 meals 조회 실패:`, e.code || e.message);
            }
        }

        stats.activeUsers.all = activeUserSets.all.size;
        stats.activeUsers.last30 = activeUserSets.last30.size;
        stats.activeUsers.last7 = activeUserSets.last7.size;
        stats.activeUsers.today = activeUserSets.today.size;
        stats.totalMeals = stats.records.all;

        console.log('📊 대시보드 통계:', stats);
        return stats;
    } catch (e) {
        console.error("❌ Get user statistics error:", e);
        console.error("오류 코드:", e.code);
        console.error("오류 메시지:", e.message);
        throw e;
    }
}

// 공유 게시물 조회 (최신순)
async function getSharedPhotos(pageSize = 100) {
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

// 대시보드 통계 캐시 문서 (adminSettings 사용 — Firestore 규칙에서 관리자 쓰기 허용됨)
const DASHBOARD_STATS_REF = () => doc(db, 'artifacts', appId, 'adminSettings', 'dashboardStats');
// 식당정보 캐시 문서 (전일까지 집계, 당일만 병합으로 읽기 최소화)
const RESTAURANT_STATS_REF = () => doc(db, 'artifacts', appId, 'adminSettings', 'restaurantStats');

/** 통계 객체를 화면에 반영 + 마지막 업데이트 문구 */
function renderDashboardStats(stats, updatedAt) {
    const set = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value != null ? Number(value).toLocaleString() : '-';
    };
    if (stats) {
        set('statGuestVisitsAll', stats.guestVisits?.all);
        set('statGuestVisits30', stats.guestVisits?.last30);
        set('statGuestVisits7', stats.guestVisits?.last7);
        set('statGuestVisitsToday', stats.guestVisits?.today);
        set('statNewUsersAll', stats.newUsers?.all);
        set('statNewUsers30', stats.newUsers?.last30);
        set('statNewUsers7', stats.newUsers?.last7);
        set('statNewUsersToday', stats.newUsers?.today);
        set('statActiveUsersAll', stats.activeUsers?.all);
        set('statActiveUsers30', stats.activeUsers?.last30);
        set('statActiveUsers7', stats.activeUsers?.last7);
        set('statActiveUsersToday', stats.activeUsers?.today);
        set('statRecordsAll', stats.records?.all);
        set('statRecords30', stats.records?.last30);
        set('statRecords7', stats.records?.last7);
        set('statRecordsToday', stats.records?.today);
        set('statSharedAll', stats.sharedPhotos?.all);
        set('statShared30', stats.sharedPhotos?.last30);
        set('statShared7', stats.sharedPhotos?.last7);
        set('statSharedToday', stats.sharedPhotos?.today);
    } else {
        ['statGuestVisitsAll', 'statGuestVisits30', 'statGuestVisits7', 'statGuestVisitsToday',
            'statNewUsersAll', 'statNewUsers30', 'statNewUsers7', 'statNewUsersToday',
            'statActiveUsersAll', 'statActiveUsers30', 'statActiveUsers7', 'statActiveUsersToday',
            'statRecordsAll', 'statRecords30', 'statRecords7', 'statRecordsToday',
            'statSharedAll', 'statShared30', 'statShared7', 'statSharedToday'].forEach(id => set(id, null));
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

/** 오늘 날짜 문자열 (YYYY-MM-DD) */
function getTodayDateString() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// 통계 업데이트: 전일까지는 캐시 1회 읽기, 당일만 필요 시 경량 쿼리로 보정 (DB 읽기 최소화)
async function updateStatistics() {
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
        // 캐시가 오늘 이전 기준이면 당일 숫자만 경량 조회해서 보정 (전일까지는 캐시 유지)
        if (asOfDate && asOfDate !== todayStr) {
            const todayOnly = await getTodayOnlyStats();
            stats.guestVisits.today = todayOnly.guestVisitsToday;
            stats.newUsers.today = todayOnly.newUsersToday;
            stats.sharedPhotos.today = todayOnly.sharedPhotosToday;
            // records/activeUsers 오늘은 집계 비용이 커서 캐시 유지 (통계 새로고침 시 반영)
        }
        renderDashboardStats(stats, data.updatedAt);
    } catch (e) {
        console.error("대시보드 통계 로드 실패:", e);
        renderDashboardStats(null, null);
    } finally {
        if (btn) btn.disabled = false;
    }
}

// 통계 새로고침: 전체 집계 후 캐시 문서에 저장 (이때만 DB 다량 읽기)
async function refreshDashboardStats() {
    const btn = document.getElementById('dashboardStatsRefreshBtn');
    try {
        if (btn) { btn.disabled = true; btn.innerHTML = '집계 중...'; }
        const stats = await getUserStatistics();
        const payload = {
            guestVisits: stats.guestVisits,
            newUsers: stats.newUsers,
            activeUsers: stats.activeUsers,
            records: stats.records,
            sharedPhotos: stats.sharedPhotos,
            asOfDate: getTodayDateString(), // 전일까지 집계 기준일 (당일 로드 시 이 날짜 이전이면 당일만 경량 조회)
            updatedAt: serverTimestamp()
        };
        await setDoc(DASHBOARD_STATS_REF(), payload);
        renderDashboardStats(stats, new Date());
    } catch (e) {
        console.error("통계 새로고침 실패:", e);
        alert("통계 새로고침 중 오류가 발생했습니다: " + (e.message || e));
    } finally {
        const b = document.getElementById('dashboardStatsRefreshBtn');
        if (b) {
            b.disabled = false;
            b.innerHTML = '<i class="fa-solid fa-rotate-right mr-1"></i>통계 새로고침';
        }
    }
}

// 공유 게시물 렌더링
async function renderSharedPhotos() {
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

// 관리자 로그인
window.handleAdminLogin = async function() {
    console.log('🔐 handleAdminLogin 호출됨');
    const email = document.getElementById('adminEmail').value;
    const password = document.getElementById('adminPassword').value;
    const errorDiv = document.getElementById('loginError');
    
    if (!email || !password) {
        errorDiv.textContent = "이메일과 비밀번호를 입력해주세요.";
        errorDiv.classList.remove('hidden');
        return;
    }
    
    document.getElementById('loadingOverlay').classList.remove('hidden');
    errorDiv.classList.add('hidden');
    
    try {
        const userCredential = await signInWithEmailAndPassword(adminAuth, email, password);
        const userId = userCredential.user.uid;
        
        console.log('🔐 로그인 성공:', {
            email: email,
            uid: userId
        });
        
        // ADMIN 권한 확인
        const isAdmin = await checkAdminStatus(userId);
        
        if (!isAdmin) {
            await signOut(adminAuth);
            errorDiv.textContent = "관리자 권한이 없습니다. 브라우저 콘솔(F12)을 확인하세요.";
            errorDiv.classList.remove('hidden');
            document.getElementById('loadingOverlay').classList.add('hidden');
            console.log('❌ 관리자 권한 없음. Firebase 콘솔에서 확인: artifacts/mealog-r0/admins/' + userId);
            return;
        }
        
        // 로그인 성공
        showAdminPage(userCredential.user);
        
    } catch (e) {
        console.error("로그인 실패:", e);
        let errorMsg = "로그인 실패: ";
        if (e.code === 'auth/wrong-password') errorMsg += "비밀번호가 틀렸습니다.";
        else if (e.code === 'auth/user-not-found') errorMsg += "존재하지 않는 계정입니다.";
        else if (e.code === 'auth/invalid-email') errorMsg += "유효하지 않은 이메일입니다.";
        else errorMsg += e.message;
        
        errorDiv.textContent = errorMsg;
        errorDiv.classList.remove('hidden');
    } finally {
        document.getElementById('loadingOverlay').classList.add('hidden');
    }
};

// 관리자 페이지 표시
function showAdminPage(user) {
    const loginPage = document.getElementById('loginPage');
    const adminPage = document.getElementById('adminPage');
    const adminUserInfo = document.getElementById('adminUserInfo');
    const loadingOverlay = document.getElementById('loadingOverlay');
    
    if (loginPage) loginPage.classList.add('hidden');
    if (adminPage) adminPage.classList.remove('hidden');
    if (adminUserInfo) adminUserInfo.textContent = user.email || '관리자';
    
    // 로딩 오버레이 숨기기
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
    
    // 데이터 로드
    updateStatistics();
    renderSharedPhotos();
    window.switchAdminTab('dashboard');
}

// 어드민 탭 전환
window.switchAdminTab = function(tab) {
    // 모든 탭 버튼 비활성화
    document.querySelectorAll('.admin-tab').forEach(btn => {
        btn.classList.remove('active', 'text-emerald-600', 'border-b-2', 'border-emerald-600');
        btn.classList.add('text-slate-500');
    });
    
    // 모든 탭 컨텐츠 숨기기
    document.querySelectorAll('.admin-tab-content').forEach(content => {
        content.classList.add('hidden');
    });
    
    // 선택한 탭 활성화
    const activeTabBtn = document.getElementById(`admin-tab-${tab}`);
    const activeTabContent = document.getElementById(`admin-tab-content-${tab}`);
    
    if (activeTabBtn) {
        activeTabBtn.classList.add('active', 'text-emerald-600', 'border-b-2', 'border-emerald-600');
        activeTabBtn.classList.remove('text-slate-500');
    }
    
    if (activeTabContent) {
        activeTabContent.classList.remove('hidden');
    }
    
    // 탭별 데이터 새로고침
    if (tab === 'dashboard') {
        updateStatistics();
    } else if (tab === 'monitoring') {
        switchMonitoringSidebar('feed'); // 기본으로 피드 관리 표시
        renderFeedManagement();
        loadAdminSettings(); // 공지·댓글 표시 이름 캐시 로드
    } else if (tab === 'persona') {
        // 페르소나 탭은 더 이상 사용하지 않음
    } else if (tab === 'users') {
        renderUsers();
    } else if (tab === 'content') {
        switchContentSidebar('notice'); // 사이드바 첫 메뉴(공지 관리) 기본 선택
    }
}

// 관리자 로그아웃
window.handleAdminLogout = async function() {
    try {
        await signOut(adminAuth);
        document.getElementById('adminPage').classList.add('hidden');
        document.getElementById('loginPage').classList.remove('hidden');
        document.getElementById('adminEmail').value = '';
        document.getElementById('adminPassword').value = '';
    } catch (e) {
        console.error("로그아웃 실패:", e);
        alert("로그아웃 중 오류가 발생했습니다.");
    }
};

// 대시보드 통계 새로고침 (전체 집계 후 캐시 문서에 저장)
window.refreshDashboardStats = refreshDashboardStats;

// 공유 게시물 새로고침
window.refreshSharedPhotos = async function() {
    await renderSharedPhotos();
    await updateStatistics();
};

// 삭제 모달 열기
window.openDeleteModal = function(photoId) {
    currentDeletePhotoId = photoId;
    document.getElementById('deleteModal').classList.remove('hidden');
};

// 삭제 모달 닫기
window.closeDeleteModal = function() {
    currentDeletePhotoId = null;
    document.getElementById('deleteModal').classList.add('hidden');
};

// 게시물 삭제 확인
window.confirmDeletePhoto = async function() {
    if (!currentDeletePhotoId) return;
    
    const btn = document.getElementById('confirmDeleteBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>삭제 중...';
    
    try {
        await deleteDoc(doc(db, 'artifacts', appId, 'sharedPhotos', currentDeletePhotoId));
        window.closeDeleteModal();
        await renderSharedPhotos();
        await updateStatistics();
        
        // 성공 메시지
        const successDiv = document.createElement('div');
        successDiv.className = 'fixed top-4 right-4 bg-emerald-600 text-white px-6 py-3 rounded-xl shadow-lg z-[600] flex items-center gap-2';
        successDiv.innerHTML = '<i class="fa-solid fa-check"></i> <span>게시물이 삭제되었습니다.</span>';
        document.body.appendChild(successDiv);
        setTimeout(() => successDiv.remove(), 3000);
        
    } catch (e) {
        console.error("게시물 삭제 실패:", e);
        alert("삭제 중 오류가 발생했습니다: " + e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '삭제';
    }
};

// 인증 상태 변경 리스너
onAuthStateChanged(adminAuth, async (user) => {
    const loadingOverlay = document.getElementById('loadingOverlay');
    const loginPage = document.getElementById('loginPage');
    const adminPage = document.getElementById('adminPage');
    
    try {
        if (user) {
            // ADMIN 권한 확인
            const isAdmin = await checkAdminStatus(user.uid);
            if (isAdmin) {
                if (loginPage) loginPage.classList.add('hidden');
                if (adminPage) adminPage.classList.remove('hidden');
                showAdminPage(user);
            } else {
                // ADMIN 권한 없음 - 로그인 페이지 표시
                if (adminPage) adminPage.classList.add('hidden');
                if (loginPage) loginPage.classList.remove('hidden');
                // 이미 로그인되어 있으면 로그아웃
                try {
                    await signOut(adminAuth);
                } catch (e) {
                    console.error("로그아웃 실패:", e);
                }
            }
        } else {
            // 로그인 안됨 - 로그인 페이지 표시
            if (adminPage) adminPage.classList.add('hidden');
            if (loginPage) loginPage.classList.remove('hidden');
        }
    } catch (e) {
        console.error("인증 상태 확인 오류:", e);
        if (adminPage) adminPage.classList.add('hidden');
        if (loginPage) loginPage.classList.remove('hidden');
    } finally {
        // 로딩 오버레이 숨기기
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
});

// 페이지 로드 시 초기화
function initAdminPage() {
    console.log('🔧 initAdminPage 실행');
    // 초기 상태 설정 - 로그인 페이지 표시, 로딩 오버레이 숨김
    const loadingOverlay = document.getElementById('loadingOverlay');
    const loginPage = document.getElementById('loginPage');
    const adminPage = document.getElementById('adminPage');
    
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
    if (loginPage) loginPage.classList.remove('hidden');
    if (adminPage) adminPage.classList.add('hidden');
    
    // 로그인 버튼 이벤트 리스너
    const loginBtn = document.getElementById('loginBtn');
    console.log('🔧 loginBtn 찾기:', loginBtn);
    if (loginBtn) {
        loginBtn.addEventListener('click', (e) => {
            console.log('🔧 로그인 버튼 클릭됨');
            e.preventDefault();
            if (window.handleAdminLogin) {
                window.handleAdminLogin();
            } else {
                console.error('❌ window.handleAdminLogin이 정의되지 않음');
            }
        });
        console.log('✅ 로그인 버튼 이벤트 리스너 등록됨');
    } else {
        console.error('❌ loginBtn을 찾을 수 없음');
    }
    
    // 공지 내용 포맷 툴바 (Bold, 취소선, 밑줄)
    document.querySelectorAll('.notice-format-toolbar-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const contentEl = document.getElementById('noticeContent');
            if (!contentEl) return;
            contentEl.focus();
            const cmd = btn.getAttribute('data-format');
            if (cmd) document.execCommand(cmd, false, null);
        });
    });
    const noticeAddPhotosBtn = document.getElementById('noticeAddPhotosBtn');
    const noticeImagesInput = document.getElementById('noticeImages');
    if (noticeAddPhotosBtn && noticeImagesInput) {
        noticeAddPhotosBtn.addEventListener('click', () => noticeImagesInput.click());
    }
    if (noticeImagesInput) {
        noticeImagesInput.addEventListener('change', (e) => {
            const existing = (window.noticeExistingUrls || []).length;
            const filesCount = (window.noticeFiles || []).length;
            const total = existing + filesCount;
            const canAdd = Math.max(0, 3 - total);
            const files = Array.from(e.target.files || []).slice(0, canAdd);
            if (files.length === 0) {
                if ((e.target.files || []).length > canAdd && canAdd === 0) alert('사진은 최대 3장까지 추가할 수 있습니다.');
                e.target.value = '';
                return;
            }
            if (!window.noticeFiles) window.noticeFiles = [];
            if (!window.noticeObjectUrls) window.noticeObjectUrls = [];
            files.forEach(f => {
                if (!f.type.startsWith('image/')) return;
                window.noticeFiles.push(f);
                window.noticeObjectUrls.push(URL.createObjectURL(f));
            });
            renderNoticeImagePreviews();
            e.target.value = '';
        });
    }
    const noticeContentEl = document.getElementById('noticeContent');
    if (noticeContentEl) {
        const syncPlaceholder = () => {
            const isEmpty = !(noticeContentEl.innerText || '').trim();
            noticeContentEl.classList.toggle('format-editor-empty', isEmpty);
        };
        noticeContentEl.addEventListener('input', syncPlaceholder);
        noticeContentEl.addEventListener('blur', syncPlaceholder);
        noticeContentEl.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = (e.clipboardData || window.clipboardData)?.getData('text/plain') || '';
            document.execCommand('insertText', false, text);
        });
    }
    
    // 팝업 내용 포맷 툴바 및 사진 추가
    document.querySelectorAll('.popup-format-toolbar-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const contentEl = document.getElementById('popupContent');
            if (!contentEl) return;
            contentEl.focus();
            const cmd = btn.getAttribute('data-format');
            if (cmd) document.execCommand(cmd, false, null);
        });
    });
    const popupAddPhotosBtn = document.getElementById('popupAddPhotosBtn');
    const popupImagesInput = document.getElementById('popupImages');
    if (popupAddPhotosBtn && popupImagesInput) {
        popupAddPhotosBtn.addEventListener('click', () => popupImagesInput.click());
    }
    if (popupImagesInput) {
        popupImagesInput.addEventListener('change', (e) => {
            const existing = (window.popupExistingUrls || []).length;
            const filesCount = (window.popupFiles || []).length;
            const total = existing + filesCount;
            const canAdd = Math.max(0, 3 - total);
            const files = Array.from(e.target.files || []).slice(0, canAdd);
            if (files.length === 0) {
                if ((e.target.files || []).length > canAdd && canAdd === 0) alert('사진은 최대 3장까지 추가할 수 있습니다.');
                e.target.value = '';
                return;
            }
            if (!window.popupFiles) window.popupFiles = [];
            if (!window.popupObjectUrls) window.popupObjectUrls = [];
            files.forEach(f => {
                if (!f.type.startsWith('image/')) return;
                window.popupFiles.push(f);
                window.popupObjectUrls.push(URL.createObjectURL(f));
            });
            renderPopupImagePreviews();
            e.target.value = '';
        });
    }
    const popupContentEl = document.getElementById('popupContent');
    if (popupContentEl) {
        const syncPlaceholder = () => {
            const isEmpty = !(popupContentEl.innerText || '').trim();
            popupContentEl.classList.toggle('format-editor-empty', isEmpty);
        };
        popupContentEl.addEventListener('input', syncPlaceholder);
        popupContentEl.addEventListener('blur', syncPlaceholder);
        popupContentEl.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = (e.clipboardData || window.clipboardData)?.getData('text/plain') || '';
            document.execCommand('insertText', false, text);
        });
    }
    
    // 로그인 배너 UI
    const loginBannerImageBtn = document.getElementById('loginBannerImageBtn');
    const loginBannerImageInput = document.getElementById('loginBannerImageInput');
    const loginBannerImageRemoveBtn = document.getElementById('loginBannerImageRemoveBtn');
    const loginBannerSaveBtn = document.getElementById('loginBannerSaveBtn');
    if (loginBannerImageBtn && loginBannerImageInput) {
        loginBannerImageBtn.addEventListener('click', () => loginBannerImageInput.click());
    }
    if (loginBannerImageInput) {
        loginBannerImageInput.addEventListener('change', (e) => {
            const file = (e.target.files && e.target.files[0]) ? e.target.files[0] : null;
            window.loginBannerFile = file && file.type.startsWith('image/') ? file : null;
            window.loginBannerRemoveImage = false;
            const labelEl = document.getElementById('loginBannerImageLabel');
            const previewEl = document.getElementById('loginBannerImagePreview');
            if (labelEl) labelEl.textContent = window.loginBannerFile ? file.name : '선택된 이미지 없음';
            if (previewEl) {
                previewEl.innerHTML = '';
                if (window.loginBannerFile) {
                    const img = document.createElement('img');
                    img.src = URL.createObjectURL(window.loginBannerFile);
                    img.alt = '미리보기';
                    img.className = 'max-w-full h-auto rounded-xl border border-slate-200 object-contain max-h-24';
                    previewEl.appendChild(img);
                }
            }
            e.target.value = '';
        });
    }
    if (loginBannerImageRemoveBtn) {
        loginBannerImageRemoveBtn.addEventListener('click', () => {
            window.loginBannerFile = null;
            window.loginBannerRemoveImage = true;
            const labelEl = document.getElementById('loginBannerImageLabel');
            const previewEl = document.getElementById('loginBannerImagePreview');
            if (labelEl) labelEl.textContent = '선택된 이미지 없음 (저장 시 이미지 제거됨)';
            if (previewEl) previewEl.innerHTML = '';
            const inputEl = document.getElementById('loginBannerImageInput');
            if (inputEl) inputEl.value = '';
        });
    }
    if (loginBannerSaveBtn) {
        loginBannerSaveBtn.addEventListener('click', () => window.saveLoginBanner());
    }
    const loginBannerLandingNoticeBtn = document.getElementById('loginBannerLandingNoticeBtn');
    const loginBannerLandingClearBtn = document.getElementById('loginBannerLandingClearBtn');
    const loginBannerLandingNoticeModalClose = document.getElementById('loginBannerLandingNoticeModalClose');
    if (loginBannerLandingNoticeBtn) {
        loginBannerLandingNoticeBtn.addEventListener('click', () => window.openLoginBannerLandingNoticeSelect());
    }
    if (loginBannerLandingClearBtn) {
        loginBannerLandingClearBtn.addEventListener('click', () => {
            const landingIdEl = document.getElementById('loginBannerLandingNoticeId');
            const landingLabelEl = document.getElementById('loginBannerLandingLabel');
            const landingSelectedWrap = document.getElementById('loginBannerLandingSelectedWrap');
            const landingSelectedTitle = document.getElementById('loginBannerLandingSelectedTitle');
            if (landingIdEl) landingIdEl.value = '';
            if (landingLabelEl) landingLabelEl.textContent = '공지 선택하기';
            if (landingSelectedWrap) landingSelectedWrap.classList.add('hidden');
            if (landingSelectedTitle) landingSelectedTitle.textContent = '';
            window.loginBannerLandingNoticeTitle = '';
        });
    }
    if (loginBannerLandingNoticeModalClose) {
        loginBannerLandingNoticeModalClose.addEventListener('click', () => window.closeLoginBannerLandingNoticeSelect());
    }

    // Enter 키로 로그인
    const passwordInput = document.getElementById('adminPassword');
    if (passwordInput) {
        passwordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                if (window.handleAdminLogin) {
                    window.handleAdminLogin();
                }
            }
        });
    }
    
    // 일정 시간 후에도 로딩이 계속되면 숨기기 (안전장치)
    setTimeout(() => {
        const loadingOverlay = document.getElementById('loadingOverlay');
        const loginPage = document.getElementById('loginPage');
        if (loadingOverlay && !loadingOverlay.classList.contains('hidden')) {
            console.warn("로딩 타임아웃 - 로딩 오버레이 강제로 숨김");
            loadingOverlay.classList.add('hidden');
            if (loginPage) loginPage.classList.remove('hidden');
        }
    }, 5000);
}

// DOM 준비 상태 확인 후 초기화
if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initAdminPage);
} else {
    // DOM이 이미 준비되었으면 즉시 실행
    setTimeout(initAdminPage, 0); // 다음 이벤트 루프에서 실행
}

// 모니터링 사이드바 전환
window.switchMonitoringSidebar = function(section) {
    // 모든 사이드바 버튼 비활성화
    document.querySelectorAll('[id^="monitoring-sidebar-"]').forEach(btn => {
        btn.classList.remove('text-emerald-600', 'bg-emerald-50');
        btn.classList.add('text-slate-500', 'hover:bg-slate-50');
    });
    
    // 모든 메인 섹션 숨기기
    document.querySelectorAll('.monitoring-main-section').forEach(sec => {
        sec.classList.add('hidden');
    });
    
    // 선택한 사이드바 버튼 활성화
    const activeSidebarBtn = document.getElementById(`monitoring-sidebar-${section}`);
    const activeMainSection = document.getElementById(`monitoring-main-${section}`);
    
    if (activeSidebarBtn) {
        activeSidebarBtn.classList.add('text-emerald-600', 'bg-emerald-50');
        activeSidebarBtn.classList.remove('text-slate-500', 'hover:bg-slate-50');
    }
    
    if (activeMainSection) {
        activeMainSection.classList.remove('hidden');
    }
    
    // 섹션별 데이터 로드
    if (section === 'feed') {
        renderFeedManagement();
    } else if (section === 'board') {
        renderBoardPosts(currentAdminBoardCategory);
    } else if (section === 'restaurants') {
        renderRestaurantData(currentRestaurantFilter || 'all', currentRestaurantSlotFilter || 'all');
    }
};

// 콘텐츠 관리 관련 함수들

// 사이드바 전환
window.switchContentSidebar = function(section) {
    // 모든 사이드바 버튼 비활성화
    document.querySelectorAll('[id^="content-sidebar-"]').forEach(btn => {
        btn.classList.remove('text-emerald-600', 'bg-emerald-50');
        btn.classList.add('text-slate-500', 'hover:bg-slate-50');
    });
    
    // 모든 메인 섹션 숨기기
    document.querySelectorAll('.content-main-section').forEach(sec => {
        sec.classList.add('hidden');
    });
    
    // 선택한 사이드바 버튼 활성화
    const activeSidebarBtn = document.getElementById(`content-sidebar-${section}`);
    const activeMainSection = document.getElementById(`content-main-${section}`);
    
    if (activeSidebarBtn) {
        activeSidebarBtn.classList.add('text-emerald-600', 'bg-emerald-50');
        activeSidebarBtn.classList.remove('text-slate-500', 'hover:bg-slate-50');
    }
    
    if (activeMainSection) {
        activeMainSection.classList.remove('hidden');
    }
    
    // 섹션별 데이터 로드
    if (section === 'mealog') {
        loadMealogComments();
    } else if (section === 'characters') {
        showCharacterListView();
    } else if (section === 'terms') {
        loadTermsContent();
        // 약관관리 탭이 기본이므로 약관이력은 나중에 로드
    } else if (section === 'tags') {
        loadTagsContent();
    } else if (section === 'apk') {
        bindApkFileInput();
        loadApkContent();
    } else if (section === 'notice') {
        renderNotices();
    } else if (section === 'popup') {
        renderPopups();
    } else if (section === 'loginBanner') {
        loadLoginBannerConfig();
    } else if (section === 'settings') {
        loadAdminSettings();
    }
};

// 로그인 배너 표시 환경 라벨 (스테이징 = 로컬 포함)
const LOGIN_BANNER_TARGET_ENV_LABELS = { all: '전체', production: '프로덕션만', staging: '스테이징만 (로컬 포함)' };

// 로그인 배너 설정 로드
async function loadLoginBannerConfig() {
    const enabledEl = document.getElementById('loginBannerEnabled');
    const targetEnvEl = document.getElementById('loginBannerTargetEnv');
    const labelEl = document.getElementById('loginBannerImageLabel');
    const previewEl = document.getElementById('loginBannerImagePreview');
    const inputEl = document.getElementById('loginBannerImageInput');
    const landingIdEl = document.getElementById('loginBannerLandingNoticeId');
    const landingLabelEl = document.getElementById('loginBannerLandingLabel');
    const landingSelectedWrap = document.getElementById('loginBannerLandingSelectedWrap');
    const landingSelectedTitle = document.getElementById('loginBannerLandingSelectedTitle');
    if (!enabledEl) return;
    window.loginBannerFile = null;
    window.loginBannerRemoveImage = false;
    if (inputEl) inputEl.value = '';
    try {
        const bannerDoc = await getDoc(doc(db, 'artifacts', appId, 'config', 'loginBanner'));
        const data = bannerDoc.exists() ? bannerDoc.data() : null;
        enabledEl.checked = !!(data && data.enabled);
        const targetEnv = (data && (data.targetEnv === 'production' || data.targetEnv === 'staging')) ? data.targetEnv : 'all';
        if (targetEnvEl) targetEnvEl.value = targetEnv;
        const imageUrl = (data && data.imageUrl && typeof data.imageUrl === 'string') ? data.imageUrl.trim() : '';
        if (labelEl) labelEl.textContent = imageUrl ? '등록된 이미지 있음' : '선택된 이미지 없음';
        if (previewEl) {
            previewEl.innerHTML = '';
            if (imageUrl) {
                const img = document.createElement('img');
                img.src = imageUrl;
                img.alt = '배너 미리보기';
                img.className = 'max-w-full h-auto rounded-xl border border-slate-200 object-contain max-h-24';
                previewEl.appendChild(img);
            }
        }
        const lid = (data && data.landingNoticeId && typeof data.landingNoticeId === 'string') ? data.landingNoticeId.trim() : '';
        const ltitle = (data && data.landingNoticeTitle && typeof data.landingNoticeTitle === 'string') ? data.landingNoticeTitle.trim() : '';
        if (landingIdEl) landingIdEl.value = lid;
        if (landingLabelEl) landingLabelEl.textContent = lid ? '공지 변경하기' : '공지 선택하기';
        if (landingSelectedWrap) landingSelectedWrap.classList.toggle('hidden', !lid);
        if (landingSelectedTitle) landingSelectedTitle.textContent = ltitle || '(공지)';
        window.loginBannerLandingNoticeTitle = ltitle || '';
    } catch (e) {
        console.error('로그인 배너 설정 로드 실패:', e);
        if (labelEl) labelEl.textContent = '로드 실패';
    }
}

// 로그인 배너 저장
window.saveLoginBanner = async function() {
    const enabledEl = document.getElementById('loginBannerEnabled');
    const saveBtn = document.getElementById('loginBannerSaveBtn');
    if (!enabledEl || !saveBtn) return;
    const enabled = enabledEl.checked;
    let imageUrl = null;
    if (enabled && window.loginBannerRemoveImage) {
        imageUrl = null;
    } else if (enabled && window.loginBannerFile) {
        saveBtn.disabled = true;
        saveBtn.textContent = '업로드 중...';
        try {
            imageUrl = await uploadLoginBannerImage(window.loginBannerFile, appId);
        } catch (e) {
            console.error('배너 이미지 업로드 실패:', e);
            alert('이미지 업로드에 실패했습니다.');
            saveBtn.disabled = false;
            saveBtn.textContent = '저장';
            return;
        }
        saveBtn.disabled = false;
        saveBtn.textContent = '저장';
    } else if (enabled) {
        const bannerDoc = await getDoc(doc(db, 'artifacts', appId, 'config', 'loginBanner'));
        const data = bannerDoc.exists() ? bannerDoc.data() : null;
        imageUrl = (data && data.imageUrl && typeof data.imageUrl === 'string') ? data.imageUrl.trim() : null;
        if (imageUrl === '') imageUrl = null;
    }
    const landingIdEl = document.getElementById('loginBannerLandingNoticeId');
    const landingNoticeId = (landingIdEl && landingIdEl.value) ? landingIdEl.value.trim() : '';
    const landingNoticeTitle = window.loginBannerLandingNoticeTitle || '';
    const targetEnvEl = document.getElementById('loginBannerTargetEnv');
    const targetEnv = (targetEnvEl && (targetEnvEl.value === 'production' || targetEnvEl.value === 'staging')) ? targetEnvEl.value : 'all';
    try {
        const payload = {
            enabled,
            targetEnv: targetEnv || 'all',
            imageUrl: imageUrl || null,
            updatedAt: new Date().toISOString()
        };
        if (landingNoticeId) {
            payload.landingNoticeId = landingNoticeId;
            payload.landingNoticeTitle = landingNoticeTitle;
        } else {
            payload.landingNoticeId = deleteField();
            payload.landingNoticeTitle = deleteField();
        }
        await setDoc(doc(db, 'artifacts', appId, 'config', 'loginBanner'), payload, { merge: true });
        alert('저장되었습니다.');
        loadLoginBannerConfig();
    } catch (e) {
        console.error('로그인 배너 저장 실패:', e);
        alert('저장에 실패했습니다: ' + (e.message || e));
    }
};

window.openLoginBannerLandingNoticeSelect = async function() {
    const modal = document.getElementById('loginBannerLandingNoticeModal');
    const listEl = document.getElementById('loginBannerLandingNoticeList');
    if (!modal || !listEl) return;
    listEl.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-xl mb-2"></i><p class="text-sm">로딩 중...</p></div>';
    modal.classList.remove('hidden');
    try {
        const noticesColl = collection(db, 'artifacts', appId, 'notices');
        const snap = await getDocs(query(noticesColl, orderBy('timestamp', 'desc')));
        if (snap.empty) {
            listEl.innerHTML = '<div class="text-center py-8 text-slate-400"><p class="text-sm">등록된 공지가 없습니다.</p></div>';
            return;
        }
        listEl.innerHTML = snap.docs.map(d => {
            const n = d.data();
            const id = d.id;
            const title = (n.title || '제목 없음').trim();
            return `<button type="button" data-notice-id="${escapeHtml(id)}" data-notice-title="${escapeHtml(title)}" class="login-banner-landing-notice-btn w-full text-left px-4 py-3 rounded-xl border border-slate-200 hover:bg-slate-50 hover:border-emerald-300 transition-colors">
                <span class="font-bold text-slate-800">${escapeHtml(title)}</span>
            </button>`;
        }).join('');
        listEl.querySelectorAll('.login-banner-landing-notice-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const noticeId = btn.getAttribute('data-notice-id');
                const noticeTitle = btn.getAttribute('data-notice-title') || '(공지)';
                window.loginBannerLandingNoticeTitle = noticeTitle;
                const landingIdEl = document.getElementById('loginBannerLandingNoticeId');
                const landingLabelEl = document.getElementById('loginBannerLandingLabel');
                const landingSelectedWrap = document.getElementById('loginBannerLandingSelectedWrap');
                const landingSelectedTitle = document.getElementById('loginBannerLandingSelectedTitle');
                if (landingIdEl) landingIdEl.value = noticeId;
                if (landingLabelEl) landingLabelEl.textContent = '공지 변경하기';
                if (landingSelectedWrap) landingSelectedWrap.classList.remove('hidden');
                if (landingSelectedTitle) landingSelectedTitle.textContent = noticeTitle;
                window.closeLoginBannerLandingNoticeSelect();
            });
        });
    } catch (e) {
        console.error('공지 목록 로드 실패:', e);
        listEl.innerHTML = '<div class="text-center py-8 text-red-400"><p class="text-sm">공지 목록을 불러오는 중 오류가 발생했습니다.</p></div>';
    }
};

window.closeLoginBannerLandingNoticeSelect = function() {
    const modal = document.getElementById('loginBannerLandingNoticeModal');
    if (modal) modal.classList.add('hidden');
};

// APK 배포 콘텐츠 로드
async function loadApkContent() {
    const container = document.getElementById('apkCurrentInfo');
    const linkEl = document.getElementById('apkDownloadPageLink');
    if (!container) return;
    try {
        const apkDoc = doc(db, 'artifacts', appId, 'content', 'apk');
        const apkSnap = await getDoc(apkDoc);
        if (apkSnap.exists()) {
            const d = apkSnap.data();
            const updatedAt = d.updatedAt?.toDate?.();
            const sizeMb = d.fileSize ? (d.fileSize / (1024 * 1024)).toFixed(2) : '-';
            container.innerHTML = `
                <div class="flex items-center gap-2">
                    <span class="text-emerald-600 font-bold">${d.fileName || '-'}</span>
                    ${d.version ? `<span class="px-2 py-0.5 bg-slate-200 rounded text-xs">v${d.version}</span>` : ''}
                </div>
                <p class="text-sm text-slate-600">용량: ${sizeMb} MB</p>
                <p class="text-sm text-slate-500">등록일: ${updatedAt ? updatedAt.toLocaleString('ko-KR') : '-'}</p>
                <a href="${d.downloadUrl}" target="_blank" class="inline-flex items-center gap-2 mt-2 px-3 py-2 bg-emerald-100 text-emerald-700 rounded-lg text-sm font-bold hover:bg-emerald-200 transition-colors">
                    <i class="fa-solid fa-download"></i> 다운로드 링크
                </a>
            `;
        } else {
            container.innerHTML = '<p class="text-sm text-slate-500">등록된 APK가 없습니다. 위에서 APK 파일을 업로드해주세요.</p>';
        }
        if (linkEl) linkEl.href = new URL('./download.html', window.location.href).href;
    } catch (e) {
        console.error('APK 정보 로드 실패:', e);
        container.innerHTML = '<p class="text-sm text-red-500">로드 실패</p>';
    }
}

// APK 파일 업로드
window.uploadApkFile = async function() {
    const input = document.getElementById('apkFileInput');
    const uploadBtn = document.getElementById('apkUploadBtn');
    const statusEl = document.getElementById('apkUploadStatus');
    const versionInput = document.getElementById('apkVersionInput');
    if (!input?.files?.length) {
        if (typeof showToast === 'function') showToast('APK 파일을 선택해주세요.');
        return;
    }
    const file = input.files[0];
    if (!file.name.toLowerCase().endsWith('.apk')) {
        if (typeof showToast === 'function') showToast('APK 파일만 업로드할 수 있습니다.');
        return;
    }
    if (file.size > 100 * 1024 * 1024) {
        if (typeof showToast === 'function') showToast('파일 크기는 100MB 이하여야 합니다.');
        return;
    }
    try {
        uploadBtn.disabled = true;
        if (statusEl) {
            statusEl.className = 'mt-2 text-sm text-slate-600';
            statusEl.textContent = '업로드 URL 요청 중...';
            statusEl.classList.remove('hidden');
        }
        const { uploadUrl, fileName } = await callableFunctions.getApkUploadUrl({
            fileName: file.name,
            version: (versionInput?.value || '').trim()
        }).then(r => r.data);
        if (statusEl) statusEl.textContent = '파일 업로드 중...';
        const res = await fetch(uploadUrl, {
            method: 'PUT',
            body: file,
            headers: { 'Content-Type': 'application/vnd.android.package-archive' }
        });
        if (!res.ok) {
            throw new Error(`업로드 실패: ${res.status}`);
        }
        if (statusEl) statusEl.textContent = '메타데이터 저장 중...';
        await callableFunctions.confirmApkUpload({
            fileName,
            version: (versionInput?.value || '').trim(),
            fileSize: file.size
        });
        if (statusEl) {
            statusEl.className = 'mt-2 text-sm text-emerald-600';
            statusEl.textContent = '업로드 완료!';
        }
        if (typeof showToast === 'function') showToast('APK 업로드가 완료되었습니다.');
        loadApkContent();
        input.value = '';
        document.getElementById('apkFileInfo')?.classList.add('hidden');
    } catch (e) {
        console.error('APK 업로드 실패:', e);
        if (statusEl) {
            statusEl.className = 'mt-2 text-sm text-red-600';
            statusEl.textContent = '업로드 실패: ' + (e.message || '알 수 없는 오류');
            statusEl.classList.remove('hidden');
        }
        if (typeof showToast === 'function') showToast('업로드 실패: ' + (e.message || '알 수 없는 오류'));
    } finally {
        uploadBtn.disabled = false;
    }
};

// APK 파일 선택 시 UI 업데이트 (한 번만 바인딩)
let apkFileInputBound = false;
function bindApkFileInput() {
    if (apkFileInputBound) return;
    const apkInput = document.getElementById('apkFileInput');
    const apkInfo = document.getElementById('apkFileInfo');
    const apkUploadBtn = document.getElementById('apkUploadBtn');
    if (apkInput && apkInfo && apkUploadBtn) {
        apkInput.addEventListener('change', (e) => {
            const f = e.target.files?.[0];
            if (f) {
                apkInfo.textContent = `${f.name} (${(f.size / (1024 * 1024)).toFixed(2)} MB)`;
                apkInfo.classList.remove('hidden');
                apkUploadBtn.disabled = false;
            } else {
                apkInfo.classList.add('hidden');
                apkUploadBtn.disabled = true;
            }
        });
        apkFileInputBound = true;
    }
}

// 약관 콘텐츠 로드
async function loadTermsContent() {
    const termsDisplay = document.getElementById('termsContentDisplay');
    const termsEditor = document.getElementById('termsContentEditor');
    const termsTextarea = document.getElementById('termsContentTextarea');
    const privacyDisplay = document.getElementById('privacyContentDisplay');
    const privacyEditor = document.getElementById('privacyContentEditor');
    const privacyTextarea = document.getElementById('privacyContentTextarea');
    const termsUpdatedAt = document.getElementById('termsUpdatedAt');
    const privacyUpdatedAt = document.getElementById('privacyUpdatedAt');
    
    if (!termsDisplay || !termsEditor || !termsTextarea || !privacyDisplay || !privacyEditor || !privacyTextarea) return;
    
    try {
        // Firestore에서 약관 데이터 가져오기
        const termsDoc = doc(db, 'artifacts', appId, 'content', 'terms');
        const termsSnap = await getDoc(termsDoc);
        
        let termsData = {
            terms: '본 약관은 MEALOG(이하 "회사")가 제공하는 식사 기록 서비스의 이용과 관련하여 회사와 이용자 간의 권리, 의무 및 책임사항을 규정함을 목적으로 합니다.\n\n제1조 (정의)\n1. "서비스"란 회사가 제공하는 식사 기록 및 관리 서비스를 의미합니다.\n2. "이용자"란 본 약관에 동의하고 회사가 제공하는 서비스를 이용하는 자를 의미합니다.\n\n제2조 (서비스의 제공)\n회사는 다음과 같은 서비스를 제공합니다: 식사 기록, 통계 분석, 사진 공유 등\n\n제3조 (이용자의 의무)\n이용자는 서비스를 이용함에 있어 관련 법령을 준수해야 합니다.',
            privacy: '회사는 다음의 목적을 위하여 개인정보를 처리합니다:\n1. 서비스 제공 및 계약의 이행\n2. 회원 관리 및 본인 확인\n3. 서비스 개선 및 신규 서비스 개발\n\n제1조 (수집하는 개인정보의 항목)\n회사는 다음과 같은 개인정보를 수집합니다:\n1. 필수항목: 이메일, 닉네임, 프로필 아이콘\n2. 선택항목: 위치 정보 (카카오 지도 이용 시)\n\n제2조 (개인정보의 보유 및 이용기간)\n회원 탈퇴 시까지 보유하며, 탈퇴 후 즉시 파기합니다.',
            updatedAt: null
        };
        
        if (termsSnap.exists()) {
            const data = termsSnap.data();
            // 기존 배열 형식에서 단일 텍스트로 변환
            if (data.terms) {
                if (Array.isArray(data.terms)) {
                    // 배열 형식인 경우 통합
                    termsData.terms = data.terms.map(item => {
                        const title = item.title || '';
                        const content = item.content || '';
                        return title ? `${title}\n${content}` : content;
                    }).join('\n\n');
                } else {
                    // 이미 단일 텍스트인 경우
                    termsData.terms = data.terms;
                }
            }
            if (data.privacy) {
                if (Array.isArray(data.privacy)) {
                    // 배열 형식인 경우 통합
                    termsData.privacy = data.privacy.map(item => {
                        const title = item.title || '';
                        const content = item.content || '';
                        return title ? `${title}\n${content}` : content;
                    }).join('\n\n');
                } else {
                    // 이미 단일 텍스트인 경우
                    termsData.privacy = data.privacy;
                }
            }
            if (data.updatedAt) {
                termsData.updatedAt = data.updatedAt;
            }
        }
        
        // 약관 렌더링 (읽기 모드)
        renderTermsContent('terms', termsData.terms, termsData.updatedAt);
        renderTermsContent('privacy', termsData.privacy, termsData.updatedAt);
        
    } catch (e) {
        console.error('약관 콘텐츠 로드 실패:', e);
        // 기본값으로 렌더링
        renderTermsContent('terms', termsData.terms, null);
        renderTermsContent('privacy', termsData.privacy, null);
    }
}

// 약관 내용 렌더링 (읽기 모드)
function renderTermsContent(type, content, updatedAt) {
    const display = document.getElementById(`${type}ContentDisplay`);
    const editor = document.getElementById(`${type}ContentEditor`);
    const textarea = document.getElementById(`${type}ContentTextarea`);
    const updatedAtEl = document.getElementById(`${type}UpdatedAt`);
    
    if (!display || !editor || !textarea) return;
    
    // 읽기 모드로 전환
    display.classList.remove('hidden');
    editor.classList.add('hidden');
    
    // 내용 표시
    display.textContent = content || '';
    
    // textarea에 현재 값 저장 (편집 모드 전환 시 사용)
    textarea.value = content || '';
    
    // 저장 일자 표시
    if (updatedAtEl) {
        if (updatedAt) {
            try {
                const date = new Date(updatedAt);
                updatedAtEl.textContent = `최종 저장: ${date.toLocaleString('ko-KR', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                })}`;
            } catch (e) {
                updatedAtEl.textContent = '';
            }
        } else {
            updatedAtEl.textContent = '';
        }
    }
    
    // 편집 버튼 상태 초기화
    const editBtn = document.getElementById(`${type}EditBtn`);
    if (editBtn) {
        editBtn.innerHTML = '<i class="fa-solid fa-pencil mr-1"></i>수정';
        editBtn.onclick = () => window.editTerms(type);
        editBtn.className = 'px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 transition-colors';
    }
}

// 약관 편집 모드 전환
window.editTerms = function(type) {
    const display = document.getElementById(`${type}ContentDisplay`);
    const editor = document.getElementById(`${type}ContentEditor`);
    const textarea = document.getElementById(`${type}ContentTextarea`);
    const editBtn = document.getElementById(`${type}EditBtn`);
    
    if (!display || !editor || !textarea || !editBtn) return;
    
    // 편집 모드로 전환
    display.classList.add('hidden');
    editor.classList.remove('hidden');
    textarea.focus();
    
    // 버튼 텍스트 변경
    editBtn.innerHTML = '<i class="fa-solid fa-times mr-1"></i>취소';
    editBtn.onclick = () => window.cancelEditTerms(type);
    editBtn.className = 'px-3 py-1.5 bg-slate-600 text-white rounded-lg text-sm font-bold hover:bg-slate-700 transition-colors';
};

// 약관 편집 취소
window.cancelEditTerms = function(type) {
    const display = document.getElementById(`${type}ContentDisplay`);
    const editor = document.getElementById(`${type}ContentEditor`);
    const textarea = document.getElementById(`${type}ContentTextarea`);
    const editBtn = document.getElementById(`${type}EditBtn`);
    
    if (!display || !editor || !textarea || !editBtn) return;
    
    // 읽기 모드로 전환
    display.classList.remove('hidden');
    editor.classList.add('hidden');
    
    // textarea 값을 원래 값(display의 내용)으로 복원
    textarea.value = display.textContent;
    
    // 버튼 텍스트 변경
    editBtn.innerHTML = '<i class="fa-solid fa-pencil mr-1"></i>수정';
    editBtn.onclick = () => window.editTerms(type);
    editBtn.className = 'px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 transition-colors';
};

// 약관 탭 전환
window.switchTermsTab = function(tab) {
    const historyTab = document.getElementById('termsTabHistory');
    const manageTab = document.getElementById('termsTabManage');
    const historySection = document.getElementById('termsHistorySection');
    const manageSection = document.getElementById('termsManageSection');
    
    if (tab === 'history') {
        if (historyTab) {
            historyTab.className = 'px-4 py-2 text-sm font-bold text-emerald-600 border-b-2 border-emerald-600 transition-colors';
        }
        if (manageTab) {
            manageTab.className = 'px-4 py-2 text-sm font-bold text-slate-500 hover:text-slate-700 border-b-2 border-transparent hover:border-slate-300 transition-colors';
        }
        if (historySection) historySection.classList.remove('hidden');
        if (manageSection) manageSection.classList.add('hidden');
        loadTermsHistory();
    } else {
        if (historyTab) {
            historyTab.className = 'px-4 py-2 text-sm font-bold text-slate-500 hover:text-slate-700 border-b-2 border-transparent hover:border-slate-300 transition-colors';
        }
        if (manageTab) {
            manageTab.className = 'px-4 py-2 text-sm font-bold text-emerald-600 border-b-2 border-emerald-600 transition-colors';
        }
        if (historySection) historySection.classList.add('hidden');
        if (manageSection) manageSection.classList.remove('hidden');
    }
};

// 약관 이력 로드
async function loadTermsHistory() {
    const historyList = document.getElementById('termsHistoryList');
    if (!historyList) return;
    
    try {
        historyList.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i><p class="text-sm">약관 이력 로딩 중...</p></div>';
        
        // 배포된 약관 버전 목록 가져오기 (terms 문서의 하위 컬렉션으로 저장)
        const versionsColl = collection(db, 'artifacts', appId, 'content', 'terms', 'versions');
        const versionsQuery = query(versionsColl, orderBy('deployedAt', 'desc'));
        const versionsSnapshot = await getDocs(versionsQuery);
        
        const versions = [];
        versionsSnapshot.forEach(doc => {
            const data = doc.data();
            versions.push({
                id: doc.id,
                version: data.version || doc.id,
                deployedAt: data.deployedAt,
                deployedBy: data.deployedBy || '관리자',
                terms: data.terms || [],
                privacy: data.privacy || []
            });
        });
        
        if (versions.length === 0) {
            historyList.innerHTML = '<div class="text-center py-8 text-slate-400"><p class="text-sm">배포된 약관 버전이 없습니다.</p></div>';
            return;
        }
        
        // 현재 약관 버전 가져오기
        const currentVersion = await getCurrentTermsVersion();
        
        // 약관 버전 리스트 렌더링
        historyList.innerHTML = versions.map(v => {
            const date = v.deployedAt ? new Date(v.deployedAt).toLocaleString('ko-KR') : '날짜 없음';
            // 버전 비교 시 숫자로 변환하여 비교 (1.0과 1은 같음)
            const vVersion = String(v.version).trim();
            const cVersion = String(currentVersion).trim();
            const vNum = parseFloat(vVersion);
            const cNum = parseFloat(cVersion);
            const isCurrent = !isNaN(vNum) && !isNaN(cNum) && vNum === cNum;
            
            return `
                <div class="bg-white rounded-xl p-4 border border-slate-200 hover:border-emerald-300 transition-colors">
                    <div class="flex items-center justify-between">
                        <div class="flex-1">
                            <div class="flex items-center gap-2 mb-1">
                                <span class="text-sm font-bold text-slate-800">버전 ${v.version}</span>
                                ${isCurrent ? '<span class="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded text-xs font-bold">현재 적용 중</span>' : ''}
                            </div>
                            <p class="text-xs text-slate-500">배포일: ${date}</p>
                            <p class="text-xs text-slate-500">배포자: ${v.deployedBy}</p>
                        </div>
                        <div class="flex items-center gap-2">
                            <button onclick="window.showTermsVersion('${v.id}')" class="px-4 py-2 bg-slate-100 text-slate-700 rounded-lg text-sm font-bold hover:bg-slate-200 transition-colors">
                                확인
                            </button>
                            ${!isCurrent ? `<button onclick="window.deleteTermsVersion('${v.id}')" class="px-4 py-2 bg-red-100 text-red-700 rounded-lg text-sm font-bold hover:bg-red-200 transition-colors">
                                <i class="fa-solid fa-trash mr-1"></i>삭제
                            </button>` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        
    } catch (e) {
        console.error('약관 이력 로드 실패:', e);
        historyList.innerHTML = '<div class="text-center py-8 text-red-400"><p class="text-sm">약관 이력 로드 중 오류가 발생했습니다.</p></div>';
    }
}

// 약관 버전 보기
window.showTermsVersion = async function(versionId) {
    try {
        const versionDoc = doc(db, 'artifacts', appId, 'content', 'terms', 'versions', versionId);
        const versionSnap = await getDoc(versionDoc);
        
        if (!versionSnap.exists()) {
            alert('약관 버전을 찾을 수 없습니다.');
            return;
        }
        
        const data = versionSnap.data();
        const versionContent = document.getElementById('termsVersionContent');
        const versionModal = document.getElementById('termsVersionModal');
        
        if (!versionContent || !versionModal) return;
        
        const date = data.deployedAt ? new Date(data.deployedAt).toLocaleString('ko-KR') : '날짜 없음';
        const currentVersion = await getCurrentTermsVersion();
        // 버전 비교 시 숫자로 변환하여 비교 (1.0과 1은 같음)
        const vNum = parseFloat(String(data.version).trim());
        const cNum = parseFloat(String(currentVersion).trim());
        const isCurrent = !isNaN(vNum) && !isNaN(cNum) && vNum === cNum;
        
        versionContent.innerHTML = `
            <div class="mb-4 pb-4 border-b border-slate-200">
                <div class="flex items-center justify-between">
                    <h4 class="text-base font-bold text-slate-800">버전 ${data.version}</h4>
                    ${isCurrent ? '<span class="px-2 py-1 bg-emerald-100 text-emerald-700 rounded text-xs font-bold">현재 적용 중</span>' : ''}
                </div>
                <p class="text-xs text-slate-500 mt-1">배포일: ${date}</p>
                <p class="text-xs text-slate-500">배포자: ${data.deployedBy || '관리자'}</p>
            </div>
            
            <!-- 이용약관 -->
            <div class="bg-slate-50 rounded-xl p-4 border border-slate-200">
                <h5 class="text-sm font-bold text-slate-800 mb-3 flex items-center gap-2">
                    <i class="fa-solid fa-file-contract text-emerald-600"></i>
                    이용약관
                </h5>
                <div class="bg-white rounded-lg p-3 border border-slate-200 text-xs text-slate-600 leading-relaxed whitespace-pre-line">
                    ${escapeHtml(Array.isArray(data.terms) ? data.terms.map(item => {
                        const title = item.title || '';
                        const content = item.content || '';
                        return title ? `${title}\n${content}` : content;
                    }).join('\n\n') : (data.terms || ''))}
                </div>
            </div>
            
            <!-- 개인정보 처리방침 -->
            <div class="bg-slate-50 rounded-xl p-4 border border-slate-200">
                <h5 class="text-sm font-bold text-slate-800 mb-3 flex items-center gap-2">
                    <i class="fa-solid fa-shield-halved text-blue-600"></i>
                    개인정보 처리방침
                </h5>
                <div class="bg-white rounded-lg p-3 border border-slate-200 text-xs text-slate-600 leading-relaxed whitespace-pre-line">
                    ${escapeHtml(Array.isArray(data.privacy) ? data.privacy.map(item => {
                        const title = item.title || '';
                        const content = item.content || '';
                        return title ? `${title}\n${content}` : content;
                    }).join('\n\n') : (data.privacy || ''))}
                </div>
            </div>
        `;
        
        versionModal.classList.remove('hidden');
    } catch (e) {
        console.error('약관 버전 보기 실패:', e);
        alert('약관 버전을 불러오는 중 오류가 발생했습니다: ' + e.message);
    }
};

// 약관 버전 모달 닫기
window.closeTermsVersionModal = function() {
    const modal = document.getElementById('termsVersionModal');
    if (modal) {
        modal.classList.add('hidden');
    }
};

// 약관 버전 삭제
window.deleteTermsVersion = async function(versionId) {
    if (!confirm('이 약관 버전을 삭제하시겠습니까?\n\n삭제된 버전은 복구할 수 없습니다.')) {
        return;
    }
    
    try {
        const versionDoc = doc(db, 'artifacts', appId, 'content', 'terms', 'versions', versionId);
        await deleteDoc(versionDoc);
        
        alert('약관 버전이 삭제되었습니다.');
        
        // 약관이력 새로고침
        await loadTermsHistory();
    } catch (e) {
        console.error('약관 버전 삭제 실패:', e);
        alert('약관 버전 삭제 중 오류가 발생했습니다: ' + e.message);
    }
};
window.deployTerms = async function() {
    if (!confirm('약관을 배포하시겠습니까?\n\n배포하면 모든 사용자에게 재동의를 요청하게 됩니다.')) {
        return;
    }
    
    try {
        // 현재 표시된 약관 내용 가져오기
        const termsDisplay = document.getElementById('termsContentDisplay');
        const privacyDisplay = document.getElementById('privacyContentDisplay');
        const termsTextarea = document.getElementById('termsContentTextarea');
        const privacyTextarea = document.getElementById('privacyContentTextarea');
        const termsEditor = document.getElementById('termsContentEditor');
        const privacyEditor = document.getElementById('privacyContentEditor');
        
        let termsContent = '';
        let privacyContent = '';
        
        // 편집 모드인지 확인하고, 편집 모드의 내용을 가져오기
        if (termsEditor && !termsEditor.classList.contains('hidden')) {
            // 편집 모드이므로 textarea의 값을 가져옴
            termsContent = termsTextarea ? termsTextarea.value : '';
        } else {
            // 읽기 모드이므로 display의 내용을 가져옴
            termsContent = termsDisplay ? termsDisplay.textContent : '';
        }
        
        if (privacyEditor && !privacyEditor.classList.contains('hidden')) {
            // 편집 모드이므로 textarea의 값을 가져옴
            privacyContent = privacyTextarea ? privacyTextarea.value : '';
        } else {
            // 읽기 모드이므로 display의 내용을 가져옴
            privacyContent = privacyDisplay ? privacyDisplay.textContent : '';
        }
        
        if (!termsContent || !privacyContent) {
            alert('약관 내용을 입력해주세요.');
            return;
        }
        
        // 현재 약관 버전 가져오기 (Firestore 우선, 없으면 constants.js 기본값)
        const currentVersion = await getCurrentTermsVersion();
        const baseVersion = parseFloat(currentVersion);
        const newVersion = (baseVersion + 0.1).toFixed(1); // 버전 0.1씩 증가
        
        // 약관 버전 데이터 저장 (배열 형식으로 변환하여 저장 - 기존 호환성 유지)
        const versionData = {
            version: newVersion,
            terms: [{ title: '이용약관', content: termsContent }],
            privacy: [{ title: '개인정보 처리방침', content: privacyContent }],
            deployedAt: new Date().toISOString(),
            deployedBy: adminAuth.currentUser?.email || '관리자'
        };
        
        // 약관 버전 컬렉션에 저장 (terms 문서의 하위 컬렉션으로 저장)
        const versionsColl = collection(db, 'artifacts', appId, 'content', 'terms', 'versions');
        await addDoc(versionsColl, versionData);
        
        // 현재 약관도 업데이트 (단일 텍스트 형식으로 저장)
        const termsDoc = doc(db, 'artifacts', appId, 'content', 'terms');
        await setDoc(termsDoc, {
            terms: termsContent,
            privacy: privacyContent,
            updatedAt: new Date().toISOString(),
            currentVersion: newVersion  // Firestore에 현재 버전 저장
        }, { merge: true });
        
        // 약관 버전 캐시 무효화
        invalidateTermsVersionCache();
        
        alert(`약관 버전 ${newVersion}이 배포되었습니다.\n\n버전이 자동으로 업데이트되었습니다.`);
        console.log(`✅ 약관 버전 ${newVersion} 배포 완료. Firestore에 currentVersion 저장됨.`);
        
        // 약관이력 탭이면 새로고침
        const historySection = document.getElementById('termsHistorySection');
        if (historySection && !historySection.classList.contains('hidden')) {
            loadTermsHistory();
        }
        
        // 약관 관리 탭이면 내용 새로고침
        const manageSection = document.getElementById('termsManageSection');
        if (manageSection && !manageSection.classList.contains('hidden')) {
            await loadTermsContent();
        }
        
    } catch (e) {
        console.error('약관 배포 실패:', e);
        alert('약관 배포 중 오류가 발생했습니다: ' + e.message);
    }
};

// 약관 저장
window.saveTerms = async function() {
    try {
        const termsTextarea = document.getElementById('termsContentTextarea');
        const privacyTextarea = document.getElementById('privacyContentTextarea');
        const termsDisplay = document.getElementById('termsContentDisplay');
        const termsEditor = document.getElementById('termsContentEditor');
        const privacyDisplay = document.getElementById('privacyContentDisplay');
        const privacyEditor = document.getElementById('privacyContentEditor');
        
        if (!termsTextarea || !privacyTextarea) {
            alert('약관 데이터를 찾을 수 없습니다.');
            return;
        }
        
        // 편집 모드인지 확인하고, 편집 모드의 내용을 가져오기
        let termsContent = '';
        let privacyContent = '';
        
        if (termsEditor && !termsEditor.classList.contains('hidden')) {
            // 편집 모드이므로 textarea의 값을 가져옴
            termsContent = termsTextarea.value || '';
        } else {
            // 읽기 모드이므로 display의 내용을 가져옴
            termsContent = termsDisplay ? termsDisplay.textContent : '';
        }
        
        if (privacyEditor && !privacyEditor.classList.contains('hidden')) {
            // 편집 모드이므로 textarea의 값을 가져옴
            privacyContent = privacyTextarea.value || '';
        } else {
            // 읽기 모드이므로 display의 내용을 가져옴
            privacyContent = privacyDisplay ? privacyDisplay.textContent : '';
        }
        
        const termsData = {
            terms: termsContent,
            privacy: privacyContent,
            updatedAt: new Date().toISOString()
        };
        
        const termsDoc = doc(db, 'artifacts', appId, 'content', 'terms');
        await setDoc(termsDoc, termsData, { merge: true });
        
        alert('약관이 저장되었습니다.');
        console.log('약관 저장 완료:', termsData);
        
        // 저장 후 다시 로드하여 최종 저장 일자 업데이트 및 편집 모드 해제
        await loadTermsContent();
        
    } catch (e) {
        console.error('약관 저장 실패:', e);
        alert('약관 저장 중 오류가 발생했습니다: ' + e.message);
    }
};

// 태그 콘텐츠 로드
async function loadTagsContent() {
    try {
        // Firestore에서 태그 데이터 가져오기
        const tagsDoc = doc(db, 'artifacts', appId, 'content', 'defaultTags');
        const tagsSnap = await getDoc(tagsDoc);
        
        // 기본값 (constants.js의 DEFAULT_USER_SETTINGS에서 가져옴)
        let tagsData = {
            mealType: ['집밥', '외식', '회식/술자리', '배달/포장', '구내식당', '기타', '건너뜀'],
            withWhom: ['혼자', '가족', '연인', '친구', '직장동료', '학교친구', '모임', '기타'],
            category: ['한식', '양식', '일식', '중식', '분식', '카페'],
            snackType: ['커피', '차/음료', '술/주류', '베이커리', '과자/스낵', '아이스크림', '과일/견과', '기타'],
            subTagsPlaceSnack: ['집', '사무실', '카페']
        };
        
        if (tagsSnap.exists()) {
            const data = tagsSnap.data();
            if (data.mealType) tagsData.mealType = data.mealType;
            if (data.withWhom) tagsData.withWhom = data.withWhom;
            if (data.category) tagsData.category = data.category;
            if (data.snackType) tagsData.snackType = data.snackType;
            if (data.subTagsPlaceSnack && Array.isArray(data.subTagsPlaceSnack)) tagsData.subTagsPlaceSnack = data.subTagsPlaceSnack;
        }
        
        // 태그 렌더링
        renderTags('mealType', tagsData.mealType);
        renderTags('withWhom', tagsData.withWhom);
        renderTags('category', tagsData.category);
        renderTags('snackType', tagsData.snackType);
        renderTags('subTagsPlaceSnack', tagsData.subTagsPlaceSnack);
        
    } catch (e) {
        console.error('태그 콘텐츠 로드 실패:', e);
        // 기본값으로 렌더링
        const defaultTags = {
            mealType: ['집밥', '외식', '회식/술자리', '배달/포장', '구내식당', '기타', '건너뜀'],
            withWhom: ['혼자', '가족', '연인', '친구', '직장동료', '학교친구', '모임', '기타'],
            category: ['한식', '양식', '일식', '중식', '분식', '카페'],
            snackType: ['커피', '차/음료', '술/주류', '베이커리', '과자/스낵', '아이스크림', '과일/견과', '기타'],
            subTagsPlaceSnack: ['집', '사무실', '카페']
        };
        renderTags('mealType', defaultTags.mealType);
        renderTags('withWhom', defaultTags.withWhom);
        renderTags('category', defaultTags.category);
        renderTags('snackType', defaultTags.snackType);
        renderTags('subTagsPlaceSnack', defaultTags.subTagsPlaceSnack);
    }
}

// 태그 렌더링
function renderTags(type, tags) {
    const container = document.getElementById(`tags-${type}`);
    if (!container) return;
    
    // 컨테이너에 반응형 그리드 레이아웃 클래스 추가
    container.className = 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2';
    
    container.innerHTML = tags.map((tag, index) => `
        <div class="tag-item flex items-center gap-2 bg-white rounded-lg p-3 border border-slate-200 min-w-0 cursor-move hover:border-emerald-300 transition-colors" 
             draggable="true" 
             data-tag-index="${index}"
             data-tag-type="${type}">
            <div class="flex items-center justify-center w-6 h-6 text-slate-400 flex-shrink-0">
                <i class="fa-solid fa-grip-vertical text-xs"></i>
            </div>
            <input type="text" value="${escapeHtml(tag || '')}" 
                   onchange="window.updateTagItem('${type}', this)"
                   class="flex-1 min-w-0 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-bold text-slate-800 outline-none focus:border-emerald-500"
                   placeholder="태그 이름">
            <button onclick="window.removeTagItem('${type}', this.closest('.tag-item'))" class="px-3 py-2 bg-red-100 text-red-700 rounded-lg text-sm font-bold hover:bg-red-200 transition-colors flex-shrink-0">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    `).join('');
    
    // 드래그 앤 드롭 이벤트 설정
    setupTagDragAndDrop(type, container);
}

// 태그 드래그 앤 드롭 설정
function setupTagDragAndDrop(type, container) {
    let draggedElement = null;
    let draggedIndex = null;
    let dropIndex = null;
    
    container.querySelectorAll('.tag-item').forEach((item, index) => {
        // 드래그 시작
        item.addEventListener('dragstart', (e) => {
            draggedElement = item;
            draggedIndex = index;
            item.classList.add('opacity-50');
            e.dataTransfer.effectAllowed = 'move';
        });
        
        // 드래그 종료
        item.addEventListener('dragend', (e) => {
            item.classList.remove('opacity-50');
            
            // 순서 변경 적용
            if (draggedIndex !== null && dropIndex !== null && draggedIndex !== dropIndex) {
                const tags = getCurrentTags(type);
                const [removed] = tags.splice(draggedIndex, 1);
                tags.splice(dropIndex, 0, removed);
                renderTags(type, tags);
            }
            
            // 초기화
            draggedElement = null;
            draggedIndex = null;
            dropIndex = null;
            
            // 모든 항목의 드래그 오버 스타일 제거
            container.querySelectorAll('.tag-item').forEach(el => {
                el.classList.remove('border-emerald-500', 'bg-emerald-50');
            });
        });
        
        // 드래그 오버 (호버 효과)
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            
            const allItems = Array.from(container.querySelectorAll('.tag-item'));
            const currentIndex = allItems.indexOf(item);
            
            if (draggedIndex !== null && currentIndex !== draggedIndex) {
                dropIndex = currentIndex;
                
                // 드래그 오버 스타일 적용
                allItems.forEach(el => {
                    el.classList.remove('border-emerald-500', 'bg-emerald-50');
                });
                item.classList.add('border-emerald-500', 'bg-emerald-50');
            }
        });
        
        // 드래그 리브 (호버 효과 제거)
        item.addEventListener('dragleave', (e) => {
            if (!item.contains(e.relatedTarget)) {
                item.classList.remove('border-emerald-500', 'bg-emerald-50');
            }
        });
        
        // 드롭
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
    });
}

// 태그 항목 추가
window.addTagItem = function(type) {
    const container = document.getElementById(`tags-${type}`);
    if (!container) return;
    
    const tags = getCurrentTags(type);
    tags.push('');
    
    renderTags(type, tags);
};

// 태그 항목 제거
window.removeTagItem = function(type, itemElement) {
    const tags = getCurrentTags(type);
    if (tags.length <= 1) {
        alert('최소 한 개의 태그가 필요합니다.');
        return;
    }
    
    const container = document.getElementById(`tags-${type}`);
    const allItems = Array.from(container.querySelectorAll('.tag-item'));
    const index = allItems.indexOf(itemElement);
    
    if (index > -1) {
        tags.splice(index, 1);
        renderTags(type, tags);
    }
};

// 태그 항목 업데이트
window.updateTagItem = function(type, inputElement) {
    // DOM 순서에 따라 태그가 자동으로 업데이트되므로 별도 처리 불필요
    // 실제 저장 시 getCurrentTags로 최신 순서를 가져옴
};

// 현재 태그 목록 가져오기 (DOM 순서대로)
function getCurrentTags(type) {
    const container = document.getElementById(`tags-${type}`);
    if (!container) return [];
    
    const tags = [];
    container.querySelectorAll('.tag-item').forEach(itemEl => {
        const input = itemEl.querySelector('input[type="text"]');
        if (input) {
            const value = input.value.trim();
            if (value.length > 0) {
                tags.push(value);
            }
        }
    });
    
    return tags;
}

// 태그 저장
window.saveTags = async function() {
    try {
        const mealType = getCurrentTags('mealType');
        const withWhom = getCurrentTags('withWhom');
        const category = getCurrentTags('category');
        const snackType = getCurrentTags('snackType');
        const subTagsPlaceSnack = getCurrentTags('subTagsPlaceSnack');
        
        // 빈 태그가 있는지 확인
        if (mealType.length === 0 || withWhom.length === 0 || category.length === 0 || snackType.length === 0) {
            alert('각 카테고리마다 최소 한 개의 태그가 필요합니다.');
            return;
        }
        if (subTagsPlaceSnack.length === 0) {
            alert('간식 장소는 최소 한 개의 태그가 필요합니다.');
            return;
        }
        
        const tagsData = {
            mealType: mealType,
            withWhom: withWhom,
            category: category,
            snackType: snackType,
            subTagsPlaceSnack: subTagsPlaceSnack,
            updatedAt: new Date().toISOString()
        };
        
        const tagsDoc = doc(db, 'artifacts', appId, 'content', 'defaultTags');
        await setDoc(tagsDoc, tagsData, { merge: true });
        
        alert('태그가 저장되었습니다.');
        console.log('태그 저장 완료:', tagsData);
    } catch (e) {
        console.error('태그 저장 실패:', e);
        alert('태그 저장 중 오류가 발생했습니다: ' + e.message);
    }
};

// HTML 이스케이프 헬퍼 함수
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 페이지별 커서 저장 (이전/다음 페이지 이동용)
let adminUsersLastDocsByPage = {};
let adminUsersTotalCount = 0;

// 사용자 목록 가져오기 — 페이지 단위만 DB 조회 (limit + startAfter)
async function getUsers(options = {}) {
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? USERS_PER_PAGE;
    const startAfterDoc = page === 1 ? null : (adminUsersLastDocsByPage[page - 1] ?? null);

    try {
        const usersColl = collection(db, 'artifacts', appId, 'users');
        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
        const userBansColl = collection(db, 'artifacts', appId, 'userBans');
        const boardPostsColl = collection(db, 'artifacts', appId, 'boardPosts');
        const deleteRequestsColl = collection(db, 'artifacts', appId, 'deleteUserRequests');

        // 1) 첫 페이지만 전체 사용자 수 조회 (1 read)
        let totalCount = adminUsersTotalCount;
        if (page === 1) {
            const countSnap = await getCountFromServer(usersColl);
            totalCount = countSnap.data().count;
            adminUsersTotalCount = totalCount;
        }

        // 2) users 컬렉션 페이지 단위 쿼리 (가입일 내림차순)
        let usersQuery = query(usersColl, orderBy('createdAt', 'desc'), limit(pageSize));
        if (startAfterDoc) usersQuery = query(usersColl, orderBy('createdAt', 'desc'), limit(pageSize), startAfter(startAfterDoc));
        const usersSnapshot = await getDocs(usersQuery);
        const userIds = usersSnapshot.docs.map(d => d.id);
        const lastDoc = usersSnapshot.docs.length > 0 ? usersSnapshot.docs[usersSnapshot.docs.length - 1] : null;
        if (lastDoc) adminUsersLastDocsByPage[page] = lastDoc;

        if (userIds.length === 0) {
            return { users: [], totalCount, lastDoc: null, hasMore: false };
        }

        // 3) 이 페이지 사용자들에 대해서만 userBans, deleteRequests, sharedPhotos(whereIn), boardPosts(whereIn) 조회
        const [userBansSnapshot, deleteRequestsSnapshot, sharedChunk1, sharedChunk2, boardChunk1, boardChunk2] = await Promise.all([
            Promise.all(userIds.map(id => getDoc(doc(userBansColl, id)))),
            getDocs(deleteRequestsColl),
            userIds.length > 0 ? getDocs(query(sharedColl, where('userId', 'in', userIds.slice(0, 30)))) : Promise.resolve({ docs: [] }),
            userIds.length > 30 ? getDocs(query(sharedColl, where('userId', 'in', userIds.slice(30, 50)))) : Promise.resolve({ docs: [] }),
            userIds.length > 0 ? getDocs(query(boardPostsColl, where('authorId', 'in', userIds.slice(0, 30)))) : Promise.resolve({ docs: [] }),
            userIds.length > 30 ? getDocs(query(boardPostsColl, where('authorId', 'in', userIds.slice(30, 50)))) : Promise.resolve({ docs: [] })
        ]);

        const userBansMap = new Map();
        userBansSnapshot.forEach((snap, i) => {
            if (snap.exists() && userIds[i]) {
                const data = snap.data();
                userBansMap.set(userIds[i], { bannedShare: data.bannedShare === true, bannedWrite: data.bannedWrite === true });
            }
        });
        const deleteRequestedUserIds = new Set();
        deleteRequestsSnapshot.docs.forEach(d => { const uid = d.data().userId; if (uid && userIds.includes(uid)) deleteRequestedUserIds.add(uid); });
        const albumShareCountMap = new Map();
        [...(sharedChunk1.docs || []), ...(sharedChunk2.docs || [])].forEach(d => {
            const uid = d.data().userId;
            if (uid) albumShareCountMap.set(uid, (albumShareCountMap.get(uid) || 0) + 1);
        });
        const talkCountMap = new Map();
        [...(boardChunk1.docs || []), ...(boardChunk2.docs || [])].forEach(d => {
            const aid = d.data().authorId;
            if (aid) talkCountMap.set(aid, (talkCountMap.get(aid) || 0) + 1);
        });
        const sharedUserMap = new Map();
        [...(sharedChunk1.docs || []), ...(sharedChunk2.docs || [])].forEach(d => {
            const data = d.data();
            if (data.userId && !sharedUserMap.has(data.userId))
                sharedUserMap.set(data.userId, { nickname: data.userNickname || null, icon: data.userIcon || null });
        });

        // 4) 이 페이지 사용자만 settings, meals 개수 병렬 조회
        const [settingsDocs, mealCountSettled] = await Promise.all([
            Promise.all(userIds.map(id => getDoc(doc(db, 'artifacts', appId, 'users', id, 'config', 'settings')))),
            Promise.allSettled(userIds.map(id => getCountFromServer(collection(db, 'artifacts', appId, 'users', id, 'meals'))))
        ]);
        const mealCounts = mealCountSettled.map(s => s.status === 'fulfilled' ? s.value : null);

        const users = [];
        for (let i = 0; i < userIds.length; i++) {
            const userId = userIds[i];
            const userDocData = usersSnapshot.docs[i].data();
            let nickname = '익명';
            let icon = '🐻';
            let birthdate = '';
            let lifestyle = '';
            let gender = null;
            let email = userDocData.email || null;
            let termsAgreed = false;
            let termsAgreedAt = null;
            let termsVersion = null;
            let providerId = userDocData.providerId || null;
            let createdAt = null;
            let lastLoginAt = null;
            if (userDocData.createdAt) createdAt = userDocData.createdAt.toDate ? userDocData.createdAt.toDate() : new Date(userDocData.createdAt);
            if (userDocData.lastLoginAt) lastLoginAt = userDocData.lastLoginAt.toDate ? userDocData.lastLoginAt.toDate() : new Date(userDocData.lastLoginAt);

            if (sharedUserMap.has(userId)) {
                const s = sharedUserMap.get(userId);
                if (s.nickname) nickname = s.nickname;
                if (s.icon) icon = s.icon;
            }

            const settingsSnap = settingsDocs[i];
            if (settingsSnap?.exists()) {
                const settings = settingsSnap.data();
                if (settings.profile) {
                    if (settings.profileCompleted === true) {
                        const pn = settings.profile.nickname;
                        if (pn !== undefined && pn !== null && String(pn).trim() !== '' && pn !== '게스트') nickname = pn;
                        else nickname = '미설정';
                    } else nickname = '미설정';
                    if (settings.profile.icon) icon = settings.profile.icon;
                    if (settings.profile.birthdate) birthdate = String(settings.profile.birthdate).trim();
                    if (settings.profile.lifestyle) lifestyle = String(settings.profile.lifestyle).trim();
                    if (settings.profile.gender === 'male' || settings.profile.gender === 'female') gender = settings.profile.gender;
                } else nickname = '미설정';
                termsAgreed = settings.termsAgreed === true;
                termsAgreedAt = settings.termsAgreedAt || null;
                termsVersion = settings.termsVersion || null;
                if (settings.email) email = settings.email;
                if (settings.providerId) providerId = settings.providerId;
            }

            let loginMethod = '게스트';
            if (providerId === 'google.com') loginMethod = '구글';
            else if (email) loginMethod = '이메일';

            const ban = userBansMap.get(userId);
            const bannedShare = ban?.bannedShare ?? false;
            const bannedWrite = ban?.bannedWrite ?? false;
            const deleteRequested = deleteRequestedUserIds.has(userId);
            const timelineCount = (mealCounts[i] && typeof mealCounts[i].data === 'function') ? mealCounts[i].data().count : 0;
            const albumShareCount = albumShareCountMap.get(userId) ?? 0;
            const talkCount = talkCountMap.get(userId) ?? 0;

            users.push({
                userId,
                nickname,
                icon,
                birthdate,
                lifestyle,
                gender,
                email,
                loginMethod,
                termsAgreed,
                termsAgreedAt,
                termsVersion,
                timelineCount,
                albumShareCount,
                talkCount,
                createdAt,
                lastLoginAt,
                bannedShare,
                bannedWrite,
                deleteRequested
            });
        }

        return { users, totalCount, lastDoc, hasMore: usersSnapshot.docs.length === pageSize };
    } catch (e) {
        console.error("Get users error:", e);
        throw e;
    }
}

// 사용자 목록 렌더링
async function renderUsers(options = {}) {
    const container = document.getElementById('usersContainer');
    if (!container) {
        console.error('usersContainer를 찾을 수 없습니다.');
        return;
    }
    
        container.innerHTML = '<tr><td colspan="13" class="px-4 py-8 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i><p>로딩 중...</p></td></tr>';
    
    try {
        console.log('renderUsers 시작');
        // 헤더 정렬 핸들러는 한 번만 바인딩
        initUsersSortHandlers();
        
        let users;
        const useCacheOnly = options?.useCacheOnly === true;
        if (usersCache && Array.isArray(usersCache) && useCacheOnly) {
            users = usersCache;
        } else if (useCacheOnly) {
            users = [];
        } else {
            if (!usersCache) adminUsersListPage = 1;
            const result = await getUsers({ page: adminUsersListPage, pageSize: USERS_PER_PAGE });
            users = result.users;
            usersCache = users;
        }
        console.log('getUsers 결과:', users.length, '명 (페이지', adminUsersListPage, '/ 총', adminUsersTotalCount, '명)');
        
        if (users.length === 0) {
            container.innerHTML = '<tr><td colspan="13" class="px-4 py-8 text-center text-slate-400"><i class="fa-solid fa-users text-2xl mb-2"></i><p>사용자가 없습니다.</p></td></tr>';
            updateAdminUsersListPagination(adminUsersTotalCount, Math.max(1, Math.ceil(adminUsersTotalCount / USERS_PER_PAGE)));
            try { applyAdminUsersPageVisibility(adminUsersCurrentPage); } catch (_) {}
            return;
        }
        
        // 최신 약관 버전 가져오기
        const currentVersion = await getCurrentTermsVersion();
        
        // 정렬 적용 (현재 페이지 내에서만)
        const sortedUsers = sortUsersForTable(users, currentVersion);
        updateUsersSortHeaderUI();
        
        const totalListPages = Math.max(1, Math.ceil(adminUsersTotalCount / USERS_PER_PAGE));
        if (adminUsersListPage > totalListPages) adminUsersListPage = totalListPages;
        const usersToShow = sortedUsers;
        
        updateAdminUsersListPagination(adminUsersTotalCount, totalListPages);
        
        const start = (adminUsersListPage - 1) * USERS_PER_PAGE + 1;
        const end = start + usersToShow.length - 1;
        console.log(`${usersToShow.length}명 표시 (${start}-${end} / ${adminUsersTotalCount}명).`);
        container.innerHTML = usersToShow.map(user => {
            // 약관 동의 상태: 앱(auth-flow)과 동일 기준 — termsVersion 없으면 기존 사용자로 간주하여 동의함
            // 앱은 식사 기록이 있는 사용자(기존 사용자)는 약관 버전을 검사하지 않으므로, 여기서도 timelineCount > 0 이면 재동의 필요로 표시하지 않음
            const hasVersion = user.termsVersion != null && String(user.termsVersion).trim() !== '';
            const isExistingUserByMeals = (user.timelineCount ?? 0) > 0;
            const hasAgreedToLatest = user.termsAgreed && (!hasVersion || user.termsVersion === currentVersion || isExistingUserByMeals);
            const hasAgreedToOld = user.termsAgreed && hasVersion && user.termsVersion !== currentVersion && !isExistingUserByMeals;

            let termsAgreedText;
            if (hasAgreedToLatest) {
                termsAgreedText = `<span class="px-2 py-1 bg-emerald-100 text-emerald-700 text-xs font-bold rounded">동의함</span>`;
            } else if (hasAgreedToOld) {
                termsAgreedText = `<span class="px-2 py-1 bg-orange-100 text-orange-700 text-xs font-bold rounded">재동의 필요</span>`;
            } else {
                termsAgreedText = `<span class="px-2 py-1 bg-red-100 text-red-700 text-xs font-bold rounded">미동의</span>`;
            }
            
            const termsAgreedDate = user.termsAgreedAt ? 
                new Date(user.termsAgreedAt).toLocaleDateString('ko-KR') : '-';
            
            const createdDt = user.createdAt ? (user.createdAt instanceof Date ? user.createdAt : new Date(user.createdAt)) : null;
            const lastLoginDt = user.lastLoginAt ? (user.lastLoginAt instanceof Date ? user.lastLoginAt : new Date(user.lastLoginAt)) : null;
            const opts = { timeZone: 'Asia/Seoul' };
            const createdAtDate = createdDt
                ? createdDt.toLocaleDateString('ko-KR', opts) + '<br>' + createdDt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', ...opts })
                : '-';
            const lastLoginDate = lastLoginDt
                ? lastLoginDt.toLocaleDateString('ko-KR', opts) + '<br>' + lastLoginDt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', ...opts })
                : '-';
            
            let loginMethodBadge = 'bg-slate-100 text-slate-700';
            if (user.loginMethod === '구글') {
                loginMethodBadge = 'bg-red-100 text-red-700';
            } else if (user.loginMethod === '이메일') {
                loginMethodBadge = 'bg-blue-100 text-blue-700';
            }
            
            const shareBanBadge = user.bannedShare
                ? '<span class="px-2 py-0.5 bg-amber-100 text-amber-700 text-xs font-bold rounded">금지</span>'
                : '<span class="text-slate-400 text-xs">-</span>';
            const writeBanBadge = user.bannedWrite
                ? '<span class="px-2 py-0.5 bg-amber-100 text-amber-700 text-xs font-bold rounded">금지</span>'
                : '<span class="text-slate-400 text-xs">-</span>';
            const deleteRequestedBadge = user.deleteRequested
                ? '<span class="px-2 py-0.5 bg-slate-200 text-slate-600 text-xs font-bold rounded">삭제 요청됨</span>'
                : '';
            const rowClass = user.deleteRequested
                ? 'bg-slate-100 text-slate-500 hover:bg-slate-200 transition-colors'
                : 'hover:bg-slate-50 transition-colors';
            const userIdAttr = String(user.userId).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\&quot;');
            const emailUserIdCell = `<span class="text-sm text-slate-600 block">${escapeHtml(user.email || '-')}</span>
                        <button onclick="navigator.clipboard.writeText('${userIdAttr}').then(() => alert('사용자 ID가 복사되었습니다.')).catch(() => alert('복사 실패'))" 
                                class="text-xs text-slate-500 hover:text-slate-700 font-mono cursor-pointer hover:underline mt-0.5 block text-left" 
                                title="클릭하여 복사">${escapeHtml(user.userId)}</button>`;
            return `
                <tr class="${rowClass}">
                    <td data-page="1 2" class="px-2 py-3">
                        <label class="flex items-center gap-1.5 cursor-pointer">
                            <input type="checkbox" class="admin-user-checkbox rounded border-slate-300 text-emerald-600 focus:ring-emerald-500" data-user-id="${escapeHtml(user.userId)}" title="선택" ${user.deleteRequested ? 'disabled' : ''}>
                        </label>
                    </td>
                    <td data-page="1 2" class="px-4 py-3 align-top">${emailUserIdCell}</td>
                    <td data-page="1 2" class="px-4 py-3">
                        <div class="flex flex-col gap-0.5">
                            <div class="flex items-center gap-2 whitespace-nowrap">
                                <span class="text-xl">${user.icon || '🐻'}</span>
                                <span class="font-bold text-slate-800">${user.nickname || '익명'}</span>
                            </div>
                            ${deleteRequestedBadge ? `<div class="mt-0.5">${deleteRequestedBadge}</div>` : ''}
                        </div>
                    </td>
                    <td data-page="1 2" class="px-2 py-3 text-center">
                        <span class="text-sm text-slate-600">${user.gender === 'male' ? '남' : user.gender === 'female' ? '여' : '-'}</span>
                    </td>
                    <td data-page="1" class="px-4 py-3">
                        <span class="px-2 py-1 ${loginMethodBadge} text-xs font-bold rounded">${user.loginMethod || '게스트'}</span>
                    </td>
                    <td data-page="1" class="px-2 py-3">${writeBanBadge}</td>
                    <td data-page="1" class="px-2 py-3">${shareBanBadge}</td>
                    <td data-page="1" class="px-4 py-3">
                        <div class="flex flex-col gap-1">
                            ${termsAgreedText}
                            ${user.termsAgreedAt ? `<span class="text-xs text-slate-500">${termsAgreedDate}</span>` : ''}
                        </div>
                    </td>
                    <td data-page="1" class="px-4 py-3">
                        <span class="text-sm text-slate-600">${user.loginMethod === '게스트' ? '-' : createdAtDate}</span>
                    </td>
                    <td data-page="1" class="px-4 py-3">
                        <span class="text-sm text-slate-600">${lastLoginDate}</span>
                    </td>
                    <td data-page="2" class="px-4 py-3">
                        <span class="font-bold text-slate-800">${user.timelineCount || 0}</span>
                    </td>
                    <td data-page="2" class="px-4 py-3">
                        <span class="font-bold text-slate-800">${user.albumShareCount || 0}</span>
                    </td>
                    <td data-page="2" class="px-4 py-3">
                        <span class="font-bold text-slate-800">${user.talkCount || 0}</span>
                    </td>
                </tr>
            `;
        }).join('');
        initAdminUsersSelectAll();
        applyAdminUsersPageVisibility(typeof adminUsersCurrentPage !== 'undefined' ? adminUsersCurrentPage : 1);
    } catch (e) {
        console.error("사용자 목록 렌더링 실패:", e);
        const errMsg = (e && (e.message || e.code || String(e))) || '알 수 없는 오류';
        container.innerHTML = '<tr><td colspan="13" class="px-4 py-8 text-center text-red-400"><i class="fa-solid fa-exclamation-triangle text-2xl mb-2"></i><p>사용자 목록을 불러오는 중 오류가 발생했습니다.</p><p class="text-xs mt-2 text-slate-500">' + escapeHtml(errMsg) + '</p></td></tr>';
    }
}

let adminUsersCurrentPage = 1;
let adminUsersListPage = 1;

const USERS_PER_PAGE = 50;

function updateAdminUsersListPagination(totalCount, totalPages) {
    const infoEl = document.getElementById('adminUsersListPaginationInfo');
    const navEl = document.getElementById('adminUsersListPagination');
    if (!infoEl || !navEl) return;
    const start = totalCount === 0 ? 0 : (adminUsersListPage - 1) * USERS_PER_PAGE + 1;
    const end = Math.min(adminUsersListPage * USERS_PER_PAGE, totalCount);
    infoEl.textContent = totalCount === 0 ? '0명' : `${start}-${end} / ${totalCount}명`;
    navEl.innerHTML = '';
    if (totalPages <= 1) return;
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'px-2 py-1 rounded text-xs font-bold bg-slate-100 text-slate-600 hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed';
    prevBtn.textContent = '이전';
    prevBtn.disabled = adminUsersListPage <= 1;
    prevBtn.onclick = () => { adminUsersListPage = Math.max(1, adminUsersListPage - 1); renderUsers(); };
    navEl.appendChild(prevBtn);
    const maxButtons = 7;
    let from = Math.max(1, adminUsersListPage - Math.floor(maxButtons / 2));
    let to = Math.min(totalPages, from + maxButtons - 1);
    if (to - from + 1 < maxButtons) from = Math.max(1, to - maxButtons + 1);
    for (let p = from; p <= to; p++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'admin-users-list-page-btn min-w-[1.75rem] px-2 py-1 rounded text-xs font-bold transition-colors ' + (p === adminUsersListPage ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600 hover:bg-slate-200');
        btn.textContent = String(p);
        btn.onclick = () => { adminUsersListPage = p; renderUsers(); };
        navEl.appendChild(btn);
    }
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'px-2 py-1 rounded text-xs font-bold bg-slate-100 text-slate-600 hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed';
    nextBtn.textContent = '다음';
    nextBtn.disabled = adminUsersListPage >= totalPages;
    nextBtn.onclick = () => { adminUsersListPage = Math.min(totalPages, adminUsersListPage + 1); renderUsers(); };
    navEl.appendChild(nextBtn);
}

function applyAdminUsersPageVisibility(pageNum) {
    try {
        const table = document.getElementById('adminUsersTable');
        if (!table) return;
        const sel = pageNum === 1 ? '[data-page="1"], [data-page="1 2"]' : '[data-page="2"], [data-page="1 2"]';
        const hide = pageNum === 1 ? '[data-page="2"]' : '[data-page="1"]';
        table.querySelectorAll('th' + hide).forEach(el => { el.style.display = 'none'; });
        table.querySelectorAll('th' + sel).forEach(el => { el.style.display = ''; });
        table.querySelectorAll('tbody td' + hide).forEach(el => { el.style.display = 'none'; });
        table.querySelectorAll('tbody td' + sel).forEach(el => { el.style.display = ''; });
    } catch (e) {
        console.warn('applyAdminUsersPageVisibility:', e);
    }
}

window.switchAdminUsersPage = function (pageNum) {
    if (pageNum !== 1 && pageNum !== 2) return;
    adminUsersCurrentPage = pageNum;
    applyAdminUsersPageVisibility(pageNum);
    const btn1 = document.getElementById('adminUsersPage1');
    const btn2 = document.getElementById('adminUsersPage2');
    if (btn1 && btn2) {
        if (pageNum === 1) {
            btn1.classList.add('bg-emerald-100', 'text-emerald-800');
            btn1.classList.remove('bg-transparent', 'text-slate-600');
            btn1.setAttribute('aria-pressed', 'true');
            btn2.classList.add('bg-transparent', 'text-slate-600');
            btn2.classList.remove('bg-emerald-100', 'text-emerald-800');
            btn2.setAttribute('aria-pressed', 'false');
        } else {
            btn2.classList.add('bg-emerald-100', 'text-emerald-800');
            btn2.classList.remove('bg-transparent', 'text-slate-600');
            btn2.setAttribute('aria-pressed', 'true');
            btn1.classList.add('bg-transparent', 'text-slate-600');
            btn1.classList.remove('bg-emerald-100', 'text-emerald-800');
            btn1.setAttribute('aria-pressed', 'false');
        }
    }
};

window.switchAdminUsersListPage = function (pageNum) {
    if (pageNum < 1) return;
    adminUsersListPage = pageNum;
    renderUsers();
};

function _applyAdminUsersPageBtnState() {
    const btn1 = document.getElementById('adminUsersPage1');
    const btn2 = document.getElementById('adminUsersPage2');
    if (btn1 && btn2) {
        if (adminUsersCurrentPage === 1) {
            btn1.classList.add('bg-emerald-100', 'text-emerald-800');
            btn1.classList.remove('bg-transparent', 'text-slate-600');
            btn2.classList.add('bg-transparent', 'text-slate-600');
            btn2.classList.remove('bg-emerald-100', 'text-emerald-800');
        } else {
            btn2.classList.add('bg-emerald-100', 'text-emerald-800');
            btn2.classList.remove('bg-transparent', 'text-slate-600');
            btn2.setAttribute('aria-pressed', 'true');
            btn1.classList.add('bg-transparent', 'text-slate-600');
            btn1.classList.remove('bg-emerald-100', 'text-emerald-800');
            btn1.setAttribute('aria-pressed', 'false');
        }
    }
};

// 사용자 테이블 전체 선택 체크박스
function initAdminUsersSelectAll() {
    const selectAll = document.getElementById('adminUsersSelectAll');
    const checkboxes = document.querySelectorAll('.admin-user-checkbox');
    if (!selectAll) return;
    selectAll.checked = false;
    selectAll.indeterminate = false;
    selectAll.onchange = function () {
        checkboxes.forEach(cb => { cb.checked = selectAll.checked; });
        selectAll.indeterminate = false;
    };
    checkboxes.forEach(cb => {
        cb.onchange = function () {
            const checked = document.querySelectorAll('.admin-user-checkbox:checked').length;
            selectAll.checked = checked === checkboxes.length;
            selectAll.indeterminate = checked > 0 && checked < checkboxes.length;
        };
    });
}

// 선택된 사용자 ID 목록
function getSelectedUserIds() {
    return Array.from(document.querySelectorAll('.admin-user-checkbox:checked'))
        .map(cb => cb.getAttribute('data-user-id'))
        .filter(Boolean);
}

// 대기 중인 삭제 요청 수동 처리 (트리거가 동작하지 않을 때 사용)
window.processDeleteUserRequests = async function () {
    const uid = adminAuth.currentUser?.uid;
    if (!uid) {
        alert('관리자 로그인이 필요합니다.');
        return;
    }
    try {
        const processDeleteUserRequestsFn = httpsCallable(functions, 'processDeleteUserRequests');
        const result = await processDeleteUserRequestsFn();
        const data = result?.data || {};
        const { processed = 0, failed = 0, total = 0, errors } = data;
        if (total === 0) {
            alert('처리할 삭제 요청이 없습니다.');
        } else {
            let msg = `삭제 요청 처리: ${processed}명 삭제됨`;
            if (failed > 0) {
                msg += `, ${failed}명 실패.\n실패한 요청은 회색으로 유지되며, 새로고침 후 다시 "삭제 요청 처리"를 시도할 수 있습니다.`;
                if (errors && errors.length) msg += '\n\n실패 사유:\n' + errors.slice(0, 8).join('\n');
            }
            alert(msg);
        }
        usersCache = null;
        renderUsers();
    } catch (e) {
        console.error('삭제 요청 처리 실패:', e);
        alert('삭제 요청 처리 중 오류가 발생했습니다: ' + (e.message || e));
    }
};

// 선택 삭제: deleteUserRequests에 문서 생성 후 즉시 processDeleteUserRequests 호출
window.adminUserDeleteSelected = async function () {
    let ids = getSelectedUserIds();
    if (ids.length === 0) {
        alert('삭제할 사용자를 선택해 주세요.');
        return;
    }
    ids = [...new Set(ids)];
    if (!confirm(`선택한 ${ids.length}명의 사용자를 삭제하시겠습니까?\n삭제 후 해당 계정으로 로그인할 수 없습니다.`)) {
        return;
    }
    const uid = adminAuth.currentUser?.uid;
    if (!uid) {
        alert('관리자 로그인이 필요합니다.');
        return;
    }
    try {
        const coll = collection(db, 'artifacts', appId, 'deleteUserRequests');
        for (const userId of ids) {
            await addDoc(coll, { userId, requestedBy: uid, timestamp: serverTimestamp() });
        }
        usersCache = null;
        try {
            const processDeleteUserRequestsFn = httpsCallable(functions, 'processDeleteUserRequests');
            const result = await processDeleteUserRequestsFn();
            const data = result?.data || {};
            const { processed = 0, failed = 0, total = 0, errors } = data;
            let msg = total === 0
                ? '처리할 삭제 요청이 없습니다.'
                : `${processed}명 삭제됨`;
            if (failed > 0) {
                msg += `, ${failed}명 실패.`;
                if (errors && errors.length) msg += '\n\n실패: ' + errors.slice(0, 5).join('\n');
            }
            alert(msg);
        } catch (e) {
            console.error('삭제 요청 처리 실패:', e);
            alert('삭제 요청은 접수되었으나 즉시 처리에 실패했습니다.\n"삭제 요청 처리" 버튼을 눌러 다시 시도해 주세요.\n\n' + (e.message || e));
        }
        renderUsers();
    } catch (e) {
        console.error('삭제 요청 실패:', e);
        alert('삭제 요청 중 오류가 발생했습니다: ' + (e.message || e));
    }
};

// 공유 금지 설정/해제
window.adminUserBanShare = async function (value) {
    const ids = getSelectedUserIds();
    if (ids.length === 0) {
        alert('대상을 선택해 주세요.');
        return;
    }
    const uid = adminAuth.currentUser?.uid;
    if (!uid) {
        alert('관리자 로그인이 필요합니다.');
        return;
    }
    try {
        for (const userId of ids) {
            const ref = doc(db, 'artifacts', appId, 'userBans', userId);
            const snap = await getDoc(ref);
            const current = snap.exists() ? snap.data() : {};
            await setDoc(ref, {
                ...current,
                bannedShare: !!value,
                updatedAt: new Date().toISOString(),
                updatedBy: uid
            }, { merge: true });
        }
        alert(value ? `선택한 ${ids.length}명에게 공유 금지를 적용했습니다.` : `선택한 ${ids.length}명의 공유 금지를 해제했습니다.`);
        usersCache = null;
        renderUsers();
    } catch (e) {
        console.error('공유 금지 설정 실패:', e);
        alert('설정 중 오류가 발생했습니다: ' + (e.message || e));
    }
};

// 글쓰기(댓글 포함) 금지 설정/해제
window.adminUserBanWrite = async function (value) {
    const ids = getSelectedUserIds();
    if (ids.length === 0) {
        alert('대상을 선택해 주세요.');
        return;
    }
    const uid = adminAuth.currentUser?.uid;
    if (!uid) {
        alert('관리자 로그인이 필요합니다.');
        return;
    }
    try {
        for (const userId of ids) {
            const ref = doc(db, 'artifacts', appId, 'userBans', userId);
            const snap = await getDoc(ref);
            const current = snap.exists() ? snap.data() : {};
            await setDoc(ref, {
                ...current,
                bannedWrite: !!value,
                updatedAt: new Date().toISOString(),
                updatedBy: uid
            }, { merge: true });
        }
        alert(value ? `선택한 ${ids.length}명에게 글쓰기(댓글) 금지를 적용했습니다.` : `선택한 ${ids.length}명의 글쓰기 금지를 해제했습니다.`);
        usersCache = null;
        renderUsers();
    } catch (e) {
        console.error('글쓰기 금지 설정 실패:', e);
        alert('설정 중 오류가 발생했습니다: ' + (e.message || e));
    }
};

// 사용자 목록 새로고침
window.refreshUsers = function() {
    usersCache = null;
    renderUsers();
}

// 공지 렌더링 (관리자: 글목록 + 선택 시 본문)
let currentEditingNoticeId = null;
let currentSelectedNoticeId = null;

const NOTICE_TYPE_LABELS = { important: '중요', notice: '알림', light: '가벼운' };
const NOTICE_TYPE_CLASSES = { important: 'bg-red-100 text-red-700', notice: 'bg-blue-100 text-blue-700', light: 'bg-slate-100 text-slate-700' };

function formatNoticeDate(notice) {
    const ts = notice.timestamp;
    if (!ts) return '-';
    const d = typeof ts?.toDate === 'function' ? ts.toDate() : new Date(ts);
    return Number.isFinite(d.getTime()) ? d.toLocaleDateString('ko-KR') : '-';
}

async function renderNotices() {
    const container = document.getElementById('noticesContainer');
    if (!container) return;
    
    try {
        const noticesColl = collection(db, 'artifacts', appId, 'notices');
        const noticesSnapshot = await getDocs(query(noticesColl, orderBy('timestamp', 'desc')));
        
        if (noticesSnapshot.empty) {
            container.innerHTML = '<div class="text-center py-8 text-slate-400 px-4"><i class="fa-solid fa-bullhorn text-2xl mb-2"></i><p>공지가 없습니다.</p></div>';
            document.getElementById('noticeDetailContainer').innerHTML = '목록에서 공지를 선택하면 본문이 표시됩니다.';
            return;
        }
        
        container.innerHTML = noticesSnapshot.docs.map(d => {
            const notice = d.data();
            const noticeId = d.id;
            const date = formatNoticeDate(notice);
            const type = notice.type || notice.noticeType || 'notice';
            const typeLabel = NOTICE_TYPE_LABELS[type] || '알림';
            const typeClass = NOTICE_TYPE_CLASSES[type] || NOTICE_TYPE_CLASSES.notice;
            const isSelected = currentSelectedNoticeId === noticeId;
            return `
                <div data-notice-id="${noticeId}" onclick="window.selectAdminNotice('${noticeId}')" class="admin-notice-row px-4 py-3 border-b border-slate-100 last:border-b-0 cursor-pointer hover:bg-slate-50 transition-colors ${isSelected ? 'bg-emerald-50 border-l-4 border-l-emerald-500' : ''}">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="px-2 py-0.5 text-xs font-bold rounded ${typeClass}">${escapeHtml(typeLabel)}</span>
                        ${notice.isPinned === true ? '<span class="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs font-bold rounded">고정</span>' : ''}
                        ${notice.hidden === true ? '<span class="px-2 py-0.5 bg-slate-200 text-slate-600 text-xs font-bold rounded">숨김</span>' : ''}
                    </div>
                    <h3 class="font-bold text-slate-800 truncate mt-1">${escapeHtml(notice.title || '제목 없음')}</h3>
                    <div class="text-xs text-slate-400 mt-1">${date}</div>
                </div>
            `;
        }).join('');
        
        const listPage = document.getElementById('noticeListPage');
        const detailPage = document.getElementById('noticeDetailPage');
        if (listPage) listPage.classList.remove('hidden');
        if (detailPage) detailPage.classList.add('hidden');
    } catch (e) {
        console.error("공지 렌더링 실패:", e);
        container.innerHTML = '<div class="text-center py-8 text-red-400 px-4"><i class="fa-solid fa-exclamation-triangle text-2xl mb-2"></i><p>공지를 불러오는 중 오류가 발생했습니다.</p></div>';
    }
}

// 관리자 공지 본문 표시
async function renderNoticeDetailInAdmin(noticeId) {
    const container = document.getElementById('noticeDetailContainer');
    if (!container) return;
    
    if (!noticeId) {
        container.innerHTML = '';
        return;
    }
    
    try {
        const noticeDoc = doc(db, 'artifacts', appId, 'notices', noticeId);
        const snap = await getDoc(noticeDoc);
        if (!snap.exists()) {
            container.innerHTML = '<p class="text-red-400">공지를 찾을 수 없습니다.</p>';
            return;
        }
        const notice = snap.data();
        const date = formatNoticeDate(notice);
        const type = notice.type || notice.noticeType || 'notice';
        const typeLabel = NOTICE_TYPE_LABELS[type] || '알림';
        const typeClass = NOTICE_TYPE_CLASSES[type] || NOTICE_TYPE_CLASSES.notice;
        
        container.innerHTML = `
            <div class="bg-white rounded-xl p-4 border border-slate-200">
                <div class="flex items-center gap-2 flex-wrap mb-2">
                    <span class="px-2 py-0.5 text-xs font-bold rounded ${typeClass}">${escapeHtml(typeLabel)}</span>
                    ${notice.isPinned === true ? '<span class="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs font-bold rounded">고정</span>' : ''}
                    ${notice.hidden === true ? '<span class="px-2 py-0.5 bg-slate-200 text-slate-600 text-xs font-bold rounded">숨김</span>' : ''}
                </div>
                <h2 class="text-lg font-bold text-slate-800 mb-2">${escapeHtml(notice.title || '제목 없음')}</h2>
                <div class="text-xs text-slate-400 mb-4">${date}</div>
                ${Array.isArray(notice.imageUrls) && notice.imageUrls.length > 0 ? `
                <div class="flex flex-wrap gap-2 mb-4">
                    ${notice.imageUrls.map(url => `<img src="${url}" alt="공지 사진" class="max-w-full h-auto rounded-xl border border-slate-200 object-cover" style="max-height: 200px;" loading="lazy">`).join('')}
                </div>
                ` : ''}
                <div class="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed mb-4">${renderFormattedContent(notice.content || '')}</div>
                <div class="pt-2 border-t border-slate-200">
                    <p class="text-xs text-slate-500 mb-2">작업</p>
                    <div class="flex gap-2 flex-wrap">
                        <button type="button" onclick="window.toggleNoticeHidden('${noticeId}')" class="px-4 py-2 ${notice.hidden === true ? 'bg-emerald-500 text-white hover:bg-emerald-600' : 'bg-slate-500 text-white hover:bg-slate-600'} rounded-lg text-sm font-bold transition-colors">
                            <i class="fa-solid fa-eye${notice.hidden === true ? '-slash' : ''} mr-1.5"></i>${notice.hidden === true ? '숨김 해제' : '숨김'}
                        </button>
                        <button type="button" onclick="window.editNotice('${noticeId}')" class="px-3 py-1.5 bg-blue-50 text-blue-600 rounded-lg text-xs font-bold hover:bg-blue-100 transition-colors">
                            <i class="fa-solid fa-pencil mr-1"></i>수정
                        </button>
                        <button type="button" onclick="window.deleteNotice('${noticeId}')" class="px-3 py-1.5 bg-red-50 text-red-600 rounded-lg text-xs font-bold hover:bg-red-100 transition-colors">
                            <i class="fa-solid fa-trash mr-1"></i>삭제
                        </button>
                    </div>
                </div>
            </div>
        `;
    } catch (e) {
        console.error("공지 본문 로드 실패:", e);
        container.innerHTML = '<p class="text-red-400">본문을 불러오는 중 오류가 발생했습니다.</p>';
    }
}

// 관리자 공지 목록에서 항목 선택 → 글본문 페이지로 전환
window.selectAdminNotice = function(noticeId) {
    currentSelectedNoticeId = noticeId;
    const listPage = document.getElementById('noticeListPage');
    const detailPage = document.getElementById('noticeDetailPage');
    if (listPage) listPage.classList.add('hidden');
    if (detailPage) detailPage.classList.remove('hidden');
    renderNoticeDetailInAdmin(noticeId);
    document.querySelectorAll('.admin-notice-row').forEach(row => {
        const id = row.getAttribute('data-notice-id');
        if (id === noticeId) {
            row.classList.add('bg-emerald-50', 'border-l-4', 'border-l-emerald-500');
            row.classList.remove('border-l-0');
        } else {
            row.classList.remove('bg-emerald-50', 'border-l-4', 'border-l-emerald-500');
        }
    });
};

// 관리자 공지 글본문 → 글목록 페이지로 돌아가기
window.backToNoticeList = function() {
    currentSelectedNoticeId = null;
    const listPage = document.getElementById('noticeListPage');
    const detailPage = document.getElementById('noticeDetailPage');
    const writePage = document.getElementById('noticeWritePage');
    if (listPage) listPage.classList.remove('hidden');
    if (detailPage) detailPage.classList.add('hidden');
    if (writePage) writePage.classList.add('hidden');
};

// 글쓰기/수정 페이지에서 목록으로 (취소·등록 후 공통)
window.backToNoticeListFromWrite = function() {
    window.backToNoticeList();
    currentEditingNoticeId = null;
};

// 공지 작성/수정 페이지 열기 (페이지 형식)
window.openNoticeWriteModal = function(noticeId = null) {
    currentEditingNoticeId = noticeId;
    const listPage = document.getElementById('noticeListPage');
    const detailPage = document.getElementById('noticeDetailPage');
    const writePage = document.getElementById('noticeWritePage');
    const titleEl = document.getElementById('noticeWritePageTitle');
    const submitBtn = document.getElementById('noticeSubmitBtn');
    const titleInput = document.getElementById('noticeTitle');
    const contentInput = document.getElementById('noticeContent');
    const typeSelect = document.getElementById('noticeType');
    const pinnedCheckbox = document.getElementById('noticeIsPinned');
    const hiddenCheckbox = document.getElementById('noticeHidden');
    
    if (!writePage) return;
    
    // 목록/상세 숨기고 글쓰기 페이지 표시
    if (listPage) listPage.classList.add('hidden');
    if (detailPage) detailPage.classList.add('hidden');
    writePage.classList.remove('hidden');
    
    // 초기화
    if (titleInput) titleInput.value = '';
    if (contentInput) {
        contentInput.innerHTML = '';
        contentInput.classList.add('format-editor-empty');
    }
    window.noticeExistingUrls = [];
    window.noticeFiles = [];
    if (window.noticeObjectUrls?.length) {
        window.noticeObjectUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
    }
    window.noticeObjectUrls = [];
    const noticeImagesInput = document.getElementById('noticeImages');
    if (noticeImagesInput) noticeImagesInput.value = '';
    renderNoticeImagePreviews();
    if (typeSelect) typeSelect.value = 'important';
    if (pinnedCheckbox) pinnedCheckbox.checked = false;
    if (hiddenCheckbox) hiddenCheckbox.checked = false;
    
    // 수정 모드인 경우
    if (noticeId) {
        if (titleEl) titleEl.textContent = '공지 수정';
        if (submitBtn) submitBtn.textContent = '수정';
        
        // 공지 데이터 로드
        const noticeDoc = doc(db, 'artifacts', appId, 'notices', noticeId);
        getDoc(noticeDoc).then(snap => {
            if (snap.exists()) {
                const noticeData = snap.data();
                if (titleInput) titleInput.value = noticeData.title || '';
                if (contentInput) {
                    contentInput.innerHTML = (noticeData.content || '').replace(/\n/g, '<br>');
                    contentInput.classList.remove('format-editor-empty');
                }
                window.noticeExistingUrls = Array.isArray(noticeData.imageUrls) ? [...noticeData.imageUrls] : [];
                window.noticeFiles = [];
                if (window.noticeObjectUrls?.length) {
                    window.noticeObjectUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
                }
                window.noticeObjectUrls = [];
                const noticeImagesInput = document.getElementById('noticeImages');
                if (noticeImagesInput) noticeImagesInput.value = '';
                renderNoticeImagePreviews();
                if (typeSelect) typeSelect.value = noticeData.type || 'important';
                if (pinnedCheckbox) pinnedCheckbox.checked = Boolean(noticeData.isPinned === true);
                if (hiddenCheckbox) hiddenCheckbox.checked = Boolean(noticeData.hidden === true);
            }
        }).catch(e => {
            console.error("공지 로드 실패:", e);
            alert("공지를 불러오는 중 오류가 발생했습니다.");
        });
    } else {
        if (titleEl) titleEl.textContent = '공지 작성';
        if (submitBtn) submitBtn.textContent = '등록';
    }
};

// 공지 사진 미리보기 렌더
function renderNoticeImagePreviews() {
    const container = document.getElementById('noticeImagePreviews');
    if (!container) return;
    const existing = window.noticeExistingUrls || [];
    const files = window.noticeFiles || [];
    container.innerHTML = '';
    existing.forEach((url, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'relative w-16 h-16 rounded-lg overflow-hidden border border-slate-200 flex-shrink-0';
        wrap.innerHTML = `
            <img src="${url}" alt="미리보기" class="w-full h-full object-cover">
            <button type="button" class="absolute top-0 right-0 w-6 h-6 flex items-center justify-center bg-red-500 text-white text-xs rounded-bl hover:bg-red-600" data-type="url" data-index="${i}" aria-label="삭제">
                <i class="fa-solid fa-times"></i>
            </button>
        `;
        wrap.querySelector('button').addEventListener('click', (e) => {
            e.preventDefault();
            window.noticeExistingUrls.splice(i, 1);
            renderNoticeImagePreviews();
        });
        container.appendChild(wrap);
    });
    files.forEach((file, i) => {
        const objectUrl = window.noticeObjectUrls && window.noticeObjectUrls[i];
        if (!objectUrl) return;
        const wrap = document.createElement('div');
        wrap.className = 'relative w-16 h-16 rounded-lg overflow-hidden border border-slate-200 flex-shrink-0';
        wrap.innerHTML = `
            <img src="${objectUrl}" alt="미리보기" class="w-full h-full object-cover">
            <button type="button" class="absolute top-0 right-0 w-6 h-6 flex items-center justify-center bg-red-500 text-white text-xs rounded-bl hover:bg-red-600" data-type="file" data-index="${i}" aria-label="삭제">
                <i class="fa-solid fa-times"></i>
            </button>
        `;
        wrap.querySelector('button').addEventListener('click', (e) => {
            e.preventDefault();
            if (window.noticeObjectUrls && window.noticeObjectUrls[i]) {
                try { URL.revokeObjectURL(window.noticeObjectUrls[i]); } catch (_) {}
                window.noticeObjectUrls.splice(i, 1);
            }
            window.noticeFiles.splice(i, 1);
            renderNoticeImagePreviews();
        });
        container.appendChild(wrap);
    });
}

// 공지 작성 페이지 닫기 (목록으로 복귀)
window.closeNoticeModal = function() {
    window.backToNoticeListFromWrite();
};

// 공지 제출 (작성/수정)
window.submitNotice = async function() {
    const titleInput = document.getElementById('noticeTitle');
    const contentInput = document.getElementById('noticeContent');
    const typeSelect = document.getElementById('noticeType');
    const pinnedCheckbox = document.getElementById('noticeIsPinned');
    const hiddenCheckbox = document.getElementById('noticeHidden');
    const submitBtn = document.getElementById('noticeSubmitBtn');
    
    if (!titleInput || !contentInput) return;
    
    const title = titleInput.value.trim();
    const rawContent = contentInput.innerHTML || '';
    let content = sanitizeFormattedText(rawContent).trim();
    const type = typeSelect ? typeSelect.value : 'important';
    const isPinned = pinnedCheckbox ? Boolean(pinnedCheckbox.checked) : false;
    const hidden = hiddenCheckbox ? Boolean(hiddenCheckbox.checked) : false;
    
    // sanitize 결과가 비었으나 rawContent에 내용이 있으면 위험 태그만 제거하여 서식 보존
    if (!content && rawContent.trim()) {
        content = stripDangerousTagsOnly(rawContent).trim();
    }
    if (!content) {
        const plainText = (contentInput.innerText || '').trim();
        if (plainText) content = plainText.replace(/\n/g, '<br>');
    }
    
    if (!title) {
        alert('제목을 입력해주세요.');
        return;
    }
    
    if (!content) {
        alert('내용을 입력해주세요.');
        return;
    }
    
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>처리 중...';
    }
    
    try {
        const existingUrls = window.noticeExistingUrls || [];
        const newFiles = window.noticeFiles || [];
        let imageUrls = [...existingUrls];
        if (newFiles.length > 0) {
            const uid = adminAuth.currentUser?.uid;
            if (!uid) {
                alert('로그인이 필요합니다.');
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = currentEditingNoticeId ? '수정' : '등록'; }
                return;
            }
            const newUrls = await uploadNoticeImages(newFiles, uid);
            imageUrls = [...existingUrls, ...newUrls];
        }
        
        const noticeData = {
            title: title,
            content: content,
            type: type,
            isPinned: isPinned,
            hidden: hidden,
            imageUrls: imageUrls,
            timestamp: new Date().toISOString(),
            authorDisplayName: await getAdminDisplayName()
        };
        
        if (currentEditingNoticeId) {
            // 수정 (isPinned, hidden 명시적 저장 - 체크 해제 시 false로 반영)
            const noticeDoc = doc(db, 'artifacts', appId, 'notices', currentEditingNoticeId);
            await setDoc(noticeDoc, { ...noticeData, isPinned: isPinned, hidden: hidden }, { merge: true });
            alert('공지가 수정되었습니다.');
        } else {
            // 작성
            const noticesColl = collection(db, 'artifacts', appId, 'notices');
            await addDoc(noticesColl, noticeData);
            alert('공지가 등록되었습니다.');
        }
        
        window.backToNoticeListFromWrite();
        await renderNotices();
    } catch (e) {
        console.error("공지 저장 실패:", e);
        alert("공지 저장 중 오류가 발생했습니다: " + e.message);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = currentEditingNoticeId ? '수정' : '등록';
        }
    }
};

// 공지 수정 (글쓰기 페이지로 전환)
window.editNotice = function(noticeId) {
    window.openNoticeWriteModal(noticeId);
};

function renderNoticeInlineImagePreviews() {
    const container = document.getElementById('noticeInlineImagePreviews');
    if (!container) return;
    const existing = window.noticeExistingUrls || [];
    const files = window.noticeFiles || [];
    container.innerHTML = '';
    existing.forEach((url, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'relative w-16 h-16 rounded-lg overflow-hidden border border-slate-200 flex-shrink-0';
        wrap.innerHTML = `<img src="${url}" alt="미리보기" class="w-full h-full object-cover"><button type="button" class="absolute top-0 right-0 w-6 h-6 flex items-center justify-center bg-red-500 text-white text-xs rounded-bl" data-type="url" data-index="${i}"><i class="fa-solid fa-times"></i></button>`;
        wrap.querySelector('button').onclick = () => { window.noticeExistingUrls.splice(i, 1); renderNoticeInlineImagePreviews(); };
        container.appendChild(wrap);
    });
    files.forEach((_, i) => {
        const url = (window.noticeObjectUrls || [])[i];
        if (!url) return;
        const wrap = document.createElement('div');
        wrap.className = 'relative w-16 h-16 rounded-lg overflow-hidden border border-slate-200 flex-shrink-0';
        wrap.innerHTML = `<img src="${url}" alt="미리보기" class="w-full h-full object-cover"><button type="button" class="absolute top-0 right-0 w-6 h-6 flex items-center justify-center bg-red-500 text-white text-xs rounded-bl"><i class="fa-solid fa-times"></i></button>`;
        wrap.querySelector('button').onclick = () => {
            window.noticeFiles.splice(i, 1);
            window.noticeObjectUrls.splice(i, 1);
            renderNoticeInlineImagePreviews();
        };
        container.appendChild(wrap);
    });
}

window.cancelNoticeEdit = function(noticeId) {
    currentEditingNoticeId = null;
    renderNoticeDetailInAdmin(noticeId);
};

window.submitNoticeFromInline = async function(noticeId) {
    const titleInput = document.getElementById('noticeInlineTitle');
    const contentInput = document.getElementById('noticeInlineContent');
    const typeSelect = document.getElementById('noticeInlineType');
    const pinnedCheckbox = document.getElementById('noticeInlinePinned');
    const hiddenCheckbox = document.getElementById('noticeInlineHidden');
    if (!titleInput || !contentInput) return;

    const title = titleInput.value.trim();
    const rawContent = contentInput.innerHTML || '';
    let content = sanitizeFormattedText(rawContent).trim();
    if (!content && rawContent.trim()) content = stripDangerousTagsOnly(rawContent).trim();
    if (!content) content = (contentInput.innerText || '').trim().replace(/\n/g, '<br>');

    if (!title) { alert('제목을 입력해주세요.'); return; }
    if (!content) { alert('내용을 입력해주세요.'); return; }

    const type = typeSelect ? typeSelect.value : 'important';
    const isPinned = pinnedCheckbox ? Boolean(pinnedCheckbox.checked) : false;
    const hidden = hiddenCheckbox ? Boolean(hiddenCheckbox.checked) : false;

    try {
        const existingUrls = window.noticeExistingUrls || [];
        const newFiles = window.noticeFiles || [];
        let imageUrls = [...existingUrls];
        if (newFiles.length > 0) {
            const uid = adminAuth.currentUser?.uid;
            if (!uid) { alert('로그인이 필요합니다.'); return; }
            const newUrls = await uploadNoticeImages(newFiles, uid);
            imageUrls = [...existingUrls, ...newUrls];
        }

        const noticeData = {
            title, content, type, isPinned, hidden, imageUrls,
            timestamp: new Date().toISOString(),
            authorDisplayName: await getAdminDisplayName()
        };
        const noticeDoc = doc(db, 'artifacts', appId, 'notices', noticeId);
        await setDoc(noticeDoc, { ...noticeData, isPinned, hidden }, { merge: true });
        alert('공지가 수정되었습니다.');
        currentEditingNoticeId = null;
        await renderNotices();
        await renderNoticeDetailInAdmin(noticeId);
    } catch (e) {
        console.error("공지 저장 실패:", e);
        alert("공지 저장 중 오류가 발생했습니다: " + e.message);
    }
};

// 공지 숨김/숨김 해제 토글 (글본문 페이지에서 바로)
window.toggleNoticeHidden = async function(noticeId) {
    if (!noticeId) return;
    try {
        const noticeDoc = doc(db, 'artifacts', appId, 'notices', noticeId);
        const snap = await getDoc(noticeDoc);
        if (!snap.exists()) {
            alert('공지를 찾을 수 없습니다.');
            return;
        }
        const current = Boolean(snap.data().hidden === true);
        await setDoc(noticeDoc, { hidden: !current }, { merge: true });
        await renderNoticeDetailInAdmin(noticeId);
        await renderNotices();
    } catch (e) {
        console.error("공지 숨김 토글 실패:", e);
        alert("처리 중 오류가 발생했습니다: " + e.message);
    }
};

// 공지 삭제
window.deleteNotice = async function(noticeId) {
    if (!confirm('정말 삭제하시겠습니까?')) return;
    
    try {
        if (noticeId === currentSelectedNoticeId) currentSelectedNoticeId = null;
        const noticeDoc = doc(db, 'artifacts', appId, 'notices', noticeId);
        await deleteDoc(noticeDoc);
        alert('공지가 삭제되었습니다.');
        await renderNotices();
    } catch (e) {
        console.error("공지 삭제 실패:", e);
        alert("공지 삭제 중 오류가 발생했습니다: " + e.message);
    }
};

// ========== 팝업 관리 ==========
const POPUP_TARGET_MENU_LABELS = { dashboard: '밀당', timeline: '밀로그', gallery: '모먼트', board: '밀톡', settings: '사용자' };
const POPUP_FREQUENCY_LABELS = { daily: '하루 한 번', on_login: '로그인 시마다', on_visit: '접근시마다' };
const POPUP_TARGET_ENV_LABELS = { all: '전체', production: '프로덕션만', staging: '스테이징만' };
let currentEditingPopupId = null;
let currentSelectedPopupId = null;

async function renderPopups() {
    const container = document.getElementById('popupsContainer');
    if (!container) return;
    try {
        const popupsColl = collection(db, 'artifacts', appId, 'popups');
        const popupsSnapshot = await getDocs(query(popupsColl, orderBy('timestamp', 'desc')));
        if (popupsSnapshot.empty) {
            container.innerHTML = '<div class="text-center py-8 text-slate-400 px-4"><i class="fa-solid fa-window-maximize text-2xl mb-2"></i><p>등록된 팝업이 없습니다.</p></div>';
            return;
        }
        container.innerHTML = popupsSnapshot.docs.map(d => {
            const p = d.data();
            const id = d.id;
            const menuLabel = POPUP_TARGET_MENU_LABELS[p.targetMenu] || p.targetMenu;
            const freqLabel = POPUP_FREQUENCY_LABELS[p.frequency] || p.frequency;
            const envLabel = POPUP_TARGET_ENV_LABELS[p.targetEnv] || POPUP_TARGET_ENV_LABELS.all;
            const start = p.startDate || '';
            const end = p.endDate || '';
            const isSelected = currentSelectedPopupId === id;
            return `
                <div data-popup-id="${id}" onclick="window.selectAdminPopup('${id}')" class="admin-popup-row flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100 last:border-b-0 cursor-pointer hover:bg-slate-50 transition-colors ${isSelected ? 'bg-emerald-50 border-l-4 border-l-emerald-500' : ''}">
                    <h3 class="font-bold text-slate-800 truncate min-w-0 flex-shrink">${escapeHtml(p.title || '제목 없음')}</h3>
                    <p class="text-xs text-slate-500 text-right whitespace-nowrap shrink-0">${envLabel} · ${menuLabel} · ${freqLabel} · ${start} ~ ${end}</p>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error("팝업 목록 로드 실패:", e);
        container.innerHTML = '<div class="text-center py-8 text-red-400 px-4"><i class="fa-solid fa-exclamation-triangle text-2xl mb-2"></i><p>팝업 목록을 불러오는 중 오류가 발생했습니다.</p></div>';
    }
}

window.selectAdminPopup = async function(popupId) {
    currentSelectedPopupId = popupId;
    const listPage = document.getElementById('popupListPage');
    const detailPage = document.getElementById('popupDetailPage');
    const writePage = document.getElementById('popupWritePage');
    if (!listPage || !detailPage) return;
    listPage.classList.add('hidden');
    writePage.classList.add('hidden');
    detailPage.classList.remove('hidden');
    await renderPopupDetailInAdmin(popupId);
    document.querySelectorAll('.admin-popup-row').forEach(row => {
        const id = row.getAttribute('data-popup-id');
        row.classList.toggle('bg-emerald-50', id === popupId);
        row.classList.toggle('border-l-4', id === popupId);
        row.classList.toggle('border-l-emerald-500', id === popupId);
    });
};

window.backToPopupList = function() {
    currentSelectedPopupId = null;
    const listPage = document.getElementById('popupListPage');
    const detailPage = document.getElementById('popupDetailPage');
    const writePage = document.getElementById('popupWritePage');
    if (listPage) listPage.classList.remove('hidden');
    if (detailPage) detailPage.classList.add('hidden');
    if (writePage) writePage.classList.add('hidden');
    renderPopups();
};

async function renderPopupDetailInAdmin(popupId) {
    const container = document.getElementById('popupDetailContainer');
    if (!container) return;
    container.innerHTML = '<p class="text-slate-500">로딩 중...</p>';
    try {
        const popupDoc = doc(db, 'artifacts', appId, 'popups', popupId);
        const snap = await getDoc(popupDoc);
        if (!snap.exists()) {
            container.innerHTML = '<p class="text-red-400">팝업을 찾을 수 없습니다.</p>';
            return;
        }
        const p = snap.data();
        const menuLabel = POPUP_TARGET_MENU_LABELS[p.targetMenu] || p.targetMenu;
        const freqLabel = POPUP_FREQUENCY_LABELS[p.frequency] || p.frequency;
        const envLabel = POPUP_TARGET_ENV_LABELS[p.targetEnv] || POPUP_TARGET_ENV_LABELS.all;
        const imagesHtml = Array.isArray(p.imageUrls) && p.imageUrls.length > 0
            ? `<div class="flex flex-col gap-2 mb-4">${p.imageUrls.map(url => `<img src="${url}" alt="팝업 사진" class="max-w-full h-auto rounded-xl border border-slate-200 object-contain" style="max-height: 50vh;">`).join('')}</div>`
            : '';
        const landingHtml = p.landingNoticeId
            ? `<p class="text-sm text-slate-600"><span class="font-bold">버튼 문구:</span> ${escapeHtml(p.landingButtonLabel || '선택한 공지 보기')}</p><p class="text-sm text-slate-600 mt-0.5"><span class="font-bold">연결 공지:</span> ${escapeHtml(p.landingNoticeTitle || '(공지)')}</p>`
            : '<p class="text-sm text-slate-500">미설정</p>';
        container.innerHTML = `
            <div class="mb-4">
                <h2 class="text-lg font-bold text-slate-800 mb-3">${escapeHtml(p.title || '제목 없음')}</h2>
                <div class="bg-slate-100 rounded-xl p-3 mb-4 text-sm">
                    <p class="font-bold text-slate-700 mb-1.5">설정</p>
                    <p class="text-slate-600"><span class="font-bold">표시 환경:</span> ${envLabel}</p>
                    <p class="text-slate-600 mt-0.5"><span class="font-bold">팝업 메뉴:</span> ${menuLabel}</p>
                    <p class="text-slate-600 mt-0.5"><span class="font-bold">팝업 주기:</span> ${freqLabel}</p>
                    <p class="text-slate-600 mt-0.5"><span class="font-bold">표시 기간:</span> ${p.startDate || ''} ~ ${p.endDate || ''}</p>
                    <p class="text-slate-600 mt-0.5"><span class="font-bold">랜딩 페이지:</span></p>
                    <div class="ml-2 mt-0.5">${landingHtml}</div>
                </div>
            </div>
            ${imagesHtml}
            <div class="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed mb-4">${renderFormattedContent(p.content || '')}</div>
            <div class="flex gap-2 pt-2 border-t border-slate-200">
                <button type="button" onclick="window.editPopup('${popupId}')" class="px-4 py-2 bg-blue-50 text-blue-600 rounded-lg text-sm font-bold hover:bg-blue-100">수정</button>
                <button type="button" onclick="window.deletePopup('${popupId}')" class="px-4 py-2 bg-red-50 text-red-600 rounded-lg text-sm font-bold hover:bg-red-100">삭제</button>
            </div>
        `;
    } catch (e) {
        console.error("팝업 본문 로드 실패:", e);
        container.innerHTML = '<p class="text-red-400">팝업을 불러오는 중 오류가 발생했습니다.</p>';
    }
}

function renderPopupImagePreviews() {
    const container = document.getElementById('popupImagePreviews');
    if (!container) return;
    const existing = window.popupExistingUrls || [];
    const files = window.popupFiles || [];
    container.innerHTML = '';
    existing.forEach((url, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'relative w-16 h-16 rounded-lg overflow-hidden border border-slate-200 flex-shrink-0';
        wrap.innerHTML = `
            <img src="${url}" alt="미리보기" class="w-full h-full object-cover">
            <button type="button" class="absolute top-0 right-0 w-6 h-6 flex items-center justify-center bg-red-500 text-white text-xs rounded-bl hover:bg-red-600" data-type="url" data-index="${i}" aria-label="삭제">
                <i class="fa-solid fa-times"></i>
            </button>
        `;
        wrap.querySelector('button').addEventListener('click', () => {
            window.popupExistingUrls.splice(i, 1);
            renderPopupImagePreviews();
        });
        container.appendChild(wrap);
    });
    files.forEach((file, i) => {
        const objectUrl = window.popupObjectUrls && window.popupObjectUrls[i];
        if (!objectUrl) return;
        const wrap = document.createElement('div');
        wrap.className = 'relative w-16 h-16 rounded-lg overflow-hidden border border-slate-200 flex-shrink-0';
        wrap.innerHTML = `
            <img src="${objectUrl}" alt="미리보기" class="w-full h-full object-cover">
            <button type="button" class="absolute top-0 right-0 w-6 h-6 flex items-center justify-center bg-red-500 text-white text-xs rounded-bl hover:bg-red-600" data-type="file" data-index="${i}" aria-label="삭제">
                <i class="fa-solid fa-times"></i>
            </button>
        `;
        wrap.querySelector('button').addEventListener('click', () => {
            if (window.popupObjectUrls && window.popupObjectUrls[i]) {
                try { URL.revokeObjectURL(window.popupObjectUrls[i]); } catch (_) {}
                window.popupObjectUrls.splice(i, 1);
            }
            window.popupFiles.splice(i, 1);
            renderPopupImagePreviews();
        });
        container.appendChild(wrap);
    });
}

window.openPopupWriteModal = function(popupId = null) {
    currentEditingPopupId = popupId;
    const listPage = document.getElementById('popupListPage');
    const detailPage = document.getElementById('popupDetailPage');
    const writePage = document.getElementById('popupWritePage');
    const titleEl = document.getElementById('popupWritePageTitle');
    const submitBtn = document.getElementById('popupSubmitBtn');
    const titleInput = document.getElementById('popupTitle');
    const contentInput = document.getElementById('popupContent');
    const targetMenuSelect = document.getElementById('popupTargetMenu');
    const startDateInput = document.getElementById('popupStartDate');
    const endDateInput = document.getElementById('popupEndDate');
    const frequencySelect = document.getElementById('popupFrequency');
    if (!writePage) return;
    if (listPage) listPage.classList.add('hidden');
    if (detailPage) detailPage.classList.add('hidden');
    writePage.classList.remove('hidden');
    if (titleInput) titleInput.value = '';
    if (contentInput) {
        contentInput.innerHTML = '';
        contentInput.classList.add('format-editor-empty');
    }
    window.popupExistingUrls = [];
    window.popupFiles = [];
    if (window.popupObjectUrls?.length) {
        window.popupObjectUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
    }
    window.popupObjectUrls = [];
    const popupImagesInput = document.getElementById('popupImages');
    if (popupImagesInput) popupImagesInput.value = '';
    renderPopupImagePreviews();
    const today = new Date().toISOString().slice(0, 10);
    if (startDateInput) startDateInput.value = today;
    if (endDateInput) endDateInput.value = today;
    if (targetMenuSelect) targetMenuSelect.value = 'timeline';
    if (frequencySelect) frequencySelect.value = 'daily';
    window.popupLandingNoticeId = '';
    window.popupLandingNoticeTitle = '';
    const landingIdEl = document.getElementById('popupLandingNoticeId');
    const landingLabelEl = document.getElementById('popupLandingLabel');
    const landingSelectedWrap = document.getElementById('popupLandingSelectedWrap');
    const landingSelectedTitle = document.getElementById('popupLandingSelectedTitle');
    const landingButtonLabelInput = document.getElementById('popupLandingButtonLabel');
    if (landingIdEl) landingIdEl.value = '';
    if (landingLabelEl) landingLabelEl.textContent = '공지 선택하기';
    if (landingSelectedWrap) landingSelectedWrap.classList.add('hidden');
    if (landingSelectedTitle) landingSelectedTitle.textContent = '';
    if (landingButtonLabelInput) landingButtonLabelInput.value = '';
    if (popupId) {
        if (titleEl) titleEl.textContent = '팝업 수정';
        if (submitBtn) submitBtn.textContent = '수정';
        const popupDoc = doc(db, 'artifacts', appId, 'popups', popupId);
        getDoc(popupDoc).then(snap => {
            if (snap.exists()) {
                const d = snap.data();
                if (titleInput) titleInput.value = d.title || '';
                if (contentInput) {
                    contentInput.innerHTML = (d.content || '').replace(/\n/g, '<br>');
                    contentInput.classList.remove('format-editor-empty');
                }
                window.popupExistingUrls = Array.isArray(d.imageUrls) ? [...d.imageUrls] : [];
                window.popupFiles = [];
                if (window.popupObjectUrls?.length) {
                    window.popupObjectUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
                }
                window.popupObjectUrls = [];
                if (popupImagesInput) popupImagesInput.value = '';
                renderPopupImagePreviews();
                if (targetMenuSelect) targetMenuSelect.value = d.targetMenu || 'timeline';
                if (startDateInput) startDateInput.value = d.startDate || today;
                if (endDateInput) endDateInput.value = d.endDate || today;
                if (frequencySelect) frequencySelect.value = d.frequency || 'daily';
                const targetEnvSelect = document.getElementById('popupTargetEnv');
                if (targetEnvSelect) targetEnvSelect.value = d.targetEnv || 'all';
                if (d.landingNoticeId) {
                    window.popupLandingNoticeId = d.landingNoticeId;
                    window.popupLandingNoticeTitle = d.landingNoticeTitle || '';
                    if (landingIdEl) landingIdEl.value = d.landingNoticeId;
                    if (landingLabelEl) landingLabelEl.textContent = '공지 변경하기';
                    if (landingSelectedWrap) landingSelectedWrap.classList.remove('hidden');
                    if (landingSelectedTitle) landingSelectedTitle.textContent = d.landingNoticeTitle || '(공지)';
                }
                if (landingButtonLabelInput) landingButtonLabelInput.value = d.landingButtonLabel || '';
            }
        }).catch(e => {
            console.error("팝업 로드 실패:", e);
            alert("팝업을 불러오는 중 오류가 발생했습니다.");
        });
    } else {
        if (titleEl) titleEl.textContent = '팝업 작성';
        if (submitBtn) submitBtn.textContent = '등록';
    }
}

window.openPopupLandingNoticeSelect = async function() {
    const modal = document.getElementById('popupLandingNoticeModal');
    const listEl = document.getElementById('popupLandingNoticeList');
    if (!modal || !listEl) return;
    listEl.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-xl mb-2"></i><p class="text-sm">로딩 중...</p></div>';
    modal.classList.remove('hidden');
    try {
        const noticesColl = collection(db, 'artifacts', appId, 'notices');
        const snap = await getDocs(query(noticesColl, orderBy('timestamp', 'desc')));
        if (snap.empty) {
            listEl.innerHTML = '<div class="text-center py-8 text-slate-400"><p class="text-sm">등록된 공지가 없습니다.</p></div>';
            return;
        }
        listEl.innerHTML = snap.docs.map(d => {
            const n = d.data();
            const id = d.id;
            const title = (n.title || '제목 없음').trim();
            return `<button type="button" data-notice-id="${escapeHtml(id)}" data-notice-title="${escapeHtml(title)}" class="popup-landing-notice-btn w-full text-left px-4 py-3 rounded-xl border border-slate-200 hover:bg-slate-50 hover:border-emerald-300 transition-colors">
                <span class="font-bold text-slate-800">${escapeHtml(title)}</span>
            </button>`;
        }).join('');
        listEl.querySelectorAll('.popup-landing-notice-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const noticeId = btn.getAttribute('data-notice-id');
                const noticeTitle = btn.getAttribute('data-notice-title') || '(공지)';
                window.selectPopupLandingNotice(noticeId, noticeTitle);
            });
        });
    } catch (e) {
        console.error("공지 목록 로드 실패:", e);
        listEl.innerHTML = '<div class="text-center py-8 text-red-400"><p class="text-sm">공지 목록을 불러오는 중 오류가 발생했습니다.</p></div>';
    }
};

window.selectPopupLandingNotice = function(noticeId, noticeTitle) {
    noticeTitle = (typeof noticeTitle === 'string') ? noticeTitle : (noticeTitle || '(공지)');
    window.popupLandingNoticeId = noticeId;
    window.popupLandingNoticeTitle = noticeTitle;
    const landingIdEl = document.getElementById('popupLandingNoticeId');
    const landingLabelEl = document.getElementById('popupLandingLabel');
    const landingSelectedWrap = document.getElementById('popupLandingSelectedWrap');
    const landingSelectedTitle = document.getElementById('popupLandingSelectedTitle');
    if (landingIdEl) landingIdEl.value = noticeId;
    if (landingLabelEl) landingLabelEl.textContent = '공지 변경하기';
    if (landingSelectedWrap) landingSelectedWrap.classList.remove('hidden');
    if (landingSelectedTitle) landingSelectedTitle.textContent = noticeTitle;
    window.closePopupLandingNoticeSelect();
};

window.closePopupLandingNoticeSelect = function() {
    const modal = document.getElementById('popupLandingNoticeModal');
    if (modal) modal.classList.add('hidden');
};

window.clearPopupLanding = function() {
    window.popupLandingNoticeId = '';
    window.popupLandingNoticeTitle = '';
    const landingIdEl = document.getElementById('popupLandingNoticeId');
    const landingLabelEl = document.getElementById('popupLandingLabel');
    const landingSelectedWrap = document.getElementById('popupLandingSelectedWrap');
    const landingSelectedTitle = document.getElementById('popupLandingSelectedTitle');
    if (landingIdEl) landingIdEl.value = '';
    if (landingLabelEl) landingLabelEl.textContent = '공지 선택하기';
    if (landingSelectedWrap) landingSelectedWrap.classList.add('hidden');
    if (landingSelectedTitle) landingSelectedTitle.textContent = '';
};

window.backToPopupListFromWrite = function() {
    const listPage = document.getElementById('popupListPage');
    const detailPage = document.getElementById('popupDetailPage');
    const writePage = document.getElementById('popupWritePage');
    if (listPage) listPage.classList.remove('hidden');
    if (detailPage) detailPage.classList.add('hidden');
    if (writePage) writePage.classList.add('hidden');
    currentEditingPopupId = null;
    renderPopups();
}

window.submitPopup = async function() {
    const titleInput = document.getElementById('popupTitle');
    const contentInput = document.getElementById('popupContent');
    const targetMenuSelect = document.getElementById('popupTargetMenu');
    const startDateInput = document.getElementById('popupStartDate');
    const endDateInput = document.getElementById('popupEndDate');
    const frequencySelect = document.getElementById('popupFrequency');
    const submitBtn = document.getElementById('popupSubmitBtn');
    if (!titleInput || !contentInput) return;
    const title = titleInput.value.trim();
    const rawContent = contentInput.innerHTML || '';
    let content = sanitizeFormattedText(rawContent).trim();
    if (!content && rawContent.trim()) content = stripDangerousTagsOnly(rawContent).trim();
    if (!content) content = (contentInput.innerText || '').trim().replace(/\n/g, '<br>');
    const targetMenu = targetMenuSelect ? targetMenuSelect.value : 'timeline';
    const startDate = startDateInput ? startDateInput.value : '';
    const endDate = endDateInput ? endDateInput.value : '';
    const frequency = frequencySelect ? frequencySelect.value : 'daily';
    const targetEnvSelect = document.getElementById('popupTargetEnv');
    const targetEnv = targetEnvSelect ? targetEnvSelect.value : 'all';
    if (!title) { alert('제목을 입력해주세요.'); return; }
    if (!content) { alert('내용을 입력해주세요.'); return; }
    if (!startDate || !endDate) { alert('팝업 기간(시작일·종료일)을 입력해주세요.'); return; }
    if (new Date(startDate) > new Date(endDate)) { alert('시작일이 종료일보다 늦을 수 없습니다.'); return; }
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>처리 중...';
    }
    try {
        const existingUrls = window.popupExistingUrls || [];
        const newFiles = window.popupFiles || [];
        let imageUrls = [...existingUrls];
        if (newFiles.length > 0) {
            const uid = adminAuth.currentUser?.uid;
            if (!uid) {
                alert('로그인이 필요합니다.');
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = currentEditingPopupId ? '수정' : '등록'; }
                return;
            }
            const newUrls = await uploadPopupImages(newFiles, uid);
            imageUrls = [...existingUrls, ...newUrls];
        }
        const landingIdEl = document.getElementById('popupLandingNoticeId');
        const landingButtonLabelInput = document.getElementById('popupLandingButtonLabel');
        const landingNoticeId = (landingIdEl && landingIdEl.value) ? landingIdEl.value.trim() : '';
        const popupData = {
            title,
            content,
            imageUrls,
            targetMenu,
            startDate,
            endDate,
            frequency,
            targetEnv: targetEnv || 'all',
            timestamp: new Date().toISOString(),
            authorDisplayName: await getAdminDisplayName()
        };
        if (landingNoticeId) {
            popupData.landingNoticeId = landingNoticeId;
            popupData.landingNoticeTitle = window.popupLandingNoticeTitle || '';
            popupData.landingButtonLabel = (landingButtonLabelInput && landingButtonLabelInput.value) ? landingButtonLabelInput.value.trim() : '';
        } else if (currentEditingPopupId) {
            popupData.landingNoticeId = deleteField();
            popupData.landingNoticeTitle = deleteField();
            popupData.landingButtonLabel = deleteField();
        }
        if (currentEditingPopupId) {
            const popupDoc = doc(db, 'artifacts', appId, 'popups', currentEditingPopupId);
            await setDoc(popupDoc, popupData, { merge: true });
            alert('팝업이 수정되었습니다.');
        } else {
            const popupsColl = collection(db, 'artifacts', appId, 'popups');
            await addDoc(popupsColl, popupData);
            alert('팝업이 등록되었습니다.');
        }
        window.backToPopupListFromWrite();
    } catch (e) {
        console.error("팝업 저장 실패:", e);
        alert("팝업 저장 중 오류가 발생했습니다: " + e.message);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = currentEditingPopupId ? '수정' : '등록';
        }
    }
}

window.editPopup = function(popupId) {
    window.openPopupWriteModal(popupId);
}

window.deletePopup = async function(popupId) {
    if (!confirm('이 팝업을 삭제하시겠습니까?')) return;
    try {
        const popupDoc = doc(db, 'artifacts', appId, 'popups', popupId);
        await deleteDoc(popupDoc);
        alert('팝업이 삭제되었습니다.');
        window.backToPopupList();
    } catch (e) {
        console.error("팝업 삭제 실패:", e);
        alert("팝업 삭제 중 오류가 발생했습니다: " + e.message);
    }
}

// 관리자 표시 이름 캐시 (공지·댓글 작성 시 사용)
let cachedAdminDisplayName = '관리자';

async function loadAdminSettings() {
    const inputEl = document.getElementById('adminDisplayNameInput');
    if (!inputEl) return;
    try {
        const configRef = doc(db, 'artifacts', appId, 'adminSettings', 'config');
        const snap = await getDoc(configRef);
        const displayName = snap.exists() && snap.data().displayName ? String(snap.data().displayName).trim() : '관리자';
        cachedAdminDisplayName = displayName || '관리자';
        inputEl.value = cachedAdminDisplayName;
    } catch (e) {
        console.warn('관리자 설정 로드 실패:', e);
        inputEl.value = cachedAdminDisplayName;
    }
}

window.saveAdminDisplayName = async function() {
    const inputEl = document.getElementById('adminDisplayNameInput');
    if (!inputEl) return;
    const value = inputEl.value.trim() || '관리자';
    try {
        const configRef = doc(db, 'artifacts', appId, 'adminSettings', 'config');
        await setDoc(configRef, { displayName: value }, { merge: true });
        cachedAdminDisplayName = value;
        invalidateAdminDisplayNameCache();
        alert('저장되었습니다.');
    } catch (e) {
        console.error('관리자 표시 이름 저장 실패:', e);
        alert('저장에 실패했습니다: ' + (e?.message || e));
    }
};

// 게시판 게시물 렌더링 (기본 구현)
let currentAdminBoardCategory = 'all';
async function renderBoardPosts(category = 'all') {
    const container = document.getElementById('boardPostsContainer');
    if (!container) return;
    
    currentAdminBoardCategory = category;
    container.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i><p>로딩 중...</p></div>';
    
    try {
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
        
        if (postsSnapshot.empty) {
            container.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-comments text-2xl mb-2"></i><p>게시물이 없습니다.</p></div>';
            return;
        }
        
        window._feedReportDetails = window._feedReportDetails || {};
        container.innerHTML = postsSnapshot.docs.map(d => {
            const post = d.data();
            const postId = d.id;
            const ts = post.timestamp;
            const date = ts ? (() => {
                const d = typeof ts?.toDate === 'function' ? ts.toDate() : new Date(ts);
                return Number.isFinite(d.getTime()) ? d.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '-';
            })() : '-';
            const reportInfo = reportsMap['board_' + postId];
            if (reportInfo && reportInfo.count > 0) {
                window._feedReportDetails['board_' + postId] = reportInfo.byReason;
            }
            const reportBadgeHtml = (reportInfo && reportInfo.count > 0)
                ? `<span class="px-2 py-0.5 bg-red-100 text-red-700 text-xs font-bold rounded cursor-pointer hover:bg-red-200" onclick="window.showReportDetailPopup('board_${String(postId).replace(/'/g, "\\'")}')">🚩 신고 ${reportInfo.count}</span>`
                : '';
            const isHidden = post.isHidden === true;
            const safePostId = String(postId).replace(/'/g, "\\'");
            return `
                <div class="border border-slate-200 rounded-xl p-4 ${isHidden ? 'bg-slate-50 opacity-90' : ''} board-list-row hover:bg-slate-50 transition-colors" data-post-id="${postId}">
                    <div class="flex items-start gap-4">
                        <div class="flex-shrink-0 pt-0.5">
                            <input type="checkbox" class="board-item-checkbox w-4 h-4 rounded border-slate-300" data-post-id="${postId}" title="선택">
                        </div>
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2 mb-2 flex-wrap">
                                <h3 class="font-bold text-slate-800"><span class="board-post-title-link cursor-pointer hover:underline" onclick="event.stopPropagation(); window.selectBoardPost('${safePostId}')">${escapeHtml(post.title || '')}</span></h3>
                                <span class="px-2 py-0.5 bg-slate-100 text-slate-700 text-xs font-bold rounded">${escapeHtml(post.category || '')}</span>
                                ${isHidden ? '<span class="px-2 py-0.5 bg-slate-300 text-slate-600 text-xs font-bold rounded">가려짐</span>' : ''}
                                ${reportBadgeHtml}
                            </div>
                            <p class="text-sm text-slate-600 mb-2">${escapeHtml(post.content || '').substring(0, 100)}${post.content && post.content.length > 100 ? '...' : ''}</p>
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
        }).join('');
    } catch (e) {
        console.error("게시판 게시물 렌더링 실패:", e);
        container.innerHTML = '<div class="text-center py-8 text-red-400"><i class="fa-solid fa-exclamation-triangle text-2xl mb-2"></i><p>게시물을 불러오는 중 오류가 발생했습니다.</p></div>';
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
        alert(ids.length + '건이 삭제되었습니다.');
        renderBoardPosts(currentAdminBoardCategory);
    } catch (e) {
        console.error(e);
        alert('삭제 실패: ' + (e?.message || e));
    }
};

// 게시판 게시물 새로고침
window.refreshBoardPosts = function() {
    renderBoardPosts(currentAdminBoardCategory);
}

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
            <h2 class="text-lg font-bold text-slate-800 mb-2">${escapeHtml(post.title || '제목 없음')}</h2>
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
    
    renderBoardPosts(category);
}

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

// 공유된 게시물 키 캐시 (userId_mealId) — 피드 필터/배지용, 세션당 1회 로드
let feedSharedKeysCache = null;

async function ensureFeedSharedKeysCache() {
    if (feedSharedKeysCache) return;
    const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
    const snap = await getDocs(sharedColl);
    feedSharedKeysCache = new Set();
    snap.docs.forEach(d => {
        const data = d.data();
        if (data.userId && data.entryId) feedSharedKeysCache.add(`${data.userId}_${data.entryId}`);
    });
}

async function renderFeedManagement() {
    const container = document.getElementById('feedManagementContainer');
    if (!container) return;
    
    container.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i><p>로딩 중...</p></div>';
    
    try {
        await ensureFeedSharedKeysCache();
        console.log('📋 피드 관리: 페이지', feedCurrentPage, '로드 중... (전체 타임라인)');
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
        
        // 페이지 단위로 이미 로드됨 (추가 slice 없음)
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
        
        container.innerHTML = paginatedMeals.map(meal => {
            const targetGroupKey = meal.isBestShare ? `best_${meal.id}` : meal.isDailyShare ? `daily_${meal.date || ''}_${meal.userId}` : meal.isInsightShare ? `insight_${meal.dateRangeText || ''}_${meal.userId}` : `entry_${meal.id}_${meal.userId}`;
            const reportInfo = reportsMap[targetGroupKey];
            if (reportInfo && reportInfo.count > 0) { window._feedReportDetails[targetGroupKey] = reportInfo.byReason; }
            const reportBadgeHtml = (reportInfo && reportInfo.count > 0) ? `<span class="px-2 py-0.5 bg-red-100 text-red-700 text-xs font-bold rounded cursor-pointer hover:bg-red-200" onclick="window.showReportDetailPopup('${String(targetGroupKey).replace(/'/g, "\\'")}')">🚩 신고 ${reportInfo.count}</span>` : '';
            
            // 베스트 공유 게시물인 경우
            if (meal.isBestShare) {
                const userInfo = { nickname: meal.userNickname || '익명', icon: meal.userIcon || '🐻' };
                let dateTimeStr = '-';
                if (meal.timestamp) {
                    try {
                        const dateObj = new Date(meal.timestamp);
                        dateTimeStr = dateObj.toLocaleString('ko-KR', {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit'
                        });
                    } catch (e) {
                        dateTimeStr = meal.timestamp;
                    }
                }
                
                return `
                    <div class="border border-slate-200 rounded-xl p-4 hover:shadow-md transition-shadow bg-emerald-50/30">
                        <div class="flex gap-4">
                            <div class="flex-shrink-0 flex items-start pt-1">
                                <input type="checkbox" class="feed-item-checkbox" data-meal-id="${meal.id}" data-user-id="${meal.userId}" data-is-best="true">
                            </div>
                            <div class="flex-1 min-w-0">
                                <div class="text-xs text-slate-500 font-bold mb-2">${dateTimeStr}</div>
                                <div class="flex items-start justify-between mb-2">
                                    <div class="flex items-center gap-2 flex-wrap">
                                        <span class="text-lg">${userInfo.icon}</span>
                                        <span class="font-bold text-slate-800">${userInfo.nickname}</span>
                                        <span class="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs font-bold rounded">🏆 베스트 공유</span>
                                        <span class="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs font-bold rounded">관리번호: ${meal.id}</span>
                                        <span class="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs font-bold rounded">${meal.periodType || ''} ${meal.periodText || ''}</span>
                                        <span class="px-2 py-0.5 bg-emerald-100 text-emerald-700 text-xs font-bold rounded">공유됨</span>
                                        ${reportBadgeHtml}
                                    </div>
                                </div>
                                ${meal.photoUrl ? `
                                    <div class="mb-2">
                                        <img src="${meal.photoUrl}" alt="베스트 공유 이미지" class="max-w-full h-auto rounded-xl border border-slate-200" style="max-height: 300px;">
                                    </div>
                                ` : ''}
                                ${meal.comment ? `<div class="mt-2 text-sm text-slate-700 bg-slate-50 p-2 rounded">${escapeHtml(meal.comment)}</div>` : ''}
                            </div>
                        </div>
                    </div>
                `;
            }
            
            // 일간보기 공유 게시물인 경우
            if (meal.isDailyShare) {
                const userInfo = { nickname: meal.userNickname || '익명', icon: meal.userIcon || '🐻' };
                let dateTimeStr = '-';
                if (meal.timestamp) {
                    try {
                        const dateObj = new Date(meal.timestamp);
                        dateTimeStr = dateObj.toLocaleString('ko-KR', {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit'
                        });
                    } catch (e) {
                        dateTimeStr = meal.timestamp;
                    }
                }
                
                // 날짜 표시
                let dateDisplay = meal.date || '-';
                if (meal.date) {
                    try {
                        const dateObj = new Date(meal.date + 'T00:00:00');
                        dateDisplay = dateObj.toLocaleDateString('ko-KR', { 
                            month: 'long', 
                            day: 'numeric', 
                            weekday: 'short' 
                        });
                    } catch (e) {
                        dateDisplay = meal.date;
                    }
                }
                
                return `
                    <div class="border border-slate-200 rounded-xl p-4 hover:shadow-md transition-shadow bg-blue-50/30">
                        <div class="flex gap-4">
                            <div class="flex-shrink-0 flex items-start pt-1">
                                <input type="checkbox" class="feed-item-checkbox" data-meal-id="${meal.id}" data-user-id="${meal.userId}" data-is-daily="true">
                            </div>
                            <div class="flex-1 min-w-0">
                                <div class="text-xs text-slate-500 font-bold mb-2">${dateTimeStr}</div>
                                <div class="flex items-start justify-between mb-2">
                                    <div class="flex items-center gap-2 flex-wrap">
                                        <span class="text-lg">${userInfo.icon}</span>
                                        <span class="font-bold text-slate-800">${userInfo.nickname}</span>
                                        <span class="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs font-bold rounded">📅 일간보기 공유</span>
                                        <span class="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs font-bold rounded">관리번호: ${meal.id}</span>
                                        <span class="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs font-bold rounded">${dateDisplay}</span>
                                        <span class="px-2 py-0.5 bg-emerald-100 text-emerald-700 text-xs font-bold rounded">공유됨</span>
                                        ${reportBadgeHtml}
                                    </div>
                                </div>
                                ${meal.photoUrl ? `
                                    <div class="mb-2">
                                        <img src="${meal.photoUrl}" alt="일간보기 공유 이미지" class="max-w-full h-auto rounded-xl border border-slate-200" style="max-height: 300px;">
                                    </div>
                                ` : ''}
                                ${meal.comment ? `<div class="mt-2 text-sm text-slate-700 bg-slate-50 p-2 rounded whitespace-pre-line">${escapeHtml(meal.comment)}</div>` : ''}
                            </div>
                        </div>
                    </div>
                `;
            }
            
            // 인사이트 공유 게시물인 경우
            if (meal.isInsightShare) {
                const userInfo = { nickname: meal.userNickname || '익명', icon: meal.userIcon || '🐻' };
                let dateTimeStr = '-';
                if (meal.timestamp) {
                    try {
                        const dateObj = new Date(meal.timestamp);
                        dateTimeStr = dateObj.toLocaleString('ko-KR', {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit'
                        });
                    } catch (e) {
                        dateTimeStr = meal.timestamp;
                    }
                }
                
                return `
                    <div class="border border-slate-200 rounded-xl p-4 hover:shadow-md transition-shadow bg-purple-50/30">
                        <div class="flex gap-4">
                            <div class="flex-shrink-0 flex items-start pt-1">
                                <input type="checkbox" class="feed-item-checkbox" data-meal-id="${meal.id}" data-user-id="${meal.userId}" data-is-insight="true">
                            </div>
                            <div class="flex-1 min-w-0">
                                <div class="text-xs text-slate-500 font-bold mb-2">${dateTimeStr}</div>
                                <div class="flex items-start justify-between mb-2">
                                    <div class="flex items-center gap-2 flex-wrap">
                                        <span class="text-lg">${userInfo.icon}</span>
                                        <span class="font-bold text-slate-800">${userInfo.nickname}</span>
                                        <span class="px-2 py-0.5 bg-purple-100 text-purple-700 text-xs font-bold rounded">💡 인사이트 공유</span>
                                        <span class="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs font-bold rounded">관리번호: ${meal.id}</span>
                                        <span class="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs font-bold rounded">${meal.dateRangeText || ''}</span>
                                        <span class="px-2 py-0.5 bg-emerald-100 text-emerald-700 text-xs font-bold rounded">공유됨</span>
                                        ${reportBadgeHtml}
                                    </div>
                                </div>
                                ${meal.photoUrl ? `
                                    <div class="mb-2">
                                        <img src="${meal.photoUrl}" alt="인사이트 공유 이미지" class="max-w-full h-auto rounded-xl border border-slate-200" style="max-height: 300px;">
                                    </div>
                                ` : ''}
                                ${meal.comment ? `<div class="mt-2 text-sm text-slate-700 bg-slate-50 p-2 rounded whitespace-pre-line">${escapeHtml(meal.comment)}</div>` : ''}
                            </div>
                        </div>
                    </div>
                `;
            }
            
            // 일반 게시물
            const userInfo = userInfoMap.get(meal.userId) || { nickname: '익명', icon: '🐻' };
            const date = meal.date || '-';
            const time = meal.time || '';
            // 날짜와 시간 포맷팅
            let dateTimeStr = '';
            if (date && date !== '-') {
                try {
                    const dateObj = new Date(date + (time ? `T${time}` : 'T00:00:00'));
                    dateTimeStr = dateObj.toLocaleString('ko-KR', {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit'
                    });
                } catch (e) {
                    dateTimeStr = `${date} ${time || ''}`.trim();
                }
            } else {
                dateTimeStr = '-';
            }
            const isShared = feedSharedKeysCache && feedSharedKeysCache.has(`${meal.userId}_${meal.id}`);
            const hasLocalSharedPhotos = meal.sharedPhotos && Array.isArray(meal.sharedPhotos) && meal.sharedPhotos.length > 0;
            const hasPhotos = meal.photos && meal.photos.length > 0;
            const isBanned = meal.shareBanned === true;
            // 데이터 불일치 감지: meal.sharedPhotos 배열은 있지만 sharedPhotos 컬렉션에는 없음
            const hasDataMismatch = hasLocalSharedPhotos && !isShared;
            
            return `
                <div class="border border-slate-200 rounded-xl p-4 hover:shadow-md transition-shadow ${isBanned ? 'bg-red-50' : ''} ${hasDataMismatch ? 'bg-yellow-50 border-yellow-300' : ''}">
                    <div class="flex gap-4">
                        <div class="flex-shrink-0 flex items-start pt-1">
                            <input type="checkbox" class="feed-item-checkbox" data-meal-id="${meal.id}" data-user-id="${meal.userId}">
                        </div>
                        <div class="flex-1 min-w-0">
                            <div class="text-xs text-slate-500 font-bold mb-2">${dateTimeStr}</div>
                            <div class="flex items-start justify-between mb-2">
                                <div class="flex items-center gap-2 flex-wrap">
                                    <span class="text-lg">${userInfo.icon}</span>
                                    <span class="font-bold text-slate-800">${userInfo.nickname}</span>
                                    <span class="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs font-bold rounded">관리번호: ${meal.id}</span>
                                    ${isShared ? '<span class="px-2 py-0.5 bg-emerald-100 text-emerald-700 text-xs font-bold rounded">공유됨</span>' : ''}
                                    ${hasDataMismatch ? '<span class="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs font-bold rounded">데이터 불일치</span>' : ''}
                                    ${isBanned ? '<span class="px-2 py-0.5 bg-red-100 text-red-700 text-xs font-bold rounded">금지됨</span>' : ''}
                                    ${reportBadgeHtml}
                                </div>
                                ${hasDataMismatch ? `<button onclick="window.syncSharedPhotos('${meal.id}', '${meal.userId}')" class="px-3 py-1 bg-yellow-600 text-white rounded-lg text-xs font-bold hover:bg-yellow-700 transition-colors">동기화</button>` : ''}
                            </div>
                            <div class="text-sm text-slate-600 mb-2">
                                ${meal.menuDetail || meal.place || meal.snackType || '내용 없음'}
                            </div>
                            ${hasPhotos && meal.photos && meal.photos.length > 0 ? `
                                <div class="flex flex-wrap gap-2 mb-2">
                                    ${meal.photos.map(photo => `
                                        <img src="${photo}" alt="사진" class="w-40 h-40 object-cover rounded-xl">
                                    `).join('')}
                                </div>
                            ` : ''}
                            ${meal.comment ? `<div class="mt-2 text-sm text-slate-700 bg-slate-50 p-2 rounded">${escapeHtml(meal.comment)}</div>` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        
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

// 페르소나 사이드바 전환
// switchPersonaSidebar는 더 이상 사용하지 않음 (콘텐츠 관리로 이동)
// 기존 호출을 switchContentSidebar로 변경
window.switchPersonaSidebar = function(section) {
    // 콘텐츠 관리 탭으로 리다이렉트
    window.switchAdminTab('content');
    setTimeout(() => {
        window.switchContentSidebar(section);
    }, 100);
};

// MEALOG 코멘트 로드
async function loadMealogComments() {
    const container = document.getElementById('mealogCommentsContainer');
    if (!container) return;
    
    container.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i><p>로딩 중...</p></div>';
    
    try {
        const mealogDocRef = doc(db, 'artifacts', appId, 'persona', 'mealog');
        const mealogSnap = await getDoc(mealogDocRef);
        
        let comments = [];
        if (mealogSnap.exists()) {
            const data = mealogSnap.data();
            comments = data.comments || [];
        }
        
        // 기본값이 없으면 기본 메시지 추가
        if (comments.length === 0) {
            comments = [`안녕하세요! MEALOG 사용 방법을
안내해드릴게요.

📌 캐릭터 선택
왼쪽 캐릭터 아이콘을 클릭하면
다양한 캐릭터를 선택할 수 있어요.
각 캐릭터는 서로 다른 스타일로
식사 기록을 분석해줘요.

💬 COMMENT 버튼
노란색 COMMENT 버튼을 누르면
선택한 캐릭터가 AI로 당신의
식사 기록을 분석해서
특별한 코멘트를 만들어줘요!

🏆 베스트 공유
Best 분석 탭에서 "공유하기"
버튼을 누르면 이번 주/월의
베스트 식사를 피드에
공유할 수 있어요.

📊 식사/간식 분석
Best, 식사, 간식 탭을 눌러서
다양한 방식으로 기록을
확인해보세요.`];
        }
        
        renderMealogComments(comments);
    } catch (e) {
        console.error('MEALOG 코멘트 로드 실패:', e);
        container.innerHTML = '<div class="text-center py-8 text-red-400"><i class="fa-solid fa-exclamation-triangle text-2xl mb-2"></i><p>MEALOG 코멘트를 불러오는 중 오류가 발생했습니다: ' + e.message + '</p></div>';
    }
}

// MEALOG 코멘트 렌더링
function renderMealogComments(comments) {
    const container = document.getElementById('mealogCommentsContainer');
    if (!container) return;
    
    // 기존 내용 제거
    container.innerHTML = '';
    
    // 각 코멘트를 DOM 요소로 생성하여 추가
    comments.forEach((comment, index) => {
        const commentDiv = document.createElement('div');
        commentDiv.className = 'bg-slate-50 rounded-xl p-4 border border-slate-200';
        commentDiv.setAttribute('data-index', index);
        
        commentDiv.innerHTML = `
            <div class="flex items-start justify-between mb-3">
                <span class="text-xs font-bold text-slate-500">메시지 ${index + 1}</span>
                <button onclick="window.removeMealogComment(${index})" class="px-3 py-2 bg-red-100 text-red-700 rounded-lg text-sm font-bold hover:bg-red-200 transition-colors">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
            <textarea onchange="window.updateMealogComment(${index}, this.value)"
                      class="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500 resize-y min-h-[200px]"
                      placeholder="MEALOG 안내 메시지를 입력하세요"></textarea>
        `;
        
        // textarea의 값을 value 속성으로 직접 설정 (줄바꿈 유지, HTML 이스케이프 불필요)
        const textarea = commentDiv.querySelector('textarea');
        if (textarea && comment) {
            textarea.value = comment; // textarea.value는 줄바꿈을 그대로 유지
        }
        
        container.appendChild(commentDiv);
    });
}

// MEALOG 코멘트 추가
window.addMealogComment = function() {
    const comments = getCurrentMealogComments();
    comments.push('');
    renderMealogComments(comments);
};

// MEALOG 코멘트 제거
window.removeMealogComment = function(index) {
    const comments = getCurrentMealogComments();
    if (comments.length <= 1) {
        alert('최소 한 개의 메시지가 필요합니다.');
        return;
    }
    
    comments.splice(index, 1);
    renderMealogComments(comments);
};

// MEALOG 코멘트 업데이트
window.updateMealogComment = function(index, value) {
    const comments = getCurrentMealogComments();
    if (comments[index] !== undefined) {
        comments[index] = value;
    }
};

// 현재 MEALOG 코멘트 목록 가져오기
function getCurrentMealogComments() {
    const container = document.getElementById('mealogCommentsContainer');
    if (!container) return [];
    
    const comments = [];
    // DOM 순서대로 모든 textarea를 순회하여 순차적으로 배열에 추가
    // 인덱스 기반 할당 대신 push를 사용하여 빈 슬롯 방지
    container.querySelectorAll('[data-index]').forEach(itemEl => {
        const textarea = itemEl.querySelector('textarea');
        if (textarea && textarea.value) {
            // textarea의 값을 그대로 추가 (줄바꿈 포함)
            comments.push(textarea.value);
        }
    });
    
    return comments;
}

// MEALOG 코멘트 저장
window.saveMealogComments = async function() {
    try {
        const comments = getCurrentMealogComments();
        
        // 더 엄격한 필터링: undefined, null, 빈 문자열 모두 제거
        const validComments = comments.filter(c => {
            return c !== null && c !== undefined && typeof c === 'string' && c.trim().length > 0;
        });
        
        if (validComments.length === 0) {
            alert('최소 한 개의 메시지가 필요합니다.');
            return;
        }
        
        const mealogData = {
            comments: validComments,
            updatedAt: new Date().toISOString()
        };
        
        const mealogDocRef = doc(db, 'artifacts', appId, 'persona', 'mealog');
        await setDoc(mealogDocRef, mealogData, { merge: true });
        
        alert('MEALOG 메시지가 저장되었습니다.');
        console.log('MEALOG 메시지 저장 완료:', mealogData);
        console.log('저장된 코멘트 수:', validComments.length);
        console.log('저장된 코멘트 내용:', validComments);
        // 각 코멘트의 전체 내용과 길이를 상세히 로그
        validComments.forEach((comment, idx) => {
            console.log(`코멘트 ${idx + 1}:`, {
                길이: comment.length,
                줄_수: comment.split('\n').length,
                전체_내용: comment,
                COMMENT_버튼_포함: comment.includes('💬') || comment.includes('COMMENT')
            });
        });
    } catch (e) {
        console.error('MEALOG 메시지 저장 실패:', e);
        alert('MEALOG 메시지 저장 중 오류가 발생했습니다: ' + e.message);
    }
};

// 기본 캐릭터 정의 (insight.js와 동일)
const DEFAULT_CHARACTERS = [
    { 
        id: 'trainer', 
        name: '엄격한 트레이너', 
        icon: '💪', 
        image: 'persona/trainer.png',
        persona: '건강과 웰빙을 중시하는 트레이너',
        systemPrompt: '당신은 건강과 웰빙을 중시하는 트레이너입니다. 엄격하지만 따뜻한 톤으로, 식사 패턴을 날카롭게 분석하고 건강한 식습관을 위한 명확한 조언을 제공합니다. 격려와 함께 건설적인 피드백을 주며, 때로는 유머를 섞어 지루하지 않게 전달합니다. 전문적이지만 딱딱하지 않고, 사용자가 행동 변화를 일으킬 수 있도록 동기부여하는 당신만의 스타일을 유지하세요.'
    }
];

// 현재 선택된 캐릭터 ID
let currentEditingCharacterId = null;

// 페르소나 캐릭터 렌더링
async function renderPersonaCharacters() {
    const listContainer = document.getElementById('personaCharactersList');
    if (!listContainer) return;
    
    listContainer.innerHTML = '<div class="text-center py-4 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-xl mb-2"></i><p class="text-xs">로딩 중...</p></div>';
    
    try {
        // 기본 캐릭터 + Firebase 캐릭터 로드
        const charactersDocRef = doc(db, 'artifacts', appId, 'persona', 'characters');
        const charactersSnap = await getDoc(charactersDocRef);
        
        let allCharacters = [...DEFAULT_CHARACTERS];
        
        if (charactersSnap.exists()) {
            const data = charactersSnap.data();
            // Firebase에서 추가된 캐릭터들 추가 (기본 캐릭터와 중복되지 않는 것만, id 순 정렬)
            Object.entries(data)
                .filter(([id]) => !DEFAULT_CHARACTERS.find(c => c.id === id))
                .sort(([a], [b]) => a.localeCompare(b))
                .forEach(([id, charData]) => {
                    allCharacters.push({
                        id,
                        name: charData.name || id,
                        icon: charData.icon || '👤',
                        image: charData.image || null,
                        persona: charData.persona || '',
                        systemPrompt: ''
                    });
                });
        }
        
        // 각 캐릭터의 개별 설정 문서에서 상세 정보 가져오기
        for (const char of allCharacters) {
            try {
                const personaDocRef = doc(db, 'artifacts', appId, 'persona', char.id);
                const personaDoc = await getDoc(personaDocRef);
                if (personaDoc.exists()) {
                    const personaData = personaDoc.data();
                    if (personaData.persona) char.persona = personaData.persona;
                    if (personaData.systemPrompt) char.systemPrompt = personaData.systemPrompt;
                    if (personaData.defaultComments) char.defaultComments = personaData.defaultComments;
                    if (personaData.image) char.image = personaData.image;
                    if (personaData.name) char.name = personaData.name;
                }
            } catch (e) {
                console.error(`캐릭터 ${char.id} 설정 가져오기 실패:`, e);
            }
        }
        
        // '공통' 캐릭터를 맨 앞에 추가
        const commonCharacter = {
            id: 'common',
            name: '공통',
            icon: '🌐',
            image: null,
            persona: '모든 캐릭터에 공통으로 적용되는 페르소나',
            systemPrompt: ''
        };
        
        // 공통 페르소나 로드
        try {
            const commonDocRef = doc(db, 'artifacts', appId, 'persona', 'common');
            const commonDoc = await getDoc(commonDocRef);
            if (commonDoc.exists()) {
                const commonData = commonDoc.data();
                if (commonData.systemPrompt) commonCharacter.systemPrompt = commonData.systemPrompt;
            }
        } catch (e) {
            console.error('공통 페르소나 로드 실패:', e);
        }
        
        // 공통 + 다른 캐릭터들 (순서: 공통 → 기본 → Firebase)
        const allCharactersWithCommon = [commonCharacter, ...allCharacters];
        
        // 캐릭터 목록 렌더링 (세로)
        listContainer.innerHTML = allCharactersWithCommon.map((char, index) => {
            const isCommon = char.id === 'common';
            return `
                <div class="flex items-center gap-3 p-3 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 transition-colors">
                    <button type="button" onclick="window.selectCharacterForEdit('${String(char.id).replace(/'/g, "\\'")}')" 
                            data-character-id="${escapeHtml(char.id)}"
                            class="flex-1 flex items-center gap-3 text-left min-w-0">
                        <span class="text-sm font-bold text-slate-500 w-6">${index + 1}</span>
                        ${char.image ? `
                            <img src="${escapeHtml(char.image)}" alt="${escapeHtml(char.name || '')}" class="w-10 h-10 object-cover rounded-lg flex-shrink-0" onerror="this.style.display='none'">
                        ` : ''}
                        ${!char.image && char.icon ? `
                            <div class="w-10 h-10 rounded-lg bg-slate-200 flex items-center justify-center text-xl flex-shrink-0">${escapeHtml(char.icon)}</div>
                        ` : ''}
                        <span class="text-sm font-bold text-slate-800 truncate">${escapeHtml(char.name || char.id || '')}</span>
                    </button>
                    ${!isCommon ? `
                        <button type="button" onclick="window.deleteCharacter('${String(char.id).replace(/'/g, "\\'")}')" 
                                class="px-3 py-1.5 bg-red-100 text-red-700 rounded-lg text-xs font-bold hover:bg-red-200 transition-colors flex-shrink-0">
                            <i class="fa-solid fa-trash mr-1"></i>삭제
                        </button>
                    ` : ''}
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error("페르소나 캐릭터 렌더링 실패:", e);
        listContainer.innerHTML = '<div class="text-center py-4 text-red-400"><i class="fa-solid fa-exclamation-triangle text-xl mb-2"></i><p class="text-xs">캐릭터를 불러오는 중 오류가 발생했습니다.</p></div>';
    }
}

// 캐릭터 목록 뷰 표시
window.showCharacterListView = function() {
    const listView = document.getElementById('characters-list-view');
    const editView = document.getElementById('character-edit-view');
    if (listView) listView.classList.remove('hidden');
    if (editView) editView.classList.add('hidden');
    currentEditingCharacterId = null;
    renderPersonaCharacters();
};

// 캐릭터 선택 (편집용) - 편집 뷰로 전환
window.selectCharacterForEdit = async function(characterId) {
    currentEditingCharacterId = characterId;
    
    // 목록 뷰 숨기고 편집 뷰 표시
    const listView = document.getElementById('characters-list-view');
    const editView = document.getElementById('character-edit-view');
    if (listView) listView.classList.add('hidden');
    if (editView) editView.classList.remove('hidden');
    
    // 편집 폼 로드
    await loadCharacterEditor(characterId);
};

// 캐릭터 편집 폼 로드
async function loadCharacterEditor(characterId) {
    const editorContent = document.getElementById('personaCharacterEditorContent');
    if (!editorContent) return;
    
    editorContent.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i><p>로딩 중...</p></div>';
    
    try {
        // 공통 캐릭터인지 확인
        if (characterId === 'common') {
            let commonData = {
                id: 'common',
                name: '공통',
                icon: '🌐',
                image: null,
                persona: '모든 캐릭터에 공통으로 적용되는 페르소나',
                systemPrompt: ''
            };
            
            // Firebase에서 공통 페르소나 가져오기
            const commonDocRef = doc(db, 'artifacts', appId, 'persona', 'common');
            const commonDoc = await getDoc(commonDocRef);
            if (commonDoc.exists()) {
                const data = commonDoc.data();
                commonData.systemPrompt = data.systemPrompt || '';
            }
            
            // 공통 페르소나 편집 폼 렌더링
            renderCommonPersonaForm(commonData);
            return;
        }
        
        // 기본 캐릭터인지 확인
        const defaultChar = DEFAULT_CHARACTERS.find(c => c.id === characterId);
        let characterData = defaultChar ? { ...defaultChar } : { id: characterId, name: '', icon: '👤', image: '', persona: '', systemPrompt: '', defaultComments: [] };
        
        // Firebase에서 개별 설정 가져오기
        const personaDocRef = doc(db, 'artifacts', appId, 'persona', characterId);
        const personaDoc = await getDoc(personaDocRef);
        if (personaDoc.exists()) {
            const data = personaDoc.data();
            characterData = { ...characterData, ...data };
        }
        
        // Firebase에서 characters 목록에서도 가져오기 (이름, 아이콘, 이미지)
        const charactersDocRef = doc(db, 'artifacts', appId, 'persona', 'characters');
        const charactersSnap = await getDoc(charactersDocRef);
        if (charactersSnap.exists()) {
            const data = charactersSnap.data();
            if (data[characterId]) {
                characterData.name = data[characterId].name || characterData.name;
                characterData.icon = data[characterId].icon || characterData.icon;
                characterData.image = data[characterId].image || characterData.image;
            }
        }
        
        // 기본 멘트가 없으면 빈 배열로 초기화
        if (!characterData.defaultComments || !Array.isArray(characterData.defaultComments)) {
            characterData.defaultComments = [];
        }
        
        // 로딩 멘트가 없으면 기본값 설정
        if (!characterData.loadingMessage) {
            characterData.loadingMessage = '분석중입니다';
        }
        
        // 편집 폼 렌더링
        renderCharacterEditorForm(characterData);
    } catch (e) {
        console.error('캐릭터 편집 폼 로드 실패:', e);
        editorContent.innerHTML = '<div class="text-center py-8 text-red-400"><i class="fa-solid fa-exclamation-triangle text-2xl mb-2"></i><p>캐릭터 정보를 불러오는 중 오류가 발생했습니다.</p></div>';
    }
}

// 공통 페르소나 편집 폼 렌더링
function renderCommonPersonaForm(commonData) {
    const editorContent = document.getElementById('personaCharacterEditorContent');
    if (!editorContent) return;
    
    editorContent.innerHTML = `
        <div class="space-y-6">
            <div class="bg-blue-50 border border-blue-200 rounded-xl p-4">
                <div class="flex items-start gap-3">
                    <i class="fa-solid fa-info-circle text-blue-600 text-xl mt-0.5"></i>
                    <div>
                        <h3 class="text-sm font-bold text-blue-800 mb-1">공통 페르소나</h3>
                        <p class="text-xs text-blue-700">이 페르소나는 모든 AI 캐릭터의 분석에 공통으로 적용됩니다. 각 캐릭터의 고유한 페르소나와 함께 사용됩니다.</p>
                    </div>
                </div>
            </div>
            
            <!-- 공통 페르소나: 입력 텍스트만큼 창 자동 확장 -->
            <div>
                <label class="block text-sm font-bold text-slate-700 mb-2">
                    <i class="fa-solid fa-robot mr-2"></i>공통 페르소나 (구글 AI 스튜디오에 발송할 프롬프트)
                </label>
                <textarea id="commonSystemPrompt" 
                          class="persona-auto-resize w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500 min-h-[200px] resize-none overflow-hidden"
                          placeholder="모든 캐릭터에 공통으로 적용될 페르소나를 입력하세요. 예: '항상 친근하고 따뜻한 톤으로 대화하며, 사용자의 식사 기록을 긍정적으로 분석합니다.'">${escapeHtml(commonData.systemPrompt || '')}</textarea>
            </div>
        </div>
    `;
    attachPersonaAutoResize();
}

// 캐릭터 편집 폼 렌더링
function renderCharacterEditorForm(characterData) {
    const editorContent = document.getElementById('personaCharacterEditorContent');
    if (!editorContent) return;
    
    editorContent.innerHTML = `
        <div class="space-y-6">
            <!-- 이미지: 좌(미리보기) | 우(선택+경로, 이미지 높이에 맞춤) -->
            <div>
                <label class="block text-sm font-bold text-slate-700 mb-2">
                    <i class="fa-solid fa-image mr-2"></i>캐릭터 이미지 <span class="text-slate-500 font-normal">(75×132)</span>
                </label>
                <div class="flex gap-3 items-stretch">
                    <div id="characterImagePreview" class="relative flex-shrink-0 w-[75px] h-[132px] rounded-xl border border-slate-200 bg-slate-100 flex items-center justify-center overflow-hidden">
                        ${characterData.image ? `
                            <img src="${escapeHtml(characterData.image)}" alt="미리보기" class="w-full h-full object-cover" onerror="this.parentElement.innerHTML='<span class=\\'text-slate-400 text-2xl\\'>👤</span>'">
                            <button type="button" onclick="window.removeCharacterImage()" 
                                    class="absolute top-0.5 right-0.5 px-1.5 py-0.5 bg-red-500 text-white rounded text-xs font-bold hover:bg-red-600">
                                <i class="fa-solid fa-times"></i>
                            </button>
                        ` : '<span class="text-slate-400 text-2xl">👤</span>'}
                    </div>
                    <div class="flex flex-col gap-2 justify-center min-w-0">
                        <input type="file" id="characterImageFile" accept="image/*" 
                               onchange="window.handleCharacterImageUpload(event)"
                               class="hidden">
                        <button type="button" onclick="document.getElementById('characterImageFile').click()" 
                                class="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-bold transition-colors flex items-center justify-center gap-2">
                            <i class="fa-solid fa-upload"></i>
                            <span>이미지 선택</span>
                        </button>
                        <input type="text" id="characterImage" value="${escapeHtml(characterData.image || '')}" 
                               placeholder="또는 이미지 URL 직접 입력"
                               onchange="window.updateCharacterImageFromUrl(this.value)"
                               class="w-full min-w-[160px] px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500">
                    </div>
                </div>
            </div>
            
            <!-- 캐릭터 이름: 타이틀 오른쪽에 입력 -->
            <div class="flex gap-4 items-center">
                <label class="flex-shrink-0 text-sm font-bold text-slate-700 w-28">
                    <i class="fa-solid fa-tag mr-2"></i>캐릭터 이름
                </label>
                <input type="text" id="characterName" value="${escapeHtml(characterData.name || '')}" 
                       placeholder="예: 엄격한 트레이너"
                       class="flex-1 min-w-0 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500">
            </div>
            
            <!-- 기본 멘트: 타이틀 오른쪽에 입력 -->
            <div class="flex gap-4 items-start">
                <label class="flex-shrink-0 text-sm font-bold text-slate-700 w-28 pt-2">
                    <i class="fa-solid fa-comment mr-2"></i>기본 멘트
                </label>
                <div class="flex-1 min-w-0">
                    <p class="text-xs text-slate-500 mb-2">COMMENT 버튼 클릭 시 표시. 여러 개 입력 시 랜덤 표시.</p>
                    <div id="characterDefaultCommentsContainer" class="space-y-3">
                        ${characterData.defaultComments && characterData.defaultComments.length > 0 ? characterData.defaultComments.map((comment, index) => `
                            <div class="flex gap-2 items-start" data-comment-index="${index}">
                                <textarea onchange="window.updateCharacterDefaultComment(${index}, this.value)"
                                          class="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500 resize-y min-h-[80px] overflow-hidden"
                                          placeholder="기본 멘트를 입력하세요">${escapeHtml(comment || '')}</textarea>
                                <button onclick="window.removeCharacterDefaultComment(${index})" class="px-3 py-2 bg-red-100 text-red-700 rounded-lg text-sm font-bold hover:bg-red-200 transition-colors flex-shrink-0">
                                    <i class="fa-solid fa-trash"></i>
                                </button>
                            </div>
                        `).join('') : ''}
                    </div>
                    <button onclick="window.addCharacterDefaultComment()" class="mt-2 px-4 py-2 bg-slate-200 text-slate-700 rounded-lg text-sm font-bold hover:bg-slate-300 transition-colors">
                        <i class="fa-solid fa-plus mr-2"></i>멘트 추가
                    </button>
                </div>
            </div>
            
            <!-- 로딩 멘트: 타이틀 오른쪽에 입력 -->
            <div class="flex gap-4 items-start">
                <label class="flex-shrink-0 text-sm font-bold text-slate-700 w-28 pt-2">
                    <i class="fa-solid fa-spinner mr-2"></i>로딩 멘트
                </label>
                <div class="flex-1 min-w-0">
                    <p class="text-xs text-slate-500 mb-2">AI 코멘트 생성 중 표시 (일반 텍스트)</p>
                    <textarea id="characterLoadingMessage" 
                              class="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500 resize-y min-h-[80px] overflow-hidden"
                              placeholder="예: 분석중입니다">${escapeHtml(characterData.loadingMessage || '')}</textarea>
                </div>
            </div>

            <div class="border-t border-slate-200 pt-4 space-y-4">
                <div class="flex gap-4 items-start">
                    <label class="flex-shrink-0 text-sm font-bold text-slate-700 w-28 pt-2">기간 경과 부족 시</label>
                    <div class="flex-1 min-w-0">
                        <p class="text-xs text-slate-500 mb-1">표시 조건: 주간 4일 미만, 월간 10일 미만, 연간 3월 미만, 직접설정 50% 미만 경과 시</p>
                        <p class="text-xs text-emerald-700 mb-2">분석 가능 시점: 주간 4일 경과 후 · 월간 10일 경과 후 · 연간 4월 1일 이후 · 직접설정은 선택 기간의 50% 이상 경과 후</p>
                        <textarea id="characterInsightMessageInsufficientPeriod" rows="2"
                                  class="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500 resize-y min-h-[80px] overflow-hidden"
                                  placeholder="아직 이 기간이 충분히 경과하지 않았어요. 조금 더 지나면 더 의미 있는 코멘트를 드릴 수 있어요.">${escapeHtml(characterData.insightMessageInsufficientPeriod || '')}</textarea>
                    </div>
                </div>
                <div class="flex gap-4 items-start">
                    <label class="flex-shrink-0 text-sm font-bold text-slate-700 w-28 pt-2">기록 부족 시</label>
                    <div class="flex-1 min-w-0">
                        <p class="text-xs text-slate-500 mb-1">표시 조건: 경과한 일수 × 3(아침/점심/저녁) 대비 본식 기록이 50% 미만일 때</p>
                        <p class="text-xs text-emerald-700 mb-2">분석 가능 시점: 경과 일수의 본식 슬롯 수의 50% 이상 기록 시 (예: 7일 경과 시 11회 이상, 10일 경과 시 15회 이상)</p>
                        <textarea id="characterInsightMessageInsufficientRecords" rows="2"
                                  class="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500 resize-y min-h-[80px] overflow-hidden"
                                  placeholder="이 기간의 식사 기록이 아직 충분하지 않아요. 조금 더 기록해 보시면 더 재미있는 코멘트를 드릴 수 있어요.">${escapeHtml(characterData.insightMessageInsufficientRecords || '')}</textarea>
                    </div>
                </div>
            </div>
            
            <!-- 페르소나: 입력 텍스트만큼 창 자동 확장 -->
            <div>
                <label class="block text-sm font-bold text-slate-700 mb-2">
                    <i class="fa-solid fa-robot mr-2"></i>페르소나 (구글 AI 스튜디오에 발송할 프롬프트)
                </label>
                <textarea id="characterSystemPrompt" 
                          class="persona-auto-resize w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500 min-h-[200px] resize-none overflow-hidden"
                          placeholder="캐릭터의 성격, 말투, 분석 스타일 등을 정의하는 프롬프트를 입력하세요">${escapeHtml(characterData.systemPrompt || '')}</textarea>
            </div>
        </div>
    `;
    attachPersonaAutoResize();
}

// 페르소나 입력창: 입력 텍스트만큼 자동 확장 (스크롤 없음)
function attachPersonaAutoResize() {
    const resize = (ta) => {
        ta.style.height = 'auto';
        ta.style.height = Math.max(200, ta.scrollHeight) + 'px';
    };
    document.querySelectorAll('.persona-auto-resize').forEach(ta => {
        resize(ta);
        ta.addEventListener('input', () => resize(ta));
    });
}

// 기본 멘트 추가
window.addCharacterDefaultComment = function() {
    const container = document.getElementById('characterDefaultCommentsContainer');
    if (!container) return;
    
    const index = container.children.length;
    const newCommentDiv = document.createElement('div');
    newCommentDiv.className = 'flex gap-2 items-start';
    newCommentDiv.setAttribute('data-comment-index', index);
    newCommentDiv.innerHTML = `
        <textarea onchange="window.updateCharacterDefaultComment(${index}, this.value)"
                  class="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500 resize-y min-h-[80px] overflow-hidden"
                  placeholder="기본 멘트를 입력하세요"></textarea>
        <button onclick="window.removeCharacterDefaultComment(${index})" class="px-3 py-2 bg-red-100 text-red-700 rounded-lg text-sm font-bold hover:bg-red-200 transition-colors flex-shrink-0">
            <i class="fa-solid fa-trash"></i>
        </button>
    `;
    container.appendChild(newCommentDiv);
};

// 기본 멘트 제거
window.removeCharacterDefaultComment = function(index) {
    const container = document.getElementById('characterDefaultCommentsContainer');
    if (!container) return;
    
    const commentDiv = container.querySelector(`[data-comment-index="${index}"]`);
    if (commentDiv) {
        commentDiv.remove();
        // 인덱스 재정렬
        Array.from(container.children).forEach((child, idx) => {
            child.setAttribute('data-comment-index', idx);
            const textarea = child.querySelector('textarea');
            const button = child.querySelector('button');
            if (textarea) {
                textarea.setAttribute('onchange', `window.updateCharacterDefaultComment(${idx}, this.value)`);
            }
            if (button) {
                button.setAttribute('onclick', `window.removeCharacterDefaultComment(${idx})`);
            }
        });
    }
};

// 기본 멘트 업데이트
window.updateCharacterDefaultComment = function(index, value) {
    // 실시간 업데이트는 렌더링 시 자동으로 반영됨
};

// 캐릭터 이미지 업로드 핸들러
window.handleCharacterImageUpload = async function(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    // 파일 타입 확인
    if (!file.type.startsWith('image/')) {
        alert('이미지 파일만 업로드할 수 있습니다.');
        return;
    }
    
    // 파일 크기 확인 (10MB 제한)
    if (file.size > 10 * 1024 * 1024) {
        alert('파일 크기는 10MB 이하여야 합니다.');
        return;
    }
    
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    
    try {
        // 현재 사용자 ID 가져오기 (관리자)
        const user = adminAuth.currentUser;
        if (!user) {
            alert('로그인이 필요합니다.');
            return;
        }
        
        // Firebase Storage에 업로드 (PNG 투명 배경 보존)
        const imageUrl = await uploadPersonaImageToStorage(file, user.uid, currentEditingCharacterId || 'temp');
        
        // 이미지 URL 필드에 설정
        const imageInput = document.getElementById('characterImage');
        if (imageInput) {
            imageInput.value = imageUrl;
        }
        
        // 미리보기 업데이트
        updateCharacterImagePreview(imageUrl);
        
        // 파일 입력 초기화
        event.target.value = '';
        
    } catch (e) {
        console.error('이미지 업로드 실패:', e);
        alert('이미지 업로드 중 오류가 발생했습니다: ' + e.message);
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
};

// 캐릭터 이미지 미리보기 업데이트
function updateCharacterImagePreview(imageUrl) {
    const previewContainer = document.getElementById('characterImagePreview');
    if (!previewContainer) return;
    
    if (imageUrl) {
        previewContainer.innerHTML = `
            <img src="${escapeHtml(imageUrl)}" alt="미리보기" class="w-full h-full object-cover" onerror="this.parentElement.innerHTML='<span class=\\'text-slate-400 text-2xl\\'>👤</span>'">
            <button type="button" onclick="window.removeCharacterImage()" 
                    class="absolute top-0.5 right-0.5 px-1.5 py-0.5 bg-red-500 text-white rounded text-xs font-bold hover:bg-red-600">
                <i class="fa-solid fa-times"></i>
            </button>
        `;
    } else {
        previewContainer.innerHTML = '<span class="text-slate-400 text-2xl">👤</span>';
    }
}

// 캐릭터 이미지 제거
window.removeCharacterImage = function() {
    const imageInput = document.getElementById('characterImage');
    if (imageInput) {
        imageInput.value = '';
    }
    updateCharacterImagePreview('');
};

// URL 입력으로 이미지 미리보기 업데이트
window.updateCharacterImageFromUrl = function(imageUrl) {
    updateCharacterImagePreview(imageUrl || '');
};

// 새 캐릭터 추가
window.addNewCharacter = function() {
    const newId = 'character_' + Date.now();
    currentEditingCharacterId = newId;
    
    // 편집 뷰로 전환
    const listView = document.getElementById('characters-list-view');
    const editView = document.getElementById('character-edit-view');
    if (listView) listView.classList.add('hidden');
    if (editView) editView.classList.remove('hidden');
    
    // 편집 폼 로드
    loadCharacterEditor(newId);
};

// 캐릭터 삭제
window.deleteCharacter = async function(characterId) {
    // 공통 캐릭터는 삭제 불가
    if (characterId === 'common') {
        alert('공통 페르소나는 삭제할 수 없습니다.');
        return;
    }
    
    if (!confirm('정말 이 캐릭터를 삭제하시겠습니까?')) return;
    
    try {
        // characters 목록에서 삭제
        const charactersDocRef = doc(db, 'artifacts', appId, 'persona', 'characters');
        const charactersSnap = await getDoc(charactersDocRef);
        if (charactersSnap.exists()) {
            const data = charactersSnap.data();
            delete data[characterId];
            await setDoc(charactersDocRef, data, { merge: true });
        }
        
        // 개별 설정 문서 삭제
        const personaDocRef = doc(db, 'artifacts', appId, 'persona', characterId);
        await deleteDoc(personaDocRef);
        
        // 현재 선택된 캐릭터가 삭제된 경우 목록 뷰로 전환
        if (currentEditingCharacterId === characterId) {
            currentEditingCharacterId = null;
            showCharacterListView();
        }
        
        // 목록 새로고침
        await renderPersonaCharacters();
        
        alert('캐릭터가 삭제되었습니다.');
    } catch (e) {
        console.error('캐릭터 삭제 실패:', e);
        alert('캐릭터 삭제 중 오류가 발생했습니다: ' + e.message);
    }
};

// 캐릭터 저장
window.saveCharacter = async function() {
    if (!currentEditingCharacterId) {
        alert('저장할 캐릭터를 선택해주세요.');
        return;
    }
    
    try {
        // 공통 페르소나 저장
        if (currentEditingCharacterId === 'common') {
            const commonSystemPromptInput = document.getElementById('commonSystemPrompt');
            if (!commonSystemPromptInput) {
                alert('폼을 불러오는 중입니다. 잠시 후 다시 시도해주세요.');
                return;
            }
            const commonDocRef = doc(db, 'artifacts', appId, 'persona', 'common');
            await setDoc(commonDocRef, {
                systemPrompt: commonSystemPromptInput.value.trim(),
                updatedAt: new Date().toISOString()
            }, { merge: true });
            
            alert('공통 페르소나가 저장되었습니다.');
            
            // 목록 새로고침
            await renderPersonaCharacters();
            return;
        }
        
        const imageInput = document.getElementById('characterImage');
        const nameInput = document.getElementById('characterName');
        const systemPromptInput = document.getElementById('characterSystemPrompt');
        const loadingMessageInput = document.getElementById('characterLoadingMessage');
        const insightPeriodEl = document.getElementById('characterInsightMessageInsufficientPeriod');
        const insightRecordsEl = document.getElementById('characterInsightMessageInsufficientRecords');
        const commentsContainer = document.getElementById('characterDefaultCommentsContainer');
        
        if (!imageInput || !nameInput || !systemPromptInput) {
            alert('폼을 불러오는 중입니다. 잠시 후 다시 시도해주세요.');
            return;
        }
        
        const image = imageInput.value.trim();
        const name = nameInput.value.trim();
        const systemPrompt = systemPromptInput.value.trim();
        const loadingMessage = loadingMessageInput ? loadingMessageInput.value.trim() : '';
        
        if (!name) {
            alert('캐릭터 이름을 입력해주세요.');
            return;
        }
        
        // 기본 멘트 수집
        const defaultComments = [];
        if (commentsContainer) {
            commentsContainer.querySelectorAll('textarea').forEach(textarea => {
                const value = textarea.value.trim();
                if (value) {
                    defaultComments.push(value);
                }
            });
        }
        
        // characters 목록에 저장 (기본 캐릭터가 아닌 경우만)
        const isDefaultCharacter = DEFAULT_CHARACTERS.find(c => c.id === currentEditingCharacterId);
        if (!isDefaultCharacter) {
            const charactersDocRef = doc(db, 'artifacts', appId, 'persona', 'characters');
            const charactersSnap = await getDoc(charactersDocRef);
            const charactersData = charactersSnap.exists() ? charactersSnap.data() : {};
            
            charactersData[currentEditingCharacterId] = {
                name: name,
                icon: '👤', // 기본값
                image: image || null
            };
            
            await setDoc(charactersDocRef, charactersData, { merge: true });
        }
        
        // 개별 설정 문서에 저장
        const personaDocRef = doc(db, 'artifacts', appId, 'persona', currentEditingCharacterId);
        await setDoc(personaDocRef, {
            persona: name, // 간단한 설명으로 이름 사용
            systemPrompt: systemPrompt,
            defaultComments: defaultComments,
            loadingMessage: loadingMessage || '분석중입니다', // 기본값
            insightMessageInsufficientPeriod: (insightPeriodEl && insightPeriodEl.value) ? insightPeriodEl.value.trim() : '',
            insightMessageInsufficientRecords: (insightRecordsEl && insightRecordsEl.value) ? insightRecordsEl.value.trim() : '',
            image: image || null,
            name: name,
            updatedAt: new Date().toISOString()
        }, { merge: true });
        
        alert('캐릭터가 저장되었습니다.');
        
        // 목록 새로고침
        await renderPersonaCharacters();
    } catch (e) {
        console.error('캐릭터 저장 실패:', e);
        alert('캐릭터 저장 중 오류가 발생했습니다: ' + e.message);
    }
};

// 페르소나 설정 렌더링 (초기화)
async function renderPersonaSettings() {
    // 페르소나 설정은 더 이상 사용하지 않음
    // 콘텐츠 관리 탭으로 리다이렉트
    window.switchAdminTab('content');
    setTimeout(() => {
        window.switchContentSidebar('mealog');
    }, 100);
}

// 페르소나 새로고침 (콘텐츠 관리로 이동)
window.refreshPersona = function() {
    const activeSection = document.querySelector('.content-main-section:not(.hidden)');
    if (activeSection) {
        const sectionId = activeSection.id.replace('content-main-', '');
        if (sectionId === 'mealog' || sectionId === 'characters') {
            switchContentSidebar(sectionId);
        }
    } else {
        switchContentSidebar('mealog');
    }
}

// 식당정보 필터 상태 (모니터링 > 식당정보)
let currentRestaurantFilter = 'all'; // 'all', 'kakao', 'manual'
let currentRestaurantSlotFilter = 'all'; // 'all', 'meal', 'snack'

const MEAL_SLOTS = ['morning', 'lunch', 'dinner'];
const SNACK_SLOTS = ['pre_morning', 'snack1', 'snack2', 'night'];

/** mealDoc.data() 형태의 객체를 restaurantMap에 반영 (slotFilter 적용) */
function applyMealToRestaurantMap(restaurantMap, mealData, slotFilter) {
    const place = mealData.place;
    const slotId = mealData.slotId || '';
    if (slotFilter === 'meal' && !MEAL_SLOTS.includes(slotId)) return;
    if (slotFilter === 'snack' && !SNACK_SLOTS.includes(slotId)) return;
    if (!place || place.trim() === '') return;

    const placeKey = place.trim();
    const hasPlaceId = !!(mealData.placeId || mealData.kakaoPlaceId);
    const hasPlaceData = !!mealData.placeData;
    const hasKakaoPlace = mealData.kakaoPlace === true || mealData.kakaoPlace === 'true';
    const isKakao = hasPlaceId || hasPlaceData || hasKakaoPlace;
    const placeId = mealData.placeId || mealData.kakaoPlaceId || null;
    const address = mealData.placeAddress || mealData.address || null;

    if (!restaurantMap.has(placeKey)) {
        restaurantMap.set(placeKey, {
            name: placeKey,
            count: 0,
            firstSeen: mealData.date || null,
            lastSeen: mealData.date || null,
            isKakao: isKakao,
            placeId: placeId,
            address: address,
            kakaoCount: 0,
            manualCount: 0
        });
    }
    const restaurant = restaurantMap.get(placeKey);
    restaurant.count++;
    if (isKakao) {
        restaurant.isKakao = true;
        restaurant.kakaoCount++;
        if (placeId && !restaurant.placeId) restaurant.placeId = placeId;
        if (address && !restaurant.address) restaurant.address = address;
    } else {
        restaurant.manualCount++;
    }
    if (mealData.date) {
        if (!restaurant.firstSeen || mealData.date < restaurant.firstSeen) restaurant.firstSeen = mealData.date;
        if (!restaurant.lastSeen || mealData.date > restaurant.lastSeen) restaurant.lastSeen = mealData.date;
    }
}

/** 당일 meals만 collectionGroup으로 조회 (읽기 최소화용). 현재 appId 경로만 사용 */
async function getTodayMealsForRestaurants() {
    const todayStr = getTodayDateString();
    const mealsGroup = collectionGroup(db, 'meals');
    const q = query(mealsGroup, where('date', '==', todayStr));
    const snap = await getDocs(q);
    const prefix = `artifacts/${appId}/`;
    return snap.docs.filter(d => d.ref.path.startsWith(prefix)).map(d => d.data());
}

/** 캐시용 배열 → Map (병합용) */
function restaurantArrayToMap(arr) {
    const map = new Map();
    (arr || []).forEach(r => map.set(r.name, { ...r }));
    return map;
}

/** 전체 사용자 × 전체 meals 조회 후 restaurant Map 반환 (새로고침 시에만 사용) */
async function fetchAllRestaurantsFull(slotFilter) {
    const usersColl = collection(db, 'artifacts', appId, 'users');
    const usersSnapshot = await getDocs(usersColl);
    const restaurantMap = new Map();
    for (const userDoc of usersSnapshot.docs) {
        try {
            const mealsColl = collection(db, 'artifacts', appId, 'users', userDoc.id, 'meals');
            const mealsSnapshot = await getDocs(mealsColl);
            mealsSnapshot.docs.forEach(mealDoc => applyMealToRestaurantMap(restaurantMap, mealDoc.data(), slotFilter));
        } catch (e) {
            console.warn(`사용자 ${userDoc.id} meals 조회 실패:`, e);
        }
    }
    return restaurantMap;
}

// 식당정보 데이터 렌더링 (전일까지 캐시 + 당일만 병합, 새로고침 시에만 전체 조회)
window.renderRestaurantData = async function(filter = 'all', slotFilter = 'all') {
    const container = document.getElementById('restaurantsContainer');
    if (!container) return;

    currentRestaurantFilter = filter;
    if (slotFilter === undefined) slotFilter = currentRestaurantSlotFilter;

    container.innerHTML = `
        <div class="text-center py-8 text-slate-400">
            <i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i>
            <p>로딩 중...</p>
        </div>
    `;

    try {
        const todayStr = getTodayDateString();
        const cacheSnap = await getDoc(RESTAURANT_STATS_REF());
        let restaurantMap;

        if (slotFilter === 'all' && cacheSnap.exists() && cacheSnap.data().asOfDate && cacheSnap.data().restaurants) {
            const data = cacheSnap.data();
            const asOfDate = data.asOfDate;
            const cachedList = data.restaurants || [];

            if (asOfDate === todayStr) {
                // 캐시가 오늘 기준이면 캐시만 사용 (읽기 1회)
                restaurantMap = restaurantArrayToMap(cachedList);
            } else {
                // 전일까지 캐시 + 당일 meals만 조회 후 병합
                restaurantMap = restaurantArrayToMap(cachedList);
                const todayMeals = await getTodayMealsForRestaurants();
                todayMeals.forEach(mealData => applyMealToRestaurantMap(restaurantMap, mealData, 'all'));
                const mergedList = Array.from(restaurantMap.values());
                await setDoc(RESTAURANT_STATS_REF(), { asOfDate: todayStr, restaurants: mergedList }, { merge: true });
            }
        } else if (slotFilter === 'all') {
            // 캐시 없음(전체) → 전체 조회 후 캐시 저장
            restaurantMap = await fetchAllRestaurantsFull('all');
            const list = Array.from(restaurantMap.values());
            await setDoc(RESTAURANT_STATS_REF(), { asOfDate: todayStr, restaurants: list }, { merge: true });
        } else {
            // 끼니 필터(식사만/간식만)는 캐시에 끼니별 집계가 없으므로 전체 조회
            restaurantMap = await fetchAllRestaurantsFull(slotFilter);
        }

        let restaurants = Array.from(restaurantMap.values());
        
        // 디버깅: 필터 전 통계
        const totalCount = restaurants.length;
        const kakaoCount = restaurants.filter(r => r.isKakao).length;
        const manualCount = restaurants.filter(r => !r.isKakao).length;
        console.log('📊 식당 통계:', {
            total: totalCount,
            kakao: kakaoCount,
            manual: manualCount,
            filter: filter,
            kakaoRestaurants: restaurants.filter(r => r.isKakao).slice(0, 5).map(r => ({ name: r.name, placeId: r.placeId, address: r.address }))
        });
        
        // 카카오맵 식당이 없는데 필터가 'kakao'인 경우 경고
        if (filter === 'kakao' && kakaoCount === 0 && totalCount > 0) {
            console.warn('⚠️ 카카오맵 필터가 선택되었지만 카카오맵 식당이 없습니다.');
            console.warn('   - 기존 데이터에 카카오맵 정보(placeId, kakaoPlaceId 등)가 저장되지 않았을 수 있습니다.');
            console.warn('   - 새로 입력하는 식당은 카카오맵 정보가 저장됩니다.');
        }
        
        // 필터 적용
        if (filter === 'kakao') {
            restaurants = restaurants.filter(r => r.isKakao);
            console.log('카카오맵 필터 적용 후:', restaurants.length, '개');
        } else if (filter === 'manual') {
            restaurants = restaurants.filter(r => !r.isKakao);
            console.log('수동입력 필터 적용 후:', restaurants.length, '개');
        }
        
        // 정렬 (입력 횟수 내림차순)
        restaurants.sort((a, b) => b.count - a.count);
        
        const slotLabel = slotFilter === 'all' ? '' : slotFilter === 'meal' ? ' (식사만)' : ' (간식만)';
        if (restaurants.length === 0) {
            const filterMsg = filter === 'all' ? '등록된 식당 정보가 없습니다.' : filter === 'kakao' ? '카카오맵으로 입력된 식당이 없습니다.' : '수동으로 입력된 식당이 없습니다.';
            container.innerHTML = `
                <div class="text-center py-12 text-slate-400">
                    <i class="fa-solid fa-utensils text-4xl mb-4"></i>
                    <p class="text-sm font-bold">${filterMsg}${slotLabel}</p>
                </div>
            `;
            return;
        }
        
        // 테이블 형태로 표시
        container.innerHTML = `
            <div class="overflow-x-auto">
                <table class="w-full">
                    <thead class="bg-slate-50 border-b border-slate-200">
                        <tr>
                            <th class="px-4 py-3 text-left text-xs font-bold text-slate-600 uppercase">순위</th>
                            <th class="px-4 py-3 text-left text-xs font-bold text-slate-600 uppercase">식당명</th>
                            <th class="px-4 py-3 text-left text-xs font-bold text-slate-600 uppercase">입력 횟수</th>
                            <th class="px-4 py-3 text-left text-xs font-bold text-slate-600 uppercase">입력 방식</th>
                            <th class="px-4 py-3 text-left text-xs font-bold text-slate-600 uppercase">최초 입력</th>
                            <th class="px-4 py-3 text-left text-xs font-bold text-slate-600 uppercase">최근 입력</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-slate-100">
                        ${restaurants.map((restaurant, index) => {
                            const inputTypeBadge = restaurant.isKakao 
                                ? `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-100 text-blue-700">
                                    <i class="fa-solid fa-map-marker-alt mr-1"></i>카카오맵
                                   </span>`
                                : `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-700">
                                    <i class="fa-solid fa-keyboard mr-1"></i>수동입력
                                   </span>`;
                            
                            const countDetail = restaurant.isKakao && restaurant.manualCount > 0
                                ? `<div class="text-xs text-slate-500 mt-1">카카오: ${restaurant.kakaoCount}회, 수동: ${restaurant.manualCount}회</div>`
                                : '';
                            
                            return `
                            <tr class="hover:bg-slate-50 transition-colors">
                                <td class="px-4 py-3 text-sm font-bold text-slate-700">${index + 1}</td>
                                <td class="px-4 py-3 text-sm text-slate-800">
                                    <div class="font-bold">${escapeHtml(restaurant.name)}</div>
                                    ${restaurant.address ? `<div class="text-xs text-slate-500 mt-1">${escapeHtml(restaurant.address)}</div>` : ''}
                                </td>
                                <td class="px-4 py-3 text-sm">
                                    <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700">
                                        ${restaurant.count}회
                                    </span>
                                    ${countDetail}
                                </td>
                                <td class="px-4 py-3 text-sm">${inputTypeBadge}</td>
                                <td class="px-4 py-3 text-sm text-slate-600">${restaurant.firstSeen || '-'}</td>
                                <td class="px-4 py-3 text-sm text-slate-600">${restaurant.lastSeen || '-'}</td>
                            </tr>
                        `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
            <div class="mt-4 text-sm text-slate-500 text-center">
                총 ${restaurants.length}개의 식당이 ${filter === 'all' ? '등록' : filter === 'kakao' ? '카카오맵으로 입력' : '수동으로 입력'}되어 있습니다.
                ${slotLabel}
            </div>
        `;
        
    } catch (e) {
        console.error('식당정보 조회 실패:', e);
        container.innerHTML = `
            <div class="text-center py-8 text-red-400">
                <i class="fa-solid fa-circle-exclamation text-2xl mb-2"></i>
                <p>데이터를 불러오는 중 오류가 발생했습니다.</p>
                <p class="text-xs mt-2">${e.message}</p>
            </div>
        `;
    }
};

// 식당정보 필터 설정 (입력 방식: 전체/카카오맵/수동입력)
window.setRestaurantFilter = function(filter) {
    document.querySelectorAll('.restaurant-filter-btn').forEach(btn => {
        btn.classList.remove('bg-emerald-600', 'text-white');
        btn.classList.add('bg-slate-100', 'text-slate-600', 'hover:bg-slate-200');
    });
    const activeFilterBtn = document.getElementById(`restaurant-filter-${filter}`);
    if (activeFilterBtn) {
        activeFilterBtn.classList.remove('bg-slate-100', 'text-slate-600', 'hover:bg-slate-200');
        activeFilterBtn.classList.add('bg-emerald-600', 'text-white');
    }
    renderRestaurantData(filter, currentRestaurantSlotFilter);
};

// 식당정보 끼니 구분 필터 설정 (전체/식사/간식)
window.setRestaurantSlotFilter = function(slotFilter) {
    currentRestaurantSlotFilter = slotFilter;
    document.querySelectorAll('.restaurant-slot-filter-btn').forEach(btn => {
        btn.classList.remove('bg-emerald-600', 'text-white');
        btn.classList.add('bg-slate-100', 'text-slate-600', 'hover:bg-slate-200');
    });
    const activeBtn = document.getElementById(`restaurant-slot-filter-${slotFilter}`);
    if (activeBtn) {
        activeBtn.classList.remove('bg-slate-100', 'text-slate-600', 'hover:bg-slate-200');
        activeBtn.classList.add('bg-emerald-600', 'text-white');
    }
    renderRestaurantData(currentRestaurantFilter, slotFilter);
};

// 식당정보 새로고침: 전체 조회 후 캐시 저장 (전일까지 숫자 갱신)
window.refreshRestaurantData = async function() {
    const container = document.getElementById('restaurantsContainer');
    if (!container) return;
    container.innerHTML = `
        <div class="text-center py-8 text-slate-400">
            <i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i>
            <p>전체 집계 중...</p>
        </div>
    `;
    try {
        const slotFilter = currentRestaurantSlotFilter;
        const restaurantMap = await fetchAllRestaurantsFull(slotFilter === 'all' ? 'all' : slotFilter);
        if (slotFilter === 'all') {
            const list = Array.from(restaurantMap.values());
            await setDoc(RESTAURANT_STATS_REF(), { asOfDate: getTodayDateString(), restaurants: list }, { merge: true });
        }
        await renderRestaurantData(currentRestaurantFilter, currentRestaurantSlotFilter);
    } catch (e) {
        console.error('식당정보 새로고침 실패:', e);
        container.innerHTML = `<div class="text-center py-8 text-red-400"><p>새로고침 중 오류가 발생했습니다.</p></div>`;
    }
};

