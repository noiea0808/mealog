/**
 * 미분류 식사 기록 서버 backfill — Gemini 배치 분류
 * (docs/food-category-auto-classification.md §6)
 *
 * 클라이언트 로컬 분류기(js/utils/food-classifier.js)가 못 잡은 기록의
 * categoryAuto를 채운다. 전 과정이 best-effort다:
 * - 사용자 확정 필드(category)는 절대 건드리지 않는다. categoryAuto/'ai'만 기록.
 * - updatedAt도 건드리지 않는다 — 아웃박스 충돌 판정 필드라 서버가 올리면
 *   클라이언트의 정당한 수정 푸시가 막힌다 (docs/sync-outbox-design.md §4.5).
 * - Gemini 호출은 AbortController 30초 상한 (신뢰성 대전제: 통제 못하는 대기는
 *   영원히 안 끝난다고 가정한다).
 * - 실패한 건은 그대로 둔다 — 다음 배치가 다시 집는다. 재시도 장치 없음.
 */

/**
 * js/utils/food-dictionary.js FORM_CATEGORIES 와 동기화 (형태 축).
 * ⚠️ 이 배열을 바꾸면 클라이언트 사전도 함께 바꿔야 한다 — 두 곳이 갈리면
 * 서버가 채운 categoryAuto 가 차트 화이트리스트 밖 값이 되어 '미입력'으로 접힌다.
 *
 * 요리 종류(cuisineAuto)는 아직 서버 backfill 대상이 아니다 — 클라이언트가 저장할 때만
 * 채운다. 과거 기록의 요리 종류가 필요해지면 별도 배치를 추가한다.
 */
const AUTO_CATEGORIES = [
    '밥류',
    '국물요리',
    '면류',
    '빵류',
    '고기·생선',
    '채소·샐러드',
    '튀김·분식',
    '커피',
    '차/음료',
    '술/주류',
    '베이커리/떡',
    '과자/스낵',
    '아이스크림',
    '과일/견과',
];

/** 모델이 분류 불가로 판단할 때 쓰는 값 — 저장 시 categoryAuto:'' + source:'ai'로 종결 */
const UNCLASSIFIED = '미분류';

const GEMINI_TIMEOUT_MS = 30 * 1000;
const MAIN_SLOT_IDS = new Set(['morning', 'lunch', 'dinner']);
const SNACK_SLOT_IDS = new Set(['pre_morning', 'snack1', 'snack2', 'night']);

/**
 * 간식 축 — js/utils/food-classifier.js SNACK_KEYWORDS 의 키와 동기화.
 * 끼니와 달리 기존 snackType 태그를 그대로 쓴다.
 */
const SNACK_CATEGORIES = ['커피', '차/음료', '술/주류', '베이커리', '과자/스낵', '아이스크림', '과일/견과'];

/**
 * backfill 대상 판정 — 끼니는 category, 간식은 snackType 축.
 * - 상세 텍스트 있음
 * - 해당 축의 사용자 값이 비었거나 레거시 '기타'(과거 조용한 폴백의 산물)
 * - categoryAuto 없음, categorySource 미기록(null/undefined)
 *   ('user'·'local'·'dismissed'·'ai'는 각자의 종결 상태다)
 * @returns {'meal'|'snack'|null} 대상이면 축 종류, 아니면 null
 */
function classificationKind(d) {
    if (!d) return null;
    const slotId = String(d.slotId || '');
    const isMeal = MAIN_SLOT_IDS.has(slotId);
    const isSnack = SNACK_SLOT_IDS.has(slotId);
    if (!isMeal && !isSnack) return null;
    if (!String(d.menuDetail || '').trim()) return null;
    const userValue = String((isMeal ? d.category : d.snackType) || '').trim();
    if (userValue && userValue !== '기타') return null;
    if (String(d.categoryAuto || '').trim()) return null;
    if (d.categorySource != null) return null;
    return isMeal ? 'meal' : 'snack';
}

/** @deprecated classificationKind를 쓰세요 — 하위 호환용 */
function needsClassification(d) {
    return classificationKind(d) === 'meal';
}

/**
 * Gemini 1회 호출로 텍스트 목록을 일괄 분류.
 * responseSchema enum 강제 — 자유 생성이 없어 파싱 실패가 구조적으로 차단된다.
 * @param {string[]} texts
 * @param {{ apiKey: string, model: string, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<string[]>} texts와 같은 길이의 카테고리 배열
 */
