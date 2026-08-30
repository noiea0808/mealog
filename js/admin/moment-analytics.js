/**
 * 관리자 모니터링: 모먼트 분석 — 항목별 입력률
 *
 * 모먼트 「관리」가 개별 기록을 다룬다면, 여기서는 그 기록들이 **얼마나 채워지는지**만 본다.
 * 어떻게·어디서·무엇을·누구와·만족도·포만감·사진·코멘트가 각각 몇 %나 입력되는지,
 * 그리고 그 비율이 기간에 따라 어떻게 움직이는지가 이 화면의 전부다.
 *
 * 읽기 비용: 로컬 미러(meals-mirror.js)에서 집계한다 — 실행 시 미러 증분 동기화
 * (변경분만 Firestore 읽기)를 거친 뒤 IndexedDB에서 기간을 자른다. 탭 진입만으로는
 * 아무것도 조회하지 않고, 「분석 실행」을 눌렀을 때만 움직인다(다른 관리자 화면과 같은 규칙).
 * 미러가 실패하면 예전 방식(기간 내 meals 전량 서버 스캔)으로 물러난다.
 *
 * 계산은 moment-analytics-model.js가 한다 — 여기는 조회와 그리기만.
 */
import { db, refreshAppCheckTokenBeforeFirestore } from '../firebase.js';
import {
    collectionGroup,
    getDocs,
    query,
    orderBy,
    limit,
    startAfter,
    where
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { escapeHtml, runAdminRefreshAction } from './utils.js';
import { ensureMealsMirrorSynced, getMealsInRange } from './meals-mirror.js';
import { getExcludedAnalyticsUidSet } from '../excluded-analytics-uids.js';
import { isDailyJournalMealRecord } from '../utils/daily-journal-data.js';
import { isMemoMealRecord } from '../utils/slot-plan.js';
import { refreshLucideIcons } from '../icons.js';
import {
    MOMENT_FIELD_SPECS,
    CORE_FIELD_SPECS,
    FOOD_PATH_SPECS,
    FOOD_SUGGEST_SPECS,
    AXIS_CHART_SLOTS,
    analyzeMomentRows,
    buildAxisBreakdown,
    shiftYmd,
    pct
} from './moment-analytics-model.js';
import { loadAdminTagLists } from './admin-tag-axes.js';

/** 한 번의 분석이 읽을 수 있는 meals 문서 상한 — 넘으면 기간을 좁히라고 알린다 */
const MOMENT_ANALYTICS_DOC_CAP = 20000;
/** Firestore 배치 크기 */
const MOMENT_ANALYTICS_BATCH = 1000;
/**
 * 같은 기간 재조회 방지 —— 이 화면의 한 번 실행은 기간 안의 meals 를 전부 읽는다.
 * 모먼트 관리 목록과는 쿼리가 달라 그쪽 캐시를 나눠 쓸 수 없으므로 여기서 따로 붙든다.
 * 만료 전이라도 「새로 읽기」로 언제든 다시 칠 수 있다.
 */
const MOMENT_ANALYTICS_CACHE_TTL_MS = 10 * 60 * 1000;
const momentAnalyticsCache = new Map();

/** 마지막 분석 결과 — 엑셀 내보내기용 */
let momentAnalyticsLastResult = null;
/** 그때의 meta — 태그 목록이 있어야 선택지 분포를 같은 순서로 내보낼 수 있다 */
let momentAnalyticsLastMeta = null;

function kstTodayYmd() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

/** 프리셋 선택 → 날짜 입력칸 동기화(직접 지정일 때만 열어 둔다) */
function syncMomentAnalyticsRangeInputs() {
    const preset = document.getElementById('momentAnalyticsPreset')?.value || '30';
    const startEl = document.getElementById('momentAnalyticsStartDate');
    const endEl = document.getElementById('momentAnalyticsEndDate');
    const wrap = document.getElementById('momentAnalyticsCustomRange');
    if (!startEl || !endEl || !wrap) return;
    const custom = preset === 'custom';
    wrap.classList.toggle('opacity-50', !custom);
    wrap.classList.toggle('pointer-events-none', !custom);
    if (!custom) {
        const today = kstTodayYmd();
        endEl.value = today;
        startEl.value = shiftYmd(today, -(parseInt(preset, 10) - 1));
    }
}

function readMomentAnalyticsRange() {
    const preset = document.getElementById('momentAnalyticsPreset')?.value || '30';
    const today = kstTodayYmd();
    if (preset !== 'custom') {
        const span = parseInt(preset, 10);
        return { startYmd: shiftYmd(today, -(span - 1)), endYmd: today };
    }
    const startYmd = document.getElementById('momentAnalyticsStartDate')?.value || '';
    const endYmd = document.getElementById('momentAnalyticsEndDate')?.value || '';
    if (!startYmd || !endYmd) {
        alert('시작일과 종료일을 모두 선택하세요.');
        return null;
    }
    if (startYmd > endYmd) {
        alert('시작일이 종료일보다 늦을 수 없습니다.');
        return null;
    }
    return { startYmd, endYmd };
}

/**
 * 기간 안의 meals 를 가져온다 — 1차: 로컬 미러, 실패 시: 서버 전량 스캔.
 *
 * 축은 **슬롯 날짜(date)** 다 — 관리자 트렌드의 「기록한 날짜(recordedAt)」와는 일부러 다르다.
 * 입력률은 "언제 눌렀나"가 아니라 "어느 끼니 칸이 채워졌나"를 묻는 값이라서다.
 *
 * @returns {{rows: object[], truncated: boolean, source: 'mirror'|'server', serverReads: number}}
 */
async function loadRowsForRange(startYmd, endYmd, onProgress) {
    try {
        const sync = await ensureMealsMirrorSynced((p) => {
            if (typeof onProgress !== 'function') return;
            onProgress(
                p.stage === 'bootstrap'
                    ? `미러 첫 구축 중(최초 1회)… ${p.fetched.toLocaleString()}건 다운로드`
                    : `미러 동기화 중… 변경분 ${p.fetched.toLocaleString()}건`
            );
        });
        const rows = await getMealsInRange(startYmd, endYmd);
        return { rows, truncated: false, source: 'mirror', serverReads: sync.fetched + sync.removed };
    } catch (e) {
        console.warn('[모먼트 분석] 미러 실패 — 서버 전량 스캔으로 대체:', e);
        const { rows, truncated } = await fetchMealsInRange(startYmd, endYmd, (n) => {
            if (typeof onProgress === 'function') onProgress(`서버에서 읽는 중… ${n.toLocaleString()}건`);
        });
        return { rows, truncated, source: 'server', serverReads: rows.length };
    }
}

/** 예전 방식(폴백 전용): 기간 안의 meals 문서를 배치로 모두 읽는다. */
async function fetchMealsInRange(startYmd, endYmd, onProgress) {
    const rows = [];
    let cursor = null;
    let truncated = false;
    await refreshAppCheckTokenBeforeFirestore();
    for (;;) {
        const parts = [where('date', '>=', startYmd), where('date', '<=', endYmd), orderBy('date', 'desc')];
        const q = cursor
            ? query(collectionGroup(db, 'meals'), ...parts, startAfter(cursor), limit(MOMENT_ANALYTICS_BATCH))
            : query(collectionGroup(db, 'meals'), ...parts, limit(MOMENT_ANALYTICS_BATCH));
        const snap = await getDocs(q);
        if (snap.empty) break;
        snap.docs.forEach((d) => {
            const pathParts = d.ref.path.split('/');
            const uidx = pathParts.indexOf('users');
            const userId = uidx >= 0 && pathParts.length > uidx + 1 ? pathParts[uidx + 1] : '';
            rows.push({ id: d.id, userId, ...d.data() });
        });
        cursor = snap.docs[snap.docs.length - 1];
        if (typeof onProgress === 'function') onProgress(rows.length);
        if (snap.size < MOMENT_ANALYTICS_BATCH) break;
        if (rows.length >= MOMENT_ANALYTICS_DOC_CAP) {
            truncated = true;
            break;
        }
    }
    return { rows, truncated };
}

const fmtPct = (v) => `${v.toFixed(1)}%`;

/** 입력률에 따른 셀 배경 — 낮을수록 붉고 높을수록 푸르다 */
function rateCellClass(rate) {
    if (rate >= 90) return 'bg-emerald-100 text-emerald-800';
    if (rate >= 70) return 'bg-emerald-50 text-emerald-700';
    if (rate >= 40) return 'bg-amber-50 text-amber-700';
    if (rate > 0) return 'bg-red-50 text-red-600';
    return 'text-slate-300';
}

/**
 * 반대로 읽는 값의 배경 — 미분류·추천 안 씀처럼 **높을수록 나쁜** 칸.
 *
 * 같은 눈금을 그대로 쓰면 미분류 90%가 초록으로 칠해진다. 색이 값의 크기가 아니라
 * 「좋은가」를 말하는 표라, 방향이 다른 열은 눈금도 뒤집어야 한다.
 */
function rateCellClassInverse(rate) {
    if (rate <= 0) return 'text-slate-300';
    if (rate <= 10) return 'bg-emerald-50 text-emerald-700';
    if (rate <= 30) return 'bg-amber-50 text-amber-700';
    return 'bg-red-50 text-red-600';
}

/**
 * 좋고 나쁨이 없는 값의 배경 — 「자동」·「자동적용」처럼 **크기만 말하면 되는** 칸.
 *
 * 초록/빨강 눈금을 주면 「자동이 많아서 좋다(혹은 나쁘다)」로 읽힌다. 둘 다 아니다 —
 * 사람이 채운 몫과 기계가 채운 몫의 **비중**일 뿐이라 판정을 얹으면 안 된다.
 * 그래서 색상은 한 계열(하늘색)로 묶고 진하기로만 크기를 말한다.
 */
function rateCellClassNeutral(rate) {
    if (rate <= 0) return 'text-slate-300';
    if (rate <= 10) return 'bg-sky-50 text-sky-700';
    if (rate <= 30) return 'bg-sky-100 text-sky-700';
    return 'bg-sky-200 text-sky-800';
}

function renderSummaryCards(result, meta) {
    const cards = [
        { label: '분석 대상 기록', value: result.overall.total.toLocaleString(), sub: '끼니·간식 기록(하루기록 제외)' },
        { label: '참여 사용자', value: result.userCount.toLocaleString(), sub: '기간 내 1건 이상 기록' },
        {
            label: '평균 입력 완성도',
            value: fmtPct(result.avgCompleteness * 100),
            sub: `핵심 ${CORE_FIELD_SPECS.length}항목 기준`
        },
        {
            label: meta.source === 'mirror' ? 'Firestore 읽기' : '읽은 문서(서버 스캔)',
            value: (meta.source === 'mirror' ? meta.serverReads : meta.readCount).toLocaleString(),
            sub:
                meta.source === 'mirror'
                    ? `미러 집계 ${meta.readCount.toLocaleString()}건 · 제외 ${meta.skippedCount.toLocaleString()}건`
                    : `제외 ${meta.skippedCount.toLocaleString()}건(하루기록·통계제외 UID)`
        }
    ];
    return `
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
            ${cards
                .map(
                    (c) => `
                <div class="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <p class="text-xs font-bold text-slate-500">${escapeHtml(c.label)}</p>
                    <p class="text-2xl font-black text-slate-800 mt-1">${escapeHtml(c.value)}</p>
                    <p class="text-[11px] text-slate-400 mt-1">${escapeHtml(c.sub)}</p>
                </div>`
                )
                .join('')}
        </div>`;
}

/**
 * 누적 바의 색 — 인접 대비가 검증된 8슬롯.
 *
 * 아홉 번째 색을 만들어 쓰지 않는다. 생성한 색은 색맹 조건에서 기존 색과 구별되지 않아
 * 검사(CVD ΔE)를 통째로 깨뜨린다. 슬롯을 넘는 선택지는 「그 외」로 접고, 정확한 값은
 * 바로 아래 표가 그대로 들고 있다 — 접힌 것이 사라지지는 않는다.
 *
 * 세 색(#1baf7a·#eda100·#e87ba4)은 흰 바탕 대비가 3:1 아래라 색만으로 세우면 안 된다.
 * 그래서 바에 직접 라벨을 얹고, 아래 표가 같은 색 스와치로 같은 값을 다시 센다.
 */
const AXIS_SLOT_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
/** 이름을 따로 세우지 않는 두 몫 — 색상 축이 아니라 밝기로만 갈린다 */
const AXIS_FOLDED_COLOR = '#94a3b8'; // slate-400 · 목록 안이지만 슬롯을 넘은 꼬리
const AXIS_OUTSIDE_COLOR = '#475569'; // slate-600 · 목록에 아예 없는 값
/** 미입력은 계열이 아니라 「남은 자리」다 — 트랙 색으로 둔다 */
const AXIS_EMPTY_COLOR = '#f1f5f9'; // slate-100

function axisSlotColor(slot) {
    return AXIS_SLOT_COLORS[slot] ?? AXIS_FOLDED_COLOR;
}

/** 칠 위에 얹는 글자색 — 밝은 칠에는 먹색, 어두운 칠에는 흰색 */
function inkOnFill(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lin = (c) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return L > 0.45 ? '#0f172a' : '#ffffff';
}

/**
 * 축 하나의 누적 바.
 *
 * **총 길이는 언제나 분석 대상 기록 100%다.** 축마다 제 입력분만큼만 칠해지고 나머지는
 * 미입력 트랙으로 남는다 — 그래서 축 넷을 위아래로 세우면 「어떻게는 절반 넘게 채워지고
 * 누구와는 그 절반」 같은 것이 길이 차이로 바로 보인다. 각 축을 100%로 늘려 그리면
 * 구성비는 보이지만 그 비교가 통째로 사라진다.
 *
 * 칸 사이의 2px 틈은 **칸 안쪽에서** 낸다(흰 테두리 + border-box). 바깥 여백으로 내면
 * 칸 수만큼 폭이 밀려 — 열 칸이면 20px, 좁은 화면에서 5% 넘게 — 길이가 곧 비율이라는
 * 이 그림의 전제가 깨진다.
 *
 * 라벨은 **여기서 넣지 않는다.** 들어갈지 말지는 픽셀 폭을 재야 알 수 있고, 그건 DOM 에
 * 붙은 뒤에만 가능하다(`fitAxisBarLabels`). 잘린 글자는 없는 것만 못하다.
 */
function renderAxisBar(axis) {
    const c = axis.chart;
    const seg = (label, n, rate, color, ink) => {
        if (!(rate > 0)) return '';
        const title = `${label} · ${n.toLocaleString()}건 · ${fmtPct(rate)}`;
        return `<div class="h-full flex items-center justify-center" data-seg-label="${escapeHtml(
            `${label} ${rate.toFixed(0)}%`
        )}" style="width:${rate}%;background:${color};min-width:4px;box-sizing:border-box;border-right:2px solid #fff"
                     title="${escapeHtml(title)}"><span class="text-[10px] font-bold whitespace-nowrap px-1" style="color:${
                         ink || inkOnFill(color)
                     }"></span></div>`;
    };

    const parts = [
        ...c.segments.map((x) => seg(x.label, x.n, x.rate, axisSlotColor(x.slot))),
        c.folded.n ? seg(`그 외 ${c.folded.distinct}종`, c.folded.n, c.folded.rate, AXIS_FOLDED_COLOR) : '',
        c.outside.n ? seg('목록 밖', c.outside.n, c.outside.rate, AXIS_OUTSIDE_COLOR) : '',
        c.empty.rate > 0 ? seg('미입력', c.empty.n, c.empty.rate, AXIS_EMPTY_COLOR, '#64748b') : ''
    ].join('');

    return `<div class="flex w-full rounded overflow-hidden" style="height:22px;background:${AXIS_EMPTY_COLOR}">${parts}</div>`;
}

/**
 * 칸에 들어가는 라벨만 남긴다 — **폭을 재고 나서.**
 *
 * 비율로 어림하면 틀린다. 9%는 넓은 화면에서 100px 이지만 좁은 패널에서는 33px 이고,
 * 「배달/포장 9%」는 66px 이 필요하다. 그래서 같은 글꼴의 자를 하나 세워 실제 글자 폭을
 * 재고, 칸보다 좁을 때만 글자를 넣는다. 화면 폭이 바뀌면 다시 잰다(그래서 지우는 것이
 * 아니라 비웠다 채운다 — 넓어지면 라벨이 돌아온다).
 */
function fitAxisBarLabels(root) {
    const segs = root.querySelectorAll('[data-seg-label]');
    if (!segs.length) return;
    const ruler = document.createElement('span');
    ruler.className = 'text-[10px] font-bold whitespace-nowrap';
    ruler.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:0';
    root.appendChild(ruler);
    segs.forEach((seg) => {
        const span = seg.firstElementChild;
        if (!span) return;
        span.textContent = '';
        const text = seg.getAttribute('data-seg-label') || '';
        ruler.textContent = text;
        // px-1 좌우 여백(8px)까지 들어가야 「comfortable padding」이다
        if (ruler.offsetWidth + 8 <= seg.clientWidth) span.textContent = text;
    });
    ruler.remove();
}

/** 폭이 바뀌면 라벨을 다시 재운다. 그릴 때마다 끊고 새 묶음에 다시 건다 */
let axisBarResizeObserver = null;
function watchAxisBarWidth(root) {
    if (typeof ResizeObserver === 'undefined') return;
    if (axisBarResizeObserver) axisBarResizeObserver.disconnect();
    axisBarResizeObserver = new ResizeObserver(() => fitAxisBarLabels(root));
    axisBarResizeObserver.observe(root);
}

/**
 * 막대 아래 범례 — **모든 칸에 이름을 붙인다.**
 *
 * 칸 안의 직접 라벨은 넓은 칸에만 들어간다(좁은 칸에 넣으면 글자가 잘린다). 그래서
 * 좁은 칸은 색만 남고, 색만으로는 무엇인지 알 수 없다 — 게다가 이 팔레트의 세 색은
 * 흰 바탕 대비가 3:1 아래라 색을 단독 식별 수단으로 쓰면 안 된다. 범례가 그 몫을 맡는다.
 *
 * **건수 0인 선택지도 흐리게 싣는다.** 「아무도 안 고른 칩」이 이 화면이 답해야 하는
 * 질문 중 하나인데, 막대에는 칸이 안 생겨 흔적이 없다. 범례에서만 보인다.
 */
function renderAxisLegend(axis) {
    const c = axis.chart;
    /**
     * 칩 하나 — 이름·건수·비율은 눈에 보이고, **무엇을 뜻하는 칸인지는 마우스를 올렸을 때** 나온다.
     *
     * 예전에는 「그 외 / 목록 밖 / 미입력 내역」의 내역이 범례 아래 잔줄 셋으로 항상 깔려 있었다.
     * 축이 다섯이라 잔줄이 최대 열다섯 줄이 되고, 그중 관심 있는 한 줄을 눈으로 찾아야 했다.
     * 내역은 그 칩에 붙어 있는 게 맞다 — 칩을 짚는 순간 그 칩의 내역만 뜬다.
     */
    const item = (color, label, n, rate, { muted = false, ring = '', title = '' } = {}) => `
        <span class="inline-flex items-center gap-1.5 mr-3 mb-1 cursor-help ${muted ? 'opacity-45' : ''}" title="${escapeHtml(title)}">
            <span class="inline-block w-2.5 h-2.5 rounded-sm shrink-0 ${ring}" style="background:${color}"></span>
            <span class="text-[11px] ${muted ? 'text-slate-500' : 'text-slate-700'} whitespace-nowrap">${escapeHtml(label)}</span>
            <span class="text-[11px] tabular-nums text-slate-400 whitespace-nowrap">${
                n > 0 ? `${n.toLocaleString()} · ${rate.toFixed(rate < 10 ? 1 : 0)}%` : '0'
            }</span>
        </span>`;

    /** 툴팁 한 덩어리 — 빈 줄은 버린다(줄이 비면 툴팁에 빈 칸이 생긴다) */
    const tip = (...lines) => lines.filter(Boolean).join('\n');
    const amount = (n, rate) => `${n.toLocaleString()}건 · ${rate.toFixed(1)}%`;
    /** 「커피 17 · 면류 16 · …」 */
    const names = (items, more = false) =>
        items.length ? items.map((x) => `${x.label} ${x.n.toLocaleString()}`).join(' · ') + (more ? ' …' : '') : '';

    const rowTip = (r) =>
        tip(
            `${r.label} — 태그 목록 안의 선택지`,
            amount(r.n, r.rate),
            axis.noSourceSplit ? '이 축은 사용자에게 묻지 않는다 — 전부 자동 분류' : `직접 ${r.direct.toLocaleString()} · 자동 ${r.auto.toLocaleString()}`
        );

    // 막대의 칸 순서(많은 순)를 그대로 따라간다 — 눈이 왼쪽부터 짚어 내려오게
    const chips = [
        ...axis.rows
            .filter((r) => r.slot !== null)
            .map((r) => item(axisSlotColor(r.slot), r.label, r.n, r.rate, { title: rowTip(r) })),
        c.folded.n
            ? item(AXIS_FOLDED_COLOR, `그 외 ${c.folded.distinct}종`, c.folded.n, c.folded.rate, {
                  title: tip(
                      `그 외 ${c.folded.distinct}종 — 색 슬롯 ${AXIS_CHART_SLOTS}개를 넘어 한 색으로 접힌 선택지`,
                      amount(c.folded.n, c.folded.rate),
                      names(c.folded.items || [])
                  )
              })
            : '',
        c.outside.n
            ? item(AXIS_OUTSIDE_COLOR, `목록 밖 ${c.outside.distinct}종`, c.outside.n, c.outside.rate, {
                  title: tip(
                      `목록 밖 ${c.outside.distinct}종 — 지금의 태그 목록에 없는 값`,
                      amount(c.outside.n, c.outside.rate),
                      names(c.outside.samples || [], c.outside.distinct > (c.outside.samples || []).length),
                      axis.freeText ? '이 축은 자유 입력이라 목록 밖이 큰 것이 정상이다' : ''
                  )
              })
            : '',
        c.empty.n
            ? item(AXIS_EMPTY_COLOR, '미입력', c.empty.n, c.empty.rate, {
                  ring: 'ring-1 ring-inset ring-slate-300',
                  title: tip(
                      '미입력 — 이 축에 값이 남지 않은 기록',
                      amount(c.empty.n, c.empty.rate),
                      axis.emptyPaths
                          ? names(axis.emptyPaths.map((e) => ({ label: e.label.replace(/\(.*\)/, '').trim(), n: e.n })))
                          : ''
                  )
              })
            : '',
        // 아무도 안 고른 칩은 맨 뒤에 흐리게 — 막대에는 칸이 없어 여기서만 보인다
        ...axis.rows
            .filter((r) => r.n === 0)
            .map((r) =>
                item('transparent', r.label, 0, 0, {
                    muted: true,
                    ring: 'ring-1 ring-inset ring-slate-300',
                    title: `${r.label} — 이 기간에 아무도 고르지 않은 선택지 (0건)`
                })
            )
    ].join('');

    return `<div class="mt-1.5 flex flex-wrap">${chips}</div>`;
}

/**
 * 축별 누적 막대 — 이 화면의 본체.
 *
 * 숫자만 늘어놓은 표는 「멀게」 읽힌다는 지적이 이 블록의 출발점이다. 구성비와 건수는
 * 둘 다 중요하므로 둘을 한 그림에 담는다: 길이가 몫이고, 칸 나눔이 구성이다.
 * 예전에는 이 아래 선택지별 표가 한 장 더 있었는데, 범례가 같은 값을 더 짧게 말해
 * 걷어냈다 — 정확한 값이 더 필요하면 「엑셀 내보내기」의 `선택지 분포` 시트가 전부 들고 있다.
 */
function renderAxisCharts(breakdown, total) {
    const bars = breakdown
        .map(
            (axis) => `
        <div class="py-3">
            <div class="flex items-baseline justify-between gap-3 mb-1.5">
                <span class="text-xs font-black text-slate-800">
                    ${escapeHtml(axis.label)}
                    <span class="ml-1.5 text-[10px] font-normal text-slate-400">${escapeHtml(axis.note || '')}</span>
                    ${axis.tagListMissing ? '<span class="ml-1.5 text-[10px] font-bold text-red-600">태그 목록을 읽지 못함</span>' : ''}
                </span>
                <span class="text-[11px] tabular-nums text-slate-500 whitespace-nowrap">
                    입력 <b class="text-slate-700">${axis.filled.toLocaleString()}</b>건 ·
                    <b class="${axis.filledRate >= 70 ? 'text-emerald-700' : axis.filledRate >= 40 ? 'text-amber-700' : 'text-red-600'}">${fmtPct(
                        axis.filledRate
                    )}</b>
                    ${
                        axis.noSourceSplit
                            ? '<span class="ml-1 text-slate-400">전부 자동 분류</span>'
                            : `<span class="ml-1 text-slate-400">직접 ${axis.direct.toLocaleString()}</span>
                               <span class="ml-1 text-sky-600">자동 ${axis.auto.toLocaleString()}${
                                   axis.auto ? ` (${fmtPct(axis.autoShare)})` : ''
                               }</span>`
                    }
                </span>
            </div>
            ${renderAxisBar(axis)}
            ${renderAxisLegend(axis)}
        </div>`
        )
        .join('');

    return `
        <div class="mt-6">
            <div class="flex items-center justify-between gap-3 mb-1">
                <h4 class="text-sm font-black text-slate-800">
                    축별 구성 <span class="text-xs font-normal text-slate-400">(막대 전체 = 분석 대상 기록 ${total.toLocaleString()}건 · 100%)</span>
                </h4>
                ${guideButton('axis')}
            </div>
            <p class="text-[11px] text-slate-400 mb-2">
                각 막대의 <b>칠해진 길이</b>가 그 축의 입력률이고, <b>칸 나눔</b>이 무엇으로 채워졌는지입니다.
                막대가 같은 100%를 나눠 쓰므로 축끼리 길이를 그대로 비교할 수 있습니다. 칸에 마우스를 올리면 정확한 값이 뜹니다.
            </p>
            <div id="momentAxisCharts" class="rounded-xl border border-slate-200 bg-white px-4 py-2 divide-y divide-slate-100">${bars}</div>
        </div>`;
}

/* ─────────────────────────────────────────────────────────────
 * 「읽는 법」 팝업
 *
 * 이 설명들은 표 바로 아래에 잔줄로 깔려 있었다. 셋을 합치면 열댓 줄짜리 회색 글이
 * 화면의 절반을 차지하는데, **매번 읽을 글이 아니라 한 번 읽고 가끔 확인할 글**이었다.
 * 그래서 접어 두고 필요할 때 부른다 — 대신 접는 김에 주제별로 다시 묶었다(잔줄은
 * 순서가 없었다).
 *
 * 껍데기는 **하나**다. 표마다 팝업을 두면 admin.html 에 같은 마크업이 셋 생기고 셋이
 * 따로 늙는다. 한 번에 둘을 열 일도 없으므로 제목·본문만 갈아 끼운다.
 * 그 껍데기는 `momentAnalyticsContainer` **바깥**에 둔다 — 결과를 다시 그릴 때마다
 * 컨테이너는 통째로 갈려서, 안에 두면 버튼이 가리키는 대상이 사라진다.
 * ───────────────────────────────────────────────────────────── */

/** 팝업 안의 한 마디 — 제목 + 본문 */
const guideSection = (title, body) => `
    <section class="pt-4 mt-4 border-t border-slate-100 first:pt-0 first:mt-0 first:border-0">
        <h4 class="text-[13px] font-black text-slate-900 mb-1.5">${title}</h4>
        <div class="text-[12px] leading-[1.75] text-slate-600 space-y-1.5">${body}</div>
    </section>`;

/** 표 제목 오른쪽에 서는 버튼 */
const guideButton = (key) => `
    <button type="button" onclick="window.openMomentGuide('${key}')"
            class="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-bold text-slate-600 hover:bg-slate-50 hover:text-slate-800 transition-colors">
        <i data-lucide="circle-help" class="w-3.5 h-3.5"></i>읽는 법
    </button>`;

function renderAxisGuideBody() {
    return [
        guideSection(
            '막대 하나를 어떻게 읽나',
            `<p><b>총 길이는 언제나 분석 대상 기록 100%</b>입니다. 축마다 제 입력분만큼만 칠해지고 나머지는
             미입력 트랙으로 남습니다 — 그래서 축을 위아래로 세우면 「어떻게는 절반 넘게 채워지고 누구와는
             그 절반」 같은 것이 <b>길이 차이로</b> 바로 보입니다. 각 축을 100%로 늘려 그리면 구성비는
             보이지만 그 비교가 통째로 사라집니다.</p>
             <p><b>막대의 칸에도, 범례의 칩에도 마우스를 올리면</b> 그 칸이 무엇인지와 정확한 건수가 뜹니다.
             「그 외」·「목록 밖」·「미입력」에 무엇이 묶여 있는지도 그 칩에 붙어 있습니다.</p>`
        ),
        guideSection(
            '직접과 자동',
            `<p><b>자동</b> = 사람이 고르지 않았는데 값이 남은 것입니다. 근거는 저장 경로가 남긴 자국뿐입니다:</p>
             <ul class="list-disc pl-4 space-y-0.5">
                 <li>어떻게 · 어디서 · 누구와 — 맥락 예측이 자동 적용한 축(<code>autoContext</code>)</li>
                 <li>무엇을 — 로컬 · 서버 분류기가 채운 값(<code>categoryAuto</code>)</li>
             </ul>
             <p><b>값만 보면 둘은 구별되지 않습니다</b> — 「집밥」은 사람이 골라도 집밥이고 예측이 넣어도
             집밥입니다. 이 두 숫자가 없으면 입력률이 올라도 그게 사람이 더 채운 것인지 기계가 메운
             것인지 영영 알 수 없습니다.</p>`
        ),
        guideSection(
            '순서와 색',
            `<p><b>칸도 범례도 많은 순</b>으로 섭니다. 색이 그 순위를 따라가므로 <b>다른 기간을 보면 같은 값의
             색이 달라질 수 있습니다</b> — 식별은 언제나 <b>범례의 이름</b>으로 하세요(막대 바로 아래 붙어
             있는 이유입니다).</p>
             <p>색은 <b>앞 ${AXIS_CHART_SLOTS}개</b>까지입니다. 아홉 번째 색을 만들면 색맹 조건에서 기존 색과
             구별되지 않아, 나머지는 「그 외」로 묶습니다 — 무엇이 묶였는지는 그 칩에 마우스를 올리면 나옵니다.</p>
             <p><b>맨 뒤 흐린 칩</b>은 기간 안에 아무도 고르지 않은 선택지입니다 — 막대에는 칸이 안 생겨
             범례에서만 보입니다. 구분을 접거나 이름을 바꿀 후보입니다.</p>`
        ),
        guideSection(
            '「무엇을」은 축이 둘이다',
            `<p><b>형태</b>(밥류 · 면류…)는 사용자가 고르거나 분류기가 채우고, <b>종류</b>(한식 · 중식…)는
             <b>묻지 않고</b> 분류기가 붙입니다. 「면을 얼마나 먹나」와 「중식을 얼마나 먹나」는 다른
             질문이라 축이 둘입니다. 형태 축에서 목록 밖으로 밀리는 옛 한식 · 양식 기록이 종류 축에서는
             제자리를 찾습니다.</p>
             <p><b>종류의 「미입력」을 실패로 읽지 마세요</b> — 과일 · 커피 · 채소처럼 <b>축이 애초에 해당되지
             않는 형태</b>가 여기 섞여 있습니다(「사과가 한식인가 양식인가」는 질문이 성립하지 않습니다).</p>`
        ),
        guideSection(
            '「목록 밖」에 무엇이 모이나',
            `<p>지금의 태그 목록에 없는 값입니다. 「무엇을」의 목록 밖은 대부분 <b>축을 갈아끼우기 전에
             저장된 옛 어휘</b>(한식 · 양식 · 일식 · 중식 · 분식 · 카페)와 「기타」입니다 — 「한식」은 밥류일
             수도 국물요리일 수도 있어 어느 칩에도 넣지 않습니다. 표기만 달랐던 옛 형태 축 값은 읽을 때
             맞춰 제 칩으로 갑니다.</p>
             <p>「어디서」는 끼니가 가게 이름을 <b>자유 입력</b>하므로 목록 밖이 큰 것이 정상입니다.</p>`
        ),
        guideSection(
            '조심할 곳',
            `<p>「무엇을」의 <b>자동</b>은 서버 AI 배치가 <b>나중에</b> 돌아 채웁니다. 최근 며칠은 아직 안 돌았을
             수 있어 「서버 분류 대기」가 부풀어 보입니다 — 맨 최근 구간은 그만큼 감해서 보세요.</p>`
        )
    ].join('');
}

function renderTrendGuideBody() {
    return [
        guideSection(
            '이 표를 어떻게 읽나',
            `<p>모든 숫자는 그 구간의 기록 수 대비 <b>%</b>입니다 — <b>「추천 분류」 두 열만 예외</b>로,
             제안이 뜬 기록이 분모입니다. 칸에 마우스를 올리면 <b>건수와 그 칸의 분모</b>가 뜨고,
             맨 윗줄 <b>전체</b>는 기간 전체를 한 줄로 접은 값입니다.</p>
             <p>열은 <b>사용자가 시트에서 채우는 순서</b>로 섭니다 — 무엇을 → 추천 분류 → 어떻게 → 어디서 →
             누구와 → 만족도 → 포만감 → 사진 → 코멘트. 이 표에서 읽으려는 것이 「시트를 내려가며 어디서
             손이 멈추나」라서, 세는 순서가 아니라 채우는 순서를 따릅니다.</p>`
        ),
        guideSection(
            '「무엇을」이 네 열인 이유',
            `<p>이 축은 값이 채워지는 길이 둘(사람 · 분류기)이라 한 칸으로 접으면 <b>입력률이 올라도 사람이
             채운 것인지 기계가 메운 것인지</b> 갈리지 않습니다.</p>
             <ul class="list-disc pl-4 space-y-0.5">
                 <li><b>최종</b> — 어떤 경로로든 형태 값이 남았다</li>
                 <li><b>직접</b> — 사람이 칩으로 고르거나 제안을 확정했다</li>
                 <li><b>자동</b> — 사용자 값 없이 분류기가 채웠다</li>
                 <li><b>미분류</b> — 거부 · 서버 대기 · 상세 없음</li>
             </ul>
             <p>직접 + 자동 = 최종이고, 미분류까지 더하면 100%입니다.</p>
             <p><b>「자동」 칸에 마우스를 올리면 누가 채웠는지</b>가 나옵니다 — 로컬 분류기(저장할 때
             클라이언트가) · 서버 AI(Gemini 배치가 나중에) · 경로 미상(<code>categorySource</code> 가
             유실된 옛 기록). 셋의 합은 그 칸과 정확히 같습니다.</p>`
        ),
        guideSection(
            '추천 분류 — 제안을 사람이 받아들였나',
            `<p>위 네 열이 「값이 어디서 왔나」를 묻는다면 이 둘은 다른 질문입니다: 분류기가 내민 답을 사람이
             썼나. 근거는 <code>categorySuggested</code> 하나입니다 — 저장 경로가 <b>사용자가 다른 값으로
             고쳤어도</b> 분류기의 답을 남깁니다. 그 자국이 없으면 맞힌 경우만 데이터에 남아 교정률을 셀
             방법이 없습니다.</p>
             <ul class="list-disc pl-4 space-y-0.5">
                 <li><b>사용</b> — 최종 값이 제안값과 같다(확정했거나, 그대로 두고 저장했거나)</li>
                 <li><b>안 씀</b> — 사람이 다른 값으로 고쳤거나(= 오분류), ✕로 거부했다</li>
             </ul>
             <p><b>이 두 열만 분모가 다릅니다</b> — 전체 기록이 아니라 「제안이 뜬 기록」입니다. 그래서
             <b>사용 + 안 씀 = 100%</b>이고, 제안이 안 뜬 기록은 어느 칸에도 들어가지 않습니다. 옆 열들과
             세로로 견주면 안 되는 이유가 이것입니다 — 밟고 선 바닥이 다릅니다.</p>
             <p>제안 자국(<code>categorySuggested</code>)을 남기기 전에 저장된 옛 기록은 분모가 아예 0이라
             칸이 <b><code>-</code></b> 로 비어 있습니다. <b>개편 이전 구간의 빈칸은 결측이지 실패가 아닙니다.</b>
             정확한 건수는 표 아래 한 줄과 「엑셀 내보내기」의 <code>추천 분류</code> 시트에 있습니다.</p>`
        ),
        guideSection(
            '색 눈금이 열마다 다르다',
            `<ul class="list-disc pl-4 space-y-0.5">
                 <li><b>초록 ↔ 빨강</b> — 높을수록 좋다(대부분의 열)</li>
                 <li><b>뒤집은 눈금</b> — 「미분류」와 「안 씀」은 높을수록 나쁜 값이라 방향을 뒤집습니다.
                     같은 눈금을 쓰면 미분류 90%가 초록으로 칠해집니다.</li>
                 <li><b>하늘색</b> — 「자동」과 「자동적용」은 좋고 나쁨이 <b>없는</b> 열입니다. 사람이 채운 몫과
                     기계가 채운 몫의 비중일 뿐이라 판정을 얹지 않고, 진하기로 크기만 말합니다.</li>
             </ul>`
        ),
        guideSection(
            '자동적용',
            `<p>맥락 예측이 어떻게 · 어디서 · 누구와 중 <b>한 축이라도</b> 자동으로 채운 기록의 비율입니다.
             개편 전 기록에는 이 자국(<code>autoContext</code>)이 없어 0으로 나옵니다.</p>`
        ),
        guideSection(
            '서버 AI 배치는 나중에, 그것도 조금씩 돕니다',
            `<p>「무엇을」의 <b>자동</b> 중 서버 AI 몫은 <code>classifyUncategorizedMeals</code> 가 채웁니다 —
             <b>6시간마다(하루 4회) · 한 번에 최대 100건 · 최근 7일 범위</b>입니다.</p>
             <p>그래서 <b>맨 윗 구간 몇 줄은 자동이 덜 차 있고 미분류가 부풀어 보입니다</b> — 그만큼 감해서
             보세요. 반대로 그 기간의 미분류가 하루 400건보다 빠르게 쌓이면 배치가 따라잡지 못하고,
             <b>7일이 지나면 정기 배치는 그 기록을 다시 보지 않습니다</b>(영구 미분류로 남습니다).</p>
             <p>임의 기간을 다시 도는 <code>adminClassifyLegacyMeals</code> 가 서버에 있지만 <b>화면에 버튼이
             없습니다</b> — 지금은 콘솔에서 직접 부르는 수밖에 없습니다.</p>`
        )
    ].join('');
}

function renderCompletenessGuideBody() {
    return [
        guideSection(
            '이 표가 세는 것',
            `<p>기록 하나가 <b>핵심 ${CORE_FIELD_SPECS.length}항목</b>(어떻게 · 어디서 · 무엇을 · 누구와 ·
             만족도 · 포만감 · 사진 · 코멘트) 중 몇 개를 채웠는지의 분포입니다. 항목별 입력률이 「어느 칸이
             비었나」를 묻는다면, 이 표는 <b>「한 사람이 한 번에 얼마나 쓰나」</b>를 묻습니다.</p>
             <p>봐야 할 것은 평균이 아니라 <b>분포의 모양</b>입니다. 가운데가 두꺼우면 대체로 비슷하게 쓰는
             것이고, 양 끝이 두꺼우면 「거의 안 쓰는 사람」과 「다 쓰는 사람」으로 갈린 것입니다 — 뒤쪽이면
             평균을 올리려는 시도가 대부분에게 닿지 않습니다.</p>`
        ),
        guideSection(
            '분석 전체에 해당하는 것',
            `<ul class="list-disc pl-4 space-y-1">
                 <li><b>분모</b>는 기간 안의 끼니 · 간식 기록입니다. 하루기록(소감)과 캡처 공유는 이 항목들을
                     애초에 갖지 않아 제외했습니다 — 넣으면 입력률이 통째로 내려앉아 아무것도 못 읽는 숫자가 됩니다.</li>
                 <li><b>만족도 · 포만감</b>은 사용자가 설정에서 끌 수 있는 항목이라, 미입력에는 <b>「꺼 둔 사용자」가
                     섞여 있습니다</b>. 걸러내려면 사용자별 설정을 읽어야 해서(읽기가 사용자 수만큼 늘어납니다) 하지 않았습니다.</li>
                 <li><b>어디서 · 무엇을 · 누구와의 「상세」 입력</b>(선택 입력 텍스트)은 화면에서 뺐습니다 —
                     「엑셀 내보내기」의 <code>항목별 입력률</code> 시트가 그대로 들고 있습니다.</li>
                 <li><b>통계 제외 UID</b>(대시보드 설정)의 기록은 빼고 셉니다.</li>
             </ul>`
        )
    ].join('');
}

/** 표 하나당 한 마디 — 버튼의 `key` 가 이 표의 열쇠다 */
const MOMENT_GUIDES = {
    axis: { title: '축별 구성 읽는 법', body: renderAxisGuideBody },
    trend: { title: '기간 추이 읽는 법', body: renderTrendGuideBody },
    completeness: { title: '채운 항목 수 읽는 법 · 분석 주석', body: renderCompletenessGuideBody }
};

function openMomentGuide(key) {
    const guide = MOMENT_GUIDES[key];
    const modal = document.getElementById('momentGuideModal');
    const title = document.getElementById('momentGuideTitle');
    const body = document.getElementById('momentGuideBody');
    if (!guide || !modal || !title || !body) return;
    title.textContent = guide.title;
    body.innerHTML = guide.body();
    body.scrollTop = 0;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
}

function closeMomentGuide() {
    const modal = document.getElementById('momentGuideModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
}

window.openMomentGuide = openMomentGuide;
window.closeMomentGuide = closeMomentGuide;

/** 닫기 경로 셋(X · 바깥 · ESC) — 화면당 한 번만 건다 */
let momentGuideBound = false;
function bindMomentGuideOnce() {
    if (momentGuideBound) return;
    const modal = document.getElementById('momentGuideModal');
    if (!modal) return;
    momentGuideBound = true;
    document.getElementById('momentGuideClose')?.addEventListener('click', closeMomentGuide);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeMomentGuide();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!modal.classList.contains('hidden')) closeMomentGuide();
    });
}

