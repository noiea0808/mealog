// 닉네임 검증 관련 유틸리티 함수들
import { db, appId } from '../firebase.js';
import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { normalizeNicknameForClaim, nicknameClaimDocId } from '../db/nickname-claims.js';

// 비속어 필터링 리스트 (기본적인 비속어들)
const PROFANITY_WORDS = [
    '씨발', '시발', '개새끼', '개새', '병신', '미친', '미친놈', '좆', '좃', '젓', '지랄', '지랄놈',
    '개같은', '개같이', '개소리', '개지랄', '개돼지', '개쓰레기', '개새기', '개새끼', '개새퀴',
    '병신', '병신놈', '병신새끼', '병신년', '병신아', '병신들',
    '미친', '미친놈', '미친년', '미친새끼', '미친아', '미친것',
    '좆', '좃', '좆같', '좆나', '좆만', '좆밥', '좆물', '좆새끼',
    '지랄', '지랄놈', '지랄년', '지랄떨', '지랄병',
    '니미', '니미럴', '니미랄', '니미씹', '니미새끼',
    '엿', '엿먹', '엿같', '엿이나',
    '똥', '똥개', '똥새끼', '똥통',
    '쓰레기', '쓰레기같', '쓰레기놈',
    '섹스', '성교', '야동', '야사', '포르노',
    'fuck', 'shit', 'damn', 'bitch', 'asshole', 'bastard', 'cunt', 'pussy', 'dick', 'cock'
];

/**
 * 닉네임에 비속어가 포함되어 있는지 확인
 * @param {string} nickname - 확인할 닉네임
 * @returns {boolean} 비속어가 포함되어 있으면 true
 */
export function containsProfanity(nickname) {
    if (!nickname || typeof nickname !== 'string') return false;
    const lowerNickname = nickname.toLowerCase();
    return PROFANITY_WORDS.some(word => lowerNickname.includes(word.toLowerCase()));
}

/**
 * 닉네임이 중복되는지 확인 (nicknameClaims 인덱스 1회 읽기, NFKC+소문자 기준 중복)
 * 기존 사용자는 설정 저장 시 또는 backfill 스크립트로 인덱스가 채워짐.
 * @param {string} nickname - 확인할 닉네임
 * @param {string} currentUserId - 현재 사용자 ID (자신의 닉네임은 제외)
 * @returns {Promise<boolean>} 중복되면 true
 */
export async function isNicknameDuplicate(nickname, currentUserId = null) {
    if (!nickname || typeof nickname !== 'string') return false;

    try {
        const norm = normalizeNicknameForClaim(nickname);
        if (!norm) return false;

        const claimRef = doc(db, 'artifacts', appId, 'nicknameClaims', nicknameClaimDocId(norm));
        const snap = await getDoc(claimRef);
        if (!snap.exists()) return false;
        const owner = snap.data()?.userId;
        if (!owner) return false;
        if (currentUserId && owner === currentUserId) return false;
        return true;
    } catch (e) {
        console.error('닉네임 중복 체크 실패:', e);
        return false;
    }
}

/**
 * 닉네임 변경 가능 여부 확인 (한 달에 한 번 제한)
 * @param {string} userId - 사용자 ID
 * @returns {Promise<{canChange: boolean, lastChangedDate: Date|null, daysUntilNextChange: number}>}
 */
export async function canChangeNickname(userId) {
    if (!userId) {
        return { canChange: true, lastChangedDate: null, daysUntilNextChange: 0 };
    }
    
    try {
        const settingsRef = doc(db, 'artifacts', appId, 'users', userId, 'config', 'settings');
        const settingsSnap = await getDoc(settingsRef);
        
        if (!settingsSnap.exists()) {
            return { canChange: true, lastChangedDate: null, daysUntilNextChange: 0 };
        }
        
        const settings = settingsSnap.data();
        const lastChanged = settings.nicknameLastChanged;
        
        if (!lastChanged) {
            return { canChange: true, lastChangedDate: null, daysUntilNextChange: 0 };
        }
        
        const lastChangedDate = new Date(lastChanged);
        const now = new Date();
        const daysDiff = Math.floor((now - lastChangedDate) / (1000 * 60 * 60 * 24));
        const daysUntilNextChange = Math.max(0, 30 - daysDiff);
        
        return {
            canChange: daysDiff >= 30,
            lastChangedDate: lastChangedDate,
            daysUntilNextChange: daysUntilNextChange
        };
    } catch (e) {
        console.error('닉네임 변경 가능 여부 확인 실패:', e);
        // 에러 발생 시 변경 가능한 것으로 간주
        return { canChange: true, lastChangedDate: null, daysUntilNextChange: 0 };
    }
}

/**
 * 닉네임 변경 날짜 업데이트
 * @param {string} userId - 사용자 ID
 */
export async function updateNicknameChangeDate(userId) {
    if (!userId) return;
    
    try {
        const settingsRef = doc(db, 'artifacts', appId, 'users', userId, 'config', 'settings');
        await updateDoc(settingsRef, {
            nicknameLastChanged: new Date().toISOString()
        });
    } catch (e) {
        console.error('닉네임 변경 날짜 업데이트 실패:', e);
        // 실패해도 계속 진행 (중요하지 않은 메타데이터)
    }
}
