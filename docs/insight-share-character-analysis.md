# 밀당 공유 시 캐릭터 이미지 미표시 종합 분석

## 1. PNG 형식 영향
- **결론: PNG는 문제 없음**
- Cloud Function에서 `ext === 'png'` → `image/png` MIME 타입 정상 처리
- Node.js Buffer의 `toString('base64')`는 PNG 바이너리도 정상 변환
- data URL `data:image/png;base64,...` 형식은 브라우저에서 표준 지원

## 2. 전체 흐름
1. **openShareInsightModal**: DOM의 `insightCharacterIcon`에서 img src 추출 → screenshotHtml에 `<img src="Firebase URL">` 삽입
2. **shareInsightToFeed**: 
   - `img[src^="http"]` 선택
   - Firebase URL이면 `getStorageImageAsBase64` Cloud Function 호출
   - 반환된 data URL로 img.src 교체
   - img.onload 대기 후 html2canvas 실행

## 3. 가능한 원인 및 대응

| 원인 | 확인 방법 | 대응 |
|------|----------|------|
| **Cloud Function 미배포** | 콘솔에 "getStorageImageAsBase64 반환값 없음" 또는 네트워크 에러 | `firebase deploy --only functions` |
| **권한 오류** | Function 로그에서 permission-denied | Storage 규칙 확인 |
| **경로 파싱 실패** | Function 로그에서 invalid-argument | URL 형식 확인 |
| **이미지 로드 타이밍** | 캡처 시 빈 영역 | img.onload 대기 추가 (적용됨) |
| **html2canvas 한계** | data URL인데도 미표시 | scale, allowTaint 옵션 조정 |

## 4. 적용된 수정사항
- img.onload/onerror로 **명시적 로드 대기** 추가
- webp 형식 MIME 지원 추가
- 디버깅용 console.warn 추가
- 페인트 대기 150ms로 증가

## 5. 배포 확인
```bash
firebase deploy --only functions
```
배포 후 `getStorageImageAsBase64` 함수가 목록에 있는지 확인:
```bash
firebase functions:list
```
