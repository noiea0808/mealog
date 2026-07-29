// Google Play 인앱 업데이트 (Android 네이티브 전용)
// @capawesome/capacitor-app-update 를 사용해 앱 기동/재개 시 새 버전을 감지하고,
// - 중요 업데이트(updatePriority 높음): Immediate(전체 화면 강제) 업데이트
// - 일반 업데이트: Flexible(백그라운드 다운로드 후 "재시작" 안내) 업데이트
// 를 수행한다. 사이드로드(스토어 미경유) 설치에서는 조용히 무시한다.

// @capawesome/capacitor-app-update 의 enum 값 (dist/plugin.js 기준 고정값)
const UPDATE_AVAILABILITY = {
    UNKNOWN: 0,
    UPDATE_NOT_AVAILABLE: 1,
    UPDATE_AVAILABLE: 2,
    UPDATE_IN_PROGRESS: 3,
};
const FLEXIBLE_INSTALL_STATUS = {
    DOWNLOADED: 11,
};

// updatePriority(0~5, Play Console에서 릴리스별 지정)가 이 값 이상이면 강제(Immediate) 업데이트.
// 미지정 시 0이므로 기본은 Flexible(선택) 업데이트로 동작한다.
const IMMEDIATE_PRIORITY_THRESHOLD = 4;

let checkInFlight = false;
let flexibleUpdateStarted = false;
let resumeListenerBound = false;

function isAndroidNative() {
    const cap = typeof window !== 'undefined' ? window.Capacitor : undefined;
    return !!(cap && cap.isNativePlatform?.() && cap.getPlatform?.() === 'android');
}

function getPlugin() {
    return window.Capacitor?.Plugins?.AppUpdate || null;
}

// 다운로드 완료 후 "재시작하여 설치" 배너 (Flexible 업데이트 전용)
function showFlexibleRestartBanner(onRestart) {
    if (document.getElementById('appUpdateRestartBanner')) return;

    const banner = document.createElement('div');
    banner.id = 'appUpdateRestartBanner';
    banner.className = 'mealog-update-banner';
    banner.setAttribute('role', 'status');
    banner.style.cssText = [
        'position:fixed',
        'z-index:99999',
        'box-sizing:border-box',
        'line-height:1.4',
    ].join(';');

    const text = document.createElement('span');
    text.style.cssText = 'flex:1;font-weight:600;min-width:0;';
    text.innerHTML = '<strong style="display:block;font-size:13px;margin-bottom:2px;">업데이트가 준비됐어요</strong><span style="font-size:12px;font-weight:500;color:#7a7268;">재시작하면 새 버전이 적용됩니다</span>';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '재시작';
    btn.style.cssText = [
        'flex:none',
        'border:none',
        'cursor:pointer',
        'font-family:inherit',
    ].join(';');
    btn.addEventListener('click', () => {
        btn.disabled = true;
        btn.textContent = '설치 중…';
        onRestart();
    });

    banner.appendChild(text);
    banner.appendChild(btn);
    document.body.appendChild(banner);
}

// ───────────────────────────────────────────────────────────────────────────
// 아래는 스테이징/개발 환경에서 UX 흐름을 미리 보기 위한 "모의(시뮬레이션)" UI다.
// 실제 운영에서는 이 초기 확인 팝업과 다운로드 진행은 Google Play 시스템 UI가 대신
// 띄우므로, 우리 코드에는 존재하지 않는다(재시작 배너만 실제 코드).
// ───────────────────────────────────────────────────────────────────────────

function removeSimNode(id) {
    const el = document.getElementById(id);
    if (el?.parentNode) el.parentNode.removeChild(el);
}

