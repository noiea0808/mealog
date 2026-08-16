/**
 * 배포 직전 js/config.js 안전 검사.
 *
 * 왜 필요한가 — `firebase deploy --only hosting` 은 npm 빌드를 거치지 않고 **작업 디렉터리를
 * 그대로 업로드한다**. js/config.js 는 .gitignore 에는 있지만 firebase.json 의 hosting ignore
 * 에는 없으므로, 각자 PC의 로컬 설정이 그대로 운영을 덮는다. 「깃에서 제외」와 「배포에서 제외」
 * 는 다른 목록인데 이름이 비슷해 착각하기 쉽다.
 *
 * 2026-08-16 실제로 그럴 뻔했다. 로컬 config.js 를 그대로 올렸다면 동시에 두 가지가 터졌다:
 *   - APPCHECK_DEBUG_TOKEN 이 실려서 App Check 우회 토큰이 전 세계에 공개 (문지기 옆문 개방)
 *   - DEMO_ACCOUNT_PASSWORD 가 비어서 「둘러보기」가 조용히 사망
 * 둘 다 배포 후에야 드러나는 종류라, 배포 전에 막는다.
 *
 * hosting ignore 에 js/config.js 를 넣는 방식은 쓸 수 없다 — 운영이 이 파일에 의존한다
 * (데모 비밀번호가 config.default.js 에는 비어 있고 여기에만 있다).
 *
 * 사용:
 *   node scripts/verify-deploy-config.js            # firebase.json hosting predeploy
 *   node scripts/verify-deploy-config.js <경로>      # 검사 대상 지정 (테스트용)
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'js', 'config.js');

function readExport(text, name) {
    const m = text.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*['"]([^'"]*)['"]`));
    return m ? m[1].trim() : null;
}

/**
 * @param {string} configPath
 * @param {{ allowEmptyDemoPassword?: boolean }} [opts]
 * @returns {{ errors: string[] }}
 */
function checkDeployConfig(configPath = DEFAULT_CONFIG_PATH, opts = {}) {
    const errors = [];

    if (!fs.existsSync(configPath)) {
        errors.push(
            `${configPath} 가 없습니다. 이 파일 없이 배포하면 데모 로그인·카카오 키가 빠집니다.\n` +
                '   → npm run build 로 생성하거나, 운영에 배포된 js/config.js 를 받아 두세요.'
        );
        return { errors };
    }

    const text = fs.readFileSync(configPath, 'utf8');

    const debugToken = readExport(text, 'APPCHECK_DEBUG_TOKEN');
    if (debugToken) {
        errors.push(
            'APPCHECK_DEBUG_TOKEN 에 값이 들어 있습니다 (로컬 개발용 App Check 우회 토큰).\n' +
                '   이대로 배포하면 사이트 소스를 연 누구나 App Check 검사를 건너뛸 수 있습니다.\n' +
                "   → 배포 전에 js/config.js 의 APPCHECK_DEBUG_TOKEN 을 '' 로 비우세요 (배포 후 되돌리면 됩니다)."
        );
    }

    const demoPassword = readExport(text, 'DEMO_ACCOUNT_PASSWORD');
    if (!demoPassword && !opts.allowEmptyDemoPassword) {
        errors.push(
            'DEMO_ACCOUNT_PASSWORD 가 비어 있습니다. 이대로 배포하면 「둘러보기」(데모 로그인)가 죽습니다.\n' +
                '   config.default.js 에도 비어 있어서 폴백이 없습니다.\n' +
                '   → 운영 값을 채우거나, 의도한 것이면 ALLOW_EMPTY_DEMO_PASSWORD=1 로 다시 실행하세요.'
        );
    }

    return { errors };
}

if (require.main === module) {
    const target = process.argv[2] || DEFAULT_CONFIG_PATH;
    const { errors } = checkDeployConfig(target, {
        allowEmptyDemoPassword: process.env.ALLOW_EMPTY_DEMO_PASSWORD === '1'
    });
    if (errors.length > 0) {
        console.error('\n❌ 배포 중단 — js/config.js 가 배포하기에 안전하지 않습니다.\n');
        errors.forEach((e, i) => console.error(` ${i + 1}. ${e}\n`));
        console.error('   (이 검사는 firebase.json 의 hosting predeploy 에 걸려 있습니다.)\n');
        process.exit(1);
    }
    console.log('✅ verify-deploy-config: 배포용 config.js 검사 통과');
}

module.exports = { checkDeployConfig, readExport, DEFAULT_CONFIG_PATH };
