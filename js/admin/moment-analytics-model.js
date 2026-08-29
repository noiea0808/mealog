/**
 * 모먼트 분석의 계산부 — 기록 배열을 받아 항목별 입력률·추이·완성도로 바꾼다.
 *
 * 화면(moment-analytics.js)과 갈라 둔 이유는 하나다: **이 값들은 틀려도 표가 멀쩡해 보인다.**
 * 어떤 필드를 「입력됨」으로 볼지, 주 경계를 어디서 끊을지가 한 칸만 어긋나도
 * 그럴듯한 숫자가 그려진다. 그래서 여기는 Firestore도 DOM도 모르게 두고 테스트로 잡는다.
 *
 * 주차 계산을 admin/utils.js에서 가져오지 않고 다시 쓴 것도 같은 이유다 —
 * 저쪽은 firebase.js를 물고 있어 Node 테스트에서 불러올 수 없다.
 */

/** 이 일수 이하면 추이를 일별로, 넘으면 주별로 끊는다 */
export const MOMENT_ANALYTICS_DAILY_MAX_SPAN = 31;

export const trimmed = (v) => (v == null ? '' : String(v).trim());

/** 만족도·포만감: 0도 값이다(입력 안 함은 null/undefined/'') */
export function hasNumericValue(v) {
    if (v === null || v === undefined || v === '') return false;
    return Number.isFinite(Number(v));
}

export function hasPhoto(meal) {
    if (Array.isArray(meal?.photos) && meal.photos.some((p) => trimmed(p))) return true;
    return Boolean(trimmed(meal?.photoUrl));
}

/* ─────────────────────────────────────────────────────────────
 * 「무엇을」이 채워지는 경로
 *
 * 이 축만 값이 들어오는 길이 넷이다 — 사용자가 고르거나, 저장할 때 로컬 분류기가
 * 집거나, 나중에 서버 Gemini 배치가 메우거나, 아무도 못 메우거나.
 * 저장 규칙(js/modals/entry-save-record.js, functions/classifyMoments.js):
 *   - 사용자 확정만 category·snackType 에 들어간다. 자동 분류는 **절대** 이 필드를 안 건드린다.
 *   - 자동 분류는 categoryAuto + categorySource('local' | 'ai')
 *   - 제안 ✕ 거부는 값 없이 source='dismissed' — 서버 backfill도 건너뛴다(영구 미분류)
 *   - source 없고 값도 없으면 서버 배치 대기. 단 서버는 menuDetail 이 있어야 집는다.
 *
 * 그래서 「사용자 확정률」과 「최종 분류 도달률」은 다른 값이고, 시트를 바꾸면
 * 전자만 떨어지고 후자는 그대로일 수 있다. 둘을 갈라 놓지 않으면 그 구분이 안 보인다.
 * ───────────────────────────────────────────────────────────── */

/** 사용자가 확정한 형태 값 — 끼니는 category, 간식은 snackType */
export const foodUserValue = (m) => trimmed(m?.category) || trimmed(m?.snackType);
/** 분류기(로컬·서버)가 채운 값 */
export const foodAutoValue = (m) => trimmed(m?.categoryAuto);
export const foodSource = (m) => trimmed(m?.categorySource);
/** 서버 backfill 이 보는 상세 텍스트(간식도 menuDetail 하나로 저장된다 — snackDetail 은 레거시) */
export const foodDetailText = (m) => trimmed(m?.menuDetail) || trimmed(m?.snackDetail);

/**
 * 기록 하나가 「무엇을」을 어느 경로로 얻었는지 — 서로 겹치지 않는 한 칸으로 떨어진다.
 * @returns {'user'|'userEtc'|'local'|'ai'|'autoUnknown'|'dismissed'|'pending'|'noDetail'}
 */
