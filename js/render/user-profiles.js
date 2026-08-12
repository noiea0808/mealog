/**
 * Firestore에서 다른 사용자 프로필 설정 로드 (갤러리·게시판 등 공용)
 */
/** 프로필 캐시 수명 — 지나면 다음 렌더에서 다시 읽어 상대의 닉네임 변경을 반영 */
const PROFILE_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * userId → 마지막 조회 성공 시각(ms).
 * 프로필이 없는 사용자(탈퇴·설정 삭제)도 기록해 매 렌더마다 재조회하지 않게 한다.
 */
const profileFetchedAt = new Map();

/**
 * settings 조회 — 문서 없음과 조회 실패(네트워크 등)를 구분한다.
 * @returns {Promise<{ ok: boolean, data: object|null }>} ok=false 면 조회 자체가 실패한 것 (캐시에 기록하면 안 됨)
 */
async function readUserSettings(userId) {
    try {
        const { db, appId } = await import('../firebase.js');
        const { doc, getDoc } = await import("https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js");
        const settingsDoc = doc(db, 'artifacts', appId, 'users', userId, 'config', 'settings');
        const settingsSnap = await getDoc(settingsDoc);
        return { ok: true, data: settingsSnap.exists() ? settingsSnap.data() : null };
    } catch (e) {
        console.warn('사용자 설정 가져오기 실패:', e);
        return { ok: false, data: null };
    }
}

// 사용자 설정 가져오기 헬퍼 함수
export async function getUserSettings(userId) {
    return (await readUserSettings(userId)).data;
}

/** 다른 사용자들의 최신 프로필을 Firestore에서 가져와 userProfileCache에 저장 (다른 사용자가 볼 때 최신 프로필 표시용) */
export async function fetchUserProfiles(userIds) {
    if (!userIds || userIds.length === 0) return;
    const currentUid = window.currentUser?.uid;
    const toFetch = [...new Set(userIds)].filter(id => id && id !== currentUid);
    if (toFetch.length === 0) return;
    if (!window.userProfileCache) window.userProfileCache = new Map();
    const now = Date.now();
    const stale = toFetch.filter((id) => {
        const at = profileFetchedAt.get(id);
        return at == null || now - at >= PROFILE_CACHE_TTL_MS;
    });
    if (stale.length === 0) return;
    const results = await Promise.all(stale.map(async (userId) => {
        const { ok, data } = await readUserSettings(userId);
        const p = data?.profile;
        return {
            userId,
            ok,
            profile: p ? { nickname: p.nickname || '익명', icon: p.icon ?? null, photoUrl: p.photoUrl || null } : null
        };
    }));
    results.forEach(({ userId, ok, profile }) => {
        /* 조회 실패는 캐시하지 않는다 — 다음 렌더에서 재시도 */
        if (!ok) return;
        profileFetchedAt.set(userId, Date.now());
        if (profile) window.userProfileCache.set(userId, profile);
        /* 탈퇴·설정 삭제: 캐시를 비워 문서에 저장된 작성 시점 닉네임으로 폴백시킨다 */
        else window.userProfileCache.delete(userId);
    });
}
