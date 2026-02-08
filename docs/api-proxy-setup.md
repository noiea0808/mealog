# API 프록시 설정 가이드 (WebView 차단 우회)

Gemini API와 Kakao API를 WebView(앱)에서 직접 호출하면 차단되는 문제가 있어, Firebase Functions를 통해 백엔드 프록시를 사용합니다.

## 필요한 환경 변수

Firebase Functions에 다음 환경 변수를 설정해야 합니다.

| 변수명 | 용도 | 발급처 |
|--------|------|--------|
| `GEMINI_API_KEY` | 밀당 AI 코멘트 | [Google AI Studio](https://aistudio.google.com/apikey) |
| `KAKAO_REST_API_KEY` | 장소 검색 | [Kakao Developers](https://developers.kakao.com) → 앱 설정 → **REST API 키** (JavaScript 키 아님) |

---

## 환경 변수 설정 방법

### 방법 1: .env 파일 (가장 간단, 권장)

1. `functions/.env.example` 파일을 복사해서 `functions/.env` 생성
2. `functions/.env`를 열고 실제 API 키로 수정:
   ```
   GEMINI_API_KEY=AIzaSy...실제키...
   KAKAO_REST_API_KEY=abc123...실제REST키...
   ```
3. 프로젝트 루트에서 배포:
   ```bash
   firebase deploy --only functions
   ```

배포 시 `.env` 내용이 자동으로 함수에 포함됩니다. (`.env`는 `.gitignore`에 있어 Git에 안 올라갑니다)

---

### 방법 2: Google Cloud Console (이미 배포된 함수 수정 시)

Firebase Console의 Functions 화면에는 환경 변수 UI가 없습니다. **Google Cloud Console**에서 설정해야 합니다.

1. [Firebase Console](https://console.firebase.google.com) → 프로젝트 선택 → **Functions**
2. 배포된 함수 목록에서 **`callGemini`** 또는 아무 함수 클릭
3. 상단 **"Google Cloud Console에서 열기"** (또는 Cloud 아이콘) 클릭
4. Google Cloud Console에서 해당 함수 선택 → **수정** 버튼 클릭
5. **런타임, 빌드, 연결 설정** 펼치기 → **환경 변수** 섹션
6. `GEMINI_API_KEY`, `KAKAO_REST_API_KEY` 추가 → **배포** 클릭

> 참고: Cloud Functions는 함수별로 환경 변수가 공유되므로, 한 함수에만 설정해도 됩니다. (같은 프로젝트의 모든 함수에 적용되지는 않을 수 있음 - v2에서는 함수별로 설정)  
> `.env` 방식이면 모든 함수에 한 번에 적용되므로 더 간단합니다.

---

### 방법 3: 배포 시 한 번에 지정

```bash
firebase deploy --only functions --set-env-vars GEMINI_API_KEY=your_key,KAKAO_REST_API_KEY=your_kakao_rest_key
```

매번 배포할 때마다 지정해야 하므로 비추천.

---

## 배포

```bash
cd "e:\200. Dev\mealog"   # 프로젝트 루트
firebase deploy --only functions
```

(이미 `functions/`에 `npm install` 되어 있다면 위 명령만 실행)

---

## 트러블슈팅

### Gemini 403 "Requests from referer &lt;empty&gt; are blocked"

**원인**: API 키에 **HTTP referrer(웹사이트) 제한**이 걸려 있음. 서버(Firebase Functions) 요청은 Referer가 비어 있어 차단됨.

**해결**: [Google AI Studio](https://aistudio.google.com/apikey) → API 키 → **수정** → **애플리케이션 제한사항**에서
- **"없음"** 선택 (서버용 키 권장), 또는
- **"IP 주소"** 선택 후 Firebase Functions IP 대역 추가

"HTTP referrer(웹사이트)"는 브라우저용이라 서버 호출에는 맞지 않습니다.

---

## 동작 방식

| API | 이전 (클라이언트 직접 호출) | 이후 (백엔드 프록시) |
|-----|---------------------------|----------------------|
| **Gemini** | 클라이언트에서 API 키로 fetch | `callGemini` Callable → 서버에서 Gemini API 호출 |
| **Kakao** | Kakao Maps JavaScript SDK | `searchKakaoPlaces` Callable → 서버에서 Kakao Local REST API 호출 |

클라이언트는 Firebase Callable을 호출하고, 서버가 실제 API를 호출하여 결과를 반환합니다. WebView/앱에서도 정상 동작합니다.

---

### 카카오 401 "KA Header is required but neither os nor origin field is given"

카카오 API가 KA 헤더에 `os` 또는 `origin` 필드를 요구합니다. **공식 문서에 KA 헤더 형식이 명시되어 있지 않아** 코드에서 시도한 형식으로는 해결되지 않을 수 있습니다.

**권장 조치:**
1. [카카오 데브톡](https://devtalk.kakao.com) → "KA Header" 또는 "로컬 API 401" 검색
2. [카카오 개발자 1:1 문의](https://developers.kakao.com/support) → KA 헤더 정확한 형식 문의
3. 카카오맵 API [사용 설정](https://developers.kakao.com/console/app) → 카카오맵 > 사용 설정 ON 확인

---

### 카카오맵 "로컬에서는 되는데 스테이징 앱에서는 안 됨"

**원인:** Capacitor 앱(WebView)에서는 카카오 JavaScript SDK가 다음 이유로 불안정합니다.
- 카카오 플랫폼 "사이트 도메인"에 앱 도메인(capacitor://localhost 등) 미등록
- WebView에서 외부 스크립트(dapi.kakao.com) 차단

**해결:** 앱에서는 **Firebase Callable**을 우선 사용합니다 (SDK 없이 서버에서 REST API 호출).

1. **호출 허용 IP 주소**: 비워두세요. Firebase Functions는 동적 IP를 사용하므로 등록 불가. 비어 있으면 모든 IP 허용.
2. **Firebase Functions 환경 변수**: `KAKAO_REST_API_KEY`가 배포되어 있는지 확인.
   - `.env` 파일만으로는 배포 시 자동 반영되지 않을 수 있음
   - [Google Cloud Console](https://console.cloud.google.com) → 해당 프로젝트 → 함수 → 함수 선택 → 수정 → 환경 변수에 `KAKAO_REST_API_KEY` 추가 후 재배포
3. **재배포:** `firebase deploy --only functions`로 Functions 재배포