export function foodClassifyPath(meal) {
    const user = foodUserValue(meal);
    if (user) return user === '기타' ? 'userEtc' : 'user';
    const auto = foodAutoValue(meal);
    if (auto) {
        const src = foodSource(meal);
        if (src === 'local') return 'local';
        if (src === 'ai') return 'ai';
        // 자동 분류 도입 전 기록이거나 source 가 유실된 경우
        return 'autoUnknown';
    }
    if (foodSource(meal) === 'dismissed') return 'dismissed';
    // source='ai' 인데 값이 없으면 모델이 「미분류」로 종결한 것 — 다시 집지 않는다
    if (foodSource(meal) === 'ai') return 'noDetail';
    return foodDetailText(meal) ? 'pending' : 'noDetail';
}

/** 경로 표의 행 정의 — 위에서부터 「채워짐」 쪽이 오고 아래로 갈수록 빈 칸이다 */
export const FOOD_PATH_SPECS = [
    { key: 'pathUser', label: '사용자가 직접 고름', filledPath: 'user', tone: 'good' },
    { key: 'pathUserEtc', label: '사용자가 「기타」로 고름', filledPath: 'userEtc', tone: 'weak' },
    { key: 'pathLocal', label: '로컬 분류기가 채움', filledPath: 'local', tone: 'auto' },
    { key: 'pathAi', label: '서버 AI(Gemini)가 채움', filledPath: 'ai', tone: 'auto' },
    { key: 'pathAutoUnknown', label: '자동 분류(경로 미상)', filledPath: 'autoUnknown', tone: 'auto' },
    { key: 'pathDismissed', label: '제안을 거부함(영구 미분류)', filledPath: 'dismissed', tone: 'bad' },
    { key: 'pathPending', label: '서버 분류 대기', filledPath: 'pending', tone: 'pending' },
    { key: 'pathNoDetail', label: '분류 불가(상세 텍스트 없음)', filledPath: 'noDetail', tone: 'bad' }
];


/* ─────────────────────────────────────────────────────────────
 * 선택지 축 — 「태그 관리」의 목록이 실제로 얼마나 골라지는가
 *
 * 입력률(채워졌나)만으로는 답할 수 없는 두 질문이 있다:
 *   1. 관리자가 갈라 둔 구분이 실제로 유의미했나 — 아무도 안 고르는 칩, 여전히 큰 「기타」
 *   2. 시트 개편의 자동 항목이 입력을 늘렸나 — 그 값을 사람이 골랐나 기계가 넣었나
 *
 * 둘째를 세려면 값과 **출처**를 같이 봐야 한다. 저장 경로가 남기는 자국은 둘이다:
 *   - `autoContext: ['mealType'|'place'|'withWhom']` — 맥락 예측이 자동 적용한 축
 *     (js/modals/entry-save-record.js §맥락 줄 병합)
 *   - `categorySource` — 「무엇을」의 분류 경로 (위 foodClassifyPath)
 * ───────────────────────────────────────────────────────────── */

/** 그 축이 맥락 예측으로 자동 적용됐는지 — 저장 경로가 남긴 자국만 믿는다 */
export function hasAutoContext(meal, field) {
    const list = meal?.autoContext;
    return Array.isArray(list) && list.includes(field);
}

/**
 * 목록 밖 값 아래에 예시로 보여 줄 개수. 전부 늘어놓으면 「어디서」의 자유 입력
 * (가게 이름)이 표를 통째로 삼킨다 — 알고 싶은 건 목록이 얼마나 새는가지 그 목록이 아니다.
 */
export const AXIS_OTHER_SAMPLE_LIMIT = 5;

