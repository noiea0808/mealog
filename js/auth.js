// 인증 관련 함수들
import { auth } from './firebase.js';
import { GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signInAnonymously, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, deleteUser, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { showToast, showLoading, hideLoading } from './ui.js';
import { DEFAULT_USER_SETTINGS, CURRENT_TERMS_VERSION } from './constants.js';
import { dbOps } from './db.js';

function isNativePlatform() {
    return typeof window.Capacitor !== 'undefined' && window.Capacitor?.isNativePlatform?.();
}

export async function handleGoogleLogin() {
    showLoading();
    const provider = new GoogleAuthProvider();
    try {
        let result;
        if (isNativePlatform()) {
            // Capacitor/앱 환경: Redirect 사용 (브라우저 팝업 대신 WebView 내 리다이렉트)
            await signInWithRedirect(auth, provider);
            return; // 리다이렉트 발생, 복귀 시 getRedirectResult에서 처리
        } else {
            // 브라우저 환경: Popup 사용
            result = await signInWithPopup(auth, provider);
        }
        console.log('🔐 구글 로그인 성공:', {
            uid: result.user.uid,
            email: result.user.email,
            providerId: result.user.providerData[0]?.providerId,
            providerData: result.user.providerData.map(p => p.providerId)
        });
        window._recordsLoadHidePending = true;
        showLoading('기록을 불러오고 있어요', { dimBackground: false });
        showToast("구글 로그인 성공!", "success");
        // 로그인 성공 후 로딩 오버레이는 onAuthStateChanged에서 인증 플로우가 완료될 때까지 유지
    } catch (error) {
        if (error.code === 'auth/unauthorized-domain' || error.message.includes('unauthorized-domain')) {
            const domainTextEl = document.getElementById('domainText');
            if (domainTextEl) {
                const host = window.location.hostname;
                if (host === 'localhost' || host === '127.0.0.1') {
                    domainTextEl.innerText = 'localhost or 127.0.0.1 (should work by default)';
                } else {
                    domainTextEl.innerText = host;
                }
                domainTextEl.style.display = 'none';
                domainTextEl.offsetHeight;
                domainTextEl.style.display = 'block';
            }
            document.getElementById('domainErrorModal').classList.remove('hidden');
            hideLoading();
        } else if (error.code !== 'auth/cancelled-popup-request') {
            showToast("로그인 실패: " + error.message, "error");
            hideLoading();
        }
    }
}

export async function startGuest() {
    showLoading();
    try {
        await signInAnonymously(auth);
        showToast("게스트 모드로 시작합니다.", "info");
        // 로딩 오버레이는 인증 플로우에서 처리됨
    } catch (e) {
        showToast("게스트 로그인 실패", "error");
        hideLoading();
    }
}

export function openEmailModal(initialMode = 'login') {
    document.getElementById('emailAuthModal').classList.remove('hidden');
    window.setEmailAuthMode(initialMode);
    const savedEmail = localStorage.getItem('savedEmail');
    if (savedEmail) {
        document.getElementById('emailInput').value = savedEmail;
        document.getElementById('rememberEmailCheck').checked = true;
    } else {
        document.getElementById('emailInput').value = '';
        document.getElementById('rememberEmailCheck').checked = false;
    }
    document.getElementById('passwordInput').value = '';
    
    // 비밀번호 입력창에 엔터 키 이벤트 추가 (이벤트 위임 사용)
    const emailAuthModal = document.getElementById('emailAuthModal');
    if (emailAuthModal) {
        // 모달에 이벤트 위임으로 한 번만 등록 (중복 방지)
        const handleKeyPress = (e) => {
            if (e.target.id === 'passwordInput' && e.key === 'Enter') {
                e.preventDefault();
                window.handleEmailAuth();
            }
        };
        
        // 기존 리스너가 있으면 제거 후 재등록
        emailAuthModal.removeEventListener('keypress', emailAuthModal._passwordKeyHandler);
        emailAuthModal._passwordKeyHandler = handleKeyPress;
        emailAuthModal.addEventListener('keypress', handleKeyPress);
    }
}

export function closeEmailModal() {
    document.getElementById('emailAuthModal').classList.add('hidden');
}

export function setEmailAuthMode(mode) {
    window.emailAuthMode = mode;
    const title = document.getElementById('emailAuthTitle');
    const btn = document.getElementById('emailAuthBtn');
    const toggleBtn = document.getElementById('emailAuthToggleBtn');
    if (mode === 'login') {
        title.innerText = "이메일 로그인";
        btn.innerText = "로그인";
        toggleBtn.innerHTML = `계정이 없으신가요? <span class="text-emerald-600 font-bold underline">회원가입</span>`;
    } else {
        title.innerText = "회원가입";
        btn.innerText = "가입하기";
        toggleBtn.innerHTML = `이미 계정이 있으신가요? <span class="text-emerald-600 font-bold underline">로그인</span>`;
    }
}

export function toggleEmailAuthMode() {
    window.setEmailAuthMode(window.emailAuthMode === 'login' ? 'signup' : 'login');
}

export async function handleEmailAuth() {
    const email = document.getElementById('emailInput').value.trim();
    const password = document.getElementById('passwordInput').value;
    
    if (!email || !password) {
        showToast("이메일과 비밀번호를 입력해주세요.", "error");
        return;
    }
    
    // 이메일 형식 기본 검증
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        showToast("올바른 이메일 형식이 아닙니다.", "error");
        return;
    }
    
    // 비밀번호 최소 길이 검증
    if (password.length < 6) {
        showToast("비밀번호는 6자리 이상이어야 합니다.", "error");
        return;
    }
    
    showLoading();
    try {
        let result;
        if (window.emailAuthMode === 'signup') {
            result = await createUserWithEmailAndPassword(auth, email, password);
            console.log('🔐 이메일 회원가입 성공:', {
                uid: result.user.uid,
                email: result.user.email,
                providerId: result.user.providerData[0]?.providerId,
                providerData: result.user.providerData.map(p => p.providerId)
            });
            window._recordsLoadHidePending = true;
            showLoading('기록을 불러오고 있어요', { dimBackground: false });
            showToast("회원가입 성공! 환영합니다.", "success");
        } else {
            result = await signInWithEmailAndPassword(auth, email, password);
            console.log('🔐 이메일 로그인 성공:', {
                uid: result.user.uid,
                email: result.user.email,
                providerId: result.user.providerData[0]?.providerId,
                providerData: result.user.providerData.map(p => p.providerId)
            });
            window._recordsLoadHidePending = true;
            showLoading('기록을 불러오고 있어요', { dimBackground: false });
            showToast("로그인되었습니다.", "success");
            if (document.getElementById('rememberEmailCheck').checked) {
                localStorage.setItem('savedEmail', email);
            } else {
                localStorage.removeItem('savedEmail');
            }
        }
        document.getElementById('emailAuthModal').classList.add('hidden');
        // 로그인 성공 후 로딩 오버레이는 onAuthStateChanged에서 인증 플로우가 완료될 때까지 유지
        // 인증 플로우가 완료되면 processState의 finally에서 hideLoading() 호출됨
    } catch (error) {
        console.error('🔐 이메일 인증 에러:', {
            code: error.code,
            message: error.message,
            error: error
        });
        
        let msg = error.message || '알 수 없는 오류가 발생했습니다.';
        
        // Firebase Auth 에러 코드별 메시지 처리
        if (error.code === 'auth/email-already-in-use') {
            msg = "이미 사용 중인 이메일입니다.";
        } else if (error.code === 'auth/wrong-password') {
            msg = "비밀번호가 틀렸습니다.";
        } else if (error.code === 'auth/user-not-found') {
            msg = "존재하지 않는 계정입니다.";
        } else if (error.code === 'auth/weak-password') {
            msg = "비밀번호는 6자리 이상이어야 합니다.";
        } else if (error.code === 'auth/invalid-email') {
            msg = "올바른 이메일 형식이 아닙니다.";
        } else if (error.code === 'auth/user-disabled') {
            msg = "이 계정은 비활성화되었습니다. 관리자에게 문의하세요.";
        } else if (error.code === 'auth/too-many-requests') {
            msg = "너무 많은 시도가 있었습니다. 잠시 후 다시 시도해주세요.";
        } else if (error.code === 'auth/operation-not-allowed') {
            msg = "이메일/비밀번호 로그인이 비활성화되었습니다.";
        } else if (error.code === 'auth/invalid-credential') {
            msg = "이메일 또는 비밀번호가 올바르지 않습니다.";
        } else if (error.code === 'auth/network-request-failed') {
            msg = "네트워크 연결을 확인해주세요.";
        } else if (error.message && error.message.includes('400')) {
            msg = "로그인 요청이 실패했습니다. 이메일과 비밀번호를 확인해주세요.";
        }
        
        showToast("오류: " + msg, "error");
        hideLoading(); // 에러 시에만 즉시 숨김
    }
}

