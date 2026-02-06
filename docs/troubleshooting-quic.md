# ERR_QUIC_PROTOCOL_ERROR / 로그인 화면에서 멈춤

Firebase 스크립트를 불러올 때 `net::ERR_QUIC_PROTOCOL_ERROR`가 나고, 로그인 화면에서 앱이 멈추는 경우가 있습니다.

## 원인

Chrome이 Google(gstatic.com)에 **QUIC**(HTTP/3)로 접속할 때, 네트워크·방화벽·VPN·회사망 등에서 연결이 끊기면서 발생합니다. 스크립트 로드가 실패해 `main.js`와 Firebase가 초기화되지 않고, 로그인 화면에서 진행이 되지 않습니다.

## 해결 방법 (Chrome에서 QUIC 끄기)

1. Chrome 주소창에 입력: `chrome://flags/#enable-quic`
2. **Experimental QUIC protocol** 항목을 **Disabled**로 변경
3. Chrome **다시 시작** (하단 "Relaunch" 버튼)
4. MEALOG 페이지를 **새로고침**(F5 또는 Ctrl+F5)

이후에는 QUIC 대신 HTTP/2 등으로 접속되어 gstatic에서 Firebase 스크립트가 정상 로드됩니다.

## 다른 브라우저

- **Edge**: `edge://flags/#enable-quic` 에서 동일하게 Disabled 후 재시작
- **Firefox**: QUIC이 기본 꺼져 있는 경우가 많아, 같은 환경에서 정상 동작할 수 있습니다.

## 참고

- QUIC을 끄면 일부 사이트의 최신 프로토콜 이점은 줄어들지만, 일반 사용에는 문제 없습니다.
- 회사 PC에서 플래그 변경이 불가한 경우, 네트워크 관리자에게 QUIC(UDP 443) 허용을 요청하거나, 다른 네트워크(예: 집·모바일 핫스팟)에서 시도해 보세요.
