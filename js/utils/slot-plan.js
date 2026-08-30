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
export const MAX_SLOTS_PER_REVISION = 32;
export const SLOT_LABEL_MAX_CHARS = 12;

/**
 * 기본 7슬롯의 key 는 base 에서 **결정적으로** 만든다.
 *
 * 예전엔 `key: null` 을 "아직 저장 안 된 기본 슬롯" 표식으로 썼는데, 그 하나가
 * 규칙 셋을 낳았다 — 구체화 시점, 비교의 비대칭, 과거 날짜 편집의 정체성 분리.
 * 결정적 key 면 셋 다 사라진다. **어느 날짜에서 읽어도 '아침'은 늘 같은 슬롯**이다.
 *
 * 접두사가 0 아홉 개인 이유: 생성 key 의 타임스탬프(base36)는 2059년까지 8자라
 * 한 자리만 0 으로 채워지고('0mtek…'), 그 뒤로는 9자가 되며 '1' 이상으로 시작한다.
 * 어느 쪽이든 문자열 비교에서 기본 슬롯이 먼저 온다 = "가장 오래된 key = 원본"(§3).
 *
 * ⚠ 아래 기본 메모 key 가 이 접두사를 쓰므로 **여기가 위**여야 한다 —
 * 뒤에 두면 모듈 평가 순서상 TDZ 로 죽는다.
 */
export const DEFAULT_SLOT_KEY_PREFIX = '000000000';

export function defaultSlotKey(baseId) {
    return `${DEFAULT_SLOT_KEY_PREFIX}${baseId}`;
}

/* ── 메모 항목 (docs/user-memo-items.md) ───────────────────── */

/**
 * 메모 기록의 `meals.slotId`. 기준 슬롯 7개가 아닌 **"식사가 아니다"는 표식**이다
 * (불변식 2′). 식사를 세는 코드는 이 값을 명시적으로 뺀다.
 */
export const MEMO_SLOT_ID = 'memo';
/** 피커 3열 카드에 한 줄로 들어가는 한계 (user-memo-items §2.5) */
export const MEMO_LABEL_MAX_CHARS = 8;
/** 단위 — 'mg/dL' 길이가 상한의 근거다 */
export const MEMO_UNIT_MAX_CHARS = 6;
/** 슬롯과 **따로** 센다 — 피커에서 두 구역이 갈라져 있으므로 예산도 갈라 둔다 */
export const MAX_ENABLED_MEMOS = 8;
export const DEFAULT_MEMO_ICON = 'sticky-note';
export const DEFAULT_MEMO_LABEL = '메모';

/**
 * 아이콘 화이트리스트 — 다른 기기·구버전이 쓴 임의 문자열을 그대로
 * `<i data-lucide>` 에 꽂지 않는다. 밖의 값은 **읽는 시점**에 정화된다.
 */
export const MEMO_ICONS = [
    'scale', 'droplet', 'activity', 'heart-pulse', 'pill', 'syringe',
    'dumbbell', 'footprints', 'bike', 'waves', 'moon', 'bed',
    'alarm-clock', 'smile', 'frown', 'brain', 'thermometer', 'stethoscope',
    'toilet', 'glass-water', 'coffee', 'cigarette', 'wine', 'sun',
    'cloud-rain', 'book-open', 'pen-line', 'camera', 'map-pin', 'sticky-note'
];
const MEMO_ICON_SET = new Set(MEMO_ICONS);

/** 새 메모를 만들 때 이름·아이콘을 한 번에 채우는 지름길 (§4.3) */
/**
 * 기본 메모 항목 — 체중·혈당은 처음부터 깔려 있다 (user-memo-items §2.6).
 *
 * key 가 **결정적**인 것이 계약이다(기본 슬롯과 같은 수, §2.4). 사용자가 이름을
 * '몸무게'로 바꿔도 key 는 그대로라 분석 탭 차트가 이 key 로 값을 계속 찾는다.
 *
 * `unit` 이 붙어 있으므로 **숫자 메모**다(§2.7).
 */
export const DEFAULT_MEMO_KEY_PREFIX = `${DEFAULT_SLOT_KEY_PREFIX}memo-`;

export function defaultMemoKey(id) {
    return `${DEFAULT_MEMO_KEY_PREFIX}${id}`;
}

