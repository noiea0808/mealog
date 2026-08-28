/**
 * 관리자 모니터링: 모먼트(타임라인) 공유·신고·일괄 처리
 *
 * sharedPhotos 를 훑던 세 경로(하루기록 고아 · 특수 공유 목록 · 특수 공유 건수)는
 * 로컬 미러에서 읽는다 — 새로고침마다 최대 2천 건을 사 오던 자리다. 개별 문서
 * 조작(숨김·삭제·신고 처리)은 그대로 Firestore 를 쓰고, 쓴 값만 미러에 되비친다.
 * 미러가 실패하면 각 경로가 예전 서버 조회로 물러난다. — docs/admin-local-mirror.md
 */
import { db, appId, functions, refreshAppCheckTokenBeforeFirestore } from '../firebase.js';
import { sharedPhotosMirror } from './collection-mirror.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js';
import { getReportsAggregateByGroupKeys } from '../db.js';
import { REPORT_REASONS } from '../constants.js';
import { escapeHtml, fetchAdminEmailsForUserIds, runAdminRefreshAction } from './utils.js';
import { refreshLucideIcons } from '../icons.js';
import { fetchAllUsersForAdminAnalytics } from './users.js';
import {
    normalizeDailyJournalEntry,
    dailyJournalHasContent,
    dailyJournalRecordedAtMillis,
    formatMetricRecordChain,
    getDailyJournalShareEntryId,
    getDailyJournalMealDocId,
    dailyJournalMealDocToModerationFields,
    isDailyJournalMealRecord
} from '../utils/daily-journal-data.js';
import {
    collection,
    collectionGroup,
    getDocs,
    query,
    orderBy,
    limit,
    startAfter,
    doc,
    getDoc,
    getCountFromServer,
    where,
    writeBatch,
    deleteDoc,
    Timestamp
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

// 피드 관리 렌더링
let feedFilters = {
    shared: 'all', // 'all', 'yes', 'no'
    hasPhotos: 'all', // 'all', 'yes', 'no'
    banned: 'all' // 'all', 'yes', 'no'
};
/** 작성자 닉네임 클릭 시 해당 userId 기록만 표시 */
let feedAuthorFilter = null; // { userId: string, nickname: string } | null
/** 닉네임·이메일·UID 검색용 (최초 검색 시 1회 로드) */
let feedAuthorSearchUsersCache = null;
let feedAuthorSearchHandlersBound = false;
let feedCurrentPage = 1;
const feedPageSize = 20;
let feedLastDocsByPage = {};
let feedTotalCount = 0;
/** false면 getCountFromServer 실패 등 — 목록은 있으나 전체 건수·번호 역산 불가 */
let feedMealTotalCountKnown = true;
/** 마지막 페이지 쿼리가 pageSize만큼 찼는지(다음 페이지 존재 추정) */
let feedLastPageHasMore = false;
/** 현재 페이지에 실제로 표시되는 행 수(필터 전 원본 페이지 기준은 getFeedPage에서 docs.length) */
let feedLastPageRowCount = 0;

/** 모먼트 목록 TTL·캐시 — 특수 공유 fetch에도 동일 간격 사용 */
const ADMIN_FEED_CACHE_TTL_MS = 3 * 60 * 1000;

/** 기록 시각(recordedAt) 우선, 없으면 timestamp, 없으면 슬롯 date+time 근사 */
function mealRecordedAtMillis(meal) {
    if (!meal) return 0;
    const raw = meal.recordedAt ?? meal.timestamp;
    if (raw != null) {
        if (raw && typeof raw.toDate === 'function') {
            const d = raw.toDate();
            return Number.isFinite(d.getTime()) ? d.getTime() : 0;
        }
        if (typeof raw === 'string' || raw instanceof Date) {
            const d = new Date(raw);
            return Number.isFinite(d.getTime()) ? d.getTime() : 0;
        }
        if (raw && typeof raw.seconds === 'number') {
            return raw.seconds * 1000 + (raw.nanoseconds || 0) / 1e6;
        }
    }
    if (meal.date) {
        const dateStr = meal.date;
        let timeStr = meal.time || '00:00';
        try {
            if (timeStr && String(timeStr).split(':').length === 2) timeStr = `${timeStr}:00`;
            const d = new Date(`${dateStr}T${timeStr}`);
            if (Number.isFinite(d.getTime())) return d.getTime();
        } catch (_) {}
        try {
            return new Date(dateStr).getTime();
        } catch (_) {}
    }
    return 0;
}

/**
 * 모니터링 목록 정렬·기록 일시 컬럼 공통 (최신순만, 유형·작성자 무관)
 * recordedAt → timestamp → date+time
 */
function moderationRecordedAtMillis(row) {
    if (!row) return 0;
    if (row.isDailyJournal || row.slotId === 'daily_journal' || isDailyJournalMealRecord(row)) {
        if (typeof row.momentShareAtMillis === 'number' && row.momentShareAtMillis > 0) {
            return row.momentShareAtMillis;
        }
        const ms = dailyJournalRecordedAtMillis(row.dailyJournalEntry || row, row.date);
        if (ms > 0) return ms;
        const dk = String(row.date || '').trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(dk)) {
            const endOfDay = Date.parse(`${dk}T23:59:59`);
            if (Number.isFinite(endOfDay)) return endOfDay;
        }
    }
    const ms = mealRecordedAtMillis(row);
    if (ms > 0) return ms;
    if (row.isDailyShare && row.date) {
        const raw = String(row.date).trim();
        if (raw) {
            const t = Date.parse(raw.includes('T') ? raw : `${raw}T23:59:59`);
            if (Number.isFinite(t)) return t;
        }
    }
    return 0;
}

/** 모먼트 목록을 한 번이라도 성공적으로 불러온 뒤에만 필터·페이지 이동이 Firestore를 다시 칩니다 */
let adminFeedMonitoringLoaded = false;
// 공유 키 캐시 — ensureSharedKeysForFeedRows에서 채움; 무효화 시 null
let feedSharedKeysCache = null;

/** sharedPhotos 중 하루기록(daily)·주간 Best(best)·참견(insight) — 모니터링 목록 병합용 */
const ADMIN_FEED_SPECIAL_SHARE_TYPES = ['daily', 'best', 'insight'];
const ADMIN_FEED_SPECIAL_ROWS_CAP = 500;

/**
 * 하루기록 공유(sharedPhotos, slotId='daily_journal') 조회 상한.
 *
 * 하루기록의 정본은 meals 미러라 목록은 일반 기록 스트림을 탄다. 이 상한이 걸리는 곳은
 * 미러 없는 「고아 공유」를 줍는 경로뿐이고, 평소에는 페이지가 필요한 만큼(skip+pageSize)만
 * 받는다. 이 값은 정렬 인덱스가 없어 순서 없이 받아야 할 때의 안전망이다.
 */
const ADMIN_DAILY_JOURNAL_ROWS_CAP = 800;

let moderationSpecialSharesCache = { ts: 0, rows: null, scopeKey: '', limitUsed: 0 };
let moderationDailyJournalCache = { ts: 0, rows: null, scopeKey: '', limitUsed: 0 };

/** 모니터링 캐시 키 — 전체(__all__) vs 작성자 UID */
function moderationCacheScopeKey(authorUid) {
    const uid = String(authorUid || '').trim();
    return uid || '__all__';
}

function formatKoDateLabelFromYmd(dateStr) {
    const raw = String(dateStr || '').trim();
    if (!raw) return '';
    try {
        const d = new Date(raw.includes('T') ? raw : `${raw}T12:00:00`);
        if (Number.isNaN(d.getTime())) return raw;
        return d
            .toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })
            .replace(/\s+/g, '');
    } catch (_) {
        return raw;
    }
}

function firestoreTimestampToMillis(raw) {
    if (raw == null) return 0;
    if (typeof raw.toDate === 'function') {
        const d = raw.toDate();
        return Number.isFinite(d.getTime()) ? d.getTime() : 0;
    }
    if (typeof raw.seconds === 'number') {
        return raw.seconds * 1000 + (raw.nanoseconds || 0) / 1e6;
    }
    if (typeof raw === 'string' || raw instanceof Date) {
        const t = Date.parse(raw);
        return Number.isFinite(t) ? t : 0;
    }
    return 0;
}

function dailyJournalModerationRowKey(userId, dateStr) {
    return `${String(userId || '')}|${String(dateStr || '').trim()}`;
}


/**
 * sharedPhotos — slotId daily_journal 또는 entryId dailyJournal_YYYY-MM-DD (meals 컬렉션에 없음)
 * @param {string} [authorUid] — 지정 시 해당 사용자 sharedPhotos만 조회
 */
/**
 * @param {string} [authorUid] 작성자 필터
 * @param {number} [rowLimit] 이 페이지가 필요한 최대 행 수
 */
async function fetchDailyJournalMomentSharesFromSharedPhotos(authorUid = '', rowLimit = ADMIN_DAILY_JOURNAL_ROWS_CAP) {
    const scopedUid = String(authorUid || '').trim();

    /**
     * 미러가 있으면 여기서 끝난다 — Firestore 읽기 0회.
     * 아래 서버 경로는 (slotId, timestamp) 인덱스 유무에 따라 두 갈래로 갈리는데,
     * 미러는 전량을 들고 있어 두 조건을 한 번에 합집합으로 본다.
     */
    try {
        await sharedPhotosMirror.ensureSynced();
        return await sharedPhotosMirror.getFilteredDocsLike((d) => {
            if (scopedUid && d?.userId !== scopedUid) return false;
            return d?.slotId === 'daily_journal' || String(d?.entryId || '').startsWith('dailyJournal_');
        }, rowLimit);
    } catch (eMirror) {
        console.warn('[관리자 모먼트] 하루기록 미러 실패 — 서버 조회로 대체:', eMirror);
    }

    const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
    await refreshAppCheckTokenBeforeFirestore();
    const byDocId = new Map();
    const userFilter = scopedUid ? [where('userId', '==', scopedUid)] : [];

    const addDocs = (docs) => {
        for (const d of docs || []) {
            if (d?.id && !byDocId.has(d.id)) byDocId.set(d.id, d);
        }
    };

    try {
        /**
         * 최신순으로 받아야 상한을 줄일 수 있다 — 정렬 없이 자르면 「아무 N건」이라
         * 페이지에 뭐가 뜰지 알 수 없다. (slotId, timestamp) 인덱스가 없으면 아래로 내려간다.
         */
        let snap;
        try {
            snap = await getDocs(
                query(
                    sharedColl,
                    ...userFilter,
                    where('slotId', '==', 'daily_journal'),
                    orderBy('timestamp', 'desc'),
                    limit(rowLimit)
                )
            );
        } catch (eOrder) {
            if (eOrder?.code !== 'failed-precondition') throw eOrder;
            console.warn(
                '[관리자 모먼트] 하루기록 공유 정렬 인덱스 없음 — 순서 없이 상한까지 받습니다.',
                '배포: firebase deploy --only firestore:indexes'
            );
            snap = await getDocs(
                query(
                    sharedColl,
                    ...userFilter,
                    where('slotId', '==', 'daily_journal'),
                    limit(ADMIN_DAILY_JOURNAL_ROWS_CAP)
                )
            );
        }
        addDocs(snap.docs);
    } catch (e1) {
        console.warn(
            '[관리자 모먼트] 하루기록 sharedPhotos(slotId) 조회 실패 → entryId 범위 조회',
            e1?.code || e1?.message || e1
        );
        try {
            const snap = await getDocs(
                query(
                    sharedColl,
                    ...userFilter,
                    where('entryId', '>=', 'dailyJournal_'),
                    where('entryId', '<=', 'dailyJournal_\uf8ff'),
                    limit(ADMIN_DAILY_JOURNAL_ROWS_CAP)
                )
            );
            addDocs(snap.docs);
        } catch (e2) {
            console.warn(
                '[관리자 모먼트] 하루기록 sharedPhotos(entryId) 조회 실패',
                e2?.code || e2?.message || e2
            );
        }
    }

    const groups = new Map();
    for (const docSnap of byDocId.values()) {
        const d = docSnap.data() || {};
        const ty = d.type;
        if (ty === 'daily' || ty === 'best' || ty === 'insight') continue;
        const uid = String(d.userId || '').trim();
        const eid = String(d.entryId || '').trim();
        const slotId = String(d.slotId || '').trim();
        if (!uid) continue;
        if (slotId !== 'daily_journal' && !eid.startsWith('dailyJournal_')) continue;
        let dateStr = '';
        if (eid.startsWith('dailyJournal_')) {
            dateStr = eid.slice('dailyJournal_'.length);
        } else if (d.date && /^\d{4}-\d{2}-\d{2}$/.test(String(d.date))) {
            dateStr = String(d.date);
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

        const key = dailyJournalModerationRowKey(uid, dateStr);
        const tsMs = firestoreTimestampToMillis(d.timestamp);
        const url = String(d.photoUrl || '').trim();
        let g = groups.get(key);
        if (!g) {
            g = {
                userId: uid,
                date: dateStr,
                photoUrls: [],
                photoIndexByUrl: new Map(),
                momentShareAtMillis: 0,
                comment: String(d.comment || '').trim()
            };
            groups.set(key, g);
        }
        if (tsMs > g.momentShareAtMillis) g.momentShareAtMillis = tsMs;
        if (!g.comment && d.comment) g.comment = String(d.comment).trim();
        if (url) {
            const idx = typeof d.photoIndex === 'number' ? d.photoIndex : g.photoUrls.length;
            if (!g.photoIndexByUrl.has(url)) {
                g.photoIndexByUrl.set(url, idx);
                g.photoUrls.push({ url, idx });
            }
        }
    }

    const rows = [];
    for (const g of groups.values()) {
        g.photoUrls.sort((a, b) => a.idx - b.idx);
        const photos = g.photoUrls.map((p) => p.url);
        const entry = normalizeDailyJournalEntry({
            comment: g.comment,
            photos,
            sharedPhotos: photos,
            recordedAt: g.momentShareAtMillis
                ? new Date(g.momentShareAtMillis).toISOString()
                : ''
        });
        if (!dailyJournalHasContent(entry) && photos.length === 0) continue;
        rows.push({
            id: `dailyJournal_${g.userId}_${g.date}`,
            userId: g.userId,
            date: g.date,
            recordedAt: entry.recordedAt || undefined,
            momentShareAtMillis: g.momentShareAtMillis,
            momentShared: true,
            isDailyJournal: true,
            isDailyJournalSlot: false,
            comment: entry.comment,
            photos: entry.photos,
            dailyJournalEntry: entry,
            slotDisplayDate: formatKoDateLabelFromYmd(g.date),
            slotDisplayLabel: '하루소감'
        });
    }
    if (rows.length > 0) {
        console.log(`[관리자 모먼트] 하루기록 슬롯·모먼트 사진공유 ${rows.length}건(sharedPhotos, slotId≠일간)`);
    }
    return rows;
}




/**
 * config collectionGroup — users/{uid} 루트 문서 없이 settings 만 있는 계정도 포함
 */



/**
 * meals 미러(dailyJournal_*)가 있으면 pinned 하루기록 행을 제외한다.
 * — settings 슬롯뿐 아니라 모먼트 전용(sharedPhotos) 행도 함께 제외
 * — 목록에는 meals 행만 남기고 ensureSharedKeys가 momentShared를 붙여 「슬롯+모먼트」 한 줄로 표시
 */
async function filterDailyJournalRowsWithoutMealMirror(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const pinnedDj = rows.filter((r) => r?.isDailyJournal && r.userId && r.date);
    const others = rows.filter((r) => !(r?.isDailyJournal && r.userId && r.date));
    if (!pinnedDj.length) return rows;
    const keep = [];
    const BATCH = 24;
    for (let i = 0; i < pinnedDj.length; i += BATCH) {
        const chunk = pinnedDj.slice(i, i + BATCH);
        await Promise.all(
            chunk.map(async (r) => {
                const mealId = getDailyJournalMealDocId(r.date);
                if (!mealId) {
                    keep.push(r);
                    return;
                }
                /**
                 * 이 행 자체가 그 미러 문서다 — meals 미러 조회(fetchDailyJournalSlotsFromMealMirrors)
                 * 에서 나왔으니 존재는 이미 증명됐다. 같은 문서를 한 건씩 다시 읽지 않는다.
                 * (id 까지 맞춰 보는 이유: slotId 만 daily_journal 이고 문서 id 가 다른 옛 문서가
                 *  섞이면 아래 getDoc 이 가리키는 것은 **다른** 문서라, 그때는 확인이 필요하다)
                 */
                if (r.isDailyJournalSlot === true && String(r.id || '') === mealId) return;
                try {
                    const snap = await getDoc(
                        doc(db, 'artifacts', appId, 'users', r.userId, 'meals', mealId)
                    );
                    if (!snap.exists()) keep.push(r);
                } catch (_) {
                    keep.push(r);
                }
            })
        );
    }
    return [...keep, ...others];
}

/**
 * 같은 사용자·날짜의 하루기록 행이 페이지에 둘 이상이면 하나로 합친다
 * (슬롯 meals + 모먼트 pinned 가 동시에 들어온 경우 → 슬롯+모먼트)
 */
function collapseDailyJournalDuplicateRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return rows;
    const keyToIndex = new Map();
    const out = [];
    for (const r of rows) {
        if (!r?.isDailyJournal || !r.userId || !r.date) {
            out.push(r);
            continue;
        }
        const key = dailyJournalModerationRowKey(r.userId, r.date);
        if (!keyToIndex.has(key)) {
            keyToIndex.set(key, out.length);
            out.push(r);
            continue;
        }
        const keep = out[keyToIndex.get(key)];
        const preferMealDoc =
            String(r.id || '').startsWith('dailyJournal_') &&
            !String(r.id).includes(String(r.userId));
        if (preferMealDoc) {
            const merged = {
                ...keep,
                ...r,
                momentShared: !!(keep.momentShared || r.momentShared),
                isDailyJournalSlot: true,
                isDailyJournal: true
            };
            if ((keep.photos?.length || 0) > (merged.photos?.length || 0)) {
                merged.photos = keep.photos;
            }
            if ((keep.momentShareAtMillis || 0) > (merged.momentShareAtMillis || 0)) {
                merged.momentShareAtMillis = keep.momentShareAtMillis;
            }
            if (keep.dailyJournalEntry && !merged.dailyJournalEntry) {
                merged.dailyJournalEntry = keep.dailyJournalEntry;
            }
            out[keyToIndex.get(key)] = merged;
        } else {
            keep.momentShared = !!(keep.momentShared || r.momentShared);
            keep.isDailyJournalSlot =
                keep.isDailyJournalSlot === true || r.isDailyJournalSlot === true;
            keep.isDailyJournal = true;
            if ((r.photos?.length || 0) > (keep.photos?.length || 0)) {
                keep.photos = r.photos;
            }
            if ((r.momentShareAtMillis || 0) > (keep.momentShareAtMillis || 0)) {
                keep.momentShareAtMillis = r.momentShareAtMillis;
            }
            if (r.dailyJournalEntry && !keep.dailyJournalEntry) {
                keep.dailyJournalEntry = r.dailyJournalEntry;
            }
        }
    }
    return out;
}


