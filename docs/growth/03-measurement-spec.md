# 계측 명세 — 광고비를 쓰기 전에 반드시 있어야 하는 것

작성: 2026-09-06 · 대상: 로드맵 0단계(2주) · 관련: [02-marketing-roadmap.md](02-marketing-roadmap.md)

## 0. 현재 상태

- `js/firebase.js`에 `logAnalyticsEvent()`가 정의돼 있으나 **호출처가 한 곳도 없다.** `setAnalyticsUserId`만 `js/auth.js:1156`에서 호출.
  Firebase Analytics 자동 수집(first_open, session_start, screen_view)만 쌓이고 있다.
- UTM·리퍼러·Install Referrer를 읽는 코드가 없다. 사용자 문서에 유입 정보 필드가 없다.
- 공유 텍스트에 링크가 없어(`js/utils.js` ~2049행 `text: captionText || 'mealog'`) 공유 유입은 측정 이전에 존재하지 않는다.

이 상태로 광고를 집행하면 "설치 N건"만 남고 **어느 채널이 남는 사용자를 데려왔는지** 알 수 없다.
소액 실험(2단계)의 판정 지표가 전부 여기서 나오므로, 0단계에서 끝내야 한다.

## 1. 유입 귀속(attribution)

### 1.1 웹/PWA — UTM + 리퍼러 첫 접촉 저장

1. 앱 첫 로드 시 `location.search`의 `utm_source / utm_medium / utm_campaign / utm_content`와 `document.referrer`를 읽는다.
2. `localStorage['mealog.acq.first']`에 **최초 1회만** 저장(이미 있으면 덮지 않는다 — first-touch).
3. 가입(프로필 설정 완료) 시 사용자 문서에 붙인다:

```js
users/{uid}.acquisition = {
  source, medium, campaign, content,   // utm_*
  referrer,                            // document.referrer 호스트만
  platform: 'web' | 'pwa' | 'android',
  firstSeenAt, attachedAt
}
```

4. Analytics user property로도 올린다: `acq_source`, `acq_campaign`, `platform`, `login_provider`.

### 1.2 Android — Play Install Referrer

- 스토어 링크에 `&referrer=utm_source%3Dnaver%26utm_campaign%3Dglucose01` 형태로 붙이면 Play가 설치 후 앱에 전달한다.
- Capacitor 플러그인이 필요하다(커뮤니티 플러그인 존재 여부·유지보수 상태를 확인하고, 없으면 `InstallReferrerClient`를
  쓰는 소형 플러그인을 직접 작성 — 50줄 내외). 값은 1.1과 같은 형식으로 사용자 문서에 붙인다.
- Firebase Dynamic Links는 2025-08 종료됐다. 쓰지 않는다.

### 1.3 딥링크(App Links)

- `https://mealog.net/s/*`, `https://mealog.net/go/*`를 앱이 열도록 `AndroidManifest.xml`에 `autoVerify` intent-filter 추가,
  `/.well-known/assetlinks.json` 배포(서명 키 SHA-256 — 프로덕션 keystore 기준).
- 앱 미설치 시 같은 URL이 웹 공유 페이지(로드맵 0단계)로 열린다. 한 URL이 설치/미설치를 모두 처리한다.

## 2. 이벤트 목록

이름은 GA4 권장 소문자 스네이크. 파라미터는 최소한만. 개인정보(닉네임·이메일·본문)는 넣지 않는다.

