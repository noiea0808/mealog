# B-1 공유 링크 — 작업 지시 (로컬 세션용)

배경: [../04-improvement-backlog.md](../04-improvement-backlog.md) B-1.
지금 사용자의 22%가 공유를 누르는데 **공유물에 링크가 없어 아무도 데려오지 못한다.**

## 고칠 곳 — 함수 하나

**`js/utils.js` 의 `shareBlobsToExternal()`**

모든 외부 공유가 이 함수로 모인다. `sharePhotosToExternal()` 도 내부에서 이 함수를 부르므로
여기만 고치면 전부 적용된다.

| 위치 | 지금 | 바꿀 것 |
|---|---|---|
| 약 1953행 `tryWebShare()` | `const shareData = { files }` | `{ files, text }` — 텍스트·링크 추가 |
| 약 2049행 `shareOptions` | `text: captionText \|\| 'mealog'` | 캡션 뒤에 링크 붙이기 |
| 약 2059·2069행 폴백 2개 | 위와 같은 형태 | 동일하게 처리 |

## 추가할 것

- 파일 상단에 공유 링크 상수: `https://mealog.net/?utm_source=share`
- 캡션과 링크를 합치는 헬퍼 하나 (캡션이 없어도 링크는 나가야 한다)

## 주의

- 웹 경로에서 `navigator.canShare()` 가 `text` 를 붙이면 거부하는 브라우저가 있다. **기존 폴백 흐름은 그대로 둔다.**
- 링크에 `utm_source=share` 를 반드시 붙인다 — 나중에 공유 유입을 셀 수 있어야 한다.

## 영향 (수정 불필요, 자동 적용)

- `js/modals/diet-report.js:811` — AI 리포트 공유
- `js/main/feed-options-report.js:236, 272` — 모먼트 사진 공유

## 검증

`npm run lint:errors` · `npm test` · 실제 폰에서 공유를 눌러 카톡에 링크가 같이 가는지 확인.

## 작업 방식

`AGENTS.md` 와 `.cursor/rules/local-git-workflow.mdc` 를 따른다. `staging` 에서 `feat/share-link` 브랜치.
커밋까지만 하고 push 는 하지 않는다.