/** 비밀번호 재설정 메일 발송 (Firebase sendPasswordResetEmail) */
export async function requestPasswordReset() {
    const email = document.getElementById('emailInput')?.value?.trim() || '';
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email) {
        showToast("이메일을 입력해주세요.", "error");
        return;
    }
    if (!emailRegex.test(email)) {
        showToast("올바른 이메일 형식이 아닙니다.", "error");
        return;
    }
    showLoading();
    try {
        await sendPasswordResetEmail(auth, email);
        showToast("비밀번호 재설정 메일을 발송했습니다. 이메일을 확인해주세요.", "success");
        document.getElementById('emailAuthModal')?.classList.add('hidden');
    } catch (error) {
        console.error('비밀번호 재설정 메일 발송 실패:', error);
        let msg = error.message || '발송에 실패했습니다.';
        if (error.code === 'auth/invalid-email') msg = "올바른 이메일 형식이 아닙니다.";
        else if (error.code === 'auth/too-many-requests') msg = "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.";
        showToast(msg, "error");
    } finally {
        hideLoading();
    }
}

export async function handleLogout() {
    await signOut(auth);
    window.location.reload();
}

export function confirmLogout() {
    document.getElementById('logoutConfirmModal').classList.remove('hidden');
}

export async function confirmLogoutAction() {
    document.getElementById('logoutConfirmModal').classList.add('hidden');
    // 명시적 로그아웃 플래그 설정 (페이지 리로드 후에도 유지)
    sessionStorage.setItem('explicitLogout', 'true');
    await signOut(auth);
    window.location.reload();
}

