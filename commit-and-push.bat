@echo off
chcp 65001 >nul
echo 변경사항 스테이징 중...
git add -A

echo 커밋 중...
git commit -m "refactor: analytics.js 모듈화 및 UI 개선

- analytics.js를 5개 모듈로 분리 (charts, dashboard, insight, best-share, date-utils)
- Comment 입력 필드를 textarea로 변경하여 여러 줄 입력 및 줄바꿈 지원
- 하단 탭 순서 변경: 분석 > 타임라인 > 앨범
- 페이지 진입 시 기본 탭을 타임라인으로 설정
- 순환 참조 문제 해결 및 import 경로 정리"

echo 현재 브랜치 확인 중...
git branch

echo gh-pages 브랜치로 체크아웃 또는 생성 중...
git checkout -b gh-pages 2>nul || git checkout gh-pages

echo 변경사항을 gh-pages 브랜치에 커밋...
git add -A
git commit -m "refactor: analytics.js 모듈화 및 UI 개선" || echo "변경사항 없음 또는 이미 커밋됨"

echo GitHub에 푸시 중...
git push origin gh-pages --force

echo 완료!
pause