/** 하루기록 모먼트 공유 — sharedPhotos 컬렉션 문서 존재 시에만 true (settings.sharedPhotos·photos만으로는 판단 안 함) */
function isDailyJournalMomentSharedRow(meal) {
    if (!meal?.isDailyJournal) return false;
    if (meal.momentShared === true) return true;
    const eid = meal.date ? getDailyJournalShareEntryId(meal.date) : '';
    if (!eid || !meal.userId || !feedSharedKeysCache) return false;
    return feedSharedKeysCache.has(`${meal.userId}_${eid}`);
}

function formatDailyJournalMetricsAdminHtml(entry) {
    const n = normalizeDailyJournalEntry(entry);
    const lines = [];
    if (n.weightEnabled && n.weightRecords.length > 0) {
        const chain = formatMetricRecordChain(n.weightRecords, { isWeight: true });
        if (chain) lines.push({ label: '체중', text: `${chain} kg` });
    }
    if (n.bloodSugarEnabled && n.bloodSugarRecords.length > 0) {
        const chain = formatMetricRecordChain(n.bloodSugarRecords);
        if (chain) lines.push({ label: '혈당', text: `${chain} mg/dL` });
    }
    if (!lines.length) return '<span class="text-slate-300 text-xs">-</span>';
    return lines
        .map(
            (line, i) =>
                `<div class="font-bold ${i === 0 ? 'text-slate-700' : 'text-slate-600'} break-words${i > 0 ? ' mt-0.5' : ''}">${escapeHtml(line.label)} ${escapeHtml(line.text)}</div>`
        )
        .join('');
}

/**
 * @param {string} [authorUid] 작성자 필터. 지정 시 이 결과의 건수가 그대로 「전체」 수가 되므로 상한을 줄이지 않는다
 * @param {number} [rowLimit] 이 페이지가 실제로 필요한 최대 행 수 (전체 목록에서만 줄인다)
 */
async function fetchSpecialSharesForModeration(authorUid = '', rowLimit = ADMIN_FEED_SPECIAL_ROWS_CAP) {
    const scopedUid = String(authorUid || '').trim();

    /**
     * 미러가 있으면 여기서 끝난다 — Firestore 읽기 0회.
     * 아래 서버 경로가 「timestamp 없는 문서 보강」으로 타입당 400건을 더 읽던 이유가
     * orderBy('timestamp') 가 그 문서들을 통째로 빠뜨려서였는데, 미러는 정렬과 무관하게
     * 전량을 들고 있어 보강 자체가 필요 없다.
     */
    try {
        await sharedPhotosMirror.ensureSynced();
        return await sharedPhotosMirror.getFilteredDocsLike((d) => {
            if (scopedUid && d?.userId !== scopedUid) return false;
            return ADMIN_FEED_SPECIAL_SHARE_TYPES.includes(d?.type);
        }, rowLimit);
    } catch (eMirror) {
        console.warn('[관리자 모먼트] 특수 공유 미러 실패 — 서버 조회로 대체:', eMirror);
    }

    const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
    await refreshAppCheckTokenBeforeFirestore();
    const byId = new Map();

    function addDocs(docs) {
        for (const d of docs || []) {
            if (d?.id && !byId.has(d.id)) byId.set(d.id, d);
        }
    }

    if (scopedUid) {
        for (const ty of ADMIN_FEED_SPECIAL_SHARE_TYPES) {
            try {
                const snap = await getDocs(
                    query(
                        sharedColl,
                        where('userId', '==', scopedUid),
                        where('type', '==', ty),
                        limit(ADMIN_FEED_SPECIAL_ROWS_CAP)
                    )
                );
                addDocs(snap.docs);
            } catch (e) {
                console.warn(
                    '[관리자 모먼트] 작성자 특수 공유 조회 실패:',
                    ty,
                    scopedUid,
                    e?.code || e?.message || e
                );
            }
        }
        const merged = [...byId.values()];
        merged.sort((a, b) => {
            const ra = sharedPhotoDocToAdminFeedRow(a);
            const rb = sharedPhotoDocToAdminFeedRow(b);
            return moderationRecordedAtMillis(rb) - moderationRecordedAtMillis(ra);
        });
        return merged.length > ADMIN_FEED_SPECIAL_ROWS_CAP
            ? merged.slice(0, ADMIN_FEED_SPECIAL_ROWS_CAP)
            : merged;
    }

    try {
        const q = query(
            sharedColl,
            where('type', 'in', ADMIN_FEED_SPECIAL_SHARE_TYPES),
            orderBy('timestamp', 'desc'),
            limit(rowLimit)
        );
        const snap = await getDocs(q);
        addDocs(snap.docs);
    } catch (err) {
        console.warn(
            '[관리자 모먼트] 특수 공유 단일 조회 실패 → 타입별로 재시도합니다.',
            err?.code || err?.message || err
        );
        const parts = await Promise.all(
            ADMIN_FEED_SPECIAL_SHARE_TYPES.map((ty) =>
                getDocs(query(sharedColl, where('type', '==', ty), orderBy('timestamp', 'desc'), limit(200))).catch(() => null)
            )
        );
        for (const s of parts) {
            if (s?.docs?.length) addDocs(s.docs);
        }
    }

    /**
     * 보강: `timestamp` 가 없는 문서는 orderBy('timestamp') 결과에서 통째로 빠진다.
     * 그걸 type 동등 조회로 주워 온다 — 다만 **빠진 게 실제로 있을 때만** 돈다.
     *
     * 예전에는 무조건 3회(타입당 400건) 더 읽었다. 위 쿼리가 성공했든 말든 돌았고,
     * 받아 온 것 대부분은 byId 에서 중복으로 버려졌다. 새로고침 한 번에 최대 1,200건이
     * 결과를 하나도 바꾸지 않고 나갔다.
     *
     * 「빠진 게 있나」는 건수 두 개로 가른다 — 전체 건수와, orderBy('timestamp') 를 통과하는
     * 건수. 둘이 같으면 timestamp 없는 문서가 하나도 없다는 뜻이라 보강할 것이 없다.
     * 받아 온 행 수와 비교하지 않는 이유: 상한(rowLimit)을 줄이면 늘 모자라 보여서
     * 판단이 안 선다. 건수는 getCountFromServer 라 문서를 읽지 않는다.
     */
    if (await specialSharesHaveDocsWithoutTimestamp()) {
        for (const ty of ADMIN_FEED_SPECIAL_SHARE_TYPES) {
            try {
                const snap = await getDocs(query(sharedColl, where('type', '==', ty), limit(400)));
                addDocs(snap.docs);
            } catch (e) {
                console.warn('[관리자 모먼트] 캡처 보조 조회(type만):', ty, e?.code || e?.message || e);
            }
        }
    }

    const merged = [...byId.values()];
    merged.sort((a, b) => {
        const ra = sharedPhotoDocToAdminFeedRow(a);
        const rb = sharedPhotoDocToAdminFeedRow(b);
        return moderationRecordedAtMillis(rb) - moderationRecordedAtMillis(ra);
    });
    return merged.length > rowLimit ? merged.slice(0, rowLimit) : merged;
}

/**
 * @param {number} [rowLimit] 이 페이지가 필요한 행 수. 캐시가 그보다 적게 들고 있으면 다시 받는다 —
 *   뒤 페이지일수록 더 필요하므로, 앞 페이지 캐시를 그대로 쓰면 행이 모자란다.
 */
/**
 * 미러가 없는 하루기록 공유 — 「고아」만 목록에 얹는다.
 *
 * 하루기록의 정본은 이제 meals 미러(`slotId === 'daily_journal'`)다. 미러가 있는 소감은
 * 일반 기록과 같은 스트림을 타고 들어오므로 여기서 또 얹으면 한 줄이 두 번 뜬다.
 *
 * 그래도 이 경로를 남기는 이유: 소감 본문을 지우면 미러는 삭제되지만 sharedPhotos 문서는
 * 남는다. 그 공유는 피드에 계속 떠 있는데 관리 목록에서만 사라지면 손댈 방법이 없어진다.
 *
 * @param {number} [rowLimit] 이 페이지가 필요한 최대 행 수
 */
async function getOrphanJournalSharesCached(authorUid = '', rowLimit = ADMIN_DAILY_JOURNAL_ROWS_CAP) {
    const scopeKey = moderationCacheScopeKey(authorUid);
    const now = Date.now();
    if (
        moderationDailyJournalCache.rows &&
        moderationDailyJournalCache.scopeKey === scopeKey &&
        (moderationDailyJournalCache.limitUsed || 0) >= rowLimit &&
        now - moderationDailyJournalCache.ts < ADMIN_FEED_CACHE_TTL_MS
    ) {
        return moderationDailyJournalCache.rows;
    }
    await refreshAppCheckTokenBeforeFirestore();
    let shareRows = [];
    try {
        shareRows = await fetchDailyJournalMomentSharesFromSharedPhotos(authorUid, rowLimit);
    } catch (e) {
        console.warn('[관리자 모먼트] 하루기록 공유 조회 실패', e?.code || e?.message || e);
    }
    const rows = await filterDailyJournalRowsWithoutMealMirror(shareRows);
    rows.sort((a, b) => moderationRecordedAtMillis(b) - moderationRecordedAtMillis(a));
    moderationDailyJournalCache = { ts: now, rows, scopeKey, limitUsed: rowLimit };
    if (rows.length > 0) {
        console.log(`[관리자 모먼트] 미러 없는 하루기록 공유 ${rows.length}건 (공유 ${shareRows.length}건 중)`);
    }
    return rows;
}

async function getSpecialSharesModerationRowsCached(authorUid = '', rowLimit = ADMIN_FEED_SPECIAL_ROWS_CAP) {
    const scopeKey = moderationCacheScopeKey(authorUid);
    const now = Date.now();
    if (
        moderationSpecialSharesCache.rows &&
        moderationSpecialSharesCache.scopeKey === scopeKey &&
        (moderationSpecialSharesCache.limitUsed || 0) >= rowLimit &&
        now - moderationSpecialSharesCache.ts < ADMIN_FEED_CACHE_TTL_MS
    ) {
        return moderationSpecialSharesCache.rows;
    }
    const docs = await fetchSpecialSharesForModeration(authorUid, rowLimit);
    const rows = docs.map(sharedPhotoDocToAdminFeedRow);
    moderationSpecialSharesCache = { ts: now, rows, scopeKey, limitUsed: rowLimit };
    return rows;
}

/**
 * 특수 공유 전체 건수 캐시.
 * 한 번의 새로고침 안에서 「보강이 필요한가」와 「전체 몇 건인가」가 같은 값을 묻는다.
 * getCountFromServer 라 문서를 읽지는 않지만, 두 번 물을 이유도 없다.
 */
let specialSharesCountCache = { ts: 0, value: null };
/** timestamp 없는 특수 공유가 하나라도 있는가 (보강 조회 필요 여부) */
let specialSharesMissingTsCache = { ts: 0, value: null };

/**
 * orderBy('timestamp') 는 그 필드가 없는 문서를 결과에서 통째로 뺀다.
 * 전체 건수와 「orderBy 를 통과하는 건수」가 같으면 빠지는 문서가 없다는 뜻이다.
 *
 * 확인이 실패하면 true 로 답한다 — 모르면 보강을 도는 쪽이 목록이 비는 것보다 낫다.
 */
async function specialSharesHaveDocsWithoutTimestamp() {
    const now = Date.now();
    if (
        specialSharesMissingTsCache.value !== null &&
        now - specialSharesMissingTsCache.ts < ADMIN_FEED_CACHE_TTL_MS
    ) {
        return specialSharesMissingTsCache.value;
    }
    let result = true;
    try {
        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
        const total = await getSpecialSharesTimelineCountsCached();
        if (total.known) {
            const ordered = await getCountFromServer(
                query(sharedColl, where('type', 'in', ADMIN_FEED_SPECIAL_SHARE_TYPES), orderBy('timestamp', 'desc'))
            );
            result = (ordered.data().count || 0) < total.count;
        }
    } catch (e) {
        console.warn('[관리자 모먼트] 캡처 보강 필요 여부 확인 실패 — 보조 조회를 돕니다', e?.message || e);
        result = true;
    }
    specialSharesMissingTsCache = { ts: now, value: result };
    return result;
}

async function getSpecialSharesTimelineCountsCached() {
    const now = Date.now();
    if (specialSharesCountCache.value && now - specialSharesCountCache.ts < ADMIN_FEED_CACHE_TTL_MS) {
        return specialSharesCountCache.value;
    }
    const value = await getSpecialSharesTimelineCounts();
    specialSharesCountCache = { ts: now, value };
    return value;
}

async function getSpecialSharesTimelineCounts() {
    // 미러가 있으면 세는 것도 로컬에서 — getCountFromServer 호출조차 필요 없다
    try {
        await sharedPhotosMirror.ensureSynced();
        const count = await sharedPhotosMirror.countLocal((d) =>
            ADMIN_FEED_SPECIAL_SHARE_TYPES.includes(d?.type)
        );
        return { count, known: true };
    } catch (eMirror) {
        console.warn('[관리자 모먼트] 특수 공유 건수 미러 실패 — 서버 집계로 대체:', eMirror);
    }

    const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
    await refreshAppCheckTokenBeforeFirestore();
    try {
        const q = query(sharedColl, where('type', 'in', ADMIN_FEED_SPECIAL_SHARE_TYPES));
        const cnt = await getCountFromServer(q);
        return { count: cnt.data().count || 0, known: true };
    } catch (e1) {
        try {
            let sum = 0;
            let ok = true;
            for (const ty of ADMIN_FEED_SPECIAL_SHARE_TYPES) {
                try {
                    const c = await getCountFromServer(query(sharedColl, where('type', '==', ty)));
                    sum += c.data().count || 0;
                } catch (e2) {
                    ok = false;
                    console.warn('[관리자 모먼트] 특수 공유 건수 집계 실패:', ty, e2?.code || e2?.message || e2);
                }
            }
            return { count: sum, known: ok };
        } catch (e) {
            console.warn('[관리자 모먼트] 특수 공유 건수 집계 생략', e?.message || e);
            return { count: 0, known: false };
        }
    }
}

function sharedPhotoDocToAdminFeedRow(docSnap) {
    const d = docSnap.data() || {};
    const ty = d.type;
    const isDaily = ty === 'daily';
    const isBest = ty === 'best';
    const isInsight = ty === 'insight';
    const row = {
        id: docSnap.id,
        userId: d.userId || '',
        recordedAt: d.timestamp,
        timestamp: d.timestamp,
        photoUrl: d.photoUrl || '',
        comment: d.comment || '',
        shareBanned: d.shareBanned === true,
        userNickname: d.userNickname,
        userIcon: d.userIcon,
        isBestShare: isBest,
        isDailyShare: isDaily,
        isInsightShare: isInsight
    };
    if (isDaily) {
        row.slotDisplayDate = d.date ? formatKoDateLabelFromYmd(d.date) : '';
        row.slotDisplayLabel = '일간 캡처';
        if (d.date) row.date = d.date;
    } else if (isBest) {
        row.slotDisplayDate = '';
        row.slotDisplayLabel = '주간 Best';
        row.periodType = d.periodType;
        row.periodText = d.periodText;
    } else if (isInsight) {
        row.slotDisplayDate = '';
        row.slotDisplayLabel = '밀당의 참견';
        row.dateRangeText = d.dateRangeText;
    }
    return row;
}

/** 모먼트: 페이지 쿼리·신고 집계·유저 설정 조회 TTL 캐시 */
const feedQueryCache = new Map();
let feedReportsAggCache = { ts: 0, map: null };
const feedUserSettingsCache = new Map();

function invalidateAdminFeedMonitoringCache() {
    feedQueryCache.clear();
    feedReportsAggCache = { ts: 0, map: null };
    feedUserSettingsCache.clear();
    feedSharedKeysCache = null;
    moderationSpecialSharesCache = { ts: 0, rows: null, scopeKey: '', limitUsed: 0 };
    specialSharesCountCache = { ts: 0, value: null };
    specialSharesMissingTsCache = { ts: 0, value: null };
    moderationDailyJournalCache = { ts: 0, rows: null, scopeKey: '', limitUsed: 0 };
    feedMealTotalCountKnown = true;
    feedLastDocsByPage = {};
}

/**
 * 모먼트 관리: 기록·공유 문서 삭제 (일반 = users/…/meals + sharedPhotos, 베스트/일간/인사이트 = sharedPhotos만)
 */
async function adminDeleteFeedPostInternal({ mealId, userId, isBest, isDaily, isInsight }) {
    if (!mealId || !userId) throw new Error('mealId 또는 userId가 없습니다.');
    await refreshAppCheckTokenBeforeFirestore();
    if (isBest || isDaily || isInsight) {
        await deleteDoc(doc(db, 'artifacts', appId, 'sharedPhotos', mealId));
        // 내가 지운 문서다 — 미러에서도 바로 빼야 다음 목록에서 되살아나지 않는다
        await sharedPhotosMirror.applyLocalDelete(mealId).catch(() => {});
        return;
    }
    const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
    const sharedQuery = query(sharedColl, where('userId', '==', userId), where('entryId', '==', mealId));
    const sharedSnap = await getDocs(sharedQuery);
    for (const d of sharedSnap.docs) {
        await deleteDoc(d.ref);
    }
    await sharedPhotosMirror.applyLocalDelete(sharedSnap.docs.map((d) => d.id)).catch(() => {});
    const mealRef = doc(db, 'artifacts', appId, 'users', userId, 'meals', mealId);
    await deleteDoc(mealRef);
}

async function getReportsAggregateCached() {
    const now = Date.now();
    if (feedReportsAggCache.map && now - feedReportsAggCache.ts < ADMIN_FEED_CACHE_TTL_MS) {
        return feedReportsAggCache.map;
    }
    const map = await getReportsAggregateByGroupKeys();
    feedReportsAggCache = { ts: now, map };
    return map;
}


/**
 * 모먼트 목록 정렬 모드.
 *
 * 1(정상): `recordedAt` — **적은 순서**다. 사용자가 며칠 전 끼니를 오늘 몰아 적으면
 *   그 기록들은 오늘 자리에 뜬다. 식사 날짜로 세우면 과거로 흩어져, 모니터링에서
 *   "방금 뭐가 들어왔나"를 볼 수 없다.
 *
 * 2·3은 인덱스가 없을 때만 쓰는 폴백이다. 예전에는 `recordedAt` 이 없는 구문서가 있어
 * 이 필드로 정렬하면 그것들이 결과에서 통째로 빠졌는데, 2026-08-26 백필로 전 문서가 값을 갖는다.
 */