/**
 * 하루 소감도 기본 메모 항목이다 (§7.3). 다만 **기록은 여전히
 * `dailyComments` 에** 산다 — 목록에서의 자리와 사용 여부만 메모 규칙을
 * 따르고, 누르면 하루 소감 시트가 열린다.
 */
export const JOURNAL_MEMO_ID = 'journal';

export const DEFAULT_MEMO_ITEMS = [
    { id: 'weight', icon: 'scale', label: '체중', unit: 'kg', decimals: 1 },
    { id: 'bloodSugar', icon: 'droplet', label: '혈당', unit: 'mg/dL', decimals: 0 },
    { id: JOURNAL_MEMO_ID, icon: 'book-open', label: '하루 소감' }
];

/** 그 항목이 하루 소감인가 — 기록 시트가 다르다 */
export function isJournalMemoKey(key) {
    return key === defaultMemoKey(JOURNAL_MEMO_ID);
}

export function defaultMemoItems() {
    return DEFAULT_MEMO_ITEMS.map((m) => {
        const item = { key: defaultMemoKey(m.id), kind: 'memo', icon: m.icon, label: m.label, enabled: true };
        // 단위가 있는 것만 숫자 메모다 — 하루 소감은 텍스트다
        if (m.unit) {
            item.unit = m.unit;
            item.decimals = m.decimals;
        }
        return item;
    });
}

/** 기본 메모인가 — 지울 수 없고 해제만 된다 (§2.6) */
export function isDefaultMemoKey(key) {
    return typeof key === 'string' && key.startsWith(DEFAULT_MEMO_KEY_PREFIX);
}

/**
 * key 로 기본 메모 정의를 찾는다 — plan 이 아예 없는 사용자의 폴백.
 * 이게 없으면 체중 기록이 '메모/sticky-note' 로 떨어진다.
 */
export function defaultMemoItemByKey(key) {
    if (!isDefaultMemoKey(key)) return null;
    return defaultMemoItems().find((m) => m.key === key) || null;
}

/**
 * 개정판에 없는 기본 메모를 **덧붙인다**. 기존 사용자(이미 개정판이 있는)도
 * 마이그레이션 없이 얻게 하는 장치다.
 *
 * key 로 판정하므로 사용자가 해제해 둔(enabled:false) 기본 메모는 다시 켜지
 * 않는다 — 개정판에 그 key 가 살아 있기 때문이다.
 */
export function withDefaultMemos(items) {
    const list = Array.isArray(items) ? items.slice() : [];
    const have = new Set(list.map((s) => s && s.key));
    const missing = defaultMemoItems().filter((m) => !have.has(m.key));
    if (!missing.length) return list;
    /**
     * 빠진 기본 항목은 메모 구간의 **맨 앞**에 넣는다 — 체중·혈당이
     * 위에 순서대로 보여야 한다. 뒤에 붙이면 먼저 만든 사용자 메모가
     * 기본보다 앞에 온다. 이미 있는 기본 항목의 자리는 건드리지 않는다 —
     * 사용자가 끌어 정한 순서를 읽을 때마다 되돌리면 안 된다(§4.3).
     */
    const slots = list.filter((s) => !isMemoItem(s));
    const memos = list.filter(isMemoItem);
    return [...slots, ...missing, ...memos];
}

/**
 * 메모 기록의 문서 ID 접두사.
 *
 * `slotId` 만으로 충분해 보이지만, **ID 밖에 모르는 자리**가 있다 —
 * `dbOps.delete(id)` 와 아웃박스 워커가 그렇다. 거기서 mealCount 를 깎을지
 * 정하려면 본문 없이 판정할 수 있어야 한다. 하루 소감이 이미 같은 수를 쓴다
 * (`dailyJournal_{date}`).
 */
export const MEMO_MEAL_ID_PREFIX = 'memo_';

export function newMemoMealId(baseId) {
    return `${MEMO_MEAL_ID_PREFIX}${baseId}`;
}

export function isMemoMealId(id) {
    return typeof id === 'string' && id.startsWith(MEMO_MEAL_ID_PREFIX);
}

/** 이 meals 문서가 메모인가 — 식사를 세는 코드가 빼는 기준 (불변식 2′) */
export function isMemoMealRecord(record) {
    return !!record && (record.slotId === MEMO_SLOT_ID || isMemoMealId(record.id));
}