export function confirmDeleteAccount() {
    document.getElementById('deleteAccountConfirmModal').classList.remove('hidden');
}

export function cancelDeleteAccount() {
    document.getElementById('deleteAccountConfirmModal').classList.add('hidden');
}

export async function confirmDeleteAccountAction() {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast("로그인이 필요합니다.", "error");
        return;
    }
    
    // 한 번 더 확인
    if (!confirm('정말로 탈퇴하시겠어요?\n\n모든 기록과 데이터가 삭제되며 복구할 수 없습니다.')) {
        return;
    }
    
    const modal = document.getElementById('deleteAccountConfirmModal');
    
    try {
        modal.classList.add('hidden');
        showLoading();
        
        // 1. 사용자 데이터 삭제
        await dbOps.deleteAllUserData();
        
        // 2. Firebase Authentication 계정 삭제
        const user = auth.currentUser;
        if (user) {
            await deleteUser(user);
        }
        
        // 3. 로그아웃 및 페이지 리로드
        // 명시적 로그아웃 플래그 설정
        sessionStorage.setItem('explicitLogout', 'true');
        await signOut(auth);
        hideLoading();
        showToast("계정이 성공적으로 삭제되었습니다.", "success");
        window.location.reload();
    } catch (error) {
        console.error("계정 삭제 실패:", error);
        hideLoading();
        
        let errorMessage = "계정 삭제 중 오류가 발생했습니다.";
        if (error.code === 'auth/requires-recent-login') {
            errorMessage = "보안을 위해 다시 로그인한 후 탈퇴해주세요.";
        }
        showToast(errorMessage, "error");
    }
}

