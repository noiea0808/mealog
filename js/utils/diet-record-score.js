/**
 * 리포트 점수 — 그날 기록을 얼마나 남겼는지 + 먹은 것의 구성이 고른지.
 *
 * 설계 원칙: 화면에 띄우는 점수는 근거를 그대로 펼쳐 보일 수 있어야 한다.
 * 예전 점수는 AI가 매겼고 근거의 상당 부분이 영양 판단이었는데, 그 영양 판단을 본문에
 * 쓰는 것은 [금지 주제]로 막혀 있어서 설명할 수 없는 숫자였다. 지금은 네 항목 모두
 * 내역으로 펼쳐지고, 균형 항목도 balanceNote 라는 사실 서술을 달고 나온다.
 *
 * 기록 세 항목은 결정론적이다 — 같은 기록이면 언제 계산해도 같은 값이 나온다.
 * 균형 한 항목만 AI 판단이며, 없으면 그 칸을 빼고 나머지로 100점 환산한다.
 *
 * 입력은 리포트 문서에 저장된 분석 시점 스냅샷(inputMeals · inputDailyJournalComment)이라
 * 과거 리포트도 저장된 값 없이 그 자리에서 계산된다.
 */

/** 본식 — 앱의 기존 집계 기준(functions/mealStats.js MEAL_SLOTS)과 같아야 한다 */
const MAIN_SLOT_IDS = ['morning', 'lunch', 'dinner'];
const MAIN_SLOT_LABELS = { morning: '아침', lunch: '점심', dinner: '저녁' };

const BALANCE_MAX = 40;
const MAIN_MAX = 25;
const DEPTH_MAX = 25;
const JOURNAL_MAX = 10;

/**
 * 끼니당 채울 수 있는 칸 — 사진 / 만족도·포만감 / 코멘트 / 장소 / 함께
 * 장소·함께는 inputMeals 에 개별 필드가 없고 detailText 안에 "장소: ", "함께: " 줄로만
 * 들어온다(functions/index.js adminMealSlotDetailForGemini). 과거 리포트도 같은 형식으로
 * 저장되어 있어 여기서 파싱하면 새 기록과 옛 기록을 같은 기준으로 볼 수 있다.
 */
const DEPTH_FIELDS_PER_MEAL = 5;

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

/** detailText 안의 "장소: ..." / "함께: ..." 줄 존재 여부 */
function hasDetailLine(meal, label) {
    const detail = String(meal?.detailText || '');
    return new RegExp(`(^|\\n)\\s*${label}:\\s*\\S`).test(detail);
}

/**
 * 리포트 문서 → 점수와 그 내역.
 * 입력 스냅샷이 없는 구버전 문서는 계산할 근거가 없으므로 null 을 반환한다.
 * (0점으로 표시하면 기록을 안 한 날처럼 보인다 — 모르는 것과 없는 것은 다르다)
 *
 * @param {object} reportDoc Firestore aiDietReports 문서 데이터
 * @param {object} [parsedReport] 파싱된 AI 응답 — balance / balanceNote 를 여기서 읽는다
 * @returns {{total:number, sections:Array<{key:string,label:string,got:number,max:number,detail:string}>}|null}
 */
export function computeDietRecordScore(reportDoc, parsedReport = null) {
    if (!reportDoc || typeof reportDoc !== 'object') return null;
    if (!Array.isArray(reportDoc.inputMeals)) return null;

    const meals = reportDoc.inputMeals.filter((m) => m && typeof m === 'object');
    const sections = [];

    // 1. 균형 — 유일한 AI 판단. 없는 리포트(구버전)는 칸 자체를 만들지 않는다.
    const rawBalance = parsedReport?.balance;
    if (isFilledNumber(rawBalance)) {
        const pct = Math.max(0, Math.min(100, Math.round(Number(rawBalance))));
        const note = String(parsedReport?.balanceNote ?? '').trim();
        sections.push({
            key: 'balance',
            label: '구성 균형',
            got: Math.round((pct / 100) * BALANCE_MAX),
            max: BALANCE_MAX,
            detail: note || '구성을 보고 매긴 점수예요'
        });
    }

    // 2. 본식 기록 — 아침·점심·저녁. 건너뜀도 "남긴 기록"으로 인정한다.
    const recordedMainLabels = [];
    const missingMainLabels = [];
    for (const slotId of MAIN_SLOT_IDS) {
        const label = MAIN_SLOT_LABELS[slotId];
        if (meals.some((m) => String(m.slotId || '') === slotId)) recordedMainLabels.push(label);
        else missingMainLabels.push(label);
    }
    sections.push({
        key: 'main',
        label: '본식 기록',
        got: Math.round((MAIN_MAX / MAIN_SLOT_IDS.length) * recordedMainLabels.length),
        max: MAIN_MAX,
        detail:
            missingMainLabels.length === 0
                ? '세 끼 모두 기록하셨어요'
                : recordedMainLabels.length === 0
                  ? '본식 기록이 없어요'
                  : `${recordedMainLabels.join('·')} 남김 · ${missingMainLabels.join('·')} 없음`
    });

    // 3. 기록 깊이 — 기록한 끼니(간식 포함)마다 다섯 칸을 얼마나 채웠나.
    //    건너뜀 끼니는 채울 것이 없으므로 분모에서 뺀다.
    const depthMeals = meals.filter((m) => !isSkippedMeal(m));
    let photoFilled = 0;
    let ratingFilled = 0;
    let commentFilled = 0;
    let placeFilled = 0;
    let withWhomFilled = 0;
    for (const m of depthMeals) {
        if (isFilledNumber(m.photoCount) && Number(m.photoCount) > 0) photoFilled += 1;
        if (isFilledNumber(m.rating) || isFilledNumber(m.satiety)) ratingFilled += 1;
        if (hasText(m.comment)) commentFilled += 1;
        if (hasDetailLine(m, '장소')) placeFilled += 1;
        if (hasDetailLine(m, '함께')) withWhomFilled += 1;
    }
    const depthDenominator = depthMeals.length * DEPTH_FIELDS_PER_MEAL;
    const depthFilled = photoFilled + ratingFilled + commentFilled + placeFilled + withWhomFilled;
    sections.push({
        key: 'depth',
        label: '기록 깊이',
        got: depthDenominator > 0 ? Math.round((depthFilled / depthDenominator) * DEPTH_MAX) : 0,
        max: DEPTH_MAX,
        detail: depthMeals.length
            ? `${depthMeals.length}끼 · 사진 ${photoFilled} · 만족도 ${ratingFilled} · 코멘트 ${commentFilled} · 장소 ${placeFilled} · 함께 ${withWhomFilled}`
            : '채울 기록이 없어요'
    });

    // 4. 하루소감
    const hasJournal = hasText(reportDoc.inputDailyJournalComment);
    sections.push({
        key: 'journal',
        label: '하루소감',
        got: hasJournal ? JOURNAL_MAX : 0,
        max: JOURNAL_MAX,
        detail: hasJournal ? '남기셨어요' : '아직 없어요'
    });

    // 균형 칸이 없는 구버전 리포트도 같은 눈금으로 보이도록 100점 환산한다.
    const earned = sections.reduce((sum, s) => sum + s.got, 0);
    const possible = sections.reduce((sum, s) => sum + s.max, 0);
    const total = possible > 0 ? Math.round((earned / possible) * 100) : 0;
    return { total: Math.max(0, Math.min(100, total)), sections };
}

export const DIET_RECORD_SCORE_MAXES = { BALANCE_MAX, MAIN_MAX, DEPTH_MAX, JOURNAL_MAX };
