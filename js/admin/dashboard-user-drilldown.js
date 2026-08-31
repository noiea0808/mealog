// 대시보드 트렌드 드릴다운: 「신규 사용자」·「활성 사용자」 칸을 눌러 실제 명단 보기
//
// 설계 메모
// - 표의 칸 하나가 곧 (지표 × 기간)이므로 칸을 그대로 팝업 조건으로 쓴다. 별도 기간 선택 UI가 없어
//   표의 숫자와 명단이 어긋날 수 없다. (특히 활성 사용자 월 칸은 주간 합이 아니라 유니크 합집합)
// - 명단(UID)은 통계 캐시 본문이 아니라 `dashboardStats/drilldown/*` 하위 문서에 나눠 저장한다.
//   주가 쌓여도 본문 문서가 1MB 한계로 밀려가지 않고, 팝업 1회 열기 = 문서 1~5개 읽기로 끝난다.
// - 명단 문서는 「새로고침」 집계 때 이미 메모리에 있는 Set을 쓰므로 추가 쿼리 비용이 0이다.
// - 닉네임만 사용자별 settings 조회가 필요해 팝업을 열 때 지연 조회하고 세션 캐시에 담는다.
import { db, appId } from '../firebase.js';
import {
    doc,
    getDoc,
    writeBatch,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
    escapeHtml,
    weekLabelKoreanFromSunday,
    dateKeyFromLocalDate,
    getTodayDateString
} from './utils.js';
import { withDeadlineOr, DEADLINE } from '../utils/with-deadline.js';
import { fetchAdminUserDetail } from './users.js';
import {
    unionOfPeriods,
    buildMatrixRow,
    sortMatrixRows,
    sortListRows,
    summarizeMatrix,
    heatLevel,
    maxMarkCount,
    buildCohortTable,
    decodeProfileStore,
    encodeProfileStore
} from './dashboard-drilldown-model.js';

const DRILLDOWN_DOC = (id) =>
    doc(db, 'artifacts', appId, 'adminSettings', 'dashboardStats', 'drilldown', id);

/** 주차 문서 ID는 YYYY-MM-DD(일요일)이므로 아래 두 예약 ID와 겹치지 않는다 */
const DOC_ID_LAST7 = 'last7';
const DOC_ID_ALL = 'all';

/** 배치 쓰기 1회 상한(Firestore 500) 아래로 여유 있게 */
const WRITE_BATCH_SIZE = 400;

/** 팝업을 여러 번 열어도 같은 문서를 다시 읽지 않도록 하는 세션 캐시 */
const drilldownDocCache = new Map();
/** uid → { nickname, icon, t } — 세션 동안 유지, localStorage 로 세션을 넘겨서도 재사용 */
const profileCache = new Map();

/**
 * 닉네임 캐시를 localStorage 에 남기는 이유:
 * 팝업 읽기의 대부분이 사용자당 1건인 닉네임 조회다. 세션 안에서만 캐시하면 새로고침(F5)
 * 한 번에 전부 다시 읽는다. 사용자가 수천 명이 되면 「전체 기간」 칸 한 번이 수천 읽기가 된다.
 *
 * 대신 닉네임을 바꾼 사용자는 만료 전까지 옛 이름으로 보인다. 식별용 UID 는 행 툴팁에
 * 그대로 있고, 정확한 최신 값이 필요하면 「사용자 관리」 탭이 실시간이다.
 */
const PROFILE_STORE_KEY = `mealog:admin:drilldown-profiles:v1:${appId}`;
/** 이름이 바뀐 사용자를 언제까지 옛 이름으로 보여 줄지 — 3일 */
const PROFILE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** localStorage 용량을 지키기 위한 상한 (초과 시 오래된 것부터 버린다) */
const PROFILE_STORE_MAX = 5000;

let profileStoreHydrated = false;

function readLocalStorage(key) {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    } catch (e) {
        console.warn('[대시보드] 닉네임 캐시 읽기 불가:', e?.message || e);
        return null;
    }
}

/** 첫 조회 직전 1회 — 지난 세션에서 담아 둔 닉네임을 되살린다 */
function hydrateProfileCache() {
    if (profileStoreHydrated) return;
    profileStoreHydrated = true;
    const restored = decodeProfileStore(readLocalStorage(PROFILE_STORE_KEY), Date.now(), PROFILE_TTL_MS);
    for (const [uid, v] of restored) {
        if (!profileCache.has(uid)) profileCache.set(uid, v);
    }
}

/** 용량 초과면 상한을 줄여 가며 재시도하고, 끝내 안 되면 캐시를 비운다 (있으면 좋은 것이지 필수가 아니다) */
function persistProfileCache() {
    if (typeof localStorage === 'undefined') return;
    let lastErr = null;
    for (const cap of [PROFILE_STORE_MAX, 1000, 200]) {
        try {
            localStorage.setItem(PROFILE_STORE_KEY, JSON.stringify(encodeProfileStore(profileCache, cap)));
            return;
        } catch (e) {
            lastErr = e;
        }
    }
    try {
        localStorage.removeItem(PROFILE_STORE_KEY);
    } catch (e) {
        lastErr = e;
    }
    console.warn('[대시보드] 닉네임 캐시를 저장하지 못했습니다:', lastErr?.message || lastErr);
}

let modalBound = false;
let tableBound = false;
/** 팝업 열기 요청 순번 — 늦게 도착한 이전 요청이 화면을 덮어쓰지 않도록 */
let openSeq = 0;
/** 현재 팝업 상태 — 토글로 다시 그릴 때 재조회 없이 쓰려고 들고 있는다 */
let currentView = 'list';
let currentKind = 'activeUsers';
/** 하위 구간 단위 표기 ('주' | '일') */
let currentUnit = '주';
let currentPeriods = [];
let currentRows = [];
let currentMatrixRows = [];
let currentListSummary = '';
/** 클릭한 칸의 제목 — 코호트를 보고 돌아왔을 때 되돌리려고 들고 있는다 */
let currentCellTitle = '';
let currentNewOnly = false;
let currentDropoutOnly = false;
/**
 * 트렌드 표가 그리고 있는 전체 주차 키 (오름차순).
 * 코호트는 클릭한 칸의 기간이 아니라 전 구간을 봐야 해서 따로 들고 있는다.
 */
let allWeekKeys = [];
let cohortCache = null;
/** 사용자 상세 열기 순번 — 늦게 도착한 이전 조회가 화면을 덮어쓰지 않도록 */
let detailSeq = 0;
/** 상세 팝업 닫기·ESC 바인딩 1회 */
let detailModalBound = false;

export function invalidateDashboardUserDrilldownCache() {
    drilldownDocCache.clear();
    cohortCache = null;
}

