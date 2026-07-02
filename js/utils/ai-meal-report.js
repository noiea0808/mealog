/**
 * AI 식단분석 리포트 — JSON 파싱 · 공유카드형 UI
 */

function clipField(value) {
    if (value == null) return '';
    return String(value).trim();
}

function normalizeScore(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, Math.round(n)));
}

/** 파싱된 객체 → 표준 필드 (legacy goodPoint/improvePoint 호환) */
export function normalizeAiMealReportFields(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return null;
    }
    return {
        score: normalizeScore(obj.score),
        mood: clipField(obj.mood),
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
            score: null,
            mood: '분석 완료',
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
        score: data.score ?? null,
        mood: '',
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

/** 리포트 카드·공유 캡처 공통 분석 사진 썸네일 크기(px) */
export const AI_MEAL_REPORT_PHOTO_THUMB_PX = 72;

function renderAiMealReportPhotosHtml(photoUrls, esc) {
    if (!photoUrls?.length) return '';
    const sizeClass = 'h-[4.5rem] w-[4.5rem]';
    const cells = photoUrls
        .map(
            (url, i) =>
                `<div class="${sizeClass} shrink-0 rounded-lg overflow-hidden border border-slate-200/90 bg-slate-100">
                    <img src="${esc(url)}" alt="분석 사진 ${i + 1}" class="w-full h-full object-cover" loading="lazy" decoding="async">
                </div>`
        )
        .join('');
    return `<div class="flex flex-wrap justify-center gap-2.5">${cells}</div>`;
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
    const score = report.score;
    const hasScore = score != null && Number.isFinite(Number(score));
    const mood = clipField(report.mood);
    const title = clipField(report.title);
    const summary = clipField(report.summary);
    const highlight = clipField(report.highlight);
    const nudge = clipField(report.nudge);
    const photoUrls = Array.isArray(options.photoUrls)
        ? options.photoUrls.filter(Boolean).slice(0, 3)
        : [];

    const topRow =
        hasScore || mood
            ? `<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                ${
                    hasScore
                        ? `<span class="text-2xl font-black text-emerald-600 tabular-nums leading-none tracking-tight">${esc(String(score))}<span class="text-sm font-bold text-emerald-600/70">점</span></span>`
                        : ''
                }
                ${
                    hasScore && mood
                        ? `<span class="text-slate-300 font-light select-none" aria-hidden="true">·</span>`
                        : ''
                }
                ${
                    mood
                        ? `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-violet-100 text-violet-800 border border-violet-200/60">${esc(mood)}</span>`
                        : ''
                }
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

    const highlightBlock = highlight
        ? `<div class="rounded-lg bg-emerald-50/90 border border-emerald-100/90 px-3 py-2.5">
                <p class="text-[11px] font-bold text-emerald-800 mb-1">좋았던 흐름</p>
                <p class="text-sm text-slate-800 leading-normal">${esc(highlight)}</p>
            </div>`
        : '';

    const nudgeBlock = nudge
        ? `<div class="rounded-lg bg-amber-50/90 border border-amber-100/90 px-3 py-2.5">
                <p class="text-[11px] font-bold text-amber-900 mb-1">내일의 힌트</p>
                <p class="text-sm text-slate-800 leading-normal">${esc(nudge)}</p>
            </div>`
        : '';

    return `<article class="ai-meal-report-card rounded-xl border border-slate-200/90 bg-gradient-to-br from-white via-emerald-50/25 to-slate-50/40 shadow-[0_2px_16px_-4px_rgba(15,23,42,0.07)] overflow-hidden">
        <div class="p-4 space-y-2.5">
            ${topRow}
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
    if (!text) {
        if (report.score != null && Number.isFinite(Number(report.score))) {
            return `${report.score}점`;
        }
        return '—';
    }
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat;
}