/**
 * 「추천 분류」 두 열의 분모 — 전체 기록이 아니라 **제안 자국이 남은 기록**이다.
 * 셋(그대로 씀 · 고침 · 거부)이 서로 배타적이라 합이 곧 「제안이 떴던 횟수」가 된다.
 * 전체 기록으로 나누면 두 열의 합이 「제안이 뜬 비율」로 흘러가 버려, 받아들임률도
 * 건수도 아닌 읽을 수 없는 숫자가 된다.
 *
 * 옛 기록에는 `categorySuggested` 가 없어 0이 나온다 — 그 구간은 0%가 아니라 결측이라
 * 칸을 `-` 로 비운다.
 */
const suggestOffered = (b) =>
    (b.counts.suggestUsed || 0) + (b.counts.suggestChanged || 0) + (b.counts.suggestRejected || 0);

/**
 * 추이 표의 열 — **사용자가 시트에서 채우는 순서**로 선다.
 *
 * 예전에는 모델의 핵심 8항목 순서를 그대로 썼는데, 그건 「무엇을 세는가」의 순서지
 * 「무엇을 채우는가」의 순서가 아니었다. 관리자가 이 표에서 읽으려는 것은 시트를
 * 위에서 아래로 내려가며 어디서 손이 멈추는가라, 시트 순서와 어긋나면 매번 머릿속에서
 * 열을 다시 세워야 한다.
 *
 * 「무엇을」만 열이 넷인 이유: 이 축은 값이 채워지는 길이 둘(사람·분류기)이라
 * 한 칸으로 접으면 **입력률이 올라도 그게 사람이 채운 것인지 기계가 메운 것인지**
 * 갈리지 않는다. 그래서 최종을 앞에 세우고 그 안을 직접·자동·미분류로 쪼갠다
 * (셋의 합이 언제나 100%다).
 *
 * `tone` — good: 높을수록 좋다 / bad: 높을수록 나쁘다 / info: 좋고 나쁨이 없다.
 *
 * `denom` — 그 열만의 분모(없으면 그 구간의 기록 수). 열마다 밟고 선 바닥이 다를 수 있어
 * `denomLabel` 을 같이 달아 두면 마우스를 올렸을 때 무엇으로 나눈 값인지가 뜬다.
 * `displayRate` — 그리는 %를 따로 셈해야 하는 열(짝 열과 합을 100에 맞추는 자리)만 쓴다.
 */
