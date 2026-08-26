/**
 * 관리자 > 모니터링 > 식당정보 집계·필터 (Firestore 캐시 문서 adminSettings/restaurantStats)
 */
import { db, appId } from '../firebase.js';
import {
    doc,
    getDoc,
    setDoc,
    query,
    where,
    getDocs,
    collectionGroup
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { getTodayDateString, escapeHtml, runAdminRefreshAction } from './utils.js';

/** 캐시가 없을 때 거슬러 올라갈 하한 (admin.js ADMIN_OPS_START·대시보드 집계 시작일과 같음) */
const RESTAURANT_SCAN_MIN_DATE = '2026-03-08';

const RESTAURANT_STATS_REF = () => doc(db, 'artifacts', appId, 'adminSettings', 'restaurantStats');

let currentRestaurantFilter = 'all';
let currentRestaurantSlotFilter = 'all';
/** 식당 집계 화면을 한 번이라도 성공적으로 그린 뒤에만 필터 전환이 getDoc/병합 로직을 탑니다 */
let adminRestaurantMonitoringRendered = false;

const MEAL_SLOTS = ['morning', 'lunch', 'dinner'];
const SNACK_SLOTS = ['pre_morning', 'snack1', 'snack2', 'night'];

function cacheHasSlotBreakdown(cachedList) {
    return (
        Array.isArray(cachedList) &&
        cachedList.length > 0 &&
        typeof cachedList[0].countMeal === 'number' &&
        typeof cachedList[0].countSnack === 'number'
    );
}

/**
 * 식사/간식 슬롯 구분 집계(캐시에 countMeal·countSnack 저장 → 슬롯 탭에서 전체 스캔 생략)
 */
function applyMealToRestaurantAggregate(restaurantMap, mealData) {
    const place = mealData.place;
    if (!place || place.trim() === '') return;

    const slotId = mealData.slotId || '';
    const isMealSlot = MEAL_SLOTS.includes(slotId);
    const isSnackSlot = SNACK_SLOTS.includes(slotId);

    const placeKey = place.trim();
    const hasPlaceId = !!(mealData.placeId || mealData.kakaoPlaceId);
    const hasPlaceData = !!mealData.placeData;
    const hasKakaoPlace = mealData.kakaoPlace === true || mealData.kakaoPlace === 'true';
    const isKakao = hasPlaceId || hasPlaceData || hasKakaoPlace;
    const placeId = mealData.placeId || mealData.kakaoPlaceId || null;
    const address = mealData.placeAddress || mealData.address || null;

    if (!restaurantMap.has(placeKey)) {
        restaurantMap.set(placeKey, {
            name: placeKey,
            count: 0,
            countMeal: 0,
            countSnack: 0,
            firstSeen: mealData.date || null,
            lastSeen: mealData.date || null,
            isKakao: isKakao,
            placeId: placeId,
            address: address,
            kakaoCount: 0,
            manualCount: 0
        });
    }
    const restaurant = restaurantMap.get(placeKey);
    restaurant.count++;
    if (isMealSlot) restaurant.countMeal = (restaurant.countMeal || 0) + 1;
    if (isSnackSlot) restaurant.countSnack = (restaurant.countSnack || 0) + 1;
    if (isKakao) {
        restaurant.isKakao = true;
        restaurant.kakaoCount++;
        if (placeId && !restaurant.placeId) restaurant.placeId = placeId;
        if (address && !restaurant.address) restaurant.address = address;
    } else {
        restaurant.manualCount++;
    }
    if (mealData.date) {
        if (!restaurant.firstSeen || mealData.date < restaurant.firstSeen) restaurant.firstSeen = mealData.date;
        if (!restaurant.lastSeen || mealData.date > restaurant.lastSeen) restaurant.lastSeen = mealData.date;
    }
}

function finalizeRestaurantMapForSlot(restaurantMap, slotFilter) {
    if (slotFilter === 'all') return restaurantMap;
    const out = new Map();
    for (const [k, r] of restaurantMap) {
        const n = slotFilter === 'meal' ? r.countMeal : r.countSnack;
        if (n > 0) {
            out.set(k, { ...r, count: n });
        }
    }
    return out;
}

/** 'YYYY-MM-DD' 다음 날. 못 읽으면 '' */
function nextDateKey(dateKey) {
    const p = String(dateKey || '').split('-');
    if (p.length !== 3) return '';
    const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    if (Number.isNaN(d.getTime())) return '';
    d.setDate(d.getDate() + 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}

function restaurantArrayToMap(arr) {
    const map = new Map();
    (arr || []).forEach((r) => map.set(r.name, { ...r }));
    return map;
}

/**
 * 지정 구간의 meals 를 훑어 식당 집계에 반영한다.
 *
 * 예전에는 users 를 전부 읽고 사용자마다 meals 를 통째로 가져왔다(1만 건 넘음).
 * collectionGroup 에 날짜 범위를 걸면 필요한 구간만 한 번에 읽는다.
 *
 * @param {Map} restaurantMap 여기에 더한다
 * @param {string} fromDateKey 포함
 * @param {string} toDateKey 포함
 * @returns {Promise<number>} 읽은 문서 수
 */
async function accumulateRestaurantsFromMeals(restaurantMap, fromDateKey, toDateKey) {
    if (!fromDateKey || !toDateKey || fromDateKey > toDateKey) return 0;
    const mealsGroup = collectionGroup(db, 'meals');
    const snap = await getDocs(
        query(mealsGroup, where('date', '>=', fromDateKey), where('date', '<=', toDateKey))
    );
    const prefix = `artifacts/${appId}/`;
    let n = 0;
    snap.forEach((docSnap) => {
        if (!docSnap.ref.path.startsWith(prefix)) return;
        applyMealToRestaurantAggregate(restaurantMap, docSnap.data());
        n++;
    });
    return n;
}

/** 운영 시작일부터 오늘까지 전량 집계 (캐시가 없거나 못 믿을 때만) */
async function fetchRestaurantAggregateMap() {
    const restaurantMap = new Map();
    const todayStr = getTodayDateString();
    const n = await accumulateRestaurantsFromMeals(restaurantMap, RESTAURANT_SCAN_MIN_DATE, todayStr);
    console.log('🍽️ 식당 통계 전량 집계:', { from: RESTAURANT_SCAN_MIN_DATE, to: todayStr, meals: n });
    return restaurantMap;
}

async function fetchAllRestaurantsFull(slotFilter) {
    const agg = await fetchRestaurantAggregateMap();
    return finalizeRestaurantMapForSlot(agg, slotFilter);
}

async function renderRestaurantData(filter = 'all', slotFilter = 'all') {
    const container = document.getElementById('restaurantsContainer');
    if (!container) return;

    currentRestaurantFilter = filter;
    if (slotFilter === undefined) slotFilter = currentRestaurantSlotFilter;

    container.innerHTML = `
        <div class="text-center py-8 text-slate-400">
            <i data-lucide="loader-circle" class="text-2xl mb-2 lucide-spin"></i>
            <p>로딩 중...</p>
        </div>
    `;

    try {
        const todayStr = getTodayDateString();
        const cacheSnap = await getDoc(RESTAURANT_STATS_REF());
        let restaurantMap;

        const cacheData = cacheSnap.exists() ? cacheSnap.data() : null;
        const cachedList = cacheData?.restaurants || [];
        const cacheExists = !!(cacheData?.asOfDate && cachedList.length);
        const asOfDate = cacheExists ? cacheData.asOfDate : null;
        const breakdownOk = cacheHasSlotBreakdown(cachedList);

        if (cacheExists && (slotFilter === 'all' || breakdownOk)) {
            restaurantMap = restaurantArrayToMap(cachedList);
            if (asOfDate !== todayStr) {
                /**
                 * 예전에는 **오늘 하루치만** 더했다. 캐시 저장은 slotFilter==='all' 일 때만 일어나서,
                 * 다른 필터로만 열다 보면 asOfDate 가 몇 달씩 멈춰 있었고 그 사이 기록이 통째로 빠졌다.
                 * 이제 캐시 날짜 다음날부터 오늘까지를 메우고, 필터와 무관하게 저장한다.
                 */
                const fromKey = nextDateKey(asOfDate) || todayStr;
                const filled = await accumulateRestaurantsFromMeals(restaurantMap, fromKey, todayStr);
                console.log('🍽️ 식당 통계 증분:', { from: fromKey, to: todayStr, meals: filled });
                const mergedList = Array.from(restaurantMap.values());
                await setDoc(
                    RESTAURANT_STATS_REF(),
                    { asOfDate: todayStr, restaurants: mergedList },
                    { merge: true }
                );
            }
            restaurantMap = finalizeRestaurantMapForSlot(restaurantMap, slotFilter);
        } else if (slotFilter === 'all') {
            const agg = await fetchRestaurantAggregateMap();
            const list = Array.from(agg.values());
            await setDoc(RESTAURANT_STATS_REF(), { asOfDate: todayStr, restaurants: list }, { merge: true });
            restaurantMap = finalizeRestaurantMapForSlot(agg, 'all');
        } else {
            restaurantMap = await fetchAllRestaurantsFull(slotFilter);
        }

        let restaurants = Array.from(restaurantMap.values());

        const totalCount = restaurants.length;
        const kakaoCount = restaurants.filter((r) => r.isKakao).length;
        const manualCount = restaurants.filter((r) => !r.isKakao).length;
        console.log('📊 식당 통계:', {
            total: totalCount,
            kakao: kakaoCount,
            manual: manualCount,
            filter: filter,
            kakaoRestaurants: restaurants.filter((r) => r.isKakao).slice(0, 5).map((r) => ({ name: r.name, placeId: r.placeId, address: r.address }))
        });

        if (filter === 'kakao' && kakaoCount === 0 && totalCount > 0) {
            console.warn('⚠️ 카카오맵 필터가 선택되었지만 카카오맵 식당이 없습니다.');
            console.warn('   - 기존 데이터에 카카오맵 정보(placeId, kakaoPlaceId 등)가 저장되지 않았을 수 있습니다.');
            console.warn('   - 새로 입력하는 식당은 카카오맵 정보가 저장됩니다.');
        }

        if (filter === 'kakao') {
            restaurants = restaurants.filter((r) => r.isKakao);
            console.log('카카오맵 필터 적용 후:', restaurants.length, '개');
        } else if (filter === 'manual') {
            restaurants = restaurants.filter((r) => !r.isKakao);
            console.log('수동입력 필터 적용 후:', restaurants.length, '개');
        }

        restaurants.sort((a, b) => b.count - a.count);

        const slotLabel = slotFilter === 'all' ? '' : slotFilter === 'meal' ? ' (식사만)' : ' (간식만)';
        if (restaurants.length === 0) {
            const filterMsg = filter === 'all' ? '등록된 식당 정보가 없습니다.' : filter === 'kakao' ? '카카오맵으로 입력된 식당이 없습니다.' : '수동으로 입력된 식당이 없습니다.';
            container.innerHTML = `
                <div class="text-center py-12 text-slate-400">
                    <i data-lucide="utensils" class="text-4xl mb-4"></i>
                    <p class="text-sm font-bold">${filterMsg}${slotLabel}</p>
                </div>
            `;
            adminRestaurantMonitoringRendered = true;
            return;
        }

        container.innerHTML = `
            <div class="overflow-x-auto">
                <table class="w-full">
                    <thead class="bg-slate-50 border-b border-slate-200">
                        <tr>
                            <th class="px-4 py-3 text-left text-xs font-bold text-slate-600 uppercase">순위</th>
                            <th class="px-4 py-3 text-left text-xs font-bold text-slate-600 uppercase">식당명</th>
                            <th class="px-4 py-3 text-left text-xs font-bold text-slate-600 uppercase">입력 횟수</th>
                            <th class="px-4 py-3 text-left text-xs font-bold text-slate-600 uppercase">입력 방식</th>
                            <th class="px-4 py-3 text-left text-xs font-bold text-slate-600 uppercase">최초 입력</th>
                            <th class="px-4 py-3 text-left text-xs font-bold text-slate-600 uppercase">최근 입력</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-slate-100">
                        ${restaurants
                            .map((restaurant, index) => {
                                const inputTypeBadge = restaurant.isKakao
                                    ? `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-100 text-blue-700">
                                    <i data-lucide="map-pin" class="mr-1"></i>카카오맵
                                   </span>`
                                    : `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-700">
                                    <i data-lucide="keyboard" class="mr-1"></i>수동입력
                                   </span>`;

                                const countDetail =
                                    restaurant.isKakao && restaurant.manualCount > 0
                                        ? `<div class="text-xs text-slate-500 mt-1">카카오: ${restaurant.kakaoCount}회, 수동: ${restaurant.manualCount}회</div>`
                                        : '';

                                return `
                            <tr class="hover:bg-slate-50 transition-colors">
                                <td class="px-4 py-3 text-sm font-bold text-slate-700">${index + 1}</td>
                                <td class="px-4 py-3 text-sm text-slate-800">
                                    <div class="font-bold">${escapeHtml(restaurant.name)}</div>
                                    ${restaurant.address ? `<div class="text-xs text-slate-500 mt-1">${escapeHtml(restaurant.address)}</div>` : ''}
                                </td>
                                <td class="px-4 py-3 text-sm">
                                    <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700">
                                        ${restaurant.count}회
                                    </span>
                                    ${countDetail}
                                </td>
                                <td class="px-4 py-3 text-sm">${inputTypeBadge}</td>
                                <td class="px-4 py-3 text-sm text-slate-600">${restaurant.firstSeen || '-'}</td>
                                <td class="px-4 py-3 text-sm text-slate-600">${restaurant.lastSeen || '-'}</td>
                            </tr>
                        `;
                            })
                            .join('')}
                    </tbody>
                </table>
            </div>
            <div class="mt-4 text-sm text-slate-500 text-center">
                총 ${restaurants.length}개의 식당이 ${filter === 'all' ? '등록' : filter === 'kakao' ? '카카오맵으로 입력' : '수동으로 입력'}되어 있습니다.
                ${slotLabel}
            </div>
        `;
        adminRestaurantMonitoringRendered = true;
    } catch (e) {
        adminRestaurantMonitoringRendered = false;
        console.error('식당정보 조회 실패:', e);
        container.innerHTML = `
            <div class="text-center py-8 text-red-400">
                <i data-lucide="circle-alert" class="text-2xl mb-2"></i>
                <p>데이터를 불러오는 중 오류가 발생했습니다.</p>
                <p class="text-xs mt-2">${e.message}</p>
            </div>
        `;
    }
}

/** 모니터링 사이드바에서 식당 탭 진입 시 현재 필터로 렌더 */
export function renderRestaurantDataForMonitoringSidebar() {
    return renderRestaurantData(currentRestaurantFilter || 'all', currentRestaurantSlotFilter || 'all');
}

export function registerRestaurantStats() {
    window.renderRestaurantData = renderRestaurantData;
    window.setRestaurantFilter = function (filter) {
        document.querySelectorAll('.restaurant-filter-btn').forEach((btn) => {
            btn.classList.remove('bg-emerald-600', 'text-white');
            btn.classList.add('bg-slate-100', 'text-slate-600', 'hover:bg-slate-200');
        });
        const activeFilterBtn = document.getElementById(`restaurant-filter-${filter}`);
        if (activeFilterBtn) {
            activeFilterBtn.classList.remove('bg-slate-100', 'text-slate-600', 'hover:bg-slate-200');
            activeFilterBtn.classList.add('bg-emerald-600', 'text-white');
        }
        currentRestaurantFilter = filter;
        if (!adminRestaurantMonitoringRendered) return;
        renderRestaurantData(filter, currentRestaurantSlotFilter);
    };
    window.setRestaurantSlotFilter = function (slotFilter) {
        currentRestaurantSlotFilter = slotFilter;
        document.querySelectorAll('.restaurant-slot-filter-btn').forEach((btn) => {
            btn.classList.remove('bg-emerald-600', 'text-white');
            btn.classList.add('bg-slate-100', 'text-slate-600', 'hover:bg-slate-200');
        });
        const activeBtn = document.getElementById(`restaurant-slot-filter-${slotFilter}`);
        if (activeBtn) {
            activeBtn.classList.remove('bg-slate-100', 'text-slate-600', 'hover:bg-slate-200');
            activeBtn.classList.add('bg-emerald-600', 'text-white');
        }
        if (!adminRestaurantMonitoringRendered) return;
        renderRestaurantData(currentRestaurantFilter, slotFilter);
    };
    window.refreshRestaurantData = async function () {
        await runAdminRefreshAction(document.getElementById('adminRefreshRestaurantsBtn'), async () => {
            const container = document.getElementById('restaurantsContainer');
            if (!container) return;
            adminRestaurantMonitoringRendered = false;
            container.innerHTML = `
        <div class="text-center py-8 text-slate-400">
            <i data-lucide="loader-circle" class="text-2xl mb-2 lucide-spin"></i>
            <p>전체 집계 중...</p>
        </div>
    `;
            try {
                const agg = await fetchRestaurantAggregateMap();
                const list = Array.from(agg.values());
                await setDoc(RESTAURANT_STATS_REF(), { asOfDate: getTodayDateString(), restaurants: list }, { merge: true });
                await renderRestaurantData(currentRestaurantFilter, currentRestaurantSlotFilter);
            } catch (e) {
                console.error('식당정보 새로고침 실패:', e);
                container.innerHTML = `<div class="text-center py-8 text-red-400"><p>새로고침 중 오류가 발생했습니다.</p></div>`;
            }
        });
    };
}
