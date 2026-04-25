/**
 * 모먼트 sharedPhoto에 deliveryVendor 등이 없을 때 mealHistory와 병합 (구데이터 호환)
 */
export function mergeMealDisplayFields(photo, mealRecord) {
    if (!mealRecord) return { ...(photo || {}) };
    const o = { ...(photo || {}) };
    if (!o.menuDetail && mealRecord.menuDetail) o.menuDetail = mealRecord.menuDetail;
    if (!o.category && mealRecord.category) o.category = mealRecord.category;
    if (!o.mealType && mealRecord.mealType) o.mealType = mealRecord.mealType;
    if (o.deliveryVendor == null || o.deliveryVendor === '') {
        if (mealRecord.deliveryVendor) o.deliveryVendor = mealRecord.deliveryVendor;
    }
    return o;
}

/**
 * 본식 기록의 "무엇을" 한 줄 표시 (배달/포장 시 픽업·배달 식당명과 메뉴 연결)
 */
export function formatMealMenuDisplayLine(data) {
    if (!data || typeof data !== 'object') return '';
    const menu = String(data.menuDetail || data.category || '').trim();
    const vendor = String(data.deliveryVendor || '').trim();
    const mt = String(data.mealType || '').trim();
    if (mt === '배달/포장' && vendor && menu) return `${vendor} | ${menu}`;
    if (mt === '배달/포장' && vendor) return vendor;
    return menu;
}
