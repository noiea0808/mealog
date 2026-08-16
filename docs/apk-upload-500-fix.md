# APK 업로드 500 에러 해결 (getApkUploadUrl)

`getApkUploadUrl` 호출 시 500 에러가 나면, Cloud Functions 서비스 계정에 **서명 권한**이 없기 때문입니다.

## 해결 방법

### 1. Google Cloud Console에서 IAM 설정

1. [Google Cloud Console](https://console.cloud.google.com/) 접속
2. 프로젝트 **mealog-r0** 선택
3. **IAM 및 관리자** → **IAM** 메뉴
4. **권한** 탭에서 Cloud Functions가 사용하는 서비스 계정 찾기:
   - `mealog-r0@appspot.gserviceaccount.com` (App Engine 기본)
   - 또는 `프로젝트번호-compute@developer.gserviceaccount.com`

### 2. Service Account Token Creator 역할 부여

**방법 A: gcloud 명령어 (권장)**

```bash
# 프로젝트 설정
gcloud config set project mealog-r0

# App Engine 기본 서비스 계정에 역할 부여
gcloud iam service-accounts add-iam-policy-binding mealog-r0@appspot.gserviceaccount.com \
  --member="serviceAccount:mealog-r0@appspot.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

**방법 B: 콘솔에서 수동 설정**

1. **IAM 및 관리자** → **IAM**
2. `mealog-r0@appspot.gserviceaccount.com` 항목의 **연필(편집)** 클릭
3. **다른 역할 추가** → `Service Account Token Creator` 검색 후 선택
4. 저장

### 3. IAM Service Account Credentials API 활성화

1. [API 라이브러리](https://console.cloud.google.com/apis/library) 이동
2. "IAM Service Account Credentials API" 검색
3. **사용** 클릭 (이미 사용 중이면 표시됨)

### 4. Functions 재배포 (필요 시)

권한 변경 후 즉시 적용되는 경우가 많습니다. 그래도 500이 계속되면:

```bash
firebase deploy --only functions:getApkUploadUrl
```

## CORS 설정 (업로드 시 "blocked by CORS policy" 에러)

Signed URL까지 성공했는데 **브라우저에서 CORS 에러**가 나면, Storage 버킷에 CORS 설정이 필요합니다.

### Google Cloud Shell에서 실행 (권장)

1. [Google Cloud Console](https://console.cloud.google.com/) 접속
2. 프로젝트 **mealog-r0** 선택
3. 상단 **Cloud Shell 열기** (터미널 아이콘) 클릭
4. 아래 명령 실행:

```bash
# CORS 설정 적용 (버킷 이름 확인: Firebase Storage 기본은 project.appspot.com)
gcloud storage buckets update gs://mealog-r0.firebasestorage.app --cors-file=config/storage-cors.json
```

또는 `gsutil` 사용 시:

```bash
gsutil cors set config/storage-cors.json gs://mealog-r0.firebasestorage.app
```

`storage-cors.json` 내용은 `config/storage-cors.json`을 참고하세요.

---

## 참고

- `getSignedUrl`은 v4 서명을 위해 `iam.serviceAccounts.signBlob` 권한이 필요합니다.
- 이 권한은 **Service Account Token Creator** 역할에 포함됩니다.
