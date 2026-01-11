@echo off
chcp 65001 >nul
git add -A
git commit -m "feat: AI 코멘트 기능 추가 (Gemini API 연동)"
git push origin main
if errorlevel 1 git push origin master
pause
