/**
 * 회원가입 위저드 (페이지 형식 4단계)
 * 1페이지: 이메일/비번/비번확인  2페이지: 닉네임  3페이지: 생년월일/성별/라이프스타일  4페이지: 약관
 */
import { auth } from './firebase.js';
import { createUserWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import { showToast, showLoading, hideLoading } from './ui.js';
import { DEFAULT_USER_SETTINGS } from './constants.js';
import { normalizeBirthdateRaw, setupBirthdateInputFormatting } from './utils.js';

const WIZARD_STEPS = 4;

let state = {
    currentStep: 1,
    totalSteps: 4,
    startStep: 1,
    isEmailSignup: false,
    isTermsOnly: false,
    data: {}
};

function getEl(id) {
    return document.getElementById(id);
}

function showStep(step) {
    state.currentStep = step;
    document.querySelectorAll('.signup-wizard-step').forEach((el, i) => {
        el.classList.toggle('hidden', i + 1 !== step);
    });
    const progressEl = getEl('signupWizardProgress');
    if (progressEl) progressEl.textContent = state.totalSteps === 1 ? '1/1' : `${step}/${state.totalSteps}`;
    const btn = getEl('signupWizardNextBtn');
    if (btn) {
        btn.textContent = step === state.totalSteps ? '동의하고 시작하기' : '다음';
        btn.disabled = step === state.totalSteps ? !isWizardTermsReady() : false;
        btn.className = step === state.totalSteps && !isWizardTermsReady()
            ? 'flex-1 min-w-0 py-3.5 bg-slate-300 text-white rounded-xl font-bold text-sm cursor-not-allowed'
            : 'flex-1 min-w-0 py-3.5 bg-black text-white rounded-xl font-bold text-sm shadow-md active:bg-slate-800 transition-colors';
    }
    updateBackButtonVisibility();
}

function isWizardTermsReady() {
    return (getEl('wizardTermsAgreement')?.checked && getEl('wizardPrivacyAgreement')?.checked) || false;
}

function updateWizardTermsButton() {
    const btn = getEl('signupWizardNextBtn');
    if (btn && state.currentStep === state.totalSteps) {
        btn.disabled = !isWizardTermsReady();
        btn.className = isWizardTermsReady()
            ? 'flex-1 min-w-0 py-3.5 bg-black text-white rounded-xl font-bold text-sm shadow-md active:bg-slate-800 transition-colors'
            : 'flex-1 min-w-0 py-3.5 bg-slate-300 text-white rounded-xl font-bold text-sm cursor-not-allowed';
    }
}

async function validateStep1() {
    const email = (getEl('wizardEmail')?.value || '').trim();
    const password = getEl('wizardPassword')?.value || '';
    const confirm = getEl('wizardPasswordConfirm')?.value || '';
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
        showToast('올바른 이메일을 입력해주세요.', 'error');
        return false;
    }
    if (!password || password.length < 6) {
        showToast('비밀번호는 6자리 이상이어야 합니다.', 'error');
        return false;
    }
    if (password !== confirm) {
        showToast('비밀번호가 일치하지 않습니다.', 'error');
        return false;
    }
    state.data.email = email;
    state.data.password = password;
    return true;
}

async function validateStep2() {
    const nickname = (getEl('wizardNickname')?.value || '').trim();
    if (!nickname) {
        showToast('닉네임을 입력해주세요.', 'error');
        return false;
    }
    if (nickname.length > 20) {
        showToast('닉네임은 20자 이하로 입력해주세요.', 'error');
        return false;
    }
    const { containsProfanity, isNicknameDuplicate, pickUnusedRandomNickname } = await import('./utils/nickname.js');
    if (containsProfanity(nickname)) {
        showToast('사용할 수 없는 닉네임입니다.', 'error');
        return false;
    }
    const duplicate = await isNicknameDuplicate(nickname, auth.currentUser?.uid || null);
    if (duplicate) {
        const alt = await pickUnusedRandomNickname(auth.currentUser?.uid || null);
        const nickInput = getEl('wizardNickname');
        if (nickInput) nickInput.value = alt;
        showToast('이미 사용 중인 닉네임이에요. 사용 가능한 조합으로 바꿔 두었어요. 확인 후 다시 눌러 주세요.', 'info');
        return false;
    }
    state.data.nickname = nickname;
    return true;
}

