import globals from 'globals';

/**
 * MEALOG ESLint 설정
 *
 * 목표는 스타일 통일이 아니라 "조용히 잘못 도는 코드"를 잡는 것이다.
 * 빌드/번들러가 없어 정적 검사가 유일한 자동 안전망이므로 규칙은 좁고 확실한 것만 켠다.
 */
export default [
    {
        ignores: [
            'node_modules/**',
            'functions/node_modules/**',
            'www/**',
            'android/**',
            'css/**',
            'assets/**',
            'Icon/**',
            'docs/**',
            'js/config.js',
            'js/config.default.js',
            'js/config.example.js',
            // Capacitor UMD 번들 (벤더 생성물 — 직접 수정하지 않음)
            'js/capacitor.js',
            'js/capacitor-*-plugin.js'
        ]
    },

    // 프론트엔드: 브라우저 ES 모듈
    {
        files: ['js/**/*.js', 'sw.js', 'test-error-reporting.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.serviceworker,
                // CDN / 네이티브 브리지로 주입되는 전역
                Capacitor: 'readonly',
                Chart: 'readonly',
                html2canvas: 'readonly',
                lucide: 'readonly',
                Kakao: 'writable',
                kakao: 'readonly', // Kakao Maps SDK (Kakao JS SDK와 별개)
                firebase: 'readonly'
            }
        },
        rules: {
            // 오타·import 누락으로 런타임에서만 터지는 참조를 잡는다
            'no-undef': 'error',
            /**
             * window.sharedPhotos 는 appState 로 이관됐고 호환 shim 도 제거했다.
             * 다시 쓰면 아무 데도 반영되지 않는 전역이 새로 생기므로 막는다.
             */
            'no-restricted-properties': ['error', {
                object: 'window',
                property: 'sharedPhotos',
                message: "moment-share-state.js 의 getSharedPhotos() / setSharedPhotos() 를 쓰세요."
            }],
            /**
             * 상한 없는 네트워크 await 금지 — docs/sync-outbox-design.md §4.8
             *
             * 이 프로젝트에서 반복된 교착의 형태는 항상 같았다: 공유 in-flight 가드 안에서 상한
             * 없는 await 를 하면 그 가드가 영구히 잠긴다. 실제로 drainInFlight 가 그렇게 죽어
             * 세션이 끝날 때까지 아웃박스 드레인이 통째로 멈췄다.
             *
             * 개별 호출부에 타임아웃을 하나씩 박는 방식은 "다음에 추가되는 await" 를 못 막는다.
             * 문서는 안 읽힐 수 있지만 린트는 돈다 — 이것이 이 설계에서 유일하게 사람의 기억에
             * 의존하지 않는 안전망이다.
             *
             * 통과 방법: withDeadline(...) / withDeadlineOr(...) 로 감싼다.
             * (감싸면 직접 await 가 아니게 되므로 이 셀렉터에 걸리지 않는다)
             */
            'no-restricted-syntax': ['error', {
                // getToken 은 App Check 토큰 취득이다. 이게 매달리면 Auth 토큰 갱신과
                // Firestore 스트림 개설이 SDK 내부에서 같이 멈춘다 (2026-08-09 실기기 확인).
                selector: 'AwaitExpression > CallExpression[callee.name=/^(getDocFromServer|getDocsFromServer|waitForPendingWrites|disableNetwork|enableNetwork|getToken)$/]',
                message: 'utils/with-deadline.js 의 withDeadline() / withDeadlineOr() 로 감싸세요. 상한 없는 네트워크 await 는 가드를 영구히 잠급니다 (docs/sync-outbox-design.md §4.8).'
            }, {
                selector: 'AwaitExpression > CallExpression[callee.property.name="getIdToken"]',
                message: 'utils/with-deadline.js 의 withDeadlineOr(..., DEADLINE.PREFLIGHT, ...) 로 감싸세요. 토큰 갱신이 매달리면 setDoc 이 큐에 들어가기도 전에 상위 타임아웃이 터져 기록이 유실됩니다.'
            }],
            // 삼켜진 에러: 실패가 로그에도 남지 않아 원인 추적이 불가능해진다
            'no-empty': ['warn', { allowEmptyCatch: false }],
            'no-unused-vars': ['warn', {
                args: 'none',
                varsIgnorePattern: '^_',
                caughtErrors: 'none'
            }],
            // 같은 이름을 두 번 정의해 뒤엣것이 조용히 이기는 경우
            'no-dupe-keys': 'error',
            'no-dupe-args': 'error',
            'no-func-assign': 'error',
            'no-unreachable': 'warn',
            // await 없는 async 호출 등 비동기 실수
            'require-atomic-updates': 'off',
            'no-constant-condition': ['warn', { checkLoops: false }]
        }
    },

    /**
     * 관문 미적용 잔여 구간 — 아직 error 가 아니라 warn 이다.
     *
     * 1단계에서는 저장·동기화 핵심 경로(ops.js, firebase.js, meal-sync-manager.js,
     * meal-outbox-drain.js, network-loop.js, entry-and-core.js)만 error 로 강제했다.
     * 나머지는 읽기가 타임아웃됐을 때 "데이터 없음"으로 오인해 파괴적 동작을 하는 코드가
     * 있을 수 있어, 각 실패 경로를 확인하지 않은 채 기계적으로 감싸면 위험하다.
     *
     * 4단계(쓰기 지점 연결)에서 콘텐츠 경로를 정리하며 함께 error 로 올린다.
     * 그때까지 warn 으로 두는 이유는 **남은 일이 눈에 보이게** 하기 위해서다 —
     * 규칙에서 빼 버리면 조용히 잊힌다.
     */
    {
        files: [
            'js/db/board.js',
            'js/db/social.js',
            'js/db/feed-posts.js',
            'js/db/feed-notifications.js',
            'js/db/notification-targets.js',
            'js/db/listeners.js',
            'js/db/loading.js',
            'js/admin/**/*.js',
            'js/admin.js',
            'js/main/**/*.js',
            'js/analytics/**/*.js',
            'js/loading-spinner-config.js',
            'js/push-notifications.js',
            'js/auth*.js',
            'js/utils/**/*.js'
        ],
        rules: {
            'no-restricted-syntax': 'warn'
        }
    },

    // 핵심 경로는 예외 없이 error (위 warn 블록보다 뒤에 와야 이긴다)
    {
        files: [
            'js/db/ops.js',
            'js/firebase.js',
            'js/utils/meal-sync-manager.js',
            'js/utils/meal-outbox-drain.js',
            'js/utils/network-loop.js',
            'js/modals/entry-and-core.js'
        ],
        rules: {
            'no-restricted-syntax': 'error'
        }
    },

    /**
     * 테스트: Node ES 모듈 (`node --test`).
     *
     * 검사 대상 코드가 아니라 **검사 도구**이므로 관문 규칙(no-restricted-syntax)은 걸지 않는다 —
     * 테스트는 일부러 상한을 넘기고 일부러 매달리는 작업을 만든다.
     */
    {
        files: ['test/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { ...globals.node, ...globals.browser }
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-dupe-keys': 'error',
            'no-restricted-syntax': 'off'
        }
    },

    // Cloud Functions / 로컬 스크립트: Node CommonJS
    {
        files: ['functions/**/*.js', 'scripts/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: { ...globals.node }
        },
        rules: {
            'no-undef': 'error',
            'no-empty': ['warn', { allowEmptyCatch: false }],
            'no-unused-vars': ['warn', {
                args: 'none',
                varsIgnorePattern: '^_',
                caughtErrors: 'none'
            }],
            'no-dupe-keys': 'error',
            'no-dupe-args': 'error',
            'no-func-assign': 'error',
            'no-unreachable': 'warn'
        }
    }
];
