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
    banner.setAttribute('role', 'status');
    banner.style.cssText = [
        'position:fixed',
        'left:50%',
        'transform:translateX(-50%)',
        'bottom:calc(env(safe-area-inset-bottom, 0px) + 84px)',
        'z-index:99999',
        'width:min(420px, calc(100vw - 24px))',
        'box-sizing:border-box',
        'display:flex',
        'align-items:center',
        'gap:12px',
        'padding:14px 16px',
        'border-radius:14px',
        'background:#1f2937',
        'color:#fff',
        'box-shadow:0 8px 24px rgba(0,0,0,0.28)',
        'font-size:14px',
        'line-height:1.4',
    ].join(';');

    const text = document.createElement('span');
    text.style.cssText = 'flex:1;font-weight:500;';
    text.textContent = '업데이트 다운로드가 완료되었습니다.';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '재시작';
    btn.style.cssText = [
        'flex:none',
        'padding:8px 14px',
        'border:none',
        'border-radius:10px',
        'background:#10b981',
        'color:#fff',
        'font-weight:700',
        'font-size:14px',
        'cursor:pointer',
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
            const banner = document.getElementById('appUpdateRestartBanner');
            if (banner?.parentNode) banner.parentNode.removeChild(banner);
        });
        return '재시작 배너를 표시했습니다. (시뮬레이션)';
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
