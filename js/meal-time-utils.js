/**
 * 기록 시간(mealClock: "HH:mm") 표시 태그·EXIF 보조
 */

/** 24시 "HH:mm" → 카드 태그용 "pm 02:30" (소문자 am/pm, 시 두 자리) */
export function formatMealClockTagLabel(hhmm24) {
    const m = String(hhmm24 || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return '';
    const h = parseInt(m[1], 10);
    const min = m[2];
    if (!Number.isFinite(h) || h < 0 || h > 23) return '';
    const ap = h < 12 ? 'am' : 'pm';
    const h12 = h % 12 || 12;
    return `${ap} ${String(h12).padStart(2, '0')}:${min}`;
}

/** 타임라인 태그 본문(맨 앞 # 에 붙는 문자열). mealClock 없으면 빈 문자열 */
export function mealClockTagLabelFromRecord(record) {
    if (!record || record.mealClock == null || record.mealClock === '') return '';
    return formatMealClockTagLabel(record.mealClock) || '';
}

/** 수정 모달: 저장값 → input[type=time] 용 "HH:mm" */
export function normalizeMealClockInputValue(raw) {
    if (raw == null) return '';
    const s = String(raw).trim();
    const m = s.match(/^(\d{1,2}):(\d{2})/);
    if (!m) return '';
    const hh = String(Math.min(23, Math.max(0, parseInt(m[1], 10)))).padStart(2, '0');
    const mm = String(Math.min(59, Math.max(0, parseInt(m[2], 10)))).padStart(2, '0');
    return `${hh}:${mm}`;
}

/**
 * 기록 모달 HH:mm 텍스트 입력 타이핑: 숫자만 반영·최대 4자리(HHMM)까지
 * @param {string} raw
 */
export function formatMealClockTextWhileTyping(raw) {
    const d = String(raw || '').replace(/\D/g, '').slice(0, 4);
    if (d.length <= 2) return d;
    return `${d.slice(0, 2)}:${d.slice(2)}`;
}

/** 12시 형식 타입 패턴 보정 ":" 삽입 (시·분 각 2자리) */
export function formatMealClock12TextWhileTyping(raw) {
    const d = String(raw || '').replace(/\D/g, '').slice(0, 4);
    if (!d.length) return '';
    if (d.length <= 2) return d;
    return `${d.slice(0, 2)}:${d.slice(2)}`;
}

/**
 * 표시용 12시 "h:mm" 또는 "hh:mm" → 검증 후 "hh:mm"(시 01–12·분 00–59). 빈 문자열이면 실패.
 */
export function normalizeMealClock12InputValue(raw) {
    const s = String(raw || '').trim();
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return '';
    let h12 = parseInt(m[1], 10);
    let mm = parseInt(m[2], 10);
    if (!Number.isFinite(h12) || h12 < 1 || h12 > 12) return '';
    mm = Number.isFinite(mm) ? Math.min(59, Math.max(0, mm)) : 0;
    return `${String(h12).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * 오전(am)|오후(pm) + 12시표시 → 저장용 "HH:mm" (24시)
 * @param {'am'|'pm'} ampm
 * @param {string} displayRaw  예: "2:05", "09:30"
 */
export function mealClock24FromAmPmClock(ampm, displayRaw) {
    const normalized = normalizeMealClock12InputValue(displayRaw);
    if (!normalized) return '';
    const [, hPart, miPart] = normalized.match(/^(\d{2}):(\d{2})$/) || [];
    if (!hPart || !miPart) return '';
    const h12 = parseInt(hPart, 10);
    const mi = miPart;
    let H24;
    if (ampm === 'am') {
        H24 = h12 === 12 ? 0 : h12;
    } else {
        H24 = h12 === 12 ? 12 : h12 + 12;
    }
    return `${String(H24).padStart(2, '0')}:${mi}`;
}

/**
 * 저장값 "HH:mm"(24시) → UI용 오전/오후 값 · 12시계 표시
 * @returns {{ ampm: 'am'|'pm', display: string }}
 */
export function mealClock24ToAmPmAndDisplay(hhmm24) {
    const base = normalizeMealClockInputValue(hhmm24);
    const m = String(base || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return { ampm: 'pm', display: '' };
    const H = parseInt(m[1], 10);
    const mi = m[2];
    if (!Number.isFinite(H)) return { ampm: 'pm', display: '' };
    const ampm = H < 12 ? 'am' : 'pm';
    const h12mod = H % 12;
    const h12 = h12mod === 0 ? 12 : h12mod;
    return {
        ampm,
        display: `${String(h12).padStart(2, '0')}:${mi}`
    };
}

/**
 * 사진 파일 EXIF에서 촬영 시각 → "HH:mm" (로컬). 없으면 null.
 */
export async function tryExifTimeHHmmFromImageFile(file) {
    if (!file || typeof file.type !== 'string' || !file.type.startsWith('image/')) return null;
    try {
        const mod = await import('https://esm.sh/exifr@7.1.3');
        const exifr = mod.default || mod;
        const out = await exifr.parse(file, { pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate'] });
        let dt =
            out?.DateTimeOriginal ||
            out?.CreateDate ||
            out?.ModifyDate ||
            null;
        let d = null;
        if (dt instanceof Date && !Number.isNaN(dt.getTime())) {
            d = dt;
        } else if (dt) {
            const x = new Date(dt);
            d = Number.isNaN(x.getTime()) ? null : x;
        }
        if (!d) return null;
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
    } catch (_) {
        return null;
    }
}
