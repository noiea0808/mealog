/**
 * 푸시 알림: Capacitor 네이티브에서 FCM 토큰 등록 및 Firestore 저장
 * - 로그인 사용자만 등록
 * - artifacts/{appId}/users/{uid}/config/fcmTokens 문서에 토큰 저장 (다중 기기 지원)
 */
import { db, appId } from './firebase.js';
import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';
import { serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

const FCM_TOKENS_DOC = 'fcmTokens';
if (typeof window !== 'undefined') {
  window.__pushModuleVersion = '2024-03-17';
  console.log('푸시 모듈 로드:', window.__pushModuleVersion);
}

function isNative() {
  return typeof window.Capacitor !== 'undefined' && window.Capacitor?.isNativePlatform?.();
}

function isAndroid() {
  return typeof window.Capacitor !== 'undefined' && window.Capacitor.getPlatform?.() === 'android';
}

// Android: Capacitor 브리지가 PushNotifications 반환값에 .then() 호출 시 "is not implemented" 발생 → 거부 무시
if (typeof window !== 'undefined') {
  const prevHandler = window.onunhandledrejection;
  window.addEventListener('unhandledrejection', (event) => {
    const msg = event?.reason?.message ?? '';
    if (typeof msg === 'string' && msg.includes('PushNotifications') && msg.includes('is not implemented')) {
      event.preventDefault();
      event.stopPropagation();
      console.warn('푸시: Android 브리지 경고 무시 (토큰은 리스너로 수신):', msg);
      return true;
    }
    if (prevHandler) prevHandler.call(window, event);
  });
}

let pushListenersRegistered = false;

/** 디버그용: 콘솔 없이 상태 확인 가능. chrome://inspect 콘솔에서 getPushDebugInfo() 호출 */
function setPushDebug(update) {
  window.__pushDebug = { ...(window.__pushDebug || {}), ...update };
}
window.getPushDebugInfo = function getPushDebugInfo() {
  const d = window.__pushDebug || {};
  return {
    inited: d.inited ?? false,
    permission: d.permission ?? null,
    tokenSaved: d.tokenSaved ?? false,
    lastError: d.lastError ?? null
  };
};

/**
 * FCM 토큰을 Firestore에 저장 (merge: 기존 토큰에 추가)
 */
async function saveFcmToken(uid, token) {
  if (!uid || !token || typeof token !== 'string') return;
  const ref = doc(db, 'artifacts', appId, 'users', uid, 'config', FCM_TOKENS_DOC);
  try {
    const snap = await getDoc(ref);
    const prev = (snap.data() && snap.data().tokens) || {};
    await setDoc(ref, {
      tokens: {
        ...prev,
        [token]: { updatedAt: serverTimestamp() }
      }
    }, { merge: true });
    setPushDebug({ tokenSaved: true, lastError: null });
    console.log('✅ FCM 토큰 저장 완료');
    if (typeof window.__onPushTokenSaved === 'function') window.__onPushTokenSaved();
  } catch (e) {
    const msg = e?.message || String(e);
    setPushDebug({ tokenSaved: false, lastError: msg });
    console.warn('⚠️ FCM 토큰 저장 실패:', msg);
    if (typeof window.__onPushTokenSavedError === 'function') window.__onPushTokenSavedError(msg);
  }
}

/** 네이티브에서 PushNotifications 플러그인 가져오기 (스크립트 로드 우선, 없으면 동적 import) */
async function getPushNotificationsPlugin() {
  const hasFromScript = typeof window.Capacitor !== 'undefined' && window.Capacitor?.Plugins?.PushNotifications;
  if (hasFromScript) {
    console.log('푸시: 플러그인 사용 (스크립트 등록)');
    return window.Capacitor.Plugins.PushNotifications;
  }
  console.log('푸시: 스크립트에 플러그인 없음, 동적 import 시도');
  const importWithTimeout = Promise.race([
    import('@capacitor/push-notifications').then((mod) => mod.PushNotifications),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('PLUGIN_IMPORT_TIMEOUT')), 5000)
    )
  ]);
  try {
    const PN = await importWithTimeout;
    console.log('푸시: 동적 import 완료');
    return PN;
  } catch (e) {
    const msg = e?.message || String(e);
    if (msg === 'PLUGIN_IMPORT_TIMEOUT') {
      console.warn('푸시: 플러그인 로드 5초 초과 (동적 import). 스크립트 경로 확인 필요.');
    } else {
      console.warn('푸시: 동적 import 실패:', msg);
    }
    return null;
  }
}

/**
 * 푸시 알림 초기화: 네이티브에서만 실행, 권한 요청 후 토큰 등록 및 저장
 * @param {string} uid - 로그인한 사용자 uid
 */
