/**
 * settings.profile.nickname → nicknameClaims 인덱스 백필 (기존 사용자 중복 검사·트랜잭션 정합성)
 *
 * 실행: cd functions && npm run backfill:nicknameClaims
 *
 * 필요: Firebase에서 받은 서비스 계정 JSON 파일의 실제 경로
 *   - 환경변수 GOOGLE_APPLICATION_CREDENTIALS 또는 첫 번째 인자로 전달
 *   - 예시 경로(/path/to/...)는 쓰지 말 것. Git Bash에서는 /c/Users/이름/.../키.json 형식 권장
 *
 * 동일 정규화 닉네임이 여러 사용자에 있으면 먼저 스캔한 uid만 클레임하고 나머지는 로그만 남김.
 */
const fs = require('fs');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const APP_ID = 'mealog-r0';

function normalizeNicknameForClaim(nickname) {
    if (!nickname || typeof nickname !== 'string') return null;
    const t = nickname.trim();
    if (!t || t === '게스트') return null;
    try {
        return t.normalize('NFKC').toLowerCase();
    } catch {
        return t.toLowerCase();
    }
}

function nicknameClaimDocId(normalized) {
    if (!normalized) return '';
    const clipped = normalized.length > 200 ? normalized.slice(0, 200) : normalized;
    return encodeURIComponent(clipped);
}

function credentialPathCandidates(raw) {
    const candidates = [];
    if (!raw) return candidates;
    candidates.push(path.resolve(raw));
    candidates.push(raw);
    // Git Bash: /c/Users/... → C:\Users\...
    const m = raw.match(/^\/([a-zA-Z])\/(.*)$/);
    if (m) {
        const drive = m[1].toUpperCase();
        const rest = m[2].split('/').join(path.sep);
        candidates.push(`${drive}:${path.sep}${rest}`);
    }
    return [...new Set(candidates)];
}

function resolveCredentialPath() {
    const fromArg = process.argv[2];
    const fromEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const raw = (fromArg || fromEnv || '').trim().replace(/^["']|["']$/g, '');
    if (!raw) {
        return null;
    }
    for (const p of credentialPathCandidates(raw)) {
        try {
            if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
        } catch (_) {
            /* ignore */
        }
    }
    return null;
}

async function main() {
    const keyPath = resolveCredentialPath();
    if (!keyPath) {
        console.error(`
[오류] 서비스 계정 JSON 파일을 찾을 수 없습니다.

  GOOGLE_APPLICATION_CREDENTIALS 는 프로젝트 폴더(mealog)가 아니라,
  Firebase에서 받은 "파일 이름.json" 까지의 전체 경로여야 합니다.
  (폴더만 넣으면 EISDIR 오류가 납니다.)

  문서에 나온 /path/to/serviceAccount.json 은 예시입니다.
  Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → "새 비공개 키 생성"으로 받은 .json 경로를 지정하세요.

  Git Bash (MINGW64) 예시:
    export GOOGLE_APPLICATION_CREDENTIALS="/c/Users/본인계정/Downloads/your-project-xxxxx.json"
    npm run backfill:nicknameClaims

  또는 인자로:
    npm run backfill:nicknameClaims -- "/c/Users/본인계정/Downloads/your-project-xxxxx.json"

  CMD/PowerShell 예시:
    set GOOGLE_APPLICATION_CREDENTIALS=C:\\Users\\본인계정\\Downloads\\your-project-xxxxx.json
    npm run backfill:nicknameClaims
`);
        process.exit(1);
    }

    if (!fs.statSync(keyPath).isFile()) {
        console.error(`
[오류] 지정한 경로가 파일이 아닙니다 (폴더일 수 없음).

  예: .../mealog-r0-firebase-adminsdk-xxxxx.json
  현재: ${keyPath}
`);
        process.exit(1);
    }

    const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    initializeApp({ credential: cert(serviceAccount) });
    const db = getFirestore();
    const usersRef = db.collection('artifacts').doc(APP_ID).collection('users');
    const usersSnap = await usersRef.get();
    console.log(`사용자 ${usersSnap.size}명 스캔`);

    let written = 0;
    let skippedNoNick = 0;
    let skippedConflict = 0;

    for (const userDoc of usersSnap.docs) {
        const uid = userDoc.id;
        const settingsRef = userDoc.ref.collection('config').doc('settings');
        const settingsSnap = await settingsRef.get();
        if (!settingsSnap.exists) {
            skippedNoNick++;
            continue;
        }
        const nick = settingsSnap.data()?.profile?.nickname;
        const norm = normalizeNicknameForClaim(nick);
        if (!norm) {
            skippedNoNick++;
            continue;
        }

        const claimRef = db.collection('artifacts').doc(APP_ID).collection('nicknameClaims').doc(nicknameClaimDocId(norm));
        const existing = await claimRef.get();
        if (existing.exists) {
            const owner = existing.data()?.userId;
            if (owner && owner !== uid) {
                console.warn(`충돌 스킵: norm="${norm}" uid=${uid} (이미 ${owner})`);
                skippedConflict++;
                continue;
            }
        }

        await claimRef.set(
            {
                userId: uid,
                normalizedNickname: norm,
                displayNickname: String(nick).trim(),
                updatedAt: new Date().toISOString(),
                backfilledAt: new Date().toISOString()
            },
            { merge: true }
        );
        written++;
    }

    console.log(`완료: 클레임 작성 ${written}, 닉네임 없음/스킵 ${skippedNoNick}, 충돌 ${skippedConflict}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
