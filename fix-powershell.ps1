# PowerShell 프로파일 오류 수정 스크립트
# 관리자 권한으로 실행 필요

Write-Host "PowerShell 프로파일 문제 해결 중..." -ForegroundColor Cyan

# 프로파일 경로 확인
$profilePath = $PROFILE.CurrentUserAllHosts

Write-Host "현재 프로파일 경로: $profilePath" -ForegroundColor Yellow

# 프로파일 백업
if (Test-Path $profilePath) {
    $backupPath = "$profilePath.backup.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $profilePath $backupPath -Force
    Write-Host "기존 프로파일을 백업했습니다: $backupPath" -ForegroundColor Green
}

# 프로파일 디렉토리 생성
$profileDir = Split-Path $profilePath -Parent
if (-not (Test-Path $profileDir)) {
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    Write-Host "프로파일 디렉토리를 생성했습니다: $profileDir" -ForegroundColor Green
}

# 최소한의 안전한 프로파일 생성
$minimalProfile = @"
# PowerShell 프로파일 - 최소 설정
# Cursor Git 커밋을 위한 기본 설정

`$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8
"@

Set-Content -Path $profilePath -Value $minimalProfile -Encoding UTF8 -Force
Write-Host "프로파일을 재생성했습니다: $profilePath" -ForegroundColor Green

Write-Host "`n완료! 이제 Cursor를 재시작하세요." -ForegroundColor Cyan
Write-Host "Press any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