const MEALS_FEED_SORT_MODE_RECORDED_AT = 1;
let mealsAdminMealsQueryMode = MEALS_FEED_SORT_MODE_RECORDED_AT;

/** 폴백 경고 메시지용 라벨 (인덱스 1~3) */
const FEED_SORT_MODE_LABELS = { 1: 'recordedAt(기록 시각)', 2: 'date+time(슬롯 일시)', 3: 'date(슬롯일)' };

/** 현재 모드의 Firestore orderBy 절 */
function feedMealsOrderParts() {
    if (mealsAdminMealsQueryMode === MEALS_FEED_SORT_MODE_RECORDED_AT) return [orderBy('recordedAt', 'desc')];
    if (mealsAdminMealsQueryMode === 2) return [orderBy('date', 'desc'), orderBy('time', 'desc')];
    return [orderBy('date', 'desc')];
}

function feedQueryCacheKey(page) {
    const author = feedAuthorFilter?.userId?.trim() || '';
    return `m${mealsAdminMealsQueryMode}_a${author}_${page}`;
}

function getFeedAuthorUserId() {
    return feedAuthorFilter?.userId?.trim() || '';
}

function filterModerationRowsByAuthor(rows) {
    const authorUid = getFeedAuthorUserId();
    if (!authorUid || !Array.isArray(rows)) return rows || [];
    return rows.filter((r) => r?.userId === authorUid);
}

function feedAuthorMatchesSearch(user, needleLower) {
    if (!needleLower) return false;
    const nick = String(user?.nickname ?? '').toLowerCase();
    const email = String(user?.email ?? '').toLowerCase();
    const uid = String(user?.userId ?? '').toLowerCase();
    return nick.includes(needleLower) || email.includes(needleLower) || uid.includes(needleLower);
}

async function resolveFeedAuthorNicknameFromUid(uid, rootData = null) {
    let nickname = '익명';
    try {
        const settingsSnap = await getDoc(doc(db, 'artifacts', appId, 'users', uid, 'config', 'settings'));
        if (settingsSnap.exists()) {
            const profile = settingsSnap.data()?.profile;
            const pn = profile?.nickname;
            if (pn !== undefined && pn !== null && String(pn).trim() !== '' && pn !== '게스트') {
                nickname = String(pn).trim();
            } else if (settingsSnap.data()?.profileCompleted === true) {
                nickname = '미설정';
            }
        }
    } catch (_) {}
    if (nickname === '익명' && rootData?.email) {
        const local = String(rootData.email).split('@')[0];
        if (local) nickname = local;
    }
    return nickname;
}

function syncFeedAuthorSearchInput() {
    const inp = document.getElementById('feedAuthorSearchInput');
    const clr = document.getElementById('feedAuthorSearchClearBtn');
    if (!inp) return;
    if (feedAuthorFilter?.userId) {
        inp.value = feedAuthorFilter.nickname?.trim() || feedAuthorFilter.userId;
        if (clr) clr.classList.remove('hidden');
    } else {
        inp.value = '';
        if (clr) clr.classList.add('hidden');
    }
}

function ensureFeedAuthorSearchHandlers() {
    ensureFeedBulkSelectionWatch();
    if (feedAuthorSearchHandlersBound) return;
    const inp = document.getElementById('feedAuthorSearchInput');
    const clr = document.getElementById('feedAuthorSearchClearBtn');
    if (!inp) return;
    feedAuthorSearchHandlersBound = true;

    const runApply = () => {
        void applyFeedAuthorSearch();
    };

    /**
     * 타이핑만으로는 조회하지 않는다 — 지우기(빈 칸)일 때 필터를 푸는 것만 즉시 반응한다.
     *
     * 예전에는 320ms 디바운스로 자동 조회했는데, 검색어를 다 치기 전에 멈추기만 해도
     * 사용자 전량을 읽고 「일치하는 사용자가 없습니다」 alert 를 띄웠다. 한글은 더 심해서
     * 조합 중인 'ㅁ'·'메' 로도 조회가 나갔다. 필터가 하나로 좁혀지면 다 치기도 전에
     * 목록이 걸려버리기까지 했다.
     */
    inp.addEventListener('input', () => {
        const q = (inp.value || '').trim();
        if (clr) clr.classList.toggle('hidden', !q);
        if (!q && feedAuthorFilter) void window.clearFeedAuthorFilter();
    });
    inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        // 한글 조합을 끝내는 엔터다 — 여기서 조회하면 미완성 글자로 찾는다. 다음 엔터가 진짜 검색
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        runApply();
    });
    if (clr) {
        clr.addEventListener('click', () => {
            inp.value = '';
            clr.classList.add('hidden');
            void window.clearFeedAuthorFilter();
        });
    }
}

async function applyFeedAuthorSearch() {
    const inp = document.getElementById('feedAuthorSearchInput');
    const needle = (inp?.value || '').trim();
    if (!needle) {
        await window.clearFeedAuthorFilter();
        return;
    }
    const lower = needle.toLowerCase();

    if (!needle.includes('@') && !/\s/.test(needle) && needle.length >= 10) {
        try {
            const snap = await getDoc(doc(db, 'artifacts', appId, 'users', needle));
            if (snap.exists()) {
                const nickname = await resolveFeedAuthorNicknameFromUid(needle, snap.data());
                await window.setFeedAuthorFilter(needle, nickname);
                syncFeedAuthorSearchInput();
                return;
            }
        } catch (e) {
            console.warn('[관리자 모먼트] UID 직접 조회 실패:', e?.code || e?.message || e);
        }
    }

    if (!feedAuthorSearchUsersCache) {
        if (inp) inp.disabled = true;
        try {
            const users = await fetchAllUsersForAdminAnalytics();
            feedAuthorSearchUsersCache = users.map((u) => ({
                userId: u.userId,
                nickname: u.nickname || '익명',
                email: u.email || ''
            }));
        } catch (e) {
            console.error('[관리자 모먼트] 사용자 검색 목록 로드 실패:', e);
            alert('사용자 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
            return;
        } finally {
            if (inp) inp.disabled = false;
        }
    }

    const matches = feedAuthorSearchUsersCache.filter((u) => feedAuthorMatchesSearch(u, lower));
    if (matches.length === 0) {
        alert('검색 조건에 맞는 사용자가 없습니다.\n닉네임·이메일·UID 일부만 입력해도 찾을 수 있습니다.');
        return;
    }
    if (matches.length > 1) {
        const preview = matches
            .slice(0, 5)
            .map((m) => `· ${m.nickname} (${m.userId})`)
            .join('\n');
        alert(
            `검색어와 일치하는 사용자가 ${matches.length}명입니다.\nUID를 입력하거나 검색어를 더 구체적으로 입력해 주세요.\n\n${preview}${matches.length > 5 ? '\n…' : ''}`
        );
        return;
    }
    const m = matches[0];
    await window.setFeedAuthorFilter(m.userId, m.nickname);
    syncFeedAuthorSearchInput();
}

function updateFeedAuthorFilterBar() {
    const bar = document.getElementById('feedAuthorFilterBar');
    syncFeedAuthorSearchInput();
    updateFeedFilterButtonState();
    if (!bar) return;
    const authorUid = getFeedAuthorUserId();
    if (!authorUid) {
        bar.classList.add('hidden');
        bar.innerHTML = '';
        return;
    }
    const label = feedAuthorFilter?.nickname?.trim() || '익명';
    bar.classList.remove('hidden');
    bar.innerHTML = `
        <div class="flex flex-wrap items-center gap-2 text-sm">
            <span class="text-slate-600 font-bold">작성자 필터</span>
            <span class="px-3 py-1.5 bg-violet-100 text-violet-800 rounded-lg font-bold">${escapeHtml(label)}</span>
            <span class="text-[11px] text-slate-400 font-mono">${escapeHtml(authorUid)}</span>
            <button type="button" onclick="window.clearFeedAuthorFilter()" class="px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg text-xs font-bold hover:bg-slate-200 transition-colors">필터 해제</button>
        </div>
    `;
}

/**
 * 동일 정렬·페이지에 대해 TTL 내 재요청 시 getDocs/getCount 생략
 */
async function getFeedPageWithCache(page) {
    const key = feedQueryCacheKey(page);
    const ent = feedQueryCache.get(key);
    const now = Date.now();
    if (ent && now - ent.ts < ADMIN_FEED_CACHE_TTL_MS) {
        if (page === 1) feedTotalCount = ent.totalCount;
        if (typeof ent.countKnown === 'boolean') feedMealTotalCountKnown = ent.countKnown;
        feedLastPageHasMore = Array.isArray(ent.items) && ent.items.length >= feedPageSize;
        feedLastPageRowCount =
            typeof ent.rowCount === 'number' ? ent.rowCount : Array.isArray(ent.items) ? ent.items.length : 0;
        return ent.items;
    }
    const { items } = await getFeedPage({ page, pageSize: feedPageSize });
    feedQueryCache.set(key, {
        ts: now,
        items,
        totalCount: feedTotalCount,
        countKnown: feedMealTotalCountKnown,
        rowCount: feedLastPageRowCount
    });
    return items;
}

function mealDocSnapToFeedRow(d) {
    const pathParts = d.ref.path.split('/');
    const uidx = pathParts.indexOf('users');
    const userId = uidx >= 0 && pathParts.length > uidx + 1 ? pathParts[uidx + 1] : '';
    const row = { id: d.id, userId, ...d.data() };
    if (!isDailyJournalMealRecord(row)) return row;
    const dj = dailyJournalMealDocToModerationFields(row);
    const dateStr = dj.date || row.date;
    return {
        ...row,
        ...dj,
        slotDisplayDate: formatKoDateLabelFromYmd(dateStr),
        slotDisplayLabel: '하루소감'
    };
}

function compareModerationRowsDesc(a, b) {
    const ta = moderationRecordedAtMillis(a);
    const tb = moderationRecordedAtMillis(b);
    if (tb !== ta) return tb - ta;
    return String(b.id || '').localeCompare(String(a.id || ''));
}

/**
 * 캡처 공유·하루기록(전량) + meals(배치)를 기록 시각 기준으로 병합해 skip/pageSize 만큼만 수집
 * (식사만 모아 slice 하면 하루기록이 페이지 밖으로 밀림)
 */
async function collectMergedModerationPageItems({
    skip,
    pageSize,
    pinnedRows,
    mealsGroup,
    orderParts,
    batchLimit = 120,
    maxBatches = 500
}) {
    const staticRows = Array.isArray(pinnedRows) ? [...pinnedRows].sort(compareModerationRowsDesc) : [];
    let staticIdx = 0;
    let mealCursor = null;
    let mealBuf = [];
    let mealBufIdx = 0;
    let exhausted = false;
    let batchI = 0;
    const collected = [];
    let skipped = 0;

    async function refillMeals() {
        if (mealBufIdx < mealBuf.length || exhausted) return;
        const listQ = mealCursor
            ? query(mealsGroup, ...orderParts, startAfter(mealCursor), limit(batchLimit))
            : query(mealsGroup, ...orderParts, limit(batchLimit));
        const snapshot = await getDocs(listQ);
        batchI++;
        if (!snapshot.docs.length) {
            exhausted = true;
            mealBuf = [];
            return;
        }
        mealBuf = snapshot.docs.map(mealDocSnapToFeedRow);
        mealBuf.sort(compareModerationRowsDesc);
        mealBufIdx = 0;
        mealCursor = snapshot.docs[snapshot.docs.length - 1];
    }

    while (collected.length < pageSize) {
        await refillMeals();
        const nextStatic = staticIdx < staticRows.length ? staticRows[staticIdx] : null;
        const nextMeal = mealBufIdx < mealBuf.length ? mealBuf[mealBufIdx] : null;
        if (!nextStatic && !nextMeal) break;

        const pickStatic =
            nextStatic &&
            (!nextMeal || moderationRecordedAtMillis(nextStatic) >= moderationRecordedAtMillis(nextMeal));
        const row = pickStatic ? staticRows[staticIdx++] : mealBuf[mealBufIdx++];

        if (skipped < skip) {
            skipped++;
            continue;
        }
        collected.push(row);
    }

    const hasMore =
        collected.length === pageSize &&
        (staticIdx < staticRows.length || !exhausted || mealBufIdx < mealBuf.length);

    return { items: collected, hasMore, batchesLoaded: batchI };
}

/** 피드: sharedPhotos(daily/best/insight) + users/…/meals 를 공유·기록 시각 기준으로 합쳐 한 목록으로 페이지네이션 */
async function getFeedPage(options = {}) {
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? feedPageSize;
    const skip = (page - 1) * pageSize;
    const authorUid = getFeedAuthorUserId();
    // TODO(모니터링 2차): 작성자 필터 시 postReports 전수 집계·ensureSharedKeys 범위 축소
    const mealsGroup = authorUid
        ? collection(db, 'artifacts', appId, 'users', authorUid, 'meals')
        : collectionGroup(db, 'meals');

    const orderParts = feedMealsOrderParts();

    try {
        await refreshAppCheckTokenBeforeFirestore();
        /**
         * 합쳐서 20건을 뽑는 데 500건이 필요하지 않다.
         *
         * 병합 목록의 [skip, skip+pageSize) 구간을 만들려면 각 출처에서 **자기 기준 최신
         * skip+pageSize 건**만 있으면 충분하다 — 그보다 뒤에 있는 행은 자기 출처 안에서만도
         * 이미 skip+pageSize 개에게 밀렸으므로 이 페이지에 오를 수 없다.
         *
         * 두 pinned 출처 모두 timestamp 최신순으로 받고 목록도 같은 값으로 세우므로
         * 축이 일치해 이 상한이 정확하다.
         *
         * 작성자 필터일 때는 이 결과의 건수가 그대로 「전체」 수로 쓰이므로 줄이지 않는다.
         */
        const specNeeded = authorUid
            ? ADMIN_FEED_SPECIAL_ROWS_CAP
            : Math.min(skip + pageSize, ADMIN_FEED_SPECIAL_ROWS_CAP);
        const specRows = await getSpecialSharesModerationRowsCached(authorUid, specNeeded);
        /**
         * 하루기록은 meals 미러가 정본이라 일반 기록과 같은 스트림으로 들어온다.
         * 여기서 얹는 것은 미러가 사라진 「고아 공유」뿐이다 — 흔치 않다.
         */
        const journalNeeded = authorUid
            ? ADMIN_DAILY_JOURNAL_ROWS_CAP
            : Math.min(skip + pageSize, ADMIN_DAILY_JOURNAL_ROWS_CAP);
        const journalRows = await getOrphanJournalSharesCached(authorUid, journalNeeded);
        const specPinned = filterModerationRowsByAuthor(specRows);
        const journalPinned = filterModerationRowsByAuthor(journalRows);

        if (page === 1) {
            if (authorUid) {
                let mealsN = 0;
                let mealsKnown = true;
                try {
                    const countSnap = await getCountFromServer(query(mealsGroup, ...orderParts));
                    mealsN = countSnap.data().count || 0;
                } catch (cntErr) {
                    mealsKnown = false;
                    console.warn(
                        '[관리자 모먼트] 작성자 식사 건수 집계 실패',
                        cntErr?.code || cntErr?.message || cntErr
                    );
                }
                feedMealTotalCountKnown = mealsKnown;
                feedTotalCount = mealsN + specPinned.length + journalPinned.length;
            } else {
                let mealsN = 0;
                let mealsKnown = true;
                try {
                    const countSnap = await getCountFromServer(query(mealsGroup, ...orderParts));
                    mealsN = countSnap.data().count || 0;
                } catch (cntErr) {
                    mealsKnown = false;
                    console.warn(
                        '[관리자 모먼트] 식사 건수 집계(getCount) 실패 — 합산 집계는 일부 생략합니다.',
                        cntErr?.code || cntErr?.message || cntErr
                    );
                }
                let specKnown = true;
                let specN = 0;
                try {
                    const sc = await getSpecialSharesTimelineCountsCached();
                    specN = sc.count;
                    specKnown = sc.known;
                } catch (e) {
                    specKnown = false;
                    console.warn('[관리자 모먼트] 캡처 공유 건수 집계 실패', e?.code || e?.message || e);
                }
                /**
                 * 하루기록 미러는 meals 문서라 위 mealsN 에 이미 들어 있다.
                 * 여기서 더하는 것은 미러 없는 고아 공유뿐이고, 그마저 이 페이지가 받은
                 * 상한 안에서 센 수라 정확한 총계는 아니다 — 고아는 드물어 오차를 감수한다.
                 */
                const journalN = journalRows.length;
                const journalKnown = true;
                feedMealTotalCountKnown = mealsKnown && specKnown && journalKnown;
                if (feedMealTotalCountKnown) {
                    feedTotalCount = mealsN + specN + journalN;
                } else if (mealsKnown) {
                    feedTotalCount = mealsN + (specKnown ? specN : 0) + (journalKnown ? journalN : 0);
                } else {
                    feedTotalCount = (specKnown ? specN : 0) + (journalKnown ? journalN : 0);
                }
            }
        }

        const merged = await collectMergedModerationPageItems({
            skip,
            pageSize,
            pinnedRows: [...specPinned, ...journalPinned],
            mealsGroup,
            orderParts
        });
        const items = merged.items;
        feedLastPageRowCount = items.length;
        feedLastPageHasMore = merged.hasMore;

        return { items, totalCount: feedTotalCount, hasMore: feedLastPageHasMore };
    } catch (e) {
        if (page === 1 && e?.code === 'failed-precondition' && mealsAdminMealsQueryMode < 3) {
            const next = mealsAdminMealsQueryMode + 1;
            console.warn(
                `관리자 모먼트 피드: ${FEED_SORT_MODE_LABELS[mealsAdminMealsQueryMode]} 인덱스가 없어 ` +
                    `${FEED_SORT_MODE_LABELS[next]}(으)로 내려갑니다. 배포: firebase deploy --only firestore:indexes`,
                e?.message || e
            );
            mealsAdminMealsQueryMode = next;
            feedLastDocsByPage = {};
            feedQueryCache.clear();
            return getFeedPage(options);
        }
        console.error('getFeedPage error:', e);
        throw e;
    }
}

/** 현재 페이지 식사(meals) 행 기준 공유 표시용 캐시 — sharedPhotos.entryId 매칭 */
async function ensureSharedKeysForFeedRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    if (!feedSharedKeysCache) feedSharedKeysCache = new Set();
    for (const m of rows) {
        if (!m?.userId) continue;
        if (m && (m.isDailyShare || m.isBestShare || m.isInsightShare) && m.id) {
            feedSharedKeysCache.add(`${m.userId}_${m.id}`);
        }
    }
    const meals = rows.filter(
        (m) => m && !m.isDailyShare && !m.isBestShare && !m.isInsightShare && !m.isDailyJournal
    );
    if (!meals.length) return;
    const byUser = new Map();
    for (const m of meals) {
        if (!m?.userId || !m?.id) continue;
        const key = `${m.userId}_${m.id}`;
        if (feedSharedKeysCache.has(key)) continue;
        if (!byUser.has(m.userId)) byUser.set(m.userId, new Set());
        byUser.get(m.userId).add(m.id);
    }
    const djByUser = new Map();
    for (const m of rows) {
        if (!m?.isDailyJournal || !m.userId || !m.date || m.momentShared === true) continue;
        const eid = getDailyJournalShareEntryId(m.date);
        if (!eid) continue;
        if (!djByUser.has(m.userId)) djByUser.set(m.userId, new Set());
        djByUser.get(m.userId).add(eid);
    }
    const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
    for (const [uid, eidSet] of djByUser) {
        const entryIds = [...eidSet];
        for (let i = 0; i < entryIds.length; i += 10) {
            const chunk = entryIds.slice(i, i + 10);
            try {
                const q = query(
                    sharedColl,
                    where('userId', '==', uid),
                    where('entryId', 'in', chunk)
                );
                const snap = await getDocs(q);
                snap.docs.forEach((d) => {
                    const data = d.data();
                    const eid = data.entryId || null;
                    if (uid && eid) {
                        feedSharedKeysCache.add(`${uid}_${eid}`);
                        const row = rows.find(
                            (r) =>
                                r?.isDailyJournal &&
                                r.userId === uid &&
                                getDailyJournalShareEntryId(r.date) === eid
                        );
                        if (row) {
                            row.momentShared = true;
                            const tsMs = firestoreTimestampToMillis(data.timestamp);
                            if (tsMs > (row.momentShareAtMillis || 0)) row.momentShareAtMillis = tsMs;
                        }
                    }
                });
            } catch (e) {
                console.warn('ensureSharedKeysForFeedRows(dailyJournal):', e?.message || e);
            }
        }
    }

    if (byUser.size === 0) return;
    for (const [uid, idSet] of byUser) {
        const ids = [...idSet];
        for (let i = 0; i < ids.length; i += 10) {
            const chunk = ids.slice(i, i + 10);
            try {
                const q = query(
                    sharedColl,
                    where('userId', '==', uid),
                    where('entryId', 'in', chunk)
                );
                const snap = await getDocs(q);
                snap.docs.forEach((d) => {
                    const data = d.data();
                    const eid = data.entryId || data.mealId || null;
                    const u = data.userId;
                    if (u && eid) feedSharedKeysCache.add(`${u}_${eid}`);
                });
            } catch (e) {
                console.warn('ensureSharedKeysForFeedRows:', e?.message || e);
            }
        }
    }
}

