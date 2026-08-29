/**
 * 기록 시트 개편(2026-08-12~19) 효과 소급 측정.
 *
 * 계측 이벤트가 서버 화이트리스트 누락으로 8/12~26 내내 유실됐다(afe192e 에서 수정).
 * 그래서 그 기간의 효과는 **meal 문서에 남은 흔적으로만** 잴 수 있다. 이 스크립트가
 * 그 계산을 재현 가능하게 고정한다 — 숫자를 한 번 뽑고 마는 대신, 표본이 쌓이면
 * 같은 명령으로 다시 돌려 추세를 본다.
 *
 * 설계는 docs/entry-sheet-rollout-metrics.md 에 있다. 요점 셋:
 *
 * 1. **도입일은 사용자마다 다르다.** 8/20~8/26 에 롤링으로 퍼졌다. 그래서 달력 날짜로
 *    전후를 가르면 안 되고, 사용자별 도입일을 기준으로 각자 자른다.
 * 2. **창은 대칭이어야 한다.** 도입 후 4일과 도입 전 14일을 비교하면 건수가 당연히
 *    줄어 보인다. 후 구간 길이 W 를 재고 전 구간도 딱 W 일만 쓴다.
 * 3. **진행 중인 날은 뺀다.** 오늘은 아직 끼니가 남아 하루 평균을 끌어내린다.
 *    W 가 4~6일뿐이라 하루가 20% 를 흔든다.
 *
 * 읽기 전용이다. 아무것도 쓰지 않는다.
 *
 *   cd functions && node scripts/entry-sheet-effect.js --credentials=<키.json>
 *   cd functions && node scripts/entry-sheet-effect.js --credentials=<키.json> --end=2026-09-09
 *   cd functions && node scripts/entry-sheet-effect.js --credentials=<키.json> --json > out.json
 *
 * 서비스 계정 JSON: 환경변수 GOOGLE_APPLICATION_CREDENTIALS 또는 --credentials=경로
 * (Git Bash 에서는 /c/Users/.../키.json 형식도 받는다)
 */
const fs = require('fs');
const path = require('path');

const APP_ID = 'mealog-r0';
const KST_OFFSET_MS = 9 * 3600 * 1000;

/**
 * 통계에서 뺄 UID — js/excluded-analytics-uids.js DEFAULT 과 같은 기본값.
 * 실행 시 adminSettings/excludedAnalyticsUids 를 읽어 덮어쓴다(그쪽이 정본).
 */
const FALLBACK_EXCLUDED_UIDS = [
    'kakao_4833862234',
    'IYRL3bfBhKUrwJM6tb8h4BVX8DF3',
    '4UDeI0Bts0gkwnnrt1WNRgjOQ5x2'
];

/** 도입 판정에 쓰는 필드 — 개편 이후 저장 경로에서만 생긴다 (entry-save-record.js) */
const ADOPTION_FIELD = 'categorySuggested';

/** 짝 비교에 넣을 최소 표본 — 이보다 적으면 하루 평균이 우연에 흔들린다 */
const MIN_ROWS_PER_WINDOW = 5;
const MIN_WINDOW_DAYS = 3;

/** 「같은 자리에서 이어 적은 것」으로 볼 간격 상한(초). 그보다 길면 다른 세션이다 */
const SESSION_GAP_MAX_SEC = 600;
/** 저장 직후 중복 이벤트를 거르는 하한 */
const SESSION_GAP_MIN_SEC = 5;

/** 채움률을 볼 선택 입력 — 필수가 아닌데도 채웠다면 그만큼 덜 귀찮았다는 뜻 */
const OPTIONAL_FIELDS = ['menuDetail', 'place', 'photos', 'rating', 'satiety'];

// ── 순수 계산 (Firestore 를 모른다 — test/entry-sheet-effect-model.test.mjs 가 검증) ──

