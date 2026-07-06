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

function normalizeDailyJournalRecordedAt(raw) {
    if (raw == null) return '';
    if (typeof raw === 'string') {
        const s = raw.trim();
        if (!s) return '';
        const t = Date.parse(s);
        return Number.isFinite(t) ? new Date(t).toISOString() : '';
    }
    if (typeof raw.toDate === 'function') {
        const d = raw.toDate();
        return d && Number.isFinite(d.getTime()) ? d.toISOString() : '';
    }
    if (typeof raw.seconds === 'number') {
        return new Date(raw.seconds * 1000 + (raw.nanoseconds || 0) / 1e6).toISOString();
    }
    return '';
}

export function normalizeDailyJournalEntry(raw) {
    const empty = {
        comment: '',
        photos: [],
        sharedPhotos: [],
        photoAspectRatio: '1:1',
        weightEnabled: false,
        bloodSugarEnabled: false,
        weightRecords: [],
        bloodSugarRecords: [],
        recordedAt: ''
    };
    if (raw == null || raw === '') {
        return { ...empty };
    }
    if (typeof raw === 'string') {
        return { ...empty, comment: raw };
    }
    if (typeof raw === 'object') {
        const ar = raw.photoAspectRatio;
        return {
            comment: String(raw.comment || ''),
            photos: Array.isArray(raw.photos) ? raw.photos.filter(Boolean) : [],
            sharedPhotos: Array.isArray(raw.sharedPhotos) ? raw.sharedPhotos.filter(Boolean) : [],
            photoAspectRatio: ar === '3:4' || ar === '4:3' ? ar : '1:1',
            weightEnabled: raw.weightEnabled === true,
            bloodSugarEnabled: raw.bloodSugarEnabled === true,
            weightRecords: normalizeMetricRecords(raw.weightRecords),
            bloodSugarRecords: normalizeMetricRecords(raw.bloodSugarRecords),
            recordedAt: normalizeDailyJournalRecordedAt(raw.recordedAt)
        };
    }
    return normalizeDailyJournalEntry(null);
}

/** 관리자·정렬용 — 저장 시각 우선, 없으면 슬롯 날짜 정오 */
export function dailyJournalRecordedAtMillis(entry, dateStr) {
    const n = normalizeDailyJournalEntry(entry);
    if (n.recordedAt) {
        const t = Date.parse(n.recordedAt);
        if (Number.isFinite(t)) return t;
    }
    const dk = String(dateStr || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(dk)) {
        const t = Date.parse(`${dk}T12:00:00`);
        if (Number.isFinite(t)) return t;
    }
    return 0;
}

/** 모먼트·피드 휠 슬롯 칩 표기 (띄어쓰기 없음) */
export const DAILY_JOURNAL_MOMENT_SLOT_LABEL = '하루기록';

/** 하루 기록 사진 모먼트 공유 여부 (slotId 또는 entryId) */
export function isDailyJournalSharePhoto(photo, entryId) {
    if (photo && photo.slotId === 'daily_journal') return true;
    const eid =
        entryId != null && entryId !== '' && entryId !== 'null'
            ? String(entryId)
            : photo?.entryId != null && photo.entryId !== '' && photo.entryId !== 'null'
              ? String(photo.entryId)
              : '';
    return eid.startsWith('dailyJournal_');
}

/** 모먼트 sharedPhotos 문서·타임라인 공유 표시용 entryId */
export function getDailyJournalShareEntryId(dateStr) {
    const dk = String(dateStr || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(dk) ? `dailyJournal_${dk}` : '';
}

export function isDailyJournalShared(dateStr, entry) {
    const entryId = getDailyJournalShareEntryId(dateStr);
    if (entryId && window.sharedPhotos && Array.isArray(window.sharedPhotos)) {
        if (window.sharedPhotos.some((p) => p.entryId === entryId)) return true;
    }
    const n = normalizeDailyJournalEntry(entry);
    if (n.sharedPhotos && n.sharedPhotos.length > 0) return true;
    return false;
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

/** users/{uid}/meals 문서 ID — 식사·간식과 동일 컬렉션에 미러 */
export function getDailyJournalMealDocId(dateStr) {
    return getDailyJournalShareEntryId(dateStr);
}

export function isDailyJournalMealRecord(record) {
    if (!record || typeof record !== 'object') return false;
    if (record.slotId === 'daily_journal') return true;
    const id = String(record.id || '');
    if (!id.startsWith('dailyJournal_')) return false;
    const dk = id.slice('dailyJournal_'.length);
    return /^\d{4}-\d{2}-\d{2}$/.test(dk);
}

/** recordedAt → meals.time (HH:mm) */
export function recordedAtIsoToMealTime(recordedAt) {
    const iso = normalizeDailyJournalRecordedAt(recordedAt);
    if (!iso) return '23:59';
    try {
        const d = new Date(iso);
        if (!Number.isFinite(d.getTime())) return '23:59';
        const h = String(d.getHours()).padStart(2, '0');
        const m = String(d.getMinutes()).padStart(2, '0');
        return `${h}:${m}`;
    } catch (_) {
        return '23:59';
    }
}

/**
 * dailyComments 항목 → users/…/meals 문서 (식사·간식과 동일 필드: date, time, slotId, recordedAt, photos …)
 */
export function dailyJournalEntryToMealDocument(dateStr, entry) {
    const dk = String(dateStr || '').trim();
    const n = normalizeDailyJournalEntry(entry);
    const mealId = getDailyJournalMealDocId(dk);
    const recordedAt = n.recordedAt || '';
    return {
        id: mealId,
        date: dk,
        time: recordedAtIsoToMealTime(recordedAt),
        slotId: 'daily_journal',
        comment: n.comment,
        photos: n.photos,
        sharedPhotos: n.sharedPhotos,
        photoAspectRatio: n.photoAspectRatio,
        weightEnabled: n.weightEnabled,
        bloodSugarEnabled: n.bloodSugarEnabled,
        weightRecords: n.weightRecords,
        bloodSugarRecords: n.bloodSugarRecords,
        recordedAt: recordedAt || undefined
    };
}

/** meals 문서 → 관리자 모니터링 행 보강 필드 */
export function dailyJournalMealDocToModerationFields(row) {
    const dateStr =
        String(row?.date || '').trim() ||
        (String(row?.id || '').startsWith('dailyJournal_')
            ? String(row.id).slice('dailyJournal_'.length)
            : '');
    const entry = normalizeDailyJournalEntry(row);
    return {
        date: dateStr,
        slotId: 'daily_journal',
        isDailyJournal: true,
        isDailyJournalSlot: true,
        dailyJournalEntry: entry,
        comment: entry.comment,
        photos: entry.photos,
        sharedPhotos: entry.sharedPhotos
    };
}
