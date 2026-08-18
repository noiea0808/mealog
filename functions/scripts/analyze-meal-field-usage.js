/**
 * meals 원본 필드 사용률 분석 (읽기 전용 — 아무것도 쓰지 않음)
 *
 * 배경: 관리자 엑셀 내보내기는 어디서_상세를 placeDetail||placeMemo에서 읽는데
 * 이 필드들은 저장 코드가 쓰지 않는 유령 필드다. 또 mealType(집밥/외식 메인 태그)은
 * 엑셀에서 category가 비었을 때만 '무엇을'로 새어 나와 태그 사용률을 정확히 잴 수 없다.
 * 이 스크립트는 Firestore 원본에서 필드별 실제 입력률을 직접 센다.
 *
 * 실행: node functions/scripts/analyze-meal-field-usage.js <서비스계정.json 경로> [시작일] [종료일]
 *   예: node functions/scripts/analyze-meal-field-usage.js C:/keys/mealog.json 2026-07-01 2026-08-12
 *   경로 생략 시 GOOGLE_APPLICATION_CREDENTIALS 사용.
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
    const m = raw.match(/^\/([a-zA-Z])\/(.*)$/);
    if (m) {
        candidates.push(`${m[1].toUpperCase()}:${path.sep}${m[2].split('/').join(path.sep)}`);
    }
    return [...new Set(candidates)];
}

function resolveCredentialPath() {
    const raw = (process.argv[2] || process.env.GOOGLE_APPLICATION_CREDENTIALS || '')
        .trim()
        .replace(/^["']|["']$/g, '');
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

const FIELDS = [
    'mealType', 'category', 'snackType', 'snackPlaceMain',
    'place', 'placeType', 'placeDetail', 'placeMemo',
    'withWhom', 'withWhomDetail', 'menuDetail', 'comment',
    'rating', 'satiety', 'photos',
];

function has(v) {
    if (v == null) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.length > 0;
    return true;
}

async function main() {
    const keyPath = resolveCredentialPath();
    if (!keyPath) {
        console.error('[오류] 서비스 계정 JSON 경로를 인자 또는 GOOGLE_APPLICATION_CREDENTIALS로 지정하세요.');
        process.exit(1);
    }
    const startDate = process.argv[3] || '2026-07-01';
    const endDate = process.argv[4] || '2026-08-12';

    initializeApp({ credential: cert(JSON.parse(fs.readFileSync(keyPath, 'utf8'))) });
    const db = getFirestore();

    // collection group 인덱스에 의존하지 않도록 사용자별 서브컬렉션을 순회한다
    const usersSnap = await db.collection('artifacts').doc(APP_ID).collection('users').listDocuments();
    console.log(`사용자 문서 ${usersSnap.length}개, 기간 ${startDate}~${endDate}`);

    const counts = Object.fromEntries(FIELDS.map((f) => [f, 0]));
    const valueDist = { mealType: {}, category: {}, snackType: {}, withWhom: {} };
    let total = 0;
    let usersWithRecords = 0;
    const fieldUsers = Object.fromEntries(FIELDS.map((f) => [f, new Set()]));

    for (const userRef of usersSnap) {
        const mealsSnap = await userRef
            .collection('meals')
            .where('date', '>=', startDate)
            .where('date', '<=', endDate)
            .get();
        if (mealsSnap.empty) continue;
        usersWithRecords++;
        for (const doc of mealsSnap.docs) {
            const d = doc.data();
            total++;
            for (const f of FIELDS) {
                if (has(d[f])) {
                    counts[f]++;
                    fieldUsers[f].add(userRef.id);
                }
            }
            for (const f of Object.keys(valueDist)) {
                if (has(d[f])) valueDist[f][d[f]] = (valueDist[f][d[f]] || 0) + 1;
            }
        }
    }

    console.log(`\n총 기록 ${total}건 / 기록 보유 사용자 ${usersWithRecords}명\n`);
    console.log('필드별 입력률 (건수 · 비율 · 사용자수):');
    for (const f of FIELDS) {
        const pct = total ? ((counts[f] / total) * 100).toFixed(1) : '0';
        console.log(`  ${f.padEnd(16)} ${String(counts[f]).padStart(5)}건  ${pct.padStart(5)}%  ${fieldUsers[f].size}명`);
    }
    for (const [f, dist] of Object.entries(valueDist)) {
        const top = Object.entries(dist).sort((a, b) => b[1] - a[1]).slice(0, 10);
        console.log(`\n${f} 상위값:`);
        for (const [v, c] of top) console.log(`  ${v}: ${c}`);
    }
}

main().catch((e) => {
    console.error('실패:', e.message);
    process.exit(1);
});
