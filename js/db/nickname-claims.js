/**
 * 닉네임 중복 방지용 인덱스 (artifacts/{appId}/nicknameClaims/{claimId})
 * — isNicknameDuplicate: 1회 읽기, saveSettings에서 트랜잭션으로 동기화
 */

/**
 * @param {string} nickname
 * @returns {string|null} 소문자·trim 기준 정규화, 비어 있거나 게스트면 null
 */
export function normalizeNicknameForClaim(nickname) {
    if (!nickname || typeof nickname !== 'string') return null;
    const t = nickname.trim();
    if (!t || t === '게스트') return null;
    try {
        return t.normalize('NFKC').toLowerCase();
    } catch {
        return t.toLowerCase();
    }
}

/**
 * Firestore 문서 ID (정규화된 닉네임 1:1, 최대 길이 제한)
 * @param {string} normalized - normalizeNicknameForClaim 결과
 */
export function nicknameClaimDocId(normalized) {
    if (!normalized) return '';
    const clipped = normalized.length > 200 ? normalized.slice(0, 200) : normalized;
    return encodeURIComponent(clipped);
}
