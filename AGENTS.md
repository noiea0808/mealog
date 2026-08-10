## Cursor Cloud specific instructions

### Project Overview

MEALOG (밀로그) is a Korean meal diary and social sharing PWA built with vanilla JavaScript (no bundler/build framework). The frontend is static HTML/JS/CSS served directly; the backend is Firebase Cloud Functions (Node.js 20).

### ⚠️ 식사 동기화 / 오프라인 / 네트워크 복구 코드를 만지기 전에

**`docs/sync-outbox-design.md` 를 먼저 읽으세요.**

이 서브시스템은 2026년 6~8월에 13차례 수정됐고, 매번 증상은 사라졌지만 같은 뿌리에서 새 구멍이
났습니다. 불변식은 하나입니다 — **사용자가 저장을 누른 기록은, 어떤 fallible한 단계도 시작하기
전에 이미 내구 저장돼 있다.**

특히 설계 문서의 §3 "폐기된 접근과 그 이유"를 읽으세요. 거기 적힌 것을 다시 제안하지 않기
위해서입니다. **이 영역에서 작은 패치가 그럴듯해 보이면 그게 경고 신호입니다** — 이미 12번
그럴듯했습니다. 증상만 막기 전에 불변식이 깨진 지점을 먼저 찾으세요.

### Git workflow (local-first)

- Default branch for development: **`staging`**
- Local feature branches: `feat/*`, `fix/*` — not `cursor/*`
- Before starting work: `./scripts/sync-staging.sh`
- See `.cursor/rules/local-git-workflow.mdc` for full rules

### Running the Frontend (Development)

Serve the repository root with any static HTTP server on port 8000:

```
python3 -m http.server 8000
```

The app loads at `http://localhost:8000/`. All JS modules are loaded from CDN (Firebase SDK, Tailwind, Chart.js, etc.), so no build step is required for the frontend.

### Running the Backend (Firebase Functions Emulator)

```
firebase emulators:start --only functions
```

Functions emulator runs on port 5001, emulator UI on port 4000.

**Important:** `functions/.env` must exist with at least placeholder values for `GEMINI_API_KEY` and `KAKAO_REST_API_KEY` (uses `defineString` from `firebase-functions/params`). Without this file, the emulator will prompt interactively and block. Copy from `functions/.env.example`.

### Generating `js/config.js`

The file `js/config.js` is `.gitignored` and must be generated locally:

```
npm run build
```

This reads env vars from `.env`, `.env.local`, and `functions/.env`, then writes `js/config.js`. Without it, the app falls back to `js/config.default.js` (committed) which has default/empty values.

### Node.js Version

Cloud Functions require **Node.js 20** (`functions/package.json` → `engines.node: "20"`). Use `nvm use 20` before running npm commands.

### Lint / Test

No ESLint config or test framework is configured in this project. There are no `lint` or `test` npm scripts.

### Key Gotchas

- The root `package.json` is primarily for **Capacitor** (Android wrapper) dependencies. The `postinstall` script patches two Capacitor plugins (safe-area, push-notifications NPE).
- `@capacitor/cli` v8 requires Node >= 22, but this only matters for Android builds (not needed for web dev).
- The frontend uses ES modules loaded from `gstatic.com` CDN — no local Firebase SDK install is needed for the web app.
- Firebase App Check uses reCAPTCHA v3; on localhost, it falls back to debug tokens. Without registering a debug token in the Firebase Console, Firestore writes may get `permission-denied`.
- The app connects to the **live Firebase project** (`mealog-r0`) by default, not to local emulators (except Functions if `connectFunctionsEmulator` is explicitly called).