export function copyDomain() {
    const text = document.getElementById('domainText').innerText;
    navigator.clipboard.writeText(text).then(() => showToast("복사완료", "success")).catch(() => showToast("실패", "error"));
}

export function closeDomainModal() {
    document.getElementById('domainErrorModal').classList.add('hidden');
}

export async function switchToLogin() {
    // 게스트 모드에서 로그인 페이지로 전환
    try {
        // Firestore 리스너가 살아있으면 signOut 시점에 permission-denied가 연쇄로 발생할 수 있으므로 선제 해제
        if (typeof window.cleanupFirestoreListeners === 'function') {
            window.cleanupFirestoreListeners();
        }

        // 설정 페이지 닫기
        const settingsPage = document.getElementById('settingsPage');
        if (settingsPage) {
            settingsPage.classList.add('hidden');
        }
        
        // 명시적 로그아웃 플래그 설정
        sessionStorage.setItem('explicitLogout', 'true');
        // 게스트 모드 로그아웃
        await signOut(auth);
        // 로그아웃 후 자동으로 랜딩 페이지로 이동 (인증 상태 변경 리스너가 처리)
        showToast("로그인 페이지로 이동합니다.", "info");
    } catch (error) {
        console.error('로그아웃 실패:', error);
        showToast("로그아웃 중 오류가 발생했습니다.", "error");
    }
}

export async function initAuth(onAuthStateChangedCallback) {
    // Redirect 로그인 복귀 시 결과 처리 (앱/Capacitor에서 구글 로그인 후 돌아올 때)
    if (isNativePlatform()) {
        try {
            const result = await getRedirectResult(auth);
            if (result?.user) {
                console.log('🔐 구글 Redirect 로그인 성공:', result.user.uid);
                window._recordsLoadHidePending = true;
                showLoading('기록을 불러오고 있어요', { dimBackground: false });
                showToast("구글 로그인 성공!", "success");
            }
        } catch (error) {
            console.warn('구글 Redirect 로그인 처리:', error?.code, error?.message);
            if (error?.code !== 'auth/operation-not-allowed' && !error?.message?.includes('redirect')) {
                showToast("로그인 실패: " + (error?.message || '알 수 없는 오류'), "error");
            }
            hideLoading();
        }
    }
    onAuthStateChanged(auth, (user) => {
        try {
            onAuthStateChangedCallback(user);
        } catch (e) {
            console.error('인증 상태 처리 중 오류:', e);
            hideLoading();
            showToast("잠시 후 다시 시도해 주세요.", "error");
        }
    });
}

