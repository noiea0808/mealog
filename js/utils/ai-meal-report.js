/**
 * AI 식단분석 리포트 — JSON 파싱 · 공유카드형 UI
 */

function clipField(value) {
    if (value == null) return '';
    return String(value).trim();
}

/**
 * 파싱된 객체 → 표준 필드 (legacy goodPoint/improvePoint 호환)
 *
 * score 는 더 이상 여기서 오지 않는다. 화면에 뜨는 점수는 diet-record-score.js 가
 * 리포트 문서의 입력 스냅샷과 balance 로 계산한다.
 * 구버전 문서의 responseText 에 남아 있는 score 는 의미가 다르므로 무시한다.
 *
 * mood 도 뺐다. title 과 역할이 겹쳐 같은 하루를 두 번 이름 붙이고 있었다.
 * 구버전 문서에 남아 있어도 읽지 않는다.
 */
export function normalizeAiMealReportFields(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return null;
    }
    return {
        lens: clipField(obj.lens),
        // 점수 내역의 "구성 균형" 칸으로만 나간다. 리포트 문장에는 쓰이지 않는다.
        balance: obj.balance,
        balanceNote: clipField(obj.balanceNote),
        title: clipField(obj.title),
        summary: clipField(obj.summary),
        highlight: clipField(obj.highlight || obj.goodPoint),
        nudge: clipField(obj.nudge || obj.improvePoint)
    };
}

/**
 * AI 응답(string | object) → 카드 UI용 필드.
 * 파싱 실패 시 fallback 객체 반환. 입력 없으면 null.
 */
export function parseAiMealReport(aiResponse) {
    try {
        if (aiResponse == null || aiResponse === '') return null;

        if (typeof aiResponse === 'object') {
            const normalized = normalizeAiMealReportFields(aiResponse);
            return normalized || null;
        }

        const cleaned = String(aiResponse)
            .replace(/```json/gi, '')
            .replace(/```/g, '')
            .trim();
        if (!cleaned) return null;

        const parsed = JSON.parse(cleaned);
        const normalized = normalizeAiMealReportFields(parsed);
        if (!normalized) throw new Error('invalid report shape');
        return normalized;
    } catch (error) {
        console.warn('AI meal report parse failed:', error);
        const raw = typeof aiResponse === 'string' ? aiResponse.trim() : '';
        return {
            title: '오늘의 식사 리포트',
            summary: raw || '분석 결과를 불러왔어요.',
            highlight: '',
            nudge: '',
            _parseFailed: true
        };
    }
}

/** Firestore aiDietReports 문서 → parseAiMealReport 입력 */
export function extractAiMealReportSource(data) {
    if (!data || typeof data !== 'object') return null;
    const raw = typeof data.responseText === 'string' ? data.responseText.trim() : '';
    if (raw) return raw;

    const hasLegacy =
        data.summary ||
        data.goodPoint ||
        data.improvePoint ||
        (data.score != null && data.score !== '');
    if (!hasLegacy) return null;

    return {
        title: '',
        summary: clipField(data.summary),
        highlight: clipField(data.goodPoint),
        nudge: clipField(data.improvePoint)
    };
}

/** Firestore aiDietReports 문서 → 카드 하단 사진(기록당 1장, 최대 3장) */
export function extractAnalyzedPhotoUrlsForDisplay(data, maxTotal = 3) {
    const meals = Array.isArray(data?.inputMeals) ? data.inputMeals : [];
    const urls = [];
    for (const m of meals) {
        if (urls.length >= maxTotal) break;
        const mealUrls = Array.isArray(m.analyzedPhotoUrls) ? m.analyzedPhotoUrls.filter(Boolean) : [];
        if (mealUrls.length > 0) urls.push(String(mealUrls[0]).trim());
    }
    return urls.filter(Boolean).slice(0, maxTotal);
}

function renderAiMealReportPhotosHtml(photoUrls, esc) {
    if (!photoUrls?.length) return '';
    const cells = photoUrls
        .map(
            (url, i) =>
                `<div class="aspect-square rounded-lg overflow-hidden border border-slate-200/90 bg-slate-100">
                    <img src="${esc(url)}" alt="분석 사진 ${i + 1}" class="w-full h-full object-cover" loading="lazy" decoding="async">
                </div>`
        )
        .join('');
    return `<div class="grid grid-cols-3 gap-1.5">${cells}</div>`;
}

/**
 * 기록 점수 내역 — 평소엔 접혀 있고 펼치면 그날의 실제 내역을 보여준다.
 * 점수를 띄우면서 근거를 감추면 모호해진다. 근거를 밝힐 수 있는 점수로 바꾼 이유가 이것이다.
 */
