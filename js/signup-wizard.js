/**
 * 회원가입 위저드 (페이지 형식 4단계)
 * 1페이지: 이메일/비번/비번확인  2페이지: 닉네임  3페이지: 주민번호(앞자리)/라이프스타일  4페이지: 약관
 */
import { auth } from './firebase.js';
import { createUserWithEmailAndPassword, deleteUser } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { showRecordsPendingLoading } from './auth.js';
import { showToast, showLoading, hideLoading } from './ui.js';
import { DEFAULT_USER_SETTINGS } from './constants.js';
import { parseRrnPartial, mountRrnDigitGroup, setRrnDigitGroupValue, focusRrnDigitGroup } from './utils.js';

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
    if (step === 3) {
        mountRrnDigitGroup('wizardRrnDigits', { hiddenId: 'wizardBirthdate' });
        requestAnimationFrame(() => focusRrnDigitGroup('wizardRrnDigits'));
    }
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

/**
 * 닉네임 공통 검증 (비속어·중복). 실패 시 토스트 후 false.
 * @param {string} nickname
 * @param {string|null} excludeUserId — 본인 클레임 제외(Firestore uid)
 */
async function validateNicknameCore(nickname, excludeUserId = null) {
    if (!nickname) {
        showToast('닉네임을 입력해주세요.', 'error');
        return false;
    }
    if (nickname.length > 20) {
        showToast('닉네임은 20자 이하로 입력해주세요.', 'error');
        return false;
    }
    const { containsProfanity, isNicknameDuplicate } = await import('./utils/nickname.js');
    if (containsProfanity(nickname)) {
        showToast('사용할 수 없는 닉네임입니다.', 'error');
        return false;
    }
    const duplicate = await isNicknameDuplicate(nickname, excludeUserId);
    if (duplicate) {
        showToast('이미 사용 중인 닉네임입니다. 다른 닉네임을 입력하거나 추천을 눌러 주세요.', 'error');
        return false;
    }
    return true;
}

/** 추천/자동 채움 직후 — 비속어·중복·길이를 닉 단계에서 확정하고 입력·state에 반영 */
async function applyNicknameAfterSuggest(nickname, excludeUserId = null) {
    const ok = await validateNicknameCore(nickname, excludeUserId);
    if (!ok) return false;
    const input = getEl('wizardNickname');
    if (input) input.value = nickname;
    state.data.nickname = nickname;
    return true;
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
    const ok = await validateNicknameCore(nickname, auth.currentUser?.uid || null);
    if (!ok) return false;
    state.data.nickname = nickname;
    return true;
}

