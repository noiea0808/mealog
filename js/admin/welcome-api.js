/**
 * 관리자 > 콘텐츠 관리 > 웰컴_API — 연속 기록자 조회 (Callable)
 * 서버는 항상 2일 이상 조건으로 한 번만 받아 두고, 3·4·5일은 캐시에서 필터합니다.
 * 목록 불러오기 버튼을 눌렀을 때만 서버를 조회합니다.
 */
import { callableFunctions } from '../firebase.js';

/** API에 넘기는 최소 연속 일수 (넓게 조회 후 클라이언트에서 좁힘) */
const WELCOME_API_SERVER_STREAK_MIN = 2;

let welcomeApiBound = false;
/** 목록 재조회 전까지 유지 — 제미나이 배치용 */
let lastWelcomeApiRows = [];

/** @type {{ rows: object[], geminiByUid: Record<string, string>, meta: object, fetchedAt: number } | null} */
let welcomeApiListCache = null;

const WELCOME_BTN_SPINNER =
    '<i data-lucide="loader-circle" class="shrink-0 lucide-spin" aria-hidden="true"></i>';

function setRowGeminiButtonsDisabled(disabled) {
    document.querySelectorAll('.welcome-api-gemini-one').forEach((b) => {
        b.disabled = disabled;
    });
}

function setWelcomeRefreshLoading(on) {
    const btn = document.getElementById('adminWelcomeApiRefreshBtn');
    const gem = document.getElementById('adminWelcomeApiGeminiBtn');
    if (!btn) return;
    if (on) {
        if (!btn.dataset.welcomeIdleHtml) btn.dataset.welcomeIdleHtml = btn.innerHTML.trim();
        btn.disabled = true;
        btn.innerHTML = `${WELCOME_BTN_SPINNER}<span>불러오는 중…</span>`;
        if (gem) gem.disabled = true;
        setRowGeminiButtonsDisabled(true);
    } else {
        btn.disabled = false;
        btn.innerHTML = btn.dataset.welcomeIdleHtml || '목록 불러오기';
        btn.dataset.welcomeIdleHtml = '';
        if (gem) gem.disabled = false;
        setRowGeminiButtonsDisabled(false);
    }
}

/**
 * @param {{ loading: boolean, progressText?: string }} opts
 */
function setWelcomeGeminiButtonState(opts) {
    const btn = document.getElementById('adminWelcomeApiGeminiBtn');
    const ref = document.getElementById('adminWelcomeApiRefreshBtn');
    if (!btn) return;
    if (opts.loading) {
        if (!btn.dataset.welcomeIdleHtml) btn.dataset.welcomeIdleHtml = btn.innerHTML.trim();
        btn.disabled = true;
        const t = opts.progressText || '생성 중…';
        btn.innerHTML = `${WELCOME_BTN_SPINNER}<span>${t}</span>`;
        if (ref) ref.disabled = true;
        setRowGeminiButtonsDisabled(true);
    } else {
        btn.disabled = false;
        btn.innerHTML = btn.dataset.welcomeIdleHtml || '제미나이 코멘트 생성';
        btn.dataset.welcomeIdleHtml = '';
        if (ref) ref.disabled = false;
        setRowGeminiButtonsDisabled(false);
    }
}

function getSelectedStreakFilter() {
    const el = document.querySelector('input[name="adminWelcomeApiStreak"]:checked');
    const v = el ? Number(el.value) : 2;
    return [2, 3, 4, 5].includes(v) ? v : 2;
}

function filterWelcomeRowsByStreak(rows, minStreak) {
    return rows.filter((r) => (Number(r.streakDays) || 0) >= minStreak);
}

/** 서버가 내려준 저장된 제미나이 코멘트(Firestore) */
function buildGeminiByUidFromRows(rows) {
    const geminiByUid = {};
    if (!Array.isArray(rows)) return geminiByUid;
    rows.forEach((r) => {
        const g = r.welcomeGeminiComment;
        if (g != null && String(g).trim()) geminiByUid[r.uid] = String(g).trim();
    });
    return geminiByUid;
}