/** 항목 하나가 메모인가 — `kind` 가 없으면 슬롯이다 (하위호환) */
export function isMemoItem(item) {
    return !!item && item.kind === 'memo';
}

export function memoIconOrDefault(icon) {
    return typeof icon === 'string' && MEMO_ICON_SET.has(icon) ? icon : DEFAULT_MEMO_ICON;
}
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

/** slotPlan 이 없는 사용자의 사용자 슬롯 = 기준 슬롯 7개 그대로 */
export function defaultUserSlots() {
    return SLOTS.map((s) => ({ key: defaultSlotKey(s.id), base: s.id, label: s.label, enabled: true }));
}

/* ── 검증 ──────────────────────────────────────────────────── */

/**
 * 항목 배열 정화 — 다른 기기·구버전이 쓴 값을 신뢰하지 않는다.
 * 모르는 base·빈 라벨은 버리고, 아이콘은 화이트리스트로 정화하고, 상한으로 자른다.
 * 전부 버려지면 null — 호출부는 기본값으로 폴백한다.
 *
 * **슬롯을 앞, 메모를 뒤로 안정 정렬한다** (user-memo-items §2.1). 이 한 줄이
 * "배열 순서 = 표시 순서"를 슬롯 구간에서 지키면서, "메모는 피커 아래쪽"을
 * 자료구조로 보장한다. 메모끼리의 순서는 만든 순이고 편집 수단이 없다.
 */
export function sanitizeSlots(rawSlots) {
    if (!Array.isArray(rawSlots)) return null;
    const slots = [];
    const memos = [];
    const seenKeys = new Set();
    for (const s of rawSlots) {
        if (!s || typeof s !== 'object') continue;
        const memo = isMemoItem(s);
        if (!memo && !BASE_IDS.has(s.base)) continue;
        const max = memo ? MEMO_LABEL_MAX_CHARS : SLOT_LABEL_MAX_CHARS;
        const label = typeof s.label === 'string' ? s.label.trim().slice(0, max) : '';
        if (!label) continue;
        const key = typeof s.key === 'string' && s.key ? s.key : null;
        if (key != null) {
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
        }
        if (memo) {
            // 메모에는 base 가 없다 — 키가 없어야 originalSlotSet 등이 오인하지 않는다
            const item = { key, kind: 'memo', icon: memoIconOrDefault(s.icon), label, enabled: s.enabled !== false };
            // 단위가 있으면 숫자 메모다 (§2.7). 없으면 필드 자체를 두지 않는다
            const unit = typeof s.unit === 'string' ? s.unit.trim().slice(0, MEMO_UNIT_MAX_CHARS) : '';
            if (unit) {
                item.unit = unit;
                item.decimals = s.decimals === 1 ? 1 : 0;
            }
            memos.push(item);
        } else {
            slots.push({ key, base: s.base, label, enabled: s.enabled !== false });
        }
    }
    const out = slots.concat(memos).slice(0, MAX_SLOTS_PER_REVISION);
    return out.length > 0 ? out : null;
}

/** 그 목록의 슬롯만 / 메모만 */
export function slotItemsOnly(items) {
    return (Array.isArray(items) ? items : []).filter((s) => s && !isMemoItem(s));
}
export function memoItemsOnly(items) {
    return (Array.isArray(items) ? items : []).filter(isMemoItem);
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
    const base = revisionSlotsForDate(plan, dateIso, todayIso) || adoptLegacyKeys(defaultUserSlots(), plan, todayIso);
    // 기본 메모는 개정판에 없으면 덩붙는다 (§2.6) — 기존 사용자도 얻게
    return withDefaultMemos(base);
}

/**
 * 마이그레이션 심지 — 결정적 key(§2.4) **이전에** 저장된 plan 만을 위한 것.
 *
 * 옛 코드는 기본 슬롯 key 를 저장 시점에 생성했다. 그런 plan 을 가진 사용자가
 * 첫 개정판보다 앞선 날짜를 편집하면, 기본값의 결정적 key 와 개정판의 생성 key 가
 * 갈려 같은 '아침'이 날짜마다 다른 슬롯이 된다(이름 소급이 반쪽만 된다).
 * 가장 이른 개정판의 같은 base 원본 key 를 물려줘 하나로 묶는다.
 *
 * `effectiveSlots` 안에서만 돈다 — **호출부가 기억할 규칙이 아니다.**
 * 결정적 key 이전 plan 이 없다고 확신되면 이 함수째로 지워도 된다.
 */