const TREND_COLUMN_GROUPS = [
    {
        label: '무엇을',
        cols: [
            {
                label: '최종',
                tone: 'good',
                value: (b) => b.counts.whatFinal,
                hint: '사용자 확정 + 자동 분류 — 최종적으로 형태 값이 남은 기록'
            },
            { label: '직접', tone: 'good', value: (b) => b.counts.what, hint: '사용자가 칩으로 고르거나 제안을 확정한 것' },
            {
                label: '자동',
                tone: 'info',
                value: (b) => b.counts.whatFinal - b.counts.what,
                /**
                 * 자동을 **누가** 채웠나 — 저장할 때 클라이언트가 잡았나, 나중에 서버 배치가 메웠나.
                 *
                 * 이 자리인 이유: 서버 Gemini 배치는 6시간마다 **최근 7일만** 돌기 때문에
                 * 「얼마나 채웠나」가 애초에 날짜에 매인 값이다. 기간 전체를 한 덩어리로 접은
                 * 축별 구성에 두면 숫자 하나가 나올 뿐이고, 그건 엑셀이 이미 주는 값과 같다.
                 * 여기 두면 배치가 따라잡고 있는지가 세로로 보인다.
                 *
                 * 셋의 합은 이 칸과 **정확히** 같다 — 자동 = 최종 − 직접 = 로컬 + AI + 경로 미상.
                 */
                detail: (b) =>
                    `로컬 분류기 ${(b.counts.pathLocal || 0).toLocaleString()} · ` +
                    `서버 AI(Gemini) ${(b.counts.pathAi || 0).toLocaleString()} · ` +
                    `경로 미상 ${(b.counts.pathAutoUnknown || 0).toLocaleString()}`,
                hint: '사용자 값 없이 로컬·서버 분류기가 채운 것 (마우스를 올리면 누가 채웠는지)'
            },
            {
                label: '미분류',
                tone: 'bad',
                value: (b) => b.total - b.counts.whatFinal,
                hint: '거부·서버 대기·상세 없음 — 어떤 경로로도 값이 남지 않은 것'
            }
        ]
    },
    {
        label: '추천 분류',
        innerDivider: true,
        cols: [
            {
                label: '사용',
                tone: 'good',
                value: (b) => b.counts.suggestUsed,
                denom: suggestOffered,
                denomLabel: '제안이 뜬 기록',
                hint: '제안이 뜬 기록 중, 최종 값이 제안값과 같은 것 — 분모가 전체 기록이 아니다'
            },
            {
                label: '안 씀',
                tone: 'bad',
                value: (b) => b.counts.suggestChanged + b.counts.suggestRejected,
                denom: suggestOffered,
                denomLabel: '제안이 뜬 기록',
                /**
                 * 「사용」을 반올림하고 남은 몫으로 그린다 — 둘을 따로 반올림하면 37.5 + 62.5가
                 * 38 + 63 = 101로 찍혀, 합이 100이라는 이 표의 약속이 반올림에 깨진다.
                 */
                displayRate: (b) => 100 - Math.round(pct(b.counts.suggestUsed, suggestOffered(b))),
                hint: '제안이 뜬 기록 중, 사람이 다른 값으로 고쳤거나 ✕로 거부한 것 — 사용 + 안 씀 = 100%'
            }
        ]
    },
    { label: '어떻게', cols: [{ label: '어떻게', tone: 'good', value: (b) => b.counts.how }] },
    { label: '어디서', cols: [{ label: '어디서', tone: 'good', value: (b) => b.counts.where }] },
    { label: '누구와', cols: [{ label: '누구와', tone: 'good', value: (b) => b.counts.withWhom }] },
    { label: '만족도', cols: [{ label: '만족도', tone: 'good', value: (b) => b.counts.rating, hint: '설정에서 끌 수 있는 항목' }] },
    { label: '포만감', cols: [{ label: '포만감', tone: 'good', value: (b) => b.counts.satiety, hint: '설정에서 끌 수 있는 항목' }] },
    { label: '사진', cols: [{ label: '사진', tone: 'good', value: (b) => b.counts.photo }] },
    { label: '코멘트', cols: [{ label: '코멘트', tone: 'good', value: (b) => b.counts.comment }] },
    {
        label: '자동적용',
        divider: true,
        cols: [
            {
                label: '자동적용',
                tone: 'info',
                value: (b) => b.counts.autoContext || 0,
                hint: '맥락 예측이 어떻게·어디서·누구와 중 한 축이라도 자동으로 채운 기록'
            }
        ]
    }
];

