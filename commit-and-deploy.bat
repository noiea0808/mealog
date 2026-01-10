@echo off
chcp 65001 >nul
echo ========================================
echo   MEALOG Git 커밋 및 배포
echo ========================================
echo.

echo [1/4] 변경사항 확인 중...
git status --short
echo.

echo [2/4] 변경사항 스테이징 중...
git add -A
echo.

echo [3/4] 커밋 중...
git commit -m "feat: AI 코멘트 기능 추가 (Gemini API 연동)

- 분석탭 인사이트에 AI 기반 코멘트 기능 추가
- Gemini 2.5 Flash/Flash-Lite 모델 사용
- 캐릭터별 페르소나 적용 (MEALOG, 엄격한 트레이너)
- 페이지네이션 및 UI 개선 (최대 3페이지, 클릭으로 페이지 전환)
- GitHub Secrets를 사용한 API 키 보안 관리
- manifest.json 및 sw.js 파일 추가
- config.js 자동 생성 workflow 추가"
echo.

echo [4/4] GitHub에 푸시 중...
git push origin main
if %errorlevel% neq 0 (
    echo.
    echo ❌ 푸시 실패. main 브랜치가 없을 수 있습니다.
    echo master 브랜치로 푸시를 시도합니다...
    git push origin master
)
echo.

echo ========================================
echo   ✅ 커밋 및 푸시 완료!
echo ========================================
echo.
echo 📝 다음 단계:
echo    1. GitHub Actions에서 배포 상태 확인
echo    2. Settings > Pages에서 배포된 URL 확인
echo    3. 배포된 페이지에서 기능 테스트
echo.
pause
