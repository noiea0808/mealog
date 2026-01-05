// Firebase 초기화 및 설정
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

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
export const appId = 'mealog-r0';
export const apiKey = "";