function adoptLegacyKeys(slots, plan, todayIso) {
    const dates = listRevisionDates(plan, todayIso);
    if (!dates.length) return slots;
    const earliest = sanitizeSlots(plan.revisions[dates[0]]?.slots);
    if (!earliest) return slots;
    const used = new Set();
    return slots.map((s) => {
        const orig = oldestSlotForBase(earliest, s.base);
        if (!orig || !orig.key || orig.key === s.key || used.has(orig.key)) return s;
        used.add(orig.key);
        return { ...s, key: orig.key };
    });
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
        // 메모는 base 가 없다 — undefined === undefined 로 걸려들지 않게 먼저 뺀다
        if (isMemoItem(s)) continue;
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
        if (!s || isMemoItem(s)) continue; // 메모는 원본/복제 구분이 없다
        const cur = byBase.get(s.base);
        if (!cur || compareSlotKeys(s.key, cur.key) < 0) byBase.set(s.base, s);
    }
    return new Set(byBase.values());
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
        return isMemoItem(byKey)
            ? {
                  label: byKey.label,
                  base: MEMO_SLOT_ID,
                  slotKey: byKey.key,
                  kind: 'memo',
                  icon: byKey.icon,
                  unit: byKey.unit || '',
                  decimals: byKey.decimals === 1 ? 1 : 0,
                  matchedBy: 'key'
              }
            : { label: byKey.label, base: byKey.base, slotKey: byKey.key, matchedBy: 'key' };
    }

    /**
     * 메모는 base 폴백 단계가 없다 — 귀속할 기준 슬롯이 없기 때문이다.
     * 지운 항목의 이름은 위 `findSlotByKey` 가 `retired` 에서 찾아 온다.
     * 그마저 없으면 여기서 떨어진다 — **폴백은 반드시 성공한다**(§3).
     */
    if (slotId === MEMO_SLOT_ID) {
        const key = typeof record?.slotKey === 'string' && record.slotKey ? record.slotKey : null;
        // 기본 메모는 plan 이 없어도 정의가 있다 (§2.6)
        const def = defaultMemoItemByKey(key);
        if (def) {
            return {
                label: def.label,
                base: MEMO_SLOT_ID,
                slotKey: key,
                kind: 'memo',
                icon: def.icon,
                unit: def.unit,
                decimals: def.decimals,
                matchedBy: 'default'
            };
        }
        return {
            label: DEFAULT_MEMO_LABEL,
            base: MEMO_SLOT_ID,
            slotKey: key,
            kind: 'memo',
            icon: DEFAULT_MEMO_ICON,
            matchedBy: 'default'
        };
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
     * 성장 억제(§5.6): 안 바꿨으면 개정판을 만들지 않는다. 기본 슬롯의 key 가
     * 결정적이라(§2.4) 편집 없이 저장하면 여기서 글자 그대로 같아진다.
     */
    /**
     * 비교 기준도 **같은 보강**을 타야 한다(§2.6). 안 그러면 기본 메모가
     * 덩붙은 draft 와 덩붙지 않은 current 가 달라져, 설정을 열었다 저장만 해도
     * 개정판이 하나 생긴다 (§5.6 성장 억제와 충돌).
     */
    const current = withDefaultMemos(revisionSlotsForDate(plan, effectiveFrom, todayIso) || defaultUserSlots());

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
        (d) => !slotsIdentical(sanitizeSlots(plan.revisions[d]?.slots) || [], cleaned)
    );

    if (slotsIdentical(current, cleaned) && !laterNeedsWrite) return plan;

    const materialized = cleaned;

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
            const memo = isMemoItem(s);
            if (!memo && !BASE_IDS.has(s.base)) continue;
            const max = memo ? MEMO_LABEL_MAX_CHARS : SLOT_LABEL_MAX_CHARS;
            const label = typeof s.label === 'string' ? s.label.trim().slice(0, max) : '';
            if (!label) continue;
            out.set(
                s.key,
                memo
                    ? { kind: 'memo', icon: memoIconOrDefault(s.icon), label, ...(s.unit ? { unit: s.unit, decimals: s.decimals === 1 ? 1 : 0 } : {}) }
                    : { base: s.base, label }
            );
        }
    }
    return out;
}

