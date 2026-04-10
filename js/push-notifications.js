/**
 * 푸시 알림: Capacitor 네이티브에서 FCM 토큰 등록 및 Firestore 저장
 * - 로그인 사용자만 등록
 * - artifacts/{appId}/users/{uid}/config/fcmTokens 문서에 토큰 저장 (다중 기기 지원)
 */
import {
  db,
  appId,
  auth,
  appCheckInitPromise,
  refreshAppCheckTokenBeforeFirestore,
  callableFunctions
} from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import { showToast } from './ui.js';
import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';
import { serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

const FCM_TOKENS_DOC = 'fcmTokens';
if (typeof window !== 'undefined') {
  window.__pushModuleVersion = '2025-03-21';
  console.log('푸시 모듈 로드:', window.__pushModuleVersion);
}

/**
 * gstatic firebase-auth.js(11.6.x) ESM에는 authStateReady named export가 없음 → 인스턴스 메서드 또는 onAuthStateChanged 폴백.
 */
async function waitForAuthReady(authInstance) {
  if (!authInstance) return;
  if (typeof authInstance.authStateReady === 'function') {
    await authInstance.authStateReady();
    return;
  }
  await new Promise((resolve) => {
    const unsub = onAuthStateChanged(authInstance, () => {
      unsub();
      resolve();
    });
  });
}

function isNative() {
  return typeof window.Capacitor !== 'undefined' && window.Capacitor?.isNativePlatform?.();
}

function isAndroid() {
  return typeof window.Capacitor !== 'undefined' && window.Capacitor.getPlatform?.() === 'android';
}

/** 스테이징/프로덕션 앱 패키지 (알림 설정 화면 intent용) */
function getAndroidApplicationId() {
  const capAppId = String(window.Capacitor?.config?.appId || '').trim();
  if (capAppId === 'com.mealog.app.staging') return 'com.mealog.app.staging';
  if (capAppId === 'com.mealog.app') return 'com.mealog.app';
  return typeof window.APP_ENV !== 'undefined' && window.APP_ENV === 'staging'
    ? 'com.mealog.app.staging'
    : 'com.mealog.app';
}

function getCurrentPushEnv() {
  const capAppId = String(window.Capacitor?.config?.appId || '').trim();
  if (capAppId === 'com.mealog.app.staging') return 'staging';
  if (capAppId === 'com.mealog.app') return 'production';
  return typeof window.APP_ENV !== 'undefined' && window.APP_ENV === 'staging'
    ? 'staging'
    : 'production';
}

/**
 * OS 설정에서 이 앱의 알림·권한 화면으로 이동 (강제 허용은 불가 — 사용자가 켜야 함)
 * @returns {Promise<boolean>} 시도했으면 true
 */
export async function openNativeAppNotificationSettings() {
  const App = window.Capacitor?.Plugins?.App;
  if (!App?.openUrl) return false;
  try {
    if (isAndroid()) {
      const pkg = getAndroidApplicationId();
      await App.openUrl({
        url: `intent:#Intent;action=android.settings.APPLICATION_DETAILS_SETTINGS;data=package:${pkg};end`
      });
      return true;
    }
    await App.openUrl({ url: 'app-settings:' });
    return true;
  } catch (e) {
    if (isAndroid()) {
      try {
        await App.openUrl({ url: `package:${getAndroidApplicationId()}` });
        return true;
      } catch (_) {}
    }
    return false;
  }
}

if (typeof window !== 'undefined') {
  window.openMealogNotificationSettings = () => {
    openNativeAppNotificationSettings().catch(() => {});
  };
}

const PUSH_HINT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function maybeShowPushPermissionHint(uid, receive) {
  if (!uid || !isNative()) return;
  if (receive === 'granted' || receive === 'yes') return;
  try {
    const k = `mealog_push_hint_ts_${uid}`;
    const last = parseInt(localStorage.getItem(k) || '0', 10);
    if (Date.now() - last < PUSH_HINT_COOLDOWN_MS) return;
    localStorage.setItem(k, String(Date.now()));
  } catch (_) {}

  const msg =
    '댓글·알림을 받으려면 기기 설정에서 이 앱의 알림을 켜 주세요. (시스템에서만 변경 가능합니다)';

  setTimeout(() => {
    showToast(msg, 'error');
  }, 1600);
}

// Android: Capacitor 코어가 플러그인 프록시에 .then()을 걸면 "then is not implemented" — 토큰은 registration 리스너로 옴
if (typeof window !== 'undefined') {
  const prevHandler = window.onunhandledrejection;
  window.addEventListener('unhandledrejection', (event) => {
    const msg = event?.reason?.message ?? '';
    if (typeof msg === 'string' && msg.includes('PushNotifications') && msg.includes('is not implemented')) {
      event.preventDefault();
      event.stopPropagation();
      if (!window.__mealogPushBridgeNoiseOnce) {
        window.__mealogPushBridgeNoiseOnce = true;
        console.debug('[푸시] Android 브리지 알려진 무시 가능 경고(토큰은 리스너):', msg);
      }
      return true;
    }
    if (prevHandler) prevHandler.call(window, event);
  });
}

let pushListenersRegistered = false;

/** 로그인 직후 requestPermissions → register 지연 (브리지 안정화, 너무 길면 설정 복귀 후 토큰 지연) */
const INITIAL_PUSH_REGISTER_DELAY_MS = 2000;

let cachedPushPlugin = null;
let pushInitialRegisterTimer = null;
let pushResumeListenerRegistered = false;
let resumePushSyncTimer = null;

function normalizePermissionReceive(result) {
  if (result == null) return null;
  return result.receive != null ? result.receive : result;
}

/** 디버그·정체 구간 파악용: OS 권한 스냅샷 (requestPermissions 완료 전에도 값 채움) */
function refreshPushPermissionDebug(PN) {
  if (!PN?.checkPermissions) return;
  try {
    const cp = PN.checkPermissions();
    if (!cp || typeof cp.then !== 'function') return;
    Promise.race([
      cp,
      new Promise((_, rej) => setTimeout(() => rej(new Error('CHECK_PERM_TIMEOUT')), 12000))
    ])
      .then((result) => {
        setPushDebug({ permission: normalizePermissionReceive(result) });
      })
      .catch(() => {});
  } catch (_) {
    /* ignore */
  }
}

/**
 * 앱이 포그라운드일 때만 FCM register (권한 다이얼로그 직후 비활성 타이밍 완화)
 * getState() Promise가 영원히 pending이면 register가 안 불리는 경우가 있어 짧은 폴백.
 */
function callRegisterWhenActive(PN) {
  if (!PN || typeof PN.register !== 'function') return;
  setPushDebug({ phase: 'register_when_active' });
  const tryRegister = (reason) => {
    try {
      console.log('푸시: register() 호출', reason ? '(' + reason + ')' : '');
      PN.register();
      setPushDebug({ phase: 'register_invoked' });
    } catch (regErr) {
      console.warn('푸시 register() 예외:', regErr?.message || regErr);
      setPushDebug({ lastError: 'register() 예외: ' + (regErr?.message || regErr) });
    }
  };
  if (typeof window.Capacitor?.Plugins?.App !== 'undefined') {
    const stateP = window.Capacitor.Plugins.App.getState();
    const stalled = new Promise((resolve) =>
      setTimeout(() => resolve({ isActive: true, __mealogGetStateFallback: true }), 4000)
    );
    Promise.race([stateP, stalled])
      .then((state) => {
        if (state?.isActive) {
          if (state.__mealogGetStateFallback) {
            console.warn('푸시: App.getState() 지연 — register() 폴백 호출');
            setPushDebug({ phase: 'register_getstate_fallback' });
          } else {
            console.log('푸시: 앱 활성 상태 확인, register() 호출');
          }
          tryRegister(state.__mealogGetStateFallback ? 'getState-timeout' : 'active');
        } else {
          console.warn('푸시: 앱이 비활성 상태, register() 스킵');
          setPushDebug({ lastError: '앱 비활성 상태', phase: 'register_skipped_inactive' });
        }
      })
      .catch(() => {
        console.log('푸시: 상태 확인 실패, register() 호출 시도');
        tryRegister('getState-error');
      });
  } else {
    console.log('푸시: App 플러그인 없음, register() 호출');
    tryRegister('no-app-plugin');
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Capacitor 플러그인 프록시는 `then` 속성이 있어 async 함수의 `return plugin`이
 * Promise.resolve(plugin)에 의해 thenable로 처리되며 await가 영원히 걸릴 수 있음.
 */
function wrapPushPluginRef(pn) {
  return pn == null ? null : { _mealogPnRef: pn };
}
function unwrapPushPluginRef(box) {
  return box != null && typeof box === 'object' && Object.prototype.hasOwnProperty.call(box, '_mealogPnRef')
    ? box._mealogPnRef
    : null;
}

/**
 * 네이티브 앱: index.html의 capacitor-push-notifications-plugin.js만 유효.
 * WebView에서는 bare import('@capacitor/push-notifications')가 영원히 pending 되는 경우가 많아 쓰지 않음.
 */
async function resolvePushPlugin() {
  if (cachedPushPlugin) return wrapPushPluginRef(cachedPushPlugin);

  let PN = getPushPluginFromScript();

  if (isNative()) {
    const deadline = Date.now() + 8000;
    let attempts = 0;
    while (!PN && Date.now() < deadline) {
      attempts++;
      if (attempts === 15) injectPushNotificationsScriptOnce();
      await sleep(100);
      PN = getPushPluginFromScript();
    }
    if (!PN) {
      const keys = Object.keys(window.Capacitor?.Plugins || {});
      setPushDebug({
        lastError: 'PushNotifications 플러그인 없음 (로드된 Plugins: ' + keys.join(', ') + ')',
        phase: 'aborted',
        capPluginKeys: keys
      });
      console.warn(
        '푸시: PushNotifications 없음 — capacitor-push-notifications-plugin.js·cap sync·캐시 확인',
        keys
      );
      return null;
    }
    cachedPushPlugin = PN;
    return wrapPushPluginRef(PN);
  }

  if (!PN) PN = await loadPushPluginDynamic();
  if (PN) cachedPushPlugin = PN;
  return wrapPushPluginRef(PN);
}

function scheduleResumePushSync() {
  clearTimeout(resumePushSyncTimer);
  resumePushSyncTimer = setTimeout(() => {
    resumePushSyncTimer = null;
    void syncPushRegistrationFromOs();
  }, 500);
}

/** App 복귀 시 시스템 설정에서 알림을 켠 뒤에도 토큰 등록이 다시 돌도록 */
function ensurePushResumeListener() {
  if (pushResumeListenerRegistered) return;
  const App = window.Capacitor?.Plugins?.App;
  if (!App?.addListener) return;
  pushResumeListenerRegistered = true;
  App.addListener('resume', () => scheduleResumePushSync());
}

/**
 * 시스템 설정에서만 권한을 바꾼 경우: 다이얼로그 없이 checkPermissions 후 register
 * (로그인된 네이티브 앱에서만 의미 있음)
 */
export async function syncPushRegistrationFromOs() {
  if (!isNative()) return;
  const uid = window.currentUser?.uid;
  if (!uid || window.currentUser?.isAnonymous) return;

  const PN = unwrapPushPluginRef(await resolvePushPlugin());
  if (!PN?.checkPermissions) return;

  try {
    const checkP = PN.checkPermissions();
    if (checkP && typeof checkP.then === 'function') {
      checkP
        .then((result) => {
          const receive = normalizePermissionReceive(result);
          setPushDebug({ permission: receive });
          if (receive === 'denied') return;
          callRegisterWhenActive(PN);
        })
        .catch(() => callRegisterWhenActive(PN));
      return;
    }
  } catch (_) {
    /* fall through */
  }
  callRegisterWhenActive(PN);
}

/** 디버그용: 콘솔 없이 상태 확인 가능. chrome://inspect 콘솔에서 getPushDebugInfo() 호출 */
function setPushDebug(update) {
  window.__pushDebug = { ...(window.__pushDebug || {}), ...update };
}
window.getPushDebugInfo = function getPushDebugInfo() {
  const d = window.__pushDebug || {};
  const cap = typeof window.Capacitor !== 'undefined';
  const native = !!(cap && window.Capacitor.isNativePlatform?.());
  return {
    inited: d.inited ?? false,
    permission: d.permission ?? null,
    tokenSaved: d.tokenSaved ?? false,
    lastError: d.lastError ?? null,
    phase: d.phase ?? null,
    liveIsNative: native,
    liveHasCapacitor: cap,
    liveUid: window.currentUser?.uid ?? null,
    liveIsAnonymous: !!window.currentUser?.isAnonymous,
    __pushInitUid: window.__pushInitUid ?? null,
    __pushInitInFlight: !!window.__pushInitInFlight,
    liveCapPluginKeys: Object.keys(window.Capacitor?.Plugins || {})
  };
};

function isFirestorePermissionDenied(err) {
  const msg = (err && (err.message || err.code)) ? String(err.message || err.code) : String(err || '');
  const code = err && err.code ? String(err.code) : '';
  return (
    code === 'permission-denied' ||
    /permission|insufficient/i.test(msg)
  );
}

async function saveFcmTokenToFirestoreClient(uid, token, tokenEnv) {
  const ref = doc(db, 'artifacts', appId, 'users', uid, 'config', FCM_TOKENS_DOC);
  const snap = await getDoc(ref);
  const prev = (snap.data() && snap.data().tokens) || {};
  await setDoc(
    ref,
    {
      tokens: {
        ...prev,
        [token]: { updatedAt: serverTimestamp(), env: tokenEnv }
      }
    },
    { merge: true }
  );
}

/**
 * FCM 토큰을 Firestore에 저장 (merge: 기존 토큰에 추가)
 * - 로그인·App Check 직후 permission-denied 완화: 갱신 후 1회 재시도
 * - 여전히 실패 시 registerFcmToken Callable(Admin) 폴백
 */
async function saveFcmToken(uid, token) {
  if (!uid || !token || typeof token !== 'string') return;
  const tokenEnv = getCurrentPushEnv();

  const onSaved = () => {
    setPushDebug({ tokenSaved: true, lastError: null, phase: 'token_saved' });
    console.log('✅ FCM 토큰 저장 완료');
    if (typeof window.__onPushTokenSaved === 'function') window.__onPushTokenSaved();
  };

  const onFailed = (msg) => {
    setPushDebug({ tokenSaved: false, lastError: msg });
    console.warn('⚠️ FCM 토큰 저장 실패:', msg);
    if (typeof window.__onPushTokenSavedError === 'function') window.__onPushTokenSavedError(msg);
  };

  try {
    await appCheckInitPromise;
    await waitForAuthReady(auth);
    await refreshAppCheckTokenBeforeFirestore();
    await saveFcmTokenToFirestoreClient(uid, token, tokenEnv);
    onSaved();
  } catch (e) {
    const msg = e?.message || String(e);
    if (isFirestorePermissionDenied(e)) {
      try {
        await waitForAuthReady(auth);
        await refreshAppCheckTokenBeforeFirestore();
        await new Promise((r) => setTimeout(r, 450));
        await saveFcmTokenToFirestoreClient(uid, token, tokenEnv);
        onSaved();
        return;
      } catch (e2) {
        /* fall through to callable */
      }
      try {
        const payload = { token };
        if (tokenEnv) payload.env = tokenEnv;
        await refreshAppCheckTokenBeforeFirestore();
        await callableFunctions.registerFcmToken(payload);
        onSaved();
        return;
      } catch (e3) {
        try {
          await new Promise((r) => setTimeout(r, 500));
          await refreshAppCheckTokenBeforeFirestore();
          const payload = { token };
          if (tokenEnv) payload.env = tokenEnv;
          await callableFunctions.registerFcmToken(payload);
          onSaved();
          return;
        } catch (e4) {
          onFailed(e4?.message || String(e4));
          return;
        }
      }
    }
    onFailed(msg);
  }
}

/**
 * 스크립트로 등록된 PushNotifications만 동기 반환.
 * 주의: async 함수에서 `return PN` 하면 Promise.resolve(PN)이 PN의 `.then`(Capacitor 프록시)을
 * Promise로 오인해 await가 영원히 이어지지 않거나 "then is not implemented"만 터질 수 있음 (Android).
 */
function getPushPluginFromScript() {
  const plugins = window.Capacitor?.Plugins;
  if (!plugins) return null;
  if (plugins.PushNotifications) {
    console.log('푸시: 플러그인 사용 (스크립트 등록)');
    return plugins.PushNotifications;
  }
  const keys = Object.keys(plugins);
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i]).toLowerCase() === 'pushnotifications') {
      console.log('푸시: 플러그인 사용 (키 대소문자 변형):', keys[i]);
      return plugins[keys[i]];
    }
  }
  return null;
}