// "업데이트가 있습니다 — 지금 설치할까요?" 모의 확인 팝업 (실제로는 Google Play가 띄움)
function showSimulatedUpdateConfirm({ version, onAccept, onDismiss }) {
    removeSimNode('appUpdateSimConfirm');

    const overlay = document.createElement('div');
    overlay.id = 'appUpdateSimConfirm';
    overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:99998',
        'display:flex', 'align-items:center', 'justify-content:center',
        'padding:24px', 'background:rgba(0,0,0,0.45)',
    ].join(';');

    const card = document.createElement('div');
    card.style.cssText = [
        'width:min(360px, 100%)', 'box-sizing:border-box',
        'background:#fff', 'border-radius:18px', 'padding:22px 20px 16px',
        'box-shadow:0 16px 40px rgba(0,0,0,0.3)', 'text-align:center',
        'font-size:14px', 'color:#111827',
    ].join(';');

    const title = document.createElement('div');
    title.style.cssText = 'font-size:17px;font-weight:800;margin-bottom:8px;';
    title.textContent = '업데이트가 있습니다';

    const desc = document.createElement('div');
    desc.style.cssText = 'color:#4b5563;line-height:1.5;margin-bottom:18px;';
    desc.textContent = `새 버전(${version})으로 업데이트할 수 있어요. 지금 설치할까요?`;

    const simBadge = document.createElement('div');
    simBadge.style.cssText = 'color:#f59e0b;font-size:11px;font-weight:700;margin-bottom:14px;';
    simBadge.textContent = '※ 스테이징 시뮬레이션 (실제로는 Google Play 팝업)';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;';

    const later = document.createElement('button');
    later.type = 'button';
    later.textContent = '나중에';
    later.style.cssText = [
        'flex:1', 'padding:12px', 'border:none', 'border-radius:12px',
        'background:#f1f5f9', 'color:#475569', 'font-weight:700', 'font-size:14px', 'cursor:pointer',
    ].join(';');
    later.addEventListener('click', () => {
        removeSimNode('appUpdateSimConfirm');
        onDismiss?.();
    });

    const install = document.createElement('button');
    install.type = 'button';
    install.textContent = '지금 설치';
    install.style.cssText = [
        'flex:1', 'padding:12px', 'border:none', 'border-radius:12px',
        'background:#3cb889', 'color:#fff', 'font-weight:800', 'font-size:14px', 'cursor:pointer',
    ].join(';');
    install.addEventListener('click', () => {
        removeSimNode('appUpdateSimConfirm');
        onAccept?.();
    });

    row.appendChild(later);
    row.appendChild(install);
    card.appendChild(title);
    card.appendChild(desc);
    card.appendChild(simBadge);
    card.appendChild(row);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
}

// 다운로드 진행 표시(모의) → 완료되면 onDone 호출
function showSimulatedDownloadProgress(onDone) {
    removeSimNode('appUpdateSimProgress');

    const bar = document.createElement('div');
    bar.id = 'appUpdateSimProgress';
    bar.setAttribute('role', 'status');
    bar.style.cssText = [
        'position:fixed', 'left:50%', 'transform:translateX(-50%)',
        'bottom:calc(env(safe-area-inset-bottom, 0px) + 84px)', 'z-index:99999',
        'width:min(420px, calc(100vw - 24px))', 'box-sizing:border-box',
        'padding:14px 16px', 'border-radius:14px', 'background:#1f2937', 'color:#fff',
        'box-shadow:0 8px 24px rgba(0,0,0,0.28)', 'font-size:14px',
    ].join(';');

    const label = document.createElement('div');
    label.style.cssText = 'font-weight:600;margin-bottom:8px;';
    label.textContent = '업데이트 다운로드 중… 0%';

    const track = document.createElement('div');
    track.style.cssText = 'height:6px;border-radius:3px;background:rgba(255,255,255,0.2);overflow:hidden;';
    const fill = document.createElement('div');
    fill.style.cssText = 'height:100%;width:0%;background:#3cb889;transition:width 0.2s ease;';
    track.appendChild(fill);

    bar.appendChild(label);
    bar.appendChild(track);
    document.body.appendChild(bar);

    let pct = 0;
    const timer = setInterval(() => {
        pct = Math.min(100, pct + Math.round(8 + Math.random() * 16));
        fill.style.width = pct + '%';
        label.textContent = `업데이트 다운로드 중… ${pct}%`;
        if (pct >= 100) {
            clearInterval(timer);
            setTimeout(() => {
                removeSimNode('appUpdateSimProgress');
                onDone?.();
            }, 400);
        }
    }, 350);
}

async function startFlexibleUpdate(plugin) {
    if (flexibleUpdateStarted) return;
    flexibleUpdateStarted = true;
    try {
        // 다운로드 완료 시점을 받기 위한 리스너 먼저 등록
        await plugin.addListener('onFlexibleUpdateStateChange', (state) => {
            try {
                if (state?.installStatus === FLEXIBLE_INSTALL_STATUS.DOWNLOADED) {
                    showFlexibleRestartBanner(() => {
                        plugin.completeFlexibleUpdate().catch((e) => {
                            console.debug('[app-update] completeFlexibleUpdate 실패:', e);
                        });
                    });
                }
            } catch (e) {
                console.debug('[app-update] flexible state 처리 실패:', e);
            }
        });
        await plugin.startFlexibleUpdate();
    } catch (e) {
        // 사용자가 취소(CANCELED)했거나 기타 사유 → 다음 기동 때 다시 시도
        flexibleUpdateStarted = false;
        console.debug('[app-update] startFlexibleUpdate 중단:', e);
    }
}

/**
 * 앱 업데이트 확인 및 실행. Android 네이티브에서만 동작.
 * @param {{ source?: string }} [opts]
 */