/** 폐기된 항목(어느 개정판에도 없는 key)의 이름 — §3 폴백의 마지막 보루 */
function retiredSlotByKey(plan, slotKey) {
    const r = plan && typeof plan === 'object' && plan.retired && typeof plan.retired === 'object'
        ? plan.retired[slotKey]
        : null;
    if (!r) return null;
    const memo = isMemoItem(r);
    if (!memo && !BASE_IDS.has(r.base)) return null;
    const max = memo ? MEMO_LABEL_MAX_CHARS : SLOT_LABEL_MAX_CHARS;
    const label = typeof r.label === 'string' ? r.label.trim().slice(0, max) : '';
    if (!label) return null;
    if (!memo) return { key: slotKey, base: r.base, label, enabled: false };
    const out = { key: slotKey, kind: 'memo', icon: memoIconOrDefault(r.icon), label, enabled: false };
    if (r.unit) {
        out.unit = String(r.unit).slice(0, MEMO_UNIT_MAX_CHARS);
        out.decimals = r.decimals === 1 ? 1 : 0;
    }
    return out;
}

/**
 * 이름 소급 갱신(§3.1) — 모든 개정판에서 같은 key 의 label 을 바꾼 새 plan.
 * key 가 어디에도 없으면 원본을 그대로 돌려준다.
 */
export function renameSlotEverywhere(plan, slotKey, newLabel) {
    if (typeof newLabel !== 'string' || typeof slotKey !== 'string' || !slotKey) return plan;
    const revisions = plan && typeof plan === 'object' ? plan.revisions : null;
    if (!revisions || typeof revisions !== 'object') return plan;

    let touched = false;
    const nextRevisions = {};
    for (const [date, rev] of Object.entries(revisions)) {
        const slots = Array.isArray(rev?.slots) ? rev.slots : null;
        // 이름 길이 상한이 종류마다 다르다 — 자를 때 그 항목의 kind 를 본다
        const labelFor = (s) =>
            newLabel.trim().slice(0, isMemoItem(s) ? MEMO_LABEL_MAX_CHARS : SLOT_LABEL_MAX_CHARS);
        if (!slots || !slots.some((s) => s?.key === slotKey && labelFor(s) && s.label !== labelFor(s))) {
            nextRevisions[date] = rev;
            continue;
        }
        touched = true;
        nextRevisions[date] = {
            ...rev,
            slots: slots.map((s) => (s?.key === slotKey ? { ...s, label: labelFor(s) } : s))
        };
    }
    return touched ? { ...plan, revisions: nextRevisions } : plan;
}

/** 두 항목 배열이 글자 그대로 같은지 — key 를 와일드카드로 보지 않는다 */
function slotsIdentical(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every(
        (s, i) =>
            s.key === b[i].key &&
            s.base === b[i].base &&
            s.label === b[i].label &&
            s.enabled === b[i].enabled &&
            isMemoItem(s) === isMemoItem(b[i]) &&
            (!isMemoItem(s) || (s.icon === b[i].icon && (s.unit || '') === (b[i].unit || '') && (s.decimals || 0) === (b[i].decimals || 0)))
    );
}

/**
 * `slots` 구성이 **실제로 끝나는** 날 — `dateIso` 뒤에서 내용이 처음으로 달라지는
 * 개정판 날짜. 없으면 null(= 계속 적용).
 *
 * "다음 개정판"이 아니라 "다음으로 **다른** 개정판"인 이유(§4.2.5): 내용이 같은
 * 개정판이 남을 수 있다.
 * - 29일에 고쳤다가 되돌리면 개정판 29 가 28 과 같은 내용으로 덮여 남는다
 *   (그 날짜의 개정판 자신과 비교하므로 되돌림도 '변경'이다).
 * - '뒤 개정판 통일'(§4.2.4)은 설계상 같은 내용을 뒤 날짜에 써넣는다.
 *
 * 이런 자국을 세면 안내가 "28일까지만 적용"이라고 거짓말한다 — 29일 내용이
 * 같으니 실제로는 계속 적용되는데도.
 */
