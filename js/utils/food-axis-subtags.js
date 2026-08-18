/**
 * '무엇을' 축이 하나로 보이는가 — **임시 코드다. 운영 전환일에 통째로 지운다.**
 * (전환 절차: docs/food-axis-rollout.md §6)
 *
 * 축은 형태 축 하나로 합쳤는데 최근 서브태그 저장 키는 `subTags.menu` 와 `subTags.snack`
 * 으로 갈린 채 남아 있다. 새로 기억하는 것만 `menu` 한쪽으로 모으는 판정에 쓴다
 * (js/modals/entry-save-subtags.js). 저장된 값은 옮기지 않는다.
 *
 * 읽기 병합은 없어졌다 (2026-08-18). 기록 시트의 서브 칩이 `subTags` 대신 이력 빈도를
 * 보게 되면서(js/utils/frequent-subtags.js) 두 키를 합쳐 읽을 일이 사라졌다.
 */
import { isFormAxisPilot } from './form-axis-pilot.js';

/**
 * 파일럿 여부로만 판정하면 **전환일에 통합이 되돌아간다.** 전환 절차는 파일럿 목록을
 * 비우는 것으로 끝나는데(rollout §3), 그 순간 이 함수가 false 가 되어 두 키가 다시
 * 갈린다 — 칩 목록이 완전히 같은데도.
 *
 * 그래서 **실제로 같은 목록인가**를 함께 본다. 관리자 저장은 '무엇을' 편집란 하나로
 * `category`·`snackType` 두 필드에 같은 값을 쓰므로(js/admin/tags.js saveTags),
 * 전환이 끝나면 이 조건이 저절로 참이 되고 파일럿 게이트 없이도 통합이 유지된다.
 * 전환 전 사용자는 옛 요리 종류 축과 옛 간식 축이라 겹칠 일이 없다.
 */
export function isWhatAxisUnified() {
    if (isFormAxisPilot()) return true;
    const meal = window.userSettings?.tags?.category;
    const snack = window.userSettings?.tags?.snackType;
    if (!Array.isArray(meal) || !Array.isArray(snack) || meal.length === 0) return false;
    return meal.length === snack.length && meal.every((v, i) => v === snack[i]);
}
