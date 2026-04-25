// ADMIN 사용자 관리 관련 함수들
import { app, db, appId, functions, auth, callableFunctions } from '../firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js';
import { collection, getDocs, getDocsFromServer, query, orderBy, limit, startAfter, doc, getDoc, getDocFromServer, setDoc, where, addDoc, serverTimestamp, getCountFromServer, documentId } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { getCurrentTermsVersion } from '../utils-terms.js';
import { escapeHtml, runAdminRefreshAction } from './utils.js';

// 사용자 테이블 정렬 상태/캐시
let usersCache = null; // 서버 페이지 모드일 때만: 현재 페이지 원본
/** 정렬·페이지 슬라이스용 전체 목록(한 번 로드 후 메모리 유지). null이면 서버 페이지네이션만 사용 */
let usersFullListRaw = null;
let usersSortState = { key: 'createdAt', dir: 'desc' };

const USERS_SORT_DEFAULT_DIR = {
    deleteRequested: 'desc',
    pageFetchIndex: 'asc',
    birthdate: 'asc',
    gender: 'asc',
    signupToLastLoginDays: 'desc',
    activityBan: 'desc',
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

const USERS_PER_PAGE = 50;
const ADMIN_USERS_SEARCH_DEBOUNCE_MS = 280;

/** 닉네임·이메일·UID 부분 일치 검색(소문자) */
let adminUsersSearchQuery = '';
let adminUsersSearchHandlersBound = false;
let adminUsersSearchDebounceTimer = null;

/** Firestore `in` 쿼리 최대 30 — 페이지 사용자에 해당하는 문서만 조회 */
async function fetchUserBansMap(userBansColl, userIds) {
    const map = new Map();
    for (let i = 0; i < userIds.length; i += 30) {
        const chunk = userIds.slice(i, i + 30);
        if (!chunk.length) continue;
        const q = query(userBansColl, where(documentId(), 'in', chunk));
        const snap = await getDocs(q);
        snap.docs.forEach((d) => {
            const data = d.data();
            map.set(d.id, { bannedShare: data.bannedShare === true, bannedWrite: data.bannedWrite === true });
        });
    }
    return map;
}

async function fetchDeleteRequestedUserIdsForPage(deleteRequestsColl, userIds) {
    const pageSet = new Set(userIds);
    const out = new Set();
    for (let i = 0; i < userIds.length; i += 30) {
        const chunk = userIds.slice(i, i + 30);
        if (!chunk.length) continue;
        const q = query(deleteRequestsColl, where('userId', 'in', chunk));
        const snap = await getDocs(q);
        snap.docs.forEach((d) => {
            const uid = d.data().userId;
            if (uid && pageSet.has(uid)) out.add(uid);
        });
    }
    return out;
}

// 페이지별 커서 저장 (이전/다음 페이지 이동용)
let adminUsersLastDocsByPage = {};
let adminUsersTotalCount = 0;
let adminUsersCurrentPage = 1;
let adminUsersListPage = 1;
/** 새로고침으로 목록을 한 번 불러온 뒤에만 페이지·정렬·재조회가 동작 */
let adminUsersDataLoaded = false;

function normalizeString(v) {
    return (v === undefined || v === null) ? '' : String(v);
}

function adminUserMatchesSearch(user, needleLower) {
    if (!needleLower) return true;
    const nick = normalizeString(user?.nickname).toLowerCase();
    const email = normalizeString(user?.email).toLowerCase();
    const uid = normalizeString(user?.userId).toLowerCase();
    return nick.includes(needleLower) || email.includes(needleLower) || uid.includes(needleLower);
}

function updateAdminUsersSearchHint(needleLower) {
    const hint = document.getElementById('adminUsersSearchCountHint');
    if (!hint) return;
    if (!needleLower) {
        hint.textContent = '';
        hint.classList.add('hidden');
        return;
    }
    const total =
        usersFullListRaw !== null && Array.isArray(usersFullListRaw)
            ? usersFullListRaw.length
            : adminUsersTotalCount;
    if (!total || total <= 0) {
        hint.textContent = '';
        hint.classList.add('hidden');
        return;
    }
    hint.textContent = ` (전체 ${Number(total).toLocaleString('ko-KR')}명 중)`;
    hint.classList.remove('hidden');
}

function ensureAdminUsersSearchHandlers() {
    if (adminUsersSearchHandlersBound) return;
    const inp = document.getElementById('adminUsersSearchInput');
    const clr = document.getElementById('adminUsersSearchClearBtn');
    if (!inp) return;
    adminUsersSearchHandlersBound = true;

    const runSearchRender = () => {
        const q = (inp.value || '').trim();
        adminUsersSearchQuery = q;
        adminUsersListPage = 1;
        if (clr) clr.classList.toggle('hidden', !q);
        if (!adminUsersDataLoaded) return;
        if (usersFullListRaw !== null && Array.isArray(usersFullListRaw)) {
            void renderUsers({ lightRender: true });
        } else {
            void renderUsers();
        }
    };

    inp.addEventListener('input', () => {
        clearTimeout(adminUsersSearchDebounceTimer);
        adminUsersSearchDebounceTimer = setTimeout(() => {
            adminUsersSearchDebounceTimer = null;
            runSearchRender();
        }, ADMIN_USERS_SEARCH_DEBOUNCE_MS);
    });
    inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        clearTimeout(adminUsersSearchDebounceTimer);
        adminUsersSearchDebounceTimer = null;
        runSearchRender();
    });
    if (clr) {
        clr.addEventListener('click', () => {
            inp.value = '';
            adminUsersSearchQuery = '';
            clr.classList.add('hidden');
            updateAdminUsersSearchHint('');
            adminUsersListPage = 1;
            if (!adminUsersDataLoaded) return;
            if (usersFullListRaw !== null && Array.isArray(usersFullListRaw)) {
                void renderUsers({ lightRender: true });
            } else {
                void renderUsers();
            }
        });
    }
}

function normalizeNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/** settings / 루트 문서에서 날짜 필드 파싱 (Timestamp·ISO 문자열) */
function parseSettingsDate(v) {
    if (v == null || v === '') return null;
    if (typeof v?.toDate === 'function') return v.toDate();
    if (v instanceof Date) return v;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** users 루트 createdAt — Timestamp·Date·ISO·seconds 객체·ms 숫자 등 안전 파싱 (깨진 값은 null) */
function parseRootTimestampField(raw) {
    if (raw == null || raw === '') return null;
    try {
        if (typeof raw.toDate === 'function') {
            const d = raw.toDate();
            return d != null && !Number.isNaN(d.getTime()) ? d : null;
        }
        if (raw instanceof Date) {
            return !Number.isNaN(raw.getTime()) ? raw : null;
        }
        if (typeof raw === 'number' && Number.isFinite(raw)) {
            const d = new Date(raw);
            return !Number.isNaN(d.getTime()) ? d : null;
        }
        if (typeof raw === 'object' && raw !== null) {
            const secRaw = raw.seconds ?? raw._seconds;
            const nanRaw = raw.nanoseconds ?? raw._nanoseconds ?? 0;
            const sec =
                typeof secRaw === 'number' && Number.isFinite(secRaw)
                    ? secRaw
                    : secRaw != null && secRaw !== ''
                      ? Number(secRaw)
                      : NaN;
            const nan =
                typeof nanRaw === 'number' && Number.isFinite(nanRaw)
                    ? nanRaw
                    : nanRaw != null && nanRaw !== ''
                      ? Number(nanRaw)
                      : 0;
            if (Number.isFinite(sec)) {
                const ms = sec * 1000 + (Number.isFinite(nan) ? nan / 1e6 : 0);
                const d = new Date(ms);
                return !Number.isNaN(d.getTime()) ? d : null;
            }
        }
        const d = new Date(raw);
        return !Number.isNaN(d.getTime()) ? d : null;
    } catch (_) {
        return null;
    }
}

/** users 루트에 createdAt 없을 때: 프로필 완료 시각·약관 동의 시각 중 이른 값으로 표시/정렬 보정 */
function coalesceSignupDate(rootCreated, profileCompletedAt, termsAgreedAt) {
    if (rootCreated) {
        return rootCreated instanceof Date ? rootCreated : new Date(rootCreated);
    }
    const cands = [profileCompletedAt, termsAgreedAt].filter((x) => x != null);
    if (!cands.length) return null;
    const times = cands.map((d) => (d instanceof Date ? d : new Date(d)).getTime()).filter((t) => Number.isFinite(t));
    if (!times.length) return null;
    return new Date(Math.min(...times));
}

/** 가입일~마지막 로그인 사이 경과(ms). 둘 중 하나 없거나 역전이면 null. */
function computeSignupToLastLoginMs(createdAt, lastLoginAt) {
    const c = createdAt ? (createdAt instanceof Date ? createdAt : new Date(createdAt)) : null;
    const l = lastLoginAt ? (lastLoginAt instanceof Date ? lastLoginAt : new Date(lastLoginAt)) : null;
    if (!c || !l) return null;
    const ct = c.getTime();
    const lt = l.getTime();
    if (!Number.isFinite(ct) || !Number.isFinite(lt)) return null;
    if (lt < ct) return null;
    return lt - ct;
}

/** 활동일수 셀 HTML: 일과 시간을 두 줄로 (시간은 2자리 패딩) */
function formatSignupToLastLoginActivityHtml(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return escapeHtml('-');
    const totalHours = Math.floor(ms / (1000 * 60 * 60));
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    const h = `${String(hours).padStart(2, '0')}시간`;
    return `<span class="flex flex-col items-center justify-center leading-tight tabular-nums"><span>${days}일</span><span>${escapeHtml(h)}</span></span>`;
}

/** 생년월일 문자열을 정렬용 키로 변환 (없으면 null) */
function birthdateSortComparable(birthdate) {
    const s = birthdate == null ? '' : String(birthdate).trim();
    if (!s) return null;
    const digits = s.replace(/\D/g, '');
    if (digits.length === 8) return digits;
    const t = Date.parse(s);
    if (Number.isFinite(t)) return String(t);
    return s.toLowerCase();
}

/** 성별 정렬: 남 → 여 → 미입력 */
function genderSortRank(gender) {
    if (gender === 'male') return 1;
    if (gender === 'female') return 2;
    return null;
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

/** 앱과 동일: termsAgreed 불리언 true + termsVersion 문자열이 있어야 동의 기록으로 인정 */
function termsAgreedEvidence(user) {
    const strict = user?.termsAgreed === true || user?.termsAgreed === 'true' || user?.termsAgreed === 1;
    if (!strict) return false;
    const ver = user?.termsVersion;
    return ver != null && String(ver).trim() !== '';
}

function getTermsRank(user, currentVersion) {
    // 2: 최신 약관 버전과 일치, 1: 동의 기록은 있으나 구버전(재동의 필요), 0: 기록 없음
    const agreed = termsAgreedEvidence(user);
    if (!agreed) return 0;
    const ver = user?.termsVersion;
    if (currentVersion && String(ver).trim() === String(currentVersion).trim()) return 2;
    return 1;
}

function sortUsersForTable(users, currentVersion) {
    const { key, dir } = usersSortState;
    const sorted = [...users];
    sorted.sort((a, b) => {
        let av;
        let bv;
        switch (key) {
            case 'deleteRequested':
                av = a?.deleteRequested ? 1 : 0;
                bv = b?.deleteRequested ? 1 : 0;
                return compareWithNullsLast(av, bv, dir);
            case 'pageFetchIndex':
                av = typeof a?.pageFetchIndex === 'number' ? a.pageFetchIndex : null;
                bv = typeof b?.pageFetchIndex === 'number' ? b.pageFetchIndex : null;
                return compareWithNullsLast(av, bv, dir);
            case 'birthdate':
                av = birthdateSortComparable(a?.birthdate);
                bv = birthdateSortComparable(b?.birthdate);
                return compareWithNullsLast(av, bv, dir);
            case 'gender':
                av = genderSortRank(a?.gender);
                bv = genderSortRank(b?.gender);
                return compareWithNullsLast(av, bv, dir);
            case 'signupToLastLoginDays':
                av = a?.signupToLastLoginMs;
                bv = b?.signupToLastLoginMs;
                if (av !== null && av !== undefined && typeof av !== 'number') av = null;
                if (bv !== null && bv !== undefined && typeof bv !== 'number') bv = null;
                return compareWithNullsLast(av, bv, dir);
            case 'activityBan':
                av = typeof a?.activityBanLevel === 'number' ? a.activityBanLevel : 0;
                bv = typeof b?.activityBanLevel === 'number' ? b.activityBanLevel : 0;
                return compareWithNullsLast(av, bv, dir);
            case 'email':
                av = normalizeString(a?.email || a?.userId);
                bv = normalizeString(b?.email || b?.userId);
                return compareWithNullsLast(av, bv, dir);
            case 'timelineCount':
            case 'albumShareCount':
            case 'talkCount':
                av = normalizeNumber(a?.[key]);
                bv = normalizeNumber(b?.[key]);
                return compareWithNullsLast(av, bv, dir);
            case 'createdAt':
                av = normalizeDateValue(a?.createdAtResolved ?? a?.createdAt);
                bv = normalizeDateValue(b?.createdAtResolved ?? b?.createdAt);
                return compareWithNullsLast(av, bv, dir);
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

function updateAdminUsersTotalCountDisplay(totalCount) {
    const el = document.getElementById('adminUsersTotalCountDisplay');
    if (!el) return;
    if (totalCount === null || totalCount === undefined) {
        el.textContent = '—';
        return;
    }
    el.textContent = Number(totalCount).toLocaleString('ko-KR');
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

/**
 * 사용자 분석용: 전체 사용자를 페이지 단위로 모두 로드한 배열 (Firestore 다회 조회).
 * 테이블의 `usersFullListRaw`와 별개로 호출해도 동일한 getUsers 파이프라인을 사용합니다.
 */
export async function fetchAllUsersForAdminAnalytics() {
    return fetchAllUsersEnriched();
}

export function ensureAdminUsersSortHandlers() {
    initUsersSortHandlers();
    ensureAdminUsersSearchHandlers();
}

function initUsersSortHandlers() {
    const buttons = document.querySelectorAll('.admin-users-sort');
    if (!buttons || buttons.length === 0) return;
    
    buttons.forEach(btn => {
        if (btn.dataset.sortBound === '1') return;
        btn.dataset.sortBound = '1';
        btn.addEventListener('click', () => {
            if (!adminUsersDataLoaded) {
                alert('먼저 새로고침으로 목록을 불러오세요.');
                return;
            }
            const key = btn.getAttribute('data-sort-key');
            if (!key) return;
            if (usersSortState.key === key) {
                usersSortState.dir = usersSortState.dir === 'asc' ? 'desc' : 'asc';
            } else {
                usersSortState.key = key;
                usersSortState.dir = USERS_SORT_DEFAULT_DIR[key] || 'asc';
            }
            updateUsersSortHeaderUI();
            // 전체 목록 기준 정렬(최초에는 전체 로드 후 슬라이스)
            renderUsers({ loadFullListForSort: true });
        });
    });
    updateUsersSortHeaderUI();
}

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

        // 1) 첫 페이지만 전체 사용자 수 조회 — lastLoginAt 기준(프로필 미완료·카카오만 로그인한 사용자도 포함)
        let totalCount = adminUsersTotalCount;
        if (page === 1) {
            const countQuery = query(usersColl, orderBy('lastLoginAt', 'desc'));
            const countSnap = await getCountFromServer(countQuery);
            totalCount = countSnap.data().count;
            adminUsersTotalCount = totalCount;
        }

        // 2) users 컬렉션 페이지 단위 쿼리 (최근 로그인순 — createdAt 없이 문서만 있는 경우도 목록에 포함)
        let usersQuery = query(usersColl, orderBy('lastLoginAt', 'desc'), limit(pageSize));
        if (startAfterDoc) usersQuery = query(usersColl, orderBy('lastLoginAt', 'desc'), limit(pageSize), startAfter(startAfterDoc));
        /** 로컬 캐시만 보면 백필 직후에도 createdAt 이 비어 있는 것처럼 보일 수 있음 → 항상 서버 기준 */
        const usersSnapshot = await getDocsFromServer(usersQuery);
        const userIds = usersSnapshot.docs.map(d => d.id);
        const lastDoc = usersSnapshot.docs.length > 0 ? usersSnapshot.docs[usersSnapshot.docs.length - 1] : null;
        if (lastDoc) adminUsersLastDocsByPage[page] = lastDoc;

        if (userIds.length === 0) {
            return { users: [], totalCount, lastDoc: null, hasMore: false };
        }

        // 3) 이 페이지 사용자들에 대해서만 userBans(documentId in), deleteRequests(userId in), sharedPhotos/boardPosts(whereIn)
        const [userBansMap, deleteRequestedUserIds, sharedChunk1, sharedChunk2, boardChunk1, boardChunk2] = await Promise.all([
            fetchUserBansMap(userBansColl, userIds),
            fetchDeleteRequestedUserIdsForPage(deleteRequestsColl, userIds),
            userIds.length > 0 ? getDocs(query(sharedColl, where('userId', 'in', userIds.slice(0, 30)))) : Promise.resolve({ docs: [] }),
            userIds.length > 30 ? getDocs(query(sharedColl, where('userId', 'in', userIds.slice(30, 50)))) : Promise.resolve({ docs: [] }),
            userIds.length > 0 ? getDocs(query(boardPostsColl, where('authorId', 'in', userIds.slice(0, 30)))) : Promise.resolve({ docs: [] }),
            userIds.length > 30 ? getDocs(query(boardPostsColl, where('authorId', 'in', userIds.slice(30, 50)))) : Promise.resolve({ docs: [] })
        ]);
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

        // 4) settings 조회 + 타임라인 건수: meals 서브컬렉션 집계(정확). users.mealCount는 백필/클라 증감용이며 불일치할 수 있음
        const [settingsDocs, mealCountSettled] = await Promise.all([
            Promise.all(
                userIds.map((id) =>
                    getDocFromServer(doc(db, 'artifacts', appId, 'users', id, 'config', 'settings'))
                )
            ),
            Promise.allSettled(userIds.map(id => getCountFromServer(collection(db, 'artifacts', appId, 'users', id, 'meals'))))
        ]);
        const mealCounts = mealCountSettled.map(s => (s.status === 'fulfilled' ? s.value : null));

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
            let profileCompleted = false;
            let profileCompletedAt = null;
            let providerId = userDocData.providerId || null;
            let createdAt = parseRootTimestampField(userDocData.createdAt);
            let lastLoginAt = parseRootTimestampField(userDocData.lastLoginAt);

            if (sharedUserMap.has(userId)) {
                const s = sharedUserMap.get(userId);
                if (s.nickname) nickname = s.nickname;
                if (s.icon) icon = s.icon;
            }

            const settingsSnap = settingsDocs[i];
            // 자가 탈퇴(deleteAllUserData) 등으로 settings 가 없으면 루트만 남은 고아 문서 → 목록에서 제외(닉네임만 익명으로 보이던 케이스)
            if (!settingsSnap || !settingsSnap.exists()) {
                continue;
            }
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
            termsAgreed =
                settings.termsAgreed === true ||
                settings.termsAgreed === 'true' ||
                settings.termsAgreed === 1;
            termsAgreedAt = settings.termsAgreedAt ?? null;
            termsVersion = settings.termsVersion ?? null;
            profileCompleted = settings.profileCompleted === true;
            profileCompletedAt = parseSettingsDate(settings.profileCompletedAt);
            if (settings.email) email = settings.email;
            if (settings.providerId) providerId = settings.providerId;

            let loginMethod = '게스트';
            if (providerId === 'google.com') loginMethod = '구글';
            else if (providerId === 'kakao.com') loginMethod = '카카오';
            else if (email) loginMethod = '이메일';
            // 루트/settings에 providerId가 비어 있는 레거시·레이스 문서: 카카오 커스텀 토큰 UID(kakao_{id})는 앱과 동일하게 카카오로 표시 (대소문자 혼선 방지)
            else if (typeof userId === 'string' && /^kakao_/i.test(userId)) loginMethod = '카카오';

            const ban = userBansMap.get(userId);
            const bannedShare = ban?.bannedShare ?? false;
            const bannedWrite = ban?.bannedWrite ?? false;
            const deleteRequested = deleteRequestedUserIds.has(userId);
            let timelineCount = 0;
            const countSnap = mealCounts[i];
            if (countSnap && typeof countSnap.data === 'function') {
                timelineCount = countSnap.data().count;
            } else {
                const mcField = userDocData.mealCount;
                if (mcField !== undefined && mcField !== null) {
                    const n = Number(mcField);
                    if (Number.isFinite(n) && n >= 0) timelineCount = n;
                }
            }
            const albumShareCount = albumShareCountMap.get(userId) ?? 0;
            const talkCount = talkCountMap.get(userId) ?? 0;

            const activityBanLevel = (bannedWrite ? 1 : 0) + (bannedShare ? 1 : 0);
            const termsAgreedAtDate = parseSettingsDate(termsAgreedAt);
            const createdAtResolved = coalesceSignupDate(createdAt, profileCompletedAt, termsAgreedAtDate);
            let signupToLastLoginMs = null;
            if (loginMethod !== '게스트') {
                signupToLastLoginMs = computeSignupToLastLoginMs(createdAtResolved || createdAt, lastLoginAt);
            }

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
                profileCompleted,
                timelineCount,
                albumShareCount,
                talkCount,
                createdAt,
                createdAtResolved,
                lastLoginAt,
                bannedShare,
                bannedWrite,
                deleteRequested,
                pageFetchIndex: i,
                activityBanLevel,
                signupToLastLoginMs
            });
        }

        return { users, totalCount, lastDoc, hasMore: usersSnapshot.docs.length === pageSize };
    } catch (e) {
        console.error("Get users error:", e);
        throw e;
    }
}

/** 전체 사용자를 페이지 단위로 로드해 합침 — 정렬은 이 배열 전체 기준 */
async function fetchAllUsersEnriched() {
    adminUsersLastDocsByPage = {};
    const all = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
        const result = await getUsers({ page, pageSize: USERS_PER_PAGE });
        if (page === 1) {
            adminUsersTotalCount = result.totalCount;
        }
        result.users.forEach((u, i) => {
            u.pageFetchIndex = all.length + i;
            all.push(u);
        });
        hasMore = result.hasMore === true && result.users.length > 0;
        page += 1;
        if (result.users.length === 0) break;
    }
    return all;
}

function invalidateUsersTableCache() {
    usersCache = null;
    usersFullListRaw = null;
    adminUsersLastDocsByPage = {};
    adminUsersSearchQuery = '';
    try {
        const inp = document.getElementById('adminUsersSearchInput');
        if (inp) inp.value = '';
        const clr = document.getElementById('adminUsersSearchClearBtn');
        if (clr) clr.classList.add('hidden');
        updateAdminUsersSearchHint('');
    } catch (_) { /* ignore */ }
}

// 사용자 목록 렌더링
export async function renderUsers(options = {}) {
    const container = document.getElementById('usersContainer');
    if (!container) {
        console.error('usersContainer를 찾을 수 없습니다.');
        return;
    }

    const mayFetch = options.forceNetwork === true || adminUsersDataLoaded || options.loadFullListForSort === true;
    if (!mayFetch) {
        container.innerHTML =
            '<tr><td colspan="15" class="px-4 py-8 text-center text-slate-400"><i class="fa-solid fa-rotate-right text-2xl mb-2 opacity-40" aria-hidden="true"></i><p class="text-sm">상단 <strong class="text-slate-600">새로고침</strong>으로 목록을 불러옵니다.</p></td></tr>';
        const navEl = document.getElementById('adminUsersListPagination');
        updateAdminUsersTotalCountDisplay(null);
        updateAdminUsersSearchHint('');
        if (navEl) navEl.innerHTML = '';
        return;
    }

    const needle = (adminUsersSearchQuery || '').trim().toLowerCase();
    const lightRender = options?.lightRender === true && usersFullListRaw !== null && Array.isArray(usersFullListRaw);

    if (!lightRender) {
        container.innerHTML =
            '<tr><td colspan="15" class="px-4 py-8 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i><p>로딩 중...</p></td></tr>';
    }

    try {
        console.log('renderUsers 시작');
        // 헤더 정렬 핸들러는 한 번만 바인딩
        initUsersSortHandlers();
        ensureAdminUsersSearchHandlers();

        const loadFullListForSort = options?.loadFullListForSort === true;
        const needsFullList = loadFullListForSort || needle.length > 0;
        if (needsFullList && !usersFullListRaw) {
            container.innerHTML = '<tr><td colspan="15" class="px-4 py-8 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i><p>전체 사용자 목록을 불러오는 중…</p></td></tr>';
            try {
                usersFullListRaw = await fetchAllUsersEnriched();
            } catch (e) {
                console.error('전체 사용자 로드 실패:', e);
                invalidateUsersTableCache();
                const errMsg = (e && (e.message || e.code || String(e))) || '알 수 없는 오류';
                container.innerHTML = '<tr><td colspan="15" class="px-4 py-8 text-center text-red-400"><i class="fa-solid fa-exclamation-triangle text-2xl mb-2"></i><p>전체 목록을 불러오지 못했습니다.</p><p class="text-xs mt-2 text-slate-500">' + escapeHtml(errMsg) + '</p></td></tr>';
                return;
            }
        }

        let users;
        const useCacheOnly = options?.useCacheOnly === true;

        if (usersFullListRaw !== null && Array.isArray(usersFullListRaw)) {
            users = usersFullListRaw;
        } else if (usersCache && Array.isArray(usersCache) && useCacheOnly) {
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

        const hadAnyBeforeFilter = users.length > 0;
        const filtered = needle.length > 0 ? users.filter((u) => adminUserMatchesSearch(u, needle)) : users;

        if (filtered.length === 0) {
            if (needle.length > 0 && hadAnyBeforeFilter) {
                container.innerHTML =
                    '<tr><td colspan="15" class="px-4 py-8 text-center text-slate-400"><i class="fa-solid fa-magnifying-glass text-2xl mb-2 opacity-50" aria-hidden="true"></i><p>검색 조건에 맞는 사용자가 없습니다.</p><p class="text-xs mt-2 text-slate-500">닉네임·이메일·UID 일부만 입력해도 찾을 수 있습니다.</p></td></tr>';
            } else {
                container.innerHTML = '<tr><td colspan="15" class="px-4 py-8 text-center text-slate-400"><i class="fa-solid fa-users text-2xl mb-2"></i><p>사용자가 없습니다.</p></td></tr>';
            }
            const emptyPagingTotal = needle.length > 0 ? 0 : adminUsersTotalCount;
            updateAdminUsersListPagination(emptyPagingTotal, Math.max(1, Math.ceil(emptyPagingTotal / USERS_PER_PAGE)));
            updateAdminUsersSearchHint(needle);
            try { applyAdminUsersPageVisibility(adminUsersCurrentPage); } catch (_) {}
            adminUsersDataLoaded = true;
            return;
        }

        // 최신 약관 버전 가져오기
        const currentVersion = await getCurrentTermsVersion();

        const sortedUsers = sortUsersForTable(filtered, currentVersion);
        updateUsersSortHeaderUI();

        const totalCountForPaging =
            needle.length > 0
                ? filtered.length
                : usersFullListRaw !== null && Array.isArray(usersFullListRaw)
                  ? usersFullListRaw.length
                  : adminUsersTotalCount;
        const totalListPages = Math.max(1, Math.ceil(totalCountForPaging / USERS_PER_PAGE));
        if (adminUsersListPage > totalListPages) adminUsersListPage = totalListPages;

        const useClientSlice = needle.length > 0 || (usersFullListRaw !== null && Array.isArray(usersFullListRaw));
        let usersToShow;
        if (useClientSlice) {
            const startIdx = (adminUsersListPage - 1) * USERS_PER_PAGE;
            usersToShow = sortedUsers.slice(startIdx, startIdx + USERS_PER_PAGE);
        } else {
            usersToShow = sortedUsers;
        }

        updateAdminUsersListPagination(totalCountForPaging, totalListPages);
        updateAdminUsersSearchHint(needle);
        
        const start = totalCountForPaging === 0 ? 0 : (adminUsersListPage - 1) * USERS_PER_PAGE + 1;
        const end = Math.min(adminUsersListPage * USERS_PER_PAGE, totalCountForPaging);
        console.log(`${usersToShow.length}명 표시 (${start}-${end} / ${totalCountForPaging}명).`);
        container.innerHTML = usersToShow.map((user, index) => {
            const rowNum = start + index;
            const agreedEv = termsAgreedEvidence(user);
            const verTrim = user.termsVersion != null ? String(user.termsVersion).trim() : '';
            const curTrim = currentVersion != null ? String(currentVersion).trim() : '';
            const hasAgreedToLatest = agreedEv && verTrim !== '' && curTrim !== '' && verTrim === curTrim;
            const hasAgreedToOld = agreedEv && verTrim !== '' && (!curTrim || verTrim !== curTrim);

            let termsAgreedText;
            if (hasAgreedToLatest) {
                termsAgreedText = `<span class="px-2 py-1 bg-emerald-100 text-emerald-700 text-xs font-bold rounded">동의함</span>`;
            } else if (hasAgreedToOld) {
                termsAgreedText = `<span class="px-2 py-1 bg-orange-100 text-orange-700 text-xs font-bold rounded">재동의 필요</span>`;
            } else {
                termsAgreedText = `<span class="px-2 py-1 bg-red-100 text-red-700 text-xs font-bold rounded">미동의</span>`;
            }
            
            const termsAgreedAtParsed = parseSettingsDate(user.termsAgreedAt);
            const termsAgreedDate = termsAgreedAtParsed
                ? termsAgreedAtParsed.toLocaleDateString('ko-KR')
                : '-';
            
            const createdDt = user.createdAtResolved
                ? user.createdAtResolved instanceof Date
                    ? user.createdAtResolved
                    : new Date(user.createdAtResolved)
                : user.createdAt
                  ? user.createdAt instanceof Date
                      ? user.createdAt
                      : new Date(user.createdAt)
                  : null;
            const lastLoginDt = user.lastLoginAt ? (user.lastLoginAt instanceof Date ? user.lastLoginAt : new Date(user.lastLoginAt)) : null;
            const opts = { timeZone: 'Asia/Seoul' };
            const createdAtDate = createdDt
                ? createdDt.toLocaleDateString('ko-KR', opts) + '<br>' + createdDt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', ...opts })
                : '-';
            const lastLoginDate = lastLoginDt
                ? lastLoginDt.toLocaleDateString('ko-KR', opts) + '<br>' + lastLoginDt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', ...opts })
                : '-';
            const signupToLastLoginLabel =
                user.loginMethod === '게스트'
                    ? escapeHtml('-')
                    : formatSignupToLastLoginActivityHtml(user.signupToLastLoginMs);
            
            let loginMethodBadge = 'bg-slate-100 text-slate-700';
            if (user.loginMethod === '구글') {
                loginMethodBadge = 'bg-red-100 text-red-700';
            } else if (user.loginMethod === '카카오') {
                loginMethodBadge = 'bg-[#FEE500] text-[#191919]';
            } else if (user.loginMethod === '이메일') {
                loginMethodBadge = 'bg-blue-100 text-blue-700';
            }
            
            const banLabels = [];
            if (user.bannedWrite) banLabels.push('글쓰기');
            if (user.bannedShare) banLabels.push('공유');
            const activityBanCell = banLabels.length
                ? `<div class="flex flex-col gap-0.5 items-center">${banLabels.map((label) => `<span class="px-1.5 py-0.5 bg-amber-100 text-amber-800 text-[10px] font-bold rounded leading-tight whitespace-nowrap">${escapeHtml(label)}</span>`).join('')}</div>`
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
                    <td data-page="1 2" class="px-2 py-2.5 text-center">
                        <label class="inline-flex justify-center items-center cursor-pointer">
                            <input type="checkbox" class="admin-user-checkbox rounded border-slate-300 text-emerald-600 focus:ring-emerald-500" data-user-id="${escapeHtml(user.userId)}" title="선택" ${user.deleteRequested ? 'disabled' : ''}>
                        </label>
                    </td>
                    <td data-page="1 2" class="px-2 py-2.5 text-center text-slate-500 text-sm tabular-nums">${rowNum}</td>
                    <td data-page="1 2" class="px-3 py-2.5 text-left align-middle">${emailUserIdCell}</td>
                    <td data-page="1 2" class="px-2 py-2.5 min-w-[6.5rem] max-w-[9.75rem] text-center align-middle">
                        <div class="flex flex-col items-center justify-center gap-0 min-h-[2.35rem]">
                            ${
                                user.deleteRequested
                                    ? `<span class="font-bold text-slate-800 break-words text-sm leading-tight text-center max-w-full">${escapeHtml(user.nickname || '익명')}</span>`
                                    : `<div class="flex flex-row items-center justify-center gap-1.5 w-full min-w-0">
                                <span class="font-bold text-slate-800 break-words text-sm leading-tight text-center min-w-0">${escapeHtml(user.nickname || '익명')}</span>
                                <button type="button" class="admin-user-edit-nick-btn shrink-0 p-1 rounded-md text-slate-500 hover:text-emerald-700 hover:bg-emerald-50 border border-transparent hover:border-emerald-200 self-center" data-uid="${escapeHtml(user.userId)}" data-nick-enc="${encodeURIComponent(String(user.nickname || ''))}" title="닉네임 수정">
                                    <i class="fa-solid fa-pen text-[11px]" aria-hidden="true"></i>
                                </button>
                            </div>`
                            }
                            <span class="block w-full text-[11px] leading-tight break-words text-center max-w-full -mt-px ${user.lifestyle && String(user.lifestyle).trim() !== '' ? 'text-slate-500' : 'text-slate-400'}">${user.lifestyle && String(user.lifestyle).trim() !== '' ? escapeHtml(String(user.lifestyle).trim()) : '-'}</span>
                            ${deleteRequestedBadge ? `<div class="mt-0 flex justify-center w-full">${deleteRequestedBadge}</div>` : ''}
                        </div>
                    </td>
                    <td data-page="1 2" class="px-2 py-2.5 text-center">
                        <span class="text-sm text-slate-600 tabular-nums">${user.birthdate && String(user.birthdate).trim() !== '' ? escapeHtml(String(user.birthdate).trim()) : '-'}</span>
                    </td>
                    <td data-page="1 2" class="px-2 py-2.5 text-center">
                        <span class="text-sm text-slate-600">${user.gender === 'male' ? '남' : user.gender === 'female' ? '여' : '-'}</span>
                    </td>
                    <td data-page="1" class="px-3 py-2.5 text-center">
                        <span class="inline-flex px-2 py-1 ${loginMethodBadge} text-xs font-bold rounded">${user.loginMethod || '게스트'}</span>
                    </td>
                    <td data-page="1" class="px-2 py-2.5 min-w-[8rem] max-w-[11rem] text-center">
                        <div class="flex flex-col gap-1 items-center">
                            ${termsAgreedText}
                            ${termsAgreedAtParsed ? `<span class="text-[10px] text-slate-500 leading-tight text-center">${termsAgreedDate}</span>` : ''}
                        </div>
                    </td>
                    <td data-page="1" class="px-3 py-2.5 text-center">
                        <span class="text-sm text-slate-600 leading-snug">${createdAtDate}</span>
                    </td>
                    <td data-page="1" class="px-3 py-2.5 text-center">
                        <span class="text-sm text-slate-600 leading-snug">${lastLoginDate}</span>
                    </td>
                    <td data-page="1" class="px-2 py-2.5 text-center">
                        <div class="text-sm text-slate-600 font-medium">${signupToLastLoginLabel}</div>
                    </td>
                    <td data-page="1" class="px-1.5 py-2.5 min-w-[3.25rem] max-w-[4rem] text-center">${activityBanCell}</td>
                    <td data-page="2" class="px-3 py-2.5 text-center tabular-nums">
                        <span class="font-bold text-slate-800">${user.timelineCount || 0}</span>
                    </td>
                    <td data-page="2" class="px-3 py-2.5 text-center tabular-nums">
                        <span class="font-bold text-slate-800">${user.albumShareCount || 0}</span>
                    </td>
                    <td data-page="2" class="px-3 py-2.5 text-center tabular-nums">
                        <span class="font-bold text-slate-800">${user.talkCount || 0}</span>
                    </td>
                </tr>
            `;
        }).join('');
        ensureAdminUserNicknameEditDelegation();
        initAdminUsersSelectAll();
        applyAdminUsersPageVisibility(typeof adminUsersCurrentPage !== 'undefined' ? adminUsersCurrentPage : 1);
        adminUsersDataLoaded = true;
        try {
            const analyticsPanel = document.getElementById('adminUsersPanelAnalytics');
            const analyticsVisible = analyticsPanel && !analyticsPanel.classList.contains('hidden');
            if (analyticsVisible && typeof window.refreshAdminUserAnalytics === 'function') {
                void window.refreshAdminUserAnalytics();
            }
        } catch (_) { /* ignore */ }
    } catch (e) {
        adminUsersDataLoaded = false;
        console.error("사용자 목록 렌더링 실패:", e);
        const errMsg = (e && (e.message || e.code || String(e))) || '알 수 없는 오류';
        container.innerHTML = '<tr><td colspan="15" class="px-4 py-8 text-center text-red-400"><i class="fa-solid fa-exclamation-triangle text-2xl mb-2"></i><p>사용자 목록을 불러오는 중 오류가 발생했습니다.</p><p class="text-xs mt-2 text-slate-500">' + escapeHtml(errMsg) + '</p></td></tr>';
    }
}

function updateAdminUsersListPagination(totalCount, totalPages) {
    const navEl = document.getElementById('adminUsersListPagination');
    if (!navEl) return;
    updateAdminUsersTotalCountDisplay(totalCount);
    navEl.innerHTML = '';
    if (totalPages <= 1) return;
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'px-2 py-1 rounded text-xs font-bold bg-slate-100 text-slate-600 hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed';
    prevBtn.textContent = '이전';
    prevBtn.disabled = adminUsersListPage <= 1;
    prevBtn.onclick = () => {
        if (!adminUsersDataLoaded) return;
        adminUsersListPage = Math.max(1, adminUsersListPage - 1);
        renderUsers();
    };
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
        btn.onclick = () => {
            if (!adminUsersDataLoaded) return;
            adminUsersListPage = p;
            renderUsers();
        };
        navEl.appendChild(btn);
    }
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'px-2 py-1 rounded text-xs font-bold bg-slate-100 text-slate-600 hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed';
    nextBtn.textContent = '다음';
    nextBtn.disabled = adminUsersListPage >= totalPages;
    nextBtn.onclick = () => {
        if (!adminUsersDataLoaded) return;
        adminUsersListPage = Math.min(totalPages, adminUsersListPage + 1);
        renderUsers();
    };
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

export function switchAdminUsersPage(pageNum) {
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
}

export function switchAdminUsersListPage(pageNum) {
    if (pageNum < 1) return;
    if (!adminUsersDataLoaded) return;
    adminUsersListPage = pageNum;
    renderUsers();
}

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

let adminNicknameEditDelegationBound = false;

function ensureAdminUserNicknameEditDelegation() {
    if (adminNicknameEditDelegationBound) return;
    const tbody = document.getElementById('usersContainer');
    if (!tbody) return;
    adminNicknameEditDelegationBound = true;
    tbody.addEventListener('click', (e) => {
        const btn = e.target.closest('.admin-user-edit-nick-btn');
        if (!btn || btn.disabled) return;
        e.preventDefault();
        const uid = btn.getAttribute('data-uid');
        if (!uid) return;
        const enc = btn.getAttribute('data-nick-enc') || '';
        let current = '';
        try {
            current = decodeURIComponent(enc);
        } catch (_) {
            current = '';
        }
        void runAdminEditUserNickname(uid, current);
    });
}

async function runAdminEditUserNickname(targetUid, currentLabel) {
    if (!auth.currentUser) {
        alert('관리자 로그인이 필요합니다.');
        return;
    }
    const input = window.prompt('새 닉네임을 입력하세요. (20자 이하)', currentLabel);
    if (input === null) return;
    const trimmed = input.trim();
    if (!trimmed) {
        alert('닉네임을 입력해 주세요.');
        return;
    }
    if (trimmed.length > 20) {
        alert('닉네임은 20자 이하로 입력해 주세요.');
        return;
    }
    if (trimmed === '게스트') {
        alert('예약된 닉네임은 사용할 수 없습니다.');
        return;
    }
    if (trimmed === currentLabel) return;
    try {
        if (!callableFunctions?.adminSetUserNickname) {
            alert('닉네임 저장 기능을 불러올 수 없습니다. 페이지를 새로고침해 주세요.');
            return;
        }
        await callableFunctions.adminSetUserNickname({ userId: targetUid, nickname: trimmed });
        alert('닉네임이 저장되었습니다.');
        invalidateUsersTableCache();
        if (adminUsersDataLoaded) await renderUsers();
    } catch (e) {
        console.error('adminSetUserNickname', e);
        const code = String(e?.code || '');
        const msg = String(e?.message || e || '');
        if (code.includes('already-exists') || msg.includes('already-exists') || msg.includes('이미 사용 중')) {
            alert('이미 사용 중인 닉네임입니다.');
        } else if (code.includes('permission-denied')) {
            alert('권한이 없습니다.');
        } else if (code.includes('invalid-argument')) {
            alert(msg || '입력값을 확인해 주세요.');
        } else {
            alert('저장에 실패했습니다: ' + (msg || '알 수 없는 오류'));
        }
    }
}

// 대기 중인 삭제 요청 수동 처리 (트리거가 동작하지 않을 때 사용)
export async function processDeleteUserRequests() {
    const uid = auth.currentUser?.uid;
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
        invalidateUsersTableCache();
        if (adminUsersDataLoaded) await renderUsers();
    } catch (e) {
        console.error('삭제 요청 처리 실패:', e);
        alert('삭제 요청 처리 중 오류가 발생했습니다: ' + (e.message || e));
    }
}

// 선택 삭제: deleteUserRequests에 문서 생성 후 즉시 processDeleteUserRequests 호출
export async function adminUserDeleteSelected() {
    let ids = getSelectedUserIds();
    if (ids.length === 0) {
        alert('삭제할 사용자를 선택해 주세요.');
        return;
    }
    ids = [...new Set(ids)];
    if (!confirm(`선택한 ${ids.length}명의 사용자를 삭제하시겠습니까?\n삭제 후 해당 계정으로 로그인할 수 없습니다.`)) {
        return;
    }
    const uid = auth.currentUser?.uid;
    if (!uid) {
        alert('관리자 로그인이 필요합니다.');
        return;
    }
    try {
        const coll = collection(db, 'artifacts', appId, 'deleteUserRequests');
        for (const userId of ids) {
            await addDoc(coll, { userId, requestedBy: uid, timestamp: serverTimestamp() });
        }
        invalidateUsersTableCache();
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
        if (adminUsersDataLoaded) await renderUsers();
    } catch (e) {
        console.error('삭제 요청 실패:', e);
        alert('삭제 요청 중 오류가 발생했습니다: ' + (e.message || e));
    }
}

// 공유 금지 설정/해제
export async function adminUserBanShare(value) {
    const ids = getSelectedUserIds();
    if (ids.length === 0) {
        alert('대상을 선택해 주세요.');
        return;
    }
    const uid = auth.currentUser?.uid;
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
        invalidateUsersTableCache();
        if (adminUsersDataLoaded) await renderUsers();
    } catch (e) {
        console.error('공유 금지 설정 실패:', e);
        alert('설정 중 오류가 발생했습니다: ' + (e.message || e));
    }
}

// 글쓰기(댓글 포함) 금지 설정/해제
export async function adminUserBanWrite(value) {
    const ids = getSelectedUserIds();
    if (ids.length === 0) {
        alert('대상을 선택해 주세요.');
        return;
    }
    const uid = auth.currentUser?.uid;
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
        invalidateUsersTableCache();
        if (adminUsersDataLoaded) await renderUsers();
    } catch (e) {
        console.error('글쓰기 금지 설정 실패:', e);
        alert('설정 중 오류가 발생했습니다: ' + (e.message || e));
    }
}

// 사용자 목록 새로고침
export async function refreshUsers() {
    await runAdminRefreshAction(document.getElementById('adminUsersRefreshBtn'), async () => {
        invalidateUsersTableCache();
        // 가입일(createdAt) 기준 정렬은 전역 순서가 필요해 전체 로드 후 클라이언트에서 정렬(lastLoginAt만으로 페이지네이션하면 이전 페이지가 섞임)
        await renderUsers({ forceNetwork: true, loadFullListForSort: true });
    });
}
