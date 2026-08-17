/**
 * 기록 충실도 점수 — 그날 "무엇을 먹었나"가 아니라 "얼마나 남겼나"를 매긴다.
 *
 * 왜 채점 대상을 식단에서 기록으로 옮겼나.
 * 식단을 채점하면 근거의 상당 부분이 영양 판단이 된다. 그런데 그 영양 판단은 리포트 본문에
 * 쓰는 것이 프롬프트 [금지 주제]로 금지되어 있다. 결과적으로 근거를 밝힐 수 없는 숫자가
 * 화면에서 가장 크게 붙어 있었다. 대상을 기록으로 옮기면 근거를 그대로 펼쳐 보일 수 있고,
 * 무엇을 먹었는지 바꾸지 않아도 사용자가 올릴 수 있는 숫자가 된다.
 *
 * AI가 매기지 않는다. 같은 기록이면 언제 계산해도 같은 점수가 나와야 한다.
 * 입력은 리포트 문서에 이미 저장된 분석 시점 스냅샷(inputMeals · inputDailyJournalComment)이라
 * 과거 리포트도 저장된 값 없이 그 자리에서 계산된다.
 */

/** 본식 — 앱의 기존 집계 기준(functions/mealStats.js MEAL_SLOTS)과 같아야 한다 */
const MAIN_SLOT_IDS = ['morning', 'lunch', 'dinner'];
const MAIN_SLOT_LABELS = { morning: '아침', lunch: '점심', dinner: '저녁' };

const MAIN_MAX = 60;
const DEPTH_MAX = 30;
const JOURNAL_MAX = 10;

/** 끼니당 채울 수 있는 칸 — 사진 / 만족도·포만감 / 코멘트 */
const DEPTH_FIELDS_PER_MEAL = 3;

/** "건너뜀"으로 남긴 끼니. 기록으로는 인정하되 사진·만족도를 요구하지 않는다 */
function isSkippedMeal(meal) {
    const detail = String(meal?.detailText || '').trim();
    return detail === '건너뜀';
}

function hasText(value) {
    return String(value ?? '').trim().length > 0;
}

/**
 * 값이 실제로 채워진 숫자인가.
 * Number(null) 이 0 이고 Number.isFinite(0) 이 true 라, 빈 값을 그냥 넘기면
 * 만족도를 안 매긴 끼니가 "채운 끼니"로 세어진다.
 */
function isFilledNumber(value) {
    if (value == null || value === '') return false;
    return Number.isFinite(Number(value));
}

/**
 * 리포트 문서 → 기록 충실도 점수와 그 내역.
 * 입력 스냅샷이 없는 구버전 문서는 계산할 근거가 없으므로 null 을 반환한다.
 * (0점으로 표시하면 기록을 안 한 날처럼 보인다 — 모르는 것과 없는 것은 다르다)
 *
 * @param {object} reportDoc Firestore aiDietReports 문서 데이터
 * @returns {{total:number, sections:Array<{key:string,label:string,got:number,max:number,detail:string}>}|null}
 */
export function computeDietRecordScore(reportDoc) {
    if (!reportDoc || typeof reportDoc !== 'object') return null;
    if (!Array.isArray(reportDoc.inputMeals)) return null;

    const meals = reportDoc.inputMeals.filter((m) => m && typeof m === 'object');

    // 1. 본식 기록 — 아침·점심·저녁 각 20점. 건너뜀도 "남긴 기록"으로 인정한다.
    const recordedMainLabels = [];
    const missingMainLabels = [];
    for (const slotId of MAIN_SLOT_IDS) {
        const label = MAIN_SLOT_LABELS[slotId];
        if (meals.some((m) => String(m.slotId || '') === slotId)) recordedMainLabels.push(label);
        else missingMainLabels.push(label);
    }
    const mainGot = Math.round((MAIN_MAX / MAIN_SLOT_IDS.length) * recordedMainLabels.length);
    const mainDetail =
        missingMainLabels.length === 0
            ? '세 끼 모두 기록하셨어요'
            : recordedMainLabels.length === 0
              ? '본식 기록이 없어요'
              : `${recordedMainLabels.join('·')} 남김 · ${missingMainLabels.join('·')} 없음`;

    // 2. 기록 깊이 — 기록한 끼니(간식 포함)마다 사진·만족도·코멘트를 얼마나 채웠나.
    //    건너뜀 끼니는 채울 것이 없으므로 분모에서 뺀다.
    const depthMeals = meals.filter((m) => !isSkippedMeal(m));
    let photoFilled = 0;
    let ratingFilled = 0;
    let commentFilled = 0;
    for (const m of depthMeals) {
        if (isFilledNumber(m.photoCount) && Number(m.photoCount) > 0) photoFilled += 1;
        if (isFilledNumber(m.rating) || isFilledNumber(m.satiety)) ratingFilled += 1;
        if (hasText(m.comment)) commentFilled += 1;
    }
    const depthDenominator = depthMeals.length * DEPTH_FIELDS_PER_MEAL;
    const depthFilled = photoFilled + ratingFilled + commentFilled;
    const depthGot = depthDenominator > 0 ? Math.round((depthFilled / depthDenominator) * DEPTH_MAX) : 0;
    const depthDetail = depthMeals.length
        ? `${depthMeals.length}끼 중 사진 ${photoFilled} · 만족도 ${ratingFilled} · 코멘트 ${commentFilled}`
        : '채울 기록이 없어요';

    // 3. 하루소감
    const hasJournal = hasText(reportDoc.inputDailyJournalComment);
    const journalGot = hasJournal ? JOURNAL_MAX : 0;

    const sections = [
        { key: 'main', label: '본식 기록', got: mainGot, max: MAIN_MAX, detail: mainDetail },
        { key: 'depth', label: '기록 깊이', got: depthGot, max: DEPTH_MAX, detail: depthDetail },
        {
            key: 'journal',
            label: '하루소감',
            got: journalGot,
            max: JOURNAL_MAX,
            detail: hasJournal ? '남기셨어요' : '아직 없어요'
        }
    ];

    const total = sections.reduce((sum, s) => sum + s.got, 0);
    return { total: Math.max(0, Math.min(100, total)), sections };
}

export const DIET_RECORD_SCORE_MAXES = { MAIN_MAX, DEPTH_MAX, JOURNAL_MAX };
