# 공유 시 영향받는 리스너 정리

공유/공유 해제 시 **발동하는 Firestore 리스너는 2개**입니다.  
둘 다 발동할 때마다 UI 재렌더를 유발해, 다른 탭(앨범·분석·피드)에 있어도 메인 스레드가 바쁘면 프리즈·고CPU가 날 수 있습니다.

---

## 1. 공유 시 발동하는 리스너 (2개)

| 리스너 | 구독 경로 | 공유 시 | 공유 해제 시 | 콜백에서 하는 일 (수정 전) |
|--------|-----------|---------|--------------|----------------------------|
| **meals** | `users/{uid}/meals` (날짜 조건) | save(record) 시 1회 | save(record) 시 1회 | `onDataUpdate()` → **항상** `renderTimeline()` + `renderMiniCalendar()` |
| **sharedPhotos** | `sharedPhotos` (최신 100개) | CF가 문서 추가 시 1회 | CF가 문서 삭제 시 1회 | `window.sharedPhotos` 갱신 후 **현재 탭이 timeline/gallery/feed일 때만** 해당 뷰 렌더 |

- **meals**: 공유를 해도/해지해도, 클라이언트가 `save(record)`를 한 번 호출하므로 **1번만** 발동합니다.
- **sharedPhotos**: 공유 시 CF가 `sharedPhotos`에 쓰고, 해제 시 CF가 삭제하므로 **각 1번씩** 발동합니다.

즉, **공유를 하거나 해지할 때마다 최소 2개의 리스너가 각 1회씩** 발동합니다.

---

## 2. 문제였던 점

- **onDataUpdate**가 **현재 탭을 안 보고** 항상 `renderTimeline()` + `renderMiniCalendar()`를 호출했습니다.
- 그래서 **앨범·분석·피드**에 있는 동안에도:
  - 타임라인·미니캘린더용 DOM/레이아웃/스타일 계산이 매번 실행되고
  - 메인 스레드를 많이 써서 **다른 탭에서도 금방 프리즈**가 났습니다.

---

## 3. 적용한 수정

- **onDataUpdate** 안에서 **`appState.currentTab === 'timeline'`일 때만**  
  `renderTimeline()` + `renderMiniCalendar()`를 실행하도록 변경했습니다.
- 다른 탭(앨범/분석/피드)일 때는 콜백에서 아무 렌더도 하지 않고,  
  데이터만 `db/listeners.js` 쪽에서 `window.mealHistory`에 반영됩니다.
- 나중에 사용자가 타임라인 탭으로 돌아오면 `switchMainTab('timeline')`에서  
  `renderTimeline()` / `renderMiniCalendar()`가 호출되므로, 그때 최신 데이터로 그려집니다.

---

## 4. 탭별로 누가 그리는지 (수정 후)

| 현재 탭 | meals 리스너 → onDataUpdate | sharedPhotos 리스너 콜백 |
|---------|-----------------------------|---------------------------|
| timeline | ✅ renderTimeline + renderMiniCalendar | ✅ renderTimeline (또는 디바운스 후 동일) |
| gallery | ❌ 스킵 | ✅ renderGallery |
| feed | ❌ 스킵 | ✅ renderFeed |
| dashboard(분석) | ❌ 스킵 | ❌ 스킵 (analytics/dashboard는 sharedPhotos 리스너에서 안 그림) |

공유/해지 후 **분석 탭·앨범 탭에 있을 때**는, 타임라인/미니캘린더 재렌더가 더 이상 돌지 않아  
불필요한 CPU 사용과 프리즈가 줄어듭니다.

---

## 5. “처리 결과 전에 다른 탭으로 이동 시” 프리즈 원인과 해결

### 현상
공유/해지를 누른 뒤 **저장·공유 처리 결과가 도착하기 전에** 다른 탭(앨범/분석 등)으로 이동하면 프리즈가 걸림.

### 원인
`modals.js`의 `saveEntry` 안에서:

1. 저장 **시작 시점**의 `currentTab`만 캡처해 두고,
2. `await dbOps.save(record)` → `await dbOps.sharePhotos(...)` 동안 사용자가 다른 탭으로 이동할 수 있고,
3. 저장·공유가 끝난 뒤 `setTimeout(..., 100)` 콜백이 돌 때 **여전히 캡처해 둔 탭(timeline)** 기준으로 분기함.
4. 그래서 **이미 앨범/분석에 있는데도** “타임라인” 분기가 실행되어 `jumpToDate(editingDate)`가 호출되고,
5. `jumpToDate`는 **`renderTimeline()`을 여러 번** 돌리며 (`while (!window.loadedDates.includes(targetStr)) { renderTimeline(); }`) 타임라인 전체를 반복 렌더함.
6. 그 사이 사용자는 다른 탭을 보고 있는데, 메인 스레드가 타임라인 렌더에 몰리면서 **프리즈**가 발생함.

### 해결 (modals.js)
- 저장 **완료 후** `setTimeout` 콜백 **실행 시점**의 탭을 써서 분기하도록 변경:  
  `const tabNow = appState.currentTab;` 후 `tabNow` 기준으로만 처리.
- `tabNow === 'timeline'`일 때만 `jumpToDate`·스크롤 등 타임라인 전용 로직 실행.
- `tabNow === 'gallery'`일 때만 갤러리 분기(그 전에 `appState.currentTab !== 'gallery'` 한 번 더 확인).
- `tabNow === 'dashboard'`일 때는 아무 UI 갱신 없음(리스너가 타임라인/갤러리만 갱신하므로, 분석은 탭 전환 시 반영).
- 갤러리 분기 안의 추가 `setTimeout`에서도 “대기 중 탭이 바뀌었으면 스킵” 하도록 `appState.currentTab !== 'gallery'` 체크 유지.

이렇게 하면 **결과 도착 전에 다른 탭으로 나갔어도**, 콜백이 도는 시점의 탭에 맞는 작업만 하고, 보이지 않는 타임라인 반복 렌더는 하지 않아 프리즈가 사라짐.
