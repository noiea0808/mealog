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
import { refreshLucideIcons } from '../icons.js';
import {
    MOMENT_FIELD_SPECS,
    CORE_FIELD_SPECS,
    FOOD_PATH_SPECS,
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
    const item = (color, label, n, rate, muted = false, ring = '') => `
        <span class="inline-flex items-center gap-1.5 mr-3 mb-1 ${muted ? 'opacity-45' : ''}">
            <span class="inline-block w-2.5 h-2.5 rounded-sm shrink-0 ${ring}" style="background:${color}"></span>
            <span class="text-[11px] ${muted ? 'text-slate-500' : 'text-slate-700'} whitespace-nowrap">${escapeHtml(label)}</span>
            <span class="text-[11px] tabular-nums text-slate-400 whitespace-nowrap">${
                n > 0 ? `${n.toLocaleString()} · ${rate.toFixed(rate < 10 ? 1 : 0)}%` : '0'
            }</span>
        </span>`;

    // 막대의 칸 순서(많은 순)를 그대로 따라간다 — 눈이 왼쪽부터 짚어 내려오게
    const chips = [
        ...axis.rows.filter((r) => r.slot !== null).map((r) => item(axisSlotColor(r.slot), r.label, r.n, r.rate)),
        c.folded.n ? item(AXIS_FOLDED_COLOR, `그 외 ${c.folded.distinct}종`, c.folded.n, c.folded.rate) : '',
        c.outside.n ? item(AXIS_OUTSIDE_COLOR, `목록 밖 ${c.outside.distinct}종`, c.outside.n, c.outside.rate) : '',
        c.empty.n ? item(AXIS_EMPTY_COLOR, '미입력', c.empty.n, c.empty.rate, false, 'ring-1 ring-inset ring-slate-300') : '',
        // 아무도 안 고른 칩은 맨 뒤에 흐리게 — 막대에는 칸이 없어 여기서만 보인다
        ...axis.rows.filter((r) => r.n === 0).map((r) => item('transparent', r.label, 0, 0, true, 'ring-1 ring-inset ring-slate-300'))
    ].join('');

    /** 한 색으로 묶인 것들의 이름 — 묶었다고 정체까지 감추지는 않는다 */
    const detail = (label, items, more) =>
        items.length
            ? `<p class="text-[11px] text-slate-400 mt-0.5">${label}: ${items
                  .map((x) => `${escapeHtml(x.label)} ${x.n.toLocaleString()}`)
                  .join(' · ')}${more ? ' …' : ''}</p>`
            : '';

    const emptyDetail =
        axis.emptyPaths && axis.empty
            ? `<p class="text-[11px] text-slate-400 mt-0.5">미입력 내역: ${axis.emptyPaths
                  .map((p) => `${escapeHtml(p.label.replace(/\(.*\)/, '').trim())} ${p.n.toLocaleString()}`)
                  .join(' · ')}</p>`
            : '';

    return `
        <div class="mt-1.5">
            <div class="flex flex-wrap">${chips}</div>
            ${detail('그 외', c.folded.items || [], false)}
            ${detail('목록 밖', c.outside.samples || [], c.outside.distinct > (c.outside.samples || []).length)}
            ${emptyDetail}
        </div>`;
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
            <h4 class="text-sm font-black text-slate-800 mb-1">
                축별 구성 <span class="text-xs font-normal text-slate-400">(막대 전체 = 분석 대상 기록 ${total.toLocaleString()}건 · 100%)</span>
            </h4>
            <p class="text-[11px] text-slate-400 mb-2">
                각 막대의 <b>칠해진 길이</b>가 그 축의 입력률이고, <b>칸 나눔</b>이 무엇으로 채워졌는지입니다.
                네 막대가 같은 100%를 나눠 쓰므로 축끼리 길이를 그대로 비교할 수 있습니다. 칸에 마우스를 올리면 정확한 값이 뜹니다.
            </p>
            <div id="momentAxisCharts" class="rounded-xl border border-slate-200 bg-white px-4 py-2 divide-y divide-slate-100">${bars}</div>
            <p class="mt-2 text-[11px] leading-relaxed text-slate-400">
                · <b>자동</b> = 사람이 고르지 않았는데 값이 남은 것. 「어떻게·어디서·누구와」는 맥락 예측이 자동 적용한 축(<code>autoContext</code>),
                「무엇을」은 로컬·서버 분류기가 채운 값(<code>categoryAuto</code>)입니다.<br>
                · <b>칸도 범례도 많은 순</b>으로 섭니다. 색은 그 순위를 따라가므로, 다른 기간을 보면 같은 값의 색이 달라질 수 있습니다 —
                식별은 언제나 <b>범례의 이름</b>으로 하세요(막대 바로 아래 붙어 있는 이유입니다).<br>
                · <b>맨 뒤 흐린 칩</b>은 기간 안에 아무도 고르지 않은 선택지입니다 — 구분을 접거나 이름을 바꿀 후보입니다.<br>
                · <b>무엇을</b>은 축이 둘입니다. <b>형태</b>(밥류·면류…)는 사용자가 고르거나 분류기가 채우고,
                <b>종류</b>(한식·중식…)는 <b>묻지 않고</b> 분류기가 붙입니다 — 「면을 얼마나 먹나」와 「중식을 얼마나 먹나」는 다른 질문이라 축이 둘입니다.
                형태 축에서 목록 밖으로 밀리는 옛 한식·양식 기록이 종류 축에서는 제자리를 찾습니다.
                다만 <b>종류의 「미입력」을 실패로 읽지 마세요</b> — 과일·커피·채소처럼 <b>축이 애초에 해당되지 않는 형태</b>가
                여기 섞여 있습니다(「사과가 한식인가 양식인가」는 질문이 성립하지 않습니다).<br>
                · <b>목록 밖</b>은 지금의 태그 목록에 없는 값입니다. 「무엇을」의 목록 밖은 대부분 <b>축을 갈아끼우기 전에 저장된 옛 어휘</b>(한식·양식·일식·중식·분식·카페)와 「기타」입니다 —
                「한식」은 밥류일 수도 국물요리일 수도 있어 어느 칩에도 넣지 않습니다(표기만 달랐던 옛 형태 축 값은 읽을 때 맞춰 제 칩으로 갑니다).
                「어디서」는 끼니가 가게 이름을 자유 입력하므로 목록 밖이 큰 것이 정상입니다.<br>
                · 색은 <b>많은 순 앞 ${AXIS_CHART_SLOTS}개</b>까지입니다. 아홉 번째 색을 만들면 색맹 조건에서 기존 색과 구별되지 않아,
                나머지는 「그 외」로 묶고 이름은 아래 잔줄에 답니다.<br>
                · 「무엇을」의 <b>자동</b>은 서버 AI 배치가 <b>나중에</b> 돌아 채웁니다. 최근 며칠은 아직 안 돌았을 수 있어 「서버 분류 대기」가 부풀어 보입니다.
            </p>
        </div>`;
}

/**
 * 항목별 입력률 — 선택지가 없는 항목(사진·코멘트·만족도…)까지 포함한 「채워졌나」 표.
 * 막대는 뺐다: 12줄짜리 막대가 화면을 채우는 데 비해, 정작 비교하고 싶은 것은 옆 칸의 숫자였다.
 */
function renderFieldTable(result) {
    const total = result.overall.total;
    const rows = MOMENT_FIELD_SPECS.map((spec) => {
        const filled = result.overall.counts[spec.key];
        const rate = pct(filled, total);
        const labelClass = spec.core ? 'font-bold text-slate-800' : 'text-slate-500';
        return `
            <tr class="border-b border-slate-100 ${spec.aux ? 'bg-slate-50/60' : ''}">
                <td class="px-3 py-1.5 ${labelClass} whitespace-nowrap">${escapeHtml(spec.label)}${
                    spec.gated ? '<span class="ml-1 text-[10px] text-amber-600 font-bold">설정</span>' : ''
                }</td>
                <td class="px-3 py-1.5 text-right tabular-nums text-slate-700">${filled.toLocaleString()}</td>
                <td class="px-3 py-1.5 text-right tabular-nums text-slate-400">${(total - filled).toLocaleString()}</td>
                <td class="px-3 py-1.5 text-right text-xs font-black tabular-nums ${rateCellClass(rate)}">${fmtPct(rate)}</td>
                <td class="px-3 py-1.5 text-[11px] text-slate-400 whitespace-nowrap hidden lg:table-cell">${escapeHtml(spec.note || '')}</td>
            </tr>`;
    }).join('');

    return `
        <div class="mt-6">
            <h4 class="text-sm font-black text-slate-800 mb-2">항목별 입력률</h4>
            <div class="overflow-x-auto rounded-xl border border-slate-200">
                <table class="min-w-full text-sm">
                    <thead class="bg-slate-50">
                        <tr class="border-b border-slate-200">
                            <th class="px-3 py-2 text-left text-xs font-bold text-slate-600 uppercase">항목</th>
                            <th class="px-3 py-2 text-right text-xs font-bold text-slate-600 uppercase">입력</th>
                            <th class="px-3 py-2 text-right text-xs font-bold text-slate-600 uppercase">미입력</th>
                            <th class="px-3 py-2 text-right text-xs font-bold text-slate-600 uppercase">입력률</th>
                            <th class="px-3 py-2 text-left text-xs font-bold text-slate-600 uppercase hidden lg:table-cell">비고</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
}