/** ISO(UTC) → KST 날짜키. 못 읽으면 '' */
function kstDateKey(iso) {
    const t = Date.parse(String(iso || ''));
    if (!Number.isFinite(t)) return '';
    return new Date(t + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' + n일. 잘못된 입력이면 '' */
function addDays(dateKey, n) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return '';
    const d = new Date(`${dateKey}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return '';
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

/** 두 날짜키 사이의 일수 (b - a) */
function dayDiff(a, b) {
    const ta = Date.parse(`${a}T00:00:00Z`);
    const tb = Date.parse(`${b}T00:00:00Z`);
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return NaN;
    return Math.round((tb - ta) / 86400000);
}

function median(nums) {
    const s = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    if (!s.length) return null;
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 도입 전후 구간을 대칭으로 자른다.
 *
 * W = 도입일부터 endDate 까지의 일수. 도입 전도 딱 W 일만 본다.
 * W 가 짧으면(MIN_WINDOW_DAYS 미만) 비교 자체를 포기한다 — 요일 하나가 결과를 뒤집는다.
 *
 * @returns {{days: number, beforeLo: string, beforeHi: string, afterLo: string, afterHi: string}|null}
 */
function symmetricWindows(adoptDate, endDate) {
    const days = dayDiff(adoptDate, endDate) + 1;
    if (!Number.isFinite(days) || days < MIN_WINDOW_DAYS) return null;
    return {
        days,
        beforeLo: addDays(adoptDate, -days),
        beforeHi: addDays(adoptDate, -1),
        afterLo: adoptDate,
        afterHi: endDate
    };
}

/**
 * 사용자별 도입일 — ADOPTION_FIELD 가 처음 등장한 **기록일**(recordedAt 기준).
 *
 * 식사 날짜가 아니라 기록일인 이유: 도입은 "언제 새 시트로 적기 시작했나"이고,
 * 며칠 전 끼니를 오늘 적으면 식사 날짜는 과거를 가리킨다.
 *
 * @param {Map<string, object[]>} mealsByUid
 * @returns {Map<string, string>} uid → 'YYYY-MM-DD'
 */
function adoptionDateByUser(mealsByUid) {
    const out = new Map();
    for (const [uid, rows] of mealsByUid) {
        let first = '';
        for (const m of rows) {
            if (m == null || m[ADOPTION_FIELD] === undefined) continue;
            const dk = kstDateKey(m.recordedAt);
            if (dk && (!first || dk < first)) first = dk;
        }
        if (first) out.set(uid, first);
    }
    return out;
}

/**
 * 연속 입력 간격(초) — 「한 번 앉아서 적을 때 건당 얼마나 걸리나」의 대리 지표.
 *
 * 시트를 언제 열었는지는 기록에 없다. 남은 건 저장 시각(recordedAt)뿐이라, 같은 자리에서
 * 이어 적은 것들의 저장-저장 간격으로 대신 본다. 상한을 두는 이유는 "점심 적고 6시간 뒤
 * 저녁 적음"이 입력 시간으로 섞이지 않게 하기 위함이고, 하한은 저장 직후 중복을 거른다.
 *
 * 진짜 완주 시간은 entry_sheet_opened 가 쌓이면 그쪽으로 갈아탄다.
 */
function sessionGaps(isoList) {
    const t = isoList
        .map((x) => Date.parse(String(x || '')))
        .filter((x) => Number.isFinite(x))
        .sort((a, b) => a - b);
    const out = [];
    for (let i = 1; i < t.length; i++) {
        const g = (t[i] - t[i - 1]) / 1000;
        if (g > SESSION_GAP_MIN_SEC && g <= SESSION_GAP_MAX_SEC) out.push(g);
    }
    return out;
}

function isFilled(value) {
    if (Array.isArray(value)) return value.length > 0;
    if (value === undefined || value === null) return false;
    if (typeof value === 'number') return value > 0;
    return String(value).trim() !== '';
}

/**
 * 한 구간의 지표.
 * @param {object[]} rows 그 구간에 **기록된** meal 문서
 * @param {number} windowDays 구간 길이(일) — 하루 평균의 분모
 */
function summarizeWindow(rows, windowDays) {
    const n = rows.length;
    const safe = (x) => (n ? x / n : 0);
    return {
        n,
        perDay: windowDays > 0 ? n / windowDays : 0,
        filled: Object.fromEntries(
            OPTIONAL_FIELDS.map((f) => [f, safe(rows.filter((m) => isFilled(m[f])).length)])
        ),
        gapMedianSec: median(sessionGaps(rows.map((m) => m.recordedAt))),
        // 기록일 ≠ 식사일 = 밀린 것을 나중에 몰아 적음
        retroRate: safe(rows.filter((m) => kstDateKey(m.recordedAt) !== m.date).length)
    };
}

/**
 * 짝 비교 — 같은 사용자의 도입 전/후를 1:1 로 놓는다.
 *
 * 사용자 간 비교를 하지 않는 이유: 기록 습관의 개인차가 개편 효과보다 훨씬 크다.
 * 하루 5건 적는 사람과 1건 적는 사람을 평균 내면 전자의 변화만 보인다.
 *
 * @param {Map<string, object[]>} mealsByUid
 * @param {Map<string, string>} adoption
 * @param {string} endDate 마지막으로 셀 날짜(진행 중인 날은 제외하고 넘긴다)
 */
function pairedComparison(mealsByUid, adoption, endDate) {
    const per = [];
    const skipped = { noAdoption: 0, windowTooShort: 0, tooFewRows: 0 };
    for (const [uid, rows] of mealsByUid) {
        const adopt = adoption.get(uid);
        if (!adopt) {
            skipped.noAdoption++;
            continue;
        }
        const w = symmetricWindows(adopt, endDate);
        if (!w) {
            skipped.windowTooShort++;
            continue;
        }
        const inRange = (lo, hi) =>
            rows.filter((m) => {
                const dk = kstDateKey(m.recordedAt);
                return dk && dk >= lo && dk <= hi;
            });
        const before = inRange(w.beforeLo, w.beforeHi);
        const after = inRange(w.afterLo, w.afterHi);
        if (before.length < MIN_ROWS_PER_WINDOW || after.length < MIN_ROWS_PER_WINDOW) {
            skipped.tooFewRows++;
            continue;
        }
        per.push({
            uid,
            adoptDate: adopt,
            windowDays: w.days,
            before: summarizeWindow(before, w.days),
            after: summarizeWindow(after, w.days)
        });
    }
    return { per, skipped };
}

/** 사용자 평균 (사용자마다 한 표 — 많이 적는 사람이 결과를 독식하지 않게) */
function meanOver(per, pick) {
    const vals = per.map(pick).filter((v) => Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

/**
 * 분류 제안 수용률 — categorySource 분포.
 *
 *   local/ai = 제안을 그대로 두고 저장(수용)   user = 사용자가 다른 값으로 고침(교정)
 *   dismissed = 제안을 거부                    none = 출처가 안 찍힘
 */
function categoryAcceptance(mealsByUid) {
    const counts = { local: 0, ai: 0, user: 0, dismissed: 0, none: 0 };
    for (const [, rows] of mealsByUid) {
        for (const m of rows) {
            if (m[ADOPTION_FIELD] === undefined) continue;
            const src = String(m.categorySource || '').trim();
            if (src && Object.prototype.hasOwnProperty.call(counts, src)) counts[src]++;
            else counts.none++;
        }
    }
    const decided = counts.local + counts.ai + counts.user;
    return {
        counts,
        decided,
        // 제안이 결론까지 간 것 중 사용자가 고친 비율 = 오분류율
        correctionRate: decided ? counts.user / decided : null
    };
}

// ── CLI ──

function credentialPathCandidates(raw) {
    const candidates = [];
    if (!raw) return candidates;
    candidates.push(path.resolve(raw));
    candidates.push(raw);
    // Git Bash: /c/Users/... → C:\Users\...
    const m = raw.match(/^\/([a-zA-Z])\/(.*)$/);
    if (m) candidates.push(`${m[1].toUpperCase()}:${path.sep}${m[2].split('/').join(path.sep)}`);
    return [...new Set(candidates)];
}

function resolveCredentialPath() {
    const argv = process.argv.slice(2);
    const flag = argv.find((a) => /^--(?:credentials|cred)=/.test(a)) || '';
    const fromFlag = flag ? flag.slice(flag.indexOf('=') + 1) : '';
    const fromLoose = argv.find((a) => !a.startsWith('--') && a.endsWith('.json'));
    const raw = (fromFlag || fromLoose || process.env.GOOGLE_APPLICATION_CREDENTIALS || '')
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

function resolveFlag(name) {
    const m = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
    return m ? m.slice(name.length + 3).trim().replace(/^["']|["']$/g, '') : '';
}

const pct = (x) => (x == null ? '-' : `${(x * 100).toFixed(1)}%`);
const num = (x, d = 2) => (x == null ? '-' : x.toFixed(d));

function printReport(out) {
    const { endDate, adoptionHistogram, paired, acceptance, usageDaily } = out;
    console.log(`\n기록 시트 개편 효과 — 기준일 ${endDate} (진행 중인 날 제외)`);
    console.log('─'.repeat(66));

    console.log('\n[1] 도입일 분포 — categorySuggested 최초 등장');
    const keys = Object.keys(adoptionHistogram).sort();
    if (!keys.length) {
        console.log('   (도입한 사용자가 없습니다 — 개편이 아직 안 나갔거나 필드가 안 남습니다)');
    }
    keys.forEach((d) => {
        const n = adoptionHistogram[d];
        console.log(`   ${d}  ${'#'.repeat(Math.min(40, n))} ${n}명`);
    });

    const per = paired.per;
    console.log(`\n[2] 짝 비교 — ${per.length}명 (도입 전 W일 : 후 W일, 대칭)`);
    console.log(
        `   제외: 미도입 ${paired.skipped.noAdoption} · 창 짧음 ${paired.skipped.windowTooShort}` +
            ` · 표본 부족 ${paired.skipped.tooFewRows}`
    );
    if (per.length) {
        const wDays = per.map((p) => p.windowDays);
        console.log(`   창 길이 W: ${Math.min(...wDays)}~${Math.max(...wDays)}일 (중앙 ${median(wDays)}일)`);
        console.log('\n   지표(사용자 평균)          개편 전 →   개편 후');
        const row = (label, b, a, fmt) => {
            const d = b == null || a == null ? null : a - b;
            const arrow = d == null ? ' ' : d > 0 ? '▲' : d < 0 ? '▼' : '=';
            console.log(`   ${label.padEnd(22)} ${fmt(b).padStart(8)} → ${fmt(a).padStart(8)}  ${arrow}`);
        };
        row('하루 기록 수', meanOver(per, (p) => p.before.perDay), meanOver(per, (p) => p.after.perDay), (x) => num(x));
        for (const f of OPTIONAL_FIELDS) {
            row(`채움률 ${f}`, meanOver(per, (p) => p.before.filled[f]), meanOver(per, (p) => p.after.filled[f]), pct);
        }
        row('소급입력 비율', meanOver(per, (p) => p.before.retroRate), meanOver(per, (p) => p.after.retroRate), pct);
        row(
            '연속입력 간격(초)',
            median(per.map((p) => p.before.gapMedianSec)),
            median(per.map((p) => p.after.gapMedianSec)),
            (x) => num(x, 0)
        );
        const up = per.filter((p) => p.after.perDay > p.before.perDay).length;
        console.log(`\n   하루 기록 수가 늘어난 사용자: ${up}/${per.length}`);
    }

    console.log('\n[3] 분류 제안 — 수용/교정');
    const c = acceptance.counts;
    const total = c.local + c.ai + c.user + c.dismissed + c.none;
    console.log(`   제안이 남은 기록 ${total}건`);
    console.log(
        `   그대로 저장 local ${c.local} · ai ${c.ai}   사용자가 고침 ${c.user}` +
            `   거부 ${c.dismissed}   출처없음 ${c.none}`
    );
    console.log(`   교정률(오분류) = ${pct(acceptance.correctionRate)}  ← 낮을수록 분류기가 맞다`);

    console.log('\n[4] 완주율 — usageDaily 계측');
    if (!usageDaily || !usageDaily.days) {
        console.log('   (아직 데이터 없음 — 클라이언트 배포 후 쌓입니다)');
    } else {
        const u = usageDaily;
        console.log(
            `   집계일 ${u.days}일   열기 ${u.opened} · 저장 ${u.saved}` +
                ` · 내용없이닫음 ${u.abandoned} · 쓰다버림 ${u.discarded}`
        );
        console.log(`   완주율 = ${pct(u.opened ? u.saved / u.opened : null)}`);
        const lost = u.opened - u.saved - u.abandoned - u.discarded;
        if (lost > 0) console.log(`   ! 결과가 안 잡힌 세션 ${lost}건 (앱이 그대로 종료된 경우)`);
    }

    console.log(`\n${'─'.repeat(66)}`);
    const medW = per.length ? median(per.map((p) => p.windowDays)) : null;
    if (medW != null && medW < 14) {
        console.log('! 창이 2주 미만입니다. 요일 구성이 사용자마다 달라 방향만 참고하고,');
        console.log('  결론은 전원이 2주를 채운 뒤에 내리세요 (docs/entry-sheet-rollout-metrics.md).');
    }
    console.log('');
}

async function main() {
    const credPath = resolveCredentialPath();
    if (!credPath) {
        console.error('서비스 계정 JSON 을 찾지 못했습니다. --credentials=<키.json> 또는 GOOGLE_APPLICATION_CREDENTIALS');
        process.exit(1);
    }
    const { initializeApp, cert } = require('firebase-admin/app');
    const { getFirestore } = require('firebase-admin/firestore');
    initializeApp({ credential: cert(require(credPath)) });
    const db = getFirestore();

    // 기본 기준일 = 어제 (오늘은 아직 끼니가 남아 하루 평균을 끌어내린다)
    const endDate = resolveFlag('end') || addDays(kstDateKey(new Date().toISOString()), -1);
    const asJson = process.argv.slice(2).includes('--json');

    let excluded = new Set(FALLBACK_EXCLUDED_UIDS);
    try {
        const snap = await db.doc(`artifacts/${APP_ID}/adminSettings/excludedAnalyticsUids`).get();
        const uids = snap.exists ? snap.data()?.uids : null;
        if (Array.isArray(uids)) excluded = new Set(uids);
    } catch (e) {
        console.error('! 제외 UID 문서를 못 읽어 기본값을 씁니다:', e?.message || e);
    }

    const snap = await db.collectionGroup('meals').get();
    const mealsByUid = new Map();
    snap.forEach((d) => {
        const uid = d.ref.path.split('/')[3];
        if (!uid || excluded.has(uid)) return;
        const m = d.data();
        if (!m || m.slotId === 'daily_journal') return;
        if (typeof m.recordedAt !== 'string' || !m.recordedAt) return;
        if (!mealsByUid.has(uid)) mealsByUid.set(uid, []);
        mealsByUid.get(uid).push(m);
    });

    const adoption = adoptionDateByUser(mealsByUid);
    const adoptionHistogram = {};
    for (const d of adoption.values()) adoptionHistogram[d] = (adoptionHistogram[d] || 0) + 1;

    // 완주율 계측 (afe192e 배포 + 클라이언트 배포 이후에만 쌓인다)
    const usage = { days: 0, opened: 0, saved: 0, abandoned: 0, discarded: 0 };
    try {
        const ud = await db.collection(`artifacts/${APP_ID}/usageDaily`).get();
        ud.forEach((d) => {
            const v = d.data() || {};
            if (!v.entry_sheet_opened) return;
            usage.days++;
            usage.opened += v.entry_sheet_opened || 0;
            usage.saved += v.entry_sheet_saved || 0;
            usage.abandoned += v.entry_sheet_abandoned || 0;
            usage.discarded += v.entry_sheet_discarded || 0;
        });
    } catch (e) {
        console.error('! usageDaily 를 못 읽었습니다:', e?.message || e);
    }

    const out = {
        endDate,
        totalUsers: mealsByUid.size,
        totalMeals: [...mealsByUid.values()].reduce((s, r) => s + r.length, 0),
        adoptionHistogram,
        paired: pairedComparison(mealsByUid, adoption, endDate),
        acceptance: categoryAcceptance(mealsByUid),
        usageDaily: usage
    };

    if (asJson) console.log(JSON.stringify(out, null, 2));
    else printReport(out);
    process.exit(0);
}

module.exports = {
    kstDateKey,
    addDays,
    dayDiff,
    median,
    symmetricWindows,
    adoptionDateByUser,
    sessionGaps,
    isFilled,
    summarizeWindow,
    pairedComparison,
    meanOver,
    categoryAcceptance,
    OPTIONAL_FIELDS,
    MIN_ROWS_PER_WINDOW,
    MIN_WINDOW_DAYS
};

if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
