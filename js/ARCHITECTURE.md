# JS 모듈 구조 (요약)

## `main.js` (앱 진입)

- **밀당(analytics) 지연 로드** — `analytics/ensure.js`의 `installAnalyticsLazyStubs` / `ensureAnalytics`. 탭 `dashboard` 진입·HTML onclick 시에만 `analytics.js` 로드. 분석 아이콘은 `assets/analysis-icons/*.png` URL(데이터 URI 임베드 폐기).
- **`main/network.js`** — 오프라인/온라인 시 네트워크 오버레이 (`registerMainNetworkListeners`)
- **`main/cleanup.js`** — `window.cleanupFirestoreListeners` 등록 (`registerMainCleanup`)
- **`main/shares-sync.js`** — `refreshMyMomentShares` / `syncOrphanedSharesToMoment`(캐시 갱신, canonical: `sharedPhotos` 컬렉션)
- **`main/gallery-pull-refresh.js`** — 모먼트 갤러리 당겨서 새로고침 (`setupGalleryPullToRefresh`)
- **`main/notifications.js`** — 알림 읽음 상태(Firestore), 팝업 목록, 빨간 점, `updateAppBadge`, `navigateToNotificationPost`, 실시간 리스너 (`startNotificationListeners` / `stopNotificationListeners` export)
- **`main/tabs.js`** — `registerMainTabSwitch()`로 `window.switchMainTab` 등록 (헤더 라벨, 뷰 표시, 모먼트/타임라인/대시보드/밀톡 전환 로직)
- **`main/content-popup.js`** — `registerContentPopup()`로 탭별 콘텐츠 팝업·닫기; `recordBannerView` / `recordBannerClick` export (랜딩 로그인 배너 집계)
- **`main/event-listeners.js`** — `initEventListeners()` export (랜딩·인증·검색·알림·하단 탭·설정·밀톡·대시보드 버튼, 키보드/Capacitor 뒤로가기 등 DOM 바인딩)
- **`main/event-listener-manager.js`** — `registerEventListenerManager()`로 `Mealog.eventListenerManager` (DOM 리스너 중복 방지·정리)
- **`main/moment-sync-dev.js`** — `registerMomentSyncDevTools()`로 콘솔용 `syncEntryToMoment` / `syncEntriesToMomentBatch` / `debugSharedPhotos`, `Mealog.loadMyShares`·`loadSharedPhotosPage` 노출
- **`main/post-interactions-daily.js`** — `registerMainPostInteractions()` (좋아요/북마크/댓글·일간 공유 미리보기 등)
- **`main/feed-options-report.js`** — `registerMainFeedOptionsReport()` (피드 옵션·신고·공유 취소 등)
- **`main/board-handlers.js`** — `registerMainBoardHandlers()` (밀톡 글쓰기·목록·상세·댓글 등)

## `modals.js` + `modals/`

- **`modals.js`** — `modals/` 하위 모듈 re-export (진입점만 유지)
- **`modals/entry-and-core.js`** — 기록 모달·사진·태그·`saveEntry` 등
- **`modals/entry-form-config.js`** — 기록 시트 DOM id·entryMode별 메타, `PHOTO_ASPECT_OPTIONS`
- **`modals/entry-form-state.js`** — 폼 DOM 읽기·검증·저장 필드 해석 (`readEntryFormFromDom`, `validateEntryForm`, `resolveEntrySaveFields`)
- **`modals/entry-save-record.js`** — `saveEntry` payload 조립. `buildEntrySaveRecord`(Firestore record 객체) / `buildEntryShareSnapshot`(공유 비교 스냅샷) / `isLocalPendingPhoto`. 부수효과 없음
- **`modals/entry-save-subtags.js`** — 저장 시 최근 서브태그 학습 + 설정 디바운스 저장 (`buildSettingsWithRememberedSubTags`, `scheduleEntrySettingsSave`)
- **`modals/entry-save-photos.js`** — 로컬(base64/blob) 사진 Storage 업로드 + https URL 재저장 (`uploadEntryPhotosAndResave`, `ensureDataUrlForStorage`). 실패를 삼키고 플래그로 반환하며, 타임아웃·UI 복구는 `saveEntry`가 담당
- **`modals/entry-save-share.js`** — 저장 후 모먼트 공유 동기화 (`syncMomentShareAfterSave`). 공유 목록·사진 비율이 바뀐 경우에만 재동기화해 `sharedAt` 정렬을 보존
- **`modals/settings.js`** — 설정 모달·프로필·태그 관리
- **`modals/kakao-place.js`** — 카카오 장소 검색

