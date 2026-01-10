# GitHub Pages 배포 설정 가이드

## GitHub Secrets 설정 방법

GitHub Actions를 사용하여 API 키를 안전하게 배포하기 위해 GitHub Secrets에 API 키를 저장해야 합니다.

### 1단계: GitHub Secrets에 API 키 추가

1. GitHub 저장소 페이지로 이동
2. **Settings** 탭 클릭
3. 왼쪽 메뉴에서 **Secrets and variables** > **Actions** 클릭
4. **New repository secret** 버튼 클릭
5. 다음과 같이 입력:
   - **Name**: `GEMINI_API_KEY`
   - **Secret**: `AIzaSyDT_awa47kigQ3VPrPcQmUy8nLSSpZJkpw` (실제 API 키)
6. **Add secret** 클릭

### 2단계: GitHub Pages 활성화

1. GitHub 저장소 페이지로 이동
2. **Settings** 탭 클릭
3. 왼쪽 메뉴에서 **Pages** 클릭
4. **Source** 섹션에서:
   - **Deploy from a branch** 선택
   - **Branch**: `gh-pages` 선택
   - **Folder**: `/ (root)` 선택
5. **Save** 클릭

### 3단계: 배포 확인

GitHub Actions workflow는 다음 경우에 자동으로 실행됩니다:
- `main` 또는 `master` 브랜치에 push할 때
- **Actions** 탭에서 수동으로 실행할 때

#### 배포 상태 확인:
1. GitHub 저장소 페이지에서 **Actions** 탭 클릭
2. 최신 workflow 실행 상태 확인
3. 성공하면 **Settings** > **Pages**에서 배포된 URL 확인

## 배포 방식 변경

기존의 `commit-and-push.bat` 방식 대신 GitHub Actions를 사용하므로:

### 새로운 배포 방법:
```bash
# 1. main 브랜치로 변경
git checkout main

# 2. 변경사항 커밋
git add .
git commit -m "feat: AI 코멘트 기능 추가"

# 3. main 브랜치에 푸시 (자동으로 GitHub Actions가 배포)
git push origin main
```

### 자동 배포 프로세스:
1. `main` 브랜치에 push
2. GitHub Actions workflow 자동 실행
3. Secrets에서 API 키 읽기
4. `js/config.js` 파일 자동 생성
5. GitHub Pages로 자동 배포

## 보안 주의사항

✅ **권장사항**:
- GitHub Secrets에만 API 키 저장
- 로컬 `js/config.js`는 `.gitignore`에 포함 (Git에 커밋되지 않음)
- GitHub Actions에서만 `js/config.js` 생성

⚠️ **주의사항**:
- GitHub Secrets는 저장소 관리자만 볼 수 있음
- 배포된 사이트의 `js/config.js`는 공개되지만, Google Cloud Console에서 API 키 제한 설정으로 보완
- API 키 제한 설정은 `API_KEY_SECURITY.md` 참고

## 트러블슈팅

### 배포가 실패하는 경우:
1. **Secrets가 설정되지 않았는지 확인**
   - Settings > Secrets and variables > Actions에서 `GEMINI_API_KEY` 확인

2. **GitHub Pages가 활성화되었는지 확인**
   - Settings > Pages에서 설정 확인

3. **Workflow 로그 확인**
   - Actions 탭에서 실패한 workflow 클릭
   - 로그에서 오류 메시지 확인

### API 키가 작동하지 않는 경우:
1. Google Cloud Console에서 API 키 제한 설정 확인
   - HTTP 리퍼러에 GitHub Pages 도메인 추가: `https://*.github.io/*`
   
2. 배포된 사이트에서 브라우저 콘솔 확인
   - F12 > Console에서 API 오류 메시지 확인