async function renderFeedManagement() {
    const container = document.getElementById('feedManagementContainer');
    if (!container) return;

    ensureFeedAuthorSearchHandlers();
    
    container.innerHTML = '<div class="text-center py-8 text-slate-400"><i data-lucide="loader-circle" class="text-2xl mb-2 lucide-spin"></i><p>로딩 중...</p></div>';
    
    try {
        console.log('📋 피드 관리: 페이지', feedCurrentPage, '로드 중... (페이지 단위)');
        const pageRows = await getFeedPageWithCache(feedCurrentPage);
        await ensureSharedKeysForFeedRows(pageRows);
        const allRows = collapseDailyJournalDuplicateRows(pageRows);

        console.log('🔍 필터 적용:', feedFilters, feedAuthorFilter);
        const authorUid = getFeedAuthorUserId();
        let filteredMeals = allRows.filter((meal) => {
            if (authorUid && meal.userId !== authorUid) return false;
            const isDailyJournalRow = meal.isDailyJournal === true;
            const isCapture = !!(meal.isDailyShare || meal.isBestShare || meal.isInsightShare);
            const isActuallyShared =
                isCapture || !!(feedSharedKeysCache && feedSharedKeysCache.has(`${meal.userId}_${meal.id}`));
            const isDjMomentShared = isDailyJournalRow && isDailyJournalMomentSharedRow(meal);
            if (isDailyJournalRow) {
                if (feedFilters.shared === 'yes' && !isDjMomentShared) return false;
                if (feedFilters.shared === 'no' && isDjMomentShared) return false;
            } else {
                if (feedFilters.shared === 'yes' && !isActuallyShared) return false;
                if (feedFilters.shared === 'no' && isActuallyShared) return false;
                const isBanned = meal.shareBanned === true;
                if (feedFilters.banned === 'yes' && !isBanned) return false;
                if (feedFilters.banned === 'no' && isBanned) return false;
            }
            const hasPhotos =
                (meal.photos && Array.isArray(meal.photos) && meal.photos.length > 0) ||
                Boolean(meal.photoUrl && String(meal.photoUrl).trim());
            if (feedFilters.hasPhotos === 'yes' && !hasPhotos) return false;
            if (feedFilters.hasPhotos === 'no' && hasPhotos) return false;
            return true;
        });

        const dailyJournalOnPage = filteredMeals.filter((m) => m.isDailyJournal).length;
        console.log(
            `✅ 필터 적용 후: ${filteredMeals.length}건 (하루 소감 ${dailyJournalOnPage}건, 페이지 ${feedCurrentPage}${feedMealTotalCountKnown ? ` / 합산 총 ${feedTotalCount}건` : ' / 총 집계 생략'})`
        );

        filteredMeals.sort(compareModerationRowsDesc);

        // 페이지 단위 로드 결과에서만 표시
        const totalPages = computeFeedAdminTotalPages();
        const paginatedMeals = filteredMeals;

        if (paginatedMeals.length === 0) {
            const emptyMsg = authorUid
                ? '선택한 작성자의 게시물이 없습니다.'
                : '게시물이 없습니다.';
            container.innerHTML =
                `<div class="text-center py-8 text-slate-400"><i data-lucide="images" class="text-2xl mb-2"></i><p>${escapeHtml(emptyMsg)}</p></div>`;
            updateFeedAuthorFilterBar();
            adminFeedMonitoringLoaded = true;
            renderFeedPagination(computeFeedAdminTotalPages());
            return;
        }

        // 사용자 정보 가져오기 (타임라인 게시물은 설정에서 닉네임/아이콘 조회)
        const userInfoMap = new Map();
        const userIdsToFetch = [
            ...new Set(paginatedMeals.map((m) => m.userId).filter(Boolean))
        ];
        const [emailMap] = await Promise.all([
            fetchAdminEmailsForUserIds(userIdsToFetch),
            Promise.all(
                userIdsToFetch.map(async (uid) => {
                    if (userInfoMap.has(uid)) return;
                    const now = Date.now();
                    const hit = feedUserSettingsCache.get(uid);
                    if (hit && now - hit.ts < ADMIN_FEED_CACHE_TTL_MS) {
                        userInfoMap.set(uid, { nickname: hit.nickname, icon: hit.icon, email: '' });
                        return;
                    }
                    try {
                        const settingsSnap = await getDoc(doc(db, 'artifacts', appId, 'users', uid, 'config', 'settings'));
                        if (settingsSnap.exists()) {
                            const s = settingsSnap.data();
                            const row = {
                                nickname: s.profile?.nickname || '익명',
                                icon: s.profile?.icon || '🐻',
                                email: ''
                            };
                            feedUserSettingsCache.set(uid, { ts: now, nickname: row.nickname, icon: row.icon });
                            userInfoMap.set(uid, row);
                        }
                    } catch (e) {
                        console.warn('사용자 정보 조회 실패:', uid, e);
                    }
                })
            )
        ]);
        userIdsToFetch.forEach((uid) => {
            if (!userInfoMap.has(uid)) userInfoMap.set(uid, { nickname: '익명', icon: '🐻', email: '' });
            const row = userInfoMap.get(uid);
            row.email = emailMap.get(uid) || '';
        });

        const reportsMap = await getReportsAggregateCached();
        window._feedReportDetails = {};

        const fmtDateTimeParts = (meal) => {
            const kst = { timeZone: 'Asia/Seoul' };
            const toParts = (d) => {
                if (!d || !Number.isFinite(d.getTime())) return null;
                return {
                    date: d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', ...kst }),
                    time: d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, ...kst })
                };
            };
            const fromRaw = (raw) => {
                if (raw == null) return null;
                if (raw && typeof raw.toDate === 'function') return toParts(raw.toDate());
                if (raw instanceof Date) return toParts(raw);
                if (typeof raw === 'string') return toParts(new Date(raw));
                if (typeof raw === 'object' && typeof raw.seconds === 'number') {
                    return toParts(new Date(raw.seconds * 1000 + (raw.nanoseconds || 0) / 1e6));
                }
                return null;
            };
            let p = fromRaw(meal?.recordedAt);
            if (p) return p;
            p = fromRaw(meal?.timestamp);
            if (p) return p;
            if (meal?.date) {
                try {
                    let t = meal.time || '00:00';
                    if (t && String(t).split(':').length === 2) t = `${t}:00`;
                    const d = new Date(`${meal.date}T${t}`);
                    p = toParts(d);
                    if (p) return p;
                } catch (_) {}
                return { date: String(meal.date), time: String(meal.time || '-') };
            }
            return { date: '-', time: '-' };
        };

        const getCategoryCell = (major, minor) => {
            const m1 = (major || '').toString().trim();
            const m2 = (minor || '').toString().trim();
            if (!m1 && !m2) return '<span class="text-slate-300 text-xs">-</span>';
            return `
                <div class="text-xs leading-tight text-center">
                    ${m1 ? `<div class="font-bold text-slate-700 break-words">${escapeHtml(m1)}</div>` : ''}
                    ${m2 ? `<div class="text-slate-500 break-words mt-0.5">${escapeHtml(m2)}</div>` : ''}
                </div>
            `;
        };

        const rowsHtml =
            paginatedMeals.length === 0
                ? `<tr><td colspan="14" class="px-4 py-10 text-center text-slate-400 text-sm border-t border-slate-200">이 페이지에 표시할 모먼트가 없습니다.</td></tr>`
                : paginatedMeals.map((meal, rowIdx) => {
            const isDailyJournal = meal.isDailyJournal === true;
            const isCapture = !!(meal.isDailyShare || meal.isBestShare || meal.isInsightShare);
            const targetGroupKey = isDailyJournal
                ? `dailyJournal_${meal.date || ''}_${meal.userId}`
                : meal.isBestShare
                ? `best_${meal.id}`
                : meal.isDailyShare
                    ? `daily_${meal.date || ''}_${meal.userId}`
                    : meal.isInsightShare
                        ? `insight_${meal.dateRangeText || ''}_${meal.userId}`
                        : `entry_${meal.id}_${meal.userId}`;
            const reportInfo = reportsMap[targetGroupKey];
            if (reportInfo && reportInfo.count > 0) window._feedReportDetails[targetGroupKey] = reportInfo.byReason;
            const reportBadgeHtml = (reportInfo && reportInfo.count > 0)
                ? `<button type="button" class="px-2 py-0.5 bg-red-100 text-red-700 text-xs font-bold rounded hover:bg-red-200" onclick="window.showReportDetailPopup('${String(targetGroupKey).replace(/'/g, "\\'")}')">🚩 ${reportInfo.count}</button>`
                : '';

            const baseAuthor = userInfoMap.get(meal.userId) || { nickname: '익명', icon: '🐻', email: '' };
            const userInfo =
                meal.isBestShare || meal.isDailyShare || meal.isInsightShare
                    ? {
                          ...baseAuthor,
                          nickname: meal.userNickname || baseAuthor.nickname,
                          icon: meal.userIcon || baseAuthor.icon
                      }
                    : baseAuthor;

            const isShared = isDailyJournal
                ? isDailyJournalMomentSharedRow(meal)
                : isCapture || !!(feedSharedKeysCache && feedSharedKeysCache.has(`${meal.userId}_${meal.id}`));
            const hasLocalSharedPhotos =
                !isDailyJournal &&
                meal.sharedPhotos &&
                Array.isArray(meal.sharedPhotos) &&
                meal.sharedPhotos.length > 0;
            const hasPhotos = (Array.isArray(meal.photos) && meal.photos.length > 0) || Boolean(meal.photoUrl);
            const isBanned = meal.shareBanned === true;
            const hasDataMismatch = !isCapture && !isDailyJournal && hasLocalSharedPhotos && !isShared;

            const typeLabel = isDailyJournal
                ? meal.momentShared && meal.isDailyJournalSlot !== true
                    ? '하루기록·모먼트'
                    : meal.momentShared
                      ? '하루기록·슬롯+모먼트'
                      : '하루기록·슬롯'
                : meal.isBestShare
                    ? '주간 Best'
                    : meal.isDailyShare
                        ? '일간 캡처'
                        : meal.isInsightShare
                            ? '밀당의 참견'
                            : '일반';

            // 간식 '어디서'는 칩(snackPlaceMain)이 정본이고, 칩이 없던 옛 기록만 자유입력(place)으로 메운다
            const whereTag = isCapture || isDailyJournal ? '' : meal.snackPlaceMain || meal.place || meal.snackPlace || '';
            const whereSubTag = isCapture || isDailyJournal ? '' : meal.placeDetail || meal.placeMemo || '';
            // 끼니 1축 '어떻게'(집밥·외식·배달). 간식에는 이 축이 없어 빈 칸으로 남는다
            const howTag = isCapture || isDailyJournal ? '' : meal.mealType || '';
            // mealType 을 여기 섞지 않는다 — '어떻게'(조달) 값이라 '무엇을'(형태) 칸을 오염시킨다
            const whatTag = isCapture || isDailyJournal ? '' : meal.category || meal.categoryAuto || meal.snackType || '';
            const whatSubTag = isCapture || isDailyJournal ? '' : meal.menuDetail || meal.snackDetail || '';
            const withTag = isCapture || isDailyJournal ? '' : meal.withWhom || '';
            const withSubTag = isCapture || isDailyJournal ? '' : meal.withWhomDetail || '';
            const ratingVal = isCapture || isDailyJournal ? null : meal.snackRating ?? meal.rating;
            const satietyVal = isCapture || isDailyJournal ? null : meal.satiety;
            const dailyJournalMetricsHtml = isDailyJournal
                ? formatDailyJournalMetricsAdminHtml(meal.dailyJournalEntry)
                : '';
            const photoUrls = (() => {
                if (Array.isArray(meal.photos) && meal.photos.length > 0) {
                    return meal.photos.map((u) => String(u || '').trim()).filter(Boolean);
                }
                if (meal.photoUrl && String(meal.photoUrl).trim()) {
                    return [String(meal.photoUrl).trim()];
                }
                return [];
            })();
            const firstPhoto = photoUrls[0] || '';
            const rowBg = hasDataMismatch ? 'bg-yellow-50' : (isBanned ? 'bg-red-50' : '');
            const dateTime = fmtDateTimeParts(meal);
            const newestOrder = (feedCurrentPage - 1) * feedPageSize + rowIdx + 1;
            const oldFirstNumber = feedMealTotalCountKnown
                ? Math.max(1, (feedTotalCount || 0) - newestOrder + 1)
                : '—';
            const slotKey = String(meal.slotId || '').toLowerCase();
            const slotLabelMap = {
                pre_morning: '아침전',
                morning: '아침',
                snack1: '오전간식',
                snack2: '오후간식',
                night: '저녁후간식',
                breakfast: '아침',
                lunch: '점심',
                dinner: '저녁',
                snack: '간식',
                before_breakfast: '아침전',
                after_breakfast: '아침후',
                before_lunch: '점심전',
                after_lunch: '점심후',
                before_dinner: '저녁전',
                after_dinner: '저녁후'
            };
            // 식사구분은 slotId만 기준으로 표시 (mealType/snackType은 '무엇을' 성격 데이터)
            const mealSlotLabel = slotLabelMap[slotKey] || '-';
            const mealDateLabel = (() => {
                const raw = String(meal.date || '').trim();
                if (!raw) return '';
                try {
                    const d = new Date(raw);
                    if (Number.isNaN(d.getTime())) return raw;
                    // ko-KR은 "2026. 03. 27." 형태 → 공백 제거해서 "2026.03.27."로
                    return d
                        .toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })
                        .replace(/\s+/g, '');
                } catch (_) {
                    return raw;
                }
            })();
            const mealSlotDisplay =
                typeof meal.slotDisplayLabel === 'string'
                    ? { date: meal.slotDisplayDate ?? '', label: meal.slotDisplayLabel }
                    : { date: mealDateLabel, label: mealSlotLabel };

            return `
                <tr class="border-t border-slate-200 ${rowBg}">
                    <td class="px-3 py-3 align-middle text-center border-r border-slate-200">
                        <input type="checkbox" class="feed-item-checkbox" data-meal-id="${meal.id}" data-user-id="${meal.userId}" ${meal.isBestShare ? 'data-is-best="true"' : ''} ${meal.isDailyShare ? 'data-is-daily="true"' : ''} ${meal.isInsightShare ? 'data-is-insight="true"' : ''} ${isDailyJournal ? 'data-is-daily-journal="true"' : ''} ${isDailyJournal ? 'disabled title="하루 소감은 이 화면에서 일괄 처리할 수 없습니다"' : ''}>
                    </td>
                    <td class="px-2 py-3 align-middle text-center border-r border-slate-200 w-[56px] min-w-[56px]">
                        <div class="flex flex-col items-center gap-1">
                            <span class="text-xs font-bold text-slate-600">${oldFirstNumber}</span>
                            ${isShared ? '<span class="px-1.5 py-0.5 bg-emerald-100 text-emerald-700 text-[10px] font-bold rounded">공유</span>' : ''}
                        </div>
                    </td>
                    <td class="px-2 py-3 align-middle text-center w-[112px] min-w-[112px] max-w-[112px] border-r border-slate-200">
                        <div class="text-xs text-slate-700 font-semibold leading-tight whitespace-nowrap">${escapeHtml(dateTime.date)}</div>
                        <div class="text-[11px] text-slate-500 leading-tight mt-0.5 whitespace-nowrap">${escapeHtml(dateTime.time)}</div>
                        <div class="text-[10px] text-slate-400 break-all leading-tight mt-1 font-mono text-left px-0.5" title="게시물 ID">${escapeHtml(String(meal.id || '-'))}</div>
                    </td>
                    <td class="px-3 py-3 align-middle w-[176px] max-w-[176px] text-center border-r border-slate-200">
                        <div class="flex flex-col items-center gap-1 overflow-hidden">
                            <button type="button" class="admin-feed-author-filter text-sm font-semibold text-emerald-700 hover:text-emerald-900 hover:underline break-words cursor-pointer bg-transparent border-0 p-0 text-center" data-user-id="${escapeHtml(meal.userId)}" data-nickname="${escapeHtml(userInfo.nickname)}" title="이 작성자 기록만 보기">${userInfo.icon} ${escapeHtml(userInfo.nickname)}</button>
                            ${userInfo.email ? `<span class="text-[11px] text-slate-500 break-all leading-tight">${escapeHtml(userInfo.email)}</span>` : ''}
                            <span class="px-2 py-0.5 bg-slate-100 text-slate-700 text-xs font-bold rounded">${typeLabel}</span>
                        </div>
                    </td>
                    <td class="px-2 py-3 align-middle w-[92px] max-w-[92px] text-center border-r border-slate-200 overflow-hidden">
                        <div class="inline-flex flex-col items-center justify-center px-2 py-1 rounded bg-slate-100 text-slate-700 text-xs font-bold leading-tight">
                            ${mealSlotDisplay.date ? `<span class="whitespace-nowrap">${escapeHtml(String(mealSlotDisplay.date))}</span>` : ''}
                            <span class="whitespace-nowrap">${escapeHtml(String(mealSlotDisplay.label))}</span>
                        </div>
                    </td>
                    <td class="px-3 py-3 align-middle w-[102px] max-w-[102px] text-center border-r border-slate-200 overflow-hidden">${getCategoryCell(howTag, '')}</td>
                    <td class="px-3 py-3 align-middle w-[102px] max-w-[102px] text-center border-r border-slate-200 overflow-hidden">${getCategoryCell(whereTag, whereSubTag)}</td>
                    <td class="px-3 py-3 align-middle w-[102px] max-w-[102px] text-center border-r border-slate-200 overflow-hidden">${getCategoryCell(whatTag, whatSubTag)}</td>
                    <td class="px-3 py-3 align-middle w-[102px] max-w-[102px] text-center border-r border-slate-200 overflow-hidden">${getCategoryCell(withTag, withSubTag)}</td>
                    <td class="px-3 py-3 align-middle w-[92px] max-w-[92px] text-center border-r border-slate-200 overflow-hidden">
                        ${
                            isDailyJournal
                                ? `<div class="text-xs leading-tight">${dailyJournalMetricsHtml}</div>`
                                : `<div class="text-xs leading-tight">
                            <div class="font-bold text-slate-700 break-words">만족도 ${escapeHtml(String(ratingVal ?? '-'))}</div>
                            <div class="font-bold text-slate-600 break-words mt-0.5">포만감 ${escapeHtml(String(satietyVal ?? '-'))}</div>
                        </div>`
                        }
                    </td>
                    <td class="px-2 py-3 align-middle text-center w-[208px] min-w-[208px] border-r border-slate-200">
                        ${photoUrls.length > 0
                            ? `<div class="relative inline-block mx-auto max-w-full">
                                <button type="button" class="group p-0 border-0 bg-transparent cursor-zoom-in rounded-lg" onclick='window.openAdminFeedPhotoViewer(${JSON.stringify(photoUrls)}, 0)' title="클릭하여 원본 크기로 보기" aria-label="사진 원본 보기">
                                    <span class="relative block mx-auto w-[200px] h-[200px] rounded-lg border border-slate-200 bg-white overflow-hidden">
                                        <img src="${escapeHtml(firstPhoto)}" alt="" class="absolute inset-0 w-full h-full object-contain pointer-events-none">
                                        ${
                                            photoUrls.length > 1
                                                ? `<span class="absolute top-1 right-1 z-10 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] font-bold leading-none pointer-events-none shadow-sm">1/${photoUrls.length}</span>`
                                                : ''
                                        }
                                    </span>
                                </button>
                            </div>`
                            : '<span class="text-slate-300 text-xs">-</span>'}
                    </td>
                    <td class="px-3 py-3 align-middle w-[240px] min-w-[240px] border-r border-slate-200">
                        ${meal.comment
                            ? `<div class="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto text-left">${escapeHtml(String(meal.comment))}</div>`
                            : '<span class="text-slate-300 text-xs">-</span>'}
                    </td>
                    <td class="px-2 py-3 align-middle text-center whitespace-nowrap w-[72px] min-w-[72px]">
                        <div class="inline-flex flex-wrap justify-center items-center gap-1">
                            ${isShared ? '<span class="px-2 py-0.5 bg-emerald-100 text-emerald-700 text-xs font-bold rounded">공유됨</span>' : ''}
                            ${isBanned ? '<span class="px-2 py-0.5 bg-red-100 text-red-700 text-xs font-bold rounded">금지됨</span>' : ''}
                            ${hasDataMismatch ? '<span class="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs font-bold rounded">데이터 불일치</span>' : ''}
                            ${reportBadgeHtml}
                            ${hasDataMismatch ? `<button onclick="window.syncSharedPhotos('${meal.id}', '${meal.userId}')" class="px-2 py-0.5 bg-yellow-600 text-white rounded text-xs font-bold hover:bg-yellow-700 transition-colors">동기화</button>` : ''}
                        </div>
                    </td>
                    <td class="px-2 py-3 align-middle text-center w-[56px] min-w-[56px]">
                        ${
                            isDailyJournal
                                ? '<span class="text-slate-300 text-xs">-</span>'
                                : `<button type="button" class="admin-feed-row-delete px-2 py-1 bg-red-50 text-red-700 text-xs font-bold rounded hover:bg-red-100 border border-red-200 transition-colors" data-meal-id="${meal.id}" data-user-id="${meal.userId}" ${meal.isBestShare ? 'data-is-best="true"' : ''} ${meal.isDailyShare ? 'data-is-daily="true"' : ''} ${meal.isInsightShare ? 'data-is-insight="true"' : ''}>삭제</button>`
                        }
                    </td>
                </tr>
            `;
        }).join('');

        container.innerHTML =
            `
            <div class="overflow-x-auto border border-slate-200 rounded-xl bg-white">
                <table class="w-full table-fixed text-left">
                    <thead class="bg-slate-50">
                        <tr class="text-xs text-slate-500">
                            <th class="px-3 py-3 font-bold w-10 text-center whitespace-nowrap border-r border-slate-200">선택</th>
                            <th class="px-2 py-3 font-bold text-center whitespace-nowrap w-[56px] min-w-[56px] border-r border-slate-200">번호</th>
                            <th class="px-2 py-3 font-bold text-center whitespace-nowrap w-[112px] min-w-[112px] border-r border-slate-200">기록 일시</th>
                            <th class="px-3 py-3 font-bold text-center w-[176px] whitespace-nowrap border-r border-slate-200">작성자</th>
                            <th class="px-2 py-3 font-bold text-center w-[92px] whitespace-nowrap border-r border-slate-200">식사구분</th>
                            <th class="px-3 py-3 font-bold text-center w-[102px] whitespace-nowrap border-r border-slate-200">어떻게</th>
                            <th class="px-3 py-3 font-bold text-center w-[102px] whitespace-nowrap border-r border-slate-200">어디서</th>
                            <th class="px-3 py-3 font-bold text-center w-[102px] whitespace-nowrap border-r border-slate-200">무엇을</th>
                            <th class="px-3 py-3 font-bold text-center w-[102px] whitespace-nowrap border-r border-slate-200">누구와</th>
                            <th class="px-3 py-3 font-bold text-center w-[92px] whitespace-nowrap border-r border-slate-200">만족도/포만감</th>
                            <th class="px-2 py-3 font-bold text-center whitespace-nowrap w-[208px] min-w-[208px] border-r border-slate-200">사진</th>
                            <th class="px-3 py-3 font-bold text-center whitespace-nowrap w-[240px] min-w-[240px] border-r border-slate-200">코멘트</th>
                            <th class="px-2 py-3 font-bold text-center whitespace-nowrap w-[72px] min-w-[72px] border-r border-slate-200">상태/신고</th>
                            <th class="px-2 py-3 font-bold text-center whitespace-nowrap w-[56px] min-w-[56px]">삭제</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>
        `;

        container.querySelectorAll('.admin-feed-row-delete').forEach((btn) => {
            btn.addEventListener('click', (ev) => {
                ev.preventDefault();
                void window.adminDeleteSingleFeedPost(btn);
            });
        });
        container.querySelectorAll('.admin-feed-author-filter').forEach((btn) => {
            btn.addEventListener('click', (ev) => {
                ev.preventDefault();
                const uid = btn.getAttribute('data-user-id') || '';
                const nick = btn.getAttribute('data-nickname') || '';
                void window.setFeedAuthorFilter(uid, nick);
            });
        });

        // 페이지네이션 렌더링
        renderFeedPagination(totalPages);

        updateFeedAuthorFilterBar();
        // 토글 버튼 색상 업데이트
        updateFeedFilterToggleColors();
        updateFeedBulkButtonState();
        adminFeedMonitoringLoaded = true;
    } catch (e) {
        adminFeedMonitoringLoaded = false;
        console.error("피드 관리 렌더링 실패:", e);
        const msg = e?.message || '';
        const isIndexError = /COLLECTION_GROUP.*index|requires.*index/i.test(msg);
        const createLink = (e?.message && /https:\/\/[^\s)]+/.exec(e.message))?.[0] || 'https://console.firebase.google.com/v1/r/project/mealog-r0/firestore/indexes?create_exemption=Cklwcm9qZWN0cy9tZWFsb2ctcjAvZGF0YWJhc2VzLyhkZWZhdWx0KS9jb2xsZWN0aW9uR3JvdXBzL21lYWxzL2ZpZWxkcy9kYXRlEAIaCAoEZGF0ZRAC';
        if (isIndexError) {
            container.innerHTML = `
                <div class="text-center py-8 px-4 max-w-lg mx-auto">
                    <i data-lucide="database" class="text-4xl text-amber-500 mb-4"></i>
                    <p class="font-bold text-slate-800 mb-2">피드 조회용 인덱스가 필요합니다</p>
                    <p class="text-sm text-slate-600 mb-4">아래 버튼을 눌러 Firebase Console에서 <strong>meals</strong> 컬렉션 그룹의 <strong>date</strong> 필드(내림차순) 인덱스를 한 번만 생성해 주세요.</p>
                    <a href="${createLink}" target="_blank" rel="noopener" class="inline-block px-4 py-3 bg-emerald-600 text-white rounded-xl font-bold text-sm hover:bg-emerald-700 transition-colors">인덱스 만들기 (콘솔 열기)</a>
                    <p class="text-xs text-slate-500 mt-4">인덱스가 활성화되기까지 1~2분 걸릴 수 있습니다. 생성 후 피드를 새로고침하세요.</p>
                </div>`;
        } else {
            container.innerHTML = '<div class="text-center py-8 text-red-400"><i data-lucide="triangle-alert" class="text-2xl mb-2"></i><p>게시물을 불러오는 중 오류가 발생했습니다.</p><p class="text-xs mt-2 text-slate-500">' + (msg ? escapeHtml(msg) : '') + '</p></div>';
        }
    }
}

