/**
 * Firebase Auth displayName(소셜 계정 표시 이름) → Firestore profile.nickname 시드
 * 카카오 등에서 카카오 프로필 닉이 비어 있으면 시드되지 않음(그대로 위저드 유도).
 */
import { auth } from './firebase.js';
import { dbOps } from './db.js';
import { DEFAULT_USER_SETTINGS } from './constants.js';
import { hasValidMealogNickname } from './profile-readiness.js';

const seededUids = new Set();

/**
 * settings 스냅샷이 온 뒤·온보딩 검사 전에 호출.
 * @returns {Promise<boolean>} 저장까지 성공하면 true
 */
export async function maybeSeedNicknameFromAuthDisplayName() {
    const user = auth.currentUser;
    if (!user || user.isAnonymous) return false;
    if (seededUids.has(user.uid)) return false;

    try {
        await user.reload();
    } catch (_) {
        /* ignore */
    }

    let displayName = (user.displayName || '').trim();
    if (!displayName) {
        seededUids.add(user.uid);
        return false;
    }

    if (!window.userSettings) {
        window.userSettings = JSON.parse(JSON.stringify(DEFAULT_USER_SETTINGS));
    }
    if (hasValidMealogNickname(window.userSettings)) {
        seededUids.add(user.uid);
        return false;
    }

    let candidate = displayName.length > 20 ? displayName.slice(0, 20) : displayName;
    const { containsProfanity, isNicknameDuplicate } = await import('./utils/nickname.js');
    if (containsProfanity(candidate)) {
        seededUids.add(user.uid);
        return false;
    }
    if (await isNicknameDuplicate(candidate, user.uid)) {
        seededUids.add(user.uid);
        return false;
    }

    window.userSettings.profile = window.userSettings.profile || {};
    window.userSettings.profile.nickname = candidate;

    try {
        await dbOps.saveSettings(window.userSettings);
        seededUids.add(user.uid);
        if (typeof window.ensureUserRegistered === 'function') {
            await window.ensureUserRegistered();
        }
        console.log('✅ Firebase Auth 표시 이름으로 닉네임 초기 시드:', candidate);
        return true;
    } catch (e) {
        console.warn('닉네임 Auth 시드 저장 실패:', e?.message || e);
        return false;
    }
}