/** 그룹 경계의 세로줄 — 「무엇을」 넷과 「추천 분류」 둘이 한 덩어리로 읽히게 */
const TREND_DIVIDER = 'border-l border-slate-200';
/**
 * 그룹 **안쪽**의 세로줄. 경계선과 같은 굵기다 — 한 단 옅게(slate-100) 그어 봤더니
 * 실제 화면에서 보이지 않았고, 안 보이는 선은 없는 선이다. 그룹의 묶임은 두 줄 헤더의
 * `colspan` 이 이미 말하고 있어 선의 굵기까지 빌릴 필요가 없다.
 *
 * 「무엇을」 넷에는 긋지 않는다: 최종 = 직접 + 자동처럼 서로를 설명하는 사이라 칸을
 * 갈라 놓으면 그 관계가 끊긴다. 「추천 분류」 둘은 **경쟁하는 두 결말**이라 갈라야 읽힌다.
 */
const TREND_INNER_DIVIDER = 'border-l border-slate-200';

/** 그 칸 왼쪽에 그을 선 — 그룹 첫 칸은 경계선, 안쪽 칸은 `innerDivider` 인 그룹만 */
function trendCellDivider(group, index) {
    if (index === 0) return group.cols.length > 1 || group.divider ? TREND_DIVIDER : '';
    return group.innerDivider ? TREND_INNER_DIVIDER : '';
}