| 이벤트 | 파라미터 | 앵커(어디서 쏘나) | 왜 |
|---|---|---|---|
| `sign_up` | `method` (kakao/google/email) | `js/auth.js` 가입 완료 지점 | 깔때기 1 |
| `onboarding_complete` | `axis_choice` (photo/health/skip) | `js/onboarding.js` `finishGuide()` | 축 선택 온보딩 효과 |
| `first_record` | `type`, `day_offset`(가입 후 일수) | 첫 저장 성공 시 1회 | 활성화 정의 |
| `record_saved` | `type` (meal/memo/journal), `has_photo`, `axes`(where/who/sat/full 비트) | `js/modals/entry-save-record.js` `buildEntrySaveRecord` 이후 저장 성공 콜백 | 세그먼트 자동 추정 |
| `memo_saved` | `item` (weight/glucose/exercise/custom) | `js/modals/memo-record.js` | B 신호 |
| `share_start` | `kind` (daily/best/photo/insight) | 공유 버튼 진입 | 공유 깔때기 |
| `share_done` | `kind`, `target` (web/native) | `js/utils.js` `shareBlobsToExternal` 성공 분기 | 공유 완료율 |
| `share_page_view` | `card_id`, `installed`(App Links 여부) | 웹 공유 페이지 | 공유 → 유입 |
| `install_cta_click` | `from` (share_page/landing/guide) | 각 CTA | 설치 전환 |
| `pwa_installed` | — | `js/pwa-install.js` `appinstalled` | iOS/웹 설치 |
| `push_open` | `campaign` | 알림 탭 처리 | 푸시 효과 |
| `streak_popup_view` | `days` | `js/attendance-check.js` | 리텐션 장치 효과 |
| `review_prompt_shown` / `review_prompt_done` | — | 인앱 리뷰 요청 | ASO |

**활성화(activation) 정의를 고정한다: 가입 후 3일 이내 `record_saved` 3건 이상 + 축 1개 이상 사용.**
2.4절(01 문서)의 결과대로 "건수"보다 "축"이 생존을 가른다. 이 정의로 채널을 판정한다.

## 3. 관리자 화면에 추가할 것 (미러 규칙 준수)

`docs/admin-local-mirror.md`에 따라 서버를 직접 읽지 않는다.

- `toUserMirrorRow`에 `acquisition.source/campaign/platform` 추가 → **`USERS_MIRROR_ROW_SCHEMA` 올린다**(안 올리면 옛 행이 "미입력"으로 남는다).
- 대시보드에 표 하나: **유입 소스 × (가입 → 첫 기록 → D7 활성)**. 이것이 2단계 실험의 판정 화면이다.
- 세그먼트 추정(A/B/U)은 `*-mirror-model.js` 순수 모듈에 두고 두 경로(미러/폴백)가 같이 import 한다.

## 4. 대시보드 최소 지표 (주 1회 손으로 봐도 된다)

| 지표 | 정의 | 현재 값 | 출처 |
|---|---|---|---|
| 신규 가입 | 주간 sign_up | ~14/주 (추정) | GA4 |
| 활성화율 | 활성화 / 가입 | 미측정 | GA4 + 미러 |
| D7 / D14 | 첫 기록 후 7·14일 뒤 기록 | 38% / 32% | 모먼트 내보내기 |
| DAU/MAU | | 26.4% | 모먼트 내보내기 |
| 공유 완료율 | share_done / share_start | 미측정 | GA4 |
| 공유 유입 | share_page_view → install_cta_click | 0 (링크 없음) | GA4 |
| 채널별 활성 사용자 단가 | 광고비 / 활성화 사용자 수 | 미측정 | 광고 콘솔 + 미러 |

## 5. 개인정보·법 준수 체크

- **마케팅 푸시는 서비스 알림과 분리한다.** 영리 목적 광고성 정보는 사전 수신 동의가 필요하고, 21시~08시 전송은 별도 동의가 필요하다
  (정보통신망법 §50). 지금 설정 화면의 알림 토글이 "광고성 수신 동의"를 구분하는지 확인하고, 없으면 항목을 추가한다.
- `privacy.html`에 유입 정보(UTM·리퍼러) 수집 항목과 Analytics 이용을 명시한다.
- **저장소에 개인정보 파일이 커밋돼 있다**: `.00_마케팅/900_분석데이터/*.xlsx`에 이름·이메일·UID가 그대로 들어 있다.
  저장소가 비공개라도 이력에 남는다. 관리자 내보내기에서 이름·이메일 열을 빼거나, 이 폴더를 `.gitignore`에 넣고 이력에서 제거하는 것을 권한다.
  (이 문서의 분석 스크립트는 이름·이메일을 읽지 않고 UID만 집계에 쓰며, 결과 JSON에는 UID도 남기지 않는다.)