async function validateStep3() {
    const birthdate = (getEl('wizardBirthdate')?.value || '').trim();
    const lifestyle = (getEl('wizardLifestyle')?.value || '').trim();
    const genderVal = document.querySelector('.wizard-gender-btn.bg-black')?.getAttribute('data-value') || '';
    state.data.gender = (genderVal === 'male' || genderVal === 'female') ? genderVal : null;
    state.data.lifestyle = lifestyle || '';
    if (!birthdate) {
        state.data.birthdate = '';
        return true;
    }
    const { formatted, valid } = normalizeBirthdateRaw(birthdate);
    if (!valid) {
        showToast('생년월일을 올바른 형식(예: 1990-01-15)으로 입력해주세요.', 'error');
        return false;
    }
    state.data.birthdate = formatted;
    return true;
}

function validateStep4() {
    if (!getEl('wizardTermsAgreement')?.checked || !getEl('wizardPrivacyAgreement')?.checked) {
        showToast('모든 약관에 동의해주세요.', 'error');
        return false;
    }
    return true;
}

async function validateCurrentStep() {
    const step = state.currentStep;
    if (step === 1) return await validateStep1();
    if (step === 2) return await validateStep2();
    if (step === 3) return await validateStep3();
    if (step === 4) return validateStep4();
    return true;
}

async function submitWizard() {
    if (state.isEmailSignup) {
        showLoading('가입 중...', { skipOnLoginScreen: false });
        try {
            const { createUserWithEmailAndPassword } = await import('https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js');
            await createUserWithEmailAndPassword(auth, state.data.email, state.data.password);
            window._recordsLoadHidePending = true;
            showLoading('기록을 불러오고 있어요', { dimBackground: false, skipOnLoginScreen: false });
            showToast('회원가입 성공! 환영합니다.', 'success');
        } catch (e) {
            hideLoading();
            const msg = e.code === 'auth/email-already-in-use' ? '이미 사용 중인 이메일입니다.' : (e.message || '가입에 실패했습니다.');
            showToast(msg, 'error');
            return;
        }
    }

    const user = auth.currentUser;
    const { dbOps } = await import('./db.js');
    if (!window.userSettings) window.userSettings = { ...DEFAULT_USER_SETTINGS };

    if (user && !user.isAnonymous) {
        if (!state.isTermsOnly && (state.data.nickname != null || state.data.birthdate != null)) {
            window.userSettings.profile = window.userSettings.profile || {};
            window.userSettings.profile.nickname = state.data.nickname ?? window.userSettings.profile.nickname;
            window.userSettings.profile.birthdate = state.data.birthdate ?? window.userSettings.profile.birthdate;
            window.userSettings.profile.lifestyle = state.data.lifestyle ?? '';
            window.userSettings.profile.gender = state.data.gender ?? null;
            window.userSettings.profile.birthdateChangeCount = 0;
            window.userSettings.profile.birthdateChangedAt = null;
            window.userSettings.profile.iconType = 'text';
            window.userSettings.profile.icon = null;
            window.userSettings.profile.photoUrl = null;
            window.userSettings.profileCompleted = true;
            window.userSettings.profileCompletedAt = new Date().toISOString();
            if (user.providerData?.[0]) {
                window.userSettings.providerId = window.userSettings.providerId || user.providerData[0].providerId;
                if (user.email) window.userSettings.email = window.userSettings.email || user.email;
            }
            await dbOps.saveSettings(window.userSettings);
            if (typeof window.ensureUserRegistered === 'function') await window.ensureUserRegistered();
        }
        if (state.currentStep === 4 || state.isTermsOnly) {
            window.userSettings.termsAgreed = true;
            window.userSettings.termsAgreedAt = new Date().toISOString();
            const { getCurrentTermsVersion } = await import('./utils-terms.js');
            window.userSettings.termsVersion = await getCurrentTermsVersion();
            if (user.providerData?.[0]) {
                window.userSettings.providerId = window.userSettings.providerId || user.providerData[0].providerId;
                if (user.email) window.userSettings.email = window.userSettings.email || user.email;
            }
            await dbOps.saveSettings(window.userSettings);
            if (typeof window.ensureUserRegistered === 'function') await window.ensureUserRegistered();
        }
    }

    closeSignupWizard();
    hideLoading();
    const { authFlowManager } = await import('./auth-flow.js');
    await authFlowManager.onTermsAgreed();
}