// 피드 필터 토글 버튼 색상 업데이트
function updateFeedFilterToggleColors() {
    ['shared', 'hasPhotos', 'banned'].forEach(filterType => {
        const toggleBtn = document.getElementById(`feed-filter-${filterType}-toggle`);
        if (toggleBtn) {
            const currentValue = feedFilters[filterType];
            if (currentValue === 'all') {
                toggleBtn.className = 'feed-filter-toggle px-4 py-2 bg-blue-100 text-blue-700 rounded-lg text-xs font-bold transition-colors';
                toggleBtn.textContent = '전체';
            } else if (currentValue === 'yes') {
                toggleBtn.className = 'feed-filter-toggle px-4 py-2 bg-emerald-100 text-emerald-700 rounded-lg text-xs font-bold transition-colors';
                toggleBtn.textContent = '예';
            } else {
                toggleBtn.className = 'feed-filter-toggle px-4 py-2 bg-red-100 text-red-700 rounded-lg text-xs font-bold transition-colors';
                toggleBtn.textContent = '아니오';
            }
        }
    });
    updateFeedFilterButtonState();
}

/** 지금 걸린 필터를 사람이 읽는 문구로. 없으면 빈 배열 */
function activeFeedFilterLabels() {
    const yn = (v) => (v === 'yes' ? '예' : '아니오');
    const out = [];
    if (feedFilters.shared !== 'all') out.push(`공유 ${yn(feedFilters.shared)}`);
    if (feedFilters.hasPhotos !== 'all') out.push(`사진 ${yn(feedFilters.hasPhotos)}`);
    if (feedFilters.banned !== 'all') out.push(`금지 ${yn(feedFilters.banned)}`);
    if (feedAuthorFilter?.userId) {
        out.push(`작성자 ${feedAuthorFilter.nickname?.trim() || feedAuthorFilter.userId}`);
    }
    return out;
}

const FEED_FILTER_BTN_BASE =
    'inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold border transition-colors';
const FEED_FILTER_BTN_OFF = `${FEED_FILTER_BTN_BASE} bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200`;
const FEED_FILTER_BTN_ON = `${FEED_FILTER_BTN_BASE} bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700 shadow-sm`;

/**
 * 필터가 팝업 안으로 들어가면 「지금 걸려 있나」가 화면에서 사라진다.
 * 버튼 색과 라벨이 그 자리를 대신한다 — 색만으로는 못 읽는 경우가 있어 개수도 같이 적는다.
 */
function updateFeedFilterButtonState() {
    const labels = activeFeedFilterLabels();
    const n = labels.length;
    const btn = document.getElementById('feedFilterOpenBtn');
    const label = document.getElementById('feedFilterOpenBtnLabel');
    const summary = document.getElementById('feedFilterModalSummary');
    if (label) label.textContent = n === 0 ? '필터' : `필터 ${n}`;
    if (btn) {
        btn.className = n === 0 ? FEED_FILTER_BTN_OFF : FEED_FILTER_BTN_ON;
        btn.title = n === 0 ? '필터가 적용되지 않았습니다' : `적용 중: ${labels.join(' · ')}`;
    }
    if (summary) summary.textContent = n === 0 ? '적용된 필터가 없습니다' : labels.join(' · ');
}

window.openFeedFilterModal = function () {
    const m = document.getElementById('feedFilterModal');
    if (!m) return;
    ensureFeedAuthorSearchHandlers();
    updateFeedFilterToggleColors();
    syncFeedAuthorSearchInput();
    m.classList.remove('hidden');
    m.setAttribute('aria-hidden', 'false');
    if (!m.dataset.dismissBound) {
        m.dataset.dismissBound = '1';
        // 배경(모달 바깥)을 눌렀을 때만 닫는다
        m.addEventListener('click', (e) => {
            if (e.target === m) window.closeFeedFilterModal();
        });
    }
};

window.closeFeedFilterModal = function () {
    const m = document.getElementById('feedFilterModal');
    if (!m) return;
    m.classList.add('hidden');
    m.setAttribute('aria-hidden', 'true');
};

const FEED_BULK_BTN_OFF = `${FEED_FILTER_BTN_BASE} bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200`;
const FEED_BULK_BTN_ON = `${FEED_FILTER_BTN_BASE} bg-slate-800 text-white border-slate-800 hover:bg-slate-900 shadow-sm`;
let feedBulkSelectionWatchBound = false;

/** 지금 체크된 행 수 */
function feedBulkSelectedCount() {
    return document.querySelectorAll('.feed-item-checkbox:checked').length;
}

/**
 * 일괄 작업도 팝업으로 접혔으니, 「몇 건 골랐나」를 버튼이 대신 말해야 한다.
 * 선택이 없으면 팝업 안 작업 버튼을 잠근다 — 눌러보고 alert 로 되돌려보내는 것보다 낫다.
 */
function updateFeedBulkButtonState() {
    const n = feedBulkSelectedCount();
    const btn = document.getElementById('feedBulkOpenBtn');
    const label = document.getElementById('feedBulkOpenBtnLabel');
    const summary = document.getElementById('feedBulkModalSummary');
    const hint = document.getElementById('feedBulkEmptyHint');
    if (label) label.textContent = n === 0 ? '일괄 작업' : `일괄 작업 ${n}`;
    if (btn) {
        btn.className = n === 0 ? FEED_BULK_BTN_OFF : FEED_BULK_BTN_ON;
        btn.title = n === 0 ? '선택된 항목이 없습니다' : `${n}건 선택됨`;
    }
    if (summary) summary.textContent = n === 0 ? '선택된 항목이 없습니다' : `${n}건 선택됨`;
    if (hint) hint.classList.toggle('hidden', n > 0);
    document.querySelectorAll('.feed-bulk-action').forEach((el) => {
        if (el instanceof HTMLButtonElement) el.disabled = n === 0;
    });
}

/** 체크박스는 목록을 그릴 때마다 새로 만들어지므로 문서 한 곳에서 위임으로 듣는다 */
function ensureFeedBulkSelectionWatch() {
    if (feedBulkSelectionWatchBound) return;
    feedBulkSelectionWatchBound = true;
    document.addEventListener('change', (e) => {
        const t = e.target;
        if (t instanceof HTMLElement && t.classList.contains('feed-item-checkbox')) {
            updateFeedBulkButtonState();
        }
    });
}

window.openFeedBulkModal = function () {
    const m = document.getElementById('feedBulkModal');
    if (!m) return;
    updateFeedBulkButtonState();
    m.classList.remove('hidden');
    m.setAttribute('aria-hidden', 'false');
    if (!m.dataset.dismissBound) {
        m.dataset.dismissBound = '1';
        m.addEventListener('click', (e) => {
            if (e.target === m) window.closeFeedBulkModal();
        });
    }
};

window.closeFeedBulkModal = function () {
    const m = document.getElementById('feedBulkModal');
    if (!m) return;
    m.classList.add('hidden');
    m.setAttribute('aria-hidden', 'true');
};

/**
 * 작업이 실제로 돌면 목록이 다시 그려지며 선택이 풀린다. 그걸 신호로 팝업을 닫는다 —
 * 확인 창에서 취소했다면 선택이 남아 있으므로 팝업도 그대로 둔다.
 */
window.runFeedBulkAction = async function (action) {
    const fns = {
        unshare: window.bulkUnsharePosts,
        ban: window.bulkBanPosts,
        unban: window.bulkUnbanPosts,
        delete: window.bulkDeleteFeedPosts
    };
    const fn = fns[action];
    if (typeof fn !== 'function') return;
    await fn();
    updateFeedBulkButtonState();
    if (feedBulkSelectedCount() === 0) window.closeFeedBulkModal();
};

window.resetFeedFilters = async function () {
    feedFilters.shared = 'all';
    feedFilters.hasPhotos = 'all';
    feedFilters.banned = 'all';
    updateFeedFilterToggleColors();
    feedCurrentPage = 1;
    if (feedAuthorFilter) {
        // 작성자 해제가 목록까지 다시 그린다 — 여기서 또 그리면 같은 조회를 두 번 한다
        await window.clearFeedAuthorFilter();
        updateFeedFilterButtonState();
        return;
    }
    updateFeedFilterButtonState();
    if (!adminFeedMonitoringLoaded) return;
    await renderFeedManagement();
};

