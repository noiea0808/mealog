/**
 * Firestore에서 다른 사용자 프로필 설정 로드 (갤러리·게시판 등 공용)
 */
// 사용자 설정 가져오기 헬퍼 함수
export async function getUserSettings(userId) {
    try {
        const { db, appId } = await import('../firebase.js');
        const { doc, getDoc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
        const settingsDoc = doc(db, 'artifacts', appId, 'users', userId, 'config', 'settings');
        const settingsSnap = await getDoc(settingsDoc);
        if (settingsSnap.exists()) {
            return settingsSnap.data();
        }
    } catch (e) {
        console.warn('사용자 설정 가져오기 실패:', e);
    }
    return null;
}

/** 다른 사용자들의 최신 프로필을 Firestore에서 가져와 userProfileCache에 저장 (다른 사용자가 볼 때 최신 프로필 표시용) */
export async function fetchUserProfiles(userIds) {
    if (!userIds || userIds.length === 0) return;
    const currentUid = window.currentUser?.uid;
    const toFetch = [...new Set(userIds)].filter(id => id && id !== currentUid);
    if (toFetch.length === 0) return;
    if (!window.userProfileCache) window.userProfileCache = new Map();
    const uncached = toFetch.filter(id => !window.userProfileCache.has(id));
    if (uncached.length === 0) return;
    try {
        const results = await Promise.all(uncached.map(async (userId) => {
            const settings = await getUserSettings(userId);
            const p = settings?.profile;
            return { userId, profile: p ? { nickname: p.nickname || '익명', icon: p.icon ?? null, photoUrl: p.photoUrl || null } : null };
        }));
        results.forEach(({ userId, profile }) => {
            if (profile) window.userProfileCache.set(userId, profile);
        });
    } catch (e) {
        console.warn('프로필 일괄 로드 실패:', e);
    }
}
