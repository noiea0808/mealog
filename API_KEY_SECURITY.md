# API 키 보안 설정 가이드

## ⚠️ 중요: API 키 보안

현재 Gemini API 키는 `js/config.js` 파일에 저장되어 있으며, 이 파일은 `.gitignore`에 추가되어 Git에 커밋되지 않습니다.

## 현재 보안 조치

1. ✅ API 키를 별도 설정 파일(`js/config.js`)로 분리
2. ✅ `.gitignore`에 추가하여 Git에 커밋되지 않도록 설정
3. ✅ 예제 파일(`js/config.example.js`) 제공

## 추가 보안 조치 (필수)

### 1. Google Cloud Console에서 API 키 제한 설정

**중요**: 클라이언트 측 JavaScript에서는 API 키를 완전히 숨길 수 없습니다. 따라서 Google Cloud Console에서 API 키 제한을 설정해야 합니다.

#### 설정 방법:

1. [Google Cloud Console](https://console.cloud.google.com/) 접속
2. **API 및 서비스** > **사용자 인증 정보** 이동
3. 해당 API 키 클릭
4. **애플리케이션 제한사항** 설정:
   - **HTTP 리퍼러(웹사이트)** 선택
   - 허용된 리퍼러 추가:
     ```
     http://localhost:8000/*
     https://yourdomain.com/*
     https://*.github.io/*
     ```
   - 실제 배포 도메인에 맞게 수정

5. **API 제한사항** 설정:
   - **키 제한** 선택
   - **Generative Language API**만 선택
   - 다른 API는 선택하지 않음

6. **저장** 클릭

### 2. API 키 할당량 모니터링

1. Google Cloud Console에서 **API 및 서비스** > **할당량** 이동
2. **Generative Language API** 선택
3. 일일 할당량 및 사용량 모니터링
4. 필요시 할당량 제한 설정

### 3. API 키 교체 (노출된 경우)

만약 API 키가 노출되었다면:

1. Google Cloud Console에서 해당 API 키 **삭제** 또는 **비활성화**
2. 새 API 키 생성
3. `js/config.js` 파일에 새 API 키 입력
4. `.gitignore`가 제대로 작동하는지 확인

## 배포 시 주의사항

### GitHub Pages 배포 시

1. `js/config.js` 파일은 `.gitignore`에 추가되어 있으므로 Git에 커밋되지 않습니다.
2. **하지만** GitHub Pages는 정적 파일만 제공하므로, 배포 시 `js/config.js` 파일을 수동으로 추가해야 합니다.
3. 또는 GitHub Secrets를 사용하여 CI/CD 파이프라인에서 자동으로 생성

### 로컬 개발 시

1. `js/config.example.js`를 복사하여 `js/config.js` 생성
2. 실제 API 키 입력
3. `js/config.js`는 Git에 커밋하지 않음 (`.gitignore`에 포함됨)

## 보안 모범 사례

1. ✅ API 키를 환경 변수나 별도 설정 파일로 분리
2. ✅ `.gitignore`에 추가하여 Git에 커밋 방지
3. ✅ Google Cloud Console에서 HTTP 리퍼러 제한 설정
4. ✅ API 키에 최소 권한만 부여 (Generative Language API만)
5. ✅ 정기적으로 API 키 사용량 모니터링
6. ✅ 의심스러운 활동 발견 시 즉시 API 키 교체

## 참고

- 클라이언트 측 JavaScript에서는 API 키를 완전히 숨길 수 없습니다.
- 따라서 Google Cloud Console에서 API 키 제한 설정이 **필수**입니다.
- 백엔드 서버를 사용하는 경우, API 키를 서버 측에만 저장하는 것이 가장 안전합니다.
