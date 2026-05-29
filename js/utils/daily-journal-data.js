/** userSettings.dailyComments[date] — 문자열(구) 또는 확장 객체 */

function normalizeMetricRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const valueRaw = raw.value;
    if (valueRaw === '' || valueRaw == null || Number.isNaN(Number(valueRaw))) return null;
    const value = Number(valueRaw);
    if (!Number.isFinite(value) || value < 0) return null;
    let time = typeof raw.time === 'string' ? raw.time.trim() : '';
    if (time && !/^\d{2}:\d{2}$/.test(time)) time = '';
    return { value, time };
}

function normalizeMetricRecords(rawList, max = 3) {
    if (!Array.isArray(rawList)) return [];
    return rawList.map(normalizeMetricRecord).filter(Boolean).slice(0, max);
}

export function normalizeDailyJournalEntry(raw) {
    if (raw == null || raw === '') {
        return {
            comment: '',
            photos: [],
            photoAspectRatio: '1:1',
            weightEnabled: false,
            bloodSugarEnabled: false,
            weightRecords: [],
            bloodSugarRecords: []
        };
    }
    if (typeof raw === 'string') {
        return {
            comment: raw,
            photos: [],
            photoAspectRatio: '1:1',
            weightEnabled: false,
            bloodSugarEnabled: false,
            weightRecords: [],
            bloodSugarRecords: []
        };
    }
    if (typeof raw === 'object') {
        const ar = raw.photoAspectRatio;
        return {
            comment: String(raw.comment || ''),
            photos: Array.isArray(raw.photos) ? raw.photos.filter(Boolean) : [],
            photoAspectRatio: ar === '3:4' || ar === '4:3' ? ar : '1:1',
            weightEnabled: raw.weightEnabled === true,
            bloodSugarEnabled: raw.bloodSugarEnabled === true,
            weightRecords: normalizeMetricRecords(raw.weightRecords),
            bloodSugarRecords: normalizeMetricRecords(raw.bloodSugarRecords)
        };
    }
    return normalizeDailyJournalEntry(null);
}

export function getDailyJournalFromSettings(settings, dateStr) {
    if (!settings || !dateStr) return normalizeDailyJournalEntry(null);
    const raw = settings.dailyComments && settings.dailyComments[dateStr];
    return normalizeDailyJournalEntry(raw);
}

export function dailyJournalHasPhotos(entry) {
    const photos = normalizeDailyJournalEntry(entry).photos;
    return photos.some((p) => typeof p === 'string' && p.length > 0);
}

/** Storage 업로드 전 로컬(data:/blob:) 사진이 남아 있는지 */
export function dailyJournalHasPendingPhotoUpload(entry) {
    const photos = normalizeDailyJournalEntry(entry).photos;
    return photos.some(
        (p) =>
            typeof p === 'string' &&
            (p.startsWith('data:image') || p.startsWith('blob:'))
    );
}

export function dailyJournalHasContent(entry) {
    const n = normalizeDailyJournalEntry(entry);
    if (String(n.comment || '').trim()) return true;
    if (n.photos && n.photos.length > 0) return true;
    if (n.weightEnabled && n.weightRecords.length > 0) return true;
    if (n.bloodSugarEnabled && n.bloodSugarRecords.length > 0) return true;
    return false;
}

export function formatMetricRecordChain(records, { isWeight = false } = {}) {
    if (!Array.isArray(records) || records.length === 0) return '';
    return records
        .map((r) => {
            const v = Number(r.value);
            if (!Number.isFinite(v)) return '';
            if (isWeight) {
                return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(1)));
            }
            return String(Math.round(v));
        })
        .filter(Boolean)
        .join(' > ');
}

/** 슬롯 미리보기용 — comment가 없을 때 대체 한 줄 (체중·혈당은 별도 표시) */
export function dailyJournalSlotFallbackLine(entry) {
    const n = normalizeDailyJournalEntry(entry);
    const comment = String(n.comment || '').trim();
    if (comment) return comment;
    if (n.photos.length > 0) {
        return n.photos.length === 1 ? '사진 1장' : `사진 ${n.photos.length}장`;
    }
    return '';
}
