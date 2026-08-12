# 기록 시트 개편 — 인수인계 (2026-08-13)

다른 기기에서 이어서 작업할 때 이 문서부터 읽으세요.
설계 근거는 [entry-sheet-redesign.md](entry-sheet-redesign.md),
[food-category-auto-classification.md](food-category-auto-classification.md),
[place-axis-unification.md](place-axis-unification.md)에 있습니다.

## 1. 지금 상태

- **작업 브랜치: `test`** (원격 `origin/test`에 push 완료). `staging`은 손대지 않았습니다 —
  작업 시작 지점 `0f26fc6` 그대로라 원격 staging과 동일합니다.
- **배포됨(운영 Firebase `mealog-r0`)**: Cloud Functions 2개만.
  클라이언트(웹/앱)는 **아무것도 배포하지 않았습니다** — test 브랜치에만 있습니다.

### 커밋 목록 (staging 이후, 시간순)

| 커밋 | 내용 |
|---|---|
| `3336a1a` | docs: 음식 카테고리 자동 분류 설계 |
| `506b6ca` | docs: 기록 시트 재설계 |
| `43e6720` | docs: 콜드 스타트 + 태그 실사용 검증 |
| `fb5739e` | feat: 자동 분류 1단계 (분류기 + ✨제안 칩) |
| `c02b0d5` | chore: meals 원본 필드 분석 스크립트 |
| `f137f34` | feat: 1층 개편 (카테고리 그리드 접힘, 메모 상세탭) |
| `0a6dcfb` | feat: 2층 개편 (어디서·누구와 예측 한 줄) |
| `e7050b4` | feat: 3층 필드 자동 승격 |
| `640cf7b` | feat(functions): 서버 backfill |
| `48c582d` | feat: 측정 이벤트 6종 |
| `7493317` | fix: 간식 분류 · 제안 칩 자리 예약 · 분석 화이트리스트 |
| `d9d1360` | feat: 식사/간식 토글 제거 |
| `67eac0c` | feat: 어디서 축 정규화 |
| `19920aa` | fix(sw): 캐시 세대 v7 |

## 2. 다른 기기 세팅

```bash
git fetch origin && git checkout test && git pull
```

git에 **없는** 것들(로컬에서 따로 준비해야 함):

| 파일 | 용도 | 얻는 법 |
|---|---|---|
| `js/config.js` | 클라이언트 키 | `js/config.example.js` 복사 후 값 채우기 |
| `functions/.env` | GEMINI_API_KEY 등 | `functions/.env.example` 참고 |
| `functions/node_modules` | 배포용 | `cd functions && npm install` |
| `.00_마케팅/*.xlsx` | 데이터 분석 원본 | 관리자 화면에서 모먼트 내보내기로 재생성 가능 |

로컬 실행: `.claude/launch.json`의 `mealog-static` (포트 8777).

> **주의**: 코드 수정 후 브라우저에서 확인할 때 서비스 워커가 구버전을 잡고 있습니다.
> SW 등록 해제 + 캐시 삭제 후 리로드해야 새 코드가 보입니다.
> index.html 구조를 바꾸는 배포에는 `sw.js`의 `CACHE_NAME` 범프가 **필수**입니다.

## 3. 운영 영향 (중요)

**클라이언트는 영향 0** — 운영에 배포된 웹/앱은 staging 코드 그대로입니다.

**서버는 지금 운영 데이터에 쓰고 있습니다**:

- `classifyUncategorizedMeals` — 6시간마다 자동 실행. 최근 7일 미분류 기록 최대 100건에
  `categoryAuto` · `categorySource` **두 필드만** 추가합니다.
- 안전 근거: 사용자 필드(`category`·`snackType`)와 `updatedAt`을 건드리지 않습니다.
  `updatedAt`은 아웃박스 충돌 판정 필드라 서버가 올리면 클라이언트의 정당한 수정 푸시가
  막히므로 의도적으로 제외했습니다 ([sync-outbox-design.md](sync-outbox-design.md) §4.5).
- 현재 운영 클라이언트는 이 필드를 읽지 않으므로 **사용자에게 보이는 변화는 없습니다.**
- 클라이언트가 기록을 수정 저장하면 문서 전체 덮어쓰기(`setDoc`, merge 없음)라
  이 필드가 지워지지만, 다음 배치가 다시 채웁니다(자가 치유).

**중단하려면**:

```bash
firebase functions:delete classifyUncategorizedMeals --region us-central1
```

`adminClassifyLegacyMeals`는 관리자가 직접 호출할 때만 도는 callable이라 방치해도 무해합니다.

## 4. 다음에 할 일

### 우선순위 높음

1. **실기기 검증** — 제안 칩 줄바꿈, 예측 한 줄 레이아웃, 승격 필드 배치를 실제 모바일에서.
   데스크톱 DOM 검증은 끝났지만 모바일 레이아웃은 미확인입니다.
2. **과거 데이터 마이그레이션** — 관리자 계정으로 `adminClassifyLegacyMeals` 호출.
   `{ startDate: '2026-07-01', endDate: '2026-08-12', maxDocs: 100 }`,
   100건/회라 '기타' 2,532건 소진에 약 26회. 관리자 화면에 반복 호출 버튼을 붙이면 편합니다.

### 미구현 (설계만 있음)

3. **개인 사전 학습** — [food-category-auto-classification.md](food-category-auto-classification.md) §5.
   `classifyFoodText(text, personalKeywords)`에 파라미터 구멍은 뚫려 있고 호출부에서 안 넘깁니다.
   사용자가 제안을 다른 칩으로 고칠 때 그 토큰을 `userSettings.personalFoodKeywords`에 쌓고,
   저장은 `entry-save-subtags.js`의 디바운스 경로에 편승시키면 됩니다.
4. **카테고리 축 전면 교체** — 지금은 기존 축(한식/양식…)과 새 축(밥/한상/단백질식…)이 공존합니다.
   차트 화이트리스트를 합집합으로 열어둬서 둘 다 표시됩니다. 어느 쪽이 더 쌓이는지 본 뒤 결정하세요.
5. **시트 열림→저장 시간 측정** — 재설계의 최종 성공 지표인데 현재 `usageDaily` 카운터
   구조로는 못 담습니다. 별도 설계 필요.

## 5. 이번 작업에서 배운 것 (반복 방지)

- **서비스 워커 캐시**가 "배포했는데 안 보임"의 단골 원인. 캐시 세대를 안 올리면
  구 HTML + 신 JS가 섞입니다.
- **차트 화이트리스트**(`charts.js` `aggregateProportionData`, `analysis-top-icons.js`
  `getAllowedTags`)는 사용자 태그 밖 값을 '미입력'으로 접습니다. 새 태그 값을 도입하면
  두 곳 모두 열어줘야 차트에서 사라지지 않습니다.
- **키보드 열린 동안 시트 높이 재측정이 막혀 있습니다**(`entry-sheet-tabs.js`).
  입력 중에 새 요소를 띄우려면 자리를 미리 예약해야 합니다.