function canGoBack() {
    return state.currentStep > state.startStep && state.currentStep > 1;
}

function onBackClick() {
    if (!canGoBack()) return;
    showStep(state.currentStep - 1);
    updateBackButtonVisibility();
}

function updateBackButtonVisibility() {
    const backBtn = getEl('signupWizardBackBtn');
    if (backBtn) backBtn.classList.toggle('invisible', !canGoBack());
}

async function onNextClick() {
    if (!(await validateCurrentStep())) return;
    if (state.currentStep < state.totalSteps) {
        showStep(state.currentStep + 1);
        if (state.currentStep === state.totalSteps) updateWizardTermsButton();
    } else {
        await submitWizard();
    }
}

function initWizardUI() {
    document.querySelectorAll('.wizard-gender-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const wasSelected = btn.classList.contains('bg-black');
            document.querySelectorAll('.wizard-gender-btn').forEach(b => {
                const on = b === btn ? !wasSelected : false;
                b.classList.toggle('bg-black', on);
                b.classList.toggle('text-white', on);
                b.classList.toggle('bg-slate-50', !on);
                b.classList.toggle('text-slate-600', !on);
            });
        });
    });
    document.querySelectorAll('.wizard-lifestyle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const v = btn.getAttribute('data-value') || '';
            const wasSelected = btn.classList.contains('bg-black');
            const newVal = wasSelected ? '' : v;
            getEl('wizardLifestyle').value = newVal;
            document.querySelectorAll('.wizard-lifestyle-btn').forEach(b => {
                const on = !newVal ? false : b.getAttribute('data-value') === newVal;
                b.classList.toggle('bg-black', on);
                b.classList.toggle('text-white', on);
                b.classList.toggle('border-slate-300', on);
                b.classList.toggle('bg-slate-50', !on);
                b.classList.toggle('text-slate-600', !on);
                b.classList.toggle('border-slate-200', !on);
            });
        });
    });
    document.querySelectorAll('.wizard-terms-check').forEach(cb => {
        cb.addEventListener('change', updateWizardTermsButton);
    });
    document.querySelectorAll('.wizard-terms-detail').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-target');
            const el = getEl(id);
            if (!el) return;
            if (el.classList.contains('hidden')) {
                el.textContent = '로딩 중...';
                el.classList.remove('hidden');
                try {
                    const { getTermsContentForDisplay } = await import('./utils-terms.js');
                    const { terms, privacy } = await getTermsContentForDisplay();
                    if (id === 'wizardTermsContent') el.textContent = terms || '내용이 없습니다.';
                    else if (id === 'wizardPrivacyContent') el.textContent = privacy || '내용이 없습니다.';
                } catch (e) {
                    el.textContent = '약관을 불러오지 못했습니다.';
                }
            } else {
                el.classList.add('hidden');
            }
        });
    });
    const nextBtn = getEl('signupWizardNextBtn');
    if (nextBtn && !nextBtn._wizardBound) {
        nextBtn._wizardBound = true;
        nextBtn.addEventListener('click', onNextClick);
    }
    const backBtn = getEl('signupWizardBackBtn');
    if (backBtn && !backBtn._wizardBound) {
        backBtn._wizardBound = true;
        backBtn.addEventListener('click', onBackClick);
    }
    const nicknameSuggestBtn = getEl('wizardNicknameSuggestBtn');
    if (nicknameSuggestBtn && !nicknameSuggestBtn._wizardBound) {
        nicknameSuggestBtn._wizardBound = true;
        nicknameSuggestBtn.addEventListener('click', async () => {
            const input = getEl('wizardNickname');
            if (!input) return;
            nicknameSuggestBtn.disabled = true;
            try {
                const { pickUnusedRandomNickname } = await import('./utils/nickname.js');
                input.value = await pickUnusedRandomNickname(auth.currentUser?.uid || null);
            } catch (e) {
                console.warn('추천 닉네임 생성 실패:', e);
                showToast('추천 닉네임을 불러오지 못했습니다. 다시 시도해 주세요.', 'error');
            } finally {
                nicknameSuggestBtn.disabled = false;
            }
        });
    }
    const birthdateInput = getEl('wizardBirthdate');
    if (birthdateInput) setupBirthdateInputFormatting(birthdateInput);
}

