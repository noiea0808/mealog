/**
 * config/settings 의 프로필·약관 게이트 필드 복구.
 *
 * 배경: dbOps.saveSettings 는 저장 전에 기존 문서를 읽어 병합하는데(js/db/ops.js), 이 선행 읽기가
 * 실패하면 existingSettings 가 {} 로 남은 채 setDoc(merge 없음) 이 문서를 통째로 덮어쓴다.
 * 그 결과 사용자 데이터(bestMeals·tags·shortcuts 등)는 남지만 아래 게이트 필드만 기본값으로 리셋된다:
 *
 *   profileCompleted=false, termsAgreed=false, termsVersion=null,
 *   onboardingCompleted=false, isFirstLogin=true, profile.nickname='게스트'
 *
 * 이 상태가 되면 js/auth-flow.js 의 checkUserReadiness 가 hasProfile=false 로 판정해
 * 기존 사용자에게 닉네임 설정 모달이 뜬다.
 *
 * 원래 닉네임은 nicknameClaims 인덱스의 displayNickname 에서 되살린다
 * (functions/scripts/backfill-nickname-claims.js 가 쓰는 필드).
 *
 * 전수 조사 (읽기 전용, 몇 명이 당했는지 센다):
 *   cd functions && node scripts/restore-profile-terms-gate.js --scan
 *   → '데이터는 쌓였는데 게이트만 꺼진' 계정만 손상으로 집계한다(신규 가입자와 구분).
 *
 * 실행 (드라이런, 변경 없음):
 *   cd functions && node scripts/restore-profile-terms-gate.js --uid=<UID> --dry-run
 *
 * 실제 반영:
 *   cd functions && node scripts/restore-profile-terms-gate.js --uid=<UID> --apply --credentials="C:\\Users\\본인\\Downloads\\프로젝트-xxxxx.json"
 *
 * 서비스 계정 JSON (Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성):
 *   - 환경변수 GOOGLE_APPLICATION_CREDENTIALS 에 파일 **전체 경로** (폴더 아님)
 *   - 또는 `--credentials=경로` (Git Bash에서 `/c/Users/.../키.json` 형식 권장)
 */
const fs = require('fs');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const APP_ID = 'mealog-r0';

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

function resolveUid() {
    for (const a of process.argv.slice(2)) {
        const m = a.match(/^--uid=(.+)$/);
        if (m) return m[1].trim();
    }
    return '';
}

function resolveLimit() {
    for (const a of process.argv.slice(2)) {
        const m = a.match(/^--limit=(\d+)$/);
        if (m) return Number(m[1]);
    }
    return 0;
}

/** 게이트 판정에 쓰이는 필드만 추린다 (js/profile-readiness.js · js/auth-flow.js 기준) */
function gateView(s) {
    return {
        profileCompleted: s.profileCompleted,
        profileCompletedAt: s.profileCompletedAt ?? null,
        termsAgreed: s.termsAgreed,
        termsAgreedAt: s.termsAgreedAt ?? null,
        termsVersion: s.termsVersion ?? null,
        onboardingCompleted: s.onboardingCompleted,
        isFirstLogin: s.isFirstLogin,
        nickname: s.profile ? s.profile.nickname : undefined
    };
}

/** 게이트가 꺼져 있는가 — checkUserReadiness 가 hasProfile:false 로 볼 조건 */
function isGateOff(s) {
    if (s.profileCompleted !== true) return true;
    const n = s.profile && s.profile.nickname != null ? String(s.profile.nickname).trim() : '';
    return n === '' || n === '게스트';
}

/**
 * 실제로 써 온 흔적이 있는가.
 * 신규 가입자도 게이트는 꺼져 있으므로, 이 조건이 있어야 '손상'과 '아직 안 끝낸 가입'을 가른다.
 */
function usageWeight(s) {
    const n = (o) => (o && typeof o === 'object' ? Object.keys(o).length : 0);
    return n(s.bestMeals) + n(s.tags) + n(s.favoriteSubTags) + n(s.subTags);
}

