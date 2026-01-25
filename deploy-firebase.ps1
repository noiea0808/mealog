# Firebase Functions 및 Rules 배포 스크립트 (PowerShell)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Firebase Functions 및 Rules 배포 스크립트" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 현재 디렉토리로 이동
Set-Location $PSScriptRoot

# Firebase CLI 확인
try {
    $firebaseVersion = firebase --version 2>&1
    Write-Host "[확인] Firebase CLI 버전: $firebaseVersion" -ForegroundColor Green
} catch {
    Write-Host "[오류] Firebase CLI가 설치되어 있지 않습니다." -ForegroundColor Red
    Write-Host "다음 명령어로 설치해주세요:" -ForegroundColor Yellow
    Write-Host "npm install -g firebase-tools" -ForegroundColor Yellow
    Read-Host "계속하려면 Enter를 누르세요"
    exit 1
}

# Node.js 확인
try {
    $nodeVersion = node --version 2>&1
    Write-Host "[확인] Node.js 버전: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "[오류] Node.js가 설치되어 있지 않습니다." -ForegroundColor Red
    Write-Host "https://nodejs.org 에서 Node.js를 설치해주세요." -ForegroundColor Yellow
    Read-Host "계속하려면 Enter를 누르세요"
    exit 1
}

# Firebase 로그인 확인
Write-Host ""
Write-Host "[1/4] Firebase 로그인 확인..." -ForegroundColor Cyan
try {
    firebase projects:list | Out-Null
    Write-Host "[확인] Firebase에 로그인되어 있습니다." -ForegroundColor Green
} catch {
    Write-Host "Firebase에 로그인하지 않았습니다. 로그인을 진행합니다..." -ForegroundColor Yellow
    firebase login
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[오류] Firebase 로그인에 실패했습니다." -ForegroundColor Red
        Read-Host "계속하려면 Enter를 누르세요"
        exit 1
    }
}

# Functions 의존성 설치
Write-Host ""
Write-Host "[2/4] Functions 의존성 설치..." -ForegroundColor Cyan
Set-Location functions
if (-not (Test-Path "node_modules")) {
    Write-Host "npm install 실행 중..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[오류] npm install에 실패했습니다." -ForegroundColor Red
        Set-Location ..
        Read-Host "계속하려면 Enter를 누르세요"
        exit 1
    }
} else {
    Write-Host "[확인] node_modules가 이미 존재합니다. 건너뜁니다." -ForegroundColor Green
}
Set-Location ..

# Cloud Functions 배포
Write-Host ""
Write-Host "[3/4] Cloud Functions 배포..." -ForegroundColor Cyan
firebase deploy --only functions
if ($LASTEXITCODE -ne 0) {
    Write-Host "[오류] Functions 배포에 실패했습니다." -ForegroundColor Red
    Read-Host "계속하려면 Enter를 누르세요"
    exit 1
}

# Firestore Rules 배포
Write-Host ""
Write-Host "[4/4] Firestore Rules 배포..." -ForegroundColor Cyan
firebase deploy --only firestore:rules
if ($LASTEXITCODE -ne 0) {
    Write-Host "[오류] Firestore Rules 배포에 실패했습니다." -ForegroundColor Red
    Read-Host "계속하려면 Enter를 누르세요"
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "배포가 완료되었습니다!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Read-Host "계속하려면 Enter를 누르세요"
