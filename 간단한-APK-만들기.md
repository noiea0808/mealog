# 🚀 mealog APK 만들기 - 초간단 버전

## 방법 1: PWA Builder 사용 (가장 쉬움! ⭐)

### 단계별 가이드

#### 1. 웹사이트를 인터넷에 올리기

**옵션 A: GitHub Pages (무료, 5분)**
1. GitHub 계정 만들기 (없으면)
2. 새 저장소(repository) 만들기
3. `mealog` 폴더의 모든 파일 업로드
4. Settings > Pages에서 활성화
5. `https://[사용자명].github.io/[저장소명]` 주소 확인

**옵션 B: Netlify (무료, 2분)**
1. https://www.netlify.com 접속
2. 가입 후 "Add new site" > "Deploy manually"
3. `mealog` 폴더를 드래그 앤 드롭
4. 자동으로 URL 생성됨

#### 2. PWA Builder로 APK 만들기
1. https://www.pwabuilder.com/ 접속
2. 위에서 만든 웹사이트 URL 입력
3. "Start" 클릭
4. "Build My PWA" 클릭
5. "Android" 선택
6. "Generate Package" 클릭
7. APK 다운로드!

**총 소요 시간: 약 10분**

---

## 방법 2: Capacitor 사용 (고급)

### 필요 사항 설치
- Node.js: https://nodejs.org
- Android Studio: https://developer.android.com/studio

### 실행
1. `capacitor-setup.bat` 파일 실행
2. Android Studio 열기
3. 빌드

**총 소요 시간: 약 1시간 (첫 설정)**

---

## 💡 추천

**처음이시라면:** 방법 1 (PWA Builder) 추천!
- 설치 불필요
- 클릭 몇 번으로 완료
- 무료

**개발자라면:** 방법 2 (Capacitor)
- 더 많은 커스터마이징 가능
- 네이티브 기능 추가 가능

---

## ❓ 질문

**Q: 로컬에서만 사용하고 싶어요**
A: 안드로이드 에뮬레이터나 실제 기기에서 웹뷰로 실행하는 방법도 있습니다.

**Q: 더 간단한 방법 없나요?**
A: PWA Builder가 가장 간단합니다. 웹사이트만 올리면 자동으로 APK 생성해줍니다.

**Q: iOS 앱도 만들 수 있나요?**
A: 네! PWA Builder에서 iOS도 지원합니다. (단, Apple Developer 계정 필요)

