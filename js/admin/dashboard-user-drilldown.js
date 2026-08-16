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
import { escapeHtml } from './utils.js';
import { withDeadlineOr, DEADLINE } from '../utils/with-deadline.js';

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
/** 현재 팝업에 그려진 행 데이터 (신규만 보기 토글용) */
let currentRows = [];
let currentNewOnly = false;

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

export function clearDashboardDrilldownCell(td) {
    if (!td) return;
    if (!td.dataset.drillKind) return;
    delete td.dataset.drillKind;
    delete td.dataset.drillScope;
    delete td.dataset.drillKeys;
    delete td.dataset.drillLabel;
    delete td.dataset.drillCount;
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
                    shownCount: Number(cell.dataset.drillCount) || 0
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

/** 칸 하나가 가리키는 (활성 UID 합집합, 신규 UID 합집합) */
async function collectUidsForCell({ scope, keys }) {
    const active = new Set();
    const fresh = new Set();
    let missing = 0;

    if (scope === 'all') {
        const d = await fetchDrilldownDoc(DOC_ID_ALL);
        if (!d) return { active, fresh, missing: 1 };
        (d.active || []).forEach((u) => active.add(u));
        (d.new || []).forEach((u) => fresh.add(u));
        return { active, fresh, missing: 0 };
    }

    if (scope === 'day' || scope === 'last7') {
        const d = await fetchDrilldownDoc(DOC_ID_LAST7);
        if (!d?.byDate) return { active, fresh, missing: 1 };
        const dates = scope === 'last7' ? (d.dates || []) : keys;
        for (const dk of dates) {
            const e = d.byDate[dk];
            if (!e) continue;
            (e.active || []).forEach((u) => active.add(u));
            (e.new || []).forEach((u) => fresh.add(u));
        }
        return { active, fresh, missing: 0 };
    }

    // week / month — 주차 문서(들)의 합집합
    for (const sk of keys) {
        const d = await fetchDrilldownDoc(sk);
        if (!d) {
            missing++;
            continue;
        }
        (d.active || []).forEach((u) => active.add(u));
        (d.new || []).forEach((u) => fresh.add(u));
    }
    return { active, fresh, missing: missing === keys.length ? 1 : 0 };
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

export async function openDashboardUserDrilldown({ kind, scope, keys, label, shownCount = 0 }) {
    const modal = document.getElementById('dashboardUserListModal');
    if (!modal) return;
    const seq = ++openSeq;

    const kindLabel = kind === 'newUsers' ? '신규 사용자' : '활성 사용자';
    currentRows = [];
    currentNewOnly = false;
    const newOnlyEl = document.getElementById('dashboardUserListNewOnly');
    if (newOnlyEl) newOnlyEl.checked = false;
    const newOnlyWrap = document.getElementById('dashboardUserListNewOnlyWrap');
    if (newOnlyWrap) newOnlyWrap.classList.toggle('hidden', kind !== 'activeUsers');

    setModalText('dashboardUserListModalTitle', `${kindLabel} · ${label}`);
    setModalText('dashboardUserListSummary', '불러오는 중…');
    const body = document.getElementById('dashboardUserListBody');
    if (body) {
        body.innerHTML =
            '<div class="py-10 text-center text-sm text-slate-400"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>명단을 불러오는 중…</div>';
    }
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');

    const [{ active, fresh, missing }, allDoc] = await Promise.all([
        collectUidsForCell({ scope, keys }),
        fetchDrilldownDoc(DOC_ID_ALL)
    ]);
    if (seq !== openSeq) return;

    if (missing) {
        setModalText('dashboardUserListSummary', '명단 캐시 없음');
        if (body) {
            body.innerHTML =
                '<div class="py-10 text-center text-sm text-slate-500">이 기간의 명단 캐시가 아직 없습니다.<br class="my-1">상단 「새로고침」을 한 번 눌러 주세요.</div>';
        }
        return;
    }

    const joinKeys = allDoc?.joinKeys || {};
    const targetUids = kind === 'newUsers' ? [...fresh] : [...active];

    const failedProfiles = await resolveProfiles(targetUids);
    if (seq !== openSeq) return;

    currentRows = targetUids
        .map((uid) => {
            const p = profileCache.get(uid) || failedProfiles.get(uid);
            return {
                uid,
                joinKey: joinKeys[uid] || '',
                isNew: fresh.has(uid),
                nickname: p?.nickname || '미설정',
                icon: p?.icon || '🐻'
            };
        })
        // 신규를 위로, 그다음 가입일 최신순
        .sort((a, b) => {
            if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
            return String(b.joinKey).localeCompare(String(a.joinKey));
        });

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
        setModalText(
            'dashboardUserListSummary',
            `활성 ${activeCount.toLocaleString()}명 · 이 중 신규 ${newActiveCount.toLocaleString()}명 ` +
                `(같은 기간 신규 ${newCount.toLocaleString()}명 중)${rate}${staleNote}`
        );
    } else {
        setModalText(
            'dashboardUserListSummary',
            `신규 ${newCount.toLocaleString()}명 · 이 중 같은 기간에 기록을 남긴 사용자 ${newActiveCount.toLocaleString()}명${staleNote}`
        );
    }

    renderDrilldownRows();
}

function renderDrilldownRows() {
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
