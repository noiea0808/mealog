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

/** js/utils/food-classifier.js AUTO_CATEGORIES 와 동기화 */
const AUTO_CATEGORIES = [
    '밥/한상',
    '단백질식',
    '면',
    '빵/샌드위치',
    '샐러드',
    '과일',
    '커피/음료',
    '간식/디저트',
];

/** 모델이 분류 불가로 판단할 때 쓰는 값 — 저장 시 categoryAuto:'' + source:'ai'로 종결 */
const UNCLASSIFIED = '미분류';

const GEMINI_TIMEOUT_MS = 30 * 1000;
const MAIN_SLOT_IDS = new Set(['morning', 'lunch', 'dinner']);

/**
 * backfill 대상 판정.
 * - 끼니(main) 기록 + 상세 텍스트 있음
 * - category 비었거나 레거시 '기타'(과거 조용한 폴백의 산물)
 * - categoryAuto 없음, categorySource 미기록(null/undefined)
 *   ('user'·'local'·'dismissed'·'ai'는 각자의 종결 상태다)
 */
function needsClassification(d) {
    if (!d || !MAIN_SLOT_IDS.has(String(d.slotId || ''))) return false;
    const menu = String(d.menuDetail || '').trim();
    if (!menu) return false;
    const category = String(d.category || '').trim();
    if (category && category !== '기타') return false;
    if (String(d.categoryAuto || '').trim()) return false;
    if (d.categorySource != null) return false;
    return true;
}

/**
 * Gemini 1회 호출로 텍스트 목록을 일괄 분류.
 * responseSchema enum 강제 — 자유 생성이 없어 파싱 실패가 구조적으로 차단된다.
 * @param {string[]} texts
 * @param {{ apiKey: string, model: string, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<string[]>} texts와 같은 길이의 카테고리 배열
 */
async function classifyBatchWithGemini(texts, { apiKey, model, fetchImpl = fetch }) {
    const numbered = texts.map((t, i) => `${i + 1}. ${t.replace(/\n/g, ' ').slice(0, 200)}`).join('\n');
    const prompt = [
        '아래는 식사 기록 앱 사용자들이 적은 "무엇을 먹었는지" 텍스트 목록이다.',
        `각 항목을 다음 카테고리 중 정확히 하나로 분류하라: ${AUTO_CATEGORIES.join(', ')}.`,
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
                        items: { type: 'STRING', enum: [...AUTO_CATEGORIES, UNCLASSIFIED] },
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
    return parsed.map((c) => (AUTO_CATEGORIES.includes(c) ? c : UNCLASSIFIED));
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

    const targets = [];
    snap.forEach((docSnap) => {
        if (targets.length >= maxDocs) return;
        const d = docSnap.data();
        if (needsClassification(d)) {
            targets.push({ ref: docSnap.ref, text: String(d.menuDetail || '').trim() });
        }
    });

    const result = { scanned: snap.size, targeted: targets.length, classified: 0, unclassified: 0 };
    if (targets.length === 0) {
        logger.info('classifyUncategorizedMeals: 대상 없음', result);
        return result;
    }

    const categories = await classifyBatchWithGemini(targets.map((t) => t.text), { apiKey, model });

    const batch = db.batch();
    targets.forEach(({ ref }, i) => {
        const category = categories[i];
        const classified = category !== UNCLASSIFIED;
        // 미분류 판정도 source:'ai'로 종결한다 — 같은 문서를 매 배치 재시도하는 루프 방지.
        // category(사용자 필드)·updatedAt은 절대 쓰지 않는다.
        batch.update(ref, {
            categoryAuto: classified ? category : '',
            categorySource: 'ai',
        });
        if (classified) result.classified += 1;
        else result.unclassified += 1;
    });
    await batch.commit();

    logger.info('classifyUncategorizedMeals: 완료', result);
    return result;
}

module.exports = {
    AUTO_CATEGORIES,
    UNCLASSIFIED,
    needsClassification,
    classifyBatchWithGemini,
    runClassifyUncategorizedMeals,
};
