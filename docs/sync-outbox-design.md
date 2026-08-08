# 식사 기록 동기화 — 아웃박스 설계

> **동기화·오프라인·네트워크 복구 코드에 손대기 전에 이 문서를 먼저 읽으세요.**
> 이 서브시스템은 2026년 6~8월에 **13차례** 수정됐고, 매번 증상은 사라졌지만 같은 뿌리에서
> 새 구멍이 났습니다. 작은 패치가 그럴듯해 보인다면, 그건 이미 12번 그럴듯했던 것과 같은 종류일
> 가능성이 높습니다.

작성: 2026-08-08

---

## 1. 불변식

이 서브시스템 전체가 지키는 문장은 하나입니다.

> ### 사용자가 저장을 누른 기록은, 어떤 fallible한 단계도 시작하기 전에 이미 내구 저장돼 있다.

"fallible한 단계"에는 네트워크 호출뿐 아니라 **토큰 갱신, App Check, Firestore SDK 호출 전부**가
포함됩니다. 이 문장이 참이면 그 뒤의 모든 기계장치(전송, ack, 정합, 넛지, 재시도)는 best-effort가
되고, 무엇이 실패하든 **데이터는 없어지지 않습니다.**

이 문장이 거짓이면 — 지금까지처럼 — 기계장치 중 **하나만 실패해도 유실**이고, 구멍은 계속 나옵니다.

---

## 2. 왜 Firestore 로컬 큐로는 안 되는가

기존 설계의 전제는 **"Firestore의 IndexedDB 쓰기 큐가 곧 아웃박스"** 였습니다. 이 전제는 거짓입니다.
큐에 못 들어가는 경로가 최소 셋 있고, 그때 기록 본문을 저장하는 곳이 **어디에도 없습니다**
(localStorage에는 ID 세 종류만 저장됐습니다).

### 2.1 `setDoc`이 호출되기 전에 상위 타임아웃이 터진다 ★

`dbOps.save`는 `setDoc` **앞에** 상한 없는 네트워크 왕복을 둘 갖고 있었습니다.

```js
await currentUser.getIdToken(false)            // 토큰 만료 시 securetoken 왕복, 상한 없음
await refreshAppCheckTokenBeforeFirestore()    // reCAPTCHA + firebaseappcheck 왕복, 상한 없음
...
await setDoc(...)                              // ← 여기서야 큐에 들어간다
```

App Check는 마지막 강제 갱신에서 4초만 지나면 `force=true`가 되므로 평범한 저장은 사실상 매번
강제 갱신입니다. **반쯤 끊긴 연결**(와이파이는 잡혔는데 인터넷 없음, LTE↔Wi-Fi 핸드오버, 캡티브
포털)에서 fetch는 즉시 실패하지 않고 OS 타임아웃까지 매달립니다. 그 사이 `saveEntry`의 10초
타임아웃이 먼저 터지고 — **큐에는 아무것도 없습니다.**

> 같은 실패 모드를 `ops.js`에서 이미 한 번 발견해 `getDoc` 하나를 제거했습니다(주석이 그대로
> 남아 있습니다). 바로 위의 왕복 둘은 그대로 뒀습니다. **수정이 절반만 됐던 것입니다.**

### 2.2 Callable 폴백은 큐를 우회한다

`permission-denied` 시 `saveArtifactUserMeal` Callable로 넘어갑니다. 이 경로는 Firestore 큐와
무관하므로 실패하면 아무 데도 안 남습니다.

### 2.3 사진은 큐에 들어가지 않는다

`sanitizePhotoArray`가 `data:image`를 제거한 문서를 큐에 넣습니다. base64 원본은 RAM에만
있으므로, 앱이 죽으면 **문서는 올라가는데 사진만 사라집니다.**

### 2.4 그리고 앱은 실제로 자주 죽는다

사진은 클라이언트 어디에서도 리사이즈되지 않고 `readAsDataURL`로 원본이 그대로 들어옵니다
(최대 5장). 폰 사진 1장 3~12MB × 1.33(base64) → **기록 하나가 최대 ~80MB 문자열**로
`appState.currentPhotos`와 `window.mealHistory`에 동시에 얹힙니다.

WebView가 그만큼 부풀면 백그라운드 전환 시 안드로이드 저메모리 킬러의 **1순위 표적**이 됩니다.
즉 2.1~2.3이 만든 "RAM에만 있는 기록"과 2.4가 만든 "앱이 죽을 확률"이 곱해집니다. 이게
"사진 있는 기록에서 더 자주 사라진다"의 정체입니다.

---

## 3. 폐기된 접근과 그 이유

**재발명 방지용입니다. 아래를 다시 제안하기 전에 이유를 먼저 읽으세요.**

