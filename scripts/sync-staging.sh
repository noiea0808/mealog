#!/usr/bin/env bash
# 로컬에서 최신 staging 받기 — 작업 시작 전 실행
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "→ fetch origin"
git fetch origin --prune

echo "→ checkout staging"
git checkout staging

echo "→ pull origin/staging"
git pull origin staging

echo ""
echo "✅ staging 동기화 완료 ($(git rev-parse --short HEAD))"
git log --oneline -3