function escapeCell(s) {
    if (s == null || s === '') return '-';
    const t = String(s);
    return t
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatFetchedAt(ts) {
    if (!ts) return '';
    try {
        const d = new Date(ts);
        return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    } catch {
        return '';
    }
}

/** 닉네임+성별(한 줄, 닉네임 뒤 공백 2칸) · 이메일 · UID · 생년월일 · 가입일 */
function renderMergedUserCell(u) {
    const nick = escapeCell(u.nickname);
    const gender = escapeCell(u.genderLabel ?? u.gender);
    const em = escapeCell(u.email);
    const uid = escapeCell(u.uid);
    return `<div class="flex flex-col gap-1 min-w-0 w-max max-w-[min(40rem,calc(100vw-12rem))]">
<div class="flex flex-wrap items-baseline min-w-0">
<span class="font-bold text-slate-800">${nick}</span>&nbsp;&nbsp;<span class="text-sm text-slate-600 shrink-0 tabular-nums">${gender}</span>
</div>
<span class="text-slate-600 break-all text-sm">${em}</span>
<span class="font-mono text-[11px] text-slate-500 break-all">${uid}</span>
<span class="text-xs text-slate-700">${escapeCell(u.birthdate)}</span>
<span class="text-xs text-slate-700 whitespace-nowrap">${escapeCell(u.joinDate)}</span>
</div>`;
}

/** 총 기록일수 / 연속 기록 (줄바꿈) */
function renderTotalsCell(u) {
    const total = u.totalRecordDays ?? 0;
    const streak = u.streakDays ?? '-';
    return `<div class="flex flex-col items-center justify-center gap-0.5 text-center tabular-nums leading-tight py-0.5">
<span class="text-slate-800">${total}</span>
<span class="font-semibold text-emerald-700">${streak}</span>
</div>`;
}

/**
 * @param {object[]} rows 필터 적용 후 표시 행
 * @param {object} resMeta
 * @param {number} fetchedAt
 * @param {boolean} fromCache
 * @param {{ displayMin?: number, baseCount?: number }} opts baseCount = 서버 2일+ 전체 인원
 */
function buildStatusLine(rows, resMeta, fetchedAt, fromCache, opts = {}) {
    const displayMin = opts.displayMin ?? getSelectedStreakFilter();
    const baseCount = typeof opts.baseCount === 'number' ? opts.baseCount : null;
    const meta = resMeta?.asOfSeoulDate
        ? ` (기준일 서울: ${resMeta.asOfSeoulDate}, 검사 ${resMeta.scannedUserCount ?? 0}명)`
        : '';
    const time = formatFetchedAt(fetchedAt);
    const cacheHint =
        fromCache && time ? ` · ${time} 조회분 (저장됨)` : time ? ` · ${time} 조회` : '';
    let filterHint = '';
    if (baseCount != null && displayMin > 2) {
        filterHint = ` — ${displayMin}일 이상만 표시 (2일+ ${baseCount}명 중)`;
    }
    return `${rows.length}명 표시${filterHint}${meta}${cacheHint}`;
}

/**
 * @param {object[]} rows
 * @param {Record<string, string>} geminiByUid
 */
function renderWelcomeApiTableRows(rows, geminiByUid) {
    if (rows.length === 0) {
        return '<tr><td colspan="5" class="px-3 py-6 align-middle text-center text-sm text-slate-500">조건에 맞는 사용자가 없습니다.</td></tr>';
    }
    return rows
        .map((u, i) => {
            const num = i + 1;
            const sumRaw =
                u.recentThreeDaysForGemini != null && String(u.recentThreeDaysForGemini).trim()
                    ? String(u.recentThreeDaysForGemini)
                    : u.recentThreeDaysSummary != null
                      ? String(u.recentThreeDaysSummary)
                      : '';
            const gem = geminiByUid[u.uid];
            const hasGem = gem != null && String(gem).trim() !== '';
            const gemTextBlock = hasGem
                ? `<div class="welcome-api-gemini-text whitespace-pre-wrap break-words text-violet-900">${escapeCell(gem)}</div>`
                : `<div class="welcome-api-gemini-text text-slate-400">—</div>`;
            const sumTrim = sumRaw.trim();
            const summaryCellInner =
                sumTrim === ''
                    ? '<span class="text-slate-400">-</span>'
                    : `<div class="flex flex-col gap-1 min-h-0 max-w-[24rem]">
<div class="text-xs text-slate-700 whitespace-pre-wrap break-words line-clamp-5 leading-snug min-h-[5.25rem]">${escapeCell(sumRaw)}</div>
<button type="button" class="welcome-api-summary-more self-start text-xs font-bold text-emerald-600 hover:text-emerald-800 underline decoration-emerald-300 underline-offset-2" data-summary-row="${i}">더보기</button>
</div>`;
            return `<tr class="border-t border-slate-100 hover:bg-slate-50/80" data-welcome-row="${i}">
<td class="px-2 py-2 align-middle text-center text-slate-600">${num}</td>
<td class="px-2 py-2 align-middle min-w-0 w-auto">${renderMergedUserCell(u)}</td>
<td class="px-2 py-2 align-middle">${renderTotalsCell(u)}</td>
<td class="px-2 py-2 align-top welcome-api-summary-cell">${summaryCellInner}</td>
<td class="px-2 py-2 align-middle text-sm welcome-api-gemini-cell max-w-[16rem] min-w-[10rem]">
<div class="flex flex-col gap-2 min-w-0">
${gemTextBlock}
<button type="button" class="welcome-api-gemini-one inline-flex items-center justify-center gap-1.5 min-h-[2rem] px-2.5 py-1 rounded-lg text-xs font-bold bg-violet-100 text-violet-800 hover:bg-violet-200 transition-colors disabled:opacity-50 disabled:pointer-events-none shrink-0 self-start" data-welcome-gemini-row="${i}">이 사용자만 생성</button>
</div>
</td>
</tr>`;
        })
        .join('');
}

/**
 * @param {boolean} fromCacheUi 라디오만 바꾼 경우 true · 막 서버에서 받은 경우 false
 */
function applyWelcomeApiViewFromCache(fromCacheUi = true) {
    const tbody = document.getElementById('adminWelcomeApiTableBody');
    const statusEl = document.getElementById('adminWelcomeApiStatus');
    if (!tbody || !welcomeApiListCache) return;

    const displayMin = getSelectedStreakFilter();
    const baseRows = welcomeApiListCache.rows;
    const filtered = filterWelcomeRowsByStreak(baseRows, displayMin);
    const gem = welcomeApiListCache.geminiByUid || {};

    lastWelcomeApiRows = filtered;
    tbody.innerHTML = renderWelcomeApiTableRows(filtered, gem);
    if (statusEl) {
        statusEl.textContent = buildStatusLine(
            filtered,
            welcomeApiListCache.meta,
            welcomeApiListCache.fetchedAt,
            fromCacheUi,
            { displayMin, baseCount: baseRows.length }
        );
    }
}

/**
 * @param {{ force?: boolean }} opts
 */
export async function loadAdminWelcomeApiPage(opts = {}) {
    const force = opts.force === true;
    const tbody = document.getElementById('adminWelcomeApiTableBody');
    const statusEl = document.getElementById('adminWelcomeApiStatus');
    const fn = callableFunctions.adminWelcomeStreakUsers;
    if (!fn || !tbody) return;

    if (!force) {
        if (welcomeApiListCache && Array.isArray(welcomeApiListCache.rows)) {
            applyWelcomeApiViewFromCache(true);
        }
        return;
    }

    setWelcomeRefreshLoading(true);
    tbody.innerHTML =
        '<tr><td colspan="5" class="px-3 py-6 align-middle text-center text-sm text-slate-500">불러오는 중…</td></tr>';
    if (statusEl) statusEl.textContent = '';
    lastWelcomeApiRows = [];

    try {
        const res = await fn({ streakDays: WELCOME_API_SERVER_STREAK_MIN });
        const rows = Array.isArray(res.data?.users) ? res.data.users : [];
        const resMeta = {
            asOfSeoulDate: res.data?.asOfSeoulDate,
            scannedUserCount: res.data?.scannedUserCount,
            streakDaysMin: res.data?.streakDaysMin
        };
        const fetchedAt = Date.now();

        welcomeApiListCache = {
            rows,
            geminiByUid: buildGeminiByUidFromRows(rows),
            meta: resMeta,
            fetchedAt
        };

        applyWelcomeApiViewFromCache(false);
    } catch (e) {
        console.error('웰컴_API 조회 실패:', e);
        tbody.innerHTML = `<tr><td colspan="5" class="px-3 py-6 align-middle text-center text-sm text-red-600">조회 실패: ${escapeCell(e?.message || e)}</td></tr>`;
        if (statusEl) statusEl.textContent = '';
        welcomeApiListCache = null;
    } finally {
        setWelcomeRefreshLoading(false);
    }
}

function setGeminiInCache(uid, comment) {
    if (!welcomeApiListCache) return;
    if (!welcomeApiListCache.geminiByUid) welcomeApiListCache.geminiByUid = {};
    welcomeApiListCache.geminiByUid[uid] = comment;
}

function setWelcomeApiGeminiRowUi(rowIdx, state, text) {
    const row = document.querySelector(`tr[data-welcome-row="${rowIdx}"]`);
    const textEl = row?.querySelector('.welcome-api-gemini-text');
    const btn = row?.querySelector('.welcome-api-gemini-one');
    if (!textEl) return;
    if (state === 'loading') {
        textEl.textContent = '… 작성 중';
        textEl.className = 'welcome-api-gemini-text text-slate-500 text-xs';
        if (btn) btn.disabled = true;
        return;
    }
    if (state === 'error') {
        textEl.textContent = text || '오류';
        textEl.className =
            'welcome-api-gemini-text text-red-600 whitespace-pre-wrap break-words text-xs';
        if (btn) btn.disabled = false;
        return;
    }
    const display = text && String(text).trim() !== '' ? String(text).trim() : '—';
    textEl.textContent = display;
    textEl.className =
        display === '—'
            ? 'welcome-api-gemini-text text-slate-400'
            : 'welcome-api-gemini-text whitespace-pre-wrap break-words text-violet-900';
    if (btn) btn.disabled = false;
}

async function runWelcomeApiGeminiOne(rowIdx) {
    const fn = callableFunctions.adminWelcomeGeminiComment;
    if (!fn) {
        alert('제미나이 함수를 불러올 수 없습니다. 배포를 확인하세요.');
        return;
    }
    if (!Number.isFinite(rowIdx) || rowIdx < 0 || rowIdx >= lastWelcomeApiRows.length) return;
    const u = lastWelcomeApiRows[rowIdx];
    setWelcomeApiGeminiRowUi(rowIdx, 'loading');
    try {
        const summaryForModel = (
            u.recentThreeDaysForGemini ||
            u.recentThreeDaysSummary ||
            ''
        ).trim();
        const res = await fn({
            userId: u.uid,
            summaryText: summaryForModel,
            streakDays: u.streakDays ?? 0,
            nickname: u.nickname && u.nickname !== '-' ? u.nickname : '',
            analysisAnchorSeoul: u.analysisAnchorSeoul || ''
        });
        const comment = res.data?.comment ?? '';
        const out = comment && String(comment).trim() !== '' ? String(comment).trim() : '—';
        setWelcomeApiGeminiRowUi(rowIdx, 'ok', out);
        setGeminiInCache(u.uid, out);
    } catch (err) {
        console.error(err);
        setWelcomeApiGeminiRowUi(rowIdx, 'error', '오류: ' + (err?.message || err));
    }
}

async function runWelcomeApiGeminiBatch() {
    const btn = document.getElementById('adminWelcomeApiGeminiBtn');
    const fn = callableFunctions.adminWelcomeGeminiComment;
    if (!btn) return;
    if (!fn) {
        alert('제미나이 함수를 불러올 수 없습니다. 배포를 확인하세요.');
        return;
    }
    if (!lastWelcomeApiRows.length) {
        alert('먼저 목록 불러오기로 사용자 목록을 가져오세요.');
        return;
    }
    if (
        !window.confirm(
            `표시 중 ${lastWelcomeApiRows.length}명에 대해 제미나이 코멘트를 생성합니다. 계속할까요?`
        )
    ) {
        return;
    }
    const total = lastWelcomeApiRows.length;
    try {
        for (let idx = 0; idx < total; idx++) {
            setWelcomeGeminiButtonState({
                loading: true,
                progressText: `생성 중 (${idx + 1}/${total})`
            });
            const u = lastWelcomeApiRows[idx];
            setWelcomeApiGeminiRowUi(idx, 'loading');
            try {
                const summaryForModel = (
                    u.recentThreeDaysForGemini ||
                    u.recentThreeDaysSummary ||
                    ''
                ).trim();
                const res = await fn({
                    userId: u.uid,
                    summaryText: summaryForModel,
                    streakDays: u.streakDays ?? 0,
                    nickname: u.nickname && u.nickname !== '-' ? u.nickname : '',
                    analysisAnchorSeoul: u.analysisAnchorSeoul || ''
                });
                const comment = res.data?.comment ?? '';
                const out =
                    comment && String(comment).trim() !== '' ? String(comment).trim() : '—';
                setWelcomeApiGeminiRowUi(idx, 'ok', out);
                setGeminiInCache(u.uid, out);
            } catch (err) {
                console.error(err);
                setWelcomeApiGeminiRowUi(idx, 'error', '오류: ' + (err?.message || err));
            }
        }
    } finally {
        setWelcomeGeminiButtonState({ loading: false });
    }
}

function openWelcomeApiSummaryModal(fullText) {
    const modal = document.getElementById('adminWelcomeApiSummaryModal');
    const body = document.getElementById('adminWelcomeApiSummaryModalBody');
    if (!modal || !body) return;
    body.textContent = fullText || '';
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
}

function closeWelcomeApiSummaryModal() {
    const modal = document.getElementById('adminWelcomeApiSummaryModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
}

export function bindAdminWelcomeApiOnce() {
    if (welcomeApiBound) return;
    welcomeApiBound = true;
    document.querySelectorAll('input[name="adminWelcomeApiStreak"]').forEach((radio) => {
        radio.addEventListener('change', () => {
            if (welcomeApiListCache && Array.isArray(welcomeApiListCache.rows)) {
                void loadAdminWelcomeApiPage({ force: false });
            }
        });
    });
    const refreshBtn = document.getElementById('adminWelcomeApiRefreshBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            void loadAdminWelcomeApiPage({ force: true });
        });
    }
    const geminiBtn = document.getElementById('adminWelcomeApiGeminiBtn');
    if (geminiBtn) {
        geminiBtn.addEventListener('click', () => {
            void runWelcomeApiGeminiBatch();
        });
    }

    const tbody = document.getElementById('adminWelcomeApiTableBody');
    if (tbody) {
        tbody.addEventListener('click', (e) => {
            const gemBtn = e.target.closest('.welcome-api-gemini-one');
            if (gemBtn) {
                const idx = Number(gemBtn.dataset.welcomeGeminiRow);
                if (Number.isFinite(idx) && idx >= 0 && idx < lastWelcomeApiRows.length) {
                    void runWelcomeApiGeminiOne(idx);
                }
                return;
            }
            const btn = e.target.closest('.welcome-api-summary-more');
            if (!btn) return;
            const idx = Number(btn.dataset.summaryRow);
            if (!Number.isFinite(idx) || idx < 0 || idx >= lastWelcomeApiRows.length) return;
            const u = lastWelcomeApiRows[idx];
            const full = (
                u.recentThreeDaysForGemini ||
                u.recentThreeDaysSummary ||
                ''
            ).trim();
            openWelcomeApiSummaryModal(full);
        });
    }

    const modal = document.getElementById('adminWelcomeApiSummaryModal');
    const modalClose = document.getElementById('adminWelcomeApiSummaryModalClose');
    if (modalClose) {
        modalClose.addEventListener('click', () => closeWelcomeApiSummaryModal());
    }
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeWelcomeApiSummaryModal();
        });
    }
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const m = document.getElementById('adminWelcomeApiSummaryModal');
        if (m && !m.classList.contains('hidden')) closeWelcomeApiSummaryModal();
    });
}
