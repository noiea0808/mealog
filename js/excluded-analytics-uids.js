/**
 * 통계·페이지 사용량 로깅 제외 UID — Firestore `adminSettings/excludedAnalyticsUids` 가 원본.
 * 문서가 없으면 집계·표시용으로만 기본 목록(DEFAULT)을 쓰며, 관리자 로그인 시 기본 문서를 시드한다.
 * firestore.rules 의 usageDaily `isExcludedFromUsageWriting` 과 `excludedUidMap` 동기화 유지.
 */
import { db, appId } from './firebase.js';
import { doc, getDoc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

export const EXCLUDED_ANALYTICS_UIDS_DOC_ID = 'excludedAnalyticsUids';

/** 문서 미존재 시 사용하는 기본 제외 UID (운영 초기값) */
export const DEFAULT_EXCLUDED_ANALYTICS_UID_LIST = [
    'kakao_4833862234',
    'IYRL3bfBhKUrwJM6tb8h4BVX8DF3',
    '4UDeI0Bts0gkwnnrt1WNRgjOQ5x2'
];

const ref = () => doc(db, 'artifacts', appId, 'adminSettings', EXCLUDED_ANALYTICS_UIDS_DOC_ID);

function payloadFromUidList(rawList) {
    const clean = [...new Set((rawList || []).filter((u) => typeof u === 'string' && u.trim()).map((u) => u.trim()))].sort();
    const excludedUidMap = {};
    for (const u of clean) excludedUidMap[u] = true;
    return { uids: clean, excludedUidMap, updatedAt: serverTimestamp() };
}

let _listCache = null;
let _listPromise = null;

export function clearExcludedAnalyticsUidCache() {
    _listCache = null;
    _listPromise = null;
}

async function loadListFromFirestore() {
    const snap = await getDoc(ref());
    if (!snap.exists()) return null;
    const uids = snap.data()?.uids;
    if (!Array.isArray(uids)) return null;
    return [...new Set(uids.filter((u) => typeof u === 'string' && u.trim()).map((u) => u.trim()))].sort();
}

/**
 * 제외 UID 목록 (문서 없음 → DEFAULT, 문서 있음 → 저장된 uids; 빈 배열이면 제외 없음)
 */
export async function getExcludedAnalyticsUidList() {
    if (_listCache !== null) return _listCache;
    if (_listPromise) return _listPromise;
    _listPromise = (async () => {
        const fromDb = await loadListFromFirestore();
        const list = fromDb === null ? [...DEFAULT_EXCLUDED_ANALYTICS_UID_LIST] : fromDb;
        _listCache = list;
        _listPromise = null;
        return list;
    })();
    return _listPromise;
}

export async function getExcludedAnalyticsUidSet() {
    const list = await getExcludedAnalyticsUidList();
    return new Set(list);
}

/** 문서가 없을 때만 기본 목록으로 생성 (관리자 세션 진입 시 호출) */
export async function ensureDefaultExcludedAnalyticsDocIfMissing() {
    const snap = await getDoc(ref());
    if (snap.exists()) return;
    await setDoc(ref(), payloadFromUidList(DEFAULT_EXCLUDED_ANALYTICS_UID_LIST), { merge: true });
    clearExcludedAnalyticsUidCache();
}

/** 관리 화면에서 목록 저장 */
export async function saveExcludedAnalyticsUidList(uids) {
    await setDoc(ref(), payloadFromUidList(uids), { merge: true });
    clearExcludedAnalyticsUidCache();
}