export function nextDifferentRevisionAfter(plan, dateIso, todayIso, slots) {
    const revisions = plan && typeof plan === 'object' ? plan.revisions : null;
    if (!revisions) return null;
    for (const d of listRevisionDates(plan, todayIso)) {
        if (d <= dateIso) continue;
        if (!slotsIdentical(sanitizeSlots(revisions[d]?.slots) || [], slots)) return d;
    }
    return null;
}

/** 피커에 보이는(=enabled) 슬롯 수 — MAX_ENABLED_SLOTS 와 비교하는 쪽. 메모는 안 센다 */
export function countEnabledSlots(slots) {
    return (Array.isArray(slots) ? slots : []).filter((s) => s && !isMemoItem(s) && s.enabled !== false).length;
}

/** 메모 항목 수 — MAX_ENABLED_MEMOS 와 비교하는 쪽 (메모에는 사용 토글이 없다) */
export function countMemos(items) {
    return memoItemsOnly(items).length;
}

/** 개정판 수 — REVISION_COUNT_DIAG_THRESHOLD 초과 시 호출부가 diag 한 줄 남긴다 (§5.6) */
export function revisionCount(plan) {
    const revisions = plan && typeof plan === 'object' ? plan.revisions : null;
    return revisions && typeof revisions === 'object' ? Object.keys(revisions).length : 0;
}

/* ── 타임라인 그룹핑 (§3 정렬 위치) ────────────────────────── */

/** base 의 본식/간식 구분 — 아이콘·색·폼 종류와 함께 base 가 답하는 것들 */
export function baseSlotType(baseId) {
    if (baseId === MEMO_SLOT_ID) return 'memo';
    const def = SLOTS.find((s) => s.id === baseId);
    return def ? def.type : 'main';
}

/* ── 메모 배치 (user-memo-items §3.2·§3.3) ─────────────────── */

/** 'H:mm' · 'HH:mm:ss' → 비교 가능한 'HH:mm:ss'. 못 읽으면 fallback */
export function normalizeTimeKey(raw, fallback = '') {
    const s = typeof raw === 'string' ? raw.trim() : '';
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (!m) return fallback;
    const h = Number(m[1]);
    if (!Number.isFinite(h) || h > 23) return fallback;
    return `${String(h).padStart(2, '0')}:${m[2]}:${m[3] || '00'}`;
}

/**
 * base 슬롯이 **뜻하는 시각** — 시각을 안 적은 끼니의 자리를 잡을 때만 쓴다.
 *
 * 정확한 시각이 아니라 '점심은 낮'이라는 낯이다. 끼니 사이에 메모를 끼우는 데는
 * 이 정도면 충분하고, 사용자에게 시각을 강요하지 않아도 된다.
 */
const BASE_NOMINAL_TIME = {
    pre_morning: '06:30:00',
    morning: '08:00:00',
    snack1: '10:30:00',
    lunch: '12:30:00',
    snack2: '15:30:00',
    dinner: '18:30:00',
    night: '21:30:00'
};

/**
 * 그룹의 **대표 시각** = 그 그룹에서 사용자가 **적어 둔** 가장 이른 시각.
 *
 * ⚠️ `record.time` 을 보지 않는다. 끼니의 `time` 은 시각을 안 적으면 **저장한
 * 순간**이 들어가는 정렬용 필드다(entry-save-record.js). 그걸 대표 시각으로 쓰면
 * 오후 두 시에 몰아 적은 '아침'이 오후 두 시의 끼니가 되어, 낮 한 시 반에 한
 * 운동 메모가 아침 **앞**에 선다 — 화면에 시각이 없으니 이유도 안 보인다.
 *
 * 그래서 사용자가 실제로 고른 `mealClock` 만 본다. 아무도 안 적었으면 그 슬롯이
 * 뜻하는 시각(BASE_NOMINAL_TIME)으로 자리를 잡는다 — 시각을 안 적는 사람에게도
 * 아침·점심·저녁이라는 순서 정보는 이미 있다.
 */