| 접근 | 왜 폐기했나 |
|---|---|
| `navigator.onLine` 등 연결 상태 판정을 게이트로 사용 | 모바일에서 원리적으로 부정확. 재연결 후에도 false 고착, half-open은 아예 감지 못 함. `41e903b`에서 제거 |
| "복구에 성공했을 때" 훅으로 재전송 | 훅은 끊김이 *관측됐을 때만* 실행됨. Wi-Fi↔LTE 조용한 전환에서는 아예 안 돎. `3b86246`에서 멱등 드레인으로 교체 |
| 표시 상태를 늘려 케이스 구분 (pending/await_ack/register_scheduled/abandoned/…) | 사용자가 할 수 있는 행동은 어차피 같았고, 상태끼리 어긋나는 조합마다 버그가 났음. `2fb7cbb`에서 3개로 축약, 본 설계에서 2개로 |
| 플래그 Map을 추가해 orphan 행 보호 | 플래그는 재시도 과정에서 **서로 옮겨 다니고**, 표식이 하나도 없는 찰나에 리스너 재구독이 겹치면 유실. 조건을 9번째로 추가해도 못 막음 (`find-unique-meals.js` 주석 참조) |
| `terminate()` + 인스턴스 재생성으로 복구 | 붙어 있는 리스너를 전부 죽여, 핸드셰이크 중인 채널을 스스로 끊음. `bb2cb79`에서 제거 |
| `clearIndexedDbPersistence`로 캐시 정리 | **로컬 쓰기 큐까지 지움** = 미전송 유실. flush 확인된 경우에만 허용 |

공통점: 전부 **상태기계 층**을 고쳤고, 바닥(누가 큐를 소유하는가)은 건드리지 않았습니다.

---

## 4. 설계

### 4.1 스토어

앱 소유 IndexedDB (`mealog-outbox`, store `entries`). **Firestore의 IndexedDB와 별개입니다.**

```
{
  id:        string,          // meal 문서 id (클라이언트 선발급)
  uid:       string,
  op:        'upsert' | 'delete',
  record:    object,          // photos 제외한 기록 본문
  photos:    Blob[],          // 다운스케일본 (2048px long edge, JPEG 0.85)
  originals: Blob[] | null,   // 업로드 성공 시 즉시 삭제 (§4.6)
  updatedAt: string,          // ISO. 충돌 판정용 (§4.5)
  createdAt: string,
  attempts:  number,
  lastError: { code, message, at } | null,
  permanent: boolean          // 재시도 무의미 (§4.4)
}
```

### 4.2 쓰기 시점

`saveEntry`에서 `buildEntrySaveRecord` **직후, 낙관 반영보다도 먼저**. 삭제는 `deleteEntry`
진입 즉시. 이 write는 네트워크·토큰·App Check를 타지 않으므로 매달릴 수 없습니다.

지우는 시점은 **딱 하나 — 서버 존재가 확인됐을 때**. 그 외 어떤 이유로도 지우지 않습니다.

### 4.3 워커 (단일 소유자)

아웃박스를 소비하는 루프는 **하나뿐**입니다. 가장 오래된 항목부터 밀어 올리고 결과를 기록합니다.

현재 흩어져 있는 재시도 주체 — `retryPendingMealEntriesOnAppReady`,
`reconcileMealSyncAgainstServer`, `scheduleServerAckAfterPendingWrites`, grace 타이머, 드레인 —
는 **전부 이 워커로 흡수됩니다.** 각자 "무엇이 미전송인가"를 따로 판단하던 것이 버그의 원천이었습니다.

나머지는 전부 아웃박스의 **뷰**가 됩니다:

- 배지 수 = 아웃박스 크기 (`mealHistory` 스캔 없음 → 배지/드레인 불일치 버그 클래스 소멸)
- 행 표시 = `outbox.has(id)`
- orphan 보호 = `if (outbox.has(id)) keep;` — `isOrphanCandidate`의 8조건 휴리스틱 전체 대체

### 4.4 표시 — 2상태

| 상태 | 의미 | 사용자 행동 |
|---|---|---|
| (표시 없음) | 서버 반영 확인됨 | 없음 |
| **아직 안 올라감** | 아웃박스에 있음 | 기다리면 됨 (자동 재시도) |
| **영구 실패** | `permanent: true` | 개입 필요 |

`permanent`는 재시도가 무의미한 경우에만: 검증 오류, 지속적 권한 거부, 문서 크기 초과.
네트워크성 실패는 **절대** permanent가 아닙니다.

이로써 다음이 삭제됩니다: grace 타이머(10초/30초), `_registerScheduledChip`, `_abandoned`,
`_errorIds`, localStorage 키 3개(`mealog_mealSyncErrorIds_v1`, `…AbandonedIds_v1`,
`…RegisterScheduledIds_v1`).

### 4.5 충돌 — 오래된 항목이 최신본을 덮어쓰지 않게

meal 문서에 **`updatedAt` 필드를 신설**합니다 (현재 없음. `recordedAt`은 생성 시각이라 대용 불가).

밀어 올리기 직전 서버본의 `updatedAt`이 아웃박스 항목보다 최신이면 **밀지 않고 항목을 제거**합니다.
기존 문서에 `updatedAt`이 없으면 `recordedAt`으로 폴백합니다.

