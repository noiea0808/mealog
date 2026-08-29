/**
 * 사용자 슬롯 계획(slotPlan) — 순수 함수 계층 (docs/user-slot-plan.md)
 *
 * 두 층의 대전제:
 * - 기준 슬롯(base) 7개는 집계축. `meals.slotId` 는 영원히 이 중 하나다.
 * - 사용자 슬롯은 표시축. 이 모듈 밖의 서버·Functions·관리자 코드는
 *   slotPlan/slotKey 를 읽지 않는다.
 *
 * 이 파일의 함수는 전부 순수하다 — window·appState·Firestore 를 만지지 않는다.
 * 저장 경로(전용 saveSlotPlan)는 별도 모듈이 맡는다 (§5.1).
 */
import { SLOTS } from '../constants.js';

export const SLOT_PLAN_SCHEMA = 1;
/**
 * 상한은 둘이고, 세는 대상이 다르다.
 *
 * - `MAX_ENABLED_SLOTS` — **피커에 보이는 수**. 두 열 × 6줄이 한 화면이라는 제약.
 * - `MAX_SLOTS_PER_REVISION` — 저장 배열 총 길이(해제분 포함). 슬롯 삭제가 없으므로
 *   (해제만 가능) 안 쓰는 슬롯이 목록에 쌓이는데, 그게 피커 상한을 먹으면 안 된다.
 *
 * 총 상한에 닿으면 새로 만드는 대신 **해제된 슬롯을 되살려 이름을 고치는** 길이 있다 —
 * 그래서 막다른 길이 아니다.
 */
export const MAX_ENABLED_SLOTS = 12;
export const MAX_SLOTS_PER_REVISION = 24;
export const SLOT_LABEL_MAX_CHARS = 12;
/** 개정판 수가 이 값을 넘으면 진단 로그만 남긴다 — 가지치기하지 않는다 (§5.6) */
export const REVISION_COUNT_DIAG_THRESHOLD = 200;

const BASE_IDS = new Set(SLOTS.map((s) => s.id));

/* ── key 생성 ──────────────────────────────────────────────── */

/**
 * 슬롯 key: 타임스탬프(base36, 9자 고정폭) + 랜덤 4자.
 *
 * 고정폭이 계약이다 — "가장 오래된 key" 판정(§3)이 문자열 비교로 곧
 * 시간 비교가 되게 한다. 9자는 서기 5138년까지 안 넘친다.
 * key 는 사용자 문서 안에서 영구 유일이며 재사용하지 않는다 (§8-2).
 *
 * @param {number} [nowMs]  테스트 주입용
 * @param {() => number} [rng]  테스트 주입용 (0~1)
 */
export function generateSlotKey(nowMs = Date.now(), rng = Math.random) {
    const ts = nowMs.toString(36).padStart(9, '0');
    let rand = '';
    for (let i = 0; i < 4; i++) {
        rand += Math.floor(rng() * 36).toString(36);
    }
    return `${ts}${rand}`;
}

/** 두 key 중 먼저 만들어진 것이 음수 — null(기본 슬롯의 key)은 항상 가장 오래됐다 */
export function compareSlotKeys(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
}

/* ── 기본값 ────────────────────────────────────────────────── */

/**
 * slotPlan 이 없는 사용자의 사용자 슬롯 = 기준 슬롯 7개 그대로.
 * key 는 null — "원래부터 있던 슬롯"의 표식이며, 개정판을 처음 만들 때
 * 실제 key 로 구체화된다.
 */
export function defaultUserSlots() {
    return SLOTS.map((s) => ({ key: null, base: s.id, label: s.label, enabled: true }));
}

/* ── 검증 ──────────────────────────────────────────────────── */

/**
 * 슬롯 배열 정화 — 다른 기기·구버전이 쓴 값을 신뢰하지 않는다.
 * 모르는 base·빈 라벨은 버리고, 12개 상한으로 자른다.
 * 전부 버려지면 null — 호출부는 기본값으로 폴백한다.
 */
