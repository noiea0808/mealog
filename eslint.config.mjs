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
