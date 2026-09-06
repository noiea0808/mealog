/**
 * 트렌드 표 「메모」행 — 하루 소감과 사용자 메모를 읽는 자리에서 합친다.
 *
 * 집계는 둘을 **따로** 센다. 하루 소감의 정본은 `config/settings` 의 `dailyComments`
 * 이고 `meals/dailyJournal_{date}` 는 그 미러라, 「기록 · 전체」에서 미러 몫을 덜어내는
 * 보정을 받는다. 사용자 메모(docs/user-memo-items.md)는 `meals` 가 정본이라 그 보정을
 * 받으면 안 된다 — 축을 합쳐 세면 그 공식이 조용히 틀어진다.
 *
 * 그래서 저장은 두 축, 표시는 한 행이다. 하루 소감도 메모 목록의 한 항목이 된
 * 뒤로(user-memo-items §7.3) 사용자에게는 둘이 같은 것이므로, 따로 세면 오히려
 * 「메모를 얼마나 쓰나」가 두 칸으로 갈려 안 보인다.
 *
 * **한쪽이 통째로 없으면 있는 쪽만 돌려준다.** 사용자 메모는 나중에 생긴 축이라 그
 * 이전 캐시에는 배열 자체가 없는데, 없는 것을 0 으로 펴면 「모른다」가 「없다」로
 * 둔갑한다. 표는 모르는 칸을 '—' 로 두는 규칙이므로 빈 배열을 그대로 넘긴다.
 */

/** 값이 하나라도 있으면 숫자 합, 둘 다 없으면 undefined (호출부가 '—' 로 둔다) */
export function sumMemoRowTotals(journalValue, memoValue) {
    if (journalValue == null && memoValue == null) return undefined;
    return (Number(journalValue) || 0) + (Number(memoValue) || 0);
}

/** 두 칸 배열을 자리별로 더한다. 한쪽이 비면 다른 쪽 그대로 */
export function sumMemoRowArrays(journalArr, memoArr) {
    const a = Array.isArray(journalArr) && journalArr.length ? journalArr : null;
    const b = Array.isArray(memoArr) && memoArr.length ? memoArr : null;
    if (!a) return b ? [...b] : [];
    if (!b) return [...a];
    const n = Math.max(a.length, b.length);
    return Array.from({ length: n }, (_, i) => (Number(a[i]) || 0) + (Number(b[i]) || 0));
}
