/**
 * 사용자 슬롯 — 브라우저 어댑터 (docs/user-slot-plan.md §3)
 *
 * slot-plan.js 는 순수하다. window.userSettings·mealHistory·오늘 날짜를
 * 여기서만 주입한다 — 렌더 코드가 slot-plan 을 직접 부르며 저마다
 * window 를 만지기 시작하면 테스트 가능성이 죽는다.
 *
 * ⚠️ 여기 함수들은 **본인 기록 전용**이다. 라운지·모먼트 피드(타인 기록)는
 * 기준 슬롯 라벨(SLOTS)을 그대로 쓴다 — 타인의 slotPlan 은 클라이언트에
 * 없으므로, 내 슬롯 이름을 남의 기록에 붙이는 사고를 원천 차단한다(불변식 3).
 */
import {
    effectiveSlots,
    resolveSlotView,
    groupMealsByUserSlotForDate,
    memoUnitsForDate,
    mergeMemoUnits,
    memoItemsOnly,
    slotItemsOnly,
    memoIconOrDefault,
    findSlotByKey,
    normalizeTimeKey,
    defaultMemoKey,
    defaultMemoItemByKey,
    isJournalMemoKey,
    MEMO_SLOT_ID
} from './slot-plan.js';
import { getDailyJournalFromSettings, dailyJournalHasContent } from './daily-journal-data.js';

function localTodayIso() {
    const t = new Date();
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const d = String(t.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * 그 날짜의 사용자 슬롯 목록. ⚠️ 필터링용 아님(불변식 4) —
 * enabled:false 슬롯도 온다. 피커만 enabled 로 거른다.
 */
export function userSlotsForDate(dateIso) {
    return effectiveSlots(window.userSettings, dateIso, localTodayIso());
}

/** 기록 하나의 표시 슬롯 { label, base, slotKey, matchedBy } — 절대 실패하지 않는다 */
export function resolveRecordSlotView(record) {
    return resolveSlotView(record, window.userSettings, localTodayIso());
}

/**
 * 타임라인·사진 뷰어·일간 공유 캡처 공통 순회 — 그 날짜 기록을 사용자 슬롯
 * 그룹으로. 그룹의 slot 은 기존 SLOTS 원소 호환(id·type·label) + key.
 * 그룹 안 기록 정렬(시간순)은 호출부가 한다.
 */
export function userSlotGroupsForDate(dateStr) {
    return groupMealsByUserSlotForDate(
        dateStr,
        window.mealHistory || [],
        window.userSettings,
        localTodayIso()
    );
}

/**
 * 슬롯 그룹 + 메모 낱건을 한 줄로 섞은 하루 순회 (docs/user-memo-items.md §3.3).
 * 메모가 없는 사용자에게는 `userSlotGroupsForDate` 와 결과가 같다 —
 * 화면이 1픽셀도 안 바뀐다.
 */
export function dayTimelineUnitsForDate(dateStr) {
    const today = localTodayIso();
    const memos = [
        ...memoUnitsForDate(dateStr, window.mealHistory || [], window.userSettings, today),
        ...journalMemoUnitsForDate(dateStr)
    ].sort((a, b) => (a.timeKey < b.timeKey ? -1 : a.timeKey > b.timeKey ? 1 : 0));
    return mergeMemoUnits(
        groupMealsByUserSlotForDate(dateStr, window.mealHistory || [], window.userSettings, today),
        memos
    );
}

/** 그 날짜 메모 항목별 기록 수 — 하루 소감에서 온 것도 같이 센다 */
export function memoRecordCountsForDate(dateStr) {
    const counts = new Map();
    const today = localTodayIso();
    const all = [
        ...memoUnitsForDate(dateStr, window.mealHistory || [], window.userSettings, today),
        ...journalMemoUnitsForDate(dateStr)
    ];
    for (const u of all) {
        const k = String(u.slot.key || '');
        counts.set(k, (counts.get(k) || 0) + 1);
    }
    /**
     * 하루 소감은 메모 목록에 있지만 기록은 dailyComments 에 산다(§7.3).
     * 하루에 하나뿐이므로 있고/없고 둘이다.
     */
    const journalKey = defaultMemoKey('journal');
    if (dailyJournalHasContent(getDailyJournalFromSettings(window.userSettings, dateStr))) {
        counts.set(journalKey, 1);
    }
    return counts;
}

/**
 * 하루 소감에 쌓여 있는 체중·혈당을 **기본 메모 기록처럼** 보여 준다
 * (docs/user-memo-items.md §7.1).
 *
 * 데이터를 옮기지 않는다. 옮기면 meals 문서가 사용자당 수백 개 생기고 되돌릴
 * 수 없는데, **읽는 자리에서 합치면** 같은 화면을 얻고 코드를 되돌리는 것만으로
 * 원상복구된다. 하루 소감 입력 UI 를 걷을 때까지는 두 곳에서 입력되므로,
 * 합쳐 보여 주는 편이 오히려 맞다.
 *
 * 이 기록은 **읽기 전용**이다 — 누르면 하루 소감이 열린다(정본이 거기다).
 */
function journalMemoUnitsForDate(dateStr) {
    const entry = getDailyJournalFromSettings(window.userSettings, dateStr);
    const plan = window.userSettings?.slotPlan || null;
    const today = localTodayIso();
    const out = [];
    for (const [field, id, fallbackLabel, fallbackUnit] of [
        ['weightRecords', 'weight', '체중', 'kg'],
        ['bloodSugarRecords', 'bloodSugar', '혈당', 'mg/dL']
    ]) {
        const key = defaultMemoKey(id);
        // plan 에 없으면 기본 정의를 쓴다 — 이름·아이콘·단위가 거기 있다
        const item = findSlotByKey(plan, key, today) || defaultMemoItemByKey(key);
        // 사용자가 해제해 둔 기본 메모는 보여 주지 않는다
        if (item && item.enabled === false) continue;
        const records = Array.isArray(entry[field]) ? entry[field] : [];
        records.forEach((r, i) => {
            const value = Number(r?.value);
            if (!Number.isFinite(value)) return;
            const timeKey = normalizeTimeKey(r?.time, '23:59:59');
            out.push({
                slot: {
                    id: MEMO_SLOT_ID,
                    type: 'memo',
                    label: item?.label || fallbackLabel,
                    key,
                    icon: memoIconOrDefault(item?.icon),
                    unit: item?.unit || fallbackUnit
                },
                record: {
                    id: `dailyJournal_${dateStr}#${id}${i}`,
                    date: dateStr,
                    slotId: MEMO_SLOT_ID,
                    slotKey: key,
                    value,
                    time: timeKey,
                    // 시각 칩은 mealClock 을 본다 — 없으면 카드에 시각이 안 붙는다
                    mealClock: timeKey.slice(0, 5),
                    photos: [],
                    fromDailyJournal: true
                },
                timeKey
            });
        });
    }
    return out;
}

/** 그 날짜의 메모 항목 정의만 (피커·설정 시트용) */
export function userMemoItemsForDate(dateIso) {
    return memoItemsOnly(effectiveSlots(window.userSettings, dateIso, localTodayIso()));
}

/** 그 날짜의 식사 슬롯 정의만 — 메모를 빼고 세는 자리 */
export function userMealSlotsForDate(dateIso) {
    return slotItemsOnly(effectiveSlots(window.userSettings, dateIso, localTodayIso()));
}
