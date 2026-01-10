# ADMIN 권한 설정 가이드 (방법2 사용)

## ⚠️ 중요: 웹 서버를 통해 실행해야 합니다

`admin.html` 파일을 직접 열면 CORS 오류가 발생합니다. 반드시 **웹 서버를 통해** 실행하세요.

## 1단계: 웹 서버 실행

### 옵션 A: PowerShell 서버 사용 (권장)
```powershell
# 프로젝트 폴더에서 실행
.\server.ps1
```
또는
```powershell
# start.bat 실행
start.bat
```

서버가 실행되면 브라우저에서 접속:
- 일반 앱: `http://localhost:8000/index.html`
- 관리자: `http://localhost:8000/admin.html`

### 옵션 B: Python 간단 서버 (Python 설치된 경우)
```bash
# Python 3
python -m http.server 8000

# Python 2
python -m SimpleHTTPServer 8000
```

## 2단계: 일반 앱에서 로그인 및 UID 확인

1. `http://localhost:8000/index.html` 접속
2. 관리자로 사용할 계정으로 로그인 (이메일/비밀번호 또는 구글)
3. 브라우저 개발자 도구(F12) → Console 탭 열기
4. 다음 코드 실행:

```javascript
console.log('현재 사용자 UID:', window.currentUser.uid);
console.log('현재 사용자 이메일:', window.currentUser.email);
```

5. 출력된 **UID를 복사**하세요

## 3단계: 브라우저 콘솔에서 ADMIN 권한 설정

`index.html` 또는 `admin.html` 어디서든 실행 가능합니다.

1. 브라우저 개발자 도구(F12) → Console 탭
2. 다음 코드를 **전체 복사**하여 붙여넣고 실행:

```javascript
(async function() {
    // Firebase 모듈 import
    const { initializeApp } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js");
    const { getFirestore, doc, setDoc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");

    // Firebase 초기화
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

    // 현재 로그인한 사용자의 UID 사용
    if (!window.currentUser) {
        console.error('❌ 로그인이 필요합니다. 먼저 일반 앱에서 로그인하세요.');
        return;
    }

    const adminUserId = window.currentUser.uid;
    const adminEmail = window.currentUser.email || 'admin@example.com';

    try {
        // ADMIN 문서 생성
        await setDoc(doc(db, 'artifacts', 'mealog-r0', 'admins', adminUserId), {
            isAdmin: true,
            email: adminEmail,
            createdAt: new Date().toISOString()
        });

        console.log('✅ ADMIN 권한이 설정되었습니다!');
        console.log('사용자 UID:', adminUserId);
        console.log('이메일:', adminEmail);
        console.log('');
        console.log('이제 admin.html 페이지에서 로그인할 수 있습니다.');
    } catch (error) {
        console.error('❌ ADMIN 권한 설정 실패:', error);
        console.error('오류 메시지:', error.message);
    }
})();
```

3. 콘솔에 `✅ ADMIN 권한이 설정되었습니다!` 메시지가 보이면 성공!

## 4단계: 관리자 페이지에서 로그인 확인

1. `http://localhost:8000/admin.html` 접속
2. **방금 설정한 계정**의 이메일과 비밀번호로 로그인
3. 관리자 대시보드가 표시되면 성공!

## 문제 해결

### "로그인은 되는데 관리자 권한이 없습니다" 오류
- Firebase 콘솔에서 `artifacts/mealog-r0/admins/{UID}` 문서가 제대로 생성되었는지 확인
- 문서의 `isAdmin` 필드가 `true`인지 확인

### "window.currentUser is undefined" 오류
- 일반 앱(`index.html`)에서 먼저 로그인한 후 콘솔 코드를 실행하세요

### CORS 오류
- 파일을 직접 열지 말고 웹 서버를 통해 실행하세요
- `file:///`로 시작하는 URL이면 안 됩니다
- `http://localhost:8000/`로 시작해야 합니다

### 모듈 로드 오류
- 웹 서버가 제대로 실행 중인지 확인
- 브라우저 콘솔에서 정확한 오류 메시지 확인