function trendCellClass(tone, rate) {
    if (tone === 'bad') return rateCellClassInverse(rate);
    if (tone === 'info') return rateCellClassNeutral(rate);
    return rateCellClass(rate);
}

/** 추이 한 줄 — `b` 는 구간 버킷이거나 전체(overall) 버킷이다(모양이 같다) */
function renderTrendRow(b, { label, emphasis = false }) {
    const cells = TREND_COLUMN_GROUPS.map((g) =>
        g.cols
            .map((col, i) => {
                /** 열마다 제 분모다 — 대부분은 그 구간의 기록 수, 「추천 분류」만 제안이 뜬 기록 수 */
                const denom = col.denom ? col.denom(b) : b.total;
                const n = denom ? Math.max(0, col.value(b)) : 0;
                /** 그리는 값은 `displayRate` 가 있으면 그쪽이다 — 짝 열과 합을 맞추는 열이 쓴다 */
                const rate = denom && col.displayRate ? col.displayRate(b, denom) : pct(n, denom);
                const title = [
                    `${col.label} · ${n.toLocaleString()}건 / ${denom.toLocaleString()}건` +
                        (col.denomLabel ? ` (${col.denomLabel})` : ''),
                    col.detail && denom ? col.detail(b) : ''
                ]
                    .filter(Boolean)
                    .join('\n');
                return `<td class="px-2 py-2 text-center text-xs font-bold tabular-nums ${trendCellClass(
                    col.tone,
                    rate
                )} ${trendCellDivider(g, i)}" title="${escapeHtml(title)}">${denom ? rate.toFixed(0) : '-'}</td>`;
            })
            .join('')
    ).join('');
    const rowClass = emphasis ? 'border-b-2 border-slate-300 bg-slate-50' : 'border-b border-slate-100';
    const stickyBg = emphasis ? 'bg-slate-50' : 'bg-white';
    return `
        <tr class="${rowClass}">
            <td class="px-3 py-2 text-xs font-bold ${
                emphasis ? 'text-slate-900' : 'text-slate-700'
            } whitespace-pre-line sticky left-0 ${stickyBg}">${escapeHtml(label ?? b.label)}</td>
            <td class="px-3 py-2 text-right text-xs tabular-nums text-slate-500">${b.total.toLocaleString()}</td>
            ${cells}
        </tr>`;
}