export const CHOICE_AXIS_SPECS = [
    {
        key: 'how',
        label: '어떻게',
        tagKey: 'mealType',
        value: (m) => trimmed(m.mealType),
        auto: (m) => hasAutoContext(m, 'mealType'),
        note: 'mealType · 맥락 예측 자동 적용 있음'
    },
    {
        key: 'where',
        label: '어디서',
        tagKey: 'subTagsPlaceSnack',
        value: (m) => trimmed(m.snackPlaceMain) || trimmed(m.place) || trimmed(m.snackPlace),
        auto: (m) => hasAutoContext(m, 'place'),
        /** 끼니의 「어디서」는 자유 입력(가게 이름)이라 목록 밖 값이 정상이다 */
        freeText: true,
        note: '간식은 칩 · 끼니는 자유 입력'
    },
    {
        key: 'what',
        label: '무엇을',
        tagKey: 'category',
        /** 사용자가 고른 값이 없으면 분류기가 채운 값을 쓴다 — 분포는 「최종」 축이 맞다 */
        value: (m) => foodUserValue(m) || foodAutoValue(m),
        auto: (m) => !foodUserValue(m) && !!foodAutoValue(m),
        /** 이 축만 미입력이 세 갈래로 갈린다(거부·대기·상세없음) */
        emptyPaths: true,
        note: 'category / snackType · 자동 분류 있음'
    },
    {
        key: 'withWhom',
        label: '누구와',
        tagKey: 'withWhom',
        value: (m) => trimmed(m.withWhom),
        auto: (m) => hasAutoContext(m, 'withWhom'),
        note: 'withWhom · 맥락 예측 자동 적용 있음'
    }
];

/** 「무엇을」의 미입력을 가르는 세 경로 — 손댈 곳이 서로 다르다 */
export const FOOD_EMPTY_PATH_SPECS = [
    { key: 'dismissed', label: '제안을 거부함(영구 미분류)' },
    { key: 'pending', label: '서버 분류 대기' },
    { key: 'noDetail', label: '분류 불가(상세 텍스트 없음)' }
];

function emptyAxisBucket() {
    const values = {};
    return { total: 0, filled: 0, direct: 0, auto: 0, empty: 0, values, emptyPaths: { dismissed: 0, pending: 0, noDetail: 0 } };
}

/** 기록 하나를 축별 카운터에 반영 */
function tallyAxes(axes, meal) {
    CHOICE_AXIS_SPECS.forEach((spec) => {
        const bucket = axes[spec.key];
        bucket.total += 1;
        let v = '';
        let isAuto = false;
        try {
            v = trimmed(spec.value(meal));
            isAuto = !!spec.auto(meal);
        } catch (_) {
            v = '';
            isAuto = false;
        }
        if (!v) {
            bucket.empty += 1;
            if (spec.emptyPaths) {
                const path = foodClassifyPath(meal);
                if (path in bucket.emptyPaths) bucket.emptyPaths[path] += 1;
            }
            return;
        }
        bucket.filled += 1;
        if (isAuto) bucket.auto += 1;
        else bucket.direct += 1;
        const cell = bucket.values[v] || (bucket.values[v] = { n: 0, auto: 0, direct: 0 });
        cell.n += 1;
        if (isAuto) cell.auto += 1;
        else cell.direct += 1;
    });
}

/**
 * 누적 바에 색을 줄 수 있는 선택지 수.
 *
 * 데이터 시각화 팔레트가 인접 대비를 보장하는 슬롯이 여덟이다 — 아홉 번째 색을 만들어
 * 쓰면 색맹 조건에서 기존 색과 구별되지 않는다. 넘치는 만큼은 「그 외」로 접고, 정확한
 * 값은 바로 아래 표가 그대로 들고 있다.
 */
export const AXIS_CHART_SLOTS = 8;

/**
 * 색을 **관리자 목록의 순서**로 준다 — 건수 순이 아니라.
 *
 * 건수 순으로 주면 기간을 7일에서 30일로 바꾸는 것만으로 같은 선택지의 색이 바뀐다.
 * 색은 「그 값이 무엇인가」를 가리켜야지 「이번에 몇 등인가」를 가리키면 안 된다.
 * 덤으로, 「태그 관리」에서 칩을 위로 끌어올리면 그 칩이 색을 받는다 — 무엇을 색으로
 * 볼지가 관리자 손에 남는다.
 */
const slotOfIndex = (i) => (i < AXIS_CHART_SLOTS ? i : null);