/** 트렌드 표가 렌더될 때 전체 주차 키를 알려 준다 (코호트 표의 가로축) */
export function setDashboardDrilldownWeekKeys(keys) {
    const next = (keys || []).filter(Boolean);
    if (next.length !== allWeekKeys.length || next.some((k, i) => k !== allWeekKeys[i])) {
        cohortCache = null;
    }
    allWeekKeys = next;
}

// ============================================================
// 저장 (「새로고침」 집계 직후)
// ============================================================

/**
 * getUserStatistics()가 만든 UID 집합을 drilldown 하위 문서로 저장.
 * @param {object} userSets stats.userSets — { weeks, last7, all }
 * @param {{partial?: boolean}} [options] `partial` 이면 증분 집계라 손에 든 UID 가
 *   다시 센 구간뿐이다. 「전체」문서는 통째로 덮어쓰는 구조라 저장을 건너뛴다 —
 *   덮어쓰면 과거 명단이 사라진다. (주차 문서는 빈 주를 건너뛰므로 저절로 보존된다)
 */
export async function writeDashboardUserDrilldown(userSets, options = {}) {
    if (!userSets) return;
    const partial = options?.partial === true;
    const writes = [];

    for (const w of userSets.weeks || []) {
        if (!w?.sundayKey) continue;
        // 활동·가입이 모두 없는 주는 문서를 만들지 않는다 (없으면 0명으로 해석)
        if ((w.active?.length || 0) === 0 && (w.new?.length || 0) === 0) continue;
        writes.push([
            DRILLDOWN_DOC(w.sundayKey),
            {
                kind: 'week',
                sundayKey: w.sundayKey,
                active: w.active || [],
                new: w.new || [],
                dayCounts: w.dayCounts || {}
            }
        ]);
    }

    if (userSets.last7?.dates?.length === 7) {
        writes.push([
            DRILLDOWN_DOC(DOC_ID_LAST7),
            { kind: 'last7', dates: userSets.last7.dates, byDate: userSets.last7.byDate || {} }
        ]);
    }

    if (userSets.all && !partial) {
        writes.push([
            DRILLDOWN_DOC(DOC_ID_ALL),
            {
                kind: 'all',
                active: userSets.all.active || [],
                new: userSets.all.new || [],
                joinKeys: userSets.all.joinKeys || {}
            }
        ]);
    }

    for (let i = 0; i < writes.length; i += WRITE_BATCH_SIZE) {
        const batch = writeBatch(db);
        for (const [ref, data] of writes.slice(i, i + WRITE_BATCH_SIZE)) {
            batch.set(ref, { ...data, updatedAt: serverTimestamp() });
        }
        await batch.commit();
    }
    invalidateDashboardUserDrilldownCache();
}

// ============================================================
// 표의 칸에 드릴다운 표시 달기
// ============================================================

const DRILL_CELL_CLASSES = ['cursor-pointer', 'underline', 'decoration-dotted', 'underline-offset-4', 'hover:bg-emerald-50'];

/**
 * @param {HTMLElement} td
 * @param {{ kind: 'newUsers'|'activeUsers', scope: string, keys: string[], label: string, count: number }} spec
 */
export function markDashboardDrilldownCell(td, spec) {
    if (!td) return;
    const count = Number(spec?.count) || 0;
    if (!spec || count <= 0 || !spec.keys?.length) {
        clearDashboardDrilldownCell(td);
        return;
    }
    td.dataset.drillKind = spec.kind;
    td.dataset.drillScope = spec.scope;
    td.dataset.drillKeys = spec.keys.join(',');
    td.dataset.drillLabel = spec.label;
    td.dataset.drillCount = String(count);
    td.classList.add(...DRILL_CELL_CLASSES);
    // 이 칸에 이미 설명 툴팁(월 유니크 안내 등)이 있으면 지우지 않고 뒤에 덧붙인다.
    // 재렌더 때 힌트가 계속 쌓이지 않도록 이전 힌트는 잘라내고 다시 붙인다.
    const hint = `클릭: ${spec.label} ${spec.kind === 'newUsers' ? '신규' : '활성'} 사용자 명단`;
    const base = String(td.getAttribute('title') || '').split('\n클릭: ')[0];
    td.title = base && !base.startsWith('클릭: ') ? `${base}\n${hint}` : hint;
}

/**
 * 표 상단의 기간 헤더(7월·8월·최근 7일)를 클릭 대상으로 만든다.
 * 숫자 칸과 달리 「그 기간의 하위 구간별 출석 표」로 바로 연다 —
 * 누가 계속 썼고 누가 중간에 끊겼는지는 합계 숫자로는 보이지 않는다.
 * @param {HTMLElement} th
 * @param {{ scope: 'month'|'last7', keys: string[], label: string }} spec
 */
export function markDashboardDrilldownHeader(th, spec) {
    if (!th || !spec?.keys?.length) return;
    th.dataset.drillKind = 'activeUsers';
    th.dataset.drillScope = spec.scope;
    th.dataset.drillKeys = spec.keys.join(',');
    th.dataset.drillLabel = spec.label;
    th.dataset.drillView = 'matrix';
    th.classList.add(...DRILL_CELL_CLASSES);
    const unit = spec.scope === 'last7' ? '일자' : '주차';
    th.title = `클릭: ${spec.label} ${unit}별 사용자 출석 표 (지속·이탈 확인)`;
}

export function clearDashboardDrilldownCell(td) {
    if (!td) return;
    if (!td.dataset.drillKind) return;
    delete td.dataset.drillKind;
    delete td.dataset.drillScope;
    delete td.dataset.drillKeys;
    delete td.dataset.drillLabel;
    delete td.dataset.drillCount;
    delete td.dataset.drillView;
    td.classList.remove(...DRILL_CELL_CLASSES);
}

