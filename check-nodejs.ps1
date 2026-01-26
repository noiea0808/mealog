# Node.js 설치 확인 스크립트

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Node.js 설치 확인" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# PowerShell에서 Node.js 확인
Write-Host "[PowerShell에서 확인]" -ForegroundColor Yellow
try {
    $nodeVersion = node --version 2>&1
    Write-Host "✅ Node.js 버전: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "❌ Node.js가 설치되어 있지 않습니다." -ForegroundColor Red
}

try {
    $npmVersion = npm --version 2>&1
    Write-Host "✅ npm 버전: $npmVersion" -ForegroundColor Green
} catch {
    Write-Host "❌ npm이 설치되어 있지 않습니다." -ForegroundColor Red
}

Write-Host ""
Write-Host "[설치 경로 확인]" -ForegroundColor Yellow
$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($nodePath) {
    Write-Host "Node.js 경로: $nodePath" -ForegroundColor Cyan
} else {
    Write-Host "Node.js 경로를 찾을 수 없습니다." -ForegroundColor Red
}

$npmPath = (Get-Command npm -ErrorAction SilentlyContinue).Source
if ($npmPath) {
    Write-Host "npm 경로: $npmPath" -ForegroundColor Cyan
} else {
    Write-Host "npm 경로를 찾을 수 없습니다." -ForegroundColor Red
}

Write-Host ""
Write-Host "[환경 변수 확인]" -ForegroundColor Yellow
$envPath = $env:PATH -split ';' | Where-Object { $_ -like '*node*' -or $_ -like '*npm*' }
if ($envPath) {
    Write-Host "PATH에 Node.js 관련 경로:" -ForegroundColor Cyan
    $envPath | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
} else {
    Write-Host "PATH에 Node.js 관련 경로가 없습니다." -ForegroundColor Red
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
if ($nodePath -and $npmPath) {
    Write-Host "✅ Node.js와 npm이 설치되어 있습니다." -ForegroundColor Green
    Write-Host ""
    Write-Host "Git Bash에서 사용하려면:" -ForegroundColor Yellow
    Write-Host "1. Git Bash를 재시작하거나" -ForegroundColor White
    Write-Host "2. 다음 명령어로 PATH를 추가하세요:" -ForegroundColor White
    Write-Host "   export PATH=`"/c/Program Files/nodejs:`$PATH`"" -ForegroundColor Cyan
} else {
    Write-Host "❌ Node.js를 설치해야 합니다." -ForegroundColor Red
    Write-Host ""
    Write-Host "다음 단계:" -ForegroundColor Yellow
    Write-Host "1. https://nodejs.org 접속" -ForegroundColor White
    Write-Host "2. LTS 버전 다운로드 및 설치" -ForegroundColor White
    Write-Host "3. 설치 후 터미널 재시작" -ForegroundColor White
}
Write-Host "========================================" -ForegroundColor Cyan