/**
 * 읽기 전용 전수 조사. 쓰지 않는다.
 * 출력에 닉네임·이메일 같은 식별 정보는 싣지 않고 uid와 카운트만 남긴다.
 */
async function runScan(db, limit) {
    const usersRef = db.collection('artifacts').doc(APP_ID).collection('users');
    const snap = await usersRef.get();
    const total = limit > 0 ? Math.min(snap.size, limit) : snap.size;
    console.log(`사용자 ${snap.size}명 중 ${total}명 검사 (읽기 전용)`);

    const damaged = [];
    let healthy = 0;
    let pendingSignup = 0;
    let noSettings = 0;
    let checked = 0;

    for (const userDoc of snap.docs) {
        if (limit > 0 && checked >= limit) break;
        checked++;

        const settingsSnap = await userDoc.ref.collection('config').doc('settings').get();
        if (!settingsSnap.exists) {
            noSettings++;
            continue;
        }
        const s = settingsSnap.data() || {};

        if (!isGateOff(s)) {
            healthy++;
            continue;
        }
        const weight = usageWeight(s);
        if (weight === 0) {
            // 게이트도 꺼져 있고 쌓인 것도 없음 → 가입을 안 끝낸 사용자. 정상 상태다.
            pendingSignup++;
            continue;
        }
        damaged.push({
            uid: userDoc.id,
            usageWeight: weight,
            profileCompleted: s.profileCompleted,
            termsAgreed: s.termsAgreed,
            nicknameIsDefault:
                !s.profile ||
                s.profile.nickname == null ||
                String(s.profile.nickname).trim() === '' ||
                String(s.profile.nickname).trim() === '게스트'
        });
    }

    console.log('');
    console.log('── 결과 ──');
    console.log(`정상(게이트 통과):        ${healthy}`);
    console.log(`가입 미완료(데이터 없음): ${pendingSignup}`);
    console.log(`설정 문서 없음:           ${noSettings}`);
    console.log(`⚠️ 손상 의심:             ${damaged.length}`);

    if (damaged.length > 0) {
        console.log('');
        console.log('손상 의심 목록 (데이터는 쌓였는데 게이트가 꺼짐):');
        for (const d of damaged) {
            console.log(
                `  ${d.uid}  usage=${d.usageWeight}  profileCompleted=${d.profileCompleted}  termsAgreed=${d.termsAgreed}  닉네임기본값=${d.nicknameIsDefault}`
            );
        }
        console.log('');
        console.log('복구는 uid 하나씩: node scripts/restore-profile-terms-gate.js --uid=<UID> --dry-run');
    }
}

