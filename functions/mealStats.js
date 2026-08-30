/**
 * 식사 기록 집계(stats) 헬퍼
 * meals 문서 변경 시 users/{uid}/config/stats 의 daily 집계를 갱신
 */
const MEAL_SLOTS = ['morning', 'lunch', 'dinner'];
const SNACK_SLOTS = ['pre_morning', 'snack1', 'snack2', 'night'];

function isMainSlot(slotId) {
  return slotId && MEAL_SLOTS.includes(slotId);
}

function isSnackSlot(slotId) {
  return slotId && SNACK_SLOTS.includes(slotId);
}

/**
 * meal 데이터에서 집계용 델타 객체 생성 (increment: +1 추가, -1 삭제)
 * stats에는 메인태그만 저장 (사용자 설정 태그는 meal 기록에서 직접 읽음)
 */
function getMealDelta(meal, increment) {
  if (!meal || !meal.date) return null;
  /**
   * 사용자 메모는 식사가 아니다 — 총 기록 수(count)에 세지 않는다
   * (docs/user-memo-items.md 불변식 2′ · §6).
   *
   * 하루 소감 미러(slotId 'daily_journal')는 **지금도 세고 있다.** 같은 성격의
   * 과다계수지만, 여기서 함께 빼면 사용자의 '총 기록 수'가 하루 소감 수만큼
   * 줄어 보인다. 소급 재집계는 별건이라 실제 분포를 보고 정한다 (§6).
   */
  if (meal.slotId === 'memo' || String(meal.id || '').startsWith('memo_')) return null;
  const delta = {
    date: meal.date,
    count: increment,
    mainCount: 0,
    snackCount: 0,
    main: { mealType: {}, category: {}, withWhom: {}, rating: {}, satiety: {} },
    snack: { place: {}, snackType: {}, rating: {}, satiety: {} }
  };

  const slotId = meal.slotId || '';
  const isMain = isMainSlot(slotId);
  const isSnack = isSnackSlot(slotId);
  if (isMain) delta.mainCount = increment;
  else if (isSnack) delta.snackCount = increment;

  const add = (target, key, val) => {
    if (val == null || val === '') return;
    const v = String(val).trim();
    if (v) target[v] = (target[v] || 0) + increment;
  };

  if (isMain) {
    const mt = (meal.mealType || '').trim();
    const isSkip = mt === 'Skip' || mt === '건너뜀';
    if (mt && !isSkip) add(delta.main.mealType, mt, mt);
    // 사용자 확정값이 없으면 자동 분류값을 센다 — 클라이언트 차트(effectiveCategoryForAnalytics)와 같은 규칙
    const cat = ((meal.category || meal.categoryAuto) || '').trim();
    if (cat) add(delta.main.category, cat, cat);
    const whom = (meal.withWhom || '혼자').trim();
    if (!isSkip) add(delta.main.withWhom, whom || '혼자', whom || '혼자');
    if (meal.rating != null) add(delta.main.rating, String(meal.rating), String(meal.rating));
    if (meal.satiety != null) add(delta.main.satiety, String(meal.satiety), String(meal.satiety));
  } else if (isSnack) {
    const place = ((meal.snackPlaceMain || meal.place) || '').trim();
    if (place) add(delta.snack.place, place, place);
    // 간식도 같은 필드 쌍을 공유한다 — snackType이 비고 categoryAuto만 있는 기록이 정상 경로다
    const st = ((meal.snackType || meal.categoryAuto) || '').trim();
    if (st) add(delta.snack.snackType, st, st);
    if (meal.rating != null) add(delta.snack.rating, String(meal.rating), String(meal.rating));
    if (meal.satiety != null) add(delta.snack.satiety, String(meal.satiety), String(meal.satiety));
  }

  return delta;
}

/**
 * 기존 day 엔트리에 delta 적용 (빈 객체 필터링)
 */
function mergeDeltaIntoDay(dayEntry, delta) {
  if (!dayEntry || !delta) return;
  dayEntry.count = (dayEntry.count || 0) + (delta.count || 0);
  dayEntry.mainCount = (dayEntry.mainCount || 0) + (delta.mainCount || 0);
  dayEntry.snackCount = (dayEntry.snackCount || 0) + (delta.snackCount || 0);

  const merge = (dest, src) => {
    if (!dest || !src) return;
    Object.keys(src).forEach(k => {
      const v = (dest[k] || 0) + (src[k] || 0);
      if (v <= 0) delete dest[k];
      else dest[k] = v;
    });
  };

  ['mealType', 'category', 'withWhom', 'rating', 'satiety'].forEach(k => {
    if (delta.main && delta.main[k] && Object.keys(delta.main[k]).length) {
      if (!dayEntry.main) dayEntry.main = {};
      if (!dayEntry.main[k]) dayEntry.main[k] = {};
      merge(dayEntry.main[k], delta.main[k]);
    }
  });
  ['place', 'snackType', 'rating', 'satiety'].forEach(k => {
    if (delta.snack && delta.snack[k] && Object.keys(delta.snack[k]).length) {
      if (!dayEntry.snack) dayEntry.snack = {};
      if (!dayEntry.snack[k]) dayEntry.snack[k] = {};
      merge(dayEntry.snack[k], delta.snack[k]);
    }
  });
}

/**
 * 빈 객체/0 값 정리 후 day 엔트리 반환 (Firestore 저장용)
 */
function sanitizeDayEntry(dayEntry) {
  if (!dayEntry) return null;
  const c = dayEntry.count || 0;
  if (c <= 0) return null;
  const out = { count: c };
  if ((dayEntry.mainCount || 0) > 0) out.mainCount = dayEntry.mainCount;
  if ((dayEntry.snackCount || 0) > 0) out.snackCount = dayEntry.snackCount;
  if (dayEntry.main) {
    const m = {};
    ['mealType', 'category', 'withWhom', 'rating', 'satiety'].forEach(k => {
      if (dayEntry.main[k] && Object.keys(dayEntry.main[k]).length) m[k] = dayEntry.main[k];
    });
    if (Object.keys(m).length) out.main = m;
  }
  if (dayEntry.snack) {
    const s = {};
    ['place', 'snackType', 'rating', 'satiety'].forEach(k => {
      if (dayEntry.snack[k] && Object.keys(dayEntry.snack[k]).length) s[k] = dayEntry.snack[k];
    });
    if (Object.keys(s).length) out.snack = s;
  }
  return out;
}

/**
 * meals 배열에서 전체 daily stats 계산 (backfill용)
 * 본식·간식 모두 기록 문서 1건당 1회 집계
 */
function computeStatsFromMeals(meals) {
  const daily = {};
  (meals || []).forEach(m => {
    const delta = getMealDelta(m, 1);
    if (!delta) return;
    const dateStr = delta.date;
    const emptyDay = { count: 0, mainCount: 0, snackCount: 0, main: { mealType: {}, category: {}, withWhom: {}, rating: {}, satiety: {} }, snack: { place: {}, snackType: {}, rating: {}, satiety: {} } };
    const day = daily[dateStr] || JSON.parse(JSON.stringify(emptyDay));
    mergeDeltaIntoDay(day, delta);
    daily[dateStr] = sanitizeDayEntry(day) || day;
  });
  return daily;
}

module.exports = {
  getMealDelta,
  mergeDeltaIntoDay,
  sanitizeDayEntry,
  computeStatsFromMeals,
  MEAL_SLOTS,
  SNACK_SLOTS,
  isMainSlot,
  isSnackSlot
};