async function validateStep3() {
    const rrnRaw = (getEl('wizardBirthdate')?.value || '').trim();
    const lifestyle = (getEl('wizardLifestyle')?.value || '').trim();
    state.data.lifestyle = lifestyle || '';
    const parsed = parseRrnPartial(rrnRaw);
    if (parsed.empty) {
        state.data.birthdate = '';
        state.data.gender = null;
        return true;
    }
    if (!parsed.valid) {
        showToast('주민등록번호 앞자리를 올바르게 입력해주세요. (예: 801102-1)', 'error');
        return false;
    }
    state.data.birthdate = parsed.birthdate;
    state.data.gender = parsed.gender;
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
    const nextBtn = getEl('signupWizardNextBtn');
    const restoreNextBtn = () => {
        if (nextBtn) nextBtn.disabled = false;
    };

    if (state.isEmailSignup) {
        if (!validateStep4()) return;
        const nickFinal = String(state.data.nickname || (getEl('wizardNickname')?.value || '')).trim();
        if (!nickFinal) {
            showToast('닉네임 단계에서 닉네임을 확인한 뒤 다시 시도해 주세요.', 'error');
            return;
        }
        state.data.nickname = nickFinal;

        showLoading('가입 중...', { skipOnLoginScreen: false });
        try {
            await createUserWithEmailAndPassword(auth, state.data.email, state.data.password);
            window._recordsLoadHidePending = true;
        } catch (e) {
            hideLoading();
            const msg = e.code === 'auth/email-already-in-use' ? '이미 사용 중인 이메일입니다.' : (e.message || '가입에 실패했습니다.');
            showToast(msg, 'error');
            return;
        }

        const afterCreate = auth.currentUser;
        if (afterCreate && !afterCreate.isAnonymous) {
            const nickAgain = (getEl('wizardNickname')?.value || '').trim() || state.data.nickname;
            if (!(await validateNicknameCore(nickAgain, afterCreate.uid))) {
                hideLoading();
                try {
                    await deleteUser(afterCreate);
                } catch (delE) {
                    console.warn('가입 롤백(계정 삭제) 실패:', delE);
                    showToast('닉네임이 이미 사용 중입니다. 관리자에게 문의하거나 잠시 후 다시 시도해 주세요.', 'error');
                }
                restoreNextBtn();
                return;
            }
            state.data.nickname = nickAgain;
        }
    }

    const user = auth.currentUser;
    const { dbOps } = await import('./db.js');
    if (!window.userSettings) window.userSettings = { ...DEFAULT_USER_SETTINGS };

    let needsPersist = false;
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
            needsPersist = true;
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
            needsPersist = true;
        }
    }

    if (needsPersist) {
        if (nextBtn) nextBtn.disabled = true;
        const showSpinner = !state.isEmailSignup;
        if (showSpinner) {
            showLoading('설정을 저장하는 중...', { skipOnLoginScreen: false });
        }
        try {
            await dbOps.saveSettings(window.userSettings);
        } catch (e) {
            hideLoading();
            if (state.isEmailSignup && auth.currentUser && !auth.currentUser.isAnonymous) {
                try {
                    await deleteUser(auth.currentUser);
                } catch (delE) {
                    console.warn('가입 롤백(계정 삭제) 실패:', delE);
                    showToast('설정 저장에 실패했습니다. 같은 이메일로 다시 가입하려면 잠시 후 시도해 주세요.', 'error');
                }
            }
            restoreNextBtn();
            return;
        }
        if (showSpinner) hideLoading();
        restoreNextBtn();
    }

    if (state.isEmailSignup && auth.currentUser && !auth.currentUser.isAnonymous) {
        showRecordsPendingLoading(auth.currentUser);
        showToast('회원가입이 완료되었습니다. 환영합니다!', 'success');
    }

    try {
        const u = auth.currentUser;
        if (u?.uid?.startsWith('kakao_')) {
            const { consumeKakaoProfileSetupGate } = await import('./auth-flow.js');
            consumeKakaoProfileSetupGate(u);
        }
    } catch (_) {}

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
                const uid = auth.currentUser?.uid || null;
                const name = await pickUnusedRandomNickname(uid);
                if (!(await applyNicknameAfterSuggest(name, uid))) {
                    input.value = '';
                }
            } catch (e) {
                console.warn('추천 닉네임 생성 실패:', e);
                const msg =
                    e && e.code === 'NICKNAME_SUGGEST_EXHAUSTED'
                        ? e.message || '추천 닉네임을 만들 수 없습니다. 직접 입력해 주세요.'
                        : '추천 닉네임을 불러오지 못했습니다. 다시 시도해 주세요.';
                showToast(msg, 'error');
            } finally {
                nicknameSuggestBtn.disabled = false;
            }
        });
    }
    mountRrnDigitGroup('wizardRrnDigits', { hiddenId: 'wizardBirthdate' });
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
            const uid = auth.currentUser?.uid || null;
            import('./utils/nickname.js')
                .then(({ pickUnusedRandomNickname }) => pickUnusedRandomNickname(uid))
                .then(async (name) => {
                    if (!nicknameEl || !wizard || wizard.classList.contains('hidden')) return;
                    const applied = await applyNicknameAfterSuggest(name, uid);
                    if (!applied) nicknameEl.value = '';
                })
                .catch((e) => {
                    console.warn('초기 추천 닉네임 실패:', e);
                    if (e && e.code === 'NICKNAME_SUGGEST_EXHAUSTED') {
                        showToast(
                            e.message || '추천 닉네임을 준비하지 못했습니다. 직접 입력하거나 추천 버튼을 눌러 주세요.',
                            'error'
                        );
                    }
                });
        } else {
            nicknameEl.value = '';
        }
    }
    setRrnDigitGroupValue('wizardRrnDigits', '');
    getEl('wizardLifestyle').value = '';
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
    try {
        if (typeof window.scheduleAttendanceCheckIfNeeded === 'function') {
            queueMicrotask(() => window.scheduleAttendanceCheckIfNeeded());
        }
    } catch (_) {
        /* ignore */
    }
}

window.openSignupWizard = openSignupWizard;
window.closeSignupWizard = closeSignupWizard;
