/**
 * 관리자 > 모니터링 > 식당정보 집계·필터 (Firestore 캐시 문서 adminSettings/restaurantStats)
 */
import { db, appId } from '../firebase.js';
import {
    doc,
    getDoc,
    setDoc,
    collection,
    query,
    where,
    getDocs,
    collectionGroup
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';
import { getTodayDateString, escapeHtml } from './utils.js';

const RESTAURANT_STATS_REF = () => doc(db, 'artifacts', appId, 'adminSettings', 'restaurantStats');

let currentRestaurantFilter = 'all';
let currentRestaurantSlotFilter = 'all';

const MEAL_SLOTS = ['morning', 'lunch', 'dinner'];
const SNACK_SLOTS = ['pre_morning', 'snack1', 'snack2', 'night'];

function applyMealToRestaurantMap(restaurantMap, mealData, slotFilter) {
    const place = mealData.place;
    const slotId = mealData.slotId || '';
    if (slotFilter === 'meal' && !MEAL_SLOTS.includes(slotId)) return;
    if (slotFilter === 'snack' && !SNACK_SLOTS.includes(slotId)) return;
    if (!place || place.trim() === '') return;

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

async function getTodayMealsForRestaurants() {
    const todayStr = getTodayDateString();
    const mealsGroup = collectionGroup(db, 'meals');
    const q = query(mealsGroup, where('date', '==', todayStr));
    const snap = await getDocs(q);
    const prefix = `artifacts/${appId}/`;
    return snap.docs.filter(d => d.ref.path.startsWith(prefix)).map(d => d.data());
}

function restaurantArrayToMap(arr) {
    const map = new Map();
    (arr || []).forEach(r => map.set(r.name, { ...r }));
    return map;
}

async function fetchAllRestaurantsFull(slotFilter) {
    const usersColl = collection(db, 'artifacts', appId, 'users');
    const usersSnapshot = await getDocs(usersColl);
    const restaurantMap = new Map();
    for (const userDoc of usersSnapshot.docs) {
        try {
            const mealsColl = collection(db, 'artifacts', appId, 'users', userDoc.id, 'meals');
            const mealsSnapshot = await getDocs(mealsColl);
            mealsSnapshot.docs.forEach(mealDoc => applyMealToRestaurantMap(restaurantMap, mealDoc.data(), slotFilter));
        } catch (e) {
            console.warn(`사용자 ${userDoc.id} meals 조회 실패:`, e);
        }
    }
    return restaurantMap;
}

async function renderRestaurantData(filter = 'all', slotFilter = 'all') {
    const container = document.getElementById('restaurantsContainer');
    if (!container) return;

    currentRestaurantFilter = filter;
    if (slotFilter === undefined) slotFilter = currentRestaurantSlotFilter;

    container.innerHTML = `
        <div class="text-center py-8 text-slate-400">
            <i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i>
            <p>로딩 중...</p>
        </div>
    `;

    try {
        const todayStr = getTodayDateString();
        const cacheSnap = await getDoc(RESTAURANT_STATS_REF());
        let restaurantMap;

        if (slotFilter === 'all' && cacheSnap.exists() && cacheSnap.data().asOfDate && cacheSnap.data().restaurants) {
            const data = cacheSnap.data();
            const asOfDate = data.asOfDate;
            const cachedList = data.restaurants || [];

            if (asOfDate === todayStr) {
                restaurantMap = restaurantArrayToMap(cachedList);
            } else {
                restaurantMap = restaurantArrayToMap(cachedList);
                const todayMeals = await getTodayMealsForRestaurants();
                todayMeals.forEach(mealData => applyMealToRestaurantMap(restaurantMap, mealData, 'all'));
                const mergedList = Array.from(restaurantMap.values());
                await setDoc(RESTAURANT_STATS_REF(), { asOfDate: todayStr, restaurants: mergedList }, { merge: true });
            }
        } else if (slotFilter === 'all') {
            restaurantMap = await fetchAllRestaurantsFull('all');
            const list = Array.from(restaurantMap.values());
            await setDoc(RESTAURANT_STATS_REF(), { asOfDate: todayStr, restaurants: list }, { merge: true });
        } else {
            restaurantMap = await fetchAllRestaurantsFull(slotFilter);
        }

        let restaurants = Array.from(restaurantMap.values());

        const totalCount = restaurants.length;
        const kakaoCount = restaurants.filter(r => r.isKakao).length;
        const manualCount = restaurants.filter(r => !r.isKakao).length;
        console.log('📊 식당 통계:', {
            total: totalCount,
            kakao: kakaoCount,
            manual: manualCount,
            filter: filter,
            kakaoRestaurants: restaurants.filter(r => r.isKakao).slice(0, 5).map(r => ({ name: r.name, placeId: r.placeId, address: r.address }))
        });

        if (filter === 'kakao' && kakaoCount === 0 && totalCount > 0) {
            console.warn('⚠️ 카카오맵 필터가 선택되었지만 카카오맵 식당이 없습니다.');
            console.warn('   - 기존 데이터에 카카오맵 정보(placeId, kakaoPlaceId 등)가 저장되지 않았을 수 있습니다.');
            console.warn('   - 새로 입력하는 식당은 카카오맵 정보가 저장됩니다.');
        }

        if (filter === 'kakao') {
            restaurants = restaurants.filter(r => r.isKakao);
            console.log('카카오맵 필터 적용 후:', restaurants.length, '개');
        } else if (filter === 'manual') {
            restaurants = restaurants.filter(r => !r.isKakao);
            console.log('수동입력 필터 적용 후:', restaurants.length, '개');
        }

        restaurants.sort((a, b) => b.count - a.count);

        const slotLabel = slotFilter === 'all' ? '' : slotFilter === 'meal' ? ' (식사만)' : ' (간식만)';
        if (restaurants.length === 0) {
            const filterMsg = filter === 'all' ? '등록된 식당 정보가 없습니다.' : filter === 'kakao' ? '카카오맵으로 입력된 식당이 없습니다.' : '수동으로 입력된 식당이 없습니다.';
            container.innerHTML = `
                <div class="text-center py-12 text-slate-400">
                    <i class="fa-solid fa-utensils text-4xl mb-4"></i>
                    <p class="text-sm font-bold">${filterMsg}${slotLabel}</p>
                </div>
            `;
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
                        ${restaurants.map((restaurant, index) => {
            const inputTypeBadge = restaurant.isKakao
                ? `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-100 text-blue-700">
                                    <i class="fa-solid fa-map-marker-alt mr-1"></i>카카오맵
                                   </span>`
                : `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-700">
                                    <i class="fa-solid fa-keyboard mr-1"></i>수동입력
                                   </span>`;

            const countDetail = restaurant.isKakao && restaurant.manualCount > 0
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
        }).join('')}
                    </tbody>
                </table>
            </div>
            <div class="mt-4 text-sm text-slate-500 text-center">
                총 ${restaurants.length}개의 식당이 ${filter === 'all' ? '등록' : filter === 'kakao' ? '카카오맵으로 입력' : '수동으로 입력'}되어 있습니다.
                ${slotLabel}
            </div>
        `;

    } catch (e) {
        console.error('식당정보 조회 실패:', e);
        container.innerHTML = `
            <div class="text-center py-8 text-red-400">
                <i class="fa-solid fa-circle-exclamation text-2xl mb-2"></i>
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
    window.setRestaurantFilter = function(filter) {
        document.querySelectorAll('.restaurant-filter-btn').forEach(btn => {
            btn.classList.remove('bg-emerald-600', 'text-white');
            btn.classList.add('bg-slate-100', 'text-slate-600', 'hover:bg-slate-200');
        });
        const activeFilterBtn = document.getElementById(`restaurant-filter-${filter}`);
        if (activeFilterBtn) {
            activeFilterBtn.classList.remove('bg-slate-100', 'text-slate-600', 'hover:bg-slate-200');
            activeFilterBtn.classList.add('bg-emerald-600', 'text-white');
        }
        renderRestaurantData(filter, currentRestaurantSlotFilter);
    };
    window.setRestaurantSlotFilter = function(slotFilter) {
        currentRestaurantSlotFilter = slotFilter;
        document.querySelectorAll('.restaurant-slot-filter-btn').forEach(btn => {
            btn.classList.remove('bg-emerald-600', 'text-white');
            btn.classList.add('bg-slate-100', 'text-slate-600', 'hover:bg-slate-200');
        });
        const activeBtn = document.getElementById(`restaurant-slot-filter-${slotFilter}`);
        if (activeBtn) {
            activeBtn.classList.remove('bg-slate-100', 'text-slate-600', 'hover:bg-slate-200');
            activeBtn.classList.add('bg-emerald-600', 'text-white');
        }
        renderRestaurantData(currentRestaurantFilter, slotFilter);
    };
    window.refreshRestaurantData = async function() {
        const container = document.getElementById('restaurantsContainer');
        if (!container) return;
        container.innerHTML = `
        <div class="text-center py-8 text-slate-400">
            <i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i>
            <p>전체 집계 중...</p>
        </div>
    `;
        try {
            const slotFilter = currentRestaurantSlotFilter;
            const restaurantMap = await fetchAllRestaurantsFull(slotFilter === 'all' ? 'all' : slotFilter);
            if (slotFilter === 'all') {
                const list = Array.from(restaurantMap.values());
                await setDoc(RESTAURANT_STATS_REF(), { asOfDate: getTodayDateString(), restaurants: list }, { merge: true });
            }
            await renderRestaurantData(currentRestaurantFilter, currentRestaurantSlotFilter);
        } catch (e) {
            console.error('식당정보 새로고침 실패:', e);
            container.innerHTML = `<div class="text-center py-8 text-red-400"><p>새로고침 중 오류가 발생했습니다.</p></div>`;
        }
    };
}