export function sanitizeSlots(rawSlots) {
    if (!Array.isArray(rawSlots)) return null;
    const out = [];
    const seenKeys = new Set();
    for (const s of rawSlots) {
        if (!s || typeof s !== 'object') continue;
        if (!BASE_IDS.has(s.base)) continue;
        const label = typeof s.label === 'string' ? s.label.trim().slice(0, SLOT_LABEL_MAX_CHARS) : '';
        if (!label) continue;
        const key = typeof s.key === 'string' && s.key ? s.key : null;
        if (key != null) {
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
        }
        out.push({ key, base: s.base, label, enabled: s.enabled !== false });
        if (out.length >= MAX_SLOTS_PER_REVISION) break;
    }
    return out.length > 0 ? out : null;
}

function isIsoDate(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function addDaysIso(iso, days) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d + days);
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${dt.getFullYear()}-${mm}-${dd}`;
}

/* ── 개정판 해석 ───────────────────────────────────────────── */

/**
 * 유효한 개정판 날짜 목록(오름차순). 시계 방어(§5.5): 오늘+1일보다
 * 미래인 개정판은 없는 것으로 취급한다 — 지우지는 않는다.
 */
export function listRevisionDates(plan, todayIso) {
    const revisions = plan && typeof plan === 'object' ? plan.revisions : null;
    if (!revisions || typeof revisions !== 'object') return [];
    const cutoff = isIsoDate(todayIso) ? addDaysIso(todayIso, 1) : null;
    return Object.keys(revisions)
        .filter((d) => isIsoDate(d) && (!cutoff || d <= cutoff))
        .sort();
}

/**
 * 그 날짜의 유효 개정판 슬롯 배열. effectiveFrom <= date 인 마지막 개정판 (§2.1).
 * 없거나 내용이 전부 무효면 null — 호출부가 기본값으로 폴백한다.
 */
export function revisionSlotsForDate(plan, dateIso, todayIso) {
    if (!isIsoDate(dateIso)) return null;
    const dates = listRevisionDates(plan, todayIso);
    for (let i = dates.length - 1; i >= 0; i--) {
        if (dates[i] <= dateIso) {
            return sanitizeSlots(plan.revisions[dates[i]]?.slots);
        }
    }
    return null;
}

/**
 * 그 날짜의 사용자 슬롯 목록 — 항상 비어 있지 않다.
 *
 * ⚠️ 필터링용이 아니다 (불변식 4). enabled:false 슬롯도 포함해서 돌려준다.
 * 피커만 enabled 로 거른다 — 타임라인·공유카드가 이걸로 기록을 걸러내면
 * 사용자는 자기 기록을 잃는다.
 */
export function effectiveSlots(userSettings, dateIso, todayIso) {
    const plan = userSettings && typeof userSettings === 'object' ? userSettings.slotPlan : null;
    return revisionSlotsForDate(plan, dateIso, todayIso) || defaultUserSlots();
}

/* ── 기록 → 슬롯 해석 (§3) ─────────────────────────────────── */

/**
 * slotKey 를 **모든** 개정판에서 찾는다 — 날짜로 좁히지 않는다 (§3).
 * 최신 개정판부터 훑는다: 이름 소급 갱신(§3.1)이 어떤 이유로 일부 개정판에만
 * 반영됐어도 가장 최근 이름을 얻는다.
 */
export function findSlotByKey(plan, slotKey, todayIso) {
    if (typeof slotKey !== 'string' || !slotKey) return null;
    if (!plan || typeof plan !== 'object') return null;
    const dates = listRevisionDates(plan, todayIso);
    for (let i = dates.length - 1; i >= 0; i--) {
        const slots = sanitizeSlots(plan.revisions[dates[i]]?.slots);
        const hit = slots && slots.find((s) => s.key === slotKey);
        if (hit) return hit;
    }
    // 개정판에서 완전히 사라진 슬롯 — 폐기 이름으로 답한다 (§3.2)
    return retiredSlotByKey(plan, slotKey);
}

/**
 * base 가 같은 슬롯 중 **key 가 가장 오래된 것** = 그 base 의 원본 (§3).
 * 표시 순서 기준이 아니다 — 순서 끌기로 폴백 귀속이 흔들리면 안 된다.
 */
export function oldestSlotForBase(slots, baseId) {
    let best = null;
    for (const s of Array.isArray(slots) ? slots : []) {
        if (s.base !== baseId) continue;
        if (!best || compareSlotKeys(s.key, best.key) < 0) best = s;
    }
    return best;
}

/**
 * base 마다 하나씩인 **원본 슬롯**의 집합 (객체 참조 기준).
 *
 * 원본은 지울 수 없고 해제만 된다. 두 이유가 겹친다:
 * 1. 원본이 사라지면 그 시간대로 새 슬롯을 만들 길이 없어진다 — 복제가 유일한
 *    추가 경로이므로(§4.2) 복제할 원본이 남아 있어야 한다.
 * 2. `slotKey` 없는 옛 기록의 폴백 귀속처가 원본이다(§3). 사라지면 라벨이 흔들린다.
 */
export function originalSlotSet(slots) {
    const byBase = new Map();
    for (const s of Array.isArray(slots) ? slots : []) {
        if (!s) continue;
        const cur = byBase.get(s.base);
        if (!cur || compareSlotKeys(s.key, cur.key) < 0) byBase.set(s.base, s);
    }
    return new Set(byBase.values());
}

/**
 * key 없는 슬롯(기본 7개)에 실제 key 를 붙인 새 배열. 목록 순서대로 매기므로
 * 구체화 후에도 "가장 오래된 key = 원본"이 성립한다.
 *
 * 설정 시트는 **열 때** 이걸 부른다. 저장 때 부르면 그 사이 만든 복제본의 key 가
 * 원본보다 오래돼 원본 판정이 뒤집힌다(복제 시각 < 저장 시각).
 */
export function materializeSlotKeys(slots, nowMs = Date.now(), rng = Math.random) {
    let seq = 0;
    return (Array.isArray(slots) ? slots : []).map((s) =>
        s && s.key == null ? { ...s, key: generateSlotKey(nowMs + seq++, rng) } : s
    );
}

/**
 * 기록 하나의 표시 슬롯을 해석한다. 절대 실패하지 않는다 (§3 폴백 사슬).
 *
 * 반환의 base 로 기존 SLOT_STYLES[base]·getSlotLucideIcon(base)·type 판정을
 * 그대로 쓴다 — 아이콘·색·본식/간식 구분은 base 의 것이다.
 *
 * @returns {{ label: string, base: string, slotKey: string|null,
 *             matchedBy: 'key'|'base'|'default' }}
 */
export function resolveSlotView(record, userSettings, todayIso) {
    const slotId = record?.slotId;
    const plan = userSettings && typeof userSettings === 'object' ? userSettings.slotPlan : null;

    const byKey = plan ? findSlotByKey(plan, record?.slotKey, todayIso) : null;
    if (byKey) {
        return { label: byKey.label, base: byKey.base, slotKey: byKey.key, matchedBy: 'key' };
    }

    if (plan && isIsoDate(record?.date)) {
        const slots = revisionSlotsForDate(plan, record.date, todayIso);
        const byBase = slots ? oldestSlotForBase(slots, slotId) : null;
        if (byBase) {
            return { label: byBase.label, base: byBase.base, slotKey: byBase.key, matchedBy: 'base' };
        }
    }

    const def = SLOTS.find((s) => s.id === slotId);
    return {
        label: def ? def.label : '기록',
        base: def ? def.id : 'lunch',
        slotKey: null,
        matchedBy: 'default'
    };
}

/* ── 개정판 편집 (순수 — 저장은 호출부 몫) ─────────────────── */

/**
 * "사용자가 뭔가 바꿨나?" — 비대칭이다. `current`(저장된 값·기본값) 쪽의 key 가
 * null 이면 어떤 key 와도 같다고 본다: 설정 시트가 열면서 붙인 key 는 사용자의
 * 편집이 아니므로, 그것만으로 개정판이 생기면 안 된다(§5.6 성장 억제).
 *
 * @param {Array} current 저장된(또는 기본) 슬롯 — key 가 null 일 수 있는 쪽
 * @param {Array} next 편집 결과 — key 가 다 채워진 쪽
 */
function slotsEqual(current, next) {
    if (!Array.isArray(current) || !Array.isArray(next) || current.length !== next.length) return false;
    return current.every(
        (s, i) =>
            (s.key == null || s.key === next[i].key) &&
            s.base === next[i].base &&
            s.label === next[i].label &&
            s.enabled === next[i].enabled
    );
}

/**
 * `effectiveFrom` 날짜의 개정판으로 nextSlots 를 넣은 **새 plan** 을 돌려준다.
 * 그 날짜에 이미 유효하던 구성과 완전히 같으면 원본 plan 을 그대로 돌려준다 —
 * 성장 억제(§5.6). 호출부는 참조 동일성으로 "저장 불필요"를 안다.
 *
 * 날짜는 **사용자가 고른다**(§4.2.3). 27일에 저장하고 29일에 또 저장하면
 * 27·28일은 27일 구성, 29일부터는 29일 구성이 된다 — 맵이라 서로 안 지운다.
 *
 * key 가 null 인 기본 슬롯은 여기서 실제 key 로 구체화한다. 이때 생성 순서를
 * 목록 순서로 하므로, 구체화 후에도 "가장 오래된 key = 원본" 이 성립한다.
 *
 * @param {string} effectiveFrom YYYY-MM-DD — 이 날짜 기록부터 적용
 * @param {string} [todayIso] 시계 방어 기준(§5.5). 생략하면 effectiveFrom
 * @param {{ overwriteLater?: boolean }} [opts] overwriteLater 면 이 날짜보다 뒤의
 *        개정판도 같은 내용으로 덮어쓴다 (§4.2.4). 기본 false
 */
export function withRevisionOn(plan, effectiveFrom, nextSlots, nowMs = Date.now(), rng = Math.random, todayIso = effectiveFrom, opts = {}) {
    if (!isIsoDate(effectiveFrom)) return plan;
    const cleaned = sanitizeSlots(nextSlots);
    if (!cleaned) return plan;

    /**
     * 성장 억제 비교는 key 구체화 **전**에 한다. UI 는 effectiveSlots 가 준
     * 목록(기본 슬롯이면 key:null)을 편집해 돌려주므로, 안 건드렸으면 여기서
     * 그대로 같다. 구체화 후에 비교하면 새 key 때문에 항상 "달라진" 걸로
     * 보여서, 설정을 열고 그냥 닫아도 개정판이 생긴다 (§5.1·§5.6 위반).
     */
    const current = revisionSlotsForDate(plan, effectiveFrom, todayIso) || defaultUserSlots();

    /**
     * 뒤 개정판 통일(§4.2.4) — 사용자가 명시적으로 골랐을 때만.
     * 지우지 않고 **같은 내용으로 덮어쓴다**. 삭제는 `deleteField` 센티널이
     * 필요해 아웃박스 payload 를 탈 수 없고(§5.2), §5.6 과도 부딪힌다.
     * 맵 갱신만으로 같은 결과를 얻는다.
     */
    const laterDates = opts.overwriteLater
        ? Object.keys(plan?.revisions || {}).filter((d) => isIsoDate(d) && d > effectiveFrom).sort()
        : [];
    const laterNeedsWrite = laterDates.some(
        (d) => !slotsEqual(sanitizeSlots(plan.revisions[d]?.slots) || [], cleaned)
    );

    if (slotsEqual(current, cleaned) && !laterNeedsWrite) return plan;

    let seq = 0;
    const materialized = cleaned.map((s) =>
        s.key != null ? s : { ...s, key: generateSlotKey(nowMs + seq++, rng) }
    );

    const base = plan && typeof plan === 'object' && plan.revisions ? plan : { schema: SLOT_PLAN_SCHEMA, revisions: {} };
    const nextRevisions = {
        ...base.revisions,
        [effectiveFrom]: { createdAt: nowMs, slots: materialized }
    };
    for (const d of laterDates) {
        nextRevisions[d] = { createdAt: nowMs, slots: materialized };
    }

    /**
     * 이 저장으로 **어느 개정판에서도 사라지는** key 를 이름과 함께 남긴다 (§3.2).
     *
     * 같은 날짜 키의 개정판을 덮어쓰면(같은 날 만들고 같은 날 삭제) 그 슬롯의
     * key 가 통째로 증발한다. 그러면 그 슬롯으로 남긴 기록이 기준 슬롯 이름으로
     * 되돌아가, §3 이 약속한 "한 번 붙은 이름은 영원히 유지된다"가 깨진다.
     * 기록 자체는 무사하지만 약속은 약속이다.
     */
    const gone = collectRevisionKeys(base);
    for (const k of collectRevisionKeys({ revisions: nextRevisions }).keys()) gone.delete(k);

    const prevRetired = base.retired && typeof base.retired === 'object' ? base.retired : null;
    const retired = gone.size > 0 || prevRetired ? { ...prevRetired } : null;
    for (const [k, v] of gone) retired[k] = v;

    const next = {
        ...base,
        schema: SLOT_PLAN_SCHEMA,
        revisions: nextRevisions
    };
    if (retired) next.retired = retired;
    return next;
}

/**
 * 개정판 전체에서 key → { base, label } 을 모은다. 나중 개정판이 이긴다
 * (Object.values 는 삽입 순서이고 날짜 키는 대체로 오름차순으로 들어온다 —
 * 정확한 최신값이 아니어도 폐기 이름의 근사로 충분하다).
 */
function collectRevisionKeys(plan) {
    const out = new Map();
    const revisions = plan && typeof plan === 'object' ? plan.revisions : null;
    if (!revisions || typeof revisions !== 'object') return out;
    for (const date of Object.keys(revisions).sort()) {
        for (const s of Array.isArray(revisions[date]?.slots) ? revisions[date].slots : []) {
            if (!s || typeof s.key !== 'string' || !s.key) continue;
            if (!BASE_IDS.has(s.base)) continue;
            const label = typeof s.label === 'string' ? s.label.trim().slice(0, SLOT_LABEL_MAX_CHARS) : '';
            if (!label) continue;
            out.set(s.key, { base: s.base, label });
        }
    }
    return out;
}

/** 폐기된 슬롯(어느 개정판에도 없는 key)의 이름 — §3 폴백의 마지막 보루 */
function retiredSlotByKey(plan, slotKey) {
    const r = plan && typeof plan === 'object' && plan.retired && typeof plan.retired === 'object'
        ? plan.retired[slotKey]
        : null;
    if (!r || !BASE_IDS.has(r.base)) return null;
    const label = typeof r.label === 'string' ? r.label.trim().slice(0, SLOT_LABEL_MAX_CHARS) : '';
    return label ? { key: slotKey, base: r.base, label, enabled: false } : null;
}

/**
 * 이름 소급 갱신(§3.1) — 모든 개정판에서 같은 key 의 label 을 바꾼 새 plan.
 * key 가 어디에도 없으면 원본을 그대로 돌려준다.
 */
export function renameSlotEverywhere(plan, slotKey, newLabel) {
    const label = typeof newLabel === 'string' ? newLabel.trim().slice(0, SLOT_LABEL_MAX_CHARS) : '';
    if (!label || typeof slotKey !== 'string' || !slotKey) return plan;
    const revisions = plan && typeof plan === 'object' ? plan.revisions : null;
    if (!revisions || typeof revisions !== 'object') return plan;

    let touched = false;
    const nextRevisions = {};
    for (const [date, rev] of Object.entries(revisions)) {
        const slots = Array.isArray(rev?.slots) ? rev.slots : null;
        if (!slots || !slots.some((s) => s?.key === slotKey && s.label !== label)) {
            nextRevisions[date] = rev;
            continue;
        }
        touched = true;
        nextRevisions[date] = {
            ...rev,
            slots: slots.map((s) => (s?.key === slotKey ? { ...s, label } : s))
        };
    }
    return touched ? { ...plan, revisions: nextRevisions } : plan;
}

/**
 * `dateIso` 다음에 오는 개정판 날짜. 없으면 null.
 * 설정 시트가 "이 구성이 며칠까지 적용되는지" 안내하는 데 쓴다(§4.2.3).
 */
export function nextRevisionDateAfter(plan, dateIso, todayIso) {
    return listRevisionDates(plan, todayIso).find((d) => d > dateIso) || null;
}

/**
 * key 가 null 인 기본 슬롯에, 이미 이 사용자 문서에 있는 같은 base 의 원본 key 를
 * 물려준다.
 *
 * 과거 날짜를 편집할 때 필요하다: 29일 개정판만 있는 상태에서 27일을 편집하면
 * `effectiveSlots(27)` 은 개정판이 없어 기본값(key:null)을 준다. 그대로 구체화하면
 * 같은 '아침'인데 27일과 29일의 key 가 갈라져, 이름 소급(§3.1)이 한쪽만 고치게 된다.
 */
export function adoptExistingKeys(slots, plan, todayIso) {
    const dates = listRevisionDates(plan, todayIso);
    if (!dates.length) return slots;
    const earliest = sanitizeSlots(plan.revisions[dates[0]]?.slots);
    if (!earliest) return slots;
    const used = new Set();
    return (Array.isArray(slots) ? slots : []).map((s) => {
        if (!s || s.key != null) return s;
        const orig = oldestSlotForBase(earliest, s.base);
        if (!orig || orig.key == null || used.has(orig.key)) return s;
        used.add(orig.key);
        return { ...s, key: orig.key };
    });
}

/** 피커에 보이는(=enabled) 슬롯 수 — MAX_ENABLED_SLOTS 와 비교하는 쪽 */
export function countEnabledSlots(slots) {
    return (Array.isArray(slots) ? slots : []).filter((s) => s && s.enabled !== false).length;
}

/** 개정판 수 — REVISION_COUNT_DIAG_THRESHOLD 초과 시 호출부가 diag 한 줄 남긴다 (§5.6) */
export function revisionCount(plan) {
    const revisions = plan && typeof plan === 'object' ? plan.revisions : null;
    return revisions && typeof revisions === 'object' ? Object.keys(revisions).length : 0;
}

/* ── 타임라인 그룹핑 (§3 정렬 위치) ────────────────────────── */

/** base 의 본식/간식 구분 — 아이콘·색·폼 종류와 함께 base 가 답하는 것들 */
export function baseSlotType(baseId) {
    const def = SLOTS.find((s) => s.id === baseId);
    return def ? def.type : 'main';
}

/**
 * 그 날짜의 기록들을 사용자 슬롯 그룹으로 묶는다 — 타임라인·사진 뷰어·일간
 * 공유 캡처가 공유하는 순회. 반환 그룹의 `slot` 은 기존 카드 빌더가 받던
 * SLOTS 원소와 호환되는 모양(id·type·label)에 key 를 더한 것이다.
 *
 * 규칙 (docs/user-slot-plan.md §3):
 * - 그룹 = 기록의 resolveSlotView 결과. slotKey 가 그 날짜 개정판에 있으면
 *   그 슬롯, 없으면 base 원본(가장 오래된 key) 슬롯 자리에 끼운다.
 * - 그룹 순서 = 유효 개정판의 배열 순서. 개정판에 그 base 슬롯이 하나도
 *   없으면(전부 삭제) 목록 끝에 base 시간 순서로 붙는다.
 * - enabled:false 여도 기록이 있으면 그룹이 나온다 — 렌더 필터 아님 (불변식 4).
 * - slotId 가 기준 슬롯이 아닌 기록은 버린다 (현행 SLOTS.forEach 와 동일).
 *
 * 그룹 안 기록 정렬(시간순)은 호출부 몫이다 — 렌더 계층의
 * sortSnackSlotRecordsChronological 을 그대로 쓴다.
 *
 * @param {string} dateStr YYYY-MM-DD
 * @param {Array<object>} history 전체 기록 (이 함수가 날짜로 거른다)
 * @returns {Array<{ slot: {id:string,type:string,label:string,key:string|null}, records: object[] }>}
 */
export function groupMealsByUserSlotForDate(dateStr, history, userSettings, todayIso) {
    const slots = effectiveSlots(userSettings, dateStr, todayIso);
    const groups = new Map(); // groupKey → { order, slot, records }

    for (const m of Array.isArray(history) ? history : []) {
        if (!m || m.date !== dateStr || !BASE_IDS.has(m.slotId)) continue;
        const view = resolveSlotView(m, userSettings, todayIso);

        let order = view.slotKey != null ? slots.findIndex((s) => s.key === view.slotKey) : -1;
        if (order < 0) {
            const original = oldestSlotForBase(slots, view.base);
            order = original
                ? slots.indexOf(original)
                : slots.length + SLOTS.findIndex((s) => s.id === view.base);
        }

        const groupKey = view.slotKey != null ? `k:${view.slotKey}` : `b:${view.base}`;
        let g = groups.get(groupKey);
        if (!g) {
            g = {
                order,
                slot: { id: view.base, type: baseSlotType(view.base), label: view.label, key: view.slotKey },
                records: []
            };
            groups.set(groupKey, g);
        }
        g.records.push(m);
    }

    return [...groups.values()]
        .sort((a, b) => a.order - b.order)
        .map(({ slot, records }) => ({ slot, records }));
}