function renderTrendTable(result) {
    if (!result.trend.length) return '';

    // 그룹 행 + 세부 행 2단 헤더 — 열이 하나뿐인 그룹은 두 줄을 통째로 쓴다
    const groupHead = TREND_COLUMN_GROUPS.map((g) => {
        const div = g.cols.length > 1 || g.divider ? TREND_DIVIDER : '';
        const tone = g.label === '자동적용' ? 'text-sky-700' : 'text-slate-600';
        return `<th ${g.cols.length > 1 ? `colspan="${g.cols.length}"` : 'rowspan="2"'}
                    class="px-2 py-2 text-center text-xs font-bold ${tone} whitespace-nowrap bg-slate-50 ${div}">${escapeHtml(
                        g.label
                    )}</th>`;
    }).join('');
    const subHead = TREND_COLUMN_GROUPS.filter((g) => g.cols.length > 1)
        .flatMap((g) => g.cols.map((col, i) => ({ col, divider: trendCellDivider(g, i) })))
        .map(
            ({ col, divider }) =>
                `<th class="px-2 py-1 text-center text-[11px] font-bold text-slate-500 whitespace-nowrap bg-slate-50 ${divider}"
                     title="${escapeHtml(col.hint || '')}">${escapeHtml(col.label)}</th>`
        )
        .join('');

    // 최신 구간이 위로 오게 뒤집고, 맨 위에 기간 전체를 한 줄 얹는다
    const body =
        renderTrendRow(result.overall, { label: '전체', emphasis: true }) +
        [...result.trend]
            .reverse()
            .map((b) => renderTrendRow(b, {}))
            .join('');

    const sug = {
        used: result.overall.counts.suggestUsed || 0,
        changed: result.overall.counts.suggestChanged || 0,
        rejected: result.overall.counts.suggestRejected || 0
    };
    const sugTotal = sug.used + sug.changed + sug.rejected;
    const sugLine = sugTotal
        ? `제안이 뜬 기록 <b>${sugTotal.toLocaleString()}건</b> 중
           그대로 쓴 것 <b class="text-emerald-700">${sug.used.toLocaleString()}건(${fmtPct(pct(sug.used, sugTotal))})</b> ·
           다른 값으로 고친 것 <b class="text-amber-700">${sug.changed.toLocaleString()}건</b> ·
           ✕로 거부한 것 <b class="text-red-600">${sug.rejected.toLocaleString()}건</b>`
        : '이 기간에는 제안 자국(<code>categorySuggested</code>)이 남은 기록이 없습니다';

    return `
        <div class="mt-6">
            <div class="flex items-center justify-between gap-3 mb-2">
                <h4 class="text-sm font-black text-slate-800">
                    기간 추이 <span class="text-xs font-normal text-slate-400">(${
                        result.byWeek ? '주별' : '일별'
                    } · 단위 % · 열 순서는 입력 시트 순서)</span>
                </h4>
                ${guideButton('trend')}
            </div>
            <div class="overflow-x-auto rounded-xl border border-slate-200">
                <table class="min-w-full text-sm border-separate border-spacing-0">
                    <thead class="bg-slate-50">
                        <tr class="border-b border-slate-200">
                            <th rowspan="2" class="px-3 py-2 text-left text-xs font-bold text-slate-600 uppercase sticky left-0 bg-slate-50">${
                                result.byWeek ? '주차' : '날짜'
                            }</th>
                            <th rowspan="2" class="px-3 py-2 text-right text-xs font-bold text-slate-600 uppercase whitespace-nowrap">기록</th>
                            ${groupHead}
                        </tr>
                        <tr class="border-b border-slate-200">${subHead}</tr>
                    </thead>
                    <tbody>${body}</tbody>
                </table>
            </div>
            <p class="mt-2 text-[11px] leading-relaxed text-slate-500">
                <b class="text-slate-700">추천 분류</b> — ${sugLine}.
            </p>
        </div>`;
}