// 약관 동의 모달 표시
export async function showTermsModal() {
    const modal = document.getElementById('termsModal');
    if (modal) {
        modal.classList.remove('hidden');
        // 체크박스 상태 초기화
        document.getElementById('termsAgreement').checked = false;
        document.getElementById('privacyAgreement').checked = false;
        updateTermsAgreeButton();
        
        // 기존 사용자인지 확인하여 안내 문구 변경
        const descriptionEl = document.getElementById('termsModalDescription');
        if (descriptionEl) {
            try {
                const currentUser = auth.currentUser;
                if (currentUser && !currentUser.isAnonymous) {
                    // authFlowManager에서 캐시된 기존 사용자 정보 확인 (이미 백그라운드에서 확인됨)
                    let isExistingUser = false;
                    try {
                        const { authFlowManager } = await import('./auth-flow.js');
                        if (authFlowManager._cachedExistingUser !== undefined) {
                            isExistingUser = authFlowManager._cachedExistingUser;
                        } else {
                            // 캐시가 없으면 약관 모달에서만 확인 (로그인 플로우를 지연시키지 않음)
                            const { collection, query, limit, getDocs } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
                            const { db, appId } = await import('./firebase.js');
                            const mealsColl = collection(db, 'artifacts', appId, 'users', currentUser.uid, 'meals');
                            const mealsSnapshot = await getDocs(query(mealsColl, limit(1)));
                            isExistingUser = !mealsSnapshot.empty;
                            // 캐시에 저장
                            authFlowManager._cachedExistingUser = isExistingUser;
                        }
                    } catch (e) {
                        console.warn('기존 사용자 확인 실패:', e);
                    }
                    
                    if (isExistingUser) {
                        // 기존 사용자에게는 약관 업데이트 안내 문구 표시
                        descriptionEl.innerHTML = '<span class="text-emerald-600 font-semibold">💫 약관이 업데이트되었습니다</span><br><span class="text-slate-700">더 나은 서비스 제공을 위해 약관 내용을 일부 수정했습니다.<br>잠깐 시간을 내어 읽어 보시고 다시 동의해 주시면 감사하겠습니다. 🙏</span>';
                        descriptionEl.className = 'text-xs text-center mb-6 leading-relaxed space-y-1';
                    } else {
                        // 신규 사용자에게는 기본 문구 표시
                        descriptionEl.textContent = '서비스 이용을 위해 아래 약관에 동의해주세요.';
                        descriptionEl.className = 'text-xs text-slate-500 text-center mb-6';
                    }
                } else {
                    // 게스트 사용자는 기본 문구
                    descriptionEl.textContent = '서비스 이용을 위해 아래 약관에 동의해주세요.';
                    descriptionEl.className = 'text-xs text-slate-500 text-center mb-6';
                }
            } catch (e) {
                console.warn('기존 사용자 확인 실패:', e);
                // 에러 시 기본 문구 유지
                descriptionEl.textContent = '서비스 이용을 위해 아래 약관에 동의해주세요.';
                descriptionEl.className = 'text-xs text-slate-500 text-center mb-6';
            }
        }
    }
}

