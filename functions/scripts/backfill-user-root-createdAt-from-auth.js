/**
 * users/{uid} 루트 문서의 createdAt 을 Firebase Auth 계정 최초 생성 시각으로 백필(또는 덮어쓰기).
 *
 * 대상: artifacts/mealog-r0/users 컬렉션에 문서가 있는 UID (Firestore에 루트가 있는 사용자만 갱신, 빈 루트 문서 신규 생성 안 함)
 *
 * 실행 (드라이런, 쓰기 없음):
 *   cd functions && node scripts/backfill-user-root-createdAt-from-auth.js --dry-run
 *
 * 실제 반영 (createdAt 이 비어 있는 문서만):
 *   cd functions && node scripts/backfill-user-root-createdAt-from-auth.js --apply --credentials="C:\\path\\to\\serviceAccount.json"
 *
 * 이미 createdAt 이 있어도 Auth 시각으로 전부 맞추려면:
 *   ... --apply --overwrite
 *
 * 서비스 계정: GOOGLE_APPLICATION_CREDENTIALS 또는 --credentials=경로
 * (fix-settings-terms-and-user-createdAt.js 와 동일)
 */
const fs = require('fs');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const APP_ID = 'mealog-r0';

function credentialPathCandidates(raw) {
    const candidates = [];
    if (!raw) return candidates;
    candidates.push(path.resolve(raw));
    candidates.push(raw);
    const m = raw.match(/^\/([a-zA-Z])\/(.*)$/);
    if (m) {
        const drive = m[1].toUpperCase();
        const rest = m[2].split('/').join(path.sep);
        candidates.push(`${drive}:${path.sep}${rest}`);
    }
    return [...new Set(candidates)];
}

function resolveCredentialPath() {
    const argv = process.argv.slice(2);
    let fromFlag = '';
    for (const a of argv) {
        const m = a.match(/^--(?:credentials|cred)=(.+)$/);
        if (m) {
            fromFlag = m[1].trim();
            break;
        }
    }
    const fromLoose = argv.find((a) => !a.startsWith('--') && a.endsWith('.json'));
    const fromEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const raw = (fromFlag || fromLoose || fromEnv || '').trim().replace(/^["']|["']$/g, '');
    if (!raw) return null;
    for (const p of credentialPathCandidates(raw)) {
        try {
            if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
        } catch (_) {
            /* ignore */
        }
    }
    return null;
}

function hasCreatedAt(data) {
    const v = data && data.createdAt;
    if (v == null) return false;
    if (typeof v.toDate === 'function') return true;
    if (v instanceof Timestamp) return true;
    return false;
}

async function main() {
    const dryRun = process.argv.includes('--dry-run') || !process.argv.includes('--apply');
    const overwrite = process.argv.includes('--overwrite');
    const keyPath = resolveCredentialPath();
    if (!keyPath) {
        console.error(
            '서비스 계정 JSON 경로를 GOOGLE_APPLICATION_CREDENTIALS 또는 --credentials= 로 지정하세요.'
        );
        process.exit(1);
    }

    const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    initializeApp({ credential: cert(serviceAccount) });
    const db = getFirestore();
    const auth = getAuth();

    const usersRef = db.collection('artifacts').doc(APP_ID).collection('users');
    const snap = await usersRef.get();

    console.log(
        `스캔: users 루트 문서 ${snap.size}건 | 모드: ${dryRun ? 'DRY-RUN' : 'APPLY'} | overwrite=${overwrite}`
    );

    let updated = 0;
    let skippedHasDate = 0;
    let skippedNoAuth = 0;
    let errors = 0;

    for (const userDoc of snap.docs) {
        const uid = userDoc.id;
        const rootData = userDoc.data() || {};

        if (hasCreatedAt(rootData) && !overwrite) {
            skippedHasDate++;
            continue;
        }

        let userRecord;
        try {
            userRecord = await auth.getUser(uid);
        } catch (e) {
            const code = e && e.code;
            if (code === 'auth/user-not-found') {
                console.warn(`[스킵] Auth에 사용자 없음 uid=${uid}`);
                skippedNoAuth++;
                continue;
            }
            console.error(`[오류] getUser uid=${uid}`, e.message || e);
            errors++;
            continue;
        }

        const ct = userRecord.metadata && userRecord.metadata.creationTime;
        if (!ct) {
            console.warn(`[스킵] Auth metadata.creationTime 없음 uid=${uid}`);
            errors++;
            continue;
        }

        const d = new Date(ct);
        if (Number.isNaN(d.getTime())) {
            console.warn(`[스킵] creationTime 파싱 실패 uid=${uid} raw=${ct}`);
            errors++;
            continue;
        }

        const ts = Timestamp.fromDate(d);
        const action = hasCreatedAt(rootData) && overwrite ? '덮어쓰기' : '백필';
        console.log(`[${action}] uid=${uid} → ${d.toISOString()}`);

        updated++;
        if (!dryRun) {
            await userDoc.ref.set({ createdAt: ts, uid }, { merge: true });
        }
    }

    console.log(
        `완료: 갱신 예정/실행 ${updated}건, 기존 createdAt 유지 스킵 ${skippedHasDate}건, Auth 없음 ${skippedNoAuth}건, 오류/경고 ${errors}건`
    );
    if (dryRun) {
        console.log('실제 반영: node scripts/backfill-user-root-createdAt-from-auth.js --apply --credentials=...');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
