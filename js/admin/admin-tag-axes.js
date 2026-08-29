/**
 * 관리자 태그 축 — 「태그 관리」가 편집하는 목록의 **유일한 출처**.
 *
 * 예전에는 `tags.js` 안에 기본값 리터럴이 두 번(정상 경로·에러 폴백) 박혀 있었고,
 * 그 값이 `constants.js` 의 `DEFAULT_USER_SETTINGS.tags` 와 갈라질 수 있었다.
 * 「모먼트 분석」이 같은 목록을 읽기 시작하면서 출처가 셋이 될 참이라 여기로 모은다 —
 * 갈라지면 **관리자 화면이 편집하는 목록과 분석이 세는 목록이 달라진다.**
 *
 * 축 키가 두 벌인 것은 역사적 사정이다: 관리자 문서(`content/defaultTags`)는
 * `subTagsPlaceSnack`, 사용자 설정은 `tags.snackPlaceMain` 으로 같은 목록을 부른다
 * (`js/db/listeners.js` 가 옮겨 담는다). 그 대응을 여기 한 줄로 적어 둔다.
 */
import { db, appId } from '../firebase.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { DEFAULT_USER_SETTINGS } from '../constants.js';

/**
 * 관리자가 편집하는 네 축.
 * - `key`: `content/defaultTags` 문서의 필드명 (관리자 화면 DOM id 도 이 값이다)
 * - `settingsKey`: 사용자 설정 `tags.*` 의 필드명
 * - `label`: 입력 시트에서 사용자가 보는 축 이름
 */
export const ADMIN_TAG_AXES = [
    { key: 'mealType', settingsKey: 'mealType', label: '어떻게' },
    { key: 'subTagsPlaceSnack', settingsKey: 'snackPlaceMain', label: '어디서' },
    { key: 'category', settingsKey: 'category', label: '무엇을' },
    { key: 'withWhom', settingsKey: 'withWhom', label: '누구와' }
];

/** 기본 목록 — `constants.js` 하나에서만 온다 */
export function getDefaultAdminTags() {
    const t = DEFAULT_USER_SETTINGS.tags || {};
    const out = {};
    ADMIN_TAG_AXES.forEach((axis) => {
        const list = t[axis.settingsKey];
        out[axis.key] = Array.isArray(list) ? [...list] : [];
    });
    return out;
}

/**
 * 관리자 태그 목록을 읽는다 — 문서 **1건** 읽기.
 * 문서가 없거나 필드가 비면 기본값이 그 자리를 채운다(부분 병합).
 * @returns {Promise<{tags: Record<string,string[]>, fromServer: boolean}>}
 */
export async function loadAdminTagLists() {
    const tags = getDefaultAdminTags();
    try {
        const snap = await getDoc(doc(db, 'artifacts', appId, 'content', 'defaultTags'));
        if (!snap.exists()) return { tags, fromServer: false };
        const data = snap.data() || {};
        ADMIN_TAG_AXES.forEach((axis) => {
            const list = data[axis.key];
            if (Array.isArray(list) && list.length) tags[axis.key] = [...list];
        });
        return { tags, fromServer: true };
    } catch (e) {
        console.warn('[관리자 태그] 목록 읽기 실패 — 기본값으로 진행:', e);
        return { tags, fromServer: false };
    }
}
