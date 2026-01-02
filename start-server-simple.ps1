# 간단한 웹 서버 (Python 사용)
$port = 8000
$path = $PSScriptRoot

Write-Host "=== mealog 웹 서버 시작 ===" -ForegroundColor Cyan
Write-Host ""

# Python이 설치되어 있는지 확인
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    $python = Get-Command python3 -ErrorAction SilentlyContinue
}

if ($python) {
    Write-Host "Python을 사용하여 웹 서버를 시작합니다..." -ForegroundColor Green
    Write-Host "서버 주소: http://localhost:$port" -ForegroundColor Yellow
    Write-Host "브라우저를 자동으로 엽니다..." -ForegroundColor Green
    Write-Host ""
    Write-Host "서버를 중지하려면 Ctrl+C를 누르세요" -ForegroundColor Gray
    Write-Host ""
    
    # 브라우저 열기 (약간의 지연 후)
    Start-Job -ScriptBlock {
        Start-Sleep -Seconds 1
        Start-Process "http://localhost:$port"
    } | Out-Null
    
    # Python 웹 서버 시작
    Set-Location $path
    python -m http.server $port
} else {
    Write-Host "Python이 설치되어 있지 않습니다." -ForegroundColor Red
    Write-Host ""
    Write-Host "대안 1: Node.js 사용" -ForegroundColor Yellow
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        Write-Host "Node.js를 사용하여 웹 서버를 시작합니다..." -ForegroundColor Green
        Start-Job -ScriptBlock {
            Start-Sleep -Seconds 1
            Start-Process "http://localhost:$port"
        } | Out-Null
        npx --yes http-server $path -p $port -o
    } else {
        Write-Host "대안 2: PowerShell HttpListener (관리자 권한 필요)" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "PowerShell을 관리자 권한으로 실행한 후 다시 시도하세요." -ForegroundColor Red
        Write-Host "또는 Python을 설치하세요: https://www.python.org/downloads/" -ForegroundColor Yellow
        pause
    }
}