/** 합산 건수가 있으면 전체 페이지 수, 없으면 현재까지 로드된 범위 기준 */
function computeFeedAdminTotalPages() {
    if (feedMealTotalCountKnown) {
        return Math.max(1, Math.ceil((feedTotalCount || 0) / feedPageSize));
    }
    return Math.max(1, feedCurrentPage + (feedLastPageHasMore ? 1 : 0));
}

// 피드 페이지네이션 렌더링 (1,2,3… + 이전/다음 — 클릭 시 해당 페이지 조회)
function renderFeedPagination(totalPages) {
    const paginationContainer = document.getElementById('feedPagination');
    if (!paginationContainer) return;
    if (totalPages <= 0) {
        paginationContainer.innerHTML = '';
        return;
    }
    const start = (feedCurrentPage - 1) * feedPageSize + 1;
    const end = feedMealTotalCountKnown
        ? Math.min(feedCurrentPage * feedPageSize, feedTotalCount)
        : start + Math.max(0, feedLastPageRowCount - 1);
    const rangeLabel = feedMealTotalCountKnown
        ? `${start}-${end} / ${feedTotalCount}개`
        : `${start}-${end} (전체 수 미집계)`;
    let html = `<span class="text-sm text-slate-500 mr-2">${rangeLabel}</span>`;
    if (feedCurrentPage > 1) {
        html += `<button onclick="window.feedGoToPage(${feedCurrentPage - 1})" class="px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg text-sm font-bold hover:bg-slate-200 transition-colors">이전</button>`;
    }
    const maxButtons = 9;
    let from = Math.max(1, feedCurrentPage - Math.floor(maxButtons / 2));
    let to = Math.min(totalPages, from + maxButtons - 1);
    if (to - from + 1 < maxButtons) from = Math.max(1, to - maxButtons + 1);
    for (let i = from; i <= to; i++) {
        if (i === feedCurrentPage) {
            html += `<span class="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm font-bold mx-0.5">${i}</span>`;
        } else {
            html += `<button onclick="window.feedGoToPage(${i})" class="px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg text-sm font-bold hover:bg-slate-200 transition-colors mx-0.5">${i}</button>`;
        }
    }
    if (feedCurrentPage < totalPages) {
        html += `<button onclick="window.feedGoToPage(${feedCurrentPage + 1})" class="px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg text-sm font-bold hover:bg-slate-200 transition-colors">다음</button>`;
    }
    paginationContainer.innerHTML = html;
}

window.setFeedAuthorFilter = async function (userId, nickname) {
    const uid = String(userId || '').trim();
    if (!uid) return;
    feedAuthorFilter = { userId: uid, nickname: String(nickname || '').trim() || '익명' };
    feedCurrentPage = 1;
    feedQueryCache.clear();
    if (!adminFeedMonitoringLoaded) {
        updateFeedAuthorFilterBar();
        return;
    }
    await renderFeedManagement();
};

window.clearFeedAuthorFilter = async function () {
    if (!feedAuthorFilter) {
        syncFeedAuthorSearchInput();
        return;
    }
    feedAuthorFilter = null;
    feedCurrentPage = 1;
    feedQueryCache.clear();
    updateFeedAuthorFilterBar();
    if (!adminFeedMonitoringLoaded) return;
    await renderFeedManagement();
};

// 피드 필터 토글
window.toggleFeedFilter = function(filterType) {
    const currentValue = feedFilters[filterType];
    const toggleBtn = document.getElementById(`feed-filter-${filterType}-toggle`);
    
    if (currentValue === 'all') {
        feedFilters[filterType] = 'yes';
        if (toggleBtn) {
            toggleBtn.textContent = '예';
            toggleBtn.className = 'feed-filter-toggle px-4 py-2 bg-emerald-100 text-emerald-700 rounded-lg text-xs font-bold transition-colors';
        }
    } else if (currentValue === 'yes') {
        feedFilters[filterType] = 'no';
        if (toggleBtn) {
            toggleBtn.textContent = '아니오';
            toggleBtn.className = 'feed-filter-toggle px-4 py-2 bg-red-100 text-red-700 rounded-lg text-xs font-bold transition-colors';
        }
    } else {
        feedFilters[filterType] = 'all';
        if (toggleBtn) {
            toggleBtn.textContent = '전체';
            toggleBtn.className = 'feed-filter-toggle px-4 py-2 bg-blue-100 text-blue-700 rounded-lg text-xs font-bold transition-colors';
        }
    }
    
    updateFeedFilterButtonState();
    if (!adminFeedMonitoringLoaded) return;
    feedCurrentPage = 1;
    renderFeedManagement();
}

// 피드 페이지 이동 (캡처+식사 병합 목록 — 페이지 번호로 직접 조회)
window.feedGoToPage = async function (page) {
    if (!adminFeedMonitoringLoaded) return;
    if (page < 1) return;
    const totalPages = computeFeedAdminTotalPages();
    feedCurrentPage = Math.min(page, totalPages);
    await renderFeedManagement();
};

// 피드 관리 새로고침
window.refreshFeedManagement = async function () {
    await runAdminRefreshAction(document.getElementById('adminRefreshFeedBtn'), async () => {
        adminFeedMonitoringLoaded = false;
        invalidateAdminFeedMonitoringCache();
        feedCurrentPage = 1;
        feedLastDocsByPage = {};
        feedTotalCount = 0;
        mealsAdminMealsQueryMode = MEALS_FEED_SORT_MODE_RECORDED_AT;
        await renderFeedManagement();
    });
};

/** 하루기록 meals 미러 백필 — 조회 경로와 분리된 수동 액션 (콘솔·스크립트용) */
window.adminBackfillDailyJournalMealMirrors = async function (options = {}) {
    /**
     * 서버에 맡긴다. 규칙상 `users/{uid}/meals` 는 **본인만** 쓸 수 있어서, 관리자 화면에서
     * 남의 미러를 만들려 하면 늘 permission-denied 였다. admin SDK 는 규칙을 우회한다.
     *
     * `{ dryRun: true }` 로 먼저 대상 건수만 세어 볼 수 있다.
     */
    const fn = httpsCallable(functions, 'adminBackfillDailyJournalMirrors');
    const res = await fn({ dryRun: options?.dryRun === true, maxWrites: options?.maxWrites });
    console.log('[관리자 모먼트] 하루기록 미러 백필 결과:', res?.data);
    return res?.data;
};

// 신고 상세 팝업 (사유별 건수)
window.showReportDetailPopup = function(targetGroupKey) {
    const byReason = (window._feedReportDetails && window._feedReportDetails[targetGroupKey]) || {};
    const entries = Object.entries(byReason);
    if (entries.length === 0) return;
    
    const existing = document.getElementById('reportDetailModal');
    if (existing) existing.remove();
    
    const overlay = document.createElement('div');
    overlay.id = 'reportDetailModal';
    overlay.className = 'fixed inset-0 z-[var(--z-admin-modal)] flex items-center justify-center p-4';
    
    const bg = document.createElement('div');
    bg.className = 'absolute inset-0 bg-black/50';
    bg.onclick = () => overlay.remove();
    
    const getReasonLabel = (key) => {
        if (String(key).startsWith('기타:')) return key;
        return (REPORT_REASONS.find(r => r.id === key) || {}).label || key;
    };
    
    const listHtml = entries.map(([reason, count]) => `<div class="flex justify-between py-2 border-b border-slate-100 last:border-0"><span class="text-slate-700">${escapeHtml(getReasonLabel(reason))}</span><span class="font-bold text-slate-800">${count}건</span></div>`).join('');
    const total = entries.reduce((s, [, c]) => s + c, 0);
    
    const panel = document.createElement('div');
    panel.className = 'relative w-full max-w-sm bg-white rounded-2xl p-6 shadow-xl';
    panel.innerHTML = `
        <h3 class="text-lg font-bold text-slate-800 mb-4">🚩 신고 사유</h3>
        <p class="text-sm text-slate-600 mb-4">총 <strong>${total}</strong>건의 신고</p>
        <div class="max-h-64 overflow-y-auto">${listHtml}</div>
        <button type="button" class="mt-4 w-full py-3 rounded-xl font-bold text-slate-600 bg-slate-100 hover:bg-slate-200">닫기</button>
    `;
    panel.querySelector('button').onclick = () => overlay.remove();
    
    overlay.appendChild(bg);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
};

// 일괄 공유 취소
window.bulkUnsharePosts = async function() {
    const checkedBoxes = document.querySelectorAll('.feed-item-checkbox:checked');
    if (checkedBoxes.length === 0) {
        alert('선택된 게시물이 없습니다.');
        return;
    }
    
    if (!confirm(`${checkedBoxes.length}개의 게시물 공유를 취소하시겠습니까?`)) return;
    
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    
    try {
        const batch = writeBatch(db);
        let count = 0;
        let sharedPhotosDeleteCount = 0;
        
        for (const checkbox of checkedBoxes) {
            const mealId = checkbox.dataset.mealId;
            const userId = checkbox.dataset.userId;
            const isBest = checkbox.dataset.isBest === 'true';
            const isDaily = checkbox.dataset.isDaily === 'true';
            const isInsight = checkbox.dataset.isInsight === 'true';
            
            if (!mealId || !userId) continue;
            
            try {
                // 베스트 공유 게시물인 경우
                if (isBest) {
                    // sharedPhotos 컬렉션에서 해당 문서 직접 삭제
                    try {
                        const sharedDocRef = doc(db, 'artifacts', appId, 'sharedPhotos', mealId);
                        batch.delete(sharedDocRef);
                        sharedPhotosDeleteCount++;
                        count++;
                    } catch (e) {
                        console.error(`베스트 공유 게시물 ${mealId} 삭제 실패:`, e);
                    }
                    continue;
                }
                
                // 일간보기 공유 게시물인 경우
                if (isDaily) {
                    // sharedPhotos 컬렉션에서 해당 문서 직접 삭제
                    try {
                        const sharedDocRef = doc(db, 'artifacts', appId, 'sharedPhotos', mealId);
                        batch.delete(sharedDocRef);
                        sharedPhotosDeleteCount++;
                        count++;
                    } catch (e) {
                        console.error(`일간보기 공유 게시물 ${mealId} 삭제 실패:`, e);
                    }
                    continue;
                }
                
                // 인사이트 공유 게시물인 경우
                if (isInsight) {
                    // sharedPhotos 컬렉션에서 해당 문서 직접 삭제
                    try {
                        const sharedDocRef = doc(db, 'artifacts', appId, 'sharedPhotos', mealId);
                        batch.delete(sharedDocRef);
                        sharedPhotosDeleteCount++;
                        count++;
                    } catch (e) {
                        console.error(`인사이트 공유 게시물 ${mealId} 삭제 실패:`, e);
                    }
                    continue;
                }
                
                // 일반 게시물 처리
                // meal 문서 가져오기
                const mealDocRef = doc(db, 'artifacts', appId, 'users', userId, 'meals', mealId);
                const mealSnap = await getDoc(mealDocRef);
                
                if (mealSnap.exists()) {
                    // meal 문서의 sharedPhotos 필드 빈 배열로 업데이트
                    batch.update(mealDocRef, { sharedPhotos: [] });
                    count++;
                    
                    // sharedPhotos 컬렉션에서 해당 entryId의 모든 문서 삭제
                    try {
                        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
                        const sharedQuery = query(
                            sharedColl,
                            where('userId', '==', userId),
                            where('entryId', '==', mealId)
                        );
                        const sharedSnapshot = await getDocs(sharedQuery);
                        
                        sharedSnapshot.forEach(docSnap => {
                            const sharedDocRef = doc(db, 'artifacts', appId, 'sharedPhotos', docSnap.id);
                            batch.delete(sharedDocRef);
                            sharedPhotosDeleteCount++;
                        });
                    } catch (e) {
                        console.error(`게시물 ${mealId}의 sharedPhotos 삭제 실패:`, e);
                        // 에러가 발생해도 계속 진행
                    }
                }
            } catch (e) {
                console.error(`게시물 ${mealId} 공유 취소 실패:`, e);
                // 에러가 발생해도 계속 진행
            }
        }
        
        // 배치 커밋 (meal 문서 업데이트 + sharedPhotos 컬렉션 삭제 모두 포함)
        await batch.commit();
        
        invalidateAdminFeedMonitoringCache();
        alert(`${count}개의 게시물 공유가 취소되었습니다. (${sharedPhotosDeleteCount}개의 공유 사진 삭제)`);
        await renderFeedManagement();
    } catch (e) {
        console.error("일괄 공유 취소 실패:", e);
        alert("일괄 공유 취소 중 오류가 발생했습니다: " + e.message);
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
}

// 일괄 공유 금지
window.bulkBanPosts = async function() {
    const checkedBoxes = document.querySelectorAll('.feed-item-checkbox:checked');
    if (checkedBoxes.length === 0) {
        alert('선택된 게시물이 없습니다.');
        return;
    }
    
    if (!confirm(`${checkedBoxes.length}개의 게시물을 공유 금지하시겠습니까? 공유된 게시물은 공유 컬렉션에서도 삭제됩니다.`)) return;
    
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    
    try {
        const batch = writeBatch(db);
        let count = 0;
        let sharedPhotosDeleteCount = 0;
        
        for (const checkbox of checkedBoxes) {
            const mealId = checkbox.dataset.mealId;
            const userId = checkbox.dataset.userId;
            const isBest = checkbox.dataset.isBest === 'true';
            const isDaily = checkbox.dataset.isDaily === 'true';
            const isInsight = checkbox.dataset.isInsight === 'true';
            
            if (!mealId || !userId) continue;
            
            try {
                // 베스트 공유 또는 일간보기 공유 또는 인사이트 공유는 sharedPhotos 컬렉션에서만 삭제
                if (isBest || isDaily || isInsight) {
                    try {
                        const sharedDocRef = doc(db, 'artifacts', appId, 'sharedPhotos', mealId);
                        batch.delete(sharedDocRef);
                        sharedPhotosDeleteCount++;
                        count++;
                    } catch (e) {
                        const typeName = isBest ? '베스트' : isDaily ? '일간보기' : '인사이트';
                        console.error(`${typeName} 공유 게시물 ${mealId} 삭제 실패:`, e);
                    }
                    continue;
                }
                
                // 일반 게시물 처리
                // meal 문서 가져오기
                const mealDocRef = doc(db, 'artifacts', appId, 'users', userId, 'meals', mealId);
                const mealSnap = await getDoc(mealDocRef);
                
                if (mealSnap.exists()) {
                    // meal 문서에 shareBanned: true 설정 및 sharedPhotos 필드 빈 배열로 업데이트
                    batch.update(mealDocRef, { shareBanned: true, sharedPhotos: [] });
                    count++;
                    
                    // sharedPhotos 컬렉션에서 해당 entryId의 모든 문서 삭제
                    try {
                        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
                        const sharedQuery = query(
                            sharedColl,
                            where('userId', '==', userId),
                            where('entryId', '==', mealId)
                        );
                        const sharedSnapshot = await getDocs(sharedQuery);
                        
                        sharedSnapshot.forEach(docSnap => {
                            const sharedDocRef = doc(db, 'artifacts', appId, 'sharedPhotos', docSnap.id);
                            batch.delete(sharedDocRef);
                            sharedPhotosDeleteCount++;
                        });
                    } catch (e) {
                        console.error(`게시물 ${mealId}의 sharedPhotos 삭제 실패:`, e);
                        // 에러가 발생해도 계속 진행
                    }
                }
            } catch (e) {
                console.error(`게시물 ${mealId} 공유 금지 실패:`, e);
                // 에러가 발생해도 계속 진행
            }
        }
        
        // 배치 커밋 (meal 문서 업데이트 + sharedPhotos 컬렉션 삭제 모두 포함)
        await batch.commit();
        
        invalidateAdminFeedMonitoringCache();
        alert(`${count}개의 게시물이 공유 금지되었습니다. (공유 컬렉션에서 ${sharedPhotosDeleteCount}개 삭제)`);
        renderFeedManagement();
    } catch (e) {
        console.error("일괄 공유 금지 실패:", e);
        alert("일괄 공유 금지 중 오류가 발생했습니다.");
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
}

// 공유 사진 동기화 (meal.sharedPhotos 배열을 sharedPhotos 컬렉션에 추가)
// 자동 동기화 함수 (confirm/alert 없이 조용히 처리)
async function autoSyncSharedPhotos(mealId, userId) {
    try {
        // meal 문서 가져오기
        const mealDoc = doc(db, 'artifacts', appId, 'users', userId, 'meals', mealId);
        const mealSnap = await getDoc(mealDoc);
        
        if (!mealSnap.exists()) {
            console.warn(`자동 동기화: 게시물을 찾을 수 없습니다 (${mealId})`);
            return;
        }
        
        const mealData = mealSnap.data();
        const sharedPhotos = mealData.sharedPhotos;
        
        if (!sharedPhotos || !Array.isArray(sharedPhotos) || sharedPhotos.length === 0) {
            return;
        }
        
        // 사용자 정보 가져오기
        let userNickname = '익명';
        let userIcon = '🐻';
        try {
            const settingsDoc = doc(db, 'artifacts', appId, 'users', userId, 'config', 'settings');
            const settingsSnap = await getDoc(settingsDoc);
            if (settingsSnap.exists()) {
                const settings = settingsSnap.data();
                userNickname = settings.profile?.nickname || '익명';
                userIcon = settings.profile?.icon || '🐻';
            }
        } catch (e) {
            console.warn('사용자 정보 조회 실패:', e);
        }
        
        // sharedPhotos 컬렉션에 같은 entryId의 기존 문서 모두 삭제 후 새로 추가 (중복 방지)
        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
        const batch = writeBatch(db);
        
        // 같은 entryId의 기존 문서 모두 삭제
        try {
            const existingQuery = query(
                sharedColl,
                where('userId', '==', userId),
                where('entryId', '==', mealId)
            );
            const existingSnapshot = await getDocs(existingQuery);
            existingSnapshot.docs.forEach(docSnap => {
                batch.delete(docSnap.ref);
            });
            if (existingSnapshot.docs.length > 0) {
                console.log(`자동 동기화: 기존 ${existingSnapshot.docs.length}개 문서 삭제 (entryId: ${mealId})`);
            }
        } catch (e) {
            console.warn('기존 문서 삭제 중 오류 (무시하고 계속 진행):', e);
        }
        
        // meal의 date+time으로 timestamp 생성 (공유 시점 반영, 최신이 위로 오도록)
        const mealDate = String(mealData.date || '').trim();
        let mealTime = String(mealData.time || '12:00:00').trim();
        if (mealTime && mealTime.split(':').length === 2) mealTime += ':00';
        let mealTimestamp = Timestamp.now();
        if (mealDate && mealDate.length >= 10) {
            try {
                const d = new Date(mealDate + 'T' + (mealTime || '12:00:00'));
                if (!isNaN(d.getTime())) mealTimestamp = Timestamp.fromDate(d);
            } catch (_) {}
        }

        // 새로운 사진들을 추가
        sharedPhotos.forEach(photoUrl => {
            const docRef = doc(sharedColl);
            batch.set(docRef, {
                photoUrl,
                userId: userId,
                userNickname: userNickname,
                userIcon: userIcon,
                mealType: mealData.mealType || '',
                place: mealData.place || '',
                menuDetail: mealData.menuDetail || '',
                snackType: mealData.snackType || '',
                date: mealData.date || '',
                slotId: mealData.slotId || '',
                time: mealData.time || new Date().toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }),
                timestamp: mealTimestamp,
                entryId: mealId
            });
        });
        
        await batch.commit();
        console.log(`✅ 자동 동기화 완료: ${mealId} (${sharedPhotos.length}개 사진 추가)`);
        return true;
    } catch (e) {
        console.error(`자동 동기화 오류 (${mealId}):`, e);
        return false;
    }
}

