import { DEFAULT_USER_SETTINGS } from '../constants.js';
import { kakaoTalkLogoSvgHtml } from '../utils/kakao-brand.js';
import { appState } from '../state.js';
import { addCompositionAwareInput, normalizeBirthdateRaw, setupBirthdateInputFormatting } from '../utils.js';
import { renderTagManager } from '../render/index.js';
import { dbOps } from '../db.js';
import { showToast, updateHeaderUI } from '../ui.js';
import { isDemoUser } from '../demo-account.js';
import { logUsageMetric } from '../usage-metrics.js';

/**
 * 설정 > 로그인 정보 표시용.
 * 카카오는 커스텀 토큰 로그인이라 Firebase에 email·providerData가 없을 수 있어,
 * 이메일 없을 때 기본 문구를 "Google 계정"으로 두면 오해를 부름.
 */
function getSettingsAccountLoginDisplay(user) {
    const googleIcon = '<i class="fa-brands fa-google text-xl" aria-hidden="true"></i>';
    const emailIcon = '<i class="fa-solid fa-envelope text-xl" aria-hidden="true"></i>';
    const kakaoBadge = kakaoTalkLogoSvgHtml({
        className: 'w-8 h-8 text-emerald-700',
        title: '카카오 로그인'
    });

    const uid = user?.uid || '';
    const isKakaoUid = uid.startsWith('kakao_');
    const providerId = user?.providerData?.[0]?.providerId;
    const savedPid = window.userSettings?.providerId;
    const isKakao = isKakaoUid || savedPid === 'kakao.com';

    if (isKakao) {
        const mail = user.email || window.userSettings?.email || '';
        const nick = window.userSettings?.profile?.nickname || '';
        const kakaoMemberId =
            typeof uid === 'string' && uid.startsWith('kakao_') ? uid.slice(7) : '';
        let line;
        if (mail) {
            line = mail;
        } else {
            const parts = [];
            if (nick && nick !== '게스트') parts.push(nick);
            if (kakaoMemberId) parts.push(`회원번호 ${kakaoMemberId}`);
            line = parts.length ? `${parts.join(' · ')} (이메일 미연동)` : '(이메일 미연동)';
        }
        return { icon: kakaoBadge, line };
    }

    if (user.email) {
        const icon = providerId === 'google.com' ? googleIcon : emailIcon;
        return { icon, line: user.email };
    }

    if (providerId === 'google.com') {
        return { icon: googleIcon, line: 'Google 계정' };
    }

    return { icon: emailIcon, line: '로그인된 계정' };
}

/** 설정 하단 로그아웃 버튼 — 샘플 계정만 '홈으로' + 초록 스타일 */
function syncProfileLogoutFooterButton() {
    const btn = document.querySelector('.profile-logout-btn');
    if (!btn) return;
    const base =
        'profile-settings-footer-btn profile-logout-btn w-full py-3 text-sm font-bold transition-colors';
    const u = window.currentUser;
    const demo = u && !u.isAnonymous && isDemoUser(u);
    if (demo) {
        btn.textContent = '홈으로';
        btn.className = `${base} text-white bg-emerald-600 border border-emerald-700 hover:bg-emerald-700 active:bg-emerald-800 shadow-sm`;
    } else {
        btn.textContent = '로그아웃';
        btn.className = `${base} text-slate-700 bg-slate-100 border border-slate-200 hover:bg-slate-200`;
    }
}

