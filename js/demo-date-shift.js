/**
 * 데모 계정 전용: Firestore의 실제 날짜는 그대로 두고, 화면에만
 * "가장 최근 기록일 → 오늘(로컬)"이 되도록 같은 일수만큼 시프트.
 */

function parseYmd(s) {
    if (!s || typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return dt;
}

export function todayLocalYmd() {
    const d = new Date();
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${day}`;
}

export function addDaysToYmd(ymd, deltaDays) {
    const base = parseYmd(ymd);
    if (base == null || !Number.isFinite(deltaDays)) return null;
    base.setDate(base.getDate() + deltaDays);
    const y = base.getFullYear();
    const mo = String(base.getMonth() + 1).padStart(2, '0');
    const day = String(base.getDate()).padStart(2, '0');
    return `${y}-${mo}-${day}`;
}

/** meal 배열(또는 {date} 목록)에서 최대 date 기준, 오늘까지의 일수 차이 */
export function computeDemoDateShiftDays(meals) {
    let maxStr = null;
    const list = Array.isArray(meals) ? meals : [];
    for (const m of list) {
        const d = m && m.date;
        if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
            if (!maxStr || d > maxStr) maxStr = d;
        }
    }
    if (!maxStr) return 0;
    const today = todayLocalYmd();
    const a = parseYmd(today);
    const b = parseYmd(maxStr);
    if (!a || !b) return 0;
    return Math.round((a.getTime() - b.getTime()) / 86400000);
}

/** daily / dailyComments 등 YYYY-MM-DD 키 객체의 최대 키 기준 시프트 일수 */
export function computeDemoDateShiftDaysFromKeyedObject(obj) {
    if (!obj || typeof obj !== 'object') return 0;
    const keys = Object.keys(obj).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));
    if (!keys.length) return 0;
    const maxStr = keys.reduce((a, b) => (a > b ? a : b));
    const today = todayLocalYmd();
    const a = parseYmd(today);
    const b = parseYmd(maxStr);
    if (!a || !b) return 0;
    return Math.round((a.getTime() - b.getTime()) / 86400000);
}

export function applyDemoDateShiftToMealRecord(meal, days) {
    if (!meal || !days) return meal;
    const nd = addDaysToYmd(meal.date, days);
    if (!nd || nd === meal.date) return meal;
    return { ...meal, date: nd };
}

export function applyDemoDateShiftToMeals(meals, days) {
    if (!Array.isArray(meals) || !days) return meals;
    return meals.map((m) => applyDemoDateShiftToMealRecord(m, days));
}

export function applyDemoDateShiftToDailyStats(daily, days) {
    if (!daily || typeof daily !== 'object' || !days) return daily;
    const out = {};
    for (const [k, v] of Object.entries(daily)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(k)) {
            const nk = addDaysToYmd(k, days);
            if (nk) out[nk] = v;
        } else {
            out[k] = v;
        }
    }
    return out;
}

export function applyDemoDateShiftToDailyComments(dc, days) {
    if (!dc || typeof dc !== 'object' || !days) return dc;
    const out = {};
    for (const [k, v] of Object.entries(dc)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(k)) {
            const nk = addDaysToYmd(k, days);
            out[nk || k] = v;
        } else {
            out[k] = v;
        }
    }
    return out;
}

export function applyDemoDateShiftToSharedPhoto(photo, days) {
    if (!photo || !days) return photo;
    const d = photo.date;
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return photo;
    const nd = addDaysToYmd(d, days);
    if (!nd || nd === d) return photo;
    return { ...photo, date: nd };
}

export function applyDemoDateShiftToSharedPhotos(photos, days) {
    if (!Array.isArray(photos) || !days) return photos;
    return photos.map((p) => applyDemoDateShiftToSharedPhoto(p, days));
}
