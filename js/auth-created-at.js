/**
 * 가입일( users 루트 createdAt ) — Firebase Auth UID 최초 생성 시각과 맞춤
 */
import { Timestamp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

/**
 * @param {import('https://www.gstatic.com/firebasejs/11.10.0/firebase-auth').User | null | undefined} user
 * @returns {import('https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore').Timestamp | null}
 */
export function getAuthAccountCreatedTimestamp(user) {
    if (!user?.metadata?.creationTime) return null;
    const d = new Date(user.metadata.creationTime);
    if (Number.isNaN(d.getTime())) return null;
    return Timestamp.fromDate(d);
}

/**
 * @param {import('https://www.gstatic.com/firebasejs/11.10.0/firebase-auth').User | null | undefined} user
 * @returns {number | null}
 */
export function getAuthAccountCreatedMillis(user) {
    const t = getAuthAccountCreatedTimestamp(user);
    return t ? t.toMillis() : null;
}
