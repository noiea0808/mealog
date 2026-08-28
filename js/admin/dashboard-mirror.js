/**
 * 대시보드 로컬 미러 소스 — 집계가 읽을 재료를 미러에서 모아 온다
 *
 * 대시보드 전량 집계는 Firestore 읽기의 최대 소비자였다(실측 약 12.6K/회,
 * `docs/firestore-read-audit-2026-08.md`). 값이 큰 순서로 이렇게 갈아 끼운다:
 *
 *   meals 전량 스캔(식사 날짜 축)   → meals 미러
 *   meals 전량 스캔(기록 시각 축)   → 같은 미러 행을 한 번 더 훑는다
 *   슬롯별·전체 건수 count 쿼리      → 미러에서 센다
 *   사용자마다 던지던 count 쿼리     → 미러의 uid 유니크 집합 (사용자수만큼 사라진다)
 *   users 전량 조회                  → users 미러
 *   config 전량 스캔(하루 소감)      → users 미러가 settings 를 읽을 때 함께 담아 둔 자국
 *   sharedPhotos count + 기간 조회   → sharedPhotos 미러
 *
 * 남는 서버 읽기는 미러 **동기화 자체**(변경분 + 삭제 감지 count)와, 미러가 없는
 * `usageDaily`(페이지별 탭, 수십~백여 건) 뿐이다.
 *
 * 실패하면 예외를 던진다 — 부르는 쪽(`getUserStatistics`)이 예전 서버 스캔으로 돌아간다.
 *
 * 설계 문서: docs/admin-local-mirror.md · 순수 로직: dashboard-mirror-model.js
 */
import { appId } from '../firebase.js';
import { ensureMealsMirrorSynced, getAllMealsFromMirror } from './meals-mirror.js';
import { ensureUsersMirrorSynced, getAllUserMirrorRows } from './users-mirror.js';
import { sharedPhotosMirror } from './collection-mirror.js';
import { mealRowToDocLike } from './dashboard-mirror-model.js';

/**
 * 세 미러를 최신으로 맞추고 재료를 꺼낸다.
 *
 * @param {{force?: boolean}} [options] force 면 세 미러 모두 전체 재구축
 * @returns {Promise<{
 *   mealRows: object[],
 *   mealDocs: object[],
 *   userRows: object[],
 *   sharedDocs: object[],
 *   serverReads: number,
 *   syncModes: Record<string, string>
 * }>}
 */
export async function loadDashboardMirrorSource(options = {}) {
    const force = options.force === true;

    /**
     * 순차로 돌린다. 셋을 한꺼번에 띄우면 부트스트랩이 겹칠 때 브라우저 커넥션과
     * IndexedDB 트랜잭션이 동시에 몰려 첫 구축이 눈에 띄게 느려진다.
     * 어차피 사람이 버튼을 눌러 기다리는 자리라, 예측 가능한 편이 낫다.
     */
    const mealsResult = await ensureMealsMirrorSynced(undefined, { force });
    const usersResult = await ensureUsersMirrorSynced(undefined, { force });
    const sharedResult = await sharedPhotosMirror.ensureSynced(undefined, { force });

    const [mealRows, userRows, sharedDocs] = await Promise.all([
        getAllMealsFromMirror(),
        getAllUserMirrorRows(),
        sharedPhotosMirror.getDocsLike()
    ]);

    const serverReads =
        (mealsResult?.fetched || 0) + (usersResult?.serverReads || 0) + (sharedResult?.serverReads || 0);

    return {
        mealRows,
        mealDocs: mealRows.map((r) => mealRowToDocLike(r, appId)),
        userRows,
        sharedDocs,
        serverReads,
        syncModes: {
            meals: mealsResult?.mode || '?',
            users: usersResult?.mode || '?',
            sharedPhotos: sharedResult?.mode || '?'
        }
    };
}