아웃박스가 며칠씩 버틸 수 있게 되면서 새로 생기는 위험이므로, 이건 선택이 아니라 필수입니다.

### 4.6 사진

- **인테이크에서 다운스케일** (장변 2048, JPEG 0.85) → `photos`. 장당 ~400KB.
  RAM 압박과 저메모리 킬 문제(§2.4)가 여기서 해결됩니다.
- **원본은 `originals`에 Blob으로 보관하되 Storage 업로드 성공 즉시 삭제.**
  화질을 보존하면서 저장소 비용은 일시적으로만 지불합니다. 며칠 오프라인인 사용자만 쌓입니다.
- data URL 문자열이 아니라 **Blob**으로 저장합니다 (base64보다 25% 작고 직렬화 비용 없음).

### 4.7 가드는 불린이 아니라 리스

`drainInFlight`, `_mealEntryRetryInFlight`, `nudgeInFlight`, `transportKickInFlight` 는 전부
"상한 없는 await 안에서 매달리면 영구 교착"인 모양입니다. 실제로 그렇게 죽었습니다.

불린 대신 **만료 있는 리스**를 씁니다. 어디서 매달려도 리스가 만료되면 스스로 풀립니다.
개별 호출부에 타임아웃을 박는 건 땜빵입니다 — 다음에 추가되는 await는 못 막습니다.

### 4.8 네트워크 단일 관문 + 린트

모든 Firestore / Auth / App Check 호출은 **정착(settle)을 보장하는 단일 래퍼** `withDeadline()`을
통과합니다. 그리고 관문 밖 직접 await를 **ESLint 규칙으로 금지**합니다:

```
getDocFromServer / getDocsFromServer / waitForPendingWrites / getToken / getIdToken
```

이게 유일하게 **사람의 기억에 의존하지 않는** 항목입니다. 문서는 안 읽힐 수 있지만 린트는 돕니다.

> 참고: 현재 `withTimeout` 헬퍼가 `network-loop.js`와 `meal-outbox-drain.js`에 **복붙 두 벌**로
> 있으면서 정작 필요한 곳엔 안 걸려 있습니다. 그 자체가 관문이 없다는 증거였습니다.

---

## 5. 결정 기록

| 결정 | 선택 | 근거 |
|---|---|---|
| 아웃박스 사진 저장 | 다운스케일 Blob + 원본은 업로드까지만 | 화질 보존, 저장소 비용은 일시적. RAM 문제도 동시 해결 |
| 충돌 처리 | `updatedAt` 신설 + 최신 우선 | 아웃박스 장기 보관이 새로 만드는 위험. 다기기 사용 시 필수 |
| 범위 | 등록·수정 + **삭제** | 삭제도 플래그 3개로 같은 병을 앓음. 같이 걷어내야 상태기계가 실제로 사라짐 |
| 표시 UI | **2상태로 단순화** | 무한 자동 재시도 하에서 "실패" 중간 상태는 의미 없음. 코드 최대 감소 |
| 보존 정책 | 자동 삭제 없음 | 데이터 소멸은 사용자의 명시적 행동으로만. 오래된 항목은 눈에 띄게 표시만 |
| 로그아웃 | uid별 보관, 재로그인 시 재개 | 미전송 있으면 로그아웃 시 경고. 탈퇴 시에만 제거 |
| 마이그레이션 | 첫 부팅 1회 흡수 | `mealHistory` 중 서버 ack 안 된 행 → 아웃박스. 기존 localStorage 키는 읽고 폐기 |
| 롤아웃 | staging 소킹 후 프로덕션 | 기존 관행 |

---

## 6. 미결

- 다운스케일 파라미터(2048 / 0.85) 실측 검증 — 모먼트 라이트박스 확대 시 체감 확인 필요
- `originals` 누적 상한. 무제한이면 장기 오프라인 시 쿼터 압박. 상한 도달 시 오래된 것부터
  원본만 버리고 다운스케일본은 유지하는 방향 검토
- 워커 동시성: 1건씩 직렬 vs 소수 병렬. 초기엔 직렬로 시작

---

## 7. 작업 단계

1. `withDeadline()` 관문 + ESLint 규칙 (§4.8) — 독립적, 먼저 넣어도 무해
2. 리스 기반 가드 타입 (§4.7) — 기존 불린 4곳 교체
3. IndexedDB 스토어 + 사진 다운스케일 파이프라인 (§4.1, §4.6)
4. 아웃박스 쓰기 지점 (§4.2) + `updatedAt` 신설 (§4.5)
5. 단일 워커 (§4.3) — 기존 재시도 주체 5개 흡수
6. 표시 2상태 전환 (§4.4) — 플래그 Map·grace 타이머·localStorage 키 삭제
7. 마이그레이션 + staging 소킹

1·2는 3~6과 독립이므로 먼저 넣어 리스크를 분산할 수 있습니다.
