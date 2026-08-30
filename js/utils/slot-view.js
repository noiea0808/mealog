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
    dayTimelineUnits,
    memoItemsOnly,
    slotItemsOnly
} from './slot-plan.js';

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
    return dayTimelineUnits(
        dateStr,
        window.mealHistory || [],
        window.userSettings,
        localTodayIso()
    );
}

/** 그 날짜의 메모 항목 정의만 (피커·설정 시트용) */
export function userMemoItemsForDate(dateIso) {
    return memoItemsOnly(effectiveSlots(window.userSettings, dateIso, localTodayIso()));
}

/** 그 날짜의 식사 슬롯 정의만 — 메모를 빼고 세는 자리 */
export function userMealSlotsForDate(dateIso) {
    return slotItemsOnly(effectiveSlots(window.userSettings, dateIso, localTodayIso()));
}