/** 트렌드 표 전체에 클릭 위임 1회 등록 */
export function ensureDashboardDrilldownBinding() {
    if (!tableBound) {
        const table = document.getElementById('adminDashboardStatsTable');
        if (table) {
            table.addEventListener('click', (e) => {
                const cell = e.target?.closest?.('[data-drill-kind]');
                if (!cell) return;
                void openDashboardUserDrilldown({
                    kind: cell.dataset.drillKind,
                    scope: cell.dataset.drillScope,
                    keys: String(cell.dataset.drillKeys || '').split(',').filter(Boolean),
                    label: cell.dataset.drillLabel || '',
                    shownCount: Number(cell.dataset.drillCount) || 0,
                    view: cell.dataset.drillView || 'list'
                });
            });
            tableBound = true;
        }
    }
    if (!modalBound) {
        const modal = document.getElementById('dashboardUserListModal');
        const closeBtn = document.getElementById('dashboardUserListModalClose');
        const newOnly = document.getElementById('dashboardUserListNewOnly');
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) closeDashboardUserDrilldown();
            });
            document.addEventListener('keydown', (e) => {
                if (e.key !== 'Escape') return;
                // 상세가 위에 떠 있으면 그것부터 닫는다
                const detail = document.getElementById('dashboardUserDetailModal');
                if (detail && !detail.classList.contains('hidden')) {
                    closeDashboardUserDetail();
                    return;
                }
                if (!modal.classList.contains('hidden')) closeDashboardUserDrilldown();
            });
            modalBound = true;
        }
        if (closeBtn) closeBtn.addEventListener('click', closeDashboardUserDrilldown);
        if (newOnly) {
            newOnly.addEventListener('change', () => {
                currentNewOnly = newOnly.checked;
                renderDrilldownRows();
            });
        }
        const dropoutOnly = document.getElementById('dashboardUserListDropoutOnly');
        if (dropoutOnly) {
            dropoutOnly.addEventListener('change', () => {
                currentDropoutOnly = dropoutOnly.checked;
                renderDrilldownMatrix();
            });
        }
        document
            .getElementById('dashboardUserListViewList')
            ?.addEventListener('click', () => setDrilldownView('list'));
        document
            .getElementById('dashboardUserListViewMatrix')
            ?.addEventListener('click', () => setDrilldownView('matrix'));
        document
            .getElementById('dashboardUserListViewCohort')
            ?.addEventListener('click', () => setDrilldownView('cohort'));

        // 목록·표는 매번 innerHTML 로 다시 그리므로 위임으로 한 번만 건다
        const listBody = document.getElementById('dashboardUserListBody');
        const openFromEvent = (e) => {
            const el = e.target?.closest?.('[data-user-detail]');
            if (!el) return;
            e.preventDefault();
            void openDashboardUserDetail(el.dataset.userDetail, el.dataset.userNickname || '');
        };
        listBody?.addEventListener('click', openFromEvent);
        listBody?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') openFromEvent(e);
        });

        ensureUserDetailModalBinding();
    }
}

/**
 * 상세 팝업만 따로 쓰는 화면(모먼트 관리의 작성자 메뉴)이 있어 목록 모달과 분리해 건다.
 * ESC는 목록 모달이 닫혀 있을 때만 여기서 처리한다 — 목록이 떠 있으면 그쪽 핸들러가
 * 「상세 먼저, 그다음 목록」 순서를 이미 지킨다.
 */
function ensureUserDetailModalBinding() {
    if (detailModalBound) return;
    const detailModal = document.getElementById('dashboardUserDetailModal');
    if (!detailModal) return;
    detailModal.addEventListener('click', (e) => {
        if (e.target === detailModal) closeDashboardUserDetail();
    });
    document.getElementById('dashboardUserDetailClose')?.addEventListener('click', closeDashboardUserDetail);
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (detailModal.classList.contains('hidden')) return;
        const list = document.getElementById('dashboardUserListModal');
        if (list && !list.classList.contains('hidden')) return;
        closeDashboardUserDetail();
    });
    detailModalBound = true;
}

// ============================================================
// 팝업
// ============================================================

