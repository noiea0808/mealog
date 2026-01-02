# mealog 웹 서버 시작 스크립트
$port = 8000
$path = $PSScriptRoot

Write-Host "Starting web server on port $port" -ForegroundColor Green
Write-Host "Serving files from: $path" -ForegroundColor Cyan
Write-Host ""
Write-Host "Access your app at: http://localhost:$port" -ForegroundColor Yellow
Write-Host "Press Ctrl+C to stop the server" -ForegroundColor Gray
Write-Host ""

# 관리자 권한 확인
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "경고: 관리자 권한이 필요할 수 있습니다." -ForegroundColor Yellow
    Write-Host "연결이 거부되면 PowerShell을 관리자 권한으로 실행하세요." -ForegroundColor Yellow
    Write-Host ""
}

# 방화벽 예외 추가 시도
try {
    $firewall = New-Object -ComObject HNetCfg.FwMgr
    $firewall.LocalPolicy.CurrentProfile
} catch {
    Write-Host "방화벽 설정을 확인할 수 없습니다." -ForegroundColor Yellow
}

$listener = New-Object System.Net.HttpListener
try {
    $listener.Prefixes.Add("http://localhost:$port/")
    $listener.Start()
    Write-Host "서버가 성공적으로 시작되었습니다!" -ForegroundColor Green
} catch {
    Write-Host "서버 시작 실패: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "해결 방법:" -ForegroundColor Yellow
    Write-Host "1. PowerShell을 관리자 권한으로 실행" -ForegroundColor White
    Write-Host "2. 또는 start-server-simple.bat 파일 사용 (Python 필요)" -ForegroundColor White
    Write-Host ""
    pause
    exit
}

# 서버가 준비될 때까지 잠시 대기 후 브라우저 자동 열기
Start-Sleep -Milliseconds 500
try {
    Start-Process "http://localhost:$port"
    Write-Host "Browser opened automatically!" -ForegroundColor Green
} catch {
    Write-Host "Could not open browser automatically. Please open http://localhost:$port manually" -ForegroundColor Yellow
}

while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response

    $requestedPath = $request.Url.LocalPath
    if ($requestedPath -eq "/") {
        $requestedPath = "/index.html"
    }
    $filePath = Join-Path $path $requestedPath.TrimStart('/')

    if (Test-Path $filePath -PathType Leaf) {
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        $response.ContentType = switch ([System.IO.Path]::GetExtension($filePath)) {
            ".html" { "text/html; charset=utf-8" }
            ".css"  { "text/css; charset=utf-8" }
            ".js"   { "application/javascript; charset=utf-8" }
            ".png"  { "image/png" }
            ".jpg"  { "image/jpeg" }
            default { "application/octet-stream" }
        }
        $response.ContentLength64 = $bytes.Length
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
        $response.StatusCode = 404
        $response.StatusDescription = "Not Found"
        $notFoundContent = "<h1>404 Not Found</h1>"
        $notFoundBytes = [System.Text.Encoding]::UTF8.GetBytes($notFoundContent)
        $response.ContentType = "text/html; charset=utf-8"
        $response.ContentLength64 = $notFoundBytes.Length
        $response.OutputStream.Write($notFoundBytes, 0, $notFoundBytes.Length)
    }
    $response.Close()
}

