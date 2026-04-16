// 닉네임 검증 관련 유틸리티 함수들
import { db, appId } from '../firebase.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
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

/** 회원가입 추천용: 짧은 두 단어 풀 (무드·자연·생물·음식) + 긴 문장 풀 — 생성 비율은 generateRandomNicknameCombo에서 50:50 */
const NICK_MOOD = [
    '햇살', '달빛', '바람', '구름', '별빛', '숲길', '파도', '노을', '이슬', '새벽', '한낮', '황혼',
    '봄날', '여름', '가을', '겨울', '미소', '포근', '산들', '고요', '따스', '시원', '포동', '맑음',
    '은은', '반짝', '나른', '싱그', '포슬', '보송', '촉촉', '뽀송', '산뜻', '포근'
];
const NICK_NATURE = [
    '숲', '언덕', '계곡', '호수', '강', '바다', '하늘', '별', '달', '구름', '무지개', '안개',
    '눈꽃', '벚꽃', '단풍', '솔숲', '들판', '초원', '모래', '절벽', '폭포', '샘물', '동굴', '해변',
    '산책', '여정', '정원', '온실', '논밭', '밭길', '샛길', '지름길', '완만', '고개'
];
const NICK_CREATURE = [
    '곰', '여우', '다람쥐', '부엉이', '고양이', '강아지', '펭귄', '판다', '토끼', '수달', '두더지',
    '너구리', '청설', '고래', '돌고래', '물개', '해달', '문어', '상어', '가오리', '두루미', '황제펭',
    '참새', '까치', '비둘기', '제비', '까마귀', '올빼미', '두꺼비', '개구리', '도마뱀', '거북'
];
const NICK_FOODISH = [
    '떡볶이', '김밥', '라면', '우동', '초밥', '샐러드', '스프', '스튜', '카레', '피자', '파스타',
    '샌드', '토스트', '팬케', '크림', '푸딩', '젤리', '마카롱', '도넛', '머핀', '쿠키', '티라미',
    '에이드', '라떼', '아아', '말차', '허브', '꿀차', '식혜', '수제비', '칼국수', '냉면', '비빔'
];
const NICK_LEGACY_PHRASES = [
    '늑대와 함께 춤을', '독수리가 날개를 펼 때', '바람이 말을 타고', '달이 호수를 비출 때',
    '별이 내려앉는 밤', '산이 노래할 때', '강이 바다를 만날 때', '불꽃이 춤추는 밤',
    '눈이 내리는 숲', '해가 뜨는 평원', '번개가 하늘을 가를 때', '구름이 산을 감싸면',
    '나무가 말을 걸 때', '물이 돌을 닮을 때', '새벽이 잠에서 깨면'
];

function pickNickWord(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function clipNickname(s, maxLen = 20) {
    if (!s || typeof s !== 'string') return '밀당친구';
    const t = s.trim();
    if (t.length <= maxLen) return t;
    return t.slice(0, maxLen);
}

/** 짧은 두 단어(5종) 내부 비율 — 합 95로 정규화 (예전 단일 랜덤에서 레거시 5% 제외한 비율 유지) */
const SHORT_COMBO_WEIGHT_SUM = 28 + 24 + 20 + 16 + 7;

/**
 * 여러 단어 풀을 섞어 20자 이하 닉네임 후보 1개 (비속어 검사 전)
 * 짧은 두 단어 50% + 긴 문장(NICK_LEGACY_PHRASES) 50%
 */
export function generateRandomNicknameCombo() {
    let base;
    if (Math.random() < 0.5) {
        base = pickNickWord(NICK_LEGACY_PHRASES);
    } else {
        const r = Math.random() * SHORT_COMBO_WEIGHT_SUM;
        if (r < 28) {
            base = pickNickWord(NICK_MOOD) + pickNickWord(NICK_CREATURE);
        } else if (r < 28 + 24) {
            base = pickNickWord(NICK_NATURE) + pickNickWord(NICK_CREATURE);
        } else if (r < 28 + 24 + 20) {
            base = pickNickWord(NICK_MOOD) + pickNickWord(NICK_NATURE);
        } else if (r < 28 + 24 + 20 + 16) {
            base = pickNickWord(NICK_MOOD) + pickNickWord(NICK_FOODISH);
        } else {
            base = pickNickWord(NICK_CREATURE) + pickNickWord(NICK_FOODISH);
        }
    }
    base = clipNickname(base, 20);
    if (containsProfanity(base)) {
        base = clipNickname(pickNickWord(NICK_MOOD) + pickNickWord(NICK_CREATURE), 20);
    }
    return base || '밀당친구';
}

/**
 * Firestore nicknameClaims 기준으로 비어 있는 닉네임을 여러 번 시도해 고름
 * @param {string|null} currentUserId
 * @param {number} maxAttempts
 * @returns {Promise<string>}
 */
export async function pickUnusedRandomNickname(currentUserId = null, maxAttempts = 28) {
    for (let i = 0; i < maxAttempts; i++) {
        const candidate = generateRandomNicknameCombo();
        if (containsProfanity(candidate)) continue;
        const dup = await isNicknameDuplicate(candidate, currentUserId);
        if (!dup) return candidate;
    }
    return clipNickname(`밀당${pickNickWord(NICK_MOOD)}${pickNickWord(NICK_NATURE)}`, 20);
}
