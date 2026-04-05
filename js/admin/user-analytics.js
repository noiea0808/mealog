// 관리자 > 사용자 > 사용자 분석 (전체 사용자 Firestore 조회 후 집계)
import { escapeHtml } from './utils.js';
import { fetchAllUsersForAdminAnalytics } from './users.js';

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

function lifestyleLabel(user) {
    const v = user.lifestyle != null ? String(user.lifestyle).trim() : '';
    return v || '미입력';
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

function renderBarRow(label, count, total, pct) {
    const safeLabel = escapeHtml(label);
    return `
        <div class="flex flex-col gap-1 py-2 border-b border-slate-100 last:border-0">
            <div class="flex justify-between items-baseline gap-2 text-sm">
                <span class="font-medium text-slate-800 truncate" title="${safeLabel}">${safeLabel}</span>
                <span class="text-slate-600 tabular-nums shrink-0">${count.toLocaleString('ko-KR')}명 <span class="text-slate-400">(${pct}%)</span></span>
            </div>
            <div class="h-2 bg-slate-100 rounded-full overflow-hidden">
                <div class="h-full bg-emerald-500/90 rounded-full transition-[width] duration-300" style="width:${pct}%"></div>
            </div>
        </div>
    `;
}

function renderSection(title, map, total) {
    const entries = mapToSortedEntries(map);
    if (total === 0) {
        return `
            <section class="bg-white border border-slate-100 rounded-xl p-4 shadow-sm">
                <h3 class="text-sm font-black text-slate-800 mb-1">${escapeHtml(title)}</h3>
                <p class="text-xs text-slate-400">데이터 없음</p>
            </section>
        `;
    }
    const rows = entries
        .map(([label, count]) => {
            const pct = total > 0 ? Math.round((count / total) * 1000) / 10 : 0;
            return renderBarRow(label, count, total, pct);
        })
        .join('');
    return `
        <section class="bg-white border border-slate-100 rounded-xl p-4 shadow-sm">
            <h3 class="text-sm font-black text-slate-800 mb-3">${escapeHtml(title)}</h3>
            <div class="space-y-0">${rows}</div>
        </section>
    `;
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
 * 사용자 분석 패널 갱신 — 매번 Firestore에서 전체 사용자를 페이지 단위로 로드한 뒤 집계합니다.
 * (사용자 관리 탭의 현재 페이지 캐시와 무관)
 */
export async function refreshAdminUserAnalytics() {
    const mount = document.getElementById('adminUserAnalyticsMount');
    if (!mount) return;
    mount.innerHTML = `
        <div class="text-center py-16 text-slate-500 text-sm">
            <i class="fa-solid fa-spinner fa-spin text-2xl mb-3 text-emerald-600" aria-hidden="true"></i>
            <p class="font-medium text-slate-700">전체 사용자를 불러오는 중입니다…</p>
            <p class="text-xs text-slate-400 mt-2">인원이 많으면 잠시 걸릴 수 있습니다.</p>
        </div>
    `;
    let users;
    try {
        users = await fetchAllUsersForAdminAnalytics();
    } catch (e) {
        const errMsg = (e && (e.message || e.code || String(e))) || '알 수 없는 오류';
        mount.innerHTML = `
            <div class="text-center py-12 text-red-500 text-sm">
                <i class="fa-solid fa-exclamation-triangle text-2xl mb-2" aria-hidden="true"></i>
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
    const agg = buildAggregates(users);
    mount.innerHTML = `
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            ${renderSection('라이프스타일', agg.lifestyle, n)}
            ${renderSection('나이대', agg.ageBand, n)}
            ${renderSection('성별', agg.gender, n)}
            ${renderSection('로그인 방법', agg.loginMethod, n)}
            ${renderSection('활동일수(가입~마지막 로그인)', agg.activity, n)}
        </div>
        <p class="text-xs text-slate-500 mt-4 leading-relaxed">
            집계 대상 <strong class="text-slate-700">전체 ${n.toLocaleString('ko-KR')}명</strong> (Firestore <code class="text-[11px] bg-slate-100 px-1 rounded">users</code> 기준 전원).
            사용자 관리 표는 페이지 단위로만 보일 수 있으며, 이 분석은 항상 전원입니다.
        </p>
    `;
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
