// 인증 관련 함수들
import { auth } from './firebase.js';
import { GoogleAuthProvider, signInWithPopup, signInAnonymously, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { showToast } from './ui.js';

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

export function initAuth(onAuthStateChangedCallback) {
    onAuthStateChanged(auth, onAuthStateChangedCallback);
}

