# ADMIN 권한 빠른 수정 가이드

## 문제
문서 ID가 실제 사용자 UID와 일치하지 않습니다.
- 현재 문서 ID: `mustang`
- 실제 UID: `4UDeI0Bts0gkwnnrt1WNRgjOQ5x2`

## 해결 방법 1: 브라우저 콘솔로 설정 (가장 빠름)

1. **관리자 페이지(`admin.html`)에서 로그인 상태 유지** (또는 `index.html`에서 로그인)

2. **브라우저 개발자 도구(F12) → Console 탭 열기**

3. **다음 코드를 복사하여 붙여넣고 Enter:**

```javascript
(async function() {
    const { initializeApp } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
    const { getFirestore, doc, setDoc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
    const { getAuth } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js");
    
    const firebaseConfig = {
        apiKey: "AIzaSyDMhxZHK7CgtiUACy9fOIiT7IDUW1uAWBc",
        authDomain: "mealog-r0.firebaseapp.com",
        projectId: "mealog-r0",
        storageBucket: "mealog-r0.firebasestorage.app",
        messagingSenderId: "535597498508",
        appId: "1:535597498508:web:28a883a1acd8a955b87ba9"
    };
    
    const app = initializeApp(firebaseConfig);
    const db = getFirestore(app);
    const auth = getAuth(app);
    
    const currentUser = auth.currentUser;
    if (!currentUser) {
        console.error('❌ 로그인이 필요합니다.');
        return;
    }
    
    const adminUserId = currentUser.uid;
    console.log('✅ 현재 사용자 UID:', adminUserId);
    
    await setDoc(doc(db, 'artifacts', 'mealog-r0', 'admins', adminUserId), {
        isAdmin: true,
        email: currentUser.email || 'noiea@naver.com',
        createdAt: new Date().toISOString()
    });
    
    console.log('✅ ADMIN 권한 설정 완료!');
    console.log('문서 경로: artifacts/mealog-r0/admins/' + adminUserId);
    console.log('이제 관리자 페이지에서 다시 로그인하세요.');
})();
```

4. **콘솔에 `✅ ADMIN 권한 설정 완료!` 메시지 확인**

5. **관리자 페이지에서 다시 로그인**

## 해결 방법 2: Firebase 콘솔에서 수정

1. Firebase 콘솔 접속
2. `artifacts/mealog-r0/admins/mustang` 문서 열기
3. 문서 삭제 또는 문서 ID 변경
4. 새 문서 추가:
   - 문서 ID: `4UDeI0Bts0gkwnnrt1WNRgjOQ5x2` (정확히 이 UID)
   - 필드 추가:
     - `isAdmin`: boolean, `true`
     - `email`: string, `noiea@naver.com`
     - `createdAt`: timestamp, 현재 시간

## 확인
설정 후 관리자 페이지에서 다시 로그인하면 정상 작동합니다.
