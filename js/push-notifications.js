/**
 * 푸시 알림: Capacitor 네이티브에서 FCM 토큰 등록 및 Firestore 저장
 * - 로그인 사용자만 등록
 * - artifacts/{appId}/users/{uid}/config/fcmTokens 문서에 토큰 저장 (다중 기기 지원)
 */
import { db, appId } from './firebase.js';
import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';
import { serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

const FCM_TOKENS_DOC = 'fcmTokens';

function isNative() {
  return typeof window.Capacitor !== 'undefined' && window.Capacitor?.isNativePlatform?.();
}

let pushListenersRegistered = false;

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
    console.log('✅ FCM 토큰 저장 완료');
  } catch (e) {
    console.warn('⚠️ FCM 토큰 저장 실패:', e?.message || e);
  }
}

/**
 * 푸시 알림 초기화: 네이티브에서만 실행, 권한 요청 후 토큰 등록 및 저장
 * @param {string} uid - 로그인한 사용자 uid
 */
export async function initPushNotifications(uid) {
  if (!uid || !isNative()) return;

  try {
    const PushNotifications = await import('@capacitor/push-notifications');
    const { PushNotifications: PN } = PushNotifications;

    if (!pushListenersRegistered) {
      pushListenersRegistered = true;
      PN.addListener('registration', async (ev) => {
        const token = ev.value;
        if (token && window.currentUser && !window.currentUser.isAnonymous) {
          await saveFcmToken(window.currentUser.uid, token);
        }
      });
      PN.addListener('registrationError', (ev) => {
        console.warn('푸시 등록 오류:', ev.error?.message || ev.error);
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
    }

    const perm = await PN.requestPermissions();
    if (perm.receive !== 'granted') {
      console.log('푸시 알림 권한이 허용되지 않음:', perm.receive);
      return;
    }
    await PN.register();
  } catch (e) {
    console.warn('⚠️ 푸시 알림 초기화 실패:', e?.message || e);
  }
}