export function closeDashboardUserDrilldown() {
    const modal = document.getElementById('dashboardUserListModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    openSeq++; // 진행 중인 조회 결과가 닫힌 팝업에 그려지지 않게
}

/**
 * 상한 없는 읽기는 팝업을 「불러오는 중…」에 영구히 묶어 둘 수 있다.
 * 실패·지연은 null 로 정착시켜 「명단 캐시 없음」 안내까지 반드시 도달하게 한다.
 */
async function fetchDrilldownDoc(id) {
    if (drilldownDocCache.has(id)) return drilldownDocCache.get(id);
    const data = await withDeadlineOr(
        async () => {
            const snap = await getDoc(DRILLDOWN_DOC(id));
            return snap.exists() ? snap.data() : null;
        },
        DEADLINE.DOC,
        null,
        `dashboard-drilldown:${id}`
    );
    drilldownDocCache.set(id, data);
    return data;
}

/** 'YYYY-MM-DD'(일요일) → '2주' 같은 짧은 열 제목 (전체 라벨의 첫 줄) */
function shortWeekLabel(sundayKey) {
    const p = String(sundayKey).split('-');
    if (p.length !== 3) return sundayKey;
    const d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
    if (Number.isNaN(d.getTime())) return sundayKey;
    return String(weekLabelKoreanFromSunday(d)).split('\n')[0];
}

/** 'YYYY-MM-DD' → 'M/D' */
function shortDayLabel(dateKey) {
    const p = String(dateKey).split('-');
    return p.length === 3 ? `${parseInt(p[1], 10)}/${parseInt(p[2], 10)}` : String(dateKey);
}

function dateFromKey(key) {
    const p = String(key).split('-');
    if (p.length !== 3) return null;
    const d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 오늘이 그 주 안에 있으면 아직 진행 중이다.
 * 이걸 안 보면 주가 막 시작된 일요일 아침에 아직 안 찍은 전원이 「1주째 없음」이 된다.
 */
function weekIsInProgress(sundayKey, todayKey) {
    const sun = dateFromKey(sundayKey);
    if (!sun) return false;
    const satKey = dateKeyFromLocalDate(new Date(sun.getFullYear(), sun.getMonth(), sun.getDate() + 6));
    return todayKey >= sundayKey && todayKey <= satKey;
}

/**
 * 칸이 가리키는 기간을 하위 구간 단위로 펼쳐서 돌려준다.
 * 명단 보기는 이걸 합집합으로 쓰고, 기간별 표는 열 하나씩으로 쓴다 —
 * 두 화면이 같은 원본을 보므로 서로 어긋날 수 없다.
 * @returns {Promise<{ periods: Array<{key:string,label:string,active:Set,new:Set}>, missing:number }>}
 */
async function collectPeriodsForCell({ scope, keys }) {
    const todayKey = getTodayDateString();
    if (scope === 'all') {
        const d = await fetchDrilldownDoc(DOC_ID_ALL);
        if (!d) return { periods: [], missing: 1 };
        return {
            periods: [
                { key: 'all', label: '전체', active: new Set(d.active || []), new: new Set(d.new || []) }
            ],
            missing: 0
        };
    }

    if (scope === 'day' || scope === 'last7') {
        const d = await fetchDrilldownDoc(DOC_ID_LAST7);
        if (!d?.byDate) return { periods: [], missing: 1 };
        const dates = scope === 'last7' ? d.dates || [] : keys;
        const periods = dates.map((dk) => {
            const e = d.byDate[dk] || {};
            return {
                key: dk,
                label: shortDayLabel(dk),
                active: new Set(e.active || []),
                new: new Set(e.new || []),
                // 이 기능 이전에 저장된 문서에는 없다 → null 이면 화면이 ● 로 되돌아간다
                counts: e.counts && typeof e.counts === 'object' ? e.counts : null,
                inProgress: dk === todayKey
            };
        });
        return { periods, missing: 0 };
    }

    // week / month — 주차 문서 하나가 곧 열 하나
    const periods = [];
    let missing = 0;
    for (const sk of keys) {
        const d = await fetchDrilldownDoc(sk);
        if (!d) {
            missing++;
            // 문서가 없는 주는 「그 주에 아무도 없었다」로 그린다 (열 자체는 유지해야 이탈이 보인다)
            periods.push({
                key: sk,
                label: shortWeekLabel(sk),
                active: new Set(),
                new: new Set(),
                counts: {},
                inProgress: weekIsInProgress(sk, todayKey)
            });
            continue;
        }
        periods.push({
            key: sk,
            label: shortWeekLabel(sk),
            active: new Set(d.active || []),
            new: new Set(d.new || []),
            // 이 기능 이전에 저장된 문서에는 없다 → null 이면 화면이 ● 로 되돌아간다
            counts: d.dayCounts && typeof d.dayCounts === 'object' ? d.dayCounts : null,
            inProgress: weekIsInProgress(sk, todayKey)
        });
    }
    return { periods, missing: missing === keys.length ? 1 : 0 };
}


/** users/{uid}/config/settings에서 닉네임·아이콘. users.js의 표시 규칙과 동일 */
async function resolveProfiles(uids) {
    hydrateProfileCache();
    const need = uids.filter((u) => !profileCache.has(u));
    /** 이번 조회에서 실패한 uid만 담는다 (세션 캐시를 오염시키지 않기 위해) */
    const failedThisRun = new Map();
    const CHUNK = 20;
    for (let i = 0; i < need.length; i += CHUNK) {
        await Promise.all(
            need.slice(i, i + CHUNK).map(async (uid) => {
                const p = await withDeadlineOr(
                    async () => {
                        const snap = await getDoc(
                            doc(db, 'artifacts', appId, 'users', uid, 'config', 'settings')
                        );
                        if (!snap.exists()) return { nickname: '탈퇴/삭제됨', icon: '👤' };
                        const s = snap.data() || {};
                        let nickname = '미설정';
                        if (s.profile && s.profileCompleted === true) {
                            const pn = s.profile.nickname;
                            if (pn != null && String(pn).trim() !== '' && pn !== '게스트') nickname = String(pn);
                        }
                        return { nickname, icon: s.profile?.icon || '🐻' };
                    },
                    DEADLINE.DOC,
                    null,
                    'dashboard-drilldown:nickname'
                );
                // 실패는 캐시에 남기지 않는다 — 다음에 팝업을 열면 다시 시도한다
                if (p) profileCache.set(uid, { ...p, t: Date.now() });
                else failedThisRun.set(uid, { nickname: '조회 실패', icon: '👤' });
            })
        );
    }
    if (need.length > 0) persistProfileCache();
    return failedThisRun;
}

function setModalText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function formatJoinKey(joinKey) {
    if (!joinKey) return '가입일 없음';
    const p = String(joinKey).split('-');
    return p.length === 3 ? `${p[0].slice(2)}.${p[1]}.${p[2]} 가입` : String(joinKey);
}

/** 표의 좁은 열용 — '26.08.03' */
function formatJoinKeyCompact(joinKey) {
    if (!joinKey) return '—';
    const p = String(joinKey).split('-');
    return p.length === 3 ? `${p[0].slice(2)}.${p[1]}.${p[2]}` : String(joinKey);
}

export async function openDashboardUserDrilldown({ kind, scope, keys, label, shownCount = 0, view = 'list' }) {
    const modal = document.getElementById('dashboardUserListModal');
    if (!modal) return;
    const seq = ++openSeq;

    currentKind = kind;
    currentUnit = scope === 'last7' || scope === 'day' ? '일' : '주';
    currentRows = [];
    currentMatrixRows = [];
    currentPeriods = [];
    currentNewOnly = false;
    currentDropoutOnly = false;

    const kindLabel = kind === 'newUsers' ? '신규 사용자' : '활성 사용자';
    currentCellTitle = `${kindLabel} · ${label}`;
    setModalText('dashboardUserListModalTitle', currentCellTitle);
    setModalText('dashboardUserListSummary', '불러오는 중…');
    const body = document.getElementById('dashboardUserListBody');
    if (body) {
        body.innerHTML =
            '<div class="py-10 text-center text-sm text-slate-400"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>명단을 불러오는 중…</div>';
    }
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');

    const [{ periods, missing }, allDoc] = await Promise.all([
        collectPeriodsForCell({ scope, keys }),
        fetchDrilldownDoc(DOC_ID_ALL)
    ]);
    if (seq !== openSeq) return;

    if (missing) {
        setModalText('dashboardUserListSummary', '명단 캐시 없음');
        syncDrilldownToolbar(0);
        if (body) {
            body.innerHTML =
                '<div class="py-10 text-center text-sm text-slate-500">이 기간의 명단 캐시가 아직 없습니다.<br class="my-1">상단 「새로고침」을 한 번 눌러 주세요.</div>';
        }
        return;
    }

    currentPeriods = periods;
    const { active, fresh } = unionOfPeriods(periods);
    const joinKeys = allDoc?.joinKeys || {};

    // 명단 보기 대상과 표 보기 대상(가입만 하고 한 번도 안 쓴 사람 포함)을 한 번에 조회한다
    const listUids = kind === 'newUsers' ? [...fresh] : [...active];
    const matrixUids = [...new Set([...active, ...fresh])];
    const failedProfiles = await resolveProfiles([...new Set([...listUids, ...matrixUids])]);
    if (seq !== openSeq) return;
    const profileOf = (uid) => profileCache.get(uid) || failedProfiles.get(uid);

    currentRows = sortListRows(
        listUids.map((uid) => {
            const p = profileOf(uid);
            return {
                uid,
                joinKey: joinKeys[uid] || '',
                isNew: fresh.has(uid),
                nickname: p?.nickname || '미설정',
                icon: p?.icon || '🐻'
            };
        })
    );

    currentMatrixRows = sortMatrixRows(
        matrixUids.map((uid) =>
            buildMatrixRow(uid, periods, profileOf(uid), joinKeys[uid] || '', fresh.has(uid))
        )
    );

    const activeCount = active.size;
    const newCount = fresh.size;
    const newActiveCount = [...fresh].filter((u) => active.has(u)).length;
    // 명단은 마지막 「새로고침」 시점 기준이다. 표의 오늘 칸은 캐시 보정으로 더 최신일 수 있어
    // 숫자가 어긋날 수 있는데, 조용히 어긋나면 표를 못 믿게 되므로 명시한다.
    const listCount = kind === 'newUsers' ? newCount : activeCount;
    const staleNote =
        shownCount > 0 && shownCount !== listCount
            ? ` · ⚠ 표의 숫자(${shownCount.toLocaleString()})와 다릅니다 — 명단은 마지막 「새로고침」 기준`
            : '';
    if (kind === 'activeUsers') {
        const rate = newCount > 0 ? ` · 신규 활성화율 ${((newActiveCount / newCount) * 100).toFixed(1)}%` : '';
        currentListSummary =
            `활성 ${activeCount.toLocaleString()}명 · 이 중 신규 ${newActiveCount.toLocaleString()}명 ` +
            `(같은 기간 신규 ${newCount.toLocaleString()}명 중)${rate}${staleNote}`;
    } else {
        currentListSummary = `신규 ${newCount.toLocaleString()}명 · 이 중 같은 기간에 기록을 남긴 사용자 ${newActiveCount.toLocaleString()}명${staleNote}`;
    }

    // 하위 구간이 2개 이상일 때만 「기간별 표」가 의미 있다
    currentView = periods.length >= 2 && view === 'matrix' ? 'matrix' : 'list';
    syncDrilldownToolbar(periods.length);
    renderDrilldownBody();
}

/** 모드 토글·필터를 현재 상태에 맞춘다 */
function syncDrilldownToolbar(periodCount) {
    const viewWrap = document.getElementById('dashboardUserListViewWrap');
    // 코호트는 클릭한 칸과 무관하게 늘 볼 수 있으므로, 주차 정보만 있으면 토글을 띄운다
    if (viewWrap) viewWrap.classList.toggle('hidden', periodCount < 2 && allWeekKeys.length < 2);
    const activeCls = 'px-2.5 py-1 text-xs font-bold rounded-lg bg-emerald-600 text-white';
    const idleCls = 'px-2.5 py-1 text-xs font-bold rounded-lg text-slate-500 hover:bg-slate-200';
    const btnList = document.getElementById('dashboardUserListViewList');
    const btnMatrix = document.getElementById('dashboardUserListViewMatrix');
    const btnCohort = document.getElementById('dashboardUserListViewCohort');
    if (btnList) btnList.className = currentView === 'list' ? activeCls : idleCls;
    if (btnMatrix) {
        btnMatrix.className = currentView === 'matrix' ? activeCls : idleCls;
        btnMatrix.classList.toggle('hidden', periodCount < 2);
    }
    if (btnCohort) {
        btnCohort.className = currentView === 'cohort' ? activeCls : idleCls;
        btnCohort.classList.toggle('hidden', allWeekKeys.length < 2);
    }

    const newOnlyWrap = document.getElementById('dashboardUserListNewOnlyWrap');
    if (newOnlyWrap) {
        newOnlyWrap.classList.toggle('hidden', currentView !== 'list' || currentKind !== 'activeUsers');
    }
    const dropoutWrap = document.getElementById('dashboardUserListDropoutWrap');
    if (dropoutWrap) dropoutWrap.classList.toggle('hidden', currentView !== 'matrix');
    const newOnlyEl = document.getElementById('dashboardUserListNewOnly');
    if (newOnlyEl) newOnlyEl.checked = currentNewOnly;
    const dropoutEl = document.getElementById('dashboardUserListDropoutOnly');
    if (dropoutEl) dropoutEl.checked = currentDropoutOnly;

    const legend = document.getElementById('dashboardUserListLegend');
    if (legend) {
        if (currentView === 'cohort') {
            legend.textContent =
                '숫자 = 그 주에 기록을 남긴 비율 · 빗금 칸 = 진행 중인 주(평균에서 제외) · 오른쪽일수록 표본 코호트가 적다';
        } else if (currentView === 'matrix') {
            const base =
                currentUnit === '주'
                    ? '숫자 = 그 주 기록 일수 (진할수록 많음) · 테두리 = 그 주에 가입'
                    : '숫자 = 그날 기록 건수 (진할수록 많음) · 테두리 = 그날 가입';
            const hasInProgress = currentPeriods.some((p) => p.inProgress);
            legend.textContent = hasInProgress ? `${base} · * = 진행 중 (이탈 판정 제외)` : base;
        } else {
            legend.textContent = '초록 배경 = 같은 기간 가입한 신규 사용자';
        }
    }
}

function setDrilldownView(view) {
    if (currentView === view) return;
    currentView = view;
    syncDrilldownToolbar(currentPeriods.length);
    renderDrilldownBody();
}

function renderDrilldownBody() {
    if (currentView === 'cohort') {
        void renderDrilldownCohort();
        return;
    }
    // 코호트는 클릭한 칸과 무관한 화면이라 제목을 바꿔 두었다 — 돌아오면 되돌린다
    if (currentCellTitle) setModalText('dashboardUserListModalTitle', currentCellTitle);
    if (currentView === 'matrix') renderDrilldownMatrix();
    else renderDrilldownRows();
}

/**
 * 코호트는 클릭한 칸이 아니라 전 구간의 주차 문서를 본다 (주차 수만큼 읽기, 이후 캐시).
 * 나머지 화면과 같은 명단 문서를 쓰므로 숫자가 갈라지지 않는다.
 */
async function loadCohortTable() {
    if (cohortCache) return cohortCache;
    const allDoc = await fetchDrilldownDoc(DOC_ID_ALL);
    if (!allDoc) return null;
    const docs = [];
    for (const sk of allWeekKeys) {
        docs.push(await fetchDrilldownDoc(sk));
    }
    const lastKey = allWeekKeys[allWeekKeys.length - 1];
    cohortCache = buildCohortTable({
        weekKeys: allWeekKeys,
        joinKeyByUid: allDoc.joinKeys || {},
        activeSetsByWeek: docs.map((d) => new Set(d?.active || [])),
        lastWeekInProgress: weekIsInProgress(lastKey, getTodayDateString())
    });
    return cohortCache;
}

async function renderDrilldownCohort() {
    const body = document.getElementById('dashboardUserListBody');
    if (!body) return;
    const seq = ++openSeq;
    setModalText('dashboardUserListModalTitle', '코호트 리텐션 · 가입 주차별');
    if (!cohortCache) {
        setModalText('dashboardUserListSummary', '불러오는 중…');
        body.innerHTML =
            '<div class="py-10 text-center text-sm text-slate-400"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>주차별 명단을 모으는 중…</div>';
    }
    const t = await loadCohortTable();
    if (seq !== openSeq) return;
    if (!t || t.rows.length === 0) {
        setModalText('dashboardUserListSummary', '코호트를 만들 데이터가 없습니다');
        body.innerHTML =
            '<div class="py-10 text-center text-sm text-slate-500">명단 캐시가 없거나 집계 구간 안에 가입자가 없습니다.<br class="my-1">상단 「새로고침」을 한 번 눌러 주세요.</div>';
        return;
    }
    const total = t.rows.reduce((s, r) => s + r.size, 0);
    const w1 = t.totals[1];
    const headline = w1 && w1.size > 0 ? ` · 가입 다음 주 잔존 ${Math.round(w1.rate * 100)}%` : '';
    const skipped = [];
    if (t.excludedBefore > 0) skipped.push(`집계 시작 이전 가입 ${t.excludedBefore}명`);
    if (t.excludedNoJoin > 0) skipped.push(`가입일 없음 ${t.excludedNoJoin}명`);
    setModalText(
        'dashboardUserListSummary',
        `코호트 ${t.rows.length}개 · 대상 ${total.toLocaleString()}명${headline}` +
            (skipped.length ? ` — 제외: ${skipped.join(', ')}` : '')
    );
    body.innerHTML = buildCohortTableHtml(t);
}

function renderDrilldownRows() {
    setModalText('dashboardUserListSummary', currentListSummary);
    const body = document.getElementById('dashboardUserListBody');
    if (!body) return;
    const rows = currentNewOnly ? currentRows.filter((r) => r.isNew) : currentRows;
    if (rows.length === 0) {
        body.innerHTML = '<div class="py-10 text-center text-sm text-slate-400">표시할 사용자가 없습니다.</div>';
        return;
    }
    body.innerHTML = rows
        .map((r, i) => {
            const rowCls = r.isNew
                ? 'bg-emerald-50/70 border-emerald-100'
                : 'bg-white border-slate-100 hover:bg-slate-50';
            const badge = r.isNew
                ? '<span class="px-1.5 py-0.5 bg-emerald-600 text-white text-[10px] font-black rounded shrink-0">신규</span>'
                : '';
            return `
                <div class="flex items-center gap-2 px-3 py-2 border-b ${rowCls}">
                    <span class="w-7 text-[11px] text-slate-400 tabular-nums shrink-0">${i + 1}</span>
                    <span class="text-base shrink-0">${escapeHtml(r.icon)}</span>
                    <span class="font-bold text-sm text-slate-800 truncate cursor-pointer underline decoration-dotted underline-offset-2 hover:text-emerald-700" ${nameTriggerAttrs(r.uid, r.nickname)}>${escapeHtml(r.nickname)}</span>
                    ${badge}
                    <span class="ml-auto flex items-center gap-2 shrink-0">
                        <span class="text-[11px] text-slate-500 tabular-nums">${escapeHtml(formatJoinKey(r.joinKey))}</span>
                        <code class="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded max-w-[10rem] truncate">${escapeHtml(r.uid)}</code>
                    </span>
                </div>`;
        })
        .join('');
}

function statusCellHtml(r, unit) {
    if (r.status === 'kept') {
        return '<span class="px-1.5 py-0.5 bg-emerald-100 text-emerald-700 text-[10px] font-black rounded whitespace-nowrap">계속</span>';
    }
    if (r.status === 'none') {
        return '<span class="px-1.5 py-0.5 bg-slate-100 text-slate-500 text-[10px] font-black rounded whitespace-nowrap">기록 없음</span>';
    }
    return `<span class="px-1.5 py-0.5 bg-amber-100 text-amber-700 text-[10px] font-black rounded whitespace-nowrap">${r.gap}${unit}째 없음</span>`;
}

/**
 * 구간별 출석 표의 HTML. DOM·Firestore를 만지지 않아 가짜 데이터로 그대로 확인할 수 있다.
 * @param {Array<{key:string,label:string}>} periods
 * @param {Array<object>} rows buildMatrixRow 결과
 * @param {'주'|'일'} unit
 */
/** heatLevel 0~4 → 칸 배경. Tailwind 가 훑을 수 있도록 문자열을 통째로 둔다 */
const HEAT_CLASSES = [
    'text-slate-200',
    'bg-emerald-50 text-emerald-700',
    'bg-emerald-100 text-emerald-800',
    'bg-emerald-200 text-emerald-900',
    'bg-emerald-300 text-emerald-900'
];

/**
 * 출석 표의 칸 하나.
 * - count 가 null: 이 기능 이전에 저장된 문서 → 예전처럼 ● 로 (0 으로 칠하면 결번처럼 보인다)
 * - 그 구간에 가입: 테두리로 표시 (배경은 이미 농도에 쓰고 있다)
 */
function markCellHtml(m, max, unit) {
    // 가입한 구간은 기록이 없어도 테두리를 남긴다 — 「가입은 했는데 그 구간에 한 번도 안 썼다」가
    // 이탈 분석에서 제일 보고 싶은 칸이다
    const ring = m.joined ? ' ring-1 ring-inset ring-emerald-500' : '';
    const joinPrefix = m.joined ? '이 구간에 가입 · ' : '';
    const emptyCell = `<td class="px-1 py-1.5 text-center text-slate-200${ring}"${m.joined ? ' title="이 구간에 가입 · 기록 없음"' : ''}>·</td>`;

    if (m.count == null) {
        if (!m.active) return emptyCell;
        return `<td class="px-1 py-1.5 text-center text-slate-700 font-black${ring}" title="${joinPrefix}기록 수는 「새로고침」 후부터 표시됩니다">●</td>`;
    }
    if (!m.active || m.count <= 0) return emptyCell;
    const unitWord = unit === '주' ? '일 기록' : '건 기록';
    return `<td class="px-1 py-1.5 text-center font-black tabular-nums ${HEAT_CLASSES[heatLevel(m.count, max)]}${ring}" title="${joinPrefix}${m.count}${unitWord}">${m.count}</td>`;
}

export function buildMatrixTableHtml(periods, rows, unit) {
    if (!rows?.length) {
        return '<div class="py-10 text-center text-sm text-slate-400">표시할 사용자가 없습니다.</div>';
    }
    const max = maxMarkCount(rows);
    const headCells = periods
        .map((p) => {
            // 진행 중인 구간은 아직 채워질 시간이 남았다. 확정 구간과 섞어 보면 이탈로 오독한다
            const cls = p.inProgress ? 'text-amber-600 italic' : 'text-slate-600';
            const mark = p.inProgress ? '*' : '';
            const tip = p.inProgress ? `${p.key} · 진행 중 (이탈 판정에서 제외)` : p.key;
            return `<th class="px-1 py-1.5 text-center font-bold ${cls} text-[10px] min-w-[2.5rem] whitespace-nowrap" title="${escapeHtml(tip)}">${escapeHtml(p.label)}${mark}</th>`;
        })
        .join('');

    const bodyRows = rows
        .map((r, i) => {
            const cells = r.marks.map((m) => markCellHtml(m, max, unit)).join('');
            const rowCls =
                r.status === 'kept'
                    ? 'bg-white hover:bg-slate-50'
                    : r.status === 'gap'
                      ? 'bg-amber-50/50 hover:bg-amber-50'
                      : 'bg-slate-50 hover:bg-slate-100';
            const badge = r.isNew
                ? '<span class="px-1 py-0.5 bg-emerald-600 text-white text-[9px] font-black rounded shrink-0">신규</span>'
                : '';
            return `
                <tr class="border-b border-slate-100 ${rowCls}">
                    <td class="px-2 py-1.5 text-[11px] text-slate-400 tabular-nums text-right">${i + 1}</td>
                    <td class="px-2 py-1.5 sticky left-0 z-10 ${r.status === 'kept' ? 'bg-white' : r.status === 'gap' ? 'bg-amber-50/50' : 'bg-slate-50'}">
                        <span class="flex items-center gap-1.5 min-w-0">
                            <span class="text-sm shrink-0">${escapeHtml(r.icon)}</span>
                            <span class="font-bold text-xs text-slate-800 truncate max-w-[8rem] cursor-pointer underline decoration-dotted underline-offset-2 hover:text-emerald-700" ${nameTriggerAttrs(r.uid, r.nickname)}>${escapeHtml(r.nickname)}</span>
                            ${badge}
                        </span>
                    </td>
                    <td class="px-2 py-1.5 text-center text-[10px] text-slate-500 tabular-nums whitespace-nowrap" title="${escapeHtml(formatJoinKey(r.joinKey))}">${escapeHtml(formatJoinKeyCompact(r.joinKey))}</td>
                    ${cells}
                    <td class="px-2 py-1.5 text-center text-[10px] text-slate-500 tabular-nums">${r.activeCount}/${periods.length}</td>
                    <td class="px-2 py-1.5 text-center">${statusCellHtml(r, unit)}</td>
                </tr>`;
        })
        .join('');

    return `
        <div class="overflow-x-auto">
            <table class="w-full text-left border-separate border-spacing-0">
                <thead class="bg-slate-50 sticky top-0 z-20">
                    <tr class="border-b border-slate-200">
                        <th class="px-2 py-1.5"></th>
                        <th class="px-2 py-1.5 text-left font-bold text-slate-600 text-[10px] sticky left-0 z-10 bg-slate-50">사용자</th>
                        <th class="px-2 py-1.5 text-center font-bold text-slate-600 text-[10px] whitespace-nowrap">가입일</th>
                        ${headCells}
                        <th class="px-2 py-1.5 text-center font-bold text-slate-600 text-[10px] whitespace-nowrap">활동</th>
                        <th class="px-2 py-1.5 text-center font-bold text-slate-600 text-[10px] whitespace-nowrap">상태</th>
                    </tr>
                </thead>
                <tbody>${bodyRows}</tbody>
            </table>
        </div>`;
}

// ============================================================
// 사용자 상세 (목록·표에서 이름 클릭)
// ============================================================

function fmtDateTime(v) {
    if (!v) return '-';
    const d = v instanceof Date ? v : v?.toDate ? v.toDate() : new Date(v);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
}

/** 가입~마지막 로그인 경과 (사용자 관리의 「활동일수」와 같은 표기) */
function fmtActivitySpan(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return '-';
    const totalHours = Math.floor(ms / (1000 * 60 * 60));
    return `${Math.floor(totalHours / 24)}일 ${String(totalHours % 24).padStart(2, '0')}시간`;
}

function detailRow(label, valueHtml) {
    return `
        <div class="flex items-start gap-3 py-2 border-b border-slate-100 last:border-b-0">
            <span class="w-[5.5rem] shrink-0 text-[11px] font-bold text-slate-500 pt-0.5">${escapeHtml(label)}</span>
            <span class="flex-1 min-w-0 text-xs text-slate-800 break-words">${valueHtml}</span>
        </div>`;
}

/** 「사용자 관리」와 같은 항목을 세로로. DOM·Firestore를 안 만져 가짜 데이터로 확인할 수 있다 */
export function buildUserDetailHtml(u) {
    const badge = (text, cls) =>
        `<span class="inline-block px-1.5 py-0.5 text-[10px] font-black rounded ${cls}">${escapeHtml(text)}</span>`;
    const loginBadge =
        u.loginMethod === '구글'
            ? badge('구글', 'bg-red-100 text-red-700')
            : u.loginMethod === '카카오'
              ? badge('카카오', 'bg-[#FEE500] text-[#191919]')
              : badge(u.loginMethod, 'bg-slate-100 text-slate-700');

    const terms = u.termsAgreed
        ? badge('동의', 'bg-emerald-100 text-emerald-700') +
          (u.termsVersion ? ` <span class="text-[11px] text-slate-500">v${escapeHtml(String(u.termsVersion))}</span>` : '') +
          (u.termsAgreedAt ? ` <span class="text-[11px] text-slate-400">${escapeHtml(fmtDateTime(u.termsAgreedAt))}</span>` : '')
        : badge('미동의', 'bg-amber-100 text-amber-700');

    const bans = [];
    if (u.bannedShare) bans.push(badge('공유 금지', 'bg-red-100 text-red-700'));
    if (u.bannedWrite) bans.push(badge('작성 금지', 'bg-red-100 text-red-700'));
    const banHtml = bans.length ? bans.join(' ') : '<span class="text-slate-400">없음</span>';

    const genderText = u.gender === 'male' ? '남성' : u.gender === 'female' ? '여성' : '-';
    const plain = (v) => (v ? escapeHtml(String(v)) : '<span class="text-slate-400">-</span>');

    return `
        ${u.deleteRequested ? `<div class="mb-2 px-2 py-1.5 bg-red-50 border border-red-200 rounded-lg text-[11px] font-bold text-red-700">탈퇴(삭제) 요청이 접수된 사용자입니다.</div>` : ''}
        ${detailRow('이메일', plain(u.email))}
        ${detailRow('로그인 방법', loginBadge)}
        ${detailRow('생년월일', plain(u.birthdate))}
        ${detailRow('성별', plain(genderText === '-' ? '' : genderText))}
        ${detailRow('라이프스타일', plain(u.lifestyle))}
        ${detailRow('약관 동의', terms)}
        ${detailRow('프로필 완료', u.profileCompleted ? badge('완료', 'bg-emerald-100 text-emerald-700') : badge('미완료', 'bg-slate-100 text-slate-600'))}
        ${detailRow('가입일', escapeHtml(fmtDateTime(u.createdAtResolved || u.createdAt)))}
        ${detailRow('마지막 로그인', escapeHtml(fmtDateTime(u.lastLoginAt)))}
        ${detailRow('활동일수', escapeHtml(fmtActivitySpan(u.signupToLastLoginMs)))}
        ${detailRow('활동 제한', banHtml)}
        ${detailRow(
            '기록 수',
            `<span class="inline-flex gap-3 tabular-nums">
                <span>타임라인 <b class="text-slate-900">${u.timelineCount ?? 0}</b></span>
                <span>앨범 공유 <b class="text-slate-900">${u.albumShareCount ?? 0}</b></span>
                <span>토크 <b class="text-slate-900">${u.talkCount ?? 0}</b></span>
            </span>`
        )}`;
}

export function closeDashboardUserDetail() {
    const m = document.getElementById('dashboardUserDetailModal');
    if (!m) return;
    m.classList.add('hidden');
    m.setAttribute('aria-hidden', 'true');
    detailSeq++;
}

export async function openDashboardUserDetail(uid, fallbackNickname) {
    const modal = document.getElementById('dashboardUserDetailModal');
    const body = document.getElementById('dashboardUserDetailBody');
    if (!modal || !body) return;
    ensureUserDetailModalBinding();
    const seq = ++detailSeq;

    setModalText('dashboardUserDetailTitle', fallbackNickname || '사용자 정보');
    setModalText('dashboardUserDetailSub', uid);
    body.innerHTML =
        '<div class="py-8 text-center text-sm text-slate-400"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>불러오는 중…</div>';
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');

    // 상한 없는 조회는 팝업을 「불러오는 중…」에 영구히 묶어 둘 수 있다
    const u = await withDeadlineOr(
        () => fetchAdminUserDetail(uid),
        DEADLINE.SAVE,
        undefined,
        'dashboard-drilldown:user-detail'
    );
    if (seq !== detailSeq) return;

    if (u === undefined) {
        body.innerHTML =
            '<div class="py-8 text-center text-sm text-slate-500">정보를 불러오지 못했습니다.<br class="my-1">잠시 후 다시 눌러 주세요.</div>';
        return;
    }
    if (u === null) {
        body.innerHTML =
            '<div class="py-8 text-center text-sm text-slate-500">설정 문서가 없는 사용자입니다.<br class="my-1">(탈퇴 후 기록만 남은 상태)</div>';
        return;
    }
    setModalText('dashboardUserDetailTitle', `${u.icon || ''} ${u.nickname}`.trim());
    body.innerHTML = buildUserDetailHtml(u);
}

/** 목록·표의 이름을 누를 수 있게 하는 공통 속성 */
function nameTriggerAttrs(uid, nickname) {
    return `data-user-detail="${escapeHtml(uid)}" data-user-nickname="${escapeHtml(nickname)}" role="button" tabindex="0" title="사용자 정보 보기"`;
}

/** 잔존율 0~1 → 배경. 여기서는 표 최대값이 아니라 절대 비율로 나눈다 (100%가 기준선) */
function retentionHeatClass(rate) {
    if (rate >= 0.75) return 'bg-emerald-300 text-emerald-900';
    if (rate >= 0.5) return 'bg-emerald-200 text-emerald-900';
    if (rate >= 0.25) return 'bg-emerald-100 text-emerald-800';
    if (rate > 0) return 'bg-emerald-50 text-emerald-700';
    return 'text-slate-300';
}

/** 'YYYY-MM-DD'(일요일) → '3월 2주' */
function cohortRowLabel(sundayKey) {
    const p = String(sundayKey).split('-');
    if (p.length !== 3) return sundayKey;
    return `${parseInt(p[1], 10)}월 ${shortWeekLabel(sundayKey)}`;
}

/**
 * 가입 주차 × 경과 주차 삼각표.
 * 열이 「달력 주」가 아니라 「가입 후 N주차」라 코호트끼리 바로 비교된다.
 */
export function buildCohortTableHtml(t) {
    const headCells = Array.from(
        { length: t.maxSpan },
        (_, j) =>
            `<th class="px-1 py-1.5 text-center font-bold text-slate-600 text-[10px] min-w-[2.75rem] whitespace-nowrap">${j === 0 ? '가입주' : `+${j}주`}</th>`
    ).join('');

    const rowHtml = (label, size, cells, isTotal) => {
        const tds = Array.from({ length: t.maxSpan }, (_, j) => {
            const c = cells[j];
            if (!c) return '<td class="px-1 py-1.5"></td>';
            // 확정 칸이 하나도 없는 평균 열(최신 코호트의 진행 중 칸만 있던 열)은 숫자를 만들지 않는다
            if (isTotal && c.size === 0) {
                return '<td class="px-1 py-1.5 text-center text-slate-300 text-[11px]" title="아직 확정된 코호트가 없습니다">—</td>';
            }
            const pct = Math.round(c.rate * 100);
            const tip = isTotal
                ? `${c.active}/${c.size}명 · 코호트 ${c.cohorts}개`
                : `${c.active}/${size}명${c.provisional ? ' · 진행 중인 주 (평균에서 제외)' : ''}`;
            const cls = c.provisional
                ? 'text-amber-700 italic opacity-70 bg-amber-50'
                : retentionHeatClass(c.rate);
            return `<td class="px-1 py-1.5 text-center font-black tabular-nums text-[11px] ${cls}" title="${tip}">${pct}%${c.provisional ? '*' : ''}</td>`;
        }).join('');
        const rowCls = isTotal ? 'bg-slate-100 border-t-2 border-slate-300' : 'bg-white hover:bg-slate-50';
        return `
            <tr class="border-b border-slate-100 ${rowCls}">
                <td class="px-2 py-1.5 sticky left-0 z-10 ${isTotal ? 'bg-slate-100' : 'bg-white'} font-bold text-xs text-slate-700 whitespace-nowrap">${escapeHtml(label)}</td>
                <td class="px-2 py-1.5 text-center text-[10px] text-slate-500 tabular-nums">${size.toLocaleString()}</td>
                ${tds}
            </tr>`;
    };

    const body = t.rows
        .map((r) => rowHtml(cohortRowLabel(r.weekKey), r.size, r.cells, false))
        .join('');
    const totalSize = t.rows.reduce((s, r) => s + r.size, 0);
    const totalRow = rowHtml('가중 평균', totalSize, t.totals, true);

    return `
        <div class="overflow-x-auto">
            <table class="w-full text-left border-separate border-spacing-0">
                <thead class="bg-slate-50 sticky top-0 z-20">
                    <tr class="border-b border-slate-200">
                        <th class="px-2 py-1.5 text-left font-bold text-slate-600 text-[10px] sticky left-0 z-10 bg-slate-50 whitespace-nowrap">가입 주차</th>
                        <th class="px-2 py-1.5 text-center font-bold text-slate-600 text-[10px] whitespace-nowrap">인원</th>
                        ${headCells}
                    </tr>
                </thead>
                <tbody>${body}${totalRow}</tbody>
            </table>
        </div>`;
}

function renderDrilldownMatrix() {
    const body = document.getElementById('dashboardUserListBody');
    if (!body) return;
    const all = currentMatrixRows;
    const s = summarizeMatrix(all);
    setModalText(
        'dashboardUserListSummary',
        `${currentPeriods.length}개 ${currentUnit} 구간 · 대상 ${s.total.toLocaleString()}명 — ` +
            `계속 ${s.kept.toLocaleString()} · 중단 ${s.gap.toLocaleString()} · 기록 없음 ${s.none.toLocaleString()}`
    );
    const rows = currentDropoutOnly ? all.filter((r) => r.status !== 'kept') : all;
    body.innerHTML = buildMatrixTableHtml(currentPeriods, rows, currentUnit);
}
