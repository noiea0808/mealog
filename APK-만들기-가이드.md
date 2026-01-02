# mealog APK 만들기 - 간단 가이드

## 🎯 가장 쉬운 방법: PWA Builder 사용 (추천!)

### 1단계: 웹사이트 배포
먼저 웹사이트를 인터넷에 올려야 합니다:
- GitHub Pages (무료)
- Netlify (무료)
- Vercel (무료)
- Firebase Hosting (무료)

### 2단계: PWA Builder로 APK 생성
1. https://www.pwabuilder.com/ 접속
2. 웹사이트 URL 입력
3. "Build My PWA" 클릭
4. Android APK 선택
5. 다운로드

**장점:** 클릭 몇 번으로 완료!

---

## 🔧 수동 방법: Capacitor 사용

### 필요 사항
- Node.js 설치
- Android Studio 설치 (약 1GB)
- Java JDK 설치

### 설치 및 빌드
```bash
# 1. Node.js 설치 확인
node --version

# 2. Capacitor 설치
npm install -g @capacitor/cli

# 3. 프로젝트 초기화
cd d:\mealog
npm init -y
npm install @capacitor/core @capacitor/cli
npx cap init

# 4. Android 플랫폼 추가
npm install @capacitor/android
npx cap add android

# 5. Android Studio에서 빌드
npx cap open android
```

**단점:** 복잡하고 시간이 오래 걸림

---

## 💡 추천 방법

**가장 쉬운 순서:**
1. **GitHub Pages에 배포** (5분)
2. **PWA Builder로 APK 생성** (2분)
3. **APK 다운로드 및 설치**

이 방법이 가장 빠르고 쉽습니다!