async function classifyBatchWithGemini(texts, { apiKey, model, fetchImpl = fetch, kind = 'meal' }) {
    const categories = kind === 'snack' ? SNACK_CATEGORIES : AUTO_CATEGORIES;
    const numbered = texts.map((t, i) => `${i + 1}. ${t.replace(/\n/g, ' ').slice(0, 200)}`).join('\n');
    const prompt = [
        kind === 'snack'
            ? '아래는 식사 기록 앱 사용자들이 적은 "간식으로 무엇을 먹었는지" 텍스트 목록이다.'
            : '아래는 식사 기록 앱 사용자들이 적은 "무엇을 먹었는지" 텍스트 목록이다.',
        `각 항목을 다음 카테고리 중 정확히 하나로 분류하라: ${categories.join(', ')}.`,
        `음식이 아니거나 판단이 어려우면 "${UNCLASSIFIED}".`,
        '입력과 같은 개수·같은 순서의 JSON 배열로만 답하라.',
        '',
        numbered,
    ].join('\n');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
    let res;
    let data;
    try {
        res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Referer: 'https://mealog-r0.web.app/' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0,
                    maxOutputTokens: 4096,
                    responseMimeType: 'application/json',
                    responseSchema: {
                        type: 'ARRAY',
                        items: { type: 'STRING', enum: [...categories, UNCLASSIFIED] },
                    },
                    thinkingConfig: { thinkingBudget: 0 },
                },
            }),
            signal: controller.signal,
        });
        data = await res.json().catch(() => ({}));
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok) {
        throw new Error(`Gemini ${res.status}: ${data?.error?.message || 'unknown'}`);
    }
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length !== texts.length) {
        throw new Error(`응답 길이 불일치: 입력 ${texts.length} vs 응답 ${Array.isArray(parsed) ? parsed.length : 'not-array'}`);
    }
    return parsed.map((c) => (categories.includes(c) ? c : UNCLASSIFIED));
}

/**
 * 기간 내 미분류 기록을 모아 분류하고 categoryAuto를 기록한다.
 * @param {object} args
 * @param {FirebaseFirestore.Firestore} args.db
 * @param {{ info: Function, warn: Function, error: Function }} args.logger
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {string} args.startDate YYYY-MM-DD (포함)
 * @param {string} args.endDate YYYY-MM-DD (포함)
 * @param {number} [args.maxDocs]
 * @returns {Promise<{ scanned: number, targeted: number, classified: number, unclassified: number }>}
 */
async function runClassifyUncategorizedMeals({ db, logger, apiKey, model, startDate, endDate, maxDocs = 100 }) {
    const snap = await db
        .collectionGroup('meals')
        .where('date', '>=', startDate)
        .where('date', '<=', endDate)
        .get();

    // 끼니·간식은 분류 축이 달라 각각 별도 호출로 나눈다
    const byKind = { meal: [], snack: [] };
    snap.forEach((docSnap) => {
        const d = docSnap.data();
        const kind = classificationKind(d);
        if (!kind) return;
        if (byKind.meal.length + byKind.snack.length >= maxDocs) return;
        byKind[kind].push({ ref: docSnap.ref, text: String(d.menuDetail || '').trim() });
    });

    const targeted = byKind.meal.length + byKind.snack.length;
    const result = { scanned: snap.size, targeted, classified: 0, unclassified: 0 };
    if (targeted === 0) {
        logger.info('classifyUncategorizedMeals: 대상 없음', result);
        return result;
    }

    const batch = db.batch();
    for (const kind of ['meal', 'snack']) {
        const targets = byKind[kind];
        if (targets.length === 0) continue;
        const categories = await classifyBatchWithGemini(targets.map((t) => t.text), {
            apiKey,
            model,
            kind,
        });
        targets.forEach(({ ref }, i) => {
            const category = categories[i];
            const classified = category !== UNCLASSIFIED;
            // 미분류 판정도 source:'ai'로 종결한다 — 같은 문서를 매 배치 재시도하는 루프 방지.
            // category·snackType(사용자 필드)·updatedAt은 절대 쓰지 않는다.
            batch.update(ref, {
                categoryAuto: classified ? category : '',
                categorySource: 'ai',
            });
            if (classified) result.classified += 1;
            else result.unclassified += 1;
        });
    }
    await batch.commit();

    logger.info('classifyUncategorizedMeals: 완료', {
        ...result,
        mealTargets: byKind.meal.length,
        snackTargets: byKind.snack.length,
    });
    return result;
}

module.exports = {
    AUTO_CATEGORIES,
    SNACK_CATEGORIES,
    UNCLASSIFIED,
    classificationKind,
    needsClassification,
    classifyBatchWithGemini,
    runClassifyUncategorizedMeals,
};
