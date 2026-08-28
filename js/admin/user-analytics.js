// 관리자 > 사용자 > 사용자 분석 (users 로컬 미러에서 집계)
//
// 예전에는 탭을 열 때마다 목록 화면과 같은 「풍부한」 전체 조회를 돌렸다. 분석이 쓰는
// 값은 생년월일·성별·라이프스타일·로그인수단·마지막로그인·가입간격뿐인데도 공유·게시글·
// 식사 카운트까지 함께 사 오던 구조였다. 지금은 users 미러(users-mirror.js)에서 읽고,
// 미러가 못 뜨면 예전 경로로 물러난다. — docs/admin-local-mirror.md
import { escapeHtml } from './utils.js';
import { fetchAllUsersForAdminAnalytics } from './users.js';
import { ensureUsersMirrorSynced, getAllUsersFromMirror } from './users-mirror.js';

const DAY_MS = 86400000;

function parseBirthdateToAge(birthdate) {
    const s = birthdate == null ? '' : String(birthdate).trim();
    if (!s) return null;
    const digits = s.replace(/\D/g, '');
    let y;
    let m;
    let d;
    if (digits.length === 8) {
        y = parseInt(digits.slice(0, 4), 10);
        m = parseInt(digits.slice(4, 6), 10);
        d = parseInt(digits.slice(6, 8), 10);
    } else {
        const t = Date.parse(s);
        if (!Number.isFinite(t)) return null;
        const dt = new Date(t);
        y = dt.getFullYear();
        m = dt.getMonth() + 1;
        d = dt.getDate();
    }
    if (!y || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const born = new Date(y, m - 1, d);
    const today = new Date();
    let age = today.getFullYear() - born.getFullYear();
    const md = today.getMonth() - born.getMonth();
    if (md < 0 || (md === 0 && today.getDate() < born.getDate())) age--;
    if (!Number.isFinite(age) || age < 0 || age > 120) return null;
    return age;
}

function ageToBand(age) {
    if (age == null) return '미입력·알 수 없음';
    if (age <= 19) return '19세 이하';
    if (age <= 29) return '20~29세';
    if (age <= 39) return '30~39세';
    if (age <= 49) return '40~49세';
    return '50세 이상';
}

function activitySpanBucket(user) {
    if (user.loginMethod === '게스트') return '게스트';
    const ms = user.signupToLastLoginMs;
    if (ms == null || !Number.isFinite(ms) || ms < 0) return '가입/로그인 정보 없음';
    const dayFloor = Math.floor(ms / DAY_MS);
    if (dayFloor <= 0) return '0일(24시간 미만)';
    if (dayFloor <= 7) return '1~7일';
    if (dayFloor <= 30) return '8~30일';
    if (dayFloor <= 365) return '31일~1년';
    return '1년 초과';
}

/** 마지막 로그인 시각이 최근 `days`일 이내인지 (없거나 파싱 불가면 false) */
function isLastLoginWithinDays(user, days) {
    const t = user.lastLoginAt;
    if (t == null) return false;
    const d = t instanceof Date ? t : new Date(t);
    const ms = d.getTime();
    if (!Number.isFinite(ms)) return false;
    const cutoff = Date.now() - days * DAY_MS;
    return ms >= cutoff;
}

/** UI·집계와 동일한 6종 + 미입력 (그 외 문자열은 기타로 묶음) */
const LIFESTYLE_ORDER = ['직장인', '프리랜서', '자영업', '주부', '학생', '기타', '미입력'];
const LIFESTYLE_EXACT = new Set(['직장인', '프리랜서', '자영업', '주부', '학생', '기타']);

function lifestyleLabel(user) {
    const v = user.lifestyle != null ? String(user.lifestyle).trim() : '';
    if (!v) return '미입력';
    if (LIFESTYLE_EXACT.has(v)) return v;
    return '기타';
}

function genderLabel(user) {
    if (user.gender === 'male') return '남';
    if (user.gender === 'female') return '여';
    return '미입력';
}

function incrementMap(map, key) {
    const k = key || '미입력';
    map.set(k, (map.get(k) || 0) + 1);
}

function mapToSortedEntries(map) {
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

/** 고정 순서 + 없으면 0명. 맵에만 있고 순서에 없는 키는 뒤에 인원 많은 순 */
function entriesInFixedOrder(map, orderedKeys) {
    const used = new Set(orderedKeys);
    const base = orderedKeys.map((k) => [k, map.get(k) || 0]);
    const extra = [...map.entries()]
        .filter(([k]) => !used.has(k))
        .sort((a, b) => b[1] - a[1]);
    return extra.length ? base.concat(extra) : base;
}

const GENDER_ORDER = ['남', '여', '미입력'];

/** 로그인: 구글 → 이메일 → 카카오 → 게스트(앱에 존재) → 미입력 */
const LOGIN_ORDER = ['구글', '이메일', '카카오', '게스트', '미입력'];

/** 활동일수: 긴 구간 → 짧은 구간 → 정보 없음 계열 */
const ACTIVITY_ORDER = [
    '1년 초과',
    '31일~1년',
    '8~30일',
    '1~7일',
    '0일(24시간 미만)',
    '게스트',
    '가입/로그인 정보 없음'
];

const AGE_BAND_MISS = '미입력·알 수 없음';

/** 나이대: 연령 높은 구간 → 낮은 구간, 미입력·알 수 없음 은 항상 맨 아래 */
const AGE_BAND_ORDER = ['50세 이상', '40~49세', '30~39세', '20~29세', '19세 이하', AGE_BAND_MISS];

function renderBarRow(label, count, total, pct, barFillClass = 'bg-emerald-500/90') {
    const safeLabel = escapeHtml(label);
    const fill = barFillClass || 'bg-emerald-500/90';
    return `
        <div class="flex flex-col gap-1 py-2 border-b border-slate-100 last:border-0">
            <div class="flex justify-between items-baseline gap-2 text-sm">
                <span class="font-medium text-slate-800 truncate" title="${safeLabel}">${safeLabel}</span>
                <span class="text-slate-600 tabular-nums shrink-0">${count.toLocaleString('ko-KR')}명 <span class="text-slate-400">(${pct}%)</span></span>
            </div>
            <div class="h-2 bg-slate-100 rounded-full overflow-hidden">
                <div class="h-full ${fill} rounded-full transition-[width] duration-300" style="width:${pct}%"></div>
            </div>
        </div>
    `;
}

function renderSection(
    title,
    map,
    total,
    orderedEntries,
    headerAddonHtml = '',
    barFillClass = 'bg-emerald-500/90',
    titleTrailHtml = ''
) {
    const entries = orderedEntries != null ? orderedEntries : mapToSortedEntries(map);
    if (total === 0) {
        return `
            <section class="bg-white border border-slate-100 rounded-xl p-4 shadow-sm">
                <h3 class="text-sm font-black text-slate-800 mb-1">${escapeHtml(title)}</h3>
                <p class="text-xs text-slate-400">데이터 없음</p>
            </section>
        `;
    }
    const fill = barFillClass || 'bg-emerald-500/90';
    const rows = entries
        .map(([label, count]) => {
            const pct = total > 0 ? Math.round((count / total) * 1000) / 10 : 0;
            return renderBarRow(label, count, total, pct, fill);
        })
        .join('');
    const addon = headerAddonHtml || '';
    const trail = titleTrailHtml || '';
    return `
        <section class="bg-white border border-slate-100 rounded-xl p-4 shadow-sm">
            <div class="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 mb-3">
                <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 min-w-0">
                    <h3 class="text-sm font-black text-slate-800">${escapeHtml(title)}</h3>
                    ${trail}
                </div>
                ${addon}
            </div>
            <div class="space-y-0">${rows}</div>
        </section>
    `;
}

function buildActivityMapFromUsers(users) {
    const activity = new Map();
    for (const u of users) {
        incrementMap(activity, activitySpanBucket(u));
    }
    return activity;
}

/** 분석 탭에서 재사용 — 새로 불러오기 전까지 유지 */
let _adminAnalyticsUsers = null;
let _activityFilterLastWeek = false;
/** 이번 표본을 어디서·몇 읽기로 가져왔는지 (미러 배지 표시용) */
let _analyticsLoadMeta = { source: 'mirror', serverReads: 0 };

function renderAdminUserAnalyticsPanel() {
    const mount = document.getElementById('adminUserAnalyticsMount');
    if (!mount || !_adminAnalyticsUsers || !Array.isArray(_adminAnalyticsUsers)) return;

    const users = _adminAnalyticsUsers;
    const n = users.length;
    const agg = buildAggregates(users);

    const activitySubset = _activityFilterLastWeek ? users.filter((u) => isLastLoginWithinDays(u, 7)) : users;
    const nActivity = activitySubset.length;
    const aggActivity = buildActivityMapFromUsers(activitySubset);

    const activityTitle = '활동일수(가입~마지막 로그인)';
    const activityBarFill = _activityFilterLastWeek ? 'bg-orange-500/90' : 'bg-emerald-500/90';
    const btnOn =
        'bg-orange-500 text-white border-orange-600 shadow-sm hover:bg-orange-600';
    const btnOff = 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50';
    const weekBtnClass = _activityFilterLastWeek ? btnOn : btnOff;
    const activitySumHtml = (() => {
        const sum = [...aggActivity.values()].reduce((a, c) => a + c, 0);
        const tone = _activityFilterLastWeek ? 'text-orange-700' : 'text-slate-600';
        return `<span class="text-sm font-bold tabular-nums shrink-0 ${tone}" title="구간별 인원 합계">총 ${sum.toLocaleString('ko-KR')}명</span>`;
    })();
    const activitySectionInner =
        nActivity === 0
            ? `
        <section class="bg-white border border-slate-100 rounded-xl p-4 shadow-sm">
            <div class="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 mb-2">
                <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 min-w-0">
                    <h3 class="text-sm font-black text-slate-800">${escapeHtml(activityTitle)}</h3>
                    <span class="text-sm font-bold tabular-nums shrink-0 ${_activityFilterLastWeek ? 'text-orange-700' : 'text-slate-500'}">총 0명</span>
                </div>
                <button type="button" id="adminUserAnalyticsActivityWeekBtn" class="admin-user-analytics-activity-week-btn shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${weekBtnClass}" aria-pressed="${_activityFilterLastWeek ? 'true' : 'false'}">
                    최근 1주일
                </button>
            </div>
            <p class="text-xs text-slate-400">${
                _activityFilterLastWeek
                    ? '마지막 로그인이 최근 7일 이내인 사용자가 없습니다.'
                    : '데이터 없음'
            }</p>
        </section>
    `
            : renderSection(
                  activityTitle,
                  aggActivity,
                  nActivity,
                  entriesInFixedOrder(aggActivity, ACTIVITY_ORDER),
                  `<button type="button" id="adminUserAnalyticsActivityWeekBtn" class="admin-user-analytics-activity-week-btn shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${weekBtnClass}" aria-pressed="${
                      _activityFilterLastWeek ? 'true' : 'false'
                  }">최근 1주일</button>`,
                  activityBarFill,
                  activitySumHtml
              );

    const footNote = _activityFilterLastWeek
        ? `활동일수 차트만 <strong class="text-slate-700">마지막 로그인 7일 이내 ${nActivity.toLocaleString('ko-KR')}명</strong>을 집계했습니다. 나머지 차트는 전체 ${n.toLocaleString('ko-KR')}명 기준입니다.`
        : `집계 대상 <strong class="text-slate-700">전체 ${n.toLocaleString('ko-KR')}명</strong> (Firestore <code class="text-[11px] bg-slate-100 px-1 rounded">users</code> 기준 전원).`;

    const sourceBadge =
        _analyticsLoadMeta.source === 'mirror'
            ? `<span class="px-2 py-1 rounded-lg bg-emerald-50 text-emerald-700 text-[11px] font-bold" title="로컬 미러에서 집계했습니다. 괄호 안은 이번에 실제로 산 Firestore 문서 수입니다.">미러 집계 · Firestore 읽기 ${Number(_analyticsLoadMeta.serverReads || 0).toLocaleString('ko-KR')}</span>`
            : `<span class="px-2 py-1 rounded-lg bg-amber-50 text-amber-700 text-[11px] font-bold" title="미러를 쓰지 못해 예전 전체 조회로 불러왔습니다.">서버 전체 조회</span>`;

    mount.innerHTML = `
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            ${renderSection('라이프스타일', agg.lifestyle, n, entriesInFixedOrder(agg.lifestyle, LIFESTYLE_ORDER))}
            ${renderSection('나이대', agg.ageBand, n, entriesInFixedOrder(agg.ageBand, AGE_BAND_ORDER))}
            ${renderSection('성별', agg.gender, n, entriesInFixedOrder(agg.gender, GENDER_ORDER))}
            ${renderSection('로그인 방법', agg.loginMethod, n, entriesInFixedOrder(agg.loginMethod, LOGIN_ORDER))}
            ${activitySectionInner}
        </div>
        <div class="mt-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <p class="text-xs text-slate-500 leading-relaxed min-w-0">
                ${footNote}
                사용자 관리 표는 페이지 단위로만 보일 수 있으며, 사용자 분석은 전원을 대상으로 계산합니다.
            </p>
            <div class="flex items-center gap-2 shrink-0">
                ${sourceBadge}
                <span class="text-[11px] text-slate-400" title="미러를 버리고 전체를 다시 읽는 「전체 재구축」은 모니터링 > 로컬 미러의 users 행에 있습니다.">재구축: 로컬 미러 메뉴</span>
            </div>
        </div>
    `;

    const weekBtn = mount.querySelector('#adminUserAnalyticsActivityWeekBtn');
    weekBtn?.addEventListener('click', () => {
        _activityFilterLastWeek = !_activityFilterLastWeek;
        renderAdminUserAnalyticsPanel();
    });
}

function buildAggregates(users) {
    const lifestyle = new Map();
    const ageBand = new Map();
    const gender = new Map();
    const loginMethod = new Map();
    const activity = new Map();
    for (const u of users) {
        incrementMap(lifestyle, lifestyleLabel(u));
        incrementMap(ageBand, ageToBand(parseBirthdateToAge(u.birthdate)));
        incrementMap(gender, genderLabel(u));
        incrementMap(loginMethod, u.loginMethod || '미입력');
        incrementMap(activity, activitySpanBucket(u));
    }
    return { lifestyle, ageBand, gender, loginMethod, activity };
}

/**
 * 미러에서 사용자 행을 얻는다 — 실패하면 예전 전체 조회로 물러난다.
 * @param {{force?: boolean}} options force 면 미러를 전체 재구축한다
 */
async function loadUsersForAnalytics(options = {}) {
    try {
        const sync = await ensureUsersMirrorSynced(
            (p) => {
                const el = document.getElementById('adminUserAnalyticsProgress');
                if (!el) return;
                el.textContent =
                    p.stage === 'full'
                        ? `미러 전체 구축 중… ${p.fetched.toLocaleString()}명`
                        : `미러 동기화 중… 변경 ${p.fetched.toLocaleString()}명`;
            },
            options
        );
        const users = await getAllUsersFromMirror();
        return { users, source: 'mirror', serverReads: sync.serverReads };
    } catch (e) {
        console.warn('[사용자 분석] 미러 실패 — 예전 전체 조회로 대체:', e);
        const users = await fetchAllUsersForAdminAnalytics();
        return { users, source: 'server', serverReads: null };
    }
}

/**
 * 사용자 분석 패널 갱신 — users 미러에서 읽어 집계합니다.
 * (사용자 관리 탭의 현재 페이지 캐시와 무관)
 * @param {{force?: boolean}} [options] force 면 미러를 전체 재구축한 뒤 집계
 */
export async function refreshAdminUserAnalytics(options = {}) {
    const mount = document.getElementById('adminUserAnalyticsMount');
    if (!mount) return;
    _adminAnalyticsUsers = null;
    _activityFilterLastWeek = false;
    mount.innerHTML = `
        <div class="text-center py-16 text-slate-500 text-sm">
            <i data-lucide="loader-circle" class="text-2xl mb-3 text-emerald-600 lucide-spin" aria-hidden="true"></i>
            <p class="font-medium text-slate-700" id="adminUserAnalyticsProgress">전체 사용자를 불러오는 중입니다…</p>
            <p class="text-xs text-slate-400 mt-2">인원이 많으면 잠시 걸릴 수 있습니다.</p>
        </div>
    `;
    let users;
    try {
        const loaded = await loadUsersForAnalytics(options);
        users = loaded.users;
        _analyticsLoadMeta = { source: loaded.source, serverReads: loaded.serverReads };
    } catch (e) {
        const errMsg = (e && (e.message || e.code || String(e))) || '알 수 없는 오류';
        mount.innerHTML = `
            <div class="text-center py-12 text-red-500 text-sm">
                <i data-lucide="triangle-alert" class="text-2xl mb-2" aria-hidden="true"></i>
                <p>전체 사용자를 불러오지 못했습니다.</p>
                <p class="text-xs text-slate-500 mt-2">${escapeHtml(errMsg)}</p>
            </div>
        `;
        return;
    }
    const n = users.length;
    if (n === 0) {
        mount.innerHTML = `
            <div class="text-center py-12 text-slate-400 text-sm">
                <p>등록된 사용자가 없습니다.</p>
            </div>
        `;
        return;
    }
    _adminAnalyticsUsers = users;
    _activityFilterLastWeek = false;
    renderAdminUserAnalyticsPanel();
}

function setSubmenuButtonState(which) {
    const manage = document.getElementById('adminUsersSubmenuManage');
    const analytics = document.getElementById('adminUsersSubmenuAnalytics');
    const active = 'px-4 py-2 rounded-lg text-sm font-bold transition-colors bg-white text-emerald-800 shadow-sm border border-slate-200/80';
    const idle = 'px-4 py-2 rounded-lg text-sm font-bold transition-colors text-slate-600 hover:text-slate-800 hover:bg-white/60';
    if (manage && analytics) {
        if (which === 'manage') {
            manage.className = active;
            manage.setAttribute('aria-selected', 'true');
            analytics.className = idle;
            analytics.setAttribute('aria-selected', 'false');
        } else {
            analytics.className = active;
            analytics.setAttribute('aria-selected', 'true');
            manage.className = idle;
            manage.setAttribute('aria-selected', 'false');
        }
    }
}

/**
 * 사용자 탭 하위: 사용자 관리 | 사용자 분석
 */
export function switchAdminUsersSubmenu(which) {
    const panelManage = document.getElementById('adminUsersPanelManage');
    const panelAnalytics = document.getElementById('adminUsersPanelAnalytics');
    if (!panelManage || !panelAnalytics) return;
    if (which === 'analytics') {
        panelManage.classList.add('hidden');
        panelAnalytics.classList.remove('hidden');
        setSubmenuButtonState('analytics');
        void refreshAdminUserAnalytics();
    } else {
        panelAnalytics.classList.add('hidden');
        panelManage.classList.remove('hidden');
        setSubmenuButtonState('manage');
    }
}
