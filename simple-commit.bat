@echo off
chcp 65001 >nul
git add -A
git commit -m "feat: AI 코멘트 기능 추가 및 배포 설정"
git push origin main
pause
