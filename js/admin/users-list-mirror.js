/**
 * 사용자 관리 목록 — 로컬 미러로 조립한다
 *
 * 예전에는 목록 한 줄을 만들려고 사람마다 문서 세 건을 서버에서 사 왔다:
 * 루트 users · `config/settings` · `meals` 건수 집계. 거기에 페이지마다
 * `sharedPhotos`·`boardPosts` `in` 쿼리와 `userBans`·`deleteUserRequests` 청크가 붙었다.
 * 정렬·검색은 전체 목록을 요구하므로 **전 사용자에 대해** 이 값이 곱해졌다 —
 * 사용자 N 명이면 3N 을 훌쩍 넘는 읽기다.
 *
 * 재료는 이미 미러에 다 있다.
 *
 *   프로필·약관·가입일  users 미러 (settings 를 어차피 읽어 담는다)
 *   타임라인 건수        meals 미러의 uid 별 건수
 *   공유 건수·아이콘     sharedPhotos 미러
 *   밀톡 건수            boardPosts 미러
 *
 * 남는 서버 읽기는 `userBans` 와 `deleteUserRequests` 뿐이다. 둘 다 「해당되는
 * 사람만 문서가 생기는」 작은 컬렉션이라 통째로 한 번 읽는 편이, 예전처럼 페이지마다
 * 30개씩 쪼갠 `in` 쿼리를 던지는 것보다 싸다.
 *
 * 실패하면 예외를 던진다 — 부르는 쪽이 예전 서버 파이프라인으로 돌아간다.
 *
 * 설계 문서: docs/admin-local-mirror.md
 */
import { db, appId, refreshAppCheckTokenBeforeFirestore } from '../firebase.js';
import { collection, getDocs } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { ensureUsersMirrorSynced, getAllUsersFromMirror } from './users-mirror.js';
import { ensureMealsMirrorSynced, getAllMealsFromMirror } from './meals-mirror.js';
import { sharedPhotosMirror, boardPostsMirror } from './collection-mirror.js';
import { buildUserListRow } from './users-mirror-model.js';
import { countByField, firstValueByField } from './users-list-mirror-model.js';

/**
 * 제재·탈퇴 요청 — 미러가 없는 둘.
 *
 * 해당되는 사람만 문서가 생기므로 컬렉션 자체가 작다. 실패해도 목록은 세운다 —
 * 제재 표시가 빠질 뿐이고, 그 때문에 전체 목록을 못 보는 편이 더 나쁘다.
 */
async function fetchBansAndDeleteRequests() {
    const bans = new Map();
    const deleteRequested = new Set();
    let serverReads = 0;
    try {
        const snap = await getDocs(collection(db, 'artifacts', appId, 'userBans'));
        serverReads += snap.size;
        snap.docs.forEach((d) => {
            const data = d.data();
            bans.set(d.id, { bannedShare: data.bannedShare === true, bannedWrite: data.bannedWrite === true });
        });
    } catch (e) {
        console.warn('[사용자 목록] 제재 목록을 못 읽었습니다 — 제재 표시 없이 세웁니다:', e?.message || e);
    }
    try {
        const snap = await getDocs(collection(db, 'artifacts', appId, 'deleteUserRequests'));
        serverReads += snap.size;
        snap.docs.forEach((d) => {
            const uid = d.data()?.userId;
            if (uid) deleteRequested.add(uid);
        });
    } catch (e) {
        console.warn('[사용자 목록] 탈퇴 요청을 못 읽었습니다:', e?.message || e);
    }
    return { bans, deleteRequested, serverReads };
}

/**
 * 전체 사용자 목록을 미러에서 세운다 — 서버 파이프라인과 같은 모양의 배열.
 *
 * 정렬은 부르는 쪽이 하므로 여기서는 **최근 로그인순**으로만 맞춰 둔다.
 * 예전 서버 쿼리가 `orderBy('lastLoginAt','desc')` 였고, `pageFetchIndex`(원래 순서)로
 * 되돌리는 정렬 옵션이 있어서 그 순서가 눈에 보이는 값이기 때문이다.
 *
 * @returns {Promise<object[]>}
 */
export async function fetchAllUsersFromMirror() {
    await refreshAppCheckTokenBeforeFirestore();

    await ensureUsersMirrorSynced();
    await ensureMealsMirrorSynced();
    await sharedPhotosMirror.ensureSynced();
    await boardPostsMirror.ensureSynced();

    const [userRows, mealRows, sharedDocs, boardDocs, extra] = await Promise.all([
        // 목록은 예전부터 settings 없는 고아 문서를 건너뛰었다 — 같은 규칙을 쓴다
        getAllUsersFromMirror(),
        getAllMealsFromMirror(),
        sharedPhotosMirror.getDocsLike(),
        boardPostsMirror.getDocsLike(),
        fetchBansAndDeleteRequests()
    ]);

    const mealCounts = countByField(mealRows, (r) => r.userId);
    const shareCounts = countByField(sharedDocs, (d) => d.data()?.userId);
    const talkCounts = countByField(boardDocs, (d) => d.data()?.authorId);
    const sharedIcons = firstValueByField(
        sharedDocs,
        (d) => d.data()?.userId,
        (d) => d.data()?.userIcon || null
    );

    const sorted = [...userRows].sort((a, b) => {
        const ta = a.lastLoginAt ? a.lastLoginAt.getTime() : -Infinity;
        const tb = b.lastLoginAt ? b.lastLoginAt.getTime() : -Infinity;
        return tb - ta;
    });

    const users = [];
    sorted.forEach((row, i) => {
        const ban = extra.bans.get(row.userId);
        const built = buildUserListRow(row, {
            fallbackIcon: sharedIcons.get(row.userId) || null,
            timelineCount: mealCounts.get(row.userId) || 0,
            albumShareCount: shareCounts.get(row.userId) || 0,
            talkCount: talkCounts.get(row.userId) || 0,
            bannedShare: ban?.bannedShare === true,
            bannedWrite: ban?.bannedWrite === true,
            deleteRequested: extra.deleteRequested.has(row.userId),
            pageFetchIndex: i
        });
        if (built) users.push(built);
    });

    console.log(`[사용자 목록] 미러에서 ${users.length}명 · 서버 읽기 ${extra.serverReads}건(제재·탈퇴 요청)`);
    return users;
}
