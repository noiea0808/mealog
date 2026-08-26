# mealog 웹 서버
# 인코딩 설정 (한글 깨짐 방지)
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['*:Encoding'] = 'utf8'

$port = 8000
$path = Get-Location

# 치명적 오류를 파일에도 남긴다.
# 이 서버는 콘솔 없이 고아 프로세스로 남는 일이 잦은데(부모가 먼저 죽는다), 그러면
# Write-Host 는 끊어진 파이프로 나가 아무도 못 본다. 로그가 유일한 단서가 된다.
$errorLogPath = Join-Path $path 'tools\server-error.log'

function Write-ServerError {
    param([string]$Message, $ErrorRecord)

    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    if ($ErrorRecord) {
        $line += " :: {0}: {1}" -f $ErrorRecord.Exception.GetType().Name, $ErrorRecord.Exception.Message
    }
    # 끊어진 파이프에 쓰면 예외가 난다 — 로그 실패가 서버를 죽이지 않게 둘 다 감싼다.
    try { Write-Host $line -ForegroundColor DarkYellow } catch { }
    try { Add-Content -LiteralPath $errorLogPath -Value $line -Encoding utf8 } catch { }
}

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

    # 브라우저 자동 열기 (비활성화 - 배치 파일에서 처리)
    # Start-Sleep -Milliseconds 800
    # Start-Process "http://localhost:$port"
    # Write-Host "Browser opened." -ForegroundColor Green
    Write-Host ""
    Write-Host "To access from smartphone:" -ForegroundColor Cyan
    Write-Host "  1. Make sure smartphone and computer are on same Wi-Fi" -ForegroundColor White
    Write-Host "  2. Enter the address above in smartphone browser" -ForegroundColor White
    Write-Host ""
    Write-Host "Press Ctrl+C to stop the server" -ForegroundColor Gray
    Write-Host ""

    while ($listener.IsListening) {
        # GetContext 실패는 「리스너가 멈췄다」는 뜻 — 오류가 아니라 정상 종료로 다룬다.
        try {
            $context = $listener.GetContext()
        }
        catch [System.Net.HttpListenerException] { break }
        catch [System.ObjectDisposedException] { break }

        $request = $context.Request
        $response = $context.Response

        <#
          요청 하나의 실패가 서버 전체를 죽이지 않게 per-request 로 가둔다.

          2026-08-17: 이 try 가 루프 바깥에만 있어서 예외 한 번에 서빙이 영구 중단됐다.
          그런데 프로세스는 살아 있고 listener.Stop() 도 불리지 않아, http.sys 가 포트
          예약을 계속 붙든 채 요청을 큐에만 쌓았다. 브라우저에는 연결 거부가 아니라
          「연결은 되는데 응답이 없는」 상태로 보여서(흰 화면, 120초 뒤 reset) 서버가
          죽은 줄도 모르고 앱 코드를 의심하게 된다. 죽으려면 눈에 띄게 죽어야 한다.

          터지는 지점은 최소 둘:
            - ReadAllBytes: git pull 등으로 파일이 교체되는 순간
            - OutputStream.Write: 로딩 중 새로고침·이탈로 연결이 끊긴 순간
        #>
        try {
            if ($request.HttpMethod -eq "OPTIONS") {
                # OPTIONS 요청 처리 (CORS preflight)
                $response.AddHeader("Access-Control-Allow-Origin", "*")
                $response.AddHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                $response.AddHeader("Access-Control-Allow-Headers", "Content-Type")
                $response.StatusCode = 200
            }
            else {
                $requestedPath = $request.Url.LocalPath
                if ($requestedPath -eq "/") {
                    $requestedPath = "/index.html"
                }

                $filePath = Join-Path $path $requestedPath.TrimStart('/')

                # 디버깅용 로그 (선택적)
                # Write-Host "[$($request.HttpMethod)] $requestedPath" -ForegroundColor Gray

                # Test-Path 와 ReadAllBytes 사이에 파일이 갈릴 수 있다(git pull·빌드).
                # 그 순간 읽으면 IOException 이고, 모듈 하나만 못 받아도 import 사슬이
                # 끊겨 페이지 전체가 죽는다. 한 번은 짧게 기다렸다 다시 읽어 준다.
                $bytes = $null
                if (Test-Path $filePath -PathType Leaf) {
                    try {
                        $bytes = [System.IO.File]::ReadAllBytes($filePath)
                    }
                    catch [System.IO.IOException] {
                        Start-Sleep -Milliseconds 120
                        try { $bytes = [System.IO.File]::ReadAllBytes($filePath) } catch { $bytes = $null }
                    }
                }

                if ($null -ne $bytes) {
                    $ext = [System.IO.Path]::GetExtension($filePath)

                    # CORS 헤더 추가 (모든 파일에)
                    $response.AddHeader("Access-Control-Allow-Origin", "*")
                    $response.AddHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                    $response.AddHeader("Access-Control-Allow-Headers", "Content-Type")

                    # 개발 서버 — 캐시 금지. js/ 모듈에는 버전 쿼리가 없어서 브라우저가 휴리스틱으로
                    # 캐싱하면 방금 고친 모듈이 옛 파일로 돌아온다 (import 깨짐 → 리스너 미등록).
                    $response.AddHeader("Cache-Control", "no-store, must-revalidate")

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
                }
                else {
                    $response.StatusCode = 404
                    $response.StatusDescription = "Not Found"
                    $notFoundContent = "<h1>404 Not Found</h1><p>File: $requestedPath</p>"
                    $notFoundBytes = [System.Text.Encoding]::UTF8.GetBytes($notFoundContent)
                    $response.ContentType = "text/html; charset=utf-8"
                    $response.ContentLength64 = $notFoundBytes.Length
                    $response.OutputStream.Write($notFoundBytes, 0, $notFoundBytes.Length)
                }
            }
        }
        catch {
            # 여기서 잡고 끝낸다 — 다음 요청은 계속 받는다.
            Write-ServerError "request failed: $($request.HttpMethod) $($request.Url.LocalPath)" $_
            try { $response.StatusCode = 500 } catch { }
        }
        finally {
            # 연결을 반드시 놓아 준다. 이게 빠지면 브라우저가 그 요청을 영영 기다린다.
            try { $response.Close() } catch { }
        }
    }
} catch {
    $errorMsg = $_.Exception.Message
    Write-ServerError "server stopped" $_
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

    <#
      키 입력을 무한정 기다리지 않는다.
      부모가 먼저 죽어 고아로 남은 프로세스에는 키를 눌러 줄 사람이 없다. 예전엔 여기서
      영원히 멈춰 선 채 포트만 붙들고 있었다 — 위 while 루프의 사연과 같은 뿌리다.
      창이 바로 닫혀 오류를 못 읽는 것도 곤란하니, 기다리되 끝이 있게 한다.
    #>
    Write-Host "Press any key to exit (auto-exit in 30s)..."
    $deadline = (Get-Date).AddSeconds(30)
    try {
        while ((Get-Date) -lt $deadline) {
            if ($Host.UI.RawUI.KeyAvailable) {
                $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
                break
            }
            Start-Sleep -Milliseconds 200
        }
    } catch { }
} finally {
    # 포트 예약을 반드시 반납한다. 이게 빠지면 죽은 서버가 포트를 계속 붙들어
    # 「연결은 되는데 응답 없음」 상태가 남는다.
    if ($listener) {
        try { if ($listener.IsListening) { $listener.Stop() } } catch { }
        try { $listener.Close() } catch { }
    }
}
