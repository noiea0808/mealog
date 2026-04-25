// 닉네임 검증 관련 유틸리티 함수들
import { db, appId } from '../firebase.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { normalizeNicknameForClaim, nicknameClaimDocId } from '../db/nickname-claims.js';
import {
    NICK_MOOD,
    NICK_NATURE,
    NICK_CREATURE,
    NICK_FOODISH,
    NICK_LEGACY_PHRASES
} from './nickname-word-pools.js';

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
 * 닉네임이 **다른 사용자가 지금 쓰는 것과** 겹치는지 확인 (nicknameClaims + 소유자 settings 정합성)
 * - 본인 클레임(예: 예전에 쓰던 닉으로 되돌리기)은 중복이 아님
 * - 탈퇴·변경 후 남은 **고아 클레임**(settings 닉과 불일치)은 무시
 * @param {string} nickname - 확인할 닉네임
 * @param {string|null} currentUserId - 현재 사용자 ID (본인 클레임 제외)
 * @returns {Promise<boolean>} 다른 살아 있는 계정이 쓰면 true
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

        const ownerSettingsRef = doc(db, 'artifacts', appId, 'users', owner, 'config', 'settings');
        const ownerSnap = await getDoc(ownerSettingsRef);
        const ownerNorm = normalizeNicknameForClaim(
            ownerSnap.exists() ? ownerSnap.data()?.profile?.nickname : null
        );
        if (ownerNorm !== norm) return false;
        return true;
    } catch (e) {
        console.error('닉네임 중복 체크 실패:', e);
        return false;
    }
}

/**
 * (레거시) 한 달 1회 제한 — 제거됨. 예전 닉네임 재사용·자유 변경을 위해 항상 허용.
 * @returns {Promise<{canChange: boolean, lastChangedDate: null, daysUntilNextChange: number}>}
 */
export async function canChangeNickname(userId) {
    void userId;
    return { canChange: true, lastChangedDate: null, daysUntilNextChange: 0 };
}

/**
 * (레거시) nicknameLastChanged 메타 — 더 이상 설정 저장 시 갱신하지 않음
 */
export async function updateNicknameChangeDate(userId) {
    void userId;
}

function pickNickWord(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function clipNickname(s, maxLen = 20) {
    if (!s || typeof s !== 'string') return '밀당친구';
    const t = s.trim();
    if (t.length <= maxLen) return t;
    return t.slice(0, maxLen);
}

/** 추천 닉 세 단어 조합: 단어 사이 한 칸 띄움 */
function joinNickThree(a, b, c) {
    return `${String(a).trim()} ${String(b).trim()} ${String(c).trim()}`;
}

/** 세 단어 조합 패턴 가중치 합 (무드·자연·생물·음식) */
const TRIPLE_COMBO_WEIGHT_SUM = 25 + 20 + 20 + 20 + 15;

/**
 * 여러 단어 풀을 섞어 20자 이하 닉네임 후보 1개 (비속어 검사 전)
 * — 레거시 긴 문장 약 32% + 세 단어(0+0+0) 약 68%
 */
export function generateRandomNicknameCombo() {
    let base;
    if (Math.random() < 0.32) {
        base = pickNickWord(NICK_LEGACY_PHRASES);
    } else {
        const r = Math.random() * TRIPLE_COMBO_WEIGHT_SUM;
        const m = () => pickNickWord(NICK_MOOD);
        const n = () => pickNickWord(NICK_NATURE);
        const c = () => pickNickWord(NICK_CREATURE);
        const f = () => pickNickWord(NICK_FOODISH);
        if (r < 25) {
            base = joinNickThree(m(), n(), c());
        } else if (r < 45) {
            base = joinNickThree(m(), c(), f());
        } else if (r < 65) {
            base = joinNickThree(n(), c(), f());
        } else if (r < 85) {
            base = joinNickThree(m(), n(), f());
        } else {
            base = joinNickThree(c(), m(), f());
        }
    }
    base = clipNickname(base, 20);
    if (containsProfanity(base)) {
        base = clipNickname(
            joinNickThree(pickNickWord(NICK_MOOD), pickNickWord(NICK_NATURE), pickNickWord(NICK_CREATURE)),
            20
        );
    }
    return base || '밀당친구';
}

/**
 * Firestore nicknameClaims 기준으로 비어 있는 닉네임을 여러 번 시도해 고름.
 * 반환 전 항상 isNicknameDuplicate로 검증된 값만 돌려줌(미검증 폴백 없음).
 * @param {string|null} currentUserId
 * @param {number} maxAttempts
 * @returns {Promise<string>}
 * @throws {Error} code NICKNAME_SUGGEST_EXHAUSTED — 시도 한도 내 사용 가능 조합을 찾지 못함
 */
export async function pickUnusedRandomNickname(currentUserId = null, maxAttempts = 48) {
    for (let i = 0; i < maxAttempts; i++) {
        const candidate = generateRandomNicknameCombo();
        if (containsProfanity(candidate)) continue;
        const dup = await isNicknameDuplicate(candidate, currentUserId);
        if (!dup) return candidate;
    }
    for (let j = 0; j < 60; j++) {
        const suffix = String(Math.floor(Math.random() * 9000) + 1000);
        const base = clipNickname(
            joinNickThree(pickNickWord(NICK_MOOD), pickNickWord(NICK_NATURE), pickNickWord(NICK_CREATURE)),
            12
        );
        const candidate = clipNickname(`${base}${suffix}`, 20);
        if (containsProfanity(candidate)) continue;
        const dup = await isNicknameDuplicate(candidate, currentUserId);
        if (!dup) return candidate;
    }
    const err = new Error('사용 가능한 추천 닉네임을 만들지 못했습니다.');
    err.code = 'NICKNAME_SUGGEST_EXHAUSTED';
    throw err;
}