/** 완성도 분포 — 막대 대신 한 줄 표. 0~8을 가로로 늘어놓아야 분포 모양이 한눈에 들어온다 */
function renderCompletenessTable(result) {
    const total = result.overall.total;
    const head = result.completeness
        .map((_, i) => `<th class="px-2 py-2 text-center text-xs font-bold text-slate-600">${i}개</th>`)
        .join('');
    const counts = result.completeness
        .map((c) => `<td class="px-2 py-2 text-center text-xs tabular-nums text-slate-700">${c.toLocaleString()}</td>`)
        .join('');
    const rates = result.completeness
        .map((c) => {
            const rate = pct(c, total);
            return `<td class="px-2 py-2 text-center text-xs font-bold tabular-nums ${rateCellClass(rate)}">${fmtPct(rate)}</td>`;
        })
        .join('');
    return `
        <div class="mt-6">
            <div class="flex items-center justify-between gap-3 mb-2">
                <h4 class="text-sm font-black text-slate-800">
                    기록 하나가 채운 항목 수 <span class="text-xs font-normal text-slate-400">(핵심 ${CORE_FIELD_SPECS.length}항목 중)</span>
                </h4>
                ${guideButton('completeness')}
            </div>
            <div class="overflow-x-auto rounded-xl border border-slate-200">
                <table class="min-w-full text-sm">
                    <thead class="bg-slate-50">
                        <tr class="border-b border-slate-200">
                            <th class="px-3 py-2 text-left text-xs font-bold text-slate-600 uppercase whitespace-nowrap">채운 항목</th>
                            ${head}
                        </tr>
                    </thead>
                    <tbody>
                        <tr class="border-b border-slate-100">
                            <td class="px-3 py-2 text-xs font-bold text-slate-600 whitespace-nowrap">기록 수</td>
                            ${counts}
                        </tr>
                        <tr>
                            <td class="px-3 py-2 text-xs font-bold text-slate-600 whitespace-nowrap">비율</td>
                            ${rates}
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>`;
}


function renderMomentAnalyticsResult(result, meta) {
    const container = document.getElementById('momentAnalyticsContainer');
    if (!container) return;

    if (!result.overall.total) {
        container.innerHTML = `
            <div class="text-center py-10 text-slate-400">
                <i data-lucide="chart-column" class="text-2xl mb-2"></i>
                <p class="text-sm">${escapeHtml(result.startYmd)} ~ ${escapeHtml(result.endYmd)} 구간에 분석할 기록이 없습니다.</p>
            </div>`;
        refreshLucideIcons(container);
        return;
    }

    const warn = meta.truncated
        ? `<div class="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
               읽기 상한(${MOMENT_ANALYTICS_DOC_CAP.toLocaleString()}건)에 걸려 <b>가장 최근 날짜부터</b> 그만큼만 집계했습니다. 기간을 좁혀 다시 실행하세요.
           </div>`
        : '';

    // 캐시로 그린 화면은 「읽기 없이 다시 그린 것」임을 밝히고, 새로 읽을 길을 같이 준다
    const cachedNote = meta.fromCache
        ? `<span class="inline-flex items-center gap-2 text-xs text-slate-500">
               <span class="px-2 py-0.5 rounded-full bg-slate-100 font-bold">${Math.max(1, Math.round(meta.cacheAgeMs / 60000))}분 전 결과 · 읽기 없음</span>
               <button type="button" onclick="window.runMomentAnalytics(true)" class="underline hover:text-slate-700 font-bold">새로 읽기</button>
           </span>`
        : '';

    container.innerHTML = `
        ${warn}
        <div class="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span class="text-sm font-black text-slate-800">${escapeHtml(result.startYmd)} ~ ${escapeHtml(result.endYmd)}</span>
            <span class="text-xs text-slate-400">${result.spanDays}일 · 슬롯 날짜(date) 기준</span>
            ${cachedNote}
        </div>
        ${renderSummaryCards(result, meta)}
        ${renderAxisCharts(buildAxisBreakdown(result, meta.tagLists || {}), result.overall.total)}
        ${renderTrendTable(result)}
        ${renderCompletenessTable(result)}`;
    refreshLucideIcons(container);
    bindMomentGuideOnce();
    // 라벨은 DOM 에 붙은 뒤에야 폭을 잴 수 있다 — 그리기와 재기가 나뉘는 이유
    const charts = document.getElementById('momentAxisCharts');
    if (charts) {
        fitAxisBarLabels(charts);
        watchAxisBarWidth(charts);
    }
}