/** 플러그인 스크립트가 빠진 번들 대비 1회 재주입 */
function injectPushNotificationsScriptOnce() {
  if (window.__mealogPushPluginScriptInjected) return;
  window.__mealogPushPluginScriptInjected = true;
  try {
    const s = document.createElement('script');
    s.src = `js/capacitor-push-notifications-plugin.js?inj=${Date.now()}`;
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    console.warn('푸시: PushNotifications 스크립트 재주입 시도');
  } catch (e) {
    console.warn('푸시: 스크립트 재주입 실패:', e?.message || e);
  }
}

/** 동적 import 경로만 async (여기서 반환값은 모듈에서 온 클래스/객체로 thenable 오인 위험 낮음) */
async function loadPushPluginDynamic() {
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
const PUSH_INIT_VERSION = '2025-03-21-pn-reg-race';
export async function initPushNotifications(uid) {
  console.log('푸시: init 버전', PUSH_INIT_VERSION);
  setPushDebug({ inited: false, phase: 'init_started', permission: null });

  // ⚠️ 중요: 앱이 완전히 준비되었는지 확인
  if (!window.currentUser || window.currentUser.uid !== uid) {
    console.warn('푸시: currentUser 불일치 또는 없음, 스킵', {
      currentUserUid: window.currentUser?.uid,
      requestedUid: uid
    });
    setPushDebug({ lastError: 'currentUser 불일치', phase: 'aborted' });
    return false;
  }

  if (!uid || !isNative()) {
    if (!uid) {
      console.log('푸시: uid 없음, 스킵');
      setPushDebug({ lastError: 'uid 없음', phase: 'aborted' });
    } else {
      console.log('푸시: 네이티브가 아님(웹/에뮬), 스킵');
      setPushDebug({ lastError: '네이티브 아님', phase: 'aborted' });
    }
    return false;
  }

  try {
    console.log('푸시: 초기화 시작');
    setPushDebug({ phase: 'loading_plugin' });
    const PN = unwrapPushPluginRef(await resolvePushPlugin());
    console.log('푸시: 플러그인 확보 직후', { hasPN: !!PN });
    console.warn('[PUSH-DBG] 플러그인 확보 직후', { hasPN: !!PN });
    if (!PN) {
      console.warn('푸시: PushNotifications 플러그인을 불러올 수 없음');
      if (!window.__pushDebug?.lastError) {
        setPushDebug({
          lastError: '플러그인 로드 실패',
          phase: 'aborted',
          capPluginKeys: Object.keys(window.Capacitor?.Plugins || {})
        });
      }
      return false;
    }
    console.log('푸시: 플러그인 로드됨');
    console.warn('[PUSH-DBG] 플러그인 로드됨');

    ensurePushResumeListener();

    // [A] 리스너만 다음 틱에서 등록 (Android 브리지 .then() 오류 회피)
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
            const data = ev.notification?.data;
            // 관리자 브로드캐스트: 앱 내 탭만 전환. 미읽음 집계·숫자 배지(Badge)·헤더 빨간점 갱신 안 함 → 런처는 점만(기기/OS) 가능
            if (data?.type === 'adminBroadcast' || data?.suppressNumericBadge === '1') {
              const allowed = ['dashboard', 'timeline', 'gallery', 'board', 'settings'];
              const tab = allowed.includes(String(data.landingTab)) ? String(data.landingTab) : 'dashboard';
              if (data?.type === 'adminBroadcast' && typeof window.switchMainTab === 'function') {
                window.switchMainTab(tab);
              }
              return;
            }
            const nid = data?.noticeId;
            if (data?.type === 'notice' && nid && typeof window.openNoticeDetail === 'function') {
              window.switchMainTab?.('board');
              window.openNoticeDetail(String(nid));
            }
            if (data?.type === 'feedActivity' && data?.feedPostId) {
              if (typeof window.updateNotificationDot === 'function') {
                window.updateNotificationDot().catch(() => {});
              }
              return;
            }
            // 백그라운드에서는 FCM 시스템 알림, 포그라운드에서는 여기서만 옴 → 빨간점·배지 갱신
            if (typeof window.updateNotificationDot === 'function') {
              window.updateNotificationDot().catch(() => {});
            }
          });
          PN.addListener('pushNotificationActionPerformed', (ev) => {
            console.log('푸시 탭 (알림 클릭):', ev.notification, ev.actionId);
            const data = ev.notification?.data;
            if (data?.type === 'adminBroadcast') {
              const allowed = ['dashboard', 'timeline', 'gallery', 'board', 'settings'];
              const tab = allowed.includes(String(data.landingTab)) ? String(data.landingTab) : 'dashboard';
              if (typeof window.switchMainTab === 'function') window.switchMainTab(tab);
              return;
            }
            const noticeId = data?.noticeId != null ? String(data.noticeId) : '';
            if (data?.type === 'notice' && noticeId && typeof window.openNoticeDetail === 'function') {
              window.switchMainTab?.('board');
              window.openNoticeDetail(noticeId);
              return;
            }
            if (data?.type === 'feedActivity' && data?.feedPostId && typeof window.navigateToFeedNotification === 'function') {
              window.navigateToFeedNotification(String(data.feedPostId));
              return;
            }
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

    // [B] 권한 요청 후 register (짧은 지연으로 브리지 안정화)
    console.log('푸시: [B] register() 호출 준비');
    console.warn('[PUSH-DBG] [B] register() 호출 준비');
    setPushDebug({ inited: true, phase: 'register_scheduled' });

    const doRegister = () => {
      setPushDebug({ phase: 'register_timer_fired' });
      refreshPushPermissionDebug(PN);
      console.log('푸시: register() 호출 시도');
      console.warn('[PUSH-DBG] register() 호출 시도');

      // Android 13+ / iOS: 런타임 알림 권한 후에만 FCM 등록이 안정적 (로그인 시 init이 다시 켜진 뒤 필수)
      try {
        const permP = PN.requestPermissions && PN.requestPermissions();
        if (permP && typeof permP.then === 'function') {
          const permTimeoutMs = 25000;
          Promise.race([
            permP,
            new Promise((_, rej) => setTimeout(() => rej(new Error('REQ_PERM_TIMEOUT')), permTimeoutMs))
          ])
            .then((result) => {
              const receive = normalizePermissionReceive(result);
              setPushDebug({ permission: receive, phase: 'perm_resolved' });
              maybeShowPushPermissionHint(uid, receive);
              if (receive === 'denied') {
                console.warn('푸시: 알림 권한 거부, register 생략');
                setPushDebug({ lastError: '알림 권한 거부', phase: 'perm_denied' });
              } else {
                callRegisterWhenActive(PN);
              }
            })
            .catch((e) => {
              const timedOut = e?.message === 'REQ_PERM_TIMEOUT';
              console.warn(
                '푸시: requestPermissions 실패' + (timedOut ? '(타임아웃)' : '') + ', register() 시도:',
                e?.message || e
              );
              if (timedOut) {
                setPushDebug({ lastError: 'requestPermissions 타임아웃', phase: 'perm_timeout' });
              }
              refreshPushPermissionDebug(PN);
              callRegisterWhenActive(PN);
            });
          return;
        }
      } catch (e) {
        console.warn('푸시: requestPermissions 예외, register()만 시도:', e?.message || e);
      }
      setPushDebug({ phase: 'perm_sync_path' });
      refreshPushPermissionDebug(PN);
      callRegisterWhenActive(PN);
    };

    if (pushInitialRegisterTimer != null) {
      clearTimeout(pushInitialRegisterTimer);
      pushInitialRegisterTimer = null;
    }
    pushInitialRegisterTimer = setTimeout(() => {
      pushInitialRegisterTimer = null;
      doRegister();
    }, INITIAL_PUSH_REGISTER_DELAY_MS);
    return true;
  } catch (e) {
    const msg = e?.message || String(e);
    console.warn('⚠️ 푸시 알림 초기화 실패:', msg);
    setPushDebug({ lastError: msg, phase: 'aborted' });
    return false;
  }
}

/** 원격 디버깅 콘솔: 토큰 등록 재시도 (__pushInitUid 초기화 후 init 다시) */
window.retryMealogPushInit = async function retryMealogPushInit() {
  const u = window.currentUser?.uid;
  if (!u || window.currentUser?.isAnonymous) {
    console.warn('[푸시] 비익명 로그인 후 사용');
    return false;
  }
  if (!window.Capacitor?.isNativePlatform?.()) {
    console.warn('[푸시] 네이티브 앱에서만 동작');
    return false;
  }
  window.__pushInitUid = null;
  window.__pushInitInFlight = false;
  const ok = await initPushNotifications(u);
  if (ok) window.__pushInitUid = u;
  return ok;
};

// 설정 화면에서 돌아올 때 resume과 함께 visibility로도 동기화 (OEM별 차이 대비, debounce는 scheduleResumePushSync에 위임)
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (typeof window.Capacitor === 'undefined' || !window.Capacitor.isNativePlatform?.()) return;
    scheduleResumePushSync();
  });
}

// init이 끝까지 못 가도 App resume 시 syncPushRegistrationFromOs가 돌 수 있게 리스너만 먼저 붙임
if (typeof window !== 'undefined') {
  queueMicrotask(() => {
    try {
      if (window.Capacitor?.isNativePlatform?.()) ensurePushResumeListener();
    } catch (_) {}
  });
}
