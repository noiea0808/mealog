# mealog 웹 서버
# 인코딩 설정 (한글 깨짐 방지)
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['*:Encoding'] = 'utf8'

$port = 8000
$path = Get-Location

# 로컬 IP 주소 가져오기
$localIP = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -like "192.168.*" -or $_.IPAddress -like "10.*" -or $_.IPAddress -like "172.*"} | Select-Object -First 1).IPAddress
if (-not $localIP) {
    $localIP = "Local IP not found"
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  mealog Web Server" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Access from computer:" -ForegroundColor Yellow
Write-Host "  http://localhost:$port" -ForegroundColor White
Write-Host ""
Write-Host "Access from smartphone (same Wi-Fi required):" -ForegroundColor Yellow
Write-Host "  http://$localIP`:$port" -ForegroundColor White
Write-Host ""
Write-Host "Server location: $path" -ForegroundColor Gray
Write-Host ""

$listener = New-Object System.Net.HttpListener

# localhost만 사용 (관리자 권한 불필요, 충돌 없음)
# 스마트폰 접속이 필요하면 setup-admin.bat 실행 후 주석 해제
$listener.Prefixes.Add("http://localhost:$port/")

# 모든 인터페이스에서 수신 (주석 해제하면 스마트폰 접속 가능, setup-admin.bat 필요)
# $listener.Prefixes.Add("http://+:$port/")

try {
    $listener.Start()
    
    # 성공적으로 시작
    Write-Host "✓ Server started successfully!" -ForegroundColor Green
    Write-Host "  Listening on http://localhost:$port" -ForegroundColor Green
    Write-Host ""
    Write-Host "Note: Smartphone access disabled by default." -ForegroundColor Gray
    Write-Host "  To enable: Run setup-admin.bat as Administrator, then uncomment line 38 in server.ps1" -ForegroundColor Gray
    Write-Host ""
    
    # 브라우저 자동 열기
    Start-Sleep -Milliseconds 800
    Start-Process "http://localhost:$port"
    Write-Host "Browser opened." -ForegroundColor Green
    Write-Host ""
    Write-Host "To access from smartphone:" -ForegroundColor Cyan
    Write-Host "  1. Make sure smartphone and computer are on same Wi-Fi" -ForegroundColor White
    Write-Host "  2. Enter the address above in smartphone browser" -ForegroundColor White
    Write-Host ""
    Write-Host "Press Ctrl+C to stop the server" -ForegroundColor Gray
    Write-Host ""
    
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        
        # OPTIONS 요청 처리 (CORS preflight)
        if ($request.HttpMethod -eq "OPTIONS") {
            $response.AddHeader("Access-Control-Allow-Origin", "*")
            $response.AddHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            $response.AddHeader("Access-Control-Allow-Headers", "Content-Type")
            $response.StatusCode = 200
            $response.Close()
            continue
        }
        
        $requestedPath = $request.Url.LocalPath
        if ($requestedPath -eq "/") {
            $requestedPath = "/index.html"
        }
        
        $filePath = Join-Path $path $requestedPath.TrimStart('/')
        
        # 디버깅용 로그 (선택적)
        # Write-Host "[$($request.HttpMethod)] $requestedPath" -ForegroundColor Gray
        
        if (Test-Path $filePath -PathType Leaf) {
            $bytes = [System.IO.File]::ReadAllBytes($filePath)
            $ext = [System.IO.Path]::GetExtension($filePath)
            
            # CORS 헤더 추가 (모든 파일에)
            $response.AddHeader("Access-Control-Allow-Origin", "*")
            $response.AddHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            $response.AddHeader("Access-Control-Allow-Headers", "Content-Type")
            
            $contentType = switch ($ext) {
                ".html" { "text/html; charset=utf-8" }
                ".css"  { "text/css; charset=utf-8" }
                ".js"   { "application/javascript; charset=utf-8" }
                ".mjs"  { "application/javascript; charset=utf-8" }
                ".png"  { "image/png" }
                ".jpg"  { "image/jpeg" }
                ".jpeg" { "image/jpeg" }
                ".json" { "application/json; charset=utf-8" }
                default { "application/octet-stream" }
            }
            $response.ContentType = $contentType
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $response.StatusCode = 404
            $response.StatusDescription = "Not Found"
            $notFoundContent = "<h1>404 Not Found</h1><p>File: $requestedPath</p>"
            $notFoundBytes = [System.Text.Encoding]::UTF8.GetBytes($notFoundContent)
            $response.ContentType = "text/html; charset=utf-8"
            $response.ContentLength64 = $notFoundBytes.Length
            $response.OutputStream.Write($notFoundBytes, 0, $notFoundBytes.Length)
        }
        $response.Close()
    }
} catch {
    $errorMsg = $_.Exception.Message
    Write-Host "✗ Error occurred:" -ForegroundColor Red
    Write-Host $errorMsg -ForegroundColor Red
    Write-Host ""
    
    if ($errorMsg -like "*conflicts with an existing registration*") {
        Write-Host "⚠ Port 8000 URL reservation conflict detected!" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "Solutions:" -ForegroundColor Yellow
        Write-Host "1. Run remove-reservation.bat as Administrator to remove old reservation" -ForegroundColor White
        Write-Host "2. Or check what's using the port: run check-port.bat" -ForegroundColor White
        Write-Host "3. Or use a different port (edit server.ps1, change `$port variable)" -ForegroundColor White
    } elseif ($errorMsg -like "*Access is denied*") {
        Write-Host "⚠ Access denied!" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "Solutions:" -ForegroundColor Yellow
        Write-Host "1. Run setup-admin.bat as Administrator (one-time setup)" -ForegroundColor White
        Write-Host "2. Or run this script as Administrator" -ForegroundColor White
        Write-Host "3. Server will still work on localhost without admin rights" -ForegroundColor White
    } else {
        Write-Host "Solutions:" -ForegroundColor Yellow
        Write-Host "1. Port $port may already be in use." -ForegroundColor White
        Write-Host "2. Try running PowerShell as Administrator." -ForegroundColor White
        Write-Host "3. Try using a different port (edit server.ps1, change `$port variable)." -ForegroundColor White
        Write-Host "4. Use start-localhost.bat for localhost-only mode (no admin needed)" -ForegroundColor White
    }
    Write-Host ""
    Write-Host "Press any key to exit..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}