function renderTrendTable(result) {
    if (!result.trend.length) return '';
    // 최신 구간이 위로 오게 뒤집어 보여 준다
    const rows = [...result.trend].reverse();
    /**
     * 핵심 8열 + 「무엇을(최종)」 + 「자동적용」.
     * 자동적용은 맥락 예측이 한 축이라도 채운 기록의 비율이다 — 시트 개편이 입력을
     * 늘렸는지는 항목 입력률만으로는 답이 안 나온다. 입력률이 올라도 그게 사람이
     * 더 채운 것인지 기계가 메운 것인지 갈리지 않기 때문이다.
     */
    const trendSpecs = [...CORE_FIELD_SPECS, MOMENT_FIELD_SPECS.find((f) => f.key === 'whatFinal')].filter(Boolean);
    const head =
        trendSpecs
            .map(
                (f) =>
                    `<th class="px-2 py-2 text-center text-xs font-bold text-slate-600 whitespace-nowrap">${escapeHtml(
                        f.key === 'whatFinal' ? '무엇을(최종)' : f.label
                    )}</th>`
            )
            .join('') +
        '<th class="px-2 py-2 text-center text-xs font-bold text-sky-700 whitespace-nowrap border-l border-slate-200">자동적용</th>';
    const body = rows
        .map((b) => {
            const cells = trendSpecs
                .map((f) => {
                    const rate = pct(b.counts[f.key], b.total);
                    return `<td class="px-2 py-2 text-center text-xs font-bold tabular-nums ${rateCellClass(rate)}">${
                        b.total ? rate.toFixed(0) : '-'
                    }</td>`;
                })
                .join('');
            const autoRate = pct(b.counts.autoContext || 0, b.total);
            return `
                <tr class="border-b border-slate-100">
                    <td class="px-3 py-2 text-xs font-bold text-slate-700 whitespace-pre-line sticky left-0 bg-white">${escapeHtml(b.label)}</td>
                    <td class="px-3 py-2 text-right text-xs tabular-nums text-slate-500">${b.total.toLocaleString()}</td>
                    ${cells}
                    <td class="px-2 py-2 text-center text-xs font-bold tabular-nums text-sky-700 border-l border-slate-200">${
                        b.total ? autoRate.toFixed(0) : '-'
                    }</td>
                </tr>`;
        })
        .join('');

    return `
        <div class="mt-6">
            <h4 class="text-sm font-black text-slate-800 mb-2">
                기간 추이 <span class="text-xs font-normal text-slate-400">(${result.byWeek ? '주별' : '일별'} · 단위 %)</span>
            </h4>
            <div class="overflow-x-auto rounded-xl border border-slate-200">
                <table class="min-w-full text-sm border-separate border-spacing-0">
                    <thead class="bg-slate-50">
                        <tr class="border-b border-slate-200">
                            <th class="px-3 py-2 text-left text-xs font-bold text-slate-600 uppercase sticky left-0 bg-slate-50">${
                                result.byWeek ? '주차' : '날짜'
                            }</th>
                            <th class="px-3 py-2 text-right text-xs font-bold text-slate-600 uppercase whitespace-nowrap">기록</th>
                            ${head}
                        </tr>
                    </thead>
                    <tbody>${body}</tbody>
                </table>
            </div>
            <p class="mt-2 text-[11px] text-slate-400">
                · <b>자동적용</b> = 맥락 예측이 어떻게·어디서·누구와 중 한 축이라도 자동으로 채운 기록의 비율.
                개편 전 기록에는 이 자국이 없어 0으로 나옵니다.
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
            <h4 class="text-sm font-black text-slate-800 mb-2">
                기록 하나가 채운 항목 수 <span class="text-xs font-normal text-slate-400">(핵심 ${CORE_FIELD_SPECS.length}항목 중)</span>
            </h4>
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
        ${renderFieldTable(result)}
        ${renderTrendTable(result)}
        ${renderCompletenessTable(result)}
        <p class="mt-4 text-[11px] leading-relaxed text-slate-400">
            · 분모는 기간 안의 끼니·간식 기록입니다. 하루기록(소감)과 캡처 공유는 이 항목들을 갖지 않아 제외했습니다.<br>
            · <b>만족도·포만감</b>은 사용자가 설정에서 끌 수 있는 항목이라, 미입력에는 「꺼 둔 사용자」가 섞여 있습니다.<br>
            · 「항목별 입력률」의 <b>무엇을</b>은 사용자가 확정한 값만 셉니다 — 자동 분류는 이 필드를 건드리지 않습니다.
              자동까지 합친 값은 바로 아래 「무엇을(최종 분류 도달)」 행과, 위 「축별 구성」의 무엇을 막대에 있습니다.<br>
            · 통계 제외 UID(대시보드 설정)의 기록은 빼고 셉니다.
        </p>`;
    refreshLucideIcons(container);
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
    const trendRows = result.trend.map((b) => {
        const row = { 구간: String(b.label).replace('\n', ' '), 기록수: b.total };
        CORE_FIELD_SPECS.forEach((f) => {
            row[f.label] = Number(pct(b.counts[f.key], b.total).toFixed(1));
        });
        row['무엇을(최종)'] = Number(pct(b.counts.whatFinal, b.total).toFixed(1));
        row['자동적용'] = Number(pct(b.counts.autoContext || 0, b.total).toFixed(1));
        return row;
    });
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