/** 표의 행들 → 누적 바 한 줄. 분모는 축의 전체 기록 수라 바의 총 길이가 100%다. */
function buildAxisChart(rows, outside, empty, total) {
    const segments = rows
        .filter((r) => r.n > 0 && r.slot !== null)
        .map((r) => ({ label: r.label, n: r.n, rate: r.rate, slot: r.slot }));
    const foldedRows = rows.filter((r) => r.n > 0 && r.slot === null);
    const foldedN = foldedRows.reduce((acc, r) => acc + r.n, 0);
    return {
        segments,
        folded: { n: foldedN, rate: pct(foldedN, total), distinct: foldedRows.length },
        outside: { n: outside.n, rate: outside.rate },
        empty: { n: empty, rate: pct(empty, total) }
    };
}

/**
 * 축별 카운터 + 관리자 태그 목록 → 화면에 그대로 그릴 수 있는 한 장의 표.
 *
 * 순수 함수로 둔 이유는 나머지와 같다 — 「목록에 있는 값」과 「목록 밖 값」을 가르는 규칙이
 * 한 칸 어긋나도 표는 멀쩡해 보인다. 관리자 목록이 비어 있으면(문서 없음·읽기 실패)
 * 모든 값이 목록 밖으로 떨어지므로, 그 경우는 `tagListMissing` 으로 화면에 알린다.
 *
 * @param {object} result analyzeMomentRows 의 반환값
 * @param {Record<string, string[]>} tagLists `content/defaultTags` 축별 목록
 */
export function buildAxisBreakdown(result, tagLists = {}) {
    return CHOICE_AXIS_SPECS.map((spec) => {
        const bucket = result.axes?.[spec.key] || emptyAxisBucket();
        const list = Array.isArray(tagLists[spec.tagKey]) ? tagLists[spec.tagKey] : [];
        const listed = new Set(list);
        const total = bucket.total;

        const rows = list.map((tag, i) => {
            const cell = bucket.values[tag] || { n: 0, auto: 0, direct: 0 };
            // 건수가 0이어도 슬롯은 지킨다 — 기간을 바꿔 값이 생겨도 색이 그대로다
            return { label: tag, ...cell, rate: pct(cell.n, total), inList: true, slot: slotOfIndex(i) };
        });

        // 목록 밖 값 — 옛 어휘(한식·양식…)나 자유 입력이 여기 모인다
        const outside = Object.entries(bucket.values)
            .filter(([v]) => !listed.has(v))
            .map(([v, c]) => ({ label: v, ...c }))
            .sort((a, b) => b.n - a.n);
        const outsideTotal = outside.reduce((acc, r) => acc + r.n, 0);

        return {
            key: spec.key,
            label: spec.label,
            note: spec.note,
            freeText: !!spec.freeText,
            tagListMissing: list.length === 0,
            total,
            filled: bucket.filled,
            direct: bucket.direct,
            auto: bucket.auto,
            empty: bucket.empty,
            filledRate: pct(bucket.filled, total),
            autoShare: pct(bucket.auto, bucket.filled),
            rows,
            outside: {
                n: outsideTotal,
                rate: pct(outsideTotal, total),
                distinct: outside.length,
                samples: outside.slice(0, AXIS_OTHER_SAMPLE_LIMIT)
            },
            chart: buildAxisChart(
                rows,
                { n: outsideTotal, rate: pct(outsideTotal, total) },
                bucket.empty,
                total
            ),
            emptyPaths: spec.emptyPaths
                ? FOOD_EMPTY_PATH_SPECS.map((p) => ({
                      label: p.label,
                      n: bucket.emptyPaths[p.key],
                      rate: pct(bucket.emptyPaths[p.key], total)
                  }))
                : null
        };
    });
}

/**
 * 입력률을 셀 항목들.
 *
 * `core: true` 인 8개가 사용자가 화면에서 채우는 축이고, 완성도 분모도 이 8개다.
 * 상세 항목은 선택 입력이라 표에만 싣고 완성도에서는 뺀다.
 * `aux: true` 인 자동분류는 사람이 채운 것이 아니라 참고 행이다.
 */
