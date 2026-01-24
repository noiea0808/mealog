// 데이터 로딩 관련 함수들
import { db, appId } from '../firebase.js';
import { collection, query, where, orderBy, getDocs } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { toLocalDateString, uploadBase64ToStorage } from '../utils.js';
import { showToast } from '../ui.js';

// 더보기 함수: 추가 기간의 데이터 로드
export async function loadMoreMeals(monthsToLoad = 1) {
    if (!window.currentUser) {
        console.error("로그인이 필요합니다.");
        return 0;
    }
    
    try {
        const currentStart = window.loadedMealsDateRange?.start;
        if (!currentStart) {
            console.error("로드된 데이터 범위 정보가 없습니다.");
            return 0;
        }
        
        // 추가로 로드할 시작 날짜 계산
        const newStartDate = new Date(currentStart);
        newStartDate.setMonth(newStartDate.getMonth() - monthsToLoad);
        const newStartStr = newStartDate.toISOString().split('T')[0];
        
        const q = query(
            collection(db, 'artifacts', appId, 'users', window.currentUser.uid, 'meals'),
            where('date', '>=', newStartStr),
            where('date', '<', currentStart),
            orderBy('date', 'desc')
        );
        
        const snapshot = await getDocs(q);
        const additionalMeals = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        
        // 기존 데이터와 병합 (중복 제거)
        const existingIds = new Set(window.mealHistory.map(m => m.id));
        const newMeals = additionalMeals.filter(m => !existingIds.has(m.id));
        
        if (newMeals.length > 0) {
            window.mealHistory = [...window.mealHistory, ...newMeals]
                .sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
            
            // 로드된 범위 업데이트
            window.loadedMealsDateRange.start = newStartStr;
        }
        
        return newMeals.length;
    } catch (e) {
        console.error("Load More Meals Error:", e);
        // 인덱스 없을 경우 fallback 시도
        if (e.code === 'failed-precondition') {
            console.warn("날짜 범위 쿼리 인덱스가 없습니다. Firestore 콘솔에서 인덱스를 생성해주세요.");
        }
        throw e;
    }
}

// 특정 날짜 범위의 데이터 로드 (대시보드용)
export async function loadMealsForDateRange(startDate, endDate) {
    if (!window.currentUser) {
        console.error("로그인이 필요합니다.");
        return 0;
    }
    
    try {
        const startStr = typeof startDate === 'string' ? startDate : toLocalDateString(startDate);
        const endStr = typeof endDate === 'string' ? endDate : toLocalDateString(endDate);
        
        // 이미 로드된 범위 확인
        if (window.loadedMealsDateRange) {
            const loadedStart = new Date(window.loadedMealsDateRange.start);
            const loadedEnd = new Date(window.loadedMealsDateRange.end);
            const requestedStart = new Date(startStr);
            const requestedEnd = new Date(endStr);
            
            // 요청한 범위가 이미 로드된 범위에 포함되는지 확인
            if (requestedStart >= loadedStart && requestedEnd <= loadedEnd) {
                return 0;
            }
        }
        
        const q = query(
            collection(db, 'artifacts', appId, 'users', window.currentUser.uid, 'meals'),
            where('date', '>=', startStr),
            where('date', '<=', endStr),
            orderBy('date', 'desc')
        );
        
        const snapshot = await getDocs(q);
        const additionalMeals = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        
        // 기존 데이터와 병합 (중복 제거)
        const existingIds = new Set(window.mealHistory.map(m => m.id));
        const newMeals = additionalMeals.filter(m => !existingIds.has(m.id));
        
        if (newMeals.length > 0) {
            window.mealHistory = [...window.mealHistory, ...newMeals]
                .sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
            
            // 로드된 범위 업데이트
            if (!window.loadedMealsDateRange) {
                window.loadedMealsDateRange = { start: startStr, end: endStr };
            } else {
                const currentStart = new Date(window.loadedMealsDateRange.start);
                const currentEnd = new Date(window.loadedMealsDateRange.end);
                const newStart = new Date(startStr);
                const newEnd = new Date(endStr);
                
                window.loadedMealsDateRange.start = newStart < currentStart ? startStr : window.loadedMealsDateRange.start;
                window.loadedMealsDateRange.end = newEnd > currentEnd ? endStr : window.loadedMealsDateRange.end;
            }
        }
        
        return newMeals.length;
    } catch (e) {
        console.error("Load Meals For Date Range Error:", e);
        if (e.code === 'failed-precondition') {
            console.warn("날짜 범위 쿼리 인덱스가 없습니다. Firestore 콘솔에서 인덱스를 생성해주세요.");
        }
        throw e;
    }
}

// base64 이미지를 Firebase Storage로 마이그레이션
export async function migrateBase64ImagesToStorage() {
    if (!window.currentUser) {
        showToast("마이그레이션 실패: 로그인이 필요합니다.", 'error');
        throw new Error("로그인이 필요합니다.");
    }
    
    try {
        showToast("마이그레이션을 시작합니다...", 'info');
        
        const userId = window.currentUser.uid;
        const mealsColl = collection(db, 'artifacts', appId, 'users', userId, 'meals');
        
        // 모든 meal 기록 가져오기
        const snapshot = await getDocs(mealsColl);
        const meals = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        
        console.log(`총 ${meals.length}개의 기록을 확인합니다.`);
        
        let migratedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;
        
        // 각 기록을 순회하며 base64 이미지 찾기
        for (let i = 0; i < meals.length; i++) {
            const meal = meals[i];
            const mealId = meal.id;
            
            if (!meal.photos || !Array.isArray(meal.photos) || meal.photos.length === 0) {
                skippedCount++;
                continue;
            }
            
            // base64 이미지가 있는지 확인
            const base64Photos = meal.photos.filter(photo => 
                typeof photo === 'string' && photo.startsWith('data:image')
            );
            
            if (base64Photos.length === 0) {
                skippedCount++;
                continue;
            }
            
            try {
                // base64 이미지를 Storage에 업로드
                const uploadPromises = base64Photos.map(base64Photo => 
                    uploadBase64ToStorage(base64Photo, userId, mealId)
                );
                
                const uploadedUrls = await Promise.all(uploadPromises);
                
                // 기존 URL 이미지와 새로 업로드한 URL 합치기
                const existingUrls = meal.photos.filter(photo => 
                    typeof photo === 'string' && (photo.startsWith('http://') || photo.startsWith('https://'))
                );
                
                const newPhotos = [...existingUrls, ...uploadedUrls];
                
                // Firestore 업데이트
                const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
                const mealRef = doc(mealsColl, mealId);
                await setDoc(mealRef, { ...meal, photos: newPhotos }, { merge: true });
                
                migratedCount++;
                
                // 진행 상황 표시 (10개마다)
                if ((i + 1) % 10 === 0) {
                    showToast(`마이그레이션 진행 중... ${i + 1}/${meals.length}`, 'info');
                }
                
            } catch (error) {
                console.error(`기록 ${mealId} 마이그레이션 실패:`, error);
                errorCount++;
                // 개별 실패는 건너뛰고 계속 진행
            }
        }
        
        const message = `마이그레이션 완료! 성공: ${migratedCount}개, 건너뜀: ${skippedCount}개, 실패: ${errorCount}개`;
        showToast(message, 'success');
        
        return {
            total: meals.length,
            migrated: migratedCount,
            skipped: skippedCount,
            errors: errorCount
        };
        
    } catch (error) {
        console.error("마이그레이션 오류:", error);
        showToast("마이그레이션 실패: " + error.message, 'error');
        throw error;
    }
}
