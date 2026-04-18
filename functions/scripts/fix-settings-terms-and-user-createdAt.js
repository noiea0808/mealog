/**
 * 1) config/settings: termsAgreedAt 또는 termsVersion 이 있는데 termsAgreed 가 true 가 아니면 termsAgreed: true 로 보정
 * 2) config/settings: termsAgreed === true 인데 termsVersion 이 비어 있으면 content/terms 의 currentVersion 으로 백필
 * 3) users/{uid} 루트: createdAt 이 없고 설정에 프로필 완료·약관 시각이 있으면, 그중 이른 시각으로 createdAt 백필
 *
 * 실행 (드라이런, 변경 없음):
 *   cd functions && node scripts/fix-settings-terms-and-user-createdAt.js --dry-run
 *
 * 실제 반영:
 *   cd functions && node scripts/fix-settings-terms-and-user-createdAt.js --apply --credentials="C:\\Users\\본인\\Downloads\\프로젝트-xxxxx.json"
 *
 * 서비스 계정 JSON (Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성):
 *   - 환경변수 GOOGLE_APPLICATION_CREDENTIALS 에 파일 **전체 경로** (폴더 아님)
 *   - 또는 `--credentials=경로` (Git Bash에서 `/c/Users/.../키.json` 형식 권장 — `/path/...` 는 예시일 뿐이며, Bash가 Git 폴더로 바꿔 깨질 수 있음)
 */
const fs = require('fs');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

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

function toJsDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Timestamp) return v.toDate();
    if (typeof v.toDate === 'function') return v.toDate();
    if (v instanceof Date) return v;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

function earliestDate(...dates) {
    const ok = dates.filter((d) => d instanceof Date && !Number.isNaN(d.getTime()));
    if (!ok.length) return null;
    return new Date(Math.min(...ok.map((d) => d.getTime())));
}

async function main() {
    const dryRun = process.argv.includes('--dry-run') || !process.argv.includes('--apply');
    const keyPath = resolveCredentialPath();
    if (!keyPath) {
        console.error(
            '서비스 계정 JSON 경로를 GOOGLE_APPLICATION_CREDENTIALS 또는 인자로 지정하세요. (functions/scripts/backfill-nickname-claims.js 참고)'
        );
        process.exit(1);
    }

    const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    initializeApp({ credential: cert(serviceAccount) });
    const db = getFirestore();

    const termsMetaRef = db.collection('artifacts').doc(APP_ID).collection('content').doc('terms');
    const termsMetaSnap = await termsMetaRef.get();
    const currentTermsVersionFromContent =
        termsMetaSnap.exists && termsMetaSnap.data().currentVersion != null
            ? String(termsMetaSnap.data().currentVersion).trim()
            : '1.0';

    const usersRef = db.collection('artifacts').doc(APP_ID).collection('users');
    const snap = await usersRef.get();
    console.log(`사용자 문서 ${snap.size}건 스캔, 모드: ${dryRun ? 'DRY-RUN' : 'APPLY'}`);
    console.log(`약관 버전 백필에 사용할 currentVersion: ${currentTermsVersionFromContent}`);

    let fixTerms = 0;
    let fixTermsVersion = 0;
    let fixCreated = 0;
    let skipNoSettings = 0;

    for (const userDoc of snap.docs) {
        const uid = userDoc.id;
        const rootData = userDoc.data() || {};
        const rootCreated = toJsDate(rootData.createdAt);

        const settingsRef = userDoc.ref.collection('config').doc('settings');
        const settingsSnap = await settingsRef.get();
        if (!settingsSnap.exists) {
            if (!rootCreated) skipNoSettings++;
            continue;
        }

        const s = settingsSnap.data() || {};
        const hasTermsMeta = Boolean(s.termsAgreedAt) || (s.termsVersion != null && String(s.termsVersion).trim() !== '');
        const termsOk = s.termsAgreed === true;

        if (hasTermsMeta && !termsOk) {
            console.log(`[termsAgreed 보정] uid=${uid}`);
            fixTerms++;
            if (!dryRun) {
                await settingsRef.set({ termsAgreed: true }, { merge: true });
            }
        }

        const verEmpty = s.termsVersion == null || String(s.termsVersion).trim() === '';
        if (termsOk && verEmpty) {
            console.log(`[termsVersion 백필] uid=${uid} → ${currentTermsVersionFromContent}`);
            fixTermsVersion++;
            if (!dryRun) {
                await settingsRef.set({ termsVersion: currentTermsVersionFromContent }, { merge: true });
            }
        }

        const profileAt = toJsDate(s.profileCompletedAt);
        const termsAt = toJsDate(s.termsAgreedAt);
        const fallbackCreated = earliestDate(profileAt, termsAt);

        if (!rootCreated && fallbackCreated) {
            console.log(`[createdAt 백필] uid=${uid} → ${fallbackCreated.toISOString()}`);
            fixCreated++;
            if (!dryRun) {
                await userDoc.ref.set(
                    { createdAt: Timestamp.fromDate(fallbackCreated), uid },
                    { merge: true }
                );
            }
        }
    }

    console.log(
        `완료: termsAgreed 보정 ${fixTerms}건, termsVersion 백필 ${fixTermsVersion}건, createdAt 백필 ${fixCreated}건, 루트만·설정 없음 스킵 ${skipNoSettings}건`
    );
    if (dryRun) {
        console.log('실제 반영하려면 인자에 --apply 를 추가하세요.');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