function groupRepTimeKey(group) {
    let best = null;
    for (const r of Array.isArray(group?.records) ? group.records : []) {
        const t = normalizeTimeKey(r?.mealClock, '');
        if (!t) continue;
        if (best === null || t < best) best = t;
    }
    if (best !== null) return best;
    return BASE_NOMINAL_TIME[group?.slot?.id] || '';
}

/**
 * 그 날짜의 메모 기록들 — **낱건**이 배치 단위다 (§3.2).
 *
 * 슬롯처럼 key 로 묶지 않는다. 아침에 잰 체중과 저녁에 잰 체중을 한 덩어리로
 * 묶으면 하루에 한 자리밖에 못 갖는다 — "시각이 자리를 정한다"가 거기서 죽는다.
 *
 * @returns {Array<{ slot: {id:string,type:string,label:string,key:string|null,icon:string}, record: object, timeKey: string }>}
 */
export function memoUnitsForDate(dateStr, history, userSettings, todayIso) {
    const out = [];
    for (const m of Array.isArray(history) ? history : []) {
        if (!m || m.date !== dateStr || m.slotId !== MEMO_SLOT_ID) continue;
        const view = resolveSlotView(m, userSettings, todayIso);
        out.push({
            slot: {
                id: MEMO_SLOT_ID,
                type: 'memo',
                label: view.label,
                key: view.slotKey,
                icon: memoIconOrDefault(view.icon),
                unit: view.unit || ''
            },
            record: m,
            // 시각 없는 메모는 하루의 끝 — 하루 소감(23:59)과 같은 자리 규칙
            timeKey: normalizeTimeKey(m.time, '23:59:59')
        });
    }
    return out.sort((a, b) => (a.timeKey < b.timeKey ? -1 : a.timeKey > b.timeKey ? 1 : 0));
}

/**
 * 슬롯 그룹 사이에 메모 낱건을 끼운 표시 단위 목록 (§3.3).
 *
 * 규칙 한 문장: **그룹을 목록 순서로 훑으며 대표 시각 ≤ 메모 시각인 마지막
 * 그룹 뒤에 놓는다.** 그런 그룹이 없으면 맨 앞.
 *
 * 대표 시각은 사용자가 적은 시각이고, 안 적었으면 그 슬롯이 뜻하는 시각이다
 * (`groupRepTimeKey`). 저장 시각은 절대 쓰지 않는다.
 *
 * 메모는 그룹 **사이**에만 낀다 — 그룹 안(점심 2건 사이)은 가르지 않는다.
 * 그룹은 카드가 이어 붙은 시각적 한 덩어리이고, 그 사이를 벌리는 비용이
 * 얻는 정확도보다 크다.
 *
 * @returns {Array<{ type:'slot', slot: object, records: object[] }
 *               | { type:'memo', slot: object, record: object }>}
 */
export function mergeMemoUnits(groups, memoUnits) {
    const list = Array.isArray(groups) ? groups : [];
    const memos = Array.isArray(memoUnits) ? memoUnits : [];
    const reps = list.map(groupRepTimeKey);

    const buckets = new Map(); // 앵커 인덱스(-1 = 맨 앞) → 메모 단위들
    for (const u of memos) {
        let anchor = -1;
        for (let i = 0; i < list.length; i++) {
            if (reps[i] <= u.timeKey) anchor = i;
        }
        if (!buckets.has(anchor)) buckets.set(anchor, []);
        buckets.get(anchor).push(u);
    }

    const out = [];
    const pushMemos = (idx) => {
        for (const u of buckets.get(idx) || []) out.push({ type: 'memo', slot: u.slot, record: u.record });
    };
    pushMemos(-1);
    for (let i = 0; i < list.length; i++) {
        out.push({ type: 'slot', slot: list[i].slot, records: list[i].records });
        pushMemos(i);
    }
    return out;
}

/**
 * 타임라인·사진 뷰어·일간 캡처가 함께 쓰는 하루 순회 — 슬롯 그룹 + 메모 낱건.
 * 하루 소감은 여기 오지 않는다(호출부가 목록 끝에 따로 그린다).
 */
export function dayTimelineUnits(dateStr, history, userSettings, todayIso) {
    return mergeMemoUnits(
        groupMealsByUserSlotForDate(dateStr, history, userSettings, todayIso),
        memoUnitsForDate(dateStr, history, userSettings, todayIso)
    );
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
