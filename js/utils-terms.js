// 약관 버전 유틸리티 함수
// Firestore에서 현재 약관 버전을 가져오는 함수

import { doc, getDoc, collection, query, orderBy, getDocs } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db, appId } from './firebase.js';
import { CURRENT_TERMS_VERSION } from './constants.js';

// 약관 버전 캐시 (성능 최적화)
let cachedVersion = null;
let cacheTimestamp = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5분

/**
 * Firestore에서 현재 약관 버전을 가져옵니다.
 * 캐시를 사용하여 성능을 최적화합니다.
 * @returns {Promise<string>} 현재 약관 버전
 */
export async function getCurrentTermsVersion() {
    try {
        // 캐시가 유효한지 확인
        const now = Date.now();
        if (cachedVersion && cacheTimestamp && (now - cacheTimestamp) < CACHE_DURATION) {
            return cachedVersion;
        }
        
        // Firestore에서 현재 버전 가져오기 (타임아웃 2초)
        const termsDoc = doc(db, 'artifacts', appId, 'content', 'terms');
        
        // 타임아웃과 함께 실행
        const getDocWithTimeout = Promise.race([
            getDoc(termsDoc),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 2000))
        ]);
        
        try {
            const termsSnap = await getDocWithTimeout;
            
            if (termsSnap.exists()) {
                const data = termsSnap.data();
                if (data.currentVersion) {
                    cachedVersion = String(data.currentVersion).trim();
                    cacheTimestamp = now;
                    return cachedVersion;
                }
            }
        } catch (e) {
            // 타임아웃이나 권한 오류인 경우 기본값 반환
            if (e.message === 'TIMEOUT' || e.code === 'permission-denied') {
                console.warn('약관 버전 가져오기 실패 (타임아웃/권한), 기본값 사용');
                cachedVersion = CURRENT_TERMS_VERSION;
                cacheTimestamp = now;
                return cachedVersion;
            }
            // 다른 에러는 다시 던짐
            throw e;
        }
        
        // Firestore에 currentVersion이 없으면, versions 컬렉션에서 가장 최신 버전 가져오기 (관리자만 가능)
        // 일반 사용자는 권한이 없을 수 있으므로 에러 처리
        try {
            const versionsColl = collection(db, 'artifacts', appId, 'content', 'terms', 'versions');
            const versionsQuery = query(versionsColl, orderBy('deployedAt', 'desc'));
            const getDocsWithTimeout = Promise.race([
                getDocs(versionsQuery),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 2000))
            ]);
            const versionsSnapshot = await getDocsWithTimeout;
            
            if (!versionsSnapshot.empty) {
                const latestVersion = versionsSnapshot.docs[0].data();
                if (latestVersion.version) {
                    cachedVersion = String(latestVersion.version).trim();
                    cacheTimestamp = now;
                    return cachedVersion;
                }
            }
        } catch (e) {
            // 권한 오류나 타임아웃인 경우 무시하고 기본값 사용
            if (e.code === 'permission-denied' || e.message === 'TIMEOUT') {
                // 조용히 무시 (일반 사용자는 접근 불가능할 수 있음)
            } else {
                console.warn('최신 버전 가져오기 실패:', e);
            }
        }
        
        // Firestore에 없으면 constants.js의 기본값 사용
        cachedVersion = CURRENT_TERMS_VERSION;
        cacheTimestamp = now;
        return cachedVersion;
    } catch (e) {
        console.warn('약관 버전 가져오기 실패:', e);
        // 에러 발생 시 constants.js의 기본값 사용
        cachedVersion = CURRENT_TERMS_VERSION;
        cacheTimestamp = Date.now();
        return cachedVersion;
    }
}

/**
 * 약관 버전 캐시를 무효화합니다.
 * 약관 배포 후 호출하여 새로운 버전을 즉시 반영합니다.
 */
export function invalidateTermsVersionCache() {
    cachedVersion = null;
    cacheTimestamp = null;
}