/**
 * @param {Object} options
 * @param {number} options.startStep - 1~4 (이메일 가입 1, 구글 2, 약관만 4)
 * @param {number} [options.totalSteps] - 표시할 총 단계 수 (기본 4, 약관만이면 1)
 * @param {boolean} [options.isEmailSignup] - 이메일 회원가입 여부
 * @param {boolean} [options.isTermsOnly] - 기존 회원 약관 동의만 (4페이지만, 1/1)
 */
export function openSignupWizard(options = {}) {
    const startStep = options.startStep ?? 1;
    const isEmailSignup = !!options.isEmailSignup;
    const isTermsOnly = !!options.isTermsOnly;
    const totalSteps = options.totalSteps ?? (isTermsOnly ? 1 : WIZARD_STEPS);

    state = {
        currentStep: startStep,
        totalSteps,
        startStep,
        isEmailSignup,
        isTermsOnly,
        data: {}
    };

    const wizard = getEl('signupWizard');
    if (!wizard) return;

    getEl('wizardEmail').value = '';
    getEl('wizardPassword').value = '';
    getEl('wizardPasswordConfirm').value = '';
    const nicknameEl = getEl('wizardNickname');
    if (nicknameEl) {
        if (startStep <= 2) {
            nicknameEl.value = '';
            import('./utils/nickname.js').then(({ pickUnusedRandomNickname }) =>
                pickUnusedRandomNickname(auth.currentUser?.uid || null)
            ).then((name) => {
                if (nicknameEl && wizard && !wizard.classList.contains('hidden')) {
                    nicknameEl.value = name;
                }
            }).catch((e) => {
                console.warn('초기 추천 닉네임 실패:', e);
            });
        } else {
            nicknameEl.value = '';
        }
    }
    getEl('wizardBirthdate').value = '';
    getEl('wizardLifestyle').value = '';
    document.querySelectorAll('.wizard-gender-btn').forEach(b => {
        b.classList.remove('bg-black', 'text-white');
        b.classList.add('bg-slate-50', 'text-slate-600');
    });
    document.querySelectorAll('.wizard-lifestyle-btn').forEach(b => {
        b.classList.remove('bg-black', 'text-white', 'border-slate-300');
        b.classList.add('bg-slate-50', 'text-slate-600', 'border-slate-200');
    });
    getEl('wizardTermsAgreement').checked = false;
    getEl('wizardPrivacyAgreement').checked = false;

    const desc = getEl('signupWizardTermsDescription');
    if (desc && isTermsOnly) {
        desc.innerHTML = '<span class="text-emerald-600 font-semibold">💫 약관이 업데이트되었습니다</span><br><span class="text-slate-700">더 나은 서비스 제공을 위해 약관 내용을 일부 수정했습니다. 읽어 보시고 다시 동의해 주세요.</span>';
    } else if (desc) {
        desc.textContent = '서비스 이용을 위해 아래 약관에 동의해주세요.';
    }

    document.querySelectorAll('.signup-wizard-step').forEach((el, i) => {
        const stepNum = i + 1;
        el.classList.toggle('hidden', stepNum !== startStep);
    });
    getEl('signupWizardProgress').textContent = totalSteps === 1 ? '1/1' : `${startStep}/${totalSteps}`;
    const nextBtn = getEl('signupWizardNextBtn');
    nextBtn.textContent = startStep === totalSteps ? '동의하고 시작하기' : '다음';
    nextBtn.disabled = startStep === totalSteps;
    if (startStep === totalSteps) updateWizardTermsButton();

    initWizardUI();
    updateBackButtonVisibility();
    wizard.classList.remove('hidden');
}

export function closeSignupWizard() {
    const wizard = getEl('signupWizard');
    if (wizard) wizard.classList.add('hidden');
}

window.openSignupWizard = openSignupWizard;
window.closeSignupWizard = closeSignupWizard;
