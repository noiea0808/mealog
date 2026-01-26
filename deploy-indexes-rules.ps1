# Firestore 인덱스 및 Rules 배포 스크립트 (비대화형)

# UTF-8 인코딩 설정 (한글 깨짐 방지)
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Firestore 인덱스 및 Rules 배포" -ForegroundColor Cyan
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
    Write-Host "다음 명령어로 설치해주세요: npm install -g firebase-tools" -ForegroundColor Yellow
    exit 1
}

# Firebase 경로 확인
$firebasePath = (Get-Command firebase -ErrorAction SilentlyContinue).Source
if (-not $firebasePath) {
    # npm 전역 경로에서 찾기
    $npmPrefix = npm config get prefix 2>$null
    if ($npmPrefix) {
        $firebasePath = Join-Path $npmPrefix "firebase.cmd"
        if (-not (Test-Path $firebasePath)) {
            Write-Host "[오류] firebase 명령어를 찾을 수 없습니다." -ForegroundColor Red
            Write-Host "다음 명령어로 설치해주세요: npm install -g firebase-tools" -ForegroundColor Yellow
            exit 1
        }
    } else {
        Write-Host "[오류] firebase 명령어를 찾을 수 없습니다." -ForegroundColor Red
        exit 1
    }
}

Write-Host "[확인] Firebase CLI 경로: $firebasePath" -ForegroundColor Gray
Write-Host ""

# Firebase 로그인 확인
Write-Host "[0/2] Firebase 로그인 확인 중..." -ForegroundColor Cyan
$loginCheck = & $firebasePath projects:list 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "[오류] Firebase에 로그인되어 있지 않습니다." -ForegroundColor Red
    Write-Host "다음 명령어로 로그인해주세요:" -ForegroundColor Yellow
    Write-Host "  firebase login" -ForegroundColor White
    Write-Host ""
    Write-Host "로그인을 진행하시겠습니까? (Y/N)" -ForegroundColor Yellow
    $response = Read-Host
    if ($response -eq 'Y' -or $response -eq 'y') {
        & $firebasePath login
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[오류] Firebase 로그인에 실패했습니다." -ForegroundColor Red
            exit 1
        }
    } else {
        exit 1
    }
} else {
    Write-Host "[확인] Firebase에 로그인되어 있습니다." -ForegroundColor Green
}

# Firestore 인덱스 배포
Write-Host ""
Write-Host "[1/2] Firestore 인덱스 배포 중..." -ForegroundColor Cyan
$indexResult = & $firebasePath deploy --only firestore:indexes 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "[오류] Firestore 인덱스 배포에 실패했습니다." -ForegroundColor Red
    Write-Host $indexResult
    exit 1
}
Write-Host "[완료] Firestore 인덱스 배포 완료" -ForegroundColor Green

# Firestore Rules 배포
Write-Host ""
Write-Host "[2/2] Firestore Rules 배포 중..." -ForegroundColor Cyan
$rulesResult = & $firebasePath deploy --only firestore:rules 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "[오류] Firestore Rules 배포에 실패했습니다." -ForegroundColor Red
    Write-Host $rulesResult
    exit 1
}
Write-Host "[완료] Firestore Rules 배포 완료" -ForegroundColor Green

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "배포가 완료되었습니다!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
