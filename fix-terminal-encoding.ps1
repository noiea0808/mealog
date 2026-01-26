# PowerShell 인코딩 설정 (UTF-8)
# 이 스크립트를 실행하면 PowerShell의 출력 인코딩이 UTF-8로 설정됩니다

# 출력 인코딩을 UTF-8로 설정
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 코드페이지를 UTF-8로 변경 (CMD 호환)
chcp 65001 | Out-Null

Write-Host "✅ PowerShell 인코딩이 UTF-8로 설정되었습니다." -ForegroundColor Green
Write-Host ""
Write-Host "이제 한글이 정상적으로 표시됩니다." -ForegroundColor Cyan
Write-Host ""

# 현재 인코딩 확인
Write-Host "현재 출력 인코딩: $([Console]::OutputEncoding.EncodingName)" -ForegroundColor Yellow
