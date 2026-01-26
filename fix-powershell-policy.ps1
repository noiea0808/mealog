# PowerShell 실행 정책 변경 스크립트
# 관리자 권한으로 실행 필요

Write-Host "PowerShell 실행 정책 변경 중..." -ForegroundColor Cyan
Write-Host ""

# 현재 실행 정책 확인
$currentPolicy = Get-ExecutionPolicy
Write-Host "현재 실행 정책: $currentPolicy" -ForegroundColor Yellow

# 실행 정책을 RemoteSigned로 변경 (로컬 스크립트는 서명 없이 실행 가능)
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force

$newPolicy = Get-ExecutionPolicy
Write-Host "변경된 실행 정책: $newPolicy" -ForegroundColor Green

Write-Host ""
Write-Host "✅ 실행 정책이 변경되었습니다." -ForegroundColor Green
Write-Host "이제 npm과 PowerShell 스크립트를 실행할 수 있습니다." -ForegroundColor Cyan