export async function checkForAppUpdate(opts = {}) {
    if (!isAndroidNative()) return;
    const plugin = getPlugin();
    if (!plugin) return;
    if (checkInFlight) return;
    checkInFlight = true;

    try {
        const info = await plugin.getAppUpdateInfo();

        // 이미 Immediate 업데이트가 진행 중이면(앱이 중간에 종료됐다 재기동된 경우) 이어서 진행
        if (info.updateAvailability === UPDATE_AVAILABILITY.UPDATE_IN_PROGRESS) {
            if (info.immediateUpdateAllowed) {
                await plugin.performImmediateUpdate().catch((e) => {
                    console.debug('[app-update] 진행 중 immediate 재개 실패:', e);
                });
            }
            return;
        }

        if (info.updateAvailability !== UPDATE_AVAILABILITY.UPDATE_AVAILABLE) {
            return;
        }

        const priority = typeof info.updatePriority === 'number' ? info.updatePriority : 0;
        const wantImmediate = priority >= IMMEDIATE_PRIORITY_THRESHOLD;

        if (wantImmediate && info.immediateUpdateAllowed) {
            await plugin.performImmediateUpdate().catch((e) => {
                console.debug('[app-update] performImmediateUpdate 중단:', e);
            });
            return;
        }

        if (info.flexibleUpdateAllowed) {
            await startFlexibleUpdate(plugin);
            return;
        }

        // Flexible 불가하지만 Immediate 가능하면 강제 업데이트로 폴백
        if (info.immediateUpdateAllowed) {
            await plugin.performImmediateUpdate().catch((e) => {
                console.debug('[app-update] immediate 폴백 중단:', e);
            });
        }
    } catch (e) {
        // 스토어 미경유 설치(사이드로드) 등에서는 에러가 정상 — 조용히 무시
        console.debug('[app-update] getAppUpdateInfo 실패(무시):', e);
    } finally {
        checkInFlight = false;
    }
}

// 앱 재개(resume) 시 진행 중이던 Immediate 업데이트 이어가기
function bindResumeListener() {
    if (resumeListenerBound) return;
    const appPlugin = window.Capacitor?.Plugins?.App;
    if (!appPlugin?.addListener) return;
    resumeListenerBound = true;
    try {
        appPlugin.addListener('resume', () => {
            checkForAppUpdate({ source: 'resume' }).catch(() => {});
        });
    } catch (e) {
        console.debug('[app-update] resume 리스너 등록 실패:', e);
    }
}

/**
 * 앱 기동 시 한 번 호출. (Android 네이티브에서만 실제 동작)
 */
export function initAppUpdate() {
    if (!isAndroidNative()) return;
    bindResumeListener();
    // 스플래시/초기 렌더 직후로 약간 지연
    setTimeout(() => {
        checkForAppUpdate({ source: 'launch' }).catch(() => {});
    }, 2500);
}

// 수동 테스트/디버깅용
if (typeof window !== 'undefined') {
    window.mealogCheckAppUpdate = () => checkForAppUpdate({ source: 'manual' });

    // 스테이징/사이드로드처럼 Play 스토어를 못 거치는 환경에서 UI만 검증하기 위한 시뮬레이션.
    // 실제 다운로드 없이 "다운로드 완료" 배너만 띄운다. (콘솔에서 window.mealogSimulateUpdateBanner() 호출)
    window.mealogSimulateUpdateBanner = () => {
        showFlexibleRestartBanner(() => {
            console.log('[app-update] (시뮬레이션) 재시작 버튼 클릭됨 — 실제 환경에서는 여기서 completeFlexibleUpdate() 실행');
            removeSimNode('appUpdateRestartBanner');
        });
        return '재시작 배너를 표시했습니다. (시뮬레이션)';
    };

    // 전체 흐름 시뮬레이션: "업데이트 있습니다" 확인 팝업 → 다운로드 진행 → 재시작 배너.
    // 실제 운영에서 초기 팝업/다운로드는 Google Play가 대신 띄운다.
    window.mealogSimulateUpdateFlow = (version = '1.0.34') => {
        showSimulatedUpdateConfirm({
            version,
            onAccept: () => {
                showSimulatedDownloadProgress(() => {
                    showFlexibleRestartBanner(() => {
                        console.log('[app-update] (시뮬레이션) 재시작 → 실제로는 completeFlexibleUpdate()');
                        removeSimNode('appUpdateRestartBanner');
                    });
                });
            },
            onDismiss: () => {
                console.log('[app-update] (시뮬레이션) 사용자가 "나중에" 선택');
            },
        });
        return '업데이트 안내 → 다운로드 → 재시작 전체 흐름을 시뮬레이션합니다.';
    };

    // 현재 환경에서 인앱 업데이트가 실제로 동작 가능한지 진단
    window.mealogAppUpdateDiagnose = async () => {
        const result = { isAndroidNative: isAndroidNative(), hasPlugin: !!getPlugin() };
        if (result.hasPlugin) {
            try {
                result.info = await getPlugin().getAppUpdateInfo();
            } catch (e) {
                result.error = String(e?.message || e);
                result.hint = '스토어 미경유(사이드로드) 설치일 가능성이 큽니다. 인앱 업데이트는 Play 스토어 설치본에서만 동작합니다.';
            }
        }
        console.log('[app-update] 진단:', result);
        return result;
    };
}
