/**
 * 웰컴·요약 UI용 — 사용자의 가장 최신 ready AI 식단분석 리포트 조회
 */
import { db, appId } from '../firebase.js';
import {
    collection,
    getDocs,
    limit,
    orderBy,
    query,
    where
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { toLocalDateString } from '../utils.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
/** @type {{ uid: string, date: string, data: object|null, at: number, promise: Promise<{ date: string, data: object }|null>|null }} */
const _cache = { uid: '', date: '', data: null, at: 0, promise: null };
/** @type {{ uid: string, dates: string[], at: number, promise: Promise<string[]>|null }} */
const _datesCache = { uid: '', dates: [], at: 0, promise: null };

function reportDocId(uid, dateStr) {
    return `${uid}_${dateStr}`;
}

/** 인덱스 미배포 시 폴백 — 최근 N일 getDoc (날짜 내림차순) */
async function fetchReadyDietReportDatesByScan(uid, maxDays = 45) {
    const dates = [];
    for (let i = 1; i <= maxDays; i++) {
        const d = new Date();
        d.setHours(12, 0, 0, 0);
        d.setDate(d.getDate() - i);
        const dateStr = toLocalDateString(d);
        try {
            const snap = await getDoc(
                doc(db, 'artifacts', appId, 'aiDietReports', reportDocId(uid, dateStr))
            );
            if (snap.exists() && snap.data()?.status === 'ready') {
                dates.push(dateStr);
            }
        } catch (_) {
            /* ignore single-day read */
        }
    }
    return dates;
}

/** 인덱스 미배포 시 폴백 — 최근 45일 getDoc */
async function fetchLatestReadyDietReportByScan(uid) {
    const maxDays = 45;
    for (let i = 1; i <= maxDays; i++) {
        const d = new Date();
        d.setHours(12, 0, 0, 0);
        d.setDate(d.getDate() - i);
        const dateStr = toLocalDateString(d);
        try {
            const snap = await getDoc(
                doc(db, 'artifacts', appId, 'aiDietReports', reportDocId(uid, dateStr))
            );
            if (snap.exists() && snap.data()?.status === 'ready') {
                return { date: dateStr, data: snap.data() };
            }
        } catch (_) {
            /* ignore single-day read */
        }
    }
    return null;
}

async function fetchLatestReadyDietReportInner(uid) {
    if (!uid) return null;
    try {
        const coll = collection(db, 'artifacts', appId, 'aiDietReports');
        const q = query(
            coll,
            where('userId', '==', uid),
            where('status', '==', 'ready'),
            orderBy('date', 'desc'),
            limit(1)
        );
        const snap = await getDocs(q);
        if (!snap.empty) {
            const docSnap = snap.docs[0];
            const data = docSnap.data();
            const date = data?.date || '';
            if (date) return { date, data };
        }
    } catch (e) {
        const code = e?.code || '';
        if (code === 'failed-precondition' || /index/i.test(String(e?.message || ''))) {
            return fetchLatestReadyDietReportByScan(uid);
        }
        console.warn('fetchLatestReadyDietReport query failed', e);
        return fetchLatestReadyDietReportByScan(uid);
    }
    return null;
}

async function fetchReadyDietReportDatesInner(uid, max = 45) {
    if (!uid) return [];
    try {
        const coll = collection(db, 'artifacts', appId, 'aiDietReports');
        const q = query(
            coll,
            where('userId', '==', uid),
            where('status', '==', 'ready'),
            orderBy('date', 'desc'),
            limit(max)
        );
        const snap = await getDocs(q);
        const dates = [];
        snap.forEach((docSnap) => {
            const date = docSnap.data()?.date;
            if (date) dates.push(String(date));
        });
        return dates;
    } catch (e) {
        const code = e?.code || '';
        if (code === 'failed-precondition' || /index/i.test(String(e?.message || ''))) {
            return fetchReadyDietReportDatesByScan(uid, max);
        }
        console.warn('fetchReadyDietReportDates query failed', e);
        return fetchReadyDietReportDatesByScan(uid, max);
    }
}

/**
 * ready 리포트 날짜 목록 (최신순)
 * @returns {Promise<string[]>}
 */
export async function fetchReadyDietReportDates(uid, { max = 45, force = false } = {}) {
    if (!uid) return [];
    const now = Date.now();
    if (
        !force &&
        _datesCache.uid === uid &&
        _datesCache.at > 0 &&
        now - _datesCache.at < CACHE_TTL_MS &&
        !_datesCache.promise
    ) {
        return _datesCache.dates.slice();
    }
    if (_datesCache.promise && _datesCache.uid === uid && !force) {
        return _datesCache.promise;
    }

    _datesCache.uid = uid;
    _datesCache.promise = fetchReadyDietReportDatesInner(uid, max)
        .then((dates) => {
            _datesCache.dates = dates;
            _datesCache.at = Date.now();
            _datesCache.promise = null;
            return dates.slice();
        })
        .catch((e) => {
            _datesCache.promise = null;
            throw e;
        });

    return _datesCache.promise;
}

/**
 * @returns {Promise<{ date: string, data: object }|null>}
 */
export async function fetchReadyDietReportByDate(uid, dateStr) {
    if (!uid || !dateStr) return null;
    try {
        const snap = await getDoc(
            doc(db, 'artifacts', appId, 'aiDietReports', reportDocId(uid, dateStr))
        );
        if (!snap.exists()) return null;
        const data = snap.data();
        if (data?.status !== 'ready') return null;
        return { date: dateStr, data };
    } catch (e) {
        console.warn('fetchReadyDietReportByDate failed', e);
        return null;
    }
}

/**
 * @returns {Promise<{ date: string, data: object }|null>}
 */
export async function fetchLatestReadyDietReport(uid, { force = false } = {}) {
    if (!uid) return null;
    const now = Date.now();
    if (
        !force &&
        _cache.uid === uid &&
        _cache.at > 0 &&
        now - _cache.at < CACHE_TTL_MS &&
        !_cache.promise
    ) {
        if (!_cache.date && !_cache.data) return null;
        return _cache.date ? { date: _cache.date, data: _cache.data } : null;
    }
    if (_cache.promise && _cache.uid === uid && !force) {
        return _cache.promise;
    }

    _cache.uid = uid;
    _cache.promise = fetchLatestReadyDietReportInner(uid)
        .then((result) => {
            _cache.date = result?.date || '';
            _cache.data = result?.data || null;
            _cache.at = Date.now();
            _cache.promise = null;
            return result;
        })
        .catch((e) => {
            _cache.promise = null;
            throw e;
        });

    return _cache.promise;
}

export function clearLatestDietReportCache() {
    _cache.uid = '';
    _cache.date = '';
    _cache.data = null;
    _cache.at = 0;
    _cache.promise = null;
    _datesCache.uid = '';
    _datesCache.dates = [];
    _datesCache.at = 0;
    _datesCache.promise = null;
}
