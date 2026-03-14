// 약관 버전 유틸리티 함수
// Firestore에서 현재 약관 버전을 가져오는 함수

import { doc, getDoc, collection, query, orderBy, getDocs } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db, appId } from './firebase.js';
import { CURRENT_TERMS_VERSION } from './constants.js';

const DEFAULT_TERMS_TEXT = '본 약관은 MEALOG(이하 "회사")가 제공하는 식사 기록 서비스의 이용과 관련하여 회사와 이용자 간의 권리, 의무 및 책임사항을 규정함을 목적으로 합니다.\n\n제1조 (정의)\n1. "서비스"란 회사가 제공하는 식사 기록 및 관리 서비스를 의미합니다.\n2. "이용자"란 본 약관에 동의하고 회사가 제공하는 서비스를 이용하는 자를 의미합니다.\n\n제2조 (서비스의 제공)\n회사는 다음과 같은 서비스를 제공합니다: 식사 기록, 통계 분석, 사진 공유 등\n\n제3조 (이용자의 의무)\n이용자는 서비스를 이용함에 있어 관련 법령을 준수해야 합니다.';
const DEFAULT_PRIVACY_TEXT = '회사는 다음의 목적을 위하여 개인정보를 처리합니다:\n1. 서비스 제공 및 계약의 이행\n2. 회원 관리 및 본인 확인\n3. 서비스 개선 및 신규 서비스 개발\n\n제1조 (수집하는 개인정보의 항목)\n회사는 다음과 같은 개인정보를 수집합니다:\n1. 필수항목: 이메일, 닉네임, 프로필 아이콘\n2. 선택항목: 위치 정보 (카카오 지도 이용 시)\n\n제2조 (개인정보의 보유 및 이용기간)\n회원 탈퇴 시까지 보유하며, 탈퇴 후 즉시 파기합니다.';

/**
 * 약관/개인정보처리방침 전문을 Firestore에서 가져와 표시용으로 반환합니다.
 * @returns {Promise<{ terms: string, privacy: string }>}
 */
export async function getTermsContentForDisplay() {
    try {
        const termsDoc = doc(db, 'artifacts', appId, 'content', 'terms');
        const termsSnap = await getDoc(termsDoc);
        let terms = DEFAULT_TERMS_TEXT;
        let privacy = DEFAULT_PRIVACY_TEXT;
        if (termsSnap.exists()) {
            const data = termsSnap.data();
            if (data.terms) {
                terms = Array.isArray(data.terms)
                    ? data.terms.map(item => `${item.title || ''}\n${item.content || ''}`).filter(Boolean).join('\n\n')
                    : String(data.terms);
            }
            if (data.privacy) {
                privacy = Array.isArray(data.privacy)
                    ? data.privacy.map(item => `${item.title || ''}\n${item.content || ''}`).filter(Boolean).join('\n\n')
                    : String(data.privacy);
            }
        }
        return { terms, privacy };
    } catch (e) {
        console.warn('약관 전문 로드 실패:', e);
        return { terms: DEFAULT_TERMS_TEXT, privacy: DEFAULT_PRIVACY_TEXT };
    }
}

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