const PUSH_INIT_VERSION = '2024-03-17';
export async function initPushNotifications(uid) {
  console.log('푸시: init 버전', PUSH_INIT_VERSION);
  setPushDebug({ inited: false, permission: null, tokenSaved: false, lastError: null });
  if (!uid || !isNative()) {
    if (!uid) {
      console.log('푸시: uid 없음, 스킵');
      setPushDebug({ lastError: 'uid 없음' });
    } else {
      console.log('푸시: 네이티브가 아님(웹/에뮬), 스킵');
      setPushDebug({ lastError: '네이티브 아님' });
    }
    return;
  }

  try {
    console.log('푸시: 초기화 시작');
    const PN = await getPushNotificationsPlugin();
    if (!PN) {
      console.warn('푸시: PushNotifications 플러그인을 불러올 수 없음');
      setPushDebug({ lastError: '플러그인 로드 실패' });
      return;
    }
    console.log('푸시: 플러그인 로드됨, 다음 틱에 리스너·등록 실행');

    // Android 브리지 .then() 오류: addListener/register를 서로 다른 틱으로 분리해 register()는 반드시 호출되게 함
    setTimeout(() => {
      console.log('푸시: [A] 리스너 등록 시작');
      if (!pushListenersRegistered) {
        pushListenersRegistered = true;
        try {
          PN.addListener('registration', async (ev) => {
            const token = ev.value ?? ev.token ?? ev.data?.token;
            console.log('푸시: registration 이벤트 수신', { token: token ? `${token.slice(0, 20)}...` : null, hasUser: !!window.currentUser, isAnonymous: window.currentUser?.isAnonymous });
            if (!token) {
              setPushDebug({ lastError: '토큰 없음' });
              return;
            }
            if (!window.currentUser || window.currentUser.isAnonymous) {
              setPushDebug({ lastError: window.currentUser?.isAnonymous ? '익명 사용자' : 'currentUser 없음' });
              return;
            }
            await saveFcmToken(window.currentUser.uid, token);
          });
          PN.addListener('registrationError', (ev) => {
            const err = ev.error?.message || ev.error;
            console.warn('푸시 등록 오류:', err);
            setPushDebug({ lastError: '등록 오류: ' + err });
          });
          PN.addListener('pushNotificationReceived', (ev) => {
            console.log('푸시 수신 (포그라운드):', ev.notification);
          });
          PN.addListener('pushNotificationActionPerformed', (ev) => {
            console.log('푸시 탭 (알림 클릭):', ev.notification, ev.actionId);
            const data = ev.notification?.data;
            if (data && typeof window.navigateToNotificationPost === 'function' && data.postId) {
              if (data.type === 'boardComment' && typeof window.openBoardDetail === 'function') {
                window.switchMainTab?.('board');
                window.openBoardDetail(data.postId);
              } else {
                window.navigateToNotificationPost(data.postId);
              }
            }
          });
          console.log('푸시: [A] 리스너 등록 완료');
        } catch (listenerErr) {
          console.warn('푸시: [A] 리스너 예외 (계속 진행):', listenerErr?.message || listenerErr);
        }
      }
    }, 0);

    setTimeout(() => {
      console.log('푸시: [B] 플랫폼·register 블록');
      try {
        const platform = window.Capacitor?.getPlatform?.();
        const android = isAndroid();
        console.log('푸시: 플랫폼=', platform, 'Android=', android);
        if (android) {
          setPushDebug({ inited: true });
          const doRegister = () => {
            console.log('푸시: Android — FCM register() 호출');
            try {
              PN.register();
            } catch (regErr) {
              console.warn('푸시 register() 예외:', regErr?.message || regErr);
            }
          };
          PN.requestPermissions()
            .then((perm) => {
              const receive = perm?.receive ?? perm?.value ?? perm;
              setPushDebug({ permission: receive });
              if (receive === 'granted' || receive === 'yes') {
                doRegister();
              } else {
                console.warn('푸시: Android 알림 권한 —', receive);
                doRegister();
              }
            })
            .catch(() => {
              setPushDebug({ permission: null });
              doRegister();
            });
          return;
        }
        console.log('푸시: 알림 권한 요청 중...');
        PN.requestPermissions().then((perm) => {
          setPushDebug({ permission: perm?.receive });
          if (perm?.receive !== 'granted') {
            console.log('푸시 알림 권한이 허용되지 않음:', perm?.receive);
            setPushDebug({ lastError: '권한 거부: ' + (perm?.receive || 'unknown') });
            return;
          }
          console.log('푸시: 권한 허용됨, FCM 등록 중...');
          setPushDebug({ inited: true });
          try {
            PN.register();
          } catch (regErr) {
            console.warn('푸시 register() 호출 예외 (무시):', regErr?.message || regErr);
          }
        }).catch((e) => {
          console.warn('푸시 requestPermissions 실패:', e?.message || e);
          setPushDebug({ lastError: String(e?.message || e) });
        });
      } catch (e2) {
        console.warn('푸시 setTimeout 블록 실패:', e2?.message || e2);
        setPushDebug({ lastError: String(e2?.message || e2) });
      }
    }, 0);
  } catch (e) {
    const msg = e?.message || String(e);
    console.warn('⚠️ 푸시 알림 초기화 실패:', msg);
    setPushDebug({ lastError: msg });
  }
}