export const MOMENT_FIELD_SPECS = [
    { key: 'how', label: '어떻게', core: true, note: 'mealType', filled: (m) => !!trimmed(m.mealType) },
    {
        key: 'where',
        label: '어디서',
        core: true,
        note: 'place / snackPlaceMain',
        filled: (m) => !!(trimmed(m.snackPlaceMain) || trimmed(m.place) || trimmed(m.snackPlace))
    },
    {
        key: 'whereDetail',
        label: '└ 어디서 상세',
        note: '선택 입력',
        filled: (m) => !!(trimmed(m.placeDetail) || trimmed(m.placeMemo))
    },
    {
        key: 'what',
        label: '무엇을',
        core: true,
        note: 'category / snackType (사용자 확정)',
        filled: (m) => !!(trimmed(m.category) || trimmed(m.snackType))
    },
    {
        key: 'whatFinal',
        label: '└ 무엇을(최종 분류 도달)',
        aux: true,
        note: '사용자 확정 + 로컬·서버 자동 분류',
        filled: (m) => !!(foodUserValue(m) || foodAutoValue(m))
    },
    {
        key: 'whatDetail',
        label: '└ 무엇을 상세',
        note: '선택 입력',
        filled: (m) => !!(trimmed(m.menuDetail) || trimmed(m.snackDetail))
    },
    { key: 'withWhom', label: '누구와', core: true, note: 'withWhom', filled: (m) => !!trimmed(m.withWhom) },
    {
        key: 'withDetail',
        label: '└ 누구와 상세',
        note: '선택 입력',
        filled: (m) => !!trimmed(m.withWhomDetail)
    },
    {
        key: 'rating',
        label: '만족도',
        core: true,
        gated: true,
        note: '설정에서 끌 수 있음',
        filled: (m) => hasNumericValue(m.snackRating ?? m.rating)
    },
    {
        key: 'satiety',
        label: '포만감',
        core: true,
        gated: true,
        note: '설정에서 끌 수 있음',
        filled: (m) => hasNumericValue(m.satiety)
    },
    { key: 'photo', label: '사진', core: true, note: 'photos / photoUrl', filled: hasPhoto },
    { key: 'comment', label: '코멘트', core: true, note: 'comment', filled: (m) => !!trimmed(m.comment) }
];

export const CORE_FIELD_SPECS = MOMENT_FIELD_SPECS.filter((f) => f.core);

/**
 * 실제로 세는 것 전부 — 항목별 표(MOMENT_FIELD_SPECS)에 경로 행을 얹은 목록.
 * 경로는 서로 배타적이라 `filledPath` 로 한 칸만 참이 된다.
 */
export const COUNT_SPECS = [
    ...MOMENT_FIELD_SPECS,
    ...FOOD_PATH_SPECS.map((p) => ({
        ...p,
        path: true,
        filled: (m) => foodClassifyPath(m) === p.filledPath
    }))
];

/** YYYY-MM-DD → 로컬 Date (파싱 실패 시 null) */
function ymdToLocalDate(ymd) {
    const parts = String(ymd || '').split('-');
    if (parts.length !== 3) return null;
    const [y, m, d] = parts.map((n) => parseInt(n, 10));
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    const dt = new Date(y, m - 1, d);
    return Number.isNaN(dt.getTime()) ? null : dt;
}

