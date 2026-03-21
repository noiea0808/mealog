// ADMIN 인증 관련 함수들
import { app, db, appId } from '../firebase.js';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { checkAdminStatus } from './utils.js';
import { updateStatistics, renderSharedPhotos } from './dashboard.js';
import { renderUsers } from './users.js';

const adminAuth = getAuth(app);

// 관리자 로그인
export async function handleAdminLogin() {
    console.log('🔐 handleAdminLogin 호출됨');
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
        const userCredential = await signInWithEmailAndPassword(adminAuth, email, password);
        const userId = userCredential.user.uid;
        
        console.log('🔐 로그인 성공:', {
            email: email,
            uid: userId
        });
        
        // ADMIN 권한 확인
        const isAdmin = await checkAdminStatus(userId);
        
        if (!isAdmin) {
            await signOut(adminAuth);
            errorDiv.textContent = "관리자 권한이 없습니다. 브라우저 콘솔(F12)을 확인하세요.";
            errorDiv.classList.remove('hidden');
            document.getElementById('loadingOverlay').classList.add('hidden');
            console.log('❌ 관리자 권한 없음. Firebase 콘솔에서 확인: artifacts/mealog-r0/admins/' + userId);
            return;
        }
        
        // 로그인 성공 - showAdminPage는 admin.js에서 처리
        // showAdminPage는 admin.js에 정의되어 있으므로 여기서는 호출하지 않음
        // 대신 admin.js의 onAuthStateChanged에서 처리됨
        
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
}

// showAdminPage는 admin.js에서 정의됨 (순환 참조 방지)

// 관리자 로그아웃
export async function handleAdminLogout() {
    try {
        await signOut(adminAuth);
        document.getElementById('adminPage').classList.add('hidden');
        document.getElementById('loginPage').classList.remove('hidden');
        document.getElementById('adminEmail').value = '';
        document.getElementById('adminPassword').value = '';
    } catch (e) {
        console.error("로그아웃 실패:", e);
        alert("로그아웃 중 오류가 발생했습니다.");
    }
}

// onAuthStateChanged는 admin.js에서 처리 (showAdminPage와의 의존성 때문에)

// switchAdminTab은 admin.js에서 직접 정의 (다른 함수들과의 의존성 때문에)
