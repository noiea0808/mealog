// Firebase 초기화 및 설정
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-storage.js";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js";

const firebaseConfig = {
    apiKey: "AIzaSyDMhxZHK7CgtiUACy9fOIiT7IDUW1uAWBc",
    authDomain: "mealog-r0.firebaseapp.com",
    projectId: "mealog-r0",
    storageBucket: "mealog-r0.firebasestorage.app",
    messagingSenderId: "535597498508",
    appId: "1:535597498508:web:28a883a1acd8a955b87ba9",
    measurementId: "G-9BV2LKSTCD"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

// Functions 초기화 (리전 명시: us-central1)
// 배포된 Functions가 us-central1에 있으므로 해당 리전 사용
export const functions = getFunctions(app, 'us-central1');
export const appId = 'mealog-r0';
export const apiKey = "";

// Callable Functions 참조
export const callableFunctions = {
    createBoardPost: httpsCallable(functions, 'createBoardPost'),
    updateBoardPost: httpsCallable(functions, 'updateBoardPost'),
    deleteBoardPost: httpsCallable(functions, 'deleteBoardPost'),
    addBoardComment: httpsCallable(functions, 'addBoardComment'),
    deleteBoardComment: httpsCallable(functions, 'deleteBoardComment'),
    addPostComment: httpsCallable(functions, 'addPostComment'),
    deletePostComment: httpsCallable(functions, 'deletePostComment'),
    submitPostReport: httpsCallable(functions, 'submitPostReport'),
    sharePhotos: httpsCallable(functions, 'sharePhotos'),
    unsharePhotos: httpsCallable(functions, 'unsharePhotos')
};

// App Check 초기화 (reCAPTCHA v3 사용)
// 에러가 발생해도 앱이 계속 작동하도록 try-catch로 감쌈
(async () => {
    try {
        const { initializeAppCheck, ReCaptchaV3Provider } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-app-check.js");
        const appCheck = initializeAppCheck(app, {
            provider: new ReCaptchaV3Provider('6LdjYVUsAAAAAP7RvrJgOEp-7wvDpmoC8Bll9-Kw'),
            isTokenAutoRefreshEnabled: true
        });
        console.log('✅ App Check 초기화 완료');
    } catch (e) {
        console.warn('⚠️ App Check 초기화 실패 (계속 진행):', e);
        // App Check 실패해도 앱은 계속 작동
    }
})();