async function runMomentAnalytics(force = false) {
    const range = readMomentAnalyticsRange();
    if (!range) return;

    const cacheKey = `${range.startYmd}_${range.endYmd}`;
    if (!force) {
        const hit = momentAnalyticsCache.get(cacheKey);
        const age = hit ? Date.now() - hit.ts : Infinity;
        if (hit && age < MOMENT_ANALYTICS_CACHE_TTL_MS) {
            momentAnalyticsLastResult = hit.result;
            momentAnalyticsLastMeta = hit.meta;
            renderMomentAnalyticsResult(hit.result, { ...hit.meta, fromCache: true, cacheAgeMs: age });
            console.log(`[모먼트 분석] ${cacheKey}: 캐시 사용 — Firestore 읽기 없음`);
            return;
        }
    }

    const container = document.getElementById('momentAnalyticsContainer');
    if (container) {
        container.innerHTML =
            '<div class="text-center py-10 text-slate-400"><i data-lucide="loader-circle" class="text-2xl mb-2 lucide-spin"></i><p class="text-sm" id="momentAnalyticsProgress">기록을 읽는 중…</p></div>';
        refreshLucideIcons(container);
    }

    try {
        const excluded = await getExcludedAnalyticsUidSet().catch(() => new Set());
        /**
         * 본표의 행 순서는 「태그 관리」의 목록 순서다 — 관리자가 보는 화면과 같은 줄에
         * 같은 값이 오도록. 문서 1건 읽기이고, 실패해도 기본값을 돌려주므로 분석을 막지 않는다.
         */
        const { tags: tagLists, fromServer: tagListsFromServer } = await loadAdminTagLists();
        const { rows, truncated, source, serverReads } = await loadRowsForRange(range.startYmd, range.endYmd, (msg) => {
            const p = document.getElementById('momentAnalyticsProgress');
            if (p) p.textContent = msg;
        });

        const readCount = rows.length;
        const targetRows = rows.filter((m) => {
            if (excluded && excluded.has(m.userId)) return false;
            // 하루기록 미러는 이 항목들을 갖지 않는다 — 분모에 넣으면 입력률이 통째로 내려앉는다
            if (isDailyJournalMealRecord(m) || String(m.slotId || '') === 'daily_journal') return false;
            // 사용자 메모도 같다 — 식사 축이 없다 (docs/user-memo-items.md §6)
            if (isMemoMealRecord(m)) return false;
            return true;
        });

        const result = analyzeMomentRows(targetRows, range.startYmd, range.endYmd);
        const meta = {
            readCount,
            skippedCount: readCount - targetRows.length,
            truncated,
            source,
            serverReads,
            tagLists,
            tagListsFromServer
        };
        momentAnalyticsLastResult = result;
        momentAnalyticsLastMeta = meta;
        momentAnalyticsCache.set(cacheKey, { ts: Date.now(), result, meta });
        renderMomentAnalyticsResult(result, meta);
        console.log(
            `[모먼트 분석] ${range.startYmd}~${range.endYmd}: ${source === 'mirror' ? `미러 집계 (서버 읽기 ${serverReads}건)` : `서버 읽기 ${readCount}건`} → 대상 ${targetRows.length}건, 사용자 ${result.userCount}명`
        );
    } catch (e) {
        console.error('[모먼트 분석] 실패:', e);
        const hint =
            e?.code === 'failed-precondition'
                ? '<br><span class="text-xs">meals 컬렉션 그룹의 date 인덱스가 필요할 수 있습니다: <code>firebase deploy --only firestore:indexes</code></span>'
                : '';
        if (container) {
            container.innerHTML = `
                <div class="text-center py-10 text-red-500">
                    <i data-lucide="triangle-alert" class="text-2xl mb-2"></i>
                    <p class="text-sm">분석 중 오류가 발생했습니다: ${escapeHtml(e?.message || String(e))}${hint}</p>
                </div>`;
            refreshLucideIcons(container);
        }
    }
}

window.syncMomentAnalyticsRangeInputs = syncMomentAnalyticsRangeInputs;

window.runMomentAnalytics = function (force = false) {
    return runAdminRefreshAction('momentAnalyticsRunBtn', () => runMomentAnalytics(force === true), {
        loadingText: '분석 중…'
    });
};

/** 결과를 엑셀(.xlsx)로 — 선택지 분포 + 항목별 + 무엇을 경로 + 추이 */
window.exportMomentAnalyticsToExcel = async function () {
    const result = momentAnalyticsLastResult;
    if (!result || !result.overall.total) {
        alert('먼저 「분석 실행」으로 결과를 만들어 주세요.');
        return;
    }
    const total = result.overall.total;
    const fieldRows = MOMENT_FIELD_SPECS.map((spec) => ({
        항목: spec.label.replace('└ ', ''),
        구분: spec.aux ? '참고' : spec.core ? '핵심' : '상세',
        입력: result.overall.counts[spec.key],
        미입력: total - result.overall.counts[spec.key],
        입력률: Number(pct(result.overall.counts[spec.key], total).toFixed(1))
    }));
    /** 화면 추이 표와 같은 열·같은 순서 — 두 곳이 갈리면 어느 쪽이 맞는지 알 수 없다 */
    const trendRowOf = (b, label) => {
        const row = { 구간: label ?? String(b.label).replace('\n', ' '), 기록수: b.total };
        TREND_COLUMN_GROUPS.forEach((g) => {
            g.cols.forEach((col) => {
                const name = g.cols.length > 1 ? `${g.label}-${col.label}` : col.label;
                const denom = col.denom ? col.denom(b) : b.total;
                row[name] = denom ? Number(pct(Math.max(0, col.value(b)), denom).toFixed(1)) : '';
            });
        });
        return row;
    };
    const trendRows = [trendRowOf(result.overall, '전체'), ...result.trend.map((b) => trendRowOf(b))];
    /**
     * 추이 시트의 「추천 분류」 %는 제안이 뜬 기록이 분모다(화면과 같다). 여기서는 그 분모 자체와
     * 전체 대비 비중까지 건수로 펴 둔다 — 셋으로 가른 결말(고침/거부)은 추이 표에서 한 칸으로 접힌다.
     */
    const suggestRows = FOOD_SUGGEST_SPECS.map((spec) => ({
        결말: spec.label,
        건수: result.overall.counts[spec.key] || 0
    }));
    const suggestOffered = suggestRows.reduce((acc, r) => acc + r.건수, 0);
    suggestRows.forEach((r) => {
        r['제안 대비'] = Number(pct(r.건수, suggestOffered).toFixed(1));
        r['전체 대비'] = Number(pct(r.건수, total).toFixed(1));
    });
    suggestRows.push({ 결말: '(제안이 뜬 기록)', 건수: suggestOffered, '제안 대비': 100, '전체 대비': Number(pct(suggestOffered, total).toFixed(1)) });
    /** 화면 본표를 그대로 편 시트 — 축·선택지·건수·직접·자동 */
    const axisRows = [];
    buildAxisBreakdown(result, momentAnalyticsLastMeta?.tagLists || {}).forEach((axis) => {
        axis.rows.forEach((r) => {
            axisRows.push({
                축: axis.label,
                선택지: r.label,
                구분: '태그 목록',
                건수: r.n,
                비율: Number(r.rate.toFixed(1)),
                직접: r.direct,
                자동: r.auto
            });
        });
        axis.outside.samples.forEach((r) => {
            axisRows.push({
                축: axis.label,
                선택지: r.label,
                구분: '목록 밖',
                건수: r.n,
                비율: Number(pct(r.n, axis.total).toFixed(1)),
                직접: r.direct,
                자동: r.auto
            });
        });
        axisRows.push({
            축: axis.label,
            선택지: '(목록 밖 합계)',
            구분: '합계',
            건수: axis.outside.n,
            비율: Number(axis.outside.rate.toFixed(1)),
            직접: '',
            자동: ''
        });
        (axis.emptyPaths || []).forEach((e) => {
            axisRows.push({ 축: axis.label, 선택지: e.label, 구분: '미입력 분해', 건수: e.n, 비율: Number(e.rate.toFixed(1)), 직접: '', 자동: '' });
        });
        axisRows.push({
            축: axis.label,
            선택지: '(미입력)',
            구분: '합계',
            건수: axis.empty,
            비율: Number(pct(axis.empty, axis.total).toFixed(1)),
            직접: '',
            자동: ''
        });
    });
    const pathRows = FOOD_PATH_SPECS.map((spec) => ({
        경로: spec.label,
        건수: result.overall.counts[spec.key],
        비율: Number(pct(result.overall.counts[spec.key], total).toFixed(1))
    }));
    try {
        const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(axisRows), '선택지 분포');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fieldRows), '항목별 입력률');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pathRows), '무엇을 경로');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(suggestRows), '추천 분류');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(trendRows), '기간 추이');
        XLSX.writeFile(wb, `mealog-moment-analytics-${result.startYmd}-${result.endYmd}.xlsx`);
    } catch (e) {
        console.error('[모먼트 분석] 엑셀 내보내기 실패:', e);
        alert('엑셀 내보내기에 실패했습니다: ' + (e?.message || e));
    }
};

if (typeof document !== 'undefined') {
    const boot = () => syncMomentAnalyticsRangeInputs();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
}

export { runMomentAnalytics };
