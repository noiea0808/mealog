# 밀당 공유 시 캐릭터 이미지 CORS 해결

## 문제
Firebase Storage에 저장된 캐릭터 이미지를 밀당 공유 캡처에 포함할 때, 브라우저 CORS 정책으로 인해 이미지가 캡처되지 않는 문제가 있었습니다.

## 해결 방법
Cloud Function `getStorageImageAsBase64`를 추가하여 **서버에서 이미지를 다운로드**한 뒤 base64로 변환하여 클라이언트에 전달합니다. 이렇게 하면 CORS 제한 없이 캡처에 이미지를 포함할 수 있습니다.

## 배포 필요
새 Cloud Function이 추가되었으므로 **Functions를 배포**해야 합니다:

```bash
cd functions
npm install
firebase deploy --only functions
```

또는 전체 배포:

```bash
firebase deploy
```

## 동작 흐름
1. 사용자가 밀당 공유 시 "공유하기" 클릭
2. 미리보기에 Firebase Storage URL의 캐릭터 이미지가 있음
3. `getStorageImageAsBase64` Cloud Function 호출 (이미지 URL 전달)
4. 서버에서 Storage 파일 다운로드 → base64 변환 → 반환
5. 클라이언트에서 img src를 data URL로 교체
6. html2canvas로 CORS 없이 캡처

## 보안
- 로그인한 사용자만 호출 가능
- `users/{본인uid}/...` 경로의 이미지만 접근 가능 (다른 사용자 이미지 차단)
