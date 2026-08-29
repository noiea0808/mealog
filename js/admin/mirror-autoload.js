/**
 * 화면 진입 자동 로드 — 「미러가 이미 있을 때만」
 *
 * 탭에 들어갈 때마다 「새로고침」을 눌러야 했던 것은 2026-04-01(06ad572)의 비용
 * 가드다 (`admin.js` 의 「탭/서브메뉴 진입 시 Firestore 조회 없음」). 그때는 진입이
 * 곧 서버 전량 스캔이라 — 모먼트 관리는 커서 배치, 사용자 관리는 사람 수 × 3 —
 * 무심코 눌렀다 나오는 것만으로 수천 읽기가 나갔다. 옳은 설계였다.
 *
 * 미러가 생긴 지금 진입 비용은 델타다: 삭제 감지 count 1읽기 + 바뀐 문서 몇 건.
 * 근거가 사라졌으므로 화면이 스스로 뜨게 한다.
 *
 * **다만 미구축 미러는 건드리지 않는다.** 화면을 여는 것만으로 부트스트랩(meals 는
 * 1.2만 읽기)을 사면 미러로 없앤 비용이 그대로 돌아온다. 배경 유지보수
 * (`runMirrorMaintenance`)가 쓰는 게이트와 **같은 규칙**(`bootstrapDone`)이다 —
 * 전량 읽기는 사람이 미러 콘솔에서 결정한다는 8단계 원칙을 그대로 지킨다.
 * 그때는 예전처럼 화면이 비어 있고, 「새로고침」이 사람의 손으로 부른다.
 */
import { getMealsMirrorStatus } from './meals-mirror.js';
import { getUsersMirrorStatus } from './users-mirror.js';
import { ALL_COLLECTION_MIRRORS } from './collection-mirror.js';

const STATUS_BY_KEY = {
    meals: getMealsMirrorStatus,
    users: getUsersMirrorStatus,
    ...Object.fromEntries(ALL_COLLECTION_MIRRORS.map((m) => [m.name, () => m.getStatus()]))
};

/** 이 화면이 기대는 미러가 전부 구축돼 있나 — 하나라도 없으면 자동 로드하지 않는다 */
async function allMirrorsBuilt(keys) {
    for (const key of keys) {
        const readStatus = STATUS_BY_KEY[key];
        if (typeof readStatus !== 'function') return false;
        try {
            const status = await readStatus();
            if (!status?.bootstrapDone) return false;
        } catch (e) {
            /* 상태를 못 읽으면 「없다」로 본다 — 모르는 채로 전량을 사는 것보다 낫다 */
            console.warn(`[미러 자동 로드] ${key} 상태를 읽지 못했습니다:`, e?.message || e);
            return false;
        }
    }
    return true;
}

/**
 * 미러가 준비돼 있으면 화면을 채운다.
 *
 * @param {string[]} mirrorKeys 이 화면이 읽는 미러
 * @param {() => any} load 평소의 「새로고침」 경로 — 미러가 있으면 델타로 끝난다
 * @returns {Promise<boolean>} 실제로 채웠으면 true (미구축·실패면 false)
 */
export async function autoloadWhenMirrored(mirrorKeys, load) {
    if (typeof load !== 'function') return false;
    if (!(await allMirrorsBuilt(mirrorKeys))) return false;
    try {
        await load();
        return true;
    } catch (e) {
        console.warn('[미러 자동 로드] 화면을 채우지 못했습니다 — 「새로고침」으로 다시 시도하세요:', e?.message || e);
        return false;
    }
}
