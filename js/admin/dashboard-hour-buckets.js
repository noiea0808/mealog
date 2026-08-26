/**
 * 트렌드 표 시간대 행 — 「사용자가 언제 앱을 켜서 적었나」를 3시간 단위로 본다.
 *
 * 끼니·간식 행과 열별 합계가 **다를 수 있다.** 저쪽은 식사 날짜로 칸을 잡지만
 * 이쪽은 기록한 날짜로 잡기 때문이다 — 어제 끼니를 오늘 밤에 적으면 저쪽은 어제 칸,
 * 이쪽은 오늘 칸 21–24시로 간다. 축을 맞춰 놓으면 시각의 뜻이 섞여서,
 * "며칟날 몇 시에 앱을 켰나"를 볼 수 없다.
 *
 * 그래서 기준은 recordedAt(ISO)이다. 날짜와 시각을 한 값에서 같이 뽑아야
 * 둘이 어긋나지 않는다. recordedAt이 없는 옛 문서만 식사 날짜 + meals.time으로
 * 근사한다.
 *
 * 'unknown'을 따로 두는 이유: 시각이 없는 기록을 23:59 같은 값으로 폴백시키면
 * 밤 구간이 조용히 부풀어 오른다. 모르는 것은 모른다고 표시한다.
 */

export const HOUR_BUCKET_SIZE = 3;

export const HOUR_BUCKETS = [
    { id: 'h00', label: '00–03시' },
    { id: 'h03', label: '03–06시' },
    { id: 'h06', label: '06–09시' },
    { id: 'h09', label: '09–12시' },
    { id: 'h12', label: '12–15시' },
    { id: 'h15', label: '15–18시' },
    { id: 'h18', label: '18–21시' },
    { id: 'h21', label: '21–24시' },
    { id: 'unknown', label: '시간 미상' }
];

/** 0~23 → 버킷 id. 범위를 벗어나면 null */
export function hourBucketIdFromHour(hour) {
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    return HOUR_BUCKETS[Math.floor(hour / HOUR_BUCKET_SIZE)].id;
}

/** meals.time("HH:mm:ss" 로컬) → 버킷 id. 없거나 형식이 깨졌으면 'unknown' */
export function hourBucketIdFromMealTime(time) {
    if (typeof time !== 'string') return 'unknown';
    const m = /^(\d{1,2}):\d{1,2}/.exec(time.trim());
    if (!m) return 'unknown';
    return hourBucketIdFromHour(parseInt(m[1], 10)) || 'unknown';
}


/** Date → 로컬 'YYYY-MM-DD' (admin/utils.js dateKeyFromLocalDate 와 같은 규칙) */
function localDateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ISO → { dateKey, bucketId } (로컬). 못 읽으면 null */
function slotFromIso(iso) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return null;
    return { dateKey: localDateKey(d), bucketId: hourBucketIdFromHour(d.getHours()) || 'unknown' };
}

function normalizedDateKey(raw) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    return DATE_KEY_RE.test(s) ? s : '';
}

/**
 * meals 문서 → 시간대 행이 쓸 { dateKey, bucketId }. 날짜조차 못 정하면 null.
 *
 * recordedAt이 정본이다. 없는 옛 문서는 식사 날짜를 기록일로 근사하되,
 * 하루 소감 미러의 time에는 "23:59" 폴백이 박혀 있어(daily-journal-data.js)
 * 그대로 쓰면 밤 구간이 부풀기 때문에 시각만 미상으로 둔다.
 */
export function hourSlotForMealDoc(meal) {
    if (!meal || typeof meal !== 'object') return null;
    const iso = typeof meal.recordedAt === 'string' ? meal.recordedAt.trim() : '';
    if (iso) {
        const slot = slotFromIso(iso);
        if (slot) return slot;
    }
    const dateKey = normalizedDateKey(meal.date);
    if (!dateKey) return null;
    return {
        dateKey,
        bucketId: meal.slotId === 'daily_journal' ? 'unknown' : hourBucketIdFromMealTime(meal.time)
    };
}

/**
 * dailyComments 항목 → { dateKey, bucketId }. 날짜조차 못 정하면 null.
 * recordedAt이 없으면 소감이 걸린 날짜만 알 뿐 시각은 모른다.
 */
export function hourSlotForJournalEntry(dateStr, entry) {
    const iso = typeof entry?.recordedAt === 'string' ? entry.recordedAt.trim() : '';
    if (iso) {
        const slot = slotFromIso(iso);
        if (slot) return slot;
    }
    const dateKey = normalizedDateKey(dateStr);
    return dateKey ? { dateKey, bucketId: 'unknown' } : null;
}
