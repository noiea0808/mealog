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
import { escapeHtml, weekLabelKoreanFromSunday } from './utils.js';
import { withDeadlineOr, DEADLINE } from '../utils/with-deadline.js';
import {
    unionOfPeriods,
    buildMatrixRow,
    sortMatrixRows,
    sortListRows,
    summarizeMatrix
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
/** uid → { nickname, icon } — 세션 동안 유지 */
const profileCache = new Map();

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
let currentNewOnly = false;
let currentDropoutOnly = false;

export function invalidateDashboardUserDrilldownCache() {
    drilldownDocCache.clear();
}

// ============================================================
// 저장 (「새로고침」 집계 직후)
// ============================================================

/**
 * getUserStatistics()가 만든 UID 집합을 drilldown 하위 문서로 저장.
 * @param {object} userSets stats.userSets — { weeks, last7, all }
 */
export async function writeDashboardUserDrilldown(userSets) {
    if (!userSets) return;
    const writes = [];

    for (const w of userSets.weeks || []) {
        if (!w?.sundayKey) continue;
        // 활동·가입이 모두 없는 주는 문서를 만들지 않는다 (없으면 0명으로 해석)
        if ((w.active?.length || 0) === 0 && (w.new?.length || 0) === 0) continue;
        writes.push([
            DRILLDOWN_DOC(w.sundayKey),
            { kind: 'week', sundayKey: w.sundayKey, active: w.active || [], new: w.new || [] }
        ]);
    }

    if (userSets.last7?.dates?.length === 7) {
        writes.push([
            DRILLDOWN_DOC(DOC_ID_LAST7),
            { kind: 'last7', dates: userSets.last7.dates, byDate: userSets.last7.byDate || {} }
        ]);
    }

    if (userSets.all) {
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
                if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeDashboardUserDrilldown();
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
    }
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

/**
 * 칸이 가리키는 기간을 하위 구간 단위로 펼쳐서 돌려준다.
 * 명단 보기는 이걸 합집합으로 쓰고, 기간별 표는 열 하나씩으로 쓴다 —
 * 두 화면이 같은 원본을 보므로 서로 어긋날 수 없다.
 * @returns {Promise<{ periods: Array<{key:string,label:string,active:Set,new:Set}>, missing:number }>}
 */
async function collectPeriodsForCell({ scope, keys }) {
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
                new: new Set(e.new || [])
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
            periods.push({ key: sk, label: shortWeekLabel(sk), active: new Set(), new: new Set() });
            continue;
        }
        periods.push({
            key: sk,
            label: shortWeekLabel(sk),
            active: new Set(d.active || []),
            new: new Set(d.new || [])
        });
    }
    return { periods, missing: missing === keys.length ? 1 : 0 };
}


/** users/{uid}/config/settings에서 닉네임·아이콘 (세션 캐시). users.js의 표시 규칙과 동일 */
async function resolveProfiles(uids) {
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
                if (p) profileCache.set(uid, p);
                else failedThisRun.set(uid, { nickname: '조회 실패', icon: '👤' });
            })
        );
    }
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
    setModalText('dashboardUserListModalTitle', `${kindLabel} · ${label}`);
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
    if (viewWrap) viewWrap.classList.toggle('hidden', periodCount < 2);
    const activeCls = 'px-2.5 py-1 text-xs font-bold rounded-lg bg-emerald-600 text-white';
    const idleCls = 'px-2.5 py-1 text-xs font-bold rounded-lg text-slate-500 hover:bg-slate-200';
    const btnList = document.getElementById('dashboardUserListViewList');
    const btnMatrix = document.getElementById('dashboardUserListViewMatrix');
    if (btnList) btnList.className = currentView === 'list' ? activeCls : idleCls;
    if (btnMatrix) btnMatrix.className = currentView === 'matrix' ? activeCls : idleCls;

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
        legend.textContent =
            currentView === 'matrix'
                ? `● 기록 있음 · 빈칸 없음 · 초록 = 그 ${currentUnit}에 가입`
                : '초록 배경 = 같은 기간 가입한 신규 사용자';
    }
}

function setDrilldownView(view) {
    if (currentView === view) return;
    currentView = view;
    syncDrilldownToolbar(currentPeriods.length);
    renderDrilldownBody();
}

function renderDrilldownBody() {
    if (currentView === 'matrix') renderDrilldownMatrix();
    else renderDrilldownRows();
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
                    <span class="font-bold text-sm text-slate-800 truncate">${escapeHtml(r.nickname)}</span>
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
export function buildMatrixTableHtml(periods, rows, unit) {
    if (!rows?.length) {
        return '<div class="py-10 text-center text-sm text-slate-400">표시할 사용자가 없습니다.</div>';
    }
    const headCells = periods
        .map(
            (p) =>
                `<th class="px-1 py-1.5 text-center font-bold text-slate-600 text-[10px] min-w-[2.5rem] whitespace-nowrap" title="${escapeHtml(p.key)}">${escapeHtml(p.label)}</th>`
        )
        .join('');

    const bodyRows = rows
        .map((r, i) => {
            const cells = r.marks
                .map((m) => {
                    if (!m.active) return '<td class="px-1 py-1.5 text-center text-slate-200">·</td>';
                    const cls = m.joined ? 'text-emerald-600' : 'text-slate-700';
                    const t = m.joined ? ' title="이 구간에 가입"' : '';
                    return `<td class="px-1 py-1.5 text-center ${cls} font-black"${t}>●</td>`;
                })
                .join('');
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
                            <span class="font-bold text-xs text-slate-800 truncate max-w-[8rem]" title="${escapeHtml(r.uid)}">${escapeHtml(r.nickname)}</span>
                            ${badge}
                        </span>
                    </td>
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
                        ${headCells}
                        <th class="px-2 py-1.5 text-center font-bold text-slate-600 text-[10px] whitespace-nowrap">활동</th>
                        <th class="px-2 py-1.5 text-center font-bold text-slate-600 text-[10px] whitespace-nowrap">상태</th>
                    </tr>
                </thead>
                <tbody>${bodyRows}</tbody>
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
