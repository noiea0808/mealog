// 인증 관련 함수들
import { auth } from './firebase.js';
import { GoogleAuthProvider, signInWithPopup, signInAnonymously, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { showToast } from './ui.js';
import { DEFAULT_USER_SETTINGS } from './constants.js';

export async function handleGoogleLogin() {
    const provider = new GoogleAuthProvider();
    try {
        await signInWithPopup(auth, provider);
        showToast("구글 로그인 성공!", "success");
        } catch (error) {
            if (error.code === 'auth/unauthorized-domain' || error.message.includes('unauthorized-domain')) {
                const domainTextEl = document.getElementById('domainText');
                if (domainTextEl) {
                    // localhost나 127.0.0.1이 아닌 경우에만 도메인 표시
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
            } else {
                showToast("로그인 실패: " + error.message, "error");
            }
        }
}

export async function startGuest() {
    document.getElementById('loadingOverlay').classList.remove('hidden');
    try {
        await signInAnonymously(auth);
        showToast("게스트 모드로 시작합니다.", "info");
    } catch (e) {
        showToast("게스트 로그인 실패", "error");
        document.getElementById('loadingOverlay').classList.add('hidden');
    }
}

export function openEmailModal() {
    document.getElementById('emailAuthModal').classList.remove('hidden');
    window.setEmailAuthMode('login');
    const savedEmail = localStorage.getItem('savedEmail');
    if (savedEmail) {
        document.getElementById('emailInput').value = savedEmail;
        document.getElementById('rememberEmailCheck').checked = true;
    } else {
        document.getElementById('emailInput').value = '';
        document.getElementById('rememberEmailCheck').checked = false;
    }
    document.getElementById('passwordInput').value = '';
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
    const email = document.getElementById('emailInput').value;
    const password = document.getElementById('passwordInput').value;
    if (!email || !password) {
        showToast("이메일과 비밀번호를 입력해주세요.", "error");
        return;
    }
    document.getElementById('loadingOverlay').classList.remove('hidden');
    try {
        if (window.emailAuthMode === 'signup') {
            await createUserWithEmailAndPassword(auth, email, password);
            showToast("회원가입 성공! 환영합니다.", "success");
        } else {
            await signInWithEmailAndPassword(auth, email, password);
            showToast("로그인되었습니다.", "success");
            if (document.getElementById('rememberEmailCheck').checked) {
                localStorage.setItem('savedEmail', email);
            } else {
                localStorage.removeItem('savedEmail');
            }
        }
        document.getElementById('emailAuthModal').classList.add('hidden');
    } catch (error) {
        let msg = error.message;
        if (error.code === 'auth/email-already-in-use') msg = "이미 사용 중인 이메일입니다.";
        if (error.code === 'auth/wrong-password') msg = "비밀번호가 틀렸습니다.";
        if (error.code === 'auth/user-not-found') msg = "존재하지 않는 계정입니다.";
        if (error.code === 'auth/weak-password') msg = "비밀번호는 6자리 이상이어야 합니다.";
        showToast("오류: " + msg, "error");
        document.getElementById('loadingOverlay').classList.add('hidden');
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
    await signOut(auth);
    window.location.reload();
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
        // 설정 페이지 닫기
        const settingsPage = document.getElementById('settingsPage');
        if (settingsPage) {
            settingsPage.classList.add('hidden');
        }
        
        // 게스트 모드 로그아웃
        await signOut(auth);
        // 로그아웃 후 자동으로 랜딩 페이지로 이동 (인증 상태 변경 리스너가 처리)
        showToast("로그인 페이지로 이동합니다.", "info");
    } catch (error) {
        console.error('로그아웃 실패:', error);
        showToast("로그아웃 중 오류가 발생했습니다.", "error");
    }
}

export function initAuth(onAuthStateChangedCallback) {
    onAuthStateChanged(auth, onAuthStateChangedCallback);
}


// 약관 동의 모달 표시
export function showTermsModal() {
    const modal = document.getElementById('termsModal');
    if (modal) {
        modal.classList.remove('hidden');
        const termsCheck = document.getElementById('termsAgreement');
        const privacyCheck = document.getElementById('privacyAgreement');
        if (termsCheck) termsCheck.checked = false;
        if (privacyCheck) privacyCheck.checked = false;
        updateTermsAgreeButton();
    }
}

// 약관 동의 모달 닫기
export function closeTermsModal() {
    const modal = document.getElementById('termsModal');
    if (modal) modal.classList.add('hidden');
}

// 약관 동의 취소 (로그아웃)
export async function cancelTermsAgreement() {
    await signOut(auth);
    window.location.reload();
}

// 약관 상세 보기 토글
export function showTermsDetail(type) {
    const contentId = type === 'terms' ? 'termsContent' : 'privacyContent';
    const content = document.getElementById(contentId);
    if (content) content.classList.toggle('hidden');
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
        if (!window.userSettings) window.userSettings = { ...DEFAULT_USER_SETTINGS };
        window.userSettings.termsAgreed = true;
        window.userSettings.termsAgreedAt = new Date().toISOString();
        const { dbOps } = await import('./db.js');
        await dbOps.saveSettings(window.userSettings);
        closeTermsModal();
        await showProfileSetupModal();
    } catch (e) {
        console.error("약관 동의 저장 실패:", e);
        showToast("약관 동의 저장에 실패했습니다.", "error");
    }
}

// 프로필 설정 모달 표시
export async function showProfileSetupModal() {
    const modal = document.getElementById('profileSetupModal');
    if (modal) {
        modal.classList.remove('hidden');
        await renderSetupIconSelector();
        const nicknameInput = document.getElementById('setupNickname');
        if (nicknameInput) nicknameInput.value = '';
        window.selectedSetupIcon = '🐻';
    }
}

// 프로필 설정 모달 닫기
export function closeProfileSetupModal() {
    const modal = document.getElementById('profileSetupModal');
    if (modal) modal.classList.add('hidden');
}

// 아이콘 선택 영역 렌더링
async function renderSetupIconSelector() {
    const container = document.getElementById('setupIconSelector');
    if (!container) return;
    const { DEFAULT_ICONS } = await import('./constants.js');
    container.innerHTML = DEFAULT_ICONS.map(icon => `
        <button onclick="window.selectSetupIcon('${icon}')" class="icon-option-setup w-12 h-12 rounded-xl border-2 border-slate-200 flex items-center justify-center text-2xl ${icon === '🐻' ? 'selected border-emerald-500 bg-emerald-50' : ''}" data-icon="${icon}">
            ${icon}
        </button>
    `).join('');
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

// 프로필 설정 확인
export async function confirmProfileSetup() {
    const nicknameInput = document.getElementById('setupNickname');
    const nickname = nicknameInput?.value.trim() || '';
    if (!nickname) {
        showToast("닉네임을 입력해주세요.", "error");
        return;
    }
    if (nickname.length > 20) {
        showToast("닉네임은 20자 이하로 입력해주세요.", "error");
        return;
    }
    try {
        if (!window.userSettings) window.userSettings = { ...DEFAULT_USER_SETTINGS };
        window.userSettings.profile.nickname = nickname;
        window.userSettings.profile.icon = window.selectedSetupIcon || '🐻';
        const { dbOps } = await import('./db.js');
        await dbOps.saveSettings(window.userSettings);
        const { updateHeaderUI } = await import('./ui.js');
        updateHeaderUI();
        closeProfileSetupModal();
        const { showOnboardingModal } = await import('./onboarding.js');
        showOnboardingModal();
    } catch (e) {
        console.error("프로필 설정 저장 실패:", e);
        showToast("프로필 설정 저장에 실패했습니다.", "error");
    }
}