function localDateToYmd(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shiftYmd(ymd, deltaDays) {
    const dt = ymdToLocalDate(ymd);
    if (!dt) return ymd;
    dt.setDate(dt.getDate() + deltaDays);
    return localDateToYmd(dt);
}

/** 시작일·종료일을 모두 포함한 일수 */
export function daysBetweenYmd(startYmd, endYmd) {
    const a = ymdToLocalDate(startYmd);
    const b = ymdToLocalDate(endYmd);
    if (!a || !b) return 0;
    return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
}

/** 그 날짜가 속한 주의 일요일 키 */
export function sundayKeyOfYmd(ymd) {
    const d = ymdToLocalDate(ymd);
    if (!d) return null;
    d.setDate(d.getDate() - d.getDay());
    return localDateToYmd(d);
}

/** "2주\n3/2~3/8" — 대시보드 주간 컬럼과 같은 형식(th에 whitespace-pre-line) */
export function weekLabelOfSundayKey(sundayYmd) {
    const sun = ymdToLocalDate(sundayYmd);
    if (!sun) return String(sundayYmd || '');
    const y = sun.getFullYear();
    const m = sun.getMonth();
    let n = 0;
    for (let day = 1; day <= sun.getDate(); day++) {
        if (new Date(y, m, day).getDay() === 0) n++;
    }
    const sat = new Date(y, m, sun.getDate() + 6);
    return `${n}주\n${sun.getMonth() + 1}/${sun.getDate()}~${sat.getMonth() + 1}/${sat.getDate()}`;
}

/** 구간 하나의 빈 카운터 */
function emptyBucket(label, key) {
    const counts = { autoContext: 0 };
    COUNT_SPECS.forEach((f) => {
        counts[f.key] = 0;
    });
    return { key, label, total: 0, counts };
}

/**
 * 기록 배열 → 전체·구간별 입력 카운트
 * @param {Array<object>} rows 이미 걸러진 끼니·간식 기록(하루기록·제외 UID 제거된 상태)
 */
export function analyzeMomentRows(rows, startYmd, endYmd) {
    const spanDays = daysBetweenYmd(startYmd, endYmd);
    const byWeek = spanDays > MOMENT_ANALYTICS_DAILY_MAX_SPAN;

    const overall = emptyBucket('전체', 'overall');
    const buckets = new Map();
    /** 선택지 축 카운터 — 값별 분포와 자동/직접 출처를 같이 센다 */
    const axes = {};
    CHOICE_AXIS_SPECS.forEach((spec) => {
        axes[spec.key] = emptyAxisBucket();
    });
    /** 축 하나라도 맥락 예측이 자동 적용된 기록 — 추이에서 개편 효과를 따라간다 */
    let autoContextRows = 0;
    const userIds = new Set();
    /** 핵심 8항목 중 몇 개를 채웠나 → 0~8 히스토그램 */
    const completeness = new Array(CORE_FIELD_SPECS.length + 1).fill(0);

    (Array.isArray(rows) ? rows : []).forEach((meal) => {
        if (!meal) return;
        userIds.add(meal.userId);
        overall.total += 1;

        const dateKey = trimmed(meal.date);
        let bKey = dateKey;
        let bLabel = dateKey;
        if (byWeek) {
            bKey = sundayKeyOfYmd(dateKey) || dateKey;
            bLabel = weekLabelOfSundayKey(bKey);
        }
        if (!buckets.has(bKey)) buckets.set(bKey, emptyBucket(bLabel, bKey));
        const bucket = buckets.get(bKey);
        bucket.total += 1;

        tallyAxes(axes, meal);
        if (Array.isArray(meal.autoContext) && meal.autoContext.length > 0) {
            autoContextRows += 1;
            bucket.counts.autoContext += 1;
            overall.counts.autoContext += 1;
        }

        let coreFilled = 0;
        COUNT_SPECS.forEach((spec) => {
            let ok = false;
            try {
                ok = !!spec.filled(meal);
            } catch (_) {
                ok = false;
            }
            if (!ok) return;
            overall.counts[spec.key] += 1;
            bucket.counts[spec.key] += 1;
            if (spec.core) coreFilled += 1;
        });
        completeness[coreFilled] += 1;
    });

    const trend = [...buckets.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));

    const coreFilledSum = CORE_FIELD_SPECS.reduce((acc, f) => acc + overall.counts[f.key], 0);
    const avgCompleteness = overall.total ? coreFilledSum / (overall.total * CORE_FIELD_SPECS.length) : 0;

    return {
        startYmd,
        endYmd,
        spanDays,
        byWeek,
        overall,
        trend,
        completeness,
        userCount: userIds.size,
        avgCompleteness,
        axes,
        autoContextRows
    };
}

export const pct = (n, d) => (d > 0 ? (n / d) * 100 : 0);
