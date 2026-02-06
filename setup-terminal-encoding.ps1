# PowerShell 프로파일에 인코딩 설정 추가
# 이 스크립트를 한 번 실행하면 이후 PowerShell 세션에서 자동으로 UTF-8이 적용됩니다

$profilePath = $PROFILE.CurrentUserAllHosts
$profileDir = Split-Path $profilePath -Parent

# 프로파일 디렉토리 생성
if (-not (Test-Path $profileDir)) {
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    Write-Host "프로파일 디렉토리 생성: $profileDir" -ForegroundColor Green
}

# 인코딩 설정 코드
$encodingCode = @"
# UTF-8 인코딩 설정
`$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null
"@

# 기존 프로파일 읽기
$existingContent = ""
if (Test-Path $profilePath) {
    $existingContent = Get-Content $profilePath -Raw -Encoding UTF8
    Write-Host "기존 프로파일 발견: $profilePath" -ForegroundColor Yellow
}

# 인코딩 설정이 이미 있는지 확인
if ($existingContent -notmatch "UTF-8 인코딩 설정") {
    # 프로파일 끝에 인코딩 설정 추가
    $newContent = $existingContent + "`n`n" + $encodingCode
    Set-Content -Path $profilePath -Value $newContent -Encoding UTF8 -Force
    Write-Host "✅ 프로파일에 UTF-8 인코딩 설정이 추가되었습니다." -ForegroundColor Green
    Write-Host "다음 PowerShell 세션부터 자동으로 적용됩니다." -ForegroundColor Cyan
} else {
    Write-Host "✅ 프로파일에 이미 UTF-8 인코딩 설정이 있습니다." -ForegroundColor Green
}

Write-Host ""
Write-Host "프로파일 경로: $profilePath" -ForegroundColor Yellow
Write-Host ""
Write-Host "즉시 적용하려면 다음 명령어를 실행하세요:" -ForegroundColor Cyan
Write-Host "  . `$PROFILE" -ForegroundColor White