async function main() {
    const scanMode = process.argv.includes('--scan');
    const dryRun = process.argv.includes('--dry-run') || !process.argv.includes('--apply');
    const uid = resolveUid();
    if (!scanMode && !uid) {
        console.error('대상 사용자를 --uid=<UID> 로 지정하세요. (전수 조사는 --scan)');
        process.exit(1);
    }

    const keyPath = resolveCredentialPath();
    if (!keyPath) {
        console.error(
            '서비스 계정 JSON 경로를 GOOGLE_APPLICATION_CREDENTIALS 또는 --credentials= 로 지정하세요. (functions/scripts/backfill-nickname-claims.js 참고)'
        );
        process.exit(1);
    }

    const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    initializeApp({ credential: cert(serviceAccount) });
    const db = getFirestore();

    if (scanMode) {
        await runScan(db, resolveLimit());
        return;
    }

    console.log(`대상 uid: ${uid}, 모드: ${dryRun ? 'DRY-RUN' : 'APPLY'}`);

    const settingsRef = db
        .collection('artifacts')
        .doc(APP_ID)
        .collection('users')
        .doc(uid)
        .collection('config')
        .doc('settings');

    const settingsSnap = await settingsRef.get();
    if (!settingsSnap.exists) {
        console.error('config/settings 문서가 없습니다. 중단합니다.');
        process.exit(1);
    }
    const s = settingsSnap.data() || {};
    console.log('복구 전:', JSON.stringify(gateView(s), null, 1));

    // 사용자 데이터가 실제로 남아 있는지 확인 — 빈 문서라면 이 스크립트의 대상이 아니다
    const intact = {
        bestMeals: s.bestMeals ? Object.keys(s.bestMeals).length : 0,
        tags: s.tags ? Object.keys(s.tags).length : 0,
        favoriteSubTags: s.favoriteSubTags ? Object.keys(s.favoriteSubTags).length : 0
    };
    console.log('보존된 사용자 데이터:', JSON.stringify(intact));

    // 현재 약관 버전
    const termsSnap = await db.collection('artifacts').doc(APP_ID).collection('content').doc('terms').get();
    const currentTermsVersion =
        termsSnap.exists && termsSnap.data().currentVersion != null
            ? String(termsSnap.data().currentVersion).trim()
            : '';
    console.log(`content/terms.currentVersion: ${currentTermsVersion || '(없음)'}`);

    // nicknameClaims 역조회 → 원래 닉네임
    let recoveredNickname = null;
    const claims = await db
        .collection('artifacts')
        .doc(APP_ID)
        .collection('nicknameClaims')
        .where('userId', '==', uid)
        .get();
    console.log(`nicknameClaims 매칭: ${claims.size}건`);
    for (const c of claims.docs) {
        const d = c.data() || {};
        console.log(`  - ${c.id}: displayNickname=${d.displayNickname ?? '(없음)'}`);
        if (!recoveredNickname && d.displayNickname && String(d.displayNickname).trim() !== '게스트') {
            recoveredNickname = String(d.displayNickname).trim();
        }
    }
    console.log(`복구할 닉네임: ${recoveredNickname ?? '(찾지 못함)'}`);

    // 패치 조립 — 지정한 필드만 부분 갱신한다 (문서 전체 덮어쓰기 금지)
    const nowIso = new Date().toISOString();
    const patch = {};
    const reconstructed = [];

    if (recoveredNickname) patch['profile.nickname'] = recoveredNickname;

    if (s.termsAgreed !== true) {
        patch.termsAgreed = true;
        if (s.termsAgreedAt == null) {
            patch.termsAgreedAt = nowIso;
            reconstructed.push('termsAgreedAt');
        }
    }
    if (currentTermsVersion && String(s.termsVersion ?? '').trim() !== currentTermsVersion) {
        patch.termsVersion = currentTermsVersion;
    }
    if (s.isFirstLogin !== false) patch.isFirstLogin = false;

    // 닉네임을 못 살렸으면 프로필 완료로 표시하지 않는다 —
    // '게스트'인 채 profileCompleted=true 가 되면 위저드가 다시는 안 뜨고 상태가 굳는다.
    if (recoveredNickname) {
        if (s.profileCompleted !== true) {
            patch.profileCompleted = true;
            if (s.profileCompletedAt == null) {
                patch.profileCompletedAt = nowIso;
                reconstructed.push('profileCompletedAt');
            }
        }
        if (s.onboardingCompleted !== true) patch.onboardingCompleted = true;
    } else {
        console.warn(
            '⚠️ 원래 닉네임을 찾지 못해 profileCompleted·onboardingCompleted 는 건드리지 않습니다. 닉네임을 수동으로 정한 뒤 다시 실행하세요.'
        );
    }

    if (Object.keys(patch).length === 0) {
        console.log('변경할 것이 없습니다.');
        return;
    }

    console.log('적용할 패치:', JSON.stringify(patch, null, 1));
    if (reconstructed.length) {
        console.log(`⚠️ 원본 시각을 알 수 없어 현재 시각으로 채운 필드: ${reconstructed.join(', ')}`);
    }

    if (dryRun) {
        console.log('DRY-RUN 이라 쓰지 않았습니다. 반영하려면 --apply 를 붙이세요.');
        return;
    }

    await settingsRef.update(patch);
    const afterSnap = await settingsRef.get();
    console.log('복구 후:', JSON.stringify(gateView(afterSnap.data() || {}), null, 1));
    console.log('✅ 완료. 앱에서 로그아웃 없이 재시작하면 닉네임 모달이 사라져야 합니다.');
}

main().catch((e) => {
    console.error('실패:', e);
    process.exit(1);
});
