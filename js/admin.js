// ADMIN 관리자 페이지 관련 함수들
import { auth, db, appId } from './firebase.js';
import { GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { collection, getDocs, query, orderBy, limit, doc, deleteDoc, getDoc, setDoc, where } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

let currentDeletePhotoId = null;

// ADMIN 권한 확인
async function checkAdminStatus(userId) {
    if (!userId) {
        console.log('❌ ADMIN 체크: userId가 없습니다.');
        return false;
    }
    
    try {
        const adminDocRef = doc(db, 'artifacts', appId, 'admins', userId);
        console.log('🔍 ADMIN 체크 중:', {
            userId: userId,
            path: `artifacts/${appId}/admins/${userId}`
        });
        
        const adminDoc = await getDoc(adminDocRef);
        
        if (!adminDoc.exists()) {
            console.log('❌ ADMIN 문서가 존재하지 않습니다:', userId);
            console.log('💡 Firebase 콘솔에서 확인하세요: artifacts/mealog-r0/admins/{사용자UID}');
            return false;
        }
        
        const adminData = adminDoc.data();
        console.log('📄 ADMIN 문서 데이터:', adminData);
        
        const isAdmin = adminData.isAdmin === true;
        if (!isAdmin) {
            console.log('❌ isAdmin 필드가 true가 아닙니다:', adminData.isAdmin);
        } else {
            console.log('✅ ADMIN 권한 확인됨!');
        }
        
        return isAdmin;
    } catch (e) {
        console.error("❌ ADMIN 체크 오류:", e);
        return false;
    }
}

// 사용자 통계 조회
async function getUserStatistics() {
    try {
        // 공유 게시물에서 사용자 정보 먼저 추출
        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
        const sharedSnapshot = await getDocs(sharedColl);
        const uniqueUserIds = new Set();
        const userMap = new Map(); // userId -> { email, nickname, icon, lastActivity }
        
        sharedSnapshot.forEach(doc => {
            const data = doc.data();
            if (data.userId) {
                uniqueUserIds.add(data.userId);
                if (!userMap.has(data.userId)) {
                    userMap.set(data.userId, {
                        userId: data.userId,
                        email: null,
                        nickname: data.userNickname || '익명',
                        icon: data.userIcon || '🐻',
                        lastActivity: data.timestamp ? new Date(data.timestamp) : null
                    });
                } else {
                    // 마지막 활동 업데이트
                    const userInfo = userMap.get(data.userId);
                    if (data.timestamp) {
                        const ts = new Date(data.timestamp);
                        if (!userInfo.lastActivity || ts > userInfo.lastActivity) {
                            userInfo.lastActivity = ts;
                        }
                    }
                }
            }
        });
        
        console.log('📸 공유 게시물에서 발견된 사용자:', uniqueUserIds.size, '명');
        console.log('   사용자 ID 목록:', Array.from(uniqueUserIds));
        
        // users 컬렉션 조회 시도
        let usersSnapshot;
        let usersFromCollection = 0;
        try {
            const usersColl = collection(db, 'artifacts', appId, 'users');
            usersSnapshot = await getDocs(usersColl);
            usersFromCollection = usersSnapshot.size;
            console.log('✅ users 컬렉션 조회 성공:', usersFromCollection, '개 문서');
            
            // users 컬렉션의 사용자 정보 업데이트
            usersSnapshot.forEach(userDoc => {
                const userId = userDoc.id;
                const userData = userDoc.data();
                if (userMap.has(userId)) {
                    const userInfo = userMap.get(userId);
                    if (userData.config && userData.config.settings && userData.config.settings.profile) {
                        userInfo.nickname = userData.config.settings.profile.nickname || userInfo.nickname;
                        userInfo.icon = userData.config.settings.profile.icon || userInfo.icon;
                    }
                }
            });
        } catch (usersError) {
            console.warn('⚠️ users 컬렉션 조회 실패 (공유 게시물 데이터 사용):', usersError);
            usersSnapshot = { docs: [], size: 0 };
        }
        
        // 통계 계산을 위한 날짜 설정
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const last7Days = new Date(today);
        last7Days.setDate(last7Days.getDate() - 7);
        const last30Days = new Date(today);
        last30Days.setDate(last30Days.getDate() - 30);
        
        const stats = {
            totalUsers: Math.max(usersFromCollection, uniqueUserIds.size), // 둘 중 큰 값 사용
            activeUsers: 0,
            totalMeals: 0,
            totalSharedPhotos: sharedSnapshot.size,
            recentActivity: {
                last7Days: 0,
                last30Days: 0
            }
        };
        
        console.log('📊 통계 조회 시작:', {
            totalUsers: stats.totalUsers,
            기준일: today.toISOString().split('T')[0],
            last7Days: last7Days.toISOString().split('T')[0],
            last30Days: last30Days.toISOString().split('T')[0]
        });
        
        // 공유 게시물에서 활동 추적
        sharedSnapshot.forEach(doc => {
            const data = doc.data();
            if (data.timestamp) {
                const photoDate = new Date(data.timestamp);
                const photoDateOnly = new Date(photoDate.getFullYear(), photoDate.getMonth(), photoDate.getDate());
                
                if (photoDateOnly >= last30Days) {
                    stats.recentActivity.last30Days++;
                    if (photoDateOnly >= last7Days) {
                        stats.recentActivity.last7Days++;
                    }
                }
            }
        });
        
        // 각 사용자의 meals 데이터 확인
        let processedUsers = 0;
        const userIdsToCheck = usersFromCollection > 0 
            ? usersSnapshot.docs.map(doc => doc.id)
            : Array.from(uniqueUserIds);
        
        for (const userId of userIdsToCheck) {
            processedUsers++;
            console.log(`\n👤 사용자 ${processedUsers}/${userIdsToCheck.length} 처리 중: ${userId}`);
            
            try {
                const mealsColl = collection(db, 'artifacts', appId, 'users', userId, 'meals');
                const mealsSnapshot = await getDocs(mealsColl);
                const userMealsCount = mealsSnapshot.size;
                stats.totalMeals += userMealsCount;
                
                console.log(`  - 식사 기록 수: ${userMealsCount}`);
                
                if (userMealsCount > 0) {
                    let hasRecentActivity30d = false;
                    let sampleDates = [];
                    
                    mealsSnapshot.forEach((mealDoc, index) => {
                        const mealData = mealDoc.data();
                        let mealDate = null;
                        
                        if (mealData.date) {
                            const dateParts = mealData.date.split('-');
                            if (dateParts.length === 3) {
                                mealDate = new Date(
                                    parseInt(dateParts[0]),
                                    parseInt(dateParts[1]) - 1,
                                    parseInt(dateParts[2])
                                );
                            }
                        } else if (mealData.timestamp) {
                            if (mealData.timestamp.toDate) {
                                mealDate = mealData.timestamp.toDate();
                            } else if (typeof mealData.timestamp === 'string') {
                                mealDate = new Date(mealData.timestamp);
                            } else {
                                mealDate = new Date(mealData.timestamp);
                            }
                        }
                        
                        if (index < 3 && mealDate) {
                            sampleDates.push({
                                date: mealData.date || 'N/A',
                                timestamp: mealData.timestamp || 'N/A',
                                parsed: mealDate.toISOString().split('T')[0]
                            });
                        }
                        
                        if (mealDate) {
                            const mealDateOnly = new Date(mealDate.getFullYear(), mealDate.getMonth(), mealDate.getDate());
                            
                            if (mealDateOnly >= last30Days) {
                                stats.recentActivity.last30Days++;
                                hasRecentActivity30d = true;
                                
                                if (mealDateOnly >= last7Days) {
                                    stats.recentActivity.last7Days++;
                                }
                            }
                        }
                    });
                    
                    if (sampleDates.length > 0) {
                        console.log(`  - 샘플 날짜 데이터:`, sampleDates);
                    }
                    
                    if (hasRecentActivity30d) {
                        stats.activeUsers++;
                        console.log(`  ✅ 활성 사용자로 카운트됨`);
                    } else {
                        console.log(`  ⚠️ 30일 내 활동 없음`);
                    }
                } else {
                    console.log(`  - 기록 없음`);
                }
            } catch (e) {
                console.warn(`  ⚠️ 사용자 ${userId}의 meals 조회 실패:`, e.code || e.message);
            }
        }
        
        console.log(`\n📊 사용자 처리 완료: ${processedUsers}명`);
        console.log(`📸 공유 게시물: ${stats.totalSharedPhotos}개`);
        console.log('\n📊 최종 통계:', stats);
        return stats;
    } catch (e) {
        console.error("❌ Get user statistics error:", e);
        console.error("오류 코드:", e.code);
        console.error("오류 메시지:", e.message);
        throw e;
    }
}

// 공유 게시물 조회 (최신순)
async function getSharedPhotos(pageSize = 100) {
    try {
        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
        const q = query(sharedColl, orderBy('timestamp', 'desc'), limit(pageSize));
        const snapshot = await getDocs(q);
        
        return snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
    } catch (e) {
        console.error("Get shared photos error:", e);
        throw e;
    }
}

// 통계 업데이트
async function updateStatistics() {
    try {
        const stats = await getUserStatistics();
        
        document.getElementById('statTotalUsers').textContent = stats.totalUsers.toLocaleString();
        document.getElementById('statActiveUsers').textContent = stats.activeUsers.toLocaleString();
        document.getElementById('statTotalMeals').textContent = stats.totalMeals.toLocaleString();
        document.getElementById('statSharedPhotos').textContent = stats.totalSharedPhotos.toLocaleString();
        document.getElementById('statActivity7d').textContent = stats.recentActivity.last7Days.toLocaleString();
        document.getElementById('statActivity30d').textContent = stats.recentActivity.last30Days.toLocaleString();
    } catch (e) {
        console.error("통계 업데이트 실패:", e);
        alert("통계 조회 중 오류가 발생했습니다: " + e.message);
    }
}

// 공유 게시물 렌더링
async function renderSharedPhotos() {
    const container = document.getElementById('sharedPhotosContainer');
    if (!container) return;
    
    container.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i><p>로딩 중...</p></div>';
    
    try {
        const photos = await getSharedPhotos(100);
        
        if (photos.length === 0) {
            container.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-images text-2xl mb-2"></i><p>공유된 게시물이 없습니다.</p></div>';
            return;
        }
        
        container.innerHTML = photos.map(photo => {
            const date = photo.timestamp ? new Date(photo.timestamp) : new Date();
            const dateStr = date.toLocaleString('ko-KR', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
            
            return `
                <div class="border border-slate-200 rounded-xl p-4 hover:shadow-md transition-shadow">
                    <div class="flex gap-4">
                        ${photo.photoUrl ? `
                            <div class="flex-shrink-0">
                                <img src="${photo.photoUrl}" alt="공유 사진" class="w-20 h-20 object-cover rounded-xl">
                            </div>
                        ` : ''}
                        <div class="flex-1 min-w-0">
                            <div class="flex items-start justify-between mb-2">
                                <div class="flex items-center gap-2">
                                    <span class="text-lg">${photo.userIcon || '🐻'}</span>
                                    <span class="font-bold text-slate-800">${photo.userNickname || '익명'}</span>
                                    ${photo.type === 'best' ? '<span class="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs font-bold rounded">베스트</span>' : ''}
                                    ${photo.type === 'daily' ? '<span class="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs font-bold rounded">일간</span>' : ''}
                                </div>
                                <button onclick="window.openDeleteModal('${photo.id}')" class="px-3 py-1.5 bg-red-50 text-red-600 rounded-lg text-xs font-bold hover:bg-red-100 transition-colors">
                                    <i class="fa-solid fa-trash mr-1"></i>삭제
                                </button>
                            </div>
                            <div class="text-sm text-slate-600 mb-1">
                                ${photo.menuDetail || photo.place || photo.snackType || '내용 없음'}
                            </div>
                            <div class="text-xs text-slate-400">${dateStr}</div>
                            ${photo.comment ? `<div class="mt-2 text-sm text-slate-700 bg-slate-50 p-2 rounded">${photo.comment}</div>` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error("공유 게시물 렌더링 실패:", e);
        container.innerHTML = '<div class="text-center py-8 text-red-400"><i class="fa-solid fa-exclamation-triangle text-2xl mb-2"></i><p>게시물을 불러오는 중 오류가 발생했습니다.</p></div>';
    }
}

// 관리자 로그인
window.handleAdminLogin = async function() {
    const email = document.getElementById('adminEmail').value;
    const password = document.getElementById('adminPassword').value;
    const errorDiv = document.getElementById('loginError');
    
    if (!email || !password) {
        errorDiv.textContent = "이메일과 비밀번호를 입력해주세요.";
        errorDiv.classList.remove('hidden');
        return;
    }
    
    document.getElementById('loadingOverlay').classList.remove('hidden');
    errorDiv.classList.add('hidden');
    
    try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const userId = userCredential.user.uid;
        
        console.log('🔐 로그인 성공:', {
            email: email,
            uid: userId
        });
        
        // ADMIN 권한 확인
        const isAdmin = await checkAdminStatus(userId);
        
        if (!isAdmin) {
            await signOut(auth);
            errorDiv.textContent = "관리자 권한이 없습니다. 브라우저 콘솔(F12)을 확인하세요.";
            errorDiv.classList.remove('hidden');
            document.getElementById('loadingOverlay').classList.add('hidden');
            console.log('❌ 관리자 권한 없음. Firebase 콘솔에서 확인: artifacts/mealog-r0/admins/' + userId);
            return;
        }
        
        // 로그인 성공
        showAdminPage(userCredential.user);
        
    } catch (e) {
        console.error("로그인 실패:", e);
        let errorMsg = "로그인 실패: ";
        if (e.code === 'auth/wrong-password') errorMsg += "비밀번호가 틀렸습니다.";
        else if (e.code === 'auth/user-not-found') errorMsg += "존재하지 않는 계정입니다.";
        else if (e.code === 'auth/invalid-email') errorMsg += "유효하지 않은 이메일입니다.";
        else errorMsg += e.message;
        
        errorDiv.textContent = errorMsg;
        errorDiv.classList.remove('hidden');
    } finally {
        document.getElementById('loadingOverlay').classList.add('hidden');
    }
};

// 관리자 페이지 표시
function showAdminPage(user) {
    const loginPage = document.getElementById('loginPage');
    const adminPage = document.getElementById('adminPage');
    const adminUserInfo = document.getElementById('adminUserInfo');
    const loadingOverlay = document.getElementById('loadingOverlay');
    
    if (loginPage) loginPage.classList.add('hidden');
    if (adminPage) adminPage.classList.remove('hidden');
    if (adminUserInfo) adminUserInfo.textContent = user.email || '관리자';
    
    // 로딩 오버레이 숨기기
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
    
    // 데이터 로드
    updateStatistics();
    renderSharedPhotos();
}

// 관리자 로그아웃
window.handleAdminLogout = async function() {
    try {
        await signOut(auth);
        document.getElementById('adminPage').classList.add('hidden');
        document.getElementById('loginPage').classList.remove('hidden');
        document.getElementById('adminEmail').value = '';
        document.getElementById('adminPassword').value = '';
    } catch (e) {
        console.error("로그아웃 실패:", e);
        alert("로그아웃 중 오류가 발생했습니다.");
    }
};

// 공유 게시물 새로고침
window.refreshSharedPhotos = async function() {
    await renderSharedPhotos();
    await updateStatistics();
};

// 삭제 모달 열기
window.openDeleteModal = function(photoId) {
    currentDeletePhotoId = photoId;
    document.getElementById('deleteModal').classList.remove('hidden');
};

// 삭제 모달 닫기
window.closeDeleteModal = function() {
    currentDeletePhotoId = null;
    document.getElementById('deleteModal').classList.add('hidden');
};

// 게시물 삭제 확인
window.confirmDeletePhoto = async function() {
    if (!currentDeletePhotoId) return;
    
    const btn = document.getElementById('confirmDeleteBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>삭제 중...';
    
    try {
        await deleteDoc(doc(db, 'artifacts', appId, 'sharedPhotos', currentDeletePhotoId));
        window.closeDeleteModal();
        await renderSharedPhotos();
        await updateStatistics();
        
        // 성공 메시지
        const successDiv = document.createElement('div');
        successDiv.className = 'fixed top-4 right-4 bg-emerald-600 text-white px-6 py-3 rounded-xl shadow-lg z-[600] flex items-center gap-2';
        successDiv.innerHTML = '<i class="fa-solid fa-check"></i> <span>게시물이 삭제되었습니다.</span>';
        document.body.appendChild(successDiv);
        setTimeout(() => successDiv.remove(), 3000);
        
    } catch (e) {
        console.error("게시물 삭제 실패:", e);
        alert("삭제 중 오류가 발생했습니다: " + e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '삭제';
    }
};

// 인증 상태 변경 리스너
onAuthStateChanged(auth, async (user) => {
    const loadingOverlay = document.getElementById('loadingOverlay');
    const loginPage = document.getElementById('loginPage');
    const adminPage = document.getElementById('adminPage');
    
    try {
        if (user) {
            // ADMIN 권한 확인
            const isAdmin = await checkAdminStatus(user.uid);
            if (isAdmin) {
                if (loginPage) loginPage.classList.add('hidden');
                if (adminPage) adminPage.classList.remove('hidden');
                showAdminPage(user);
            } else {
                // ADMIN 권한 없음 - 로그인 페이지 표시
                if (adminPage) adminPage.classList.add('hidden');
                if (loginPage) loginPage.classList.remove('hidden');
                // 이미 로그인되어 있으면 로그아웃
                try {
                    await signOut(auth);
                } catch (e) {
                    console.error("로그아웃 실패:", e);
                }
            }
        } else {
            // 로그인 안됨 - 로그인 페이지 표시
            if (adminPage) adminPage.classList.add('hidden');
            if (loginPage) loginPage.classList.remove('hidden');
        }
    } catch (e) {
        console.error("인증 상태 확인 오류:", e);
        if (adminPage) adminPage.classList.add('hidden');
        if (loginPage) loginPage.classList.remove('hidden');
    } finally {
        // 로딩 오버레이 숨기기
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
});

// 페이지 로드 시 초기화
window.addEventListener('DOMContentLoaded', () => {
    // 초기 상태 설정 - 로그인 페이지 표시, 로딩 오버레이 숨김
    const loadingOverlay = document.getElementById('loadingOverlay');
    const loginPage = document.getElementById('loginPage');
    const adminPage = document.getElementById('adminPage');
    
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
    if (loginPage) loginPage.classList.remove('hidden');
    if (adminPage) adminPage.classList.add('hidden');
    
    // Enter 키로 로그인
    document.getElementById('adminPassword')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            window.handleAdminLogin();
        }
    });
    
    // 일정 시간 후에도 로딩이 계속되면 숨기기 (안전장치)
    setTimeout(() => {
        if (loadingOverlay && !loadingOverlay.classList.contains('hidden')) {
            console.warn("로딩 타임아웃 - 로딩 오버레이 강제로 숨김");
            loadingOverlay.classList.add('hidden');
            if (loginPage) loginPage.classList.remove('hidden');
        }
    }, 5000);
});