window.syncSharedPhotos = async function(mealId, userId) {
    if (!confirm('이 게시물의 공유 상태를 동기화하시겠습니까?')) return;
    
    try {
        // meal 문서 가져오기
        const mealDoc = doc(db, 'artifacts', appId, 'users', userId, 'meals', mealId);
        const mealSnap = await getDoc(mealDoc);
        
        if (!mealSnap.exists()) {
            alert('게시물을 찾을 수 없습니다.');
            return;
        }
        
        const mealData = mealSnap.data();
        const sharedPhotos = mealData.sharedPhotos;
        
        if (!sharedPhotos || !Array.isArray(sharedPhotos) || sharedPhotos.length === 0) {
            alert('공유할 사진이 없습니다.');
            return;
        }
        
        // 사용자 정보 가져오기
        let userNickname = '익명';
        let userIcon = '🐻';
        try {
            const settingsDoc = doc(db, 'artifacts', appId, 'users', userId, 'config', 'settings');
            const settingsSnap = await getDoc(settingsDoc);
            if (settingsSnap.exists()) {
                const settings = settingsSnap.data();
                userNickname = settings.profile?.nickname || '익명';
                userIcon = settings.profile?.icon || '🐻';
            }
        } catch (e) {
            console.warn('사용자 정보 조회 실패:', e);
        }
        
        // sharedPhotos 컬렉션에 이미 존재하는지 확인
        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
        const existingQuery = query(
            sharedColl,
            where('userId', '==', userId),
            where('entryId', '==', mealId)
        );
        const existingSnapshot = await getDocs(existingQuery);
        const existingUrls = new Set();
        existingSnapshot.docs.forEach(doc => {
            const data = doc.data();
            const urlBase = (data.photoUrl || '').split('?')[0];
            existingUrls.add(urlBase);
        });
        
        // 중복이 아닌 사진만 필터링
        const newPhotos = sharedPhotos.filter(photoUrl => {
            const urlBase = (photoUrl || '').split('?')[0];
            return !existingUrls.has(urlBase);
        });
        
        if (newPhotos.length === 0) {
            alert('이미 모든 사진이 공유되어 있습니다.');
            return;
        }
        
        // meal의 date+time으로 timestamp 생성 (공유 시점 반영)
        const mealDate = String(mealData.date || '').trim();
        let mealTime = String(mealData.time || '12:00:00').trim();
        if (mealTime && mealTime.split(':').length === 2) mealTime += ':00';
        let mealTimestamp = Timestamp.now();
        if (mealDate && mealDate.length >= 10) {
            try {
                const d = new Date(mealDate + 'T' + (mealTime || '12:00:00'));
                if (!isNaN(d.getTime())) mealTimestamp = Timestamp.fromDate(d);
            } catch (_) {}
        }

        // sharedPhotos 컬렉션에 추가
        const batch = writeBatch(db);
        newPhotos.forEach(photoUrl => {
            const docRef = doc(sharedColl);
            batch.set(docRef, {
                photoUrl,
                userId: userId,
                userNickname: userNickname,
                userIcon: userIcon,
                mealType: mealData.mealType || '',
                place: mealData.place || '',
                menuDetail: mealData.menuDetail || '',
                snackType: mealData.snackType || '',
                date: mealData.date || '',
                slotId: mealData.slotId || '',
                time: mealData.time || new Date().toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }),
                timestamp: mealTimestamp,
                entryId: mealId
            });
        });
        
        await batch.commit();
        invalidateAdminFeedMonitoringCache();
        alert(`${newPhotos.length}개의 사진이 공유 컬렉션에 추가되었습니다.`);
        renderFeedManagement();
    } catch (e) {
        console.error("공유 사진 동기화 실패:", e);
        alert("동기화 중 오류가 발생했습니다: " + e.message);
    }
};

// 특정 게시물의 중복 문서 확인 및 정리
window.checkAndCleanDuplicates = async function(mealId) {
    try {
        // 모든 사용자에서 해당 entryId를 찾기
        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
        const sharedQuery = query(
            sharedColl,
            where('entryId', '==', mealId)
        );
        const sharedSnapshot = await getDocs(sharedQuery);
        
        if (sharedSnapshot.empty) {
            alert(`게시물 ${mealId}에 대한 공유 문서를 찾을 수 없습니다.`);
            return;
        }
        
        const docs = sharedSnapshot.docs;
        console.log(`📋 게시물 ${mealId}: 총 ${docs.length}개의 문서 발견`);
        
        // photoUrl 기반으로 중복 확인
        const urlMap = new Map(); // urlBase -> [docIds]
        docs.forEach(docSnap => {
            const data = docSnap.data();
            const urlBase = (data.photoUrl || '').split('?')[0];
            if (!urlMap.has(urlBase)) {
                urlMap.set(urlBase, []);
            }
            urlMap.get(urlBase).push({
                docId: docSnap.id,
                timestamp: data.timestamp || '',
                photoUrl: data.photoUrl || ''
            });
        });
        
        // 중복 발견
        const duplicates = [];
        urlMap.forEach((docInfos, urlBase) => {
            if (docInfos.length > 1) {
                // 같은 photoUrl이 여러 개인 경우
                duplicates.push({
                    urlBase,
                    count: docInfos.length,
                    docs: docInfos
                });
            }
        });
        
        if (duplicates.length === 0) {
            alert(`게시물 ${mealId}: 중복 문서가 없습니다. (총 ${docs.length}개 문서)`);
            return;
        }
        
        // 중복 정보 표시
        let message = `게시물 ${mealId}에서 중복 문서를 발견했습니다:\n\n`;
        duplicates.forEach((dup, idx) => {
            message += `${idx + 1}. 같은 사진이 ${dup.count}개 문서에 존재\n`;
        });
        message += `\n총 ${duplicates.length}개의 중복 사진\n`;
        message += `중복 문서를 정리하시겠습니까? (가장 오래된 문서만 남기고 나머지 삭제)`;
        
        if (!confirm(message)) return;
        
        // 중복 문서 정리: 각 photoUrl에 대해 가장 오래된 문서만 남기고 나머지 삭제
        const batch = writeBatch(db);
        let deleteCount = 0;
        
        duplicates.forEach(dup => {
            // timestamp 기준으로 정렬 (오래된 것 먼저)
            const sorted = dup.docs.sort((a, b) => {
                const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
                const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
                return timeA - timeB;
            });
            
            // 첫 번째(가장 오래된) 문서는 유지하고, 나머지는 삭제
            for (let i = 1; i < sorted.length; i++) {
                const docRef = doc(sharedColl, sorted[i].docId);
                batch.delete(docRef);
                deleteCount++;
            }
        });
        
        if (deleteCount > 0) {
            await batch.commit();
            invalidateAdminFeedMonitoringCache();
            alert(`중복 문서 ${deleteCount}개가 삭제되었습니다.`);
            renderFeedManagement();
        } else {
            alert('삭제할 문서가 없습니다.');
        }
    } catch (e) {
        console.error("중복 문서 확인/정리 실패:", e);
        alert("중복 문서 확인/정리 중 오류가 발생했습니다: " + e.message);
    }
};

// 일괄 금지 해제
window.bulkUnbanPosts = async function() {
    const checkedBoxes = document.querySelectorAll('.feed-item-checkbox:checked');
    if (checkedBoxes.length === 0) {
        alert('선택된 게시물이 없습니다.');
        return;
    }
    
    if (!confirm(`${checkedBoxes.length}개의 게시물 공유 금지를 해제하시겠습니까?`)) return;
    
    const batch = writeBatch(db);
    let count = 0;
    
    for (const checkbox of checkedBoxes) {
        const mealId = checkbox.dataset.mealId;
        const userId = checkbox.dataset.userId;
        
        try {
            const mealDoc = doc(db, 'artifacts', appId, 'users', userId, 'meals', mealId);
            await batch.update(mealDoc, { shareBanned: false });
            count++;
        } catch (e) {
            console.error(`게시물 ${mealId} 금지 해제 실패:`, e);
        }
    }
    
    try {
        await batch.commit();
        invalidateAdminFeedMonitoringCache();
        alert(`${count}개의 게시물 공유 금지가 해제되었습니다.`);
        renderFeedManagement();
    } catch (e) {
        console.error("일괄 금지 해제 실패:", e);
        alert("일괄 금지 해제 중 오류가 발생했습니다.");
    }
};

/** 행의 삭제 버튼(data-*) 기준 단일 삭제 */
window.adminDeleteSingleFeedPost = async function (btn) {
    if (!(btn instanceof HTMLElement)) return;
    const mealId = btn.dataset.mealId;
    const userId = btn.dataset.userId;
    const isBest = btn.dataset.isBest === 'true';
    const isDaily = btn.dataset.isDaily === 'true';
    const isInsight = btn.dataset.isInsight === 'true';
    if (!mealId || !userId) {
        alert('식별 정보가 없습니다.');
        return;
    }
    const onlyShared = isBest || isDaily || isInsight;
    const msg = onlyShared
        ? '이 모먼트(베스트·일간·인사이트) 전용 공유 문서를 삭제합니다. 복구할 수 없습니다. 진행할까요?'
        : '이 기록의 사용자 meals 문서와 모먼트 공유 문서를 삭제합니다. 사용자 타임라인에서도 사라집니다. 복구할 수 없습니다. 진행할까요?';
    if (!confirm(msg)) return;
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    try {
        await adminDeleteFeedPostInternal({ mealId, userId, isBest, isDaily, isInsight });
        invalidateAdminFeedMonitoringCache();
        await renderFeedManagement();
    } catch (e) {
        console.error('모먼트 삭제 실패:', e);
        alert('삭제 중 오류가 발생했습니다: ' + (e?.message || e));
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
};

/** 체크된 행 일괄 삭제 */
window.bulkDeleteFeedPosts = async function () {
    const checkedBoxes = document.querySelectorAll('.feed-item-checkbox:checked');
    if (checkedBoxes.length === 0) {
        alert('선택된 게시물이 없습니다.');
        return;
    }
    if (
        !confirm(
            `선택한 ${checkedBoxes.length}건을 삭제합니다.\n\n일반 기록: 사용자 meals 문서와 모먼트 공유 문서가 삭제됩니다.\n베스트·일간·인사이트: 모먼트 전용 공유 문서만 삭제됩니다.\n모두 복구할 수 없습니다. 계속하시겠습니까?`
        )
    ) {
        return;
    }
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    let ok = 0;
    let fail = 0;
    try {
        for (const checkbox of checkedBoxes) {
            const mealId = checkbox.dataset.mealId;
            const userId = checkbox.dataset.userId;
            const isBest = checkbox.dataset.isBest === 'true';
            const isDaily = checkbox.dataset.isDaily === 'true';
            const isInsight = checkbox.dataset.isInsight === 'true';
            if (!mealId || !userId) continue;
            try {
                await adminDeleteFeedPostInternal({ mealId, userId, isBest, isDaily, isInsight });
                ok++;
            } catch (e) {
                console.error(`삭제 실패 (${mealId}):`, e);
                fail++;
            }
        }
        invalidateAdminFeedMonitoringCache();
        await renderFeedManagement();
        alert(`삭제 완료: ${ok}건${fail ? `, 실패: ${fail}건` : ''}`);
    } catch (e) {
        console.error('일괄 삭제 실패:', e);
        alert('일괄 삭제 중 오류가 발생했습니다: ' + (e?.message || e));
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
};

/* ───────────────────────── 모먼트 엑셀 내보내기 ───────────────────────── */

/** 모먼트 기록 시각(날짜/시간)을 KST 기준 문자열로 반환 (export용) */
function momentExportDateTimeParts(meal) {
    const kst = { timeZone: 'Asia/Seoul' };
    const toParts = (d) => {
        if (!d || !Number.isFinite(d.getTime())) return null;
        return {
            date: d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', ...kst }).replace(/\s+/g, ''),
            time: d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, ...kst })
        };
    };
    const fromRaw = (raw) => {
        if (raw == null) return null;
        if (raw && typeof raw.toDate === 'function') return toParts(raw.toDate());
        if (raw instanceof Date) return toParts(raw);
        if (typeof raw === 'string') return toParts(new Date(raw));
        if (typeof raw === 'object' && typeof raw.seconds === 'number') {
            return toParts(new Date(raw.seconds * 1000 + (raw.nanoseconds || 0) / 1e6));
        }
        return null;
    };
    let p = fromRaw(meal?.recordedAt);
    if (p) return p;
    p = fromRaw(meal?.timestamp);
    if (p) return p;
    if (meal?.date) {
        try {
            let t = meal.time || '00:00';
            if (t && String(t).split(':').length === 2) t = `${t}:00`;
            p = toParts(new Date(`${meal.date}T${t}`));
            if (p) return p;
        } catch (_) {}
        return { date: String(meal.date), time: String(meal.time || '') };
    }
    return { date: '', time: '' };
}

/** 하루기록 체중·혈당 지표를 한 줄 텍스트로 (export용) */
function dailyJournalMetricsPlainText(entry) {
    const n = normalizeDailyJournalEntry(entry);
    const parts = [];
    if (n.weightEnabled && n.weightRecords.length > 0) {
        const chain = formatMetricRecordChain(n.weightRecords, { isWeight: true });
        if (chain) parts.push(`체중 ${chain} kg`);
    }
    if (n.bloodSugarEnabled && n.bloodSugarRecords.length > 0) {
        const chain = formatMetricRecordChain(n.bloodSugarRecords);
        if (chain) parts.push(`혈당 ${chain} mg/dL`);
    }
    return parts.join(' / ');
}

const MOMENT_EXPORT_SLOT_LABELS = {
    pre_morning: '아침전', morning: '아침', snack1: '오전간식', snack2: '오후간식', night: '저녁후간식',
    breakfast: '아침', lunch: '점심', dinner: '저녁', snack: '간식',
    before_breakfast: '아침전', after_breakfast: '아침후', before_lunch: '점심전', after_lunch: '점심후',
    before_dinner: '저녁전', after_dinner: '저녁후'
};

/**
 * 현재 필터(공유/사진/금지/작성자) + 선택 기간에 맞는 전체 모먼트 행을 모아 export용 평면 객체 배열로 반환
 * @param {{startMs?: number, endMs?: number}} [range] 기록 시각 기준 포함 범위(미지정 시 전체 기간)
 */