// 약관 동의 모달 닫기
export function closeTermsModal() {
    const modal = document.getElementById('termsModal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

// 약관 동의 취소 (로그아웃)
export async function cancelTermsAgreement() {
    // 명시적 로그아웃 플래그 설정
    sessionStorage.setItem('explicitLogout', 'true');
    await signOut(auth);
    window.location.reload();
}

// 약관 상세 보기 토글
export function showTermsDetail(type) {
    const contentId = type === 'terms' ? 'termsContent' : 'privacyContent';
    const content = document.getElementById(contentId);
    if (content) {
        content.classList.toggle('hidden');
    }
}

// 약관 동의 버튼 상태 업데이트
export function updateTermsAgreeButton() {
    const termsChecked = document.getElementById('termsAgreement')?.checked || false;
    const privacyChecked = document.getElementById('privacyAgreement')?.checked || false;
    const agreeBtn = document.getElementById('termsAgreeBtn');
    
    if (agreeBtn) {
        if (termsChecked && privacyChecked) {
            agreeBtn.disabled = false;
            agreeBtn.className = 'flex-1 py-3 bg-emerald-600 text-white rounded-xl font-bold text-sm shadow-md active:bg-emerald-700 transition-colors';
        } else {
            agreeBtn.disabled = true;
            agreeBtn.className = 'flex-1 py-3 bg-slate-300 text-white rounded-xl font-bold text-sm';
        }
    }
}

// 약관 동의 확인
export async function confirmTermsAgreement() {
    const termsChecked = document.getElementById('termsAgreement')?.checked || false;
    const privacyChecked = document.getElementById('privacyAgreement')?.checked || false;
    
    if (!termsChecked || !privacyChecked) {
        showToast("모든 약관에 동의해주세요.", "error");
        return;
    }
    
    try {
        // 사용자 설정에 약관 동의 정보 저장
        if (!window.userSettings) {
            window.userSettings = { ...DEFAULT_USER_SETTINGS };
        }
        
        window.userSettings.termsAgreed = true;
        window.userSettings.termsAgreedAt = new Date().toISOString();
        
        // Firestore에서 현재 약관 버전 가져오기 (동적 import로 안전하게 로드)
        const { getCurrentTermsVersion } = await import('./utils-terms.js');
        const currentVersion = await getCurrentTermsVersion();
        window.userSettings.termsVersion = currentVersion;
        
        // providerId와 email을 현재 사용자 정보로 설정 (없을 때만, 또는 같은 providerId일 때만)
        try {
            const currentUser = auth.currentUser;
            if (currentUser && !currentUser.isAnonymous) {
                // providerId는 없을 때만 설정 (덮어쓰기 방지)
                if (currentUser.providerData && currentUser.providerData.length > 0) {
                    const currentProviderId = currentUser.providerData[0].providerId;
                    if (!window.userSettings.providerId) {
                        window.userSettings.providerId = currentProviderId;
                    } else if (window.userSettings.providerId !== currentProviderId) {
                        // providerId가 다르면 경고만 (다른 계정일 수 있음)
                        console.warn(`⚠️ 약관 동의 시 providerId 불일치: 저장된(${window.userSettings.providerId}) vs 현재(${currentProviderId}). 기존 값 유지합니다.`);
                    }
                }
                // email은 같은 providerId일 때만 업데이트
                if (currentUser.email) {
                    const currentProviderId = currentUser.providerData?.[0]?.providerId;
                    if (!window.userSettings.email) {
                        window.userSettings.email = currentUser.email;
                    } else if (currentProviderId && window.userSettings.providerId === currentProviderId && window.userSettings.email !== currentUser.email) {
                        // 같은 providerId인데 이메일이 다르면 업데이트
                        window.userSettings.email = currentUser.email;
                    } else if (currentProviderId && window.userSettings.providerId !== currentProviderId) {
                        // providerId가 다르면 경고만
                        console.warn(`⚠️ 약관 동의 시 providerId 불일치로 인한 email 불일치: 저장된(${window.userSettings.email}) vs 현재(${currentUser.email}). 기존 값 유지합니다.`);
                    }
                }
            }
        } catch (e) {
            console.warn('약관 동의 시 사용자 정보 가져오기 실패:', e);
        }
        
        const { dbOps } = await import('./db.js');
        await dbOps.saveSettings(window.userSettings);
        
        closeTermsModal();
        
        // 인증 플로우 관리자에게 다음 단계 처리 요청
        const { authFlowManager } = await import('./auth-flow.js');
        await authFlowManager.onTermsAgreed();
    } catch (e) {
        console.error("약관 동의 저장 실패:", e);
        // 모달을 닫고 토스트를 표시하여 사용자가 에러를 볼 수 있도록 함
        closeTermsModal();
        
        let errorMessage = "약관 동의 저장에 실패했습니다.";
        if (e.code === 'permission-denied') {
            errorMessage = "권한이 없습니다. 잠시 후 다시 시도해주세요.";
        } else if (e.code === 'unavailable') {
            errorMessage = "네트워크 연결을 확인해주세요.";
        }
        
        // 약간의 지연 후 토스트 표시 (모달이 완전히 닫힌 후)
        setTimeout(() => {
            showToast(errorMessage, "error");
        }, 300);
    }
}

// 프로필 설정 모달 표시
export function showProfileSetupModal() {
    const modal = document.getElementById('profileSetupModal');
    if (modal) {
        modal.classList.remove('hidden');
        
        // 닉네임 입력 초기화
        const nicknameInput = document.getElementById('setupNickname');
        if (nicknameInput) {
            nicknameInput.value = '';
        }
        const birthdateInput = document.getElementById('setupBirthdate');
        if (birthdateInput) {
            birthdateInput.value = '';
        }
        const lifestyleSelect = document.getElementById('setupLifestyle');
        if (lifestyleSelect) {
            lifestyleSelect.value = '';
        }
        // 버튼 선택 상태 초기화
        document.querySelectorAll('.setup-lifestyle-btn').forEach(btn => {
            btn.classList.remove('bg-emerald-600', 'text-white', 'border-emerald-600');
            btn.classList.add('bg-slate-50', 'text-slate-600', 'border-slate-200');
        });
    }
}

// 프로필 설정 모달 닫기
export function closeProfileSetupModal() {
    const modal = document.getElementById('profileSetupModal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

// 아이콘 선택 영역 렌더링
function renderSetupIconSelector() {
    const container = document.getElementById('setupIconSelector');
    if (!container) return;
    
    // 동적 import로 변경
    import('./constants.js').then(({ DEFAULT_ICONS }) => {
        container.innerHTML = DEFAULT_ICONS.map(icon => `
            <button onclick="window.selectSetupIcon('${icon}')" class="icon-option-setup w-12 h-12 rounded-xl border-2 border-slate-200 flex items-center justify-center text-2xl ${icon === '🐻' ? 'selected border-emerald-500 bg-emerald-50' : ''}" data-icon="${icon}">
                ${icon}
            </button>
        `).join('');
    });
}

// 프로필 설정 아이콘 선택
export function selectSetupIcon(icon) {
    window.selectedSetupIcon = icon;
    document.querySelectorAll('.icon-option-setup').forEach(el => {
        if (el.dataset.icon === icon) {
            el.classList.add('selected', 'border-emerald-500', 'bg-emerald-50');
            el.classList.remove('border-slate-200');
        } else {
            el.classList.remove('selected', 'border-emerald-500', 'bg-emerald-50');
            el.classList.add('border-slate-200');
        }
    });
}

// 프로필 타입 설정
export function setProfileType(type) {
    window.setupProfileType = type;
    
    const emojiBtn = document.getElementById('setupProfileTypeEmoji');
    const photoBtn = document.getElementById('setupProfileTypePhoto');
    const emojiSection = document.getElementById('setupEmojiSection');
    const photoSection = document.getElementById('setupPhotoSection');
    
    if (type === 'emoji') {
        if (emojiBtn) {
            emojiBtn.className = 'flex-1 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-bold active:bg-emerald-700 transition-colors';
        }
        if (photoBtn) {
            photoBtn.className = 'flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-bold active:bg-slate-200 transition-colors';
        }
        if (emojiSection) emojiSection.classList.remove('hidden');
        if (photoSection) photoSection.classList.add('hidden');
    } else {
        if (emojiBtn) {
            emojiBtn.className = 'flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-bold active:bg-slate-200 transition-colors';
        }
        if (photoBtn) {
            photoBtn.className = 'flex-1 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-bold active:bg-emerald-700 transition-colors';
        }
        if (emojiSection) emojiSection.classList.add('hidden');
        if (photoSection) photoSection.classList.remove('hidden');
    }
}

// 프로필 사진 업로드 처리
export async function handleSetupPhotoUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    if (!file.type.startsWith('image/')) {
        showToast("이미지 파일만 업로드할 수 있습니다.", "error");
        return;
    }
    
    try {
        // 이미지 압축 및 미리보기
        const { compressImageToBlob } = await import('./utils.js');
        const compressedBlob = await compressImageToBlob(file);
        const photoUrl = URL.createObjectURL(compressedBlob);
        
        window.setupPhotoUrl = photoUrl;
        window.setupPhotoFile = compressedBlob;
        
        // 미리보기 업데이트
        const photoPreview = document.getElementById('setupPhotoPreview');
        if (photoPreview) {
            photoPreview.style.backgroundImage = `url(${photoUrl})`;
            photoPreview.style.backgroundSize = 'cover';
            photoPreview.style.backgroundPosition = 'center';
            photoPreview.innerHTML = '';
        }
    } catch (e) {
        console.error("사진 업로드 처리 실패:", e);
        showToast("사진 업로드 중 오류가 발생했습니다.", "error");
    }
}

// 프로필 설정 확인
export async function confirmProfileSetup() {
    const nicknameInput = document.getElementById('setupNickname');
    const nickname = nicknameInput?.value.trim() || '';

    const birthdate = (document.getElementById('setupBirthdate')?.value || '').trim();
    const lifestyle = (document.getElementById('setupLifestyle')?.value || '').trim();
    
    if (!nickname) {
        showToast("닉네임을 입력해주세요.", "error");
        return;
    }
    
    if (nickname.length > 20) {
        showToast("닉네임은 20자 이하로 입력해주세요.", "error");
        return;
    }
    
    const { containsProfanity, isNicknameDuplicate } = await import('./utils/nickname.js');
    if (containsProfanity(nickname)) {
        showToast("사용할 수 없는 닉네임입니다. 다른 닉네임을 입력해주세요.", "error");
        return;
    }
    
    const duplicate = await isNicknameDuplicate(nickname, auth.currentUser?.uid || null);
    if (duplicate) {
        showToast("이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해주세요.", "error");
        return;
    }

    if (!birthdate) {
        showToast("생년월일을 입력해주세요.", "error");
        return;
    }

    // 라이프스타일은 선택 입력 (필수 아님)
    
    try {
        if (!window.userSettings) {
            window.userSettings = { ...DEFAULT_USER_SETTINGS };
        }
        
        window.userSettings.profile.nickname = nickname;
        window.userSettings.profile.birthdate = birthdate;
        window.userSettings.profile.lifestyle = lifestyle;
        window.userSettings.profile.birthdateChangeCount = 0;
        window.userSettings.profile.birthdateChangedAt = null;
        // 초기 가입은 아이콘 설정 없이 텍스트(닉네임 첫 글자) 기본
        window.userSettings.profile.iconType = 'text';
        window.userSettings.profile.icon = null;
        window.userSettings.profile.photoUrl = null;
        // 프로필 완료 플래그 저장 (닉네임 문자열에 의존하지 않기 위함)
        window.userSettings.profileCompleted = true;
        window.userSettings.profileCompletedAt = new Date().toISOString();
        
        // providerId와 email을 현재 사용자 정보로 설정 (없을 때만, 또는 같은 providerId일 때만)
        try {
            const currentUser = auth.currentUser;
            if (currentUser && !currentUser.isAnonymous) {
                // providerId는 없을 때만 설정 (덮어쓰기 방지)
                if (currentUser.providerData && currentUser.providerData.length > 0) {
                    const currentProviderId = currentUser.providerData[0].providerId;
                    if (!window.userSettings.providerId) {
                        window.userSettings.providerId = currentProviderId;
                    } else if (window.userSettings.providerId !== currentProviderId) {
                        // providerId가 다르면 경고만
                        console.warn(`⚠️ 프로필 설정 시 providerId 불일치: 저장된(${window.userSettings.providerId}) vs 현재(${currentProviderId}). 기존 값 유지합니다.`);
                    }
                }
                // email은 같은 providerId일 때만 업데이트
                if (currentUser.email) {
                    const currentProviderId = currentUser.providerData?.[0]?.providerId;
                    if (!window.userSettings.email) {
                        window.userSettings.email = currentUser.email;
                    } else if (currentProviderId && window.userSettings.providerId === currentProviderId && window.userSettings.email !== currentUser.email) {
                        // 같은 providerId인데 이메일이 다르면 업데이트
                        window.userSettings.email = currentUser.email;
                    } else if (currentProviderId && window.userSettings.providerId !== currentProviderId) {
                        // providerId가 다르면 경고만
                        console.warn(`⚠️ 프로필 설정 시 providerId 불일치로 인한 email 불일치: 저장된(${window.userSettings.email}) vs 현재(${currentUser.email}). 기존 값 유지합니다.`);
                    }
                }
            }
        } catch (e) {
            console.warn('프로필 설정 시 사용자 정보 가져오기 실패:', e);
        }
        
        const { dbOps } = await import('./db.js');
        await dbOps.saveSettings(window.userSettings);
        
        // 헤더 업데이트
        const { updateHeaderUI } = await import('./ui.js');
        updateHeaderUI();
        
        closeProfileSetupModal();
        
        // 인증 플로우 관리자에게 다음 단계 처리 요청
        const { authFlowManager } = await import('./auth-flow.js');
        await authFlowManager.onProfileSetup();
    } catch (e) {
        console.error("프로필 설정 저장 실패:", e);
        
        let errorMessage = "프로필 설정 저장에 실패했습니다.";
        if (e.code === 'permission-denied') {
            errorMessage = "권한이 없습니다. Firebase 보안 규칙을 확인해주세요.";
        } else if (e.code === 'unavailable') {
            errorMessage = "네트워크 연결을 확인해주세요.";
        }
        
        showToast(errorMessage, "error");
    }
}