## Capacitor / 벤더

- **`capacitor-social-login-plugin.js`** — 플러그인 단일 번들(IIFE, ~2019줄). 자동 생성에 가까워 **분리하지 않음**

## `admin.js` (관리자 페이지)

- **`admin/restaurant-stats.js`** — 모니터링 > 식당정보 (`registerRestaurantStats`, `renderRestaurantDataForMonitoringSidebar`)
- **`admin/board-moderation.js`** — 모니터링 > 밀톡 (`renderBoardPosts`, 게시물 목록·상세·일괄 가리기/삭제 등 `window.*`)
- **`admin/feed-moderation.js`** — 모니터링 > 피드 (`renderFeedManagement`, 타임라인 조회·필터·신고 팝업·일괄 공유 취소/금지·동기화)
- **`admin/persona.js`** — 콘텐츠 > MEALOG 안내·캐릭터 편집 (`loadMealogComments`, `showCharacterListView` export + `window.saveCharacter` 등)
- 기타: 대시보드·사용자·공지·약관·APK 등은 `admin.js` 본문 또는 기존 `admin/*.js`

## `render.js` + `render/`

- **`render/utils.js`** — HTML 이스케이프, 포맷된 본문 렌더
- **`render/timeline.js`** — 타임라인·미니 캘린더
- **`render/entry-chips.js`** — 기록 화면 태그 칩
- **`render/photo-edit.js`** — 사진 편집 모달 (식사/프로필). 저장 후 미리보기 갱신은 `render.js`와 순환을 피하려고 `import('../render.js')` 동적 호출
- **`render/post-group-utils.js`** — 공유 사진 `postId` 계산, `processPhotosToGroups`, 갤러리 가로 스크롤 인접 이미지 프리로드
- **`render/user-profiles.js`** — `getUserSettings`, `fetchUserProfiles` (다른 사용자 프로필 캐시)
- **`render/board-notice.js`** — 공지 목록·밀톡 `renderBoard` / `renderBoardPostList` / 상세 `renderBoardDetail`, `renderNoticeDetail`
- **`render/post-group-html.js`** — 모먼트·갤러리·피드 공통 카드 HTML (`renderPostGroupHtml`)
- **`render/shared-entry-comments.js`** — 공유 기록 코멘트 Callable 일괄 조회 (`fetchMissingSharedComments`)
- **`render/moment-post-interactions.js`** — 피드 카드 좋아요/댓글 지연 로드 큐 (`enqueuePostInteractionLoad`, `processPostLoadQueue`, `loadPostInteractions`)
- **`render/gallery.js`** — `renderGallery`, 필터·탭 (`filterGalleryByUser`, `clearGalleryFilter`, `switchGalleryFilterTab`), 더보기·Observer
- **`render/feed.js`** — 타임라인 옆 피드 탭 `renderFeed`, `toggleFeedComment`
- **`render/daily-share-card.js`** — `createDailyShareCard` (일간보기 공유 html2canvas용 카드 DOM)
- **`render.js`** — 태그 매니저·기록 미리보기·`toggleComment` 등 (`createDailyShareCard`는 `daily-share-card.js`로 분리)
- **`render/index.js`** — 위 모듈들을 한데 모아 re-export (`main.js` 등은 여기서 import)

## 다음 리팩터링 후보

- `render.js`: `toggleComment` 등 추가 분리 여지
- `modals/entry-and-core.js`의 `saveEntry` — 1·2단계로 1,076줄 → 666줄. 남은 것:
  - **낙관 반영 블록** (약 90줄) — `window.mealHistory`·`sharedPhotos`를 직접 mutate하고
    탭별 렌더 분기가 섞여 있다. 분리하려면 전역 갱신을 한곳으로 모으는 설계가 먼저 필요
  - **저장 후 렌더 분기** (`setTimeout(…, 0)` 안의 탭별 분기, 약 60줄)
  - `shareBanned`(record 조립)와 `isShareBanned`(공유 스냅샷)는 같은 값을 두 번 계산한다 —
    통합 가능하나 동작 보존을 우선해 남겨 뒀다
  - 바깥 `catch(uploadPhaseError)`의 `return`은 `saveEntry`를 빠져나가야 하므로
    사진 단계를 더 옮길 때 주의 (추출된 함수의 return은 saveEntry를 끝내지 않는다)
