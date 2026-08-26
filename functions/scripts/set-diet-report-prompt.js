/**
 * AI 식단분석 프롬프트를 파일에서 읽어 Firestore(adminSettings/dietReportConfig)에 직접 쓴다.
 *
 * 배경: 운영 프롬프트는 6천 자가 넘어 관리자 화면에 붙여넣는 과정에서 잘리기 쉽다.
 * 일부만 저장되면 출력 필드 지시가 통째로 사라져도 겉으로는 정상처럼 보인다.
 * 이 스크립트는 파일을 그대로 올리고, 저장 전후 해시를 찍어 잘림을 즉시 드러낸다.
 *
 * promptVersion 은 관리자 화면(js/admin/diet-report-config.js promptVersionFromText)과
 * 동일한 규칙으로 계산한다: 'diet-' + sha1(본문).slice(0, 10)
 *
 * 현재 상태만 확인 (읽기 전용):
 *   cd functions && node scripts/set-diet-report-prompt.js --show --credentials=<키.json>
 *
 * 드라이런 — 무엇이 바뀌는지만 출력, 쓰지 않음:
 *   cd functions && node scripts/set-diet-report-prompt.js --dry-run --credentials=<키.json>
 *
 * 실제 반영:
 *   cd functions && node scripts/set-diet-report-prompt.js --apply --credentials=<키.json>
 *
 * 다른 파일을 올리려면 --file=경로 (기본: docs/ai-diet-report-prompt.txt)
 *
 * 서비스 계정 JSON (Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성):
 *   - 환경변수 GOOGLE_APPLICATION_CREDENTIALS 에 파일 **전체 경로** (폴더 아님)
 *   - 또는 `--credentials=경로` (Git Bash에서 `/c/Users/.../키.json` 형식 권장)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const APP_ID = 'mealog-r0';
const DEFAULT_PROMPT_FILE = path.join(__dirname, '..', '..', 'docs', 'ai-diet-report-prompt.txt');

/** functions/index.js buildDietReportPromptText 가 실제로 치환하는 목록 */
const SUPPORTED_PLACEHOLDERS = ['date', 'weekday', 'mealText', 'profile', 'slotCoverage', 'recentTrend'];
const REQUIRED_PLACEHOLDERS = ['date', 'mealText'];

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

function resolveFlag(name) {
    for (const a of process.argv.slice(2)) {
        const m = a.match(new RegExp(`^--${name}=(.+)$`));
        if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
    return '';
}

function hasFlag(name) {
    return process.argv.slice(2).includes(`--${name}`);
}

function promptVersionFromText(text) {
    return `diet-${crypto.createHash('sha1').update(text).digest('hex').slice(0, 10)}`;
}

/** 붙여넣기 잘림·오타 치환자를 저장 전에 잡는다 */
function inspectTemplate(text) {
    const problems = [];
    for (const key of REQUIRED_PLACEHOLDERS) {
        if (!text.includes(`{{${key}}}`)) problems.push(`필수 치환자 {{${key}}} 없음`);
    }
    const used = [...new Set((text.match(/\{\{\s*[^}]*\}\}/g) || []))];
    const unknown = used.filter((t) => !SUPPORTED_PLACEHOLDERS.includes(t.replace(/[{}\s]/g, '')));
    if (unknown.length) problems.push(`지원하지 않는 치환자: ${unknown.join(', ')}`);
    return { used, problems };
}

async function main() {
    const apply = hasFlag('apply');
    const showOnly = hasFlag('show');
    const dryRun = hasFlag('dry-run') || (!apply && !showOnly);

    const credPath = resolveCredentialPath();
    if (!credPath) {
        console.error('서비스 계정 JSON을 찾지 못했습니다. --credentials=<키.json> 또는 GOOGLE_APPLICATION_CREDENTIALS 를 지정하세요.');
        process.exit(1);
    }
    initializeApp({ credential: cert(require(credPath)) });
    const db = getFirestore();
    const ref = db.doc(`artifacts/${APP_ID}/adminSettings/dietReportConfig`);

    const snap = await ref.get();
    const current = snap.exists ? snap.data() : {};
    const currentText = String(current.promptTemplate || '');
    console.log('── 현재 Firestore 프롬프트 ──');
    console.log(`  버전 : ${current.promptVersion || '(없음)'}`);
    console.log(`  길이 : ${currentText.length}자`);
    console.log(`  검증 : ${currentText ? promptVersionFromText(currentText) : '(본문 없음)'}`);
    if (currentText && current.promptVersion && promptVersionFromText(currentText) !== current.promptVersion) {
        console.log('  경고 : 저장된 promptVersion 이 본문 해시와 다릅니다.');
    }

    if (showOnly) return;

    const filePath = resolveFlag('file') || DEFAULT_PROMPT_FILE;
    if (!fs.existsSync(filePath)) {
        console.error(`프롬프트 파일이 없습니다: ${filePath}`);
        process.exit(1);
    }
    const text = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').trim();
    if (!text) {
        console.error('프롬프트 파일이 비어 있습니다.');
        process.exit(1);
    }
    const version = promptVersionFromText(text);
    const { used, problems } = inspectTemplate(text);

    console.log('');
    console.log('── 올릴 프롬프트 ──');
    console.log(`  파일 : ${filePath}`);
    console.log(`  길이 : ${text.length}자`);
    console.log(`  버전 : ${version}`);
    console.log(`  치환자 : ${used.length ? used.join(' ') : '(없음)'}`);

    if (problems.length) {
        console.error('');
        console.error('중단 — 프롬프트에 문제가 있습니다:');
        for (const p of problems) console.error(`  · ${p}`);
        process.exit(1);
    }

    if (currentText === text) {
        console.log('');
        console.log('현재 저장된 내용과 동일합니다. 변경할 것이 없습니다.');
        return;
    }

    if (dryRun) {
        console.log('');
        console.log(`드라이런입니다. 반영하려면 --apply 를 붙이세요. (${currentText.length}자 → ${text.length}자)`);
        return;
    }

    await ref.set(
        {
            promptTemplate: text,
            promptVersion: version,
            promptUpdatedAt: FieldValue.serverTimestamp(),
            promptUpdatedBy: 'script:set-diet-report-prompt'
        },
        { merge: true }
    );

    // 저장 후 되읽어 잘림 없이 들어갔는지 확인한다 — 이 스크립트를 만든 이유가 그것이다.
    const after = (await ref.get()).data() || {};
    const savedText = String(after.promptTemplate || '');
    const ok = savedText === text && after.promptVersion === version;
    console.log('');
    console.log(`저장 완료 · ${savedText.length}자 · 버전 ${after.promptVersion || '(없음)'}`);
    console.log(ok ? '검증 OK — 파일과 저장본이 완전히 같습니다.' : '검증 실패 — 저장본이 파일과 다릅니다.');
    if (!ok) process.exit(1);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}

// 검증용 — require 하면 Firestore 접속 없이 순수 함수만 쓸 수 있다
module.exports = { promptVersionFromText, inspectTemplate };