async function collectMomentRowsForExport(range = {}) {
    const startMs = Number.isFinite(range.startMs) ? range.startMs : null;
    const endMs = Number.isFinite(range.endMs) ? range.endMs : null;
    // getFeedPage 가 page===1 에서 갱신하는 전역값을 보존했다가 복원 (현재 화면 페이지네이션 보호)
    const snapshot = {
        feedTotalCount,
        feedMealTotalCountKnown,
        feedLastPageRowCount,
        feedLastPageHasMore,
        mealsAdminMealsQueryMode
    };

    let allRows;
    try {
        const res = await getFeedPage({ page: 1, pageSize: 100000 });
        allRows = Array.isArray(res?.items) ? res.items : [];
    } finally {
        feedTotalCount = snapshot.feedTotalCount;
        feedMealTotalCountKnown = snapshot.feedMealTotalCountKnown;
        feedLastPageRowCount = snapshot.feedLastPageRowCount;
        feedLastPageHasMore = snapshot.feedLastPageHasMore;
        mealsAdminMealsQueryMode = snapshot.mealsAdminMealsQueryMode;
    }

    await ensureSharedKeysForFeedRows(allRows);
    const collapsedRows = collapseDailyJournalDuplicateRows(allRows);

    const authorUid = getFeedAuthorUserId();
    const filtered = collapsedRows.filter((meal) => {
        if (authorUid && meal.userId !== authorUid) return false;
        if (startMs !== null || endMs !== null) {
            const t = moderationRecordedAtMillis(meal);
            if (Number.isFinite(t)) {
                if (startMs !== null && t < startMs) return false;
                if (endMs !== null && t > endMs) return false;
            }
        }
        const isDailyJournalRow = meal.isDailyJournal === true;
        const isCapture = !!(meal.isDailyShare || meal.isBestShare || meal.isInsightShare);
        const isActuallyShared =
            isCapture || !!(feedSharedKeysCache && feedSharedKeysCache.has(`${meal.userId}_${meal.id}`));
        const isDjMomentShared = isDailyJournalRow && isDailyJournalMomentSharedRow(meal);
        if (isDailyJournalRow) {
            if (feedFilters.shared === 'yes' && !isDjMomentShared) return false;
            if (feedFilters.shared === 'no' && isDjMomentShared) return false;
        } else {
            if (feedFilters.shared === 'yes' && !isActuallyShared) return false;
            if (feedFilters.shared === 'no' && isActuallyShared) return false;
            const isBanned = meal.shareBanned === true;
            if (feedFilters.banned === 'yes' && !isBanned) return false;
            if (feedFilters.banned === 'no' && isBanned) return false;
        }
        const hasPhotos =
            (Array.isArray(meal.photos) && meal.photos.length > 0) ||
            Boolean(meal.photoUrl && String(meal.photoUrl).trim());
        if (feedFilters.hasPhotos === 'yes' && !hasPhotos) return false;
        if (feedFilters.hasPhotos === 'no' && hasPhotos) return false;
        return true;
    });

    filtered.sort(compareModerationRowsDesc);

    // 작성자 닉네임·이메일 조회
    const userInfoMap = new Map();
    const userIds = [...new Set(filtered.map((m) => m.userId).filter(Boolean))];
    const [emailMap] = await Promise.all([
        fetchAdminEmailsForUserIds(userIds),
        Promise.all(
            userIds.map(async (uid) => {
                const now = Date.now();
                const hit = feedUserSettingsCache.get(uid);
                if (hit && now - hit.ts < ADMIN_FEED_CACHE_TTL_MS) {
                    userInfoMap.set(uid, { nickname: hit.nickname, icon: hit.icon, email: '' });
                    return;
                }
                try {
                    const settingsSnap = await getDoc(doc(db, 'artifacts', appId, 'users', uid, 'config', 'settings'));
                    if (settingsSnap.exists()) {
                        const s = settingsSnap.data();
                        const row = { nickname: s.profile?.nickname || '익명', icon: s.profile?.icon || '🐻', email: '' };
                        feedUserSettingsCache.set(uid, { ts: now, nickname: row.nickname, icon: row.icon });
                        userInfoMap.set(uid, row);
                    }
                } catch (e) {
                    console.warn('[모먼트 내보내기] 사용자 정보 조회 실패:', uid, e);
                }
            })
        )
    ]);
    userIds.forEach((uid) => {
        if (!userInfoMap.has(uid)) userInfoMap.set(uid, { nickname: '익명', icon: '🐻', email: '' });
        userInfoMap.get(uid).email = emailMap.get(uid) || '';
    });

    const reportsMap = await getReportsAggregateCached();
    const total = filtered.length;

    return filtered.map((meal, idx) => {
        const isDailyJournal = meal.isDailyJournal === true;
        const isCapture = !!(meal.isDailyShare || meal.isBestShare || meal.isInsightShare);
        const targetGroupKey = isDailyJournal
            ? `dailyJournal_${meal.date || ''}_${meal.userId}`
            : meal.isBestShare
                ? `best_${meal.id}`
                : meal.isDailyShare
                    ? `daily_${meal.date || ''}_${meal.userId}`
                    : meal.isInsightShare
                        ? `insight_${meal.dateRangeText || ''}_${meal.userId}`
                        : `entry_${meal.id}_${meal.userId}`;
        const reportInfo = reportsMap[targetGroupKey];
        const reportCount = reportInfo && reportInfo.count > 0 ? reportInfo.count : 0;

        const baseAuthor = userInfoMap.get(meal.userId) || { nickname: '익명', icon: '🐻', email: '' };
        const nickname =
            (meal.isBestShare || meal.isDailyShare || meal.isInsightShare) && meal.userNickname
                ? meal.userNickname
                : baseAuthor.nickname;

        const isShared = isDailyJournal
            ? isDailyJournalMomentSharedRow(meal)
            : isCapture || !!(feedSharedKeysCache && feedSharedKeysCache.has(`${meal.userId}_${meal.id}`));
        const isBanned = meal.shareBanned === true;

        const typeLabel = isDailyJournal
            ? meal.momentShared && meal.isDailyJournalSlot !== true
                ? '하루기록·모먼트'
                : meal.momentShared
                    ? '하루기록·슬롯+모먼트'
                    : '하루기록·슬롯'
            : meal.isBestShare
                ? '주간 Best'
                : meal.isDailyShare
                    ? '일간 캡처'
                    : meal.isInsightShare
                        ? '밀당의 참견'
                        : '일반';

        const noTags = isCapture || isDailyJournal;
        const whereTag = noTags ? '' : meal.snackPlaceMain || meal.place || meal.snackPlace || '';
        const whereSubTag = noTags ? '' : meal.placeDetail || meal.placeMemo || '';
        const howTag = noTags ? '' : meal.mealType || '';
        const whatTag = noTags ? '' : meal.category || meal.categoryAuto || meal.snackType || '';
        const whatSubTag = noTags ? '' : meal.menuDetail || meal.snackDetail || '';
        const withTag = noTags ? '' : meal.withWhom || '';
        const withSubTag = noTags ? '' : meal.withWhomDetail || '';
        const ratingVal = noTags ? '' : meal.snackRating ?? meal.rating ?? '';
        const satietyVal = noTags ? '' : meal.satiety ?? '';

        const dt = momentExportDateTimeParts(meal);
        const slotLabel =
            typeof meal.slotDisplayLabel === 'string'
                ? meal.slotDisplayLabel
                : MOMENT_EXPORT_SLOT_LABELS[String(meal.slotId || '').toLowerCase()] || '';

        const photoUrls = Array.isArray(meal.photos) && meal.photos.length > 0
            ? meal.photos.filter(Boolean)
            : (meal.photoUrl && String(meal.photoUrl).trim() ? [meal.photoUrl] : []);

        const metricsText = isDailyJournal ? dailyJournalMetricsPlainText(meal.dailyJournalEntry) : '';

        return {
            번호: total - idx,
            유형: typeLabel,
            날짜: dt.date,
            시간: dt.time,
            식사구분: slotLabel,
            어떻게: howTag,
            어디서: whereTag,
            어디서_상세: whereSubTag,
            무엇을: whatTag,
            무엇을_상세: whatSubTag,
            누구와: withTag,
            누구와_상세: withSubTag,
            만족도: ratingVal === null ? '' : ratingVal,
            포만감: satietyVal === null ? '' : satietyVal,
            코멘트: meal.comment ? String(meal.comment) : '',
            하루기록지표: metricsText,
            공유여부: isShared ? 'Y' : 'N',
            금지여부: isBanned ? 'Y' : 'N',
            신고수: reportCount,
            사진수: photoUrls.length,
            작성자: nickname,
            이메일: baseAuthor.email || '',
            작성자UID: meal.userId || '',
            게시물ID: meal.id || ''
        };
    });
}

/** CSV(UTF-8 BOM) 문자열 생성 — SheetJS 로드 실패 시 폴백 */
function momentRowsToCsv(rows) {
    if (!rows.length) return '';
    const headers = Object.keys(rows[0]);
    const esc = (v) => {
        const s = v == null ? '' : String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(','));
    return '\uFEFF' + lines.join('\r\n');
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** KST 기준 오늘 날짜 'YYYY-MM-DD' */
function kstTodayYmd() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

/** 'YYYY-MM-DD' → KST 하루 시작/끝 millis */
function ymdToKstMillis(ymd, endOfDay = false) {
    if (!ymd) return null;
    const iso = endOfDay ? `${ymd}T23:59:59.999+09:00` : `${ymd}T00:00:00.000+09:00`;
    const ms = new Date(iso).getTime();
    return Number.isFinite(ms) ? ms : null;
}

/**
 * 내보내기 기간 선택 팝업 — 전체 기간 / 기간 선택
 * @returns {Promise<{startMs: number|null, endMs: number|null, label: string} | null>} 취소 시 null
 */
function openMomentExportRangePopup() {
    return new Promise((resolve) => {
        const existing = document.getElementById('momentExportRangeModal');
        if (existing) existing.remove();

        const today = kstTodayYmd();
        const ago = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

        const overlay = document.createElement('div');
        overlay.id = 'momentExportRangeModal';
        overlay.className = 'fixed inset-0 z-[var(--z-admin-over)] flex items-center justify-center p-4';

        const bg = document.createElement('div');
        bg.className = 'absolute inset-0 bg-black/50';

        const panel = document.createElement('div');
        panel.className = 'relative w-full max-w-md bg-white rounded-2xl p-6 shadow-xl';
        panel.innerHTML = `
            <h3 class="text-lg font-bold text-slate-800 mb-1"><i data-lucide="sheet" class="text-emerald-600 mr-2"></i>모먼트 엑셀 내보내기</h3>
            <p class="text-sm text-slate-500 mb-4">내보낼 기간을 선택하세요. (현재 필터 조건이 함께 적용됩니다)</p>
            <div class="space-y-2 mb-4">
                <label class="flex items-center gap-3 p-3 rounded-xl border border-slate-200 cursor-pointer hover:bg-slate-50">
                    <input type="radio" name="momentExportRangeMode" value="all" checked class="accent-emerald-600">
                    <span class="text-sm font-bold text-slate-700">전체 기간</span>
                </label>
                <label class="flex items-center gap-3 p-3 rounded-xl border border-slate-200 cursor-pointer hover:bg-slate-50">
                    <input type="radio" name="momentExportRangeMode" value="range" class="accent-emerald-600">
                    <span class="text-sm font-bold text-slate-700">기간 선택</span>
                </label>
            </div>
            <div id="momentExportRangeInputs" class="grid grid-cols-2 gap-3 mb-5 opacity-50 pointer-events-none">
                <div>
                    <label class="block text-xs font-bold text-slate-500 mb-1">시작일</label>
                    <input type="date" id="momentExportStartDate" value="${ago}" max="${today}" class="w-full p-2 border border-slate-200 rounded-lg text-sm">
                </div>
                <div>
                    <label class="block text-xs font-bold text-slate-500 mb-1">종료일</label>
                    <input type="date" id="momentExportEndDate" value="${today}" max="${today}" class="w-full p-2 border border-slate-200 rounded-lg text-sm">
                </div>
            </div>
            <div class="flex gap-2">
                <button type="button" id="momentExportCancelBtn" class="flex-1 py-3 rounded-xl font-bold text-slate-600 bg-slate-100 hover:bg-slate-200">취소</button>
                <button type="button" id="momentExportConfirmBtn" class="flex-1 py-3 rounded-xl font-bold text-white bg-emerald-600 hover:bg-emerald-700">내보내기</button>
            </div>
        `;

        overlay.appendChild(bg);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        const inputsWrap = panel.querySelector('#momentExportRangeInputs');
        const startInput = panel.querySelector('#momentExportStartDate');
        const endInput = panel.querySelector('#momentExportEndDate');
        const radios = panel.querySelectorAll('input[name="momentExportRangeMode"]');

        const syncInputs = () => {
            const mode = panel.querySelector('input[name="momentExportRangeMode"]:checked')?.value;
            const enabled = mode === 'range';
            inputsWrap.classList.toggle('opacity-50', !enabled);
            inputsWrap.classList.toggle('pointer-events-none', !enabled);
        };
        radios.forEach((r) => r.addEventListener('change', syncInputs));

        let settled = false;
        const close = (result) => {
            if (settled) return;
            settled = true;
            overlay.remove();
            resolve(result);
        };

        bg.addEventListener('click', () => close(null));
        panel.querySelector('#momentExportCancelBtn').addEventListener('click', () => close(null));
        panel.querySelector('#momentExportConfirmBtn').addEventListener('click', () => {
            const mode = panel.querySelector('input[name="momentExportRangeMode"]:checked')?.value;
            if (mode !== 'range') {
                close({ startMs: null, endMs: null, label: '전체기간' });
                return;
            }
            const startYmd = startInput.value;
            const endYmd = endInput.value;
            if (!startYmd || !endYmd) {
                alert('시작일과 종료일을 모두 선택하세요.');
                return;
            }
            if (startYmd > endYmd) {
                alert('시작일이 종료일보다 늦을 수 없습니다.');
                return;
            }
            close({
                startMs: ymdToKstMillis(startYmd, false),
                endMs: ymdToKstMillis(endYmd, true),
                label: `${startYmd.replace(/-/g, '')}-${endYmd.replace(/-/g, '')}`
            });
        });
    });
}

window.exportMomentsToExcel = async function () {
    const choice = await openMomentExportRangePopup();
    if (!choice) return;

    const btn = document.getElementById('adminExportMomentsBtn');
    const orig = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader-circle" class="mr-1 lucide-spin" aria-hidden="true"></i>수집 중...';
    }
    try {
        const rows = await collectMomentRowsForExport({ startMs: choice.startMs, endMs: choice.endMs });
        if (!rows.length) {
            alert('내보낼 모먼트 데이터가 없습니다. (기간·필터 조건을 확인하세요)');
            return;
        }
        const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(/[:\s-]/g, '').slice(0, 12);
        const fileBase = `mealog-moments-${choice.label}-${stamp}`;
        let usedCsv = false;
        try {
            const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
            const ws = XLSX.utils.json_to_sheet(rows);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, '모먼트');
            XLSX.writeFile(wb, `${fileBase}.xlsx`);
        } catch (xlsxErr) {
            console.warn('[모먼트 내보내기] SheetJS 로드 실패 → CSV로 폴백합니다.', xlsxErr);
            usedCsv = true;
            const csv = momentRowsToCsv(rows);
            downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${fileBase}.csv`);
        }
        alert(`모먼트 ${rows.length}건을 ${usedCsv ? 'CSV' : '엑셀(.xlsx)'} 파일로 내보냈습니다.`);
    } catch (e) {
        console.error('[모먼트 내보내기] 실패:', e);
        alert('모먼트 내보내기 중 오류가 발생했습니다: ' + (e?.message || e));
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = orig;
        }
    }
};

let adminFeedPhotoViewerState = { urls: [], index: 0 };

function ensureAdminFeedPhotoViewerModal() {
    let el = document.getElementById('adminFeedPhotoViewerModal');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'adminFeedPhotoViewerModal';
    el.className = 'fixed inset-0 z-[var(--z-loading-overlay)] hidden';
    el.innerHTML = `
        <div class="admin-feed-photo-viewer-backdrop absolute inset-0 bg-black/80" data-close="1"></div>
        <div class="absolute inset-0 flex flex-col items-center justify-center p-4 pointer-events-none">
            <div class="pointer-events-auto max-w-full max-h-full flex flex-col items-center gap-2">
                <div class="flex items-center justify-end w-full max-w-[min(96vw,1200px)] px-1 min-h-[2rem]">
                    <button type="button" id="adminFeedPhotoViewerClose" class="px-3 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white">닫기</button>
                </div>
                <div class="relative flex items-center justify-center max-h-[85vh] max-w-[96vw]">
                    <button type="button" id="adminFeedPhotoViewerPrev" class="absolute left-0 z-10 p-3 rounded-full bg-black/50 text-white hover:bg-black/70 hidden" aria-label="이전 사진"><i data-lucide="chevron-left"></i></button>
                    <div class="relative inline-block max-w-[96vw] max-h-[85vh]">
                        <img id="adminFeedPhotoViewerImg" src="" alt="" class="max-w-[96vw] max-h-[85vh] w-auto h-auto object-contain rounded-lg shadow-2xl bg-black/20 block">
                        <span id="adminFeedPhotoViewerCounter" class="absolute top-2 right-2 z-20 px-2 py-1 rounded-md bg-black/70 text-white text-xs font-bold leading-none pointer-events-none shadow-sm"></span>
                    </div>
                    <button type="button" id="adminFeedPhotoViewerNext" class="absolute right-0 z-10 p-3 rounded-full bg-black/50 text-white hover:bg-black/70 hidden" aria-label="다음 사진"><i data-lucide="chevron-right"></i></button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(el);
    el.querySelector('.admin-feed-photo-viewer-backdrop')?.addEventListener('click', () => closeAdminFeedPhotoViewer());
    el.querySelector('#adminFeedPhotoViewerClose')?.addEventListener('click', () => closeAdminFeedPhotoViewer());
    el.querySelector('#adminFeedPhotoViewerPrev')?.addEventListener('click', (e) => {
        e.stopPropagation();
        adminFeedPhotoViewerStep(-1);
    });
    el.querySelector('#adminFeedPhotoViewerNext')?.addEventListener('click', (e) => {
        e.stopPropagation();
        adminFeedPhotoViewerStep(1);
    });
    document.addEventListener('keydown', adminFeedPhotoViewerKeydown);
    /**
     * 이 모달은 body 직속이라 admin.js 의 탭 단위 아이콘 갱신 범위 밖이다.
     * 여기서 직접 그리지 않으면 좌우 화살표가 <i data-lucide> 인 채로 남아
     * "넘기는 버튼이 안 보인다"가 된다. scheduleLucideIcons 는 전역 타이머
     * 하나를 공유해 뒤따르는 렌더에 취소될 수 있으므로 동기 호출을 쓴다.
     */
    refreshLucideIcons(el);
    return el;
}

function adminFeedPhotoViewerKeydown(e) {
    const modal = document.getElementById('adminFeedPhotoViewerModal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (e.key === 'Escape') closeAdminFeedPhotoViewer();
    if (e.key === 'ArrowLeft') adminFeedPhotoViewerStep(-1);
    if (e.key === 'ArrowRight') adminFeedPhotoViewerStep(1);
}

function closeAdminFeedPhotoViewer() {
    const el = document.getElementById('adminFeedPhotoViewerModal');
    if (el) el.classList.add('hidden');
}

function adminFeedPhotoViewerStep(delta) {
    const s = adminFeedPhotoViewerState;
    if (!s.urls.length) return;
    s.index = (s.index + delta + s.urls.length) % s.urls.length;
    updateAdminFeedPhotoViewer();
}

function updateAdminFeedPhotoViewer() {
    const img = document.getElementById('adminFeedPhotoViewerImg');
    const counter = document.getElementById('adminFeedPhotoViewerCounter');
    const prev = document.getElementById('adminFeedPhotoViewerPrev');
    const next = document.getElementById('adminFeedPhotoViewerNext');
    const s = adminFeedPhotoViewerState;
    if (!img || !s.urls.length) return;
    img.src = s.urls[s.index];
    const n = s.urls.length;
    if (counter) {
        if (n > 1) {
            counter.textContent = `${s.index + 1}/${n}`;
            counter.classList.remove('hidden');
        } else {
            counter.textContent = '';
            counter.classList.add('hidden');
        }
    }
    const showNav = n > 1;
    if (prev) prev.classList.toggle('hidden', !showNav);
    if (next) next.classList.toggle('hidden', !showNav);
}

window.openAdminFeedPhotoViewer = function (urls, startIndex = 0) {
    if (!urls || !Array.isArray(urls) || urls.length === 0) return;
    const list = urls.map((u) => String(u || '').trim()).filter(Boolean);
    if (!list.length) return;
    adminFeedPhotoViewerState = {
        urls: list,
        index: Math.max(0, Math.min(Number(startIndex) || 0, list.length - 1)),
    };
    const modal = ensureAdminFeedPhotoViewerModal();
    modal.classList.remove('hidden');
    updateAdminFeedPhotoViewer();
};

/** 모니터링에서 '모먼트' 탭으로 들어올 때: 폴백(2·3)으로 내려가 있었으면 recordedAt(1) 복구를 한 번 시도 */
export function refreshAdminMealsFeedSortMode() {
    if (mealsAdminMealsQueryMode !== MEALS_FEED_SORT_MODE_RECORDED_AT) {
        mealsAdminMealsQueryMode = MEALS_FEED_SORT_MODE_RECORDED_AT;
        feedLastDocsByPage = {};
        feedCurrentPage = 1;
    }
}

window.ensureFeedAuthorSearchHandlers = ensureFeedAuthorSearchHandlers;

if (typeof document !== 'undefined') {
    const bootFeedAuthorSearch = () => {
        ensureFeedAuthorSearchHandlers();
        syncFeedAuthorSearchInput();
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootFeedAuthorSearch, { once: true });
    } else {
        bootFeedAuthorSearch();
    }
}

export { renderFeedManagement };
