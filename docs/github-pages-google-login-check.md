# 운영 구글 로그인 여전히 안 될 때 점검

## 1. GitHub Pages 배포 방식 확인 (가장 흔한 원인)

**저장소 → Settings → Pages → Build and deployment → Source**

- **"GitHub Actions"** 로 되어 있어야 합니다.
- **"Deploy from a branch"** 로 되어 있으면, 우리가 수정한 워크플로가 **전혀 사용되지 않고**, 브랜치 파일 그대로 올라갑니다.  
  이때 `config.js`는 `.gitignore`에 있어서 저장소에 없으므로, 배포된 사이트에도 없거나 비어 있어 구글 로그인이 안 됩니다.

**해결**: Source를 **"GitHub Actions"**로 바꾼 뒤 저장. 그다음 main에 빈 커밋이라도 푸시해서 워크플로가 한 번 돌게 하세요.

---

## 2. 시크릿이 워크플로에 전달되는지 확인

배포 워크플로는 `environment: github-pages` 를 사용합니다.  
이 경우 **Environment 쪽 시크릿**만 쓰일 수 있으므로, 다음 둘 다 확인하세요.

1. **Repository secrets**  
   Settings → Secrets and variables → **Actions** → Repository secrets  
   → `GOOGLE_WEB_CLIENT_ID` 있는지, 이름/대소문자 정확한지.

2. **Environment secrets**  
   Settings → **Environments** → **github-pages** → **Environment secrets**  
   → 여기에도 `GOOGLE_WEB_CLIENT_ID` 를 **같은 이름으로** 추가해 보세요.  
   (환경을 쓰면 환경 시크릿이 우선이라, 여기 없으면 비어 있을 수 있음.)

---

## 3. Actions 로그로 시크릿 적용 여부 확인

**Actions** 탭 → 가장 최근 **"Deploy to GitHub Pages"** 실행 → **"Create config.js from Secrets"** 단계 클릭.

- **"GOOGLE_WEB_CLIENT_ID: (비어 있음)"** 이면 → 위 1, 2번 다시 확인.
- **"GOOGLE_WEB_CLIENT_ID: 설정됨 (길이 XX)"** 이면 → 시크릿은 들어가고 있는 것이므로, 배포된 URL/캐시 문제일 수 있음.

---

## 4. 배포된 config.js 직접 확인

배포가 끝난 뒤 브라우저에서:

- `https://www.mealog.net/js/config.js`  
  (실제 운영 도메인이 다르면 그 도메인으로)

를 열어서 `GOOGLE_WEB_CLIENT_ID` 가 `'...'` 안에 실제 ID로 들어가 있는지 확인하세요.  
비어 있거나 `''` 이면 배포 단계에서 시크릿이 안 들어간 것입니다.

---

## 5. 요약 체크리스트

| 항목 | 확인 |
|------|------|
| Pages Source = **GitHub Actions** | |
| Repository secrets에 `GOOGLE_WEB_CLIENT_ID` | |
| Environments → github-pages → Environment secrets에 `GOOGLE_WEB_CLIENT_ID` | |
| Actions 로그에서 "설정됨 (길이 XX)" 표시 | |
| 배포 후 운영 URL의 `/js/config.js` 에 ID 들어감 | |
