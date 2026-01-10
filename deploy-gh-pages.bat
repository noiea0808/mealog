@echo off
chcp 65001
git add -A
git commit -m "refactor: analytics.js 모듈화 및 UI 개선"
git checkout -b gh-pages 2>nul
git add -A
git commit -m "refactor: analytics.js 모듈화 및 UI 개선"
git push origin gh-pages --force