export function openSettings() {
    const state = appState;
    if (!window.currentUser) return;

    // 게스트(익명)는 userSettings가 없을 수 있음 → 기본값 사용해 설정 모달은 열고, 로그인하기 노출
    const sourceSettings = window.userSettings || DEFAULT_USER_SETTINGS;
    state._profileSettingsSnapshot = JSON.parse(JSON.stringify(sourceSettings));
    state.isProfileEditing = false;
    state.profileEditScope = null;
    state.tempSettings = JSON.parse(JSON.stringify(sourceSettings));
    
    // 프로필 타입 초기화 (text | photo)
    const inferredType = state.tempSettings?.profile?.photoUrl ? 'photo' : 'text';
    const profileType = state.tempSettings?.profile?.iconType || inferredType;
    // 이모지 타입이면 text로 변환
    window.settingsProfileType = profileType === 'emoji' ? 'text' : profileType;
    setSettingsProfileType(window.settingsProfileType);

    const nicknameInput = document.getElementById('settingNickname');
    const nicknameDisplay = document.getElementById('settingNicknameDisplay');
    const nicknameVal = (state.tempSettings.profile.nickname || '').trim();
    if (nicknameInput) {
        nicknameInput.value = nicknameVal;
        // 닉네임 입력 시 텍스트 미리보기 즉시 반영 (조합 중 지연 → 한글 IME 이슈 방지)
        if (!nicknameInput._nicknameCompositionInit) {
            addCompositionAwareInput(nicknameInput, () => {
                if (window.settingsProfileType === 'text') setSettingsProfileType('text');
                syncAccountCardDisplayFields();
                renderSettingsProfileAvatarPreview();
            });
            nicknameInput._nicknameCompositionInit = true;
        }
    }
    if (nicknameDisplay) {
        nicknameDisplay.textContent = nicknameVal || '-';
        nicknameDisplay.classList.toggle('hidden', !!state.isProfileEditing);
    }
    if (nicknameInput) nicknameInput.classList.toggle('hidden', !state.isProfileEditing);
    const bioInput = document.getElementById('settingBio');
    // 생년월일 / 라이프스타일 초기화
    const birthdateInput = document.getElementById('settingBirthdate');
    const birthdateDisplay = document.getElementById('settingBirthdateDisplay');
    const birthdateEdit = document.getElementById('settingBirthdateEdit');
    const birthdateVal = (state.tempSettings?.profile?.birthdate || '').trim();
    if (birthdateInput) birthdateInput.value = birthdateVal;
    const genderVal = (state.tempSettings?.profile?.gender || '').trim();
    const genderText = genderVal === 'male' ? '(남)' : genderVal === 'female' ? '(여)' : '';
    if (birthdateDisplay) {
        birthdateDisplay.textContent = formatBirthdateForDisplay(birthdateVal) + (genderText ? ' ' + genderText : '');
        birthdateDisplay.classList.toggle('hidden', !!state.isProfileEditing);
    }
    if (birthdateEdit) birthdateEdit.classList.toggle('hidden', !state.isProfileEditing);
    const lifestyleInput = document.getElementById('settingLifestyle');
    if (lifestyleInput) {
        lifestyleInput.value = state.tempSettings?.profile?.lifestyle || '';
    }
    // 라이프스타일 버튼 선택 상태 복원
    const selectedLifestyle = (state.tempSettings?.profile?.lifestyle || '').trim();
    document.querySelectorAll('.settings-lifestyle-btn').forEach(btn => {
        const v = btn.getAttribute('data-value') || '';
        const active = v === selectedLifestyle;
        btn.classList.toggle('bg-emerald-600', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('border-emerald-600', active);
        btn.classList.toggle('bg-white', !active);
        btn.classList.toggle('text-slate-600', !active);
        btn.classList.toggle('border-slate-200', !active);
    });
    // 성별 선택 상태 복원
    const selectedGender = (state.tempSettings?.profile?.gender || '').trim();
    const settingGenderEl = document.getElementById('settingGender');
    if (settingGenderEl) settingGenderEl.value = selectedGender;
    document.querySelectorAll('.setting-gender-btn').forEach(btn => {
        const v = btn.getAttribute('data-value') || '';
        const active = v === selectedGender;
        btn.classList.toggle('bg-black', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('bg-slate-50', !active);
        btn.classList.toggle('text-slate-600', !active);
    });

    // 생년월일 힌트 업데이트 (이미 1회 수정했으면 안내, 수정 모드일 때만 표시)
    const birthdateHint = document.getElementById('birthdateHint');
    const changeCount = Number(state.tempSettings?.profile?.birthdateChangeCount || 0);
    if (birthdateHint) {
        birthdateHint.textContent = changeCount >= 1 ? '이미 1회 수정 완료 (추가 변경 불가)' : '가입 후 1회만 수정 가능';
        birthdateHint.classList.toggle('hidden', !state.isProfileEditing);
    }
    if (bioInput) {
        bioInput.value = state.tempSettings.profile.bio || '';
        const bioCharCount = document.getElementById('bioCharCount');
        if (bioCharCount) {
            bioCharCount.textContent = (state.tempSettings.profile.bio || '').length;
        }
        // 글자 수 카운터 업데이트 (조합 중 지연 → 한글 IME 이슈 방지)
        if (!bioInput._bioCompositionInit) {
            addCompositionAwareInput(bioInput, () => {
                const count = bioInput.value.length;
                if (bioCharCount) bioCharCount.textContent = count;
            });
            bioInput._bioCompositionInit = true;
        }
    }
    
    // 밀당 메모 입력 필드 초기화
    const shortcutsInput = document.getElementById('shortcutsInput');
    if (shortcutsInput) {
        shortcutsInput.value = state.tempSettings.shortcuts || '';
    }
    
    // 밀당 메모 저장 버튼 이벤트 리스너
    const saveShortcutsBtn = document.getElementById('saveShortcutsBtn');
    if (saveShortcutsBtn) {
        saveShortcutsBtn.onclick = async () => {
            if (shortcutsInput) {
                state.tempSettings.shortcuts = shortcutsInput.value.trim();
                window.userSettings = JSON.parse(JSON.stringify(state.tempSettings));
                try {
                    await dbOps.saveSettings(window.userSettings);
                    showToast("밀당 메모가 저장되었습니다.", 'success');
                } catch (e) {
                    console.error('밀당 메모 저장 실패:', e);
                    showToast("밀당 메모 저장 중 오류가 발생했습니다.", 'error');
                }
            }
        };
    }
    
    // 자주 사용하는 태그 초기화 (없으면 빈 객체로)
    if (!state.tempSettings.favoriteSubTags) {
        state.tempSettings.favoriteSubTags = {
            mealType: {},
            category: {},
            withWhom: {},
            snackType: {}
        };
    }
    
    // 자주 사용하는 태그 편집 UI 렌더링
    renderFavoriteTagsEditor();
    
    // 사진 선택 및 삭제 버튼 이벤트 리스너 설정 (이미 선언된 photoDeleteBtn 재사용)
    const photoSelectBtn = document.getElementById('photoSelectBtn');
    const photoInput = document.getElementById('photoInput');
    const textSectionPhotoBtn = document.getElementById('textSectionPhotoBtn');
    
    // 텍스트 섹션의 사진 설정 버튼
    if (textSectionPhotoBtn && photoInput) {
        textSectionPhotoBtn.onclick = () => {
            if (appState.isProfileEditing && appState.profileEditScope === 'full') {
                photoInput.click();
            } else {
                showToast('프로필 사진은 계정 영역에서 사진을 눌러 전체 편집으로 변경할 수 있습니다.', 'info');
            }
        };
    }
    
    // 사진 섹션의 사진 선택 버튼
    if (photoSelectBtn && photoInput) {
        photoSelectBtn.onclick = () => {
            if (appState.isProfileEditing && appState.profileEditScope === 'full') {
                photoInput.click();
            } else {
                showToast('프로필 사진은 계정 영역에서 사진을 눌러 전체 편집으로 변경할 수 있습니다.', 'info');
            }
        };
    }

    // 버전 정보 로드 및 표시
    loadVersionInfo();
    
    // 게스트 모드일 때 태그 관리 및 밀당 메모 탭 숨기기
    const tagsTab = document.getElementById('settingsTabTags');
    const shortcutsTab = document.getElementById('settingsTabShortcuts');
    const profileSettingsSection = document.querySelector('#settingsTabContentProfile .space-y-3');
    
    if (window.currentUser && window.currentUser.isAnonymous) {
        // 게스트 모드일 때 태그 관리 및 밀당 메모 탭 숨기기
        if (tagsTab) tagsTab.classList.add('hidden');
        if (shortcutsTab) shortcutsTab.classList.add('hidden');
        // 게스트 모드일 때 프로필 설정 폼만 숨기기 (계정/로그인하기는 프로필 탭에 표시)
        if (profileSettingsSection) profileSettingsSection.classList.add('hidden');
        switchSettingsTab('profile'); // 프로필 탭으로 이동해 '로그인하기' 노출
    } else {
        // 일반 사용자일 때 모든 탭 표시
        if (tagsTab) tagsTab.classList.remove('hidden');
        if (shortcutsTab) shortcutsTab.classList.remove('hidden');
        if (profileSettingsSection) profileSettingsSection.classList.remove('hidden');
        switchSettingsTab('profile');
    }
        
        const accountSection = document.getElementById('accountSection');
    if (accountSection) {
        let accountHtml = '';
        if (window.currentUser.isAnonymous) {
            accountHtml = `<div class="bg-indigo-50 p-3 rounded-2xl border border-indigo-100 mb-3">
                <div class="flex items-center gap-3 mb-3">
                    <div class="w-10 h-10 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-500">
                        <i class="fa-solid fa-user-secret"></i>
                    </div>
                    <div>
                        <div class="text-xs font-bold text-indigo-600">게스트 모드</div>
                    </div>
                </div>
                <button id="switchToLoginBtn" class="w-full py-2.5 bg-indigo-600 text-white rounded-xl text-xs font-bold active:bg-indigo-700 transition-colors">
                    <i class="fa-solid fa-right-to-bracket mr-1"></i>로그인하기
                </button>
            </div>`;
            document.getElementById('logoutBtnArea').classList.add('hidden');
            syncProfileLogoutFooterButton();
            const deleteArea = document.getElementById('deleteAccountBtnArea');
            if (deleteArea) deleteArea.classList.add('hidden');
        } else {
            const { icon: providerIcon, line: loginLine } = getSettingsAccountLoginDisplay(window.currentUser);
            const myPostsHidden = !window.currentUser || window.currentUser.isAnonymous;
            accountHtml = `<div class="bg-emerald-50 p-3 rounded-2xl border border-emerald-100 mb-1">
                <div class="flex items-center gap-3">
                    <div class="flex flex-col items-center justify-center gap-1.5 shrink-0 self-center">
                        <button type="button" id="accountProfileAvatarBtn" class="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-white border border-slate-400 overflow-hidden transition active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="프로필 사진 변경">
                            <span id="accountProfileAvatar" class="flex h-full w-full items-center justify-center rounded-full bg-slate-100 text-lg font-bold text-slate-600"></span>
                        </button>
                        <button type="button" id="photoDeleteBtn" class="hidden text-[11px] font-bold text-red-500 hover:text-red-600 whitespace-nowrap px-1">삭제</button>
                        <button type="button" id="openMyPostsFromSettingsBtn" class="${myPostsHidden ? 'hidden' : ''} mt-0.5 px-2 py-1.5 text-[11px] font-bold text-white bg-emerald-600 border border-emerald-600 rounded-lg hover:bg-emerald-700 active:bg-emerald-800 transition-colors whitespace-nowrap max-w-[5.5rem] leading-tight shadow-sm" title="모먼트에서 내 공유·게시글 보기">내 게시물</button>
                    </div>
                    <div class="flex-1 min-w-0 flex flex-col items-end text-right gap-1">
                        <div class="flex flex-wrap items-center justify-end gap-2 text-emerald-700 font-bold text-sm w-full" id="settingsLoginInfoRow">${providerIcon}<span class="break-all">${loginLine}</span></div>
                        <div class="flex items-center justify-end gap-1.5 w-full min-w-0">
                            <span id="accountHeaderNickname" class="text-base font-bold text-slate-800 truncate min-w-0 flex-1 max-w-[min(100%,14rem)]">-</span>
                            <div id="accountNicknameInputHost" class="hidden min-w-0 flex-1 max-w-[min(100%,14rem)] flex justify-end items-center"></div>
                            <div id="accountNicknameActions" class="flex shrink-0 items-center gap-1">
                                <button type="button" id="accountNicknameSaveBtn" class="hidden px-0 py-0 text-[10px] font-bold text-emerald-700 bg-transparent border-0 shadow-none hover:underline underline-offset-2" title="저장" aria-label="닉네임 저장">저장</button>
                                <button type="button" id="accountNicknameCancelBtn" class="hidden px-0 py-0 text-[10px] font-bold text-slate-500 bg-transparent border-0 shadow-none hover:underline underline-offset-2" title="취소" aria-label="취소">취소</button>
                                <button type="button" id="accountEditNicknameBtn" data-action="edit" class="p-1 rounded-lg text-slate-400 hover:text-emerald-700 hover:bg-emerald-100/80 transition inline-flex items-center justify-center" title="닉네임 수정" aria-label="닉네임 수정"><i class="fa-solid fa-pencil settings-pencil-icon"></i></button>
                            </div>
                        </div>
                        <div class="flex flex-col items-stretch gap-1 w-full text-sm font-medium text-slate-700">
                            <div id="accountBirthdateViewRow" class="flex items-center justify-end gap-1.5 w-full min-w-0">
                                <span id="accountHeaderBirthdate" class="truncate min-w-0 flex-1 max-w-[min(100%,14rem)] text-right">생년월일</span>
                                <div id="accountBirthdateActionsView" class="flex shrink-0 items-center gap-0.5">
                                    <button type="button" id="accountEditBirthdateBtn" data-action="edit" class="p-1 rounded-lg text-slate-400 hover:text-emerald-700 hover:bg-emerald-100/80 transition inline-flex items-center justify-center" title="생년월일 수정" aria-label="생년월일 수정"><i class="fa-solid fa-pencil settings-pencil-icon"></i></button>
                                </div>
                            </div>
                            <div id="accountBirthdateEditorRow" class="hidden w-full flex flex-row flex-wrap items-center justify-end gap-x-2 gap-y-1 min-w-0">
                                <div id="accountBirthdateEditHost" class="min-w-0 flex max-w-full flex-wrap items-center justify-end gap-2"></div>
                                <div id="accountBirthdateActionsEdit" class="shrink-0 flex items-center gap-1">
                                    <button type="button" id="accountBirthdateSaveBtn" class="px-0 py-0 text-[10px] font-bold text-emerald-700 bg-transparent border-0 shadow-none hover:underline underline-offset-2" title="저장" aria-label="생년월일 저장">저장</button>
                                    <button type="button" id="accountBirthdateCancelBtn" class="px-0 py-0 text-[10px] font-bold text-slate-500 bg-transparent border-0 shadow-none hover:underline underline-offset-2" title="취소" aria-label="취소">취소</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>`;
            document.getElementById('logoutBtnArea').classList.remove('hidden');
            syncProfileLogoutFooterButton();
            const deleteArea = document.getElementById('deleteAccountBtnArea');
            if (deleteArea) deleteArea.classList.toggle('hidden', isDemoUser(window.currentUser));
        }
        accountSection.innerHTML = accountHtml;
        // 카카오: 이메일은 users/{uid} 루트(patchArtifactUserRoot)에만 있고 Auth·settings에 없을 수 있음 → 루트에서 보강
        if (
            window.currentUser &&
            !window.currentUser.isAnonymous &&
            typeof window.currentUser.uid === 'string' &&
            window.currentUser.uid.startsWith('kakao_')
        ) {
            const hasMail =
                (window.currentUser.email || '').includes('@') ||
                (window.userSettings?.email || '').includes('@');
            if (!hasMail) {
                (async () => {
                    try {
                        const { doc, getDoc } = await import(
                            'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js'
                        );
                        const { db, appId } = await import('../firebase.js');
                        const snap = await getDoc(doc(db, 'artifacts', appId, 'users', window.currentUser.uid));
                        const rootEmail =
                            snap.exists() && snap.data().email ? String(snap.data().email).trim() : '';
                        if (rootEmail.includes('@')) {
                            window.userSettings = window.userSettings || {};
                            if (!window.userSettings.email) window.userSettings.email = rootEmail;
                            const row = document.getElementById('settingsLoginInfoRow');
                            if (row && window.currentUser) {
                                const { icon: pi, line: ll } = getSettingsAccountLoginDisplay(window.currentUser);
                                row.innerHTML = `${pi}<span class="break-all">${ll}</span>`;
                            }
                        }
                    } catch (_) {
                        /* ignore */
                    }
                })();
            }
        }
        
        // 게스트 모드일 때 로그인하기 버튼에 이벤트 리스너 추가
        if (window.currentUser && window.currentUser.isAnonymous) {
            // 약간의 지연을 두고 버튼을 찾아서 이벤트 리스너 추가 (innerHTML 후 DOM 업데이트 대기)
            setTimeout(() => {
                const switchToLoginBtn = document.getElementById('switchToLoginBtn');
                if (switchToLoginBtn) {
                    switchToLoginBtn.addEventListener('click', async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        try {
                            if (window.switchToLogin) {
                                await window.switchToLogin();
                            } else {
                                console.error('switchToLogin 함수를 찾을 수 없습니다.');
                                showToast("로그인 기능을 사용할 수 없습니다.", "error");
                            }
                        } catch (error) {
                            console.error('로그인하기 버튼 클릭 오류:', error);
                            showToast("로그인 페이지로 이동하는 중 오류가 발생했습니다.", "error");
                        }
                    });
                }
            }, 100);
        }

        if (window.currentUser && !window.currentUser.isAnonymous) {
            const accountAvatarBtn = document.getElementById('accountProfileAvatarBtn');
            const photoInputEl = document.getElementById('photoInput');
            const accountAvatarModalChangeBtn = document.getElementById('accountAvatarModalChangeBtn');
            const accountAvatarModalCloseBtn = document.getElementById('accountAvatarModalCloseBtn');
            const accountAvatarModal = document.getElementById('accountAvatarModal');
            if (accountAvatarBtn) {
                accountAvatarBtn.onclick = (e) => {
                    e.preventDefault();
                    if (window.currentUser && !window.currentUser.isAnonymous && isDemoUser(window.currentUser)) {
                        showToast('샘플 계정은 읽기 전용입니다.', 'info');
                        return;
                    }
                    openAccountAvatarModal();
                };
            }
            if (accountAvatarModalChangeBtn && photoInputEl) {
                accountAvatarModalChangeBtn.onclick = (e) => {
                    e.preventDefault();
                    if (window.currentUser && !window.currentUser.isAnonymous && isDemoUser(window.currentUser)) {
                        showToast('샘플 계정은 읽기 전용입니다.', 'info');
                        return;
                    }
                    if (
                        (!appState.isProfileEditing || appState.profileEditScope !== 'full') &&
                        typeof window.startProfileSettingsEdit === 'function'
                    ) {
                        window.startProfileSettingsEdit();
                    }
                    requestAnimationFrame(() => photoInputEl.click());
                };
            }
            if (accountAvatarModalCloseBtn) {
                accountAvatarModalCloseBtn.onclick = (e) => {
                    e.preventDefault();
                    closeAccountAvatarModal();
                };
            }
            if (accountAvatarModal) {
                accountAvatarModal.onclick = (e) => {
                    if (e.target === accountAvatarModal) closeAccountAvatarModal();
                };
            }
            const myPostsInAccount = document.getElementById('openMyPostsFromSettingsBtn');
            if (myPostsInAccount) {
                myPostsInAccount.onclick = () => {
                    if (typeof window.openMyPostsFromSettings === 'function') window.openMyPostsFromSettings();
                };
            }
            const photoDeleteBtnEl = document.getElementById('photoDeleteBtn');
            if (photoDeleteBtnEl) {
                photoDeleteBtnEl.onclick = () => handlePhotoDelete();
            }
            setProfileSettingsEditMode(false);
            syncAccountCardDisplayFields();
            renderSettingsProfileAvatarPreview();

            const nickPencil = document.getElementById('accountEditNicknameBtn');
            const bdPencil = document.getElementById('accountEditBirthdateBtn');
            const nickSave = document.getElementById('accountNicknameSaveBtn');
            const nickCancel = document.getElementById('accountNicknameCancelBtn');
            const bdSave = document.getElementById('accountBirthdateSaveBtn');
            const bdCancel = document.getElementById('accountBirthdateCancelBtn');
            if (nickPencil) {
                nickPencil.onclick = (e) => {
                    e.preventDefault();
                    handleProfileFieldPencilOrSave('nickname');
                };
            }
            if (nickSave) nickSave.onclick = (e) => { e.preventDefault(); void saveProfileSingleField('nickname'); };
            if (nickCancel) nickCancel.onclick = (e) => { e.preventDefault(); cancelInlineProfileFieldEdit(); };
            if (bdPencil) {
                bdPencil.onclick = (e) => {
                    e.preventDefault();
                    handleProfileFieldPencilOrSave('birthdate');
                };
            }
            if (bdSave) bdSave.onclick = (e) => { e.preventDefault(); void saveProfileSingleField('birthdate'); };
            if (bdCancel) bdCancel.onclick = (e) => { e.preventDefault(); cancelInlineProfileFieldEdit(); };

            const bdInput = document.getElementById('settingBirthdate');
            if (bdInput && !bdInput._accountCardSync) {
                bdInput._accountCardSync = true;
                const syncBd = () => syncAccountCardDisplayFields();
                bdInput.addEventListener('input', syncBd);
                addCompositionAwareInput(bdInput, syncBd);
            }
        }
    }

    // 사용자 설정을 탭으로 전환 (밀려오는 방식 없이 다른 탭과 동일하게)
    if (typeof window.switchMainTab === 'function') {
        window.switchMainTab('settings');
    }
}

// 버전 정보 로드 함수
// - 프로덕션(1.0.0): 배포일자만 표시 (2026.02.19)
// - 스테이징(1.0.0_1): 기준일 (배포일) 형식 (2026.02.18 (2026.02.19))
function formatVersionDate(isoStr) {
    const d = new Date(isoStr);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}.${m}.${day}`;
}

async function loadVersionInfo() {
    try {
        const response = await fetch('/version.json?t=' + Date.now());
        if (response.ok) {
            const data = await response.json();
            const versionNumberEl = document.getElementById('versionNumber');
            const buildDateEl = document.getElementById('buildDate');

            if (versionNumberEl && data.version) {
                versionNumberEl.textContent = data.version;
            }

            if (buildDateEl && data.buildDate) {
                const buildDate = new Date(data.buildDate);
                const isStaging = /_\d+$/.test(String(data.version || ''));

                if (isStaging && data.baseBuildDate) {
                    // 스테이징: 기준일 (배포일) 형식
                    const baseStr = formatVersionDate(data.baseBuildDate);
                    const deployStr = formatVersionDate(data.buildDate);
                    buildDateEl.textContent = `${baseStr} (${deployStr})`;
                    buildDateEl.title = `기준: ${new Date(data.baseBuildDate).toLocaleString('ko-KR')} / 배포: ${buildDate.toLocaleString('ko-KR')}`;
                } else {
                    // 프로덕션: 배포일자만
                    buildDateEl.textContent = formatVersionDate(data.buildDate);
                    buildDateEl.title = buildDate.toLocaleString('ko-KR');
                }
            }
        }
    } catch (e) {
        console.debug('버전 정보 로드 실패 (무시):', e);
    }
}

export function closeSettings() {
    // 설정 탭일 때는 타임라인 탭으로 전환
    if (typeof appState !== 'undefined' && appState.currentTab === 'settings' && typeof window.switchMainTab === 'function') {
        window.switchMainTab('timeline');
    }
}

// 설정 페이지 탭 전환 함수 (바 타입)
export function switchSettingsTab(tab) {
    const profileTab = document.getElementById('settingsTabProfile');
    const tagsTab = document.getElementById('settingsTabTags');
    const shortcutsTab = document.getElementById('settingsTabShortcuts');
    const notificationsTab = document.getElementById('settingsTabNotifications');
    const profileContent = document.getElementById('settingsTabContentProfile');
    const tagsContent = document.getElementById('settingsTabContentTags');
    const shortcutsContent = document.getElementById('settingsTabContentShortcuts');
    const notificationsContent = document.getElementById('settingsTabContentNotifications');
    
    const settingsTabInactiveClass =
        'settings-tab flex-1 min-w-0 basis-0 flex items-center justify-center px-0.5 py-2.5 text-[11px] sm:text-sm font-bold text-slate-500 border-b-2 border-transparent hover:text-slate-700 hover:border-slate-300 transition-colors leading-tight';
    const settingsTabActiveClass =
        'settings-tab flex-1 min-w-0 basis-0 flex items-center justify-center px-0.5 py-2.5 text-[11px] sm:text-sm font-bold text-emerald-600 border-b-2 border-emerald-600 transition-colors leading-tight';

    // 모든 탭 비활성화
    [profileTab, tagsTab, shortcutsTab, notificationsTab].forEach((t) => {
        if (t) t.className = settingsTabInactiveClass;
    });
    
    // 모든 콘텐츠 숨기기
    [profileContent, tagsContent, shortcutsContent, notificationsContent].forEach(c => {
        if (c) c.classList.add('hidden');
    });
    
    if (tab === 'profile') {
        // 프로필 탭 활성화
        if (profileTab) {
            profileTab.className = settingsTabActiveClass;
            profileTab.textContent = '프로필';
        }
        if (profileContent) profileContent.classList.remove('hidden');
        logUsageMetric('settings_profile').catch(() => {});
    } else if (tab === 'tags') {
        // 태그 관리 탭 활성화
        if (tagsTab) {
            tagsTab.className = settingsTabActiveClass;
            tagsTab.textContent = '태그 관리';
        }
        if (tagsContent) tagsContent.classList.remove('hidden');
        logUsageMetric('settings_tags').catch(() => {});
    } else if (tab === 'shortcuts') {
        // 밀당 메모 탭 활성화
        if (shortcutsTab) {
            shortcutsTab.className = settingsTabActiveClass;
            shortcutsTab.textContent = '밀당 메모';
        }
        if (shortcutsContent) shortcutsContent.classList.remove('hidden');
        logUsageMetric('settings_mealdang_memo').catch(() => {});
    } else if (tab === 'notifications') {
        if (notificationsTab) {
            notificationsTab.className = settingsTabActiveClass;
            notificationsTab.textContent = '푸시 알림';
        }
        if (notificationsContent) notificationsContent.classList.remove('hidden');
        syncPushPreferencesFormFromUserSettings();
        logUsageMetric('settings_push').catch(() => {});
    }
}

function getSettingsNicknamePreviewText() {
    return (
        document.getElementById('settingNickname')?.value ||
        appState?.tempSettings?.profile?.nickname ||
        window.userSettings?.profile?.nickname ||
        ''
    ).trim();
}

/** 계정 카드 닉네임 */
function updateAccountHeaderNickname() {
    const el = document.getElementById('accountHeaderNickname');
    if (!el) return;
    const v = getSettingsNicknamePreviewText();
    el.textContent = v || '-';
}

/** 계정 카드 생년월일(성별) */
function updateAccountHeaderBirthdate() {
    const el = document.getElementById('accountHeaderBirthdate');
    if (!el) return;
    const state = appState;
    const birthdateInput = document.getElementById('settingBirthdate');
    const raw = (birthdateInput?.value ?? state?.tempSettings?.profile?.birthdate ?? '').trim();
    const gender = (document.getElementById('settingGender')?.value || state?.tempSettings?.profile?.gender || '').trim();
    const genderText = gender === 'male' ? '(남)' : gender === 'female' ? '(여)' : '';
    if (!raw) {
        el.textContent = '생년월일';
        return;
    }
    el.textContent = formatBirthdateForDisplay(raw) + (genderText ? ` ${genderText}` : '');
}

function syncAccountCardDisplayFields() {
    updateAccountHeaderNickname();
    updateAccountHeaderBirthdate();
}

let _saveProfileSingleFieldBusy = false;

function syncGenderButtonsUIFromHidden() {
    const selectedGender = (document.getElementById('settingGender')?.value || appState.tempSettings?.profile?.gender || '').trim();
    document.querySelectorAll('.setting-gender-btn').forEach(btn => {
        const v = btn.getAttribute('data-value') || '';
        const active = v === selectedGender;
        btn.classList.toggle('font-bold', active);
        btn.classList.toggle('text-emerald-700', active);
        btn.classList.toggle('underline', active);
        btn.classList.toggle('decoration-2', active);
        btn.classList.toggle('underline-offset-2', active);
        btn.classList.toggle('font-medium', !active);
        btn.classList.toggle('text-slate-400', !active);
        btn.classList.toggle('no-underline', !active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
}

function syncLifestyleChipsUIFromHidden() {
    const selectedLifestyle = (document.getElementById('settingLifestyle')?.value || appState.tempSettings?.profile?.lifestyle || '').trim();
    document.querySelectorAll('.settings-lifestyle-btn').forEach(btn => {
        const v = btn.getAttribute('data-value') || '';
        const active = v === selectedLifestyle;
        btn.classList.toggle('bg-emerald-600', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('border-emerald-600', active);
        btn.classList.toggle('bg-white', !active);
        btn.classList.toggle('text-slate-600', !active);
        btn.classList.toggle('border-slate-200', !active);
    });
}

function applyTempSettingsToProfileDom() {
    const ts = appState.tempSettings;
    if (!ts?.profile) return;
    const nick = document.getElementById('settingNickname');
    if (nick) nick.value = ts.profile.nickname || '';
    const bd = document.getElementById('settingBirthdate');
    if (bd) bd.value = ts.profile.birthdate || '';
    const bio = document.getElementById('settingBio');
    if (bio) {
        bio.value = ts.profile.bio || '';
        const bioCharCount = document.getElementById('bioCharCount');
        if (bioCharCount) bioCharCount.textContent = String((ts.profile.bio || '').length);
    }
    const gid = document.getElementById('settingGender');
    if (gid) gid.value = ts.profile.gender || '';
    const life = document.getElementById('settingLifestyle');
    if (life) life.value = ts.profile.lifestyle || '';
    syncGenderButtonsUIFromHidden();
    syncLifestyleChipsUIFromHidden();
}

function setAccountFieldButtonMode(field, mode) {
    const showSaveCancel = mode === 'save';
    if (field === 'nickname') {
        const pencil = document.getElementById('accountEditNicknameBtn');
        const saveB = document.getElementById('accountNicknameSaveBtn');
        const cancelB = document.getElementById('accountNicknameCancelBtn');
        pencil?.classList.toggle('hidden', showSaveCancel);
        saveB?.classList.toggle('hidden', !showSaveCancel);
        cancelB?.classList.toggle('hidden', !showSaveCancel);
        return;
    }
    if (field === 'birthdate') {
        /* 생년월일은 편집 행 전환으로 처리(mountBirthdateInline / unmountBirthdateInline) */
        return;
    }
    const map = { bio: ['accountEditBioBtn', 'accountBioSaveBtn', 'accountBioCancelBtn'], lifestyle: ['accountEditLifestyleBtn', 'accountLifestyleSaveBtn', 'accountLifestyleCancelBtn'] };
    const ids = map[field];
    if (!ids) return;
    const [pencilId, saveId, cancelId] = ids;
    document.getElementById(pencilId)?.classList.toggle('hidden', showSaveCancel);
    document.getElementById(saveId)?.classList.toggle('hidden', !showSaveCancel);
    document.getElementById(cancelId)?.classList.toggle('hidden', !showSaveCancel);
}

function resetAllProfileFieldActionButtons() {
    setAccountFieldButtonMode('nickname', 'edit');
    setAccountFieldButtonMode('bio', 'edit');
    setAccountFieldButtonMode('lifestyle', 'edit');
}

function unmountNicknameInline() {
    const defaultParent = document.querySelector('#settingNicknameRow .profile-settings-field-same');
    const input = document.getElementById('settingNickname');
    const span = document.getElementById('accountHeaderNickname');
    const host = document.getElementById('accountNicknameInputHost');
    if (defaultParent && input && !defaultParent.contains(input)) {
        defaultParent.appendChild(input);
    }
    if (input) {
        input.classList.add('hidden');
        input.className =
            'profile-settings-input profile-settings-input-inline profile-settings-nickname-input hidden text-right w-[80%] max-w-full ml-auto';
    }
    host?.classList.add('hidden');
    span?.classList.remove('hidden');
}

function unmountBirthdateInline() {
    const defaultParent = document.querySelector('#settingBirthdateRow .profile-settings-field.profile-settings-field-same');
    const edit = document.getElementById('settingBirthdateEdit');
    const host = document.getElementById('accountBirthdateEditHost');
    const viewRow = document.getElementById('accountBirthdateViewRow');
    const editorRow = document.getElementById('accountBirthdateEditorRow');
    if (defaultParent && edit && !defaultParent.contains(edit)) {
        defaultParent.appendChild(edit);
    }
    if (edit) edit.classList.add('hidden');
    /* host(#accountBirthdateEditHost)에 hidden을 붙이면 다음 편집 시 입력란이 보이지 않음 — editorRow만 토글 */
    host?.classList.remove('hidden');
    viewRow?.classList.remove('hidden');
    editorRow?.classList.add('hidden');
}

function mountNicknameInline() {
    const host = document.getElementById('accountNicknameInputHost');
    const span = document.getElementById('accountHeaderNickname');
    const input = document.getElementById('settingNickname');
    if (!host || !input || !span) return;
    span.classList.add('hidden');
    host.classList.remove('hidden');
    host.appendChild(input);
    input.classList.remove('hidden');
    input.disabled = false;
    input.className =
        'profile-settings-nickname-inline w-full min-w-0 max-w-full text-right text-sm font-bold text-slate-800 bg-white px-2 py-1.5';
    setAccountFieldButtonMode('nickname', 'save');
    requestAnimationFrame(() => input.focus());
}

function mountBirthdateInline() {
    const host = document.getElementById('accountBirthdateEditHost');
    const viewRow = document.getElementById('accountBirthdateViewRow');
    const editorRow = document.getElementById('accountBirthdateEditorRow');
    const edit = document.getElementById('settingBirthdateEdit');
    if (!host || !edit || !viewRow || !editorRow) return;
    viewRow.classList.add('hidden');
    editorRow.classList.remove('hidden');
    host.classList.remove('hidden');
    host.appendChild(edit);
    edit.classList.remove('hidden');
    const bdInput = document.getElementById('settingBirthdate');
    if (bdInput) setupBirthdateInputFormatting(bdInput);
    requestAnimationFrame(() => bdInput?.focus());
}

/** 인라인 편집 취소(프로필 필드만 스냅샷 복구 — 밀당 메모 등 다른 설정은 유지) */
export function cancelInlineProfileFieldEdit() {
    unmountNicknameInline();
    unmountBirthdateInline();
    resetAllProfileFieldActionButtons();
    if (appState._profileSettingsSnapshot?.profile) {
        const p = JSON.parse(JSON.stringify(appState._profileSettingsSnapshot.profile));
        appState.tempSettings.profile = p;
        if (window.userSettings) window.userSettings.profile = JSON.parse(JSON.stringify(p));
    }
    applyTempSettingsToProfileDom();
    syncAccountCardDisplayFields();
    renderSettingsProfileAvatarPreview();
    setProfileSettingsEditMode(false);
}

export async function saveProfileSingleField(field) {
    const state = appState;
    if (_saveProfileSingleFieldBusy) return;
    if (!state.isProfileEditing || state.profileEditScope !== field) return;
    _saveProfileSingleFieldBusy = true;
    try {
        if (field === 'nickname') {
            const newNickname = (document.getElementById('settingNickname')?.value || '').trim();
            const existingNickname = (window.userSettings?.profile?.nickname || '').trim();
            if (!newNickname) {
                showToast('닉네임을 입력해주세요.', 'error');
                return;
            }
            if (newNickname.length > 20) {
                showToast('닉네임은 20자 이하로 입력해주세요.', 'error');
                return;
            }
            const { containsProfanity, isNicknameDuplicate } = await import('../utils/nickname.js');
            if (containsProfanity(newNickname)) {
                showToast('사용할 수 없는 닉네임입니다. 다른 닉네임을 입력해주세요.', 'error');
                return;
            }
            const duplicate = await isNicknameDuplicate(newNickname, window.currentUser?.uid || null);
            if (duplicate) {
                showToast('이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해주세요.', 'error');
                return;
            }
            state.tempSettings.profile.nickname = newNickname || existingNickname || '게스트';
            const fn = (state.tempSettings.profile.nickname || '').trim();
            if (fn && fn !== '게스트') {
                state.tempSettings.profileCompleted = true;
                state.tempSettings.profileCompletedAt = state.tempSettings.profileCompletedAt || new Date().toISOString();
            }
        } else if (field === 'birthdate') {
            const newBirthdate = (document.getElementById('settingBirthdate')?.value || '').trim();
            const newGenderRaw = (document.getElementById('settingGender')?.value || '').trim();
            const newGender = newGenderRaw === 'male' || newGenderRaw === 'female' ? newGenderRaw : null;
            const existingBirthdate = (window.userSettings?.profile?.birthdate || '').trim();
            const existingCount = Number(window.userSettings?.profile?.birthdateChangeCount || 0);
            if (newBirthdate) {
                const { formatted: formattedBirthdate, valid } = normalizeBirthdateRaw(newBirthdate);
                if (!valid) {
                    showToast('입력한 생년월일이 올바르지 않습니다. 숫자 8자리(예: 19900115)로 입력해주세요.', 'error');
                    return;
                }
                const isBirthdateChanged = existingBirthdate && formattedBirthdate && existingBirthdate !== formattedBirthdate;
                if (isBirthdateChanged) {
                    if (existingCount >= 1) {
                        showToast('생년월일은 가입 후 1회만 변경할 수 있습니다.', 'error');
                        return;
                    }
                    state.tempSettings.profile.birthdateChangeCount = existingCount + 1;
                    state.tempSettings.profile.birthdateChangedAt = new Date().toISOString();
                } else {
                    state.tempSettings.profile.birthdateChangeCount = Number(
                        state.tempSettings.profile.birthdateChangeCount || existingCount || 0
                    );
                    state.tempSettings.profile.birthdateChangedAt =
                        state.tempSettings.profile.birthdateChangedAt ||
                        window.userSettings?.profile?.birthdateChangedAt ||
                        null;
                }
                state.tempSettings.profile.birthdate = formattedBirthdate;
            } else {
                state.tempSettings.profile.birthdate = existingBirthdate || '';
                state.tempSettings.profile.birthdateChangeCount = Number(
                    state.tempSettings.profile.birthdateChangeCount || existingCount || 0
                );
                state.tempSettings.profile.birthdateChangedAt =
                    state.tempSettings.profile.birthdateChangedAt ||
                    window.userSettings?.profile?.birthdateChangedAt ||
                    null;
            }
            state.tempSettings.profile.gender = newGender;
        } else if (field === 'bio') {
            state.tempSettings.profile.bio = (document.getElementById('settingBio')?.value || '').trim() || '';
        } else if (field === 'lifestyle') {
            const newLifestyle = (document.getElementById('settingLifestyle')?.value || '').trim();
            const existingLifestyle = (window.userSettings?.profile?.lifestyle || '').trim();
            state.tempSettings.profile.lifestyle = newLifestyle || existingLifestyle || '';
        }

        await dbOps.saveSettings(state.tempSettings);
        state._profileSettingsSnapshot = JSON.parse(JSON.stringify(state.tempSettings));
        window.userSettings = JSON.parse(JSON.stringify(state.tempSettings));
        showToast('저장되었습니다.', 'success');
        updateHeaderUI();

        unmountNicknameInline();
        unmountBirthdateInline();
        resetAllProfileFieldActionButtons();
        applyTempSettingsToProfileDom();
        syncAccountCardDisplayFields();
        renderSettingsProfileAvatarPreview();
        setProfileSettingsEditMode(false);
    } catch (e) {
        console.error('프로필 항목 저장 실패:', e);
        showToast('저장 중 오류가 발생했습니다: ' + (e.message || e), 'error');
    } finally {
        _saveProfileSingleFieldBusy = false;
    }
}

function startInlineProfileFieldEdit(field) {
    setProfileSettingsEditMode(true, field);
    if (field === 'nickname') {
        mountNicknameInline();
    } else if (field === 'birthdate') {
        mountBirthdateInline();
    } else if (field === 'bio') {
        setAccountFieldButtonMode('bio', 'save');
        requestAnimationFrame(() => document.getElementById('settingBio')?.focus());
    } else if (field === 'lifestyle') {
        setAccountFieldButtonMode('lifestyle', 'save');
        requestAnimationFrame(() =>
            document.querySelector('.profile-lifestyle-chips .settings-lifestyle-btn')?.focus()
        );
    }
}

function handleProfileFieldPencilOrSave(field) {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인 후 이용할 수 있습니다.', 'info');
        return;
    }
    if (isDemoUser(window.currentUser)) {
        showToast('샘플 계정은 읽기 전용입니다.', 'info');
        return;
    }
    const allowed = ['nickname', 'birthdate', 'bio', 'lifestyle'];
    if (!allowed.includes(field)) return;

    if (appState.profileEditScope && appState.profileEditScope !== 'full') {
        cancelInlineProfileFieldEdit();
    }
    startInlineProfileFieldEdit(field);
}

/** 연필 → 같은 위치 인라인 편집, 버튼은 저장으로 전환 후 항목만 저장 */
export function activateAccountFieldEdit(field) {
    handleProfileFieldPencilOrSave(field);
}

function refreshAccountAvatarModalPreview() {
    const img = document.getElementById('accountAvatarModalImg');
    const icon = document.getElementById('accountAvatarModalIcon');
    if (!img || !icon) return;
    const photoUrl =
        appState?.tempSettings?.profile?.photoUrl ||
        window.settingsPhotoUrl ||
        window.userSettings?.profile?.photoUrl;
    const type = window.settingsProfileType === 'photo' ? 'photo' : 'text';
    const showImg = type === 'photo' && photoUrl;
    if (showImg) {
        img.src = photoUrl;
        img.classList.remove('hidden');
        icon.classList.add('hidden');
    } else {
        img.classList.add('hidden');
        img.removeAttribute('src');
        icon.classList.remove('hidden');
    }
}

export function openAccountAvatarModal() {
    const modal = document.getElementById('accountAvatarModal');
    if (!modal) return;
    refreshAccountAvatarModalPreview();
    modal.classList.remove('hidden');
}

export function closeAccountAvatarModal() {
    document.getElementById('accountAvatarModal')?.classList.add('hidden');
}

/**
 * 숨김 스텁(#photoPreview 등) + 계정 카드 아바타를 동일 상태로 맞춤.
 * 사진 편집 저장 등에서 window.renderSettingsProfileAvatarPreview 로 재사용.
 */
export function renderSettingsProfileAvatarPreview() {
    const type = window.settingsProfileType === 'photo' ? 'photo' : 'text';
    const photoUrl =
        appState?.tempSettings?.profile?.photoUrl ||
        window.settingsPhotoUrl ||
        window.userSettings?.profile?.photoUrl;
    const nicknameVal = getSettingsNicknamePreviewText();
    const firstChar = nicknameVal ? [...nicknameVal][0] : '?';

    const textPreview = document.getElementById('textPreview');
    const photoPreview = document.getElementById('photoPreview');
    const photoDeleteBtn = document.getElementById('photoDeleteBtn');
    const accountAv = document.getElementById('accountProfileAvatar');

    if (textPreview) {
        textPreview.style.backgroundImage = '';
        if (type === 'text') {
            textPreview.innerHTML = '';
            textPreview.className =
                'profile-avatar w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-base font-bold text-slate-600 flex-shrink-0';
            textPreview.textContent = firstChar;
        } else {
            textPreview.innerHTML = '<i class="fa-solid fa-user text-slate-500 text-2xl"></i>';
            textPreview.classList.add('flex', 'items-center', 'justify-center');
        }
    }

    if (type === 'photo' && photoPreview) {
        if (photoUrl) {
            photoPreview.style.backgroundImage = `url(${photoUrl})`;
            photoPreview.style.backgroundSize = 'cover';
            photoPreview.style.backgroundPosition = 'center';
            photoPreview.innerHTML = '';
            if (photoDeleteBtn) {
                photoDeleteBtn.classList.toggle('hidden', !appState.isProfileEditing || appState.profileEditScope !== 'full');
            }
        } else {
            photoPreview.innerHTML = '<i class="fa-solid fa-camera text-slate-400 text-xl"></i>';
            photoPreview.style.backgroundImage = '';
            if (photoDeleteBtn) photoDeleteBtn.classList.add('hidden');
        }
    } else if (photoPreview && type === 'text') {
        photoPreview.innerHTML = '<i class="fa-solid fa-camera text-slate-400 text-xl"></i>';
        photoPreview.style.backgroundImage = '';
        if (photoDeleteBtn) photoDeleteBtn.classList.add('hidden');
    }

    if (accountAv) {
        accountAv.style.backgroundImage = '';
        if (type === 'photo' && photoUrl) {
            accountAv.style.backgroundImage = `url(${photoUrl})`;
            accountAv.style.backgroundSize = 'cover';
            accountAv.style.backgroundPosition = 'center';
            accountAv.innerHTML = '';
            accountAv.className =
                'flex h-full w-full items-center justify-center rounded-full bg-slate-100 bg-cover bg-center';
        } else {
            accountAv.innerHTML = '<i class="fa-solid fa-user text-slate-400 text-2xl"></i>';
            accountAv.className =
                'flex h-full w-full items-center justify-center rounded-full bg-slate-100';
        }
        if (photoDeleteBtn && type === 'photo' && photoUrl) {
            photoDeleteBtn.classList.toggle('hidden', !appState.isProfileEditing || appState.profileEditScope !== 'full');
        } else if (photoDeleteBtn) {
            photoDeleteBtn.classList.add('hidden');
        }
    }

    const avatarModal = document.getElementById('accountAvatarModal');
    if (avatarModal && !avatarModal.classList.contains('hidden')) {
        refreshAccountAvatarModalPreview();
    }
}

function formatBirthdateForDisplay(raw) {
    if (!raw || typeof raw !== 'string') return '-';
    const s = raw.trim().replace(/-/g, '');
    if (s.length === 8 && /^\d+$/.test(s)) {
        return `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}`;
    }
    return raw;
}

/**
 * @param {boolean} isEditing
 * @param {'full'|'nickname'|'birthdate'|'bio'|'lifestyle'} [editScope] isEditing이 true일 때만 사용. 연필은 필드별, 아바타·전체는 'full'
 */
function setProfileSettingsEditMode(isEditing, editScope = 'full') {
    const state = appState;
    const demo = window.currentUser && !window.currentUser.isAnonymous && isDemoUser(window.currentUser);
    if (demo) {
        isEditing = false;
    }
    if (!isEditing) {
        unmountNicknameInline();
        unmountBirthdateInline();
        resetAllProfileFieldActionButtons();
        state.profileEditScope = null;
        state.isProfileEditing = false;
    } else {
        if (editScope === 'full') {
            unmountNicknameInline();
            unmountBirthdateInline();
            resetAllProfileFieldActionButtons();
        }
        state.profileEditScope = editScope;
        state.isProfileEditing = true;
    }

    const scope = state.profileEditScope;
    const editing = state.isProfileEditing;
    const showHeaderSaveCancel = !!(editing && scope === 'full');

    const cancelBtn = document.getElementById('cancelProfileSettingsBtn');
    const saveBtn = document.getElementById('saveProfileSettingsBtn');
    if (cancelBtn) cancelBtn.classList.toggle('hidden', !showHeaderSaveCancel);
    if (saveBtn) saveBtn.classList.toggle('hidden', !showHeaderSaveCancel);

    const loggedIn = window.currentUser && !window.currentUser.isAnonymous;
    const showNicknameRow = !!(loggedIn && editing && scope === 'full');
    const showBirthdateRow = !!(loggedIn && editing && scope === 'full');

    const enableNickname = !!(editing && (scope === 'full' || scope === 'nickname'));
    const enableBirthdate = !!(editing && (scope === 'full' || scope === 'birthdate'));
    const enableBio = !!(editing && (scope === 'full' || scope === 'bio'));
    const enableLifestyle = !!(editing && (scope === 'full' || scope === 'lifestyle'));
    const enablePhotoStub = !!(editing && scope === 'full');

    const nicknameInput = document.getElementById('settingNickname');
    const nicknameDisplay = document.getElementById('settingNicknameDisplay');
    if (nicknameDisplay) {
        nicknameDisplay.textContent = (nicknameInput?.value || state.tempSettings?.profile?.nickname || '').trim() || '-';
        nicknameDisplay.classList.toggle('hidden', enableNickname);
    }
    if (nicknameInput) {
        nicknameInput.classList.toggle('hidden', !enableNickname);
        nicknameInput.disabled = !enableNickname;
    }

    const birthdateInput = document.getElementById('settingBirthdate');
    const birthdateDisplay = document.getElementById('settingBirthdateDisplay');
    const birthdateEdit = document.getElementById('settingBirthdateEdit');
    const currentGender = (document.getElementById('settingGender')?.value || state.tempSettings?.profile?.gender || '').trim();
    const genderText = currentGender === 'male' ? '(남)' : currentGender === 'female' ? '(여)' : '';
    if (birthdateDisplay) {
        birthdateDisplay.textContent =
            formatBirthdateForDisplay(birthdateInput?.value || state.tempSettings?.profile?.birthdate || '') +
            (genderText ? ' ' + genderText : '');
        birthdateDisplay.classList.toggle('hidden', enableBirthdate);
    }
    if (birthdateEdit) birthdateEdit.classList.toggle('hidden', !enableBirthdate);
    const birthdateHint = document.getElementById('birthdateHint');
    if (birthdateHint) birthdateHint.classList.toggle('hidden', !enableBirthdate);

    const nicknameRow = document.getElementById('settingNicknameRow');
    if (nicknameRow && loggedIn) {
        nicknameRow.classList.toggle('hidden', !showNicknameRow);
    }
    const birthdateRow = document.getElementById('settingBirthdateRow');
    if (birthdateRow && loggedIn) {
        birthdateRow.classList.toggle('hidden', !showBirthdateRow);
    }

    syncAccountCardDisplayFields();

    const bioInput = document.getElementById('settingBio');
    const lifestyleInput = document.getElementById('settingLifestyle');
    if (bioInput) bioInput.disabled = !enableBio;
    if (birthdateInput) birthdateInput.disabled = !enableBirthdate;
    if (lifestyleInput) lifestyleInput.disabled = !enableLifestyle;

    renderSettingsProfileAvatarPreview();

    const photoSelectBtn = document.getElementById('photoSelectBtn');
    const textSectionPhotoBtn = document.getElementById('textSectionPhotoBtn');
    if (photoSelectBtn) photoSelectBtn.disabled = !enablePhotoStub;
    if (textSectionPhotoBtn) textSectionPhotoBtn.disabled = !enablePhotoStub;

    document.querySelectorAll('.settings-lifestyle-btn').forEach(btn => {
        btn.disabled = !enableLifestyle;
        btn.classList.toggle('opacity-60', !enableLifestyle);
        btn.classList.toggle('cursor-not-allowed', !enableLifestyle);
    });

    document.querySelectorAll('.setting-gender-btn').forEach(btn => {
        btn.disabled = !enableBirthdate;
        btn.classList.toggle('opacity-60', !enableBirthdate);
        btn.classList.toggle('cursor-not-allowed', !enableBirthdate);
    });

    const profileSettingsHeader = document.querySelector('#settingsTabContentProfile .profile-settings-header');
    if (profileSettingsHeader) {
        profileSettingsHeader.classList.toggle('profile-settings-header--active', showHeaderSaveCancel);
    }
}

window.startProfileSettingsEdit = () => {
    if (window.currentUser && !window.currentUser.isAnonymous && isDemoUser(window.currentUser)) {
        return;
    }
    cancelInlineProfileFieldEdit();
    setProfileSettingsEditMode(true, 'full');
};

window.cancelProfileSettingsEdit = () => {
    const state = appState;
    // snapshot으로 원복
    if (state._profileSettingsSnapshot) {
        state.tempSettings = JSON.parse(JSON.stringify(state._profileSettingsSnapshot));
        window.userSettings = JSON.parse(JSON.stringify(state._profileSettingsSnapshot));
    }

    // 편집 중 선택한 사진(미저장) 상태 초기화
    window.settingsPhotoFile = null;
    window.settingsPhotoUrl = null;
    const photoInput = document.getElementById('photoInput');
    if (photoInput) photoInput.value = '';

    // UI 재적용
    const inferredType = state.tempSettings?.profile?.photoUrl ? 'photo' : 'text';
    const profileType = state.tempSettings?.profile?.iconType || inferredType;
    // 이모지 타입이면 text로 변환
    window.settingsProfileType = profileType === 'emoji' ? 'text' : profileType;
    setSettingsProfileType(window.settingsProfileType);

    const nicknameInput = document.getElementById('settingNickname');
    if (nicknameInput) nicknameInput.value = state.tempSettings?.profile?.nickname || '';
    const bioInput = document.getElementById('settingBio');
    if (bioInput) bioInput.value = state.tempSettings?.profile?.bio || '';

    renderSettingsProfileAvatarPreview();

    setProfileSettingsEditMode(false);
};

// 설정 페이지 프로필 타입 설정
export function setSettingsProfileType(type) {
    // 이모지 타입이면 text로 변환
    if (type === 'emoji') {
        type = 'text';
    }
    window.settingsProfileType = type;

    // tempSettings에도 iconType 반영 (취소/저장에 사용)
    if (appState?.tempSettings?.profile) {
        appState.tempSettings.profile.iconType = type;
    }

    const textSection = document.getElementById('textSection');
    const photoSection = document.getElementById('photoSection');
    if (textSection) textSection.classList.toggle('hidden', type !== 'text');
    if (photoSection) photoSection.classList.toggle('hidden', type !== 'photo');

    renderSettingsProfileAvatarPreview();
}

// 전역 노출 (탭 클릭용)
window.setSettingsProfileType = setSettingsProfileType;
window.renderSettingsProfileAvatarPreview = renderSettingsProfileAvatarPreview;
window.syncAccountCardFromProfileFields = syncAccountCardDisplayFields;
window.activateAccountFieldEdit = activateAccountFieldEdit;
window.handleProfileFieldPencilOrSave = handleProfileFieldPencilOrSave;
window.syncSettingsGenderButtonsUI = syncGenderButtonsUIFromHidden;
window.openAccountAvatarModal = openAccountAvatarModal;
window.closeAccountAvatarModal = closeAccountAvatarModal;

// 설정 페이지 사진 업로드 처리 (선택 → 편집 모달 → 저장 시 미리보기 반영)
export async function handlePhotoUpload(event) {
    if (!appState.isProfileEditing || appState.profileEditScope !== 'full') {
        showToast('프로필 사진은 계정 영역에서 사진을 눌러 전체 편집으로 변경할 수 있습니다.', 'info');
        if (event?.target) event.target.value = '';
        return;
    }
    const file = event.target.files[0];
    if (!file) return;
    
    if (!file.type.startsWith('image/')) {
        showToast("이미지 파일만 업로드할 수 있습니다.", "error");
        return;
    }
    
    try {
        const { compressImageToBlob } = await import('../utils.js');
        const compressedBlob = await compressImageToBlob(file);
        const photoUrl = URL.createObjectURL(compressedBlob);
        
        if (window.settingsProfileType !== 'photo') {
            setSettingsProfileType('photo');
        }
        
        // 미리보기 업데이트
        const photoPreview = document.getElementById('photoPreview');
        const photoDeleteBtn = document.getElementById('photoDeleteBtn');
        if (photoPreview) {
            photoPreview.style.backgroundImage = `url(${photoUrl})`;
            photoPreview.style.backgroundSize = 'cover';
            photoPreview.style.backgroundPosition = 'center';
            photoPreview.innerHTML = '';
            if (photoDeleteBtn) {
                photoDeleteBtn.classList.remove('hidden');
            }
        }
        renderSettingsProfileAvatarPreview();

        window.settingsPhotoUrl = photoUrl;
        window.settingsPhotoFile = compressedBlob;

        if (typeof window.openProfilePhotoEdit === 'function') {
            window.openProfilePhotoEdit(photoUrl);
        } else {
            // 편집 기능이 없으면 바로 저장 가능하도록 설정
            appState.tempSettings.profile.photoUrl = photoUrl;
        }
    } catch (e) {
        console.error("사진 업로드 처리 실패:", e);
        showToast("사진 업로드 중 오류가 발생했습니다.", "error");
    }
}

// 사진 삭제 처리
export function handlePhotoDelete() {
    const state = appState;
    if (!state.isProfileEditing || state.profileEditScope !== 'full') {
        showToast('프로필 사진 삭제는 계정 영역에서 사진을 눌러 전체 편집일 때만 가능합니다.', 'info');
        return;
    }
    
    // 사진 관련 변수 초기화
    state.tempSettings.profile.photoUrl = null;
    window.settingsPhotoFile = null;
    window.settingsPhotoUrl = null;
    
    // 텍스트 모드로 전환
    setSettingsProfileType('text');
    
    // 파일 입력 초기화
    const photoInput = document.getElementById('photoInput');
    if (photoInput) photoInput.value = '';

    showToast("사진이 삭제되었습니다.", "success");
}

export async function saveProfileSettings() {
    const state = appState;
    try {
        if (!state.isProfileEditing || state.profileEditScope !== 'full') {
            showToast('프로필 사진 등 전체 저장은 계정 영역에서 사진을 눌러 전체 편집 후 상단 저장을 눌러주세요.', 'info');
            return;
        }
        // 생년월일 / 라이프스타일 (선택사항)
        const newBirthdate = (document.getElementById('settingBirthdate')?.value || '').trim();
        const newLifestyle = (document.getElementById('settingLifestyle')?.value || '').trim();
        const newGenderRaw = (document.getElementById('settingGender')?.value || '').trim();
        const newGender = (newGenderRaw === 'male' || newGenderRaw === 'female') ? newGenderRaw : null;

        const newNickname = (document.getElementById('settingNickname')?.value || '').trim();
        const existingNickname = (window.userSettings?.profile?.nickname || '').trim();
        const nicknameChanged = newNickname !== existingNickname;
        
        if (nicknameChanged) {
            if (!newNickname) {
                showToast("닉네임을 입력해주세요.", "error");
                return;
            }
            if (newNickname.length > 20) {
                showToast("닉네임은 20자 이하로 입력해주세요.", "error");
                return;
            }
            const { containsProfanity, isNicknameDuplicate } = await import('../utils/nickname.js');
            if (containsProfanity(newNickname)) {
                showToast("사용할 수 없는 닉네임입니다. 다른 닉네임을 입력해주세요.", "error");
                return;
            }
            const duplicate = await isNicknameDuplicate(newNickname, window.currentUser?.uid || null);
            if (duplicate) {
                showToast("이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해주세요.", "error");
                return;
            }
        }
        
        state.tempSettings.profile.nickname = newNickname || existingNickname || '게스트';
        state.tempSettings.profile.bio = document.getElementById('settingBio').value.trim() || '';

        // 생년월일 변경 1회 제한 (값이 입력된 경우에만 체크)
        const existingBirthdate = (window.userSettings?.profile?.birthdate || '').trim();
        const existingLifestyle = (window.userSettings?.profile?.lifestyle || '').trim();
        const existingCount = Number(window.userSettings?.profile?.birthdateChangeCount || 0);
        
        // 생년월일: 값이 입력된 경우에만 저장 및 변경 체크 (숫자 8자리도 자동 포맷 후 검증)
        if (newBirthdate) {
            const { formatted: formattedBirthdate, valid } = normalizeBirthdateRaw(newBirthdate);
            if (!valid) {
                showToast("입력한 생년월일이 올바르지 않습니다. 숫자 8자리(예: 19900115)로 입력해주세요.", "error");
                return;
            }
            const isBirthdateChanged = existingBirthdate && formattedBirthdate && existingBirthdate !== formattedBirthdate;
            if (isBirthdateChanged) {
                if (existingCount >= 1) {
                    showToast("생년월일은 가입 후 1회만 변경할 수 있습니다.", "error");
                    return;
                }
                state.tempSettings.profile.birthdateChangeCount = existingCount + 1;
                state.tempSettings.profile.birthdateChangedAt = new Date().toISOString();
            } else {
                // 기존 값 유지 (또는 최초 설정이면 0 유지)
                state.tempSettings.profile.birthdateChangeCount = Number(state.tempSettings.profile.birthdateChangeCount || existingCount || 0);
                state.tempSettings.profile.birthdateChangedAt = state.tempSettings.profile.birthdateChangedAt || window.userSettings?.profile?.birthdateChangedAt || null;
            }
            state.tempSettings.profile.birthdate = formattedBirthdate;
        } else {
            // 값이 없으면 기존 값 유지
            state.tempSettings.profile.birthdate = existingBirthdate || '';
            state.tempSettings.profile.birthdateChangeCount = Number(state.tempSettings.profile.birthdateChangeCount || existingCount || 0);
            state.tempSettings.profile.birthdateChangedAt = state.tempSettings.profile.birthdateChangedAt || window.userSettings?.profile?.birthdateChangedAt || null;
        }
        
        // 라이프스타일: 값이 입력된 경우에만 저장, 없으면 기존 값 유지
        state.tempSettings.profile.lifestyle = newLifestyle || existingLifestyle || '';
        // 성별: 선택 입력, 기가입자 강제 아님
        state.tempSettings.profile.gender = newGender;
        
        // 프로필 완료 플래그: 닉네임이 실제 값이면 완료로 처리
        const finalNickname = (state.tempSettings.profile.nickname || '').trim();
        if (finalNickname && finalNickname !== '게스트') {
            state.tempSettings.profileCompleted = true;
            state.tempSettings.profileCompletedAt = state.tempSettings.profileCompletedAt || new Date().toISOString();
        }
        
        // 아이콘 타입 저장 (text | photo)
        state.tempSettings.profile.iconType = window.settingsProfileType || 'text';

        // 프로필 타입에 따라 photoUrl 저장
        if (window.settingsProfileType === 'photo') {
            // 사진 파일이 있으면 업로드, 없으면 기존 photoUrl 유지
            if (window.settingsPhotoFile) {
                const { storage } = await import('../firebase.js');
                const { ref, uploadBytes, getDownloadURL } = await import("https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js");
                const timestamp = Date.now();
                const fileName = `photo_${timestamp}.jpg`;
                const photoRef = ref(storage, `users/${window.currentUser.uid}/profile/${fileName}`);
                
                await uploadBytes(photoRef, window.settingsPhotoFile);
                const photoUrl = await getDownloadURL(photoRef);
                
                state.tempSettings.profile.photoUrl = photoUrl;
                // 업로드 후 변수 초기화
                window.settingsPhotoFile = null;
                window.settingsPhotoUrl = null;
            }
            // icon은 항상 null (사진 또는 닉네임 첫글자만 사용)
            state.tempSettings.profile.icon = null;
        } else {
            // text: 닉네임 첫 글자 표시 (저장은 nickname만으로 충분)
            state.tempSettings.profile.icon = null;
            state.tempSettings.profile.photoUrl = null;
            state.tempSettings.profile.iconType = 'text';
            window.settingsPhotoFile = null;
            window.settingsPhotoUrl = null;
        }
        
        await dbOps.saveSettings(state.tempSettings);
        showToast("설정이 저장되었습니다.", 'success');
        
        // 헤더 업데이트
        updateHeaderUI();

        // 저장 후 보기 모드로 전환 및 스냅샷 갱신
        state._profileSettingsSnapshot = JSON.parse(JSON.stringify(state.tempSettings));
        setProfileSettingsEditMode(false);
    } catch (e) {
        console.error('프로필 저장 실패:', e);
        showToast("설정 저장 중 오류가 발생했습니다: " + (e.message || e), 'error');
    }
}

// 레거시 함수 (호환성 유지)
export async function saveSettings() {
    await saveProfileSettings();
}

export function selectIcon(i) {
    const state = appState;
    if (!state.isProfileEditing || state.profileEditScope !== 'full') {
        showToast('아이콘 변경은 프로필 전체 편집에서만 가능합니다.', 'info');
        return;
    }
    state.tempSettings.profile.icon = i;
    document.querySelectorAll('.icon-option').forEach(el => el.classList.toggle('selected', el.innerText === i));
    const emojiPreview = document.getElementById('emojiPreview');
    if (emojiPreview) emojiPreview.textContent = i;
}

export function addTag(k, isSub) {
    const state = appState;
    const inputId = `newTag-${isSub ? 'sub-' : ''}${k}`;
    const i = document.getElementById(inputId);
    if (i && i.value.trim()) {
        if (isSub) {
            state.tempSettings.subTags[k].push({ text: i.value.trim(), parent: null });
        } else {
            state.tempSettings.tags[k].push(i.value.trim());
        }
        renderTagManager(k, isSub, state.tempSettings);
        i.value = '';
        requestAnimationFrame(() => {
            document.getElementById(inputId)?.focus();
        });
    }
}

export function removeTag(k, idx, isSub) {
    const state = appState;
    if (!confirm("이 태그를 삭제하시겠습니까?")) return;
    if (isSub) {
        state.tempSettings.subTags[k].splice(idx, 1);
    } else {
        state.tempSettings.tags[k].splice(idx, 1);
    }
    renderTagManager(k, isSub, state.tempSettings);
}

function renderFavoriteTagsEditor() {
    const state = appState;
    const container = document.getElementById('favoriteTagsSection');
    if (!container) return;
    
    // 현재 선택된 메인 태그 추적
    if (!state.selectedFavoriteMainTag) {
        state.selectedFavoriteMainTag = {};
    }
    
    const tagConfigs = {
        mealType: { prefix: '본식: ', label: '어떻게', subTagKey: 'place', mainTags: state.tempSettings.tags?.mealType || [] },
        category: { prefix: '본식: ', label: '무엇을', subTagKey: 'menu', mainTags: state.tempSettings.tags?.category || [] },
        withWhom: { prefix: '본식: ', label: '누구와', subTagKey: 'people', mainTags: state.tempSettings.tags?.withWhom || [] },
        snackType: { prefix: '간식: ', label: '무엇을', subTagKey: 'snack', mainTags: state.tempSettings.tags?.snackType || [] },
        snackPlace: { prefix: '간식: ', label: '어디서', subTagKey: 'place', mainTags: state.tempSettings.tags?.snackPlaceMain || ['집', '사무실', '카페'] }
    };
    
    let html = '';
    Object.entries(tagConfigs).forEach(([sectionId, config]) => {
        const sectionKey = config.sectionKey || sectionId;
        const storageKey = config.storageKey || sectionId;
        const favoritesByMainTag = state.tempSettings.favoriteSubTags[storageKey] || {};
        const selectedMainTag = state.selectedFavoriteMainTag[sectionKey] || null;
        const selectedFavorites = selectedMainTag ? (favoritesByMainTag[selectedMainTag] || []) : [];
        const sectionTitle = (config.prefix || '') + config.label;
        const isSnack = sectionId === 'snackType' || sectionId === 'snackPlace';
        const bandClass = isSnack ? 'settings-tag-section-snack' : 'settings-tag-section-meal';

        html += `<div class="settings-tag-section ${bandClass} py-2 mb-3 px-4">
            <div class="text-xs font-bold text-slate-600 mb-1.5 uppercase">${sectionTitle}</div>
            <div id="favoriteMainTags-${sectionKey}" class="flex flex-wrap gap-1 mb-1.5">
                ${config.mainTags.map(mainTag => {
                    const isSelected = selectedMainTag === mainTag;
                    const favorites = favoritesByMainTag[mainTag] || [];
                    return `<button onclick="window.selectFavoriteMainTag('${sectionKey}', '${mainTag.replace(/'/g, "\\'")}')" 
                        class="chip ${isSelected ? 'active' : ''}">
                        <span class="font-bold">${mainTag}</span> <span class="text-[10px] opacity-70">(${favorites.length}/5)</span>
                    </button>`;
                }).join('')}
            </div>
            <div class="flex gap-1 mb-1.5">
                <input type="text" id="newFavoriteTag-${sectionKey}-${selectedMainTag || 'none'}" class="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs outline-none focus:border-slate-400" placeholder="태그 입력" onkeypress="if(event.key==='Enter' && window.selectedFavoriteMainTag && window.selectedFavoriteMainTag['${sectionKey}']) window.addFavoriteTag('${storageKey}', window.selectedFavoriteMainTag['${sectionKey}'])">
                <button ontouchstart="event.preventDefault()" ontouchend="event.preventDefault(); if(window.selectedFavoriteMainTag && window.selectedFavoriteMainTag['${sectionKey}']) window.addFavoriteTag('${storageKey}', window.selectedFavoriteMainTag['${sectionKey}'])" onclick="if(window.selectedFavoriteMainTag && window.selectedFavoriteMainTag['${sectionKey}']) window.addFavoriteTag('${storageKey}', window.selectedFavoriteMainTag['${sectionKey}'])" class="bg-slate-800 text-white px-4 py-1.5 rounded-lg text-xs font-bold ${selectedMainTag ? '' : 'opacity-50 cursor-not-allowed'}" ${selectedMainTag ? '' : 'disabled'}>추가</button>
            </div>
            ${selectedMainTag ? `
                ${selectedFavorites.length >= 5 ? '<div class="text-[10px] text-slate-500 mb-1.5">최대 5개까지 입력 가능합니다</div>' : ''}
                <div class="mt-1.5">
                    <div class="text-[10px] text-slate-400 mb-1">나만의 태그 (최대 5개)</div>
                    <div class="flex flex-wrap gap-1" id="favoriteTags-${sectionKey}-${selectedMainTag}">
                        ${selectedFavorites.map((text, idx) => `
                            <div class="flex items-center gap-0.5 px-2.5 py-1 bg-emerald-600 text-white rounded text-xs font-bold">
                                <span>${text}</span>
                                <button onclick="window.removeFavoriteTag('${storageKey}', '${selectedMainTag.replace(/'/g, "\\'")}', ${idx})" class="ml-1 hover:bg-emerald-700 rounded-full w-4 h-4 flex items-center justify-center transition-colors">
                                    <i class="fa-solid fa-xmark text-[8px]"></i>
                                </button>
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : '<div class="text-[10px] text-slate-400 mt-1.5">메인 태그를 선택하세요</div>'}
        </div>`;
    });
    
    container.innerHTML = html;
}

export function selectFavoriteMainTag(mainTagKey, mainTag) {
    const state = appState;
    if (!state.selectedFavoriteMainTag) {
        state.selectedFavoriteMainTag = {};
    }
    
    // 같은 태그를 다시 클릭하면 선택 해제, 다른 태그를 클릭하면 선택 변경
    if (state.selectedFavoriteMainTag[mainTagKey] === mainTag) {
        state.selectedFavoriteMainTag[mainTagKey] = null;
    } else {
        state.selectedFavoriteMainTag[mainTagKey] = mainTag;
    }
    
    // 전역 변수로도 저장 (입력창에서 접근 가능하도록)
    if (!window.selectedFavoriteMainTag) {
        window.selectedFavoriteMainTag = {};
    }
    window.selectedFavoriteMainTag[mainTagKey] = state.selectedFavoriteMainTag[mainTagKey];
    
    renderFavoriteTagsEditor();
}

export async function addFavoriteTag(mainTagKey, mainTag) {
    const state = appState;
    if (!state.tempSettings.favoriteSubTags) {
        state.tempSettings.favoriteSubTags = {
            mealType: {},
            category: {},
            withWhom: {},
            snackType: {}
        };
    }
    
    if (!state.tempSettings.favoriteSubTags[mainTagKey]) {
        state.tempSettings.favoriteSubTags[mainTagKey] = {};
    }
    
    // 메인 태그가 선택되지 않았으면 입력 불가
    if (!mainTag || mainTag === 'none') {
        showToast("메인 태그를 먼저 선택해주세요.", 'info');
        return;
    }
    
    const input = document.getElementById(`newFavoriteTag-${mainTagKey}-${mainTag}`);
    if (!input) return;
    
    const text = input.value.trim();
    if (!text) {
        showToast("태그를 입력해주세요.", 'info');
        return;
    }
    
    if (!state.tempSettings.favoriteSubTags[mainTagKey][mainTag]) {
        state.tempSettings.favoriteSubTags[mainTagKey][mainTag] = [];
    }
    
    const favorites = state.tempSettings.favoriteSubTags[mainTagKey][mainTag];
    
    if (favorites.includes(text)) {
        showToast("이미 추가된 태그입니다.", 'info');
        input.value = '';
        return;
    }
    
    if (favorites.length >= 5) {
        showToast("나만의 태그는 최대 5개까지 입력할 수 있습니다.", 'info');
        return;
    }
    
    favorites.push(text);
    input.value = '';
    renderFavoriteTagsEditor();
    requestAnimationFrame(() => {
        document.getElementById(`newFavoriteTag-${mainTagKey}-${mainTag}`)?.focus();
    });
    
    // 즉시 저장 후 화면(기록 모달 등)에서 쓰는 userSettings에도 반영
    try {
        await dbOps.saveSettings(state.tempSettings);
        if (!window.userSettings) window.userSettings = {};
        window.userSettings.favoriteSubTags = JSON.parse(JSON.stringify(state.tempSettings.favoriteSubTags || {}));
        showToast("태그가 저장되었습니다.", 'success');
    } catch (e) {
        console.error('태그 저장 실패:', e);
        // dbOps.saveSettings에서 이미 에러 토스트를 표시하므로 여기서는 추가 처리 불필요
    }
}

export async function removeFavoriteTag(mainTagKey, mainTag, index) {
    const state = appState;
    if (!state.tempSettings.favoriteSubTags || !state.tempSettings.favoriteSubTags[mainTagKey]) return;
    
    if (!state.tempSettings.favoriteSubTags[mainTagKey][mainTag]) {
        state.tempSettings.favoriteSubTags[mainTagKey][mainTag] = [];
    }
    
    const favorites = state.tempSettings.favoriteSubTags[mainTagKey][mainTag];
    if (index >= 0 && index < favorites.length) {
        favorites.splice(index, 1);
        renderFavoriteTagsEditor();
        
        // 즉시 저장 후 화면(기록 모달 등)에서 쓰는 userSettings에도 반영
        try {
            await dbOps.saveSettings(state.tempSettings);
            if (!window.userSettings) window.userSettings = {};
            window.userSettings.favoriteSubTags = JSON.parse(JSON.stringify(state.tempSettings.favoriteSubTags || {}));
            showToast("태그가 삭제되었습니다.", 'success');
        } catch (e) {
            console.error('태그 삭제 저장 실패:', e);
            // dbOps.saveSettings에서 이미 에러 토스트를 표시하므로 여기서는 추가 처리 불필요
        }
    }
}

const PUSH_PREF_FIELD_IDS = {
    master: 'pushPrefMaster',
    momentComment: 'pushPrefMomentComment',
    boardComment: 'pushPrefBoardComment',
    mealTalk: 'pushPrefMealTalk',
    adminDefault: 'pushPrefAdminDefault'
};

function updatePushPrefSubRowsUi(masterOn, demo) {
    document.querySelectorAll('.push-pref-sub-row').forEach((row) => {
        const lock = !masterOn || demo;
        row.classList.toggle('opacity-45', !masterOn);
        row.classList.toggle('pointer-events-none', lock);
    });
    ['pushPrefMomentComment', 'pushPrefBoardComment', 'pushPrefMealTalk', 'pushPrefAdminDefault'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = !masterOn || !!demo;
    });
}

/** 설정 문서의 pushPreferences → 폼 반영 (설정 리스너 갱신 시 호출) */
export function syncPushPreferencesFormFromUserSettings() {
    const base = DEFAULT_USER_SETTINGS.pushPreferences || {};
    const pp = { ...base, ...(window.userSettings?.pushPreferences || {}) };
    const demo = window.currentUser && !window.currentUser.isAnonymous && isDemoUser(window.currentUser);
    Object.keys(PUSH_PREF_FIELD_IDS).forEach((key) => {
        const el = document.getElementById(PUSH_PREF_FIELD_IDS[key]);
        if (!el) return;
        el.checked = pp[key] !== false;
    });
    const masterEl = document.getElementById('pushPrefMaster');
    if (masterEl) masterEl.disabled = !!demo;
    updatePushPrefSubRowsUi(pp.master !== false, !!demo);
}

let pushPreferencesControlsBound = false;

/** 푸시 설정 토글 → Firestore 저장 (앱 내 알림과 무관) */
export function initPushPreferencesControlsOnce() {
    if (pushPreferencesControlsBound) return;
    const master = document.getElementById('pushPrefMaster');
    if (!master) return;
    pushPreferencesControlsBound = true;

    const readFormPrefs = () => {
        const o = {};
        Object.keys(PUSH_PREF_FIELD_IDS).forEach((key) => {
            const el = document.getElementById(PUSH_PREF_FIELD_IDS[key]);
            o[key] = !!(el && el.checked);
        });
        return o;
    };

    const persist = async (partial) => {
        if (!window.currentUser || window.currentUser.isAnonymous) return;
        if (isDemoUser(window.currentUser)) {
            syncPushPreferencesFormFromUserSettings();
            return;
        }
        const cur = {
            ...(DEFAULT_USER_SETTINGS.pushPreferences || {}),
            ...(window.userSettings?.pushPreferences || {}),
            ...partial
        };
        try {
            await dbOps.saveSettings({ pushPreferences: cur });
        } catch (_) {
            syncPushPreferencesFormFromUserSettings();
        }
    };

    master.addEventListener('change', () => {
        const on = master.checked;
        updatePushPrefSubRowsUi(on, isDemoUser(window.currentUser));
        void persist({ master: on });
    });

    ['momentComment', 'boardComment', 'mealTalk', 'adminDefault'].forEach((key) => {
        document.getElementById(PUSH_PREF_FIELD_IDS[key])?.addEventListener('change', (e) => {
            void persist({ [key]: e.target.checked });
        });
    });
}

export async function deleteSubTag(key, text, containerId, inputId, parentFilter) {
    const newSettings = JSON.parse(JSON.stringify(window.userSettings));
    if (newSettings.subTags && newSettings.subTags[key]) {
        const idx = newSettings.subTags[key].findIndex(t => (typeof t === 'string' ? t : t.text) === text);
        if (idx > -1) {
            newSettings.subTags[key].splice(idx, 1);
            window.userSettings = newSettings;
            try {
                await dbOps.saveSettings(newSettings);
                showToast("태그가 삭제되었습니다.", 'success');
                if (containerId) {
                    const realParentFilter = (parentFilter === 'null' || !parentFilter) ? null : parentFilter;
                    window.renderSecondary(containerId, newSettings.subTags[key], inputId, realParentFilter, key);
                }
            } catch (e) {
                console.error(e);
                showToast("삭제 실패", 'error');
            }
        }
    }
}

// 카카오 장소 검색 함수 (백엔드 프록시 사용 - SDK 불필요)
// mode: 'meal' | 'snack' - 식사 어디서 vs 간식 어디서