function renderDietRecordScoreDetailHtml(recordScore, esc) {
    if (!recordScore?.sections?.length) return '';
    const rows = recordScore.sections
        .map(
            (s) =>
                `<div class="flex items-baseline justify-between gap-2 py-1">
                    <span class="text-[12px] font-semibold text-slate-600 shrink-0">${esc(s.label)}</span>
                    <span class="text-[11px] text-slate-400 truncate flex-1 text-right">${esc(s.detail)}</span>
                    <span class="text-[12px] font-bold text-slate-700 tabular-nums shrink-0 w-12 text-right">${esc(String(s.got))}<span class="text-slate-400 font-medium">/${esc(String(s.max))}</span></span>
                </div>`
        )
        .join('');
    return `<details class="ai-meal-report-score-detail rounded-lg border border-slate-200/80 bg-slate-50/60 px-3 py-1.5">
        <summary class="cursor-pointer list-none text-[11px] font-bold text-slate-500 select-none">점수 내역 보기</summary>
        <div class="mt-1 divide-y divide-slate-200/70">${rows}</div>
        <p class="mt-1.5 pt-1.5 border-t border-slate-200/70 text-[9px] leading-tight text-slate-400">구성 균형과 그날 기록을 얼마나 남겼는지로 매긴 점수예요.</p>
    </details>`;
}

/**
 * 공유카드형 HTML (escapeHtml은 호출 측에서 주입)
 * @param {ReturnType<parseAiMealReport>} report
 * @param {(s: string) => string} escapeHtml
 * @param {{ photoUrls?: string[] }} [options]
 */
export function renderAiMealReportCardHtml(report, escapeHtml, options = {}) {
    if (!report) {
        return `<div class="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">표시할 분석 결과가 없습니다.</div>`;
    }

    const esc = typeof escapeHtml === 'function' ? escapeHtml : (s) => s;
    // 점수는 AI가 아니라 그날 기록에서 계산된다. 근거를 펼쳐 보일 수 있는 숫자만 띄운다.
    const recordScore = options.recordScore || null;
    const hasScore = recordScore != null && Number.isFinite(Number(recordScore.total));
    const score = hasScore ? recordScore.total : null;
    const title = clipField(report.title);
    const summary = clipField(report.summary);
    const highlight = clipField(report.highlight);
    const nudge = clipField(report.nudge);
    const photoUrls = Array.isArray(options.photoUrls)
        ? options.photoUrls.filter(Boolean).slice(0, 3)
        : [];

    // mood 뱃지는 뺐다 — title 과 역할이 겹쳐 같은 하루에 이름을 두 번 붙이고 있었다.
    const topRow = hasScore
        ? `<div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span class="text-2xl font-black text-emerald-600 tabular-nums leading-none tracking-tight">${esc(String(score))}<span class="text-sm font-bold text-emerald-600/70">점</span></span>
                <span class="text-[11px] font-semibold text-slate-400 leading-none">오늘의 점수</span>
            </div>`
        : '';

    const photosBlock = photoUrls.length ? renderAiMealReportPhotosHtml(photoUrls, esc) : '';

    const titleBlock = title
        ? `<h3 class="text-base font-black text-slate-800 leading-snug tracking-tight">${esc(title)}</h3>`
        : '';

    const summaryBlock = summary
        ? `<div>
                <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">오늘의 식사 흐름</p>
                <p class="text-sm text-slate-700 leading-normal">${esc(summary)}</p>
            </div>`
        : '';

    // highlight는 "잘한 점"이 아니라 그날 고른 렌즈로 본 관찰,
    // nudge는 조언이 아니라 알아봐 주는 한마디다. 라벨·색이 평가처럼 읽히지 않게 한다.
    const highlightBlock = highlight
        ? `<div class="rounded-lg bg-emerald-50/90 border border-emerald-100/90 px-3 py-2.5">
                <p class="text-[11px] font-bold text-emerald-800 mb-1">오늘 눈에 띈 것</p>
                <p class="text-sm text-slate-800 leading-normal">${esc(highlight)}</p>
            </div>`
        : '';

    const nudgeBlock = nudge
        ? `<div class="rounded-lg bg-violet-50/90 border border-violet-100/90 px-3 py-2.5">
                <p class="text-[11px] font-bold text-violet-900 mb-1">밀로그의 한마디</p>
                <p class="text-sm text-slate-800 leading-normal">${esc(nudge)}</p>
            </div>`
        : '';

    return `<article class="ai-meal-report-card rounded-xl border border-slate-200/90 bg-gradient-to-br from-white via-emerald-50/25 to-slate-50/40 shadow-[0_2px_16px_-4px_rgba(15,23,42,0.07)] overflow-hidden">
        <div class="p-4 space-y-2.5">
            ${topRow}
            ${hasScore ? renderDietRecordScoreDetailHtml(recordScore, esc) : ''}
            ${photosBlock}
            ${titleBlock}
            ${summaryBlock}
            ${highlightBlock}
            ${nudgeBlock}
        </div>
    </article>`;
}

/** 목록 미리보기용 한 줄 */
export function aiMealReportPreviewLine(report) {
    if (!report) return '—';
    const title = clipField(report.title);
    const summary = clipField(report.summary);
    const text = title || summary;
    if (!text) return '—';
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat;
}
