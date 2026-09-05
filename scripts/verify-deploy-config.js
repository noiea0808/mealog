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
 * 배포 후에야 드러나는 종류라, 배포 전에 막는다.
 *
 * 단 데모 비밀번호는 2026-09-05 에 **경고로 낮췄다**. 검사를 쓸 때 놓친 사실이 있다 —
 * 둘러보기의 주 경로는 비밀번호가 아니라 signInAsDemo 콜러블(2026-03-24, 0550804)이고,
 * js/demo-account.js 는 그걸 먼저 부른 뒤 실패했을 때만 이메일/비밀번호로 폴백한다.
 * 그래서 「폴백이 없다」는 문구는 사실과 반대였고, 이 PC 에서 나간 빌드들은 줄곧 이 값이
 * 빈 채였는데도 둘러보기가 멀쩡히 돌았다. 값이 비면 폴백이 없어지는 것은 맞으므로
 * 경고는 남긴다.
 *
 * hosting ignore 에 js/config.js 를 넣는 방식은 쓸 수 없다 — 운영이 이 파일에 의존한다
 * (데모 비밀번호가 config.default.js 에는 비어 있고 여기에만 있다).
 *
 * 같은 위험이 APK 빌드에도 있다. scripts/copy-to-www.js 가 js/ 를 통째로 www 로 복사하므로
 * 로컬 config.js 가 앱 안에 그대로 실린다. 그래서 checkDeployConfig 를 export 해 두고
 * copy-to-www.js 에서도 부른다(운영 빌드는 중단, 스테이징은 경고).
 *
 * 사용:
 *   node scripts/verify-deploy-config.js            # firebase.json hosting predeploy
 *   node scripts/verify-deploy-config.js <경로>      # 검사 대상 지정 (테스트용)
 *   require('./verify-deploy-config.js')            # copy-to-www.js 등에서 재사용
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
 * @returns {{ errors: string[], warnings: string[] }}
 */
function checkDeployConfig(configPath = DEFAULT_CONFIG_PATH, opts = {}) {
    const errors = [];
    const warnings = [];

    if (!fs.existsSync(configPath)) {
        errors.push(
            `${configPath} 가 없습니다. 이 파일 없이 배포하면 데모 로그인·카카오 키가 빠집니다.\n` +
                '   → npm run build 로 생성하거나, 운영에 배포된 js/config.js 를 받아 두세요.'
        );
        return { errors, warnings };
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
        warnings.push(
            'DEMO_ACCOUNT_PASSWORD 가 비어 있습니다 — 「둘러보기」의 이메일/비밀번호 폴백이 없습니다.\n' +
                '   주 경로인 signInAsDemo 콜러블이 살아 있으면 둘러보기는 정상 동작합니다.\n' +
                '   그 함수가 막히거나(App Check 등) 미배포면 둘러보기가 죽습니다.\n' +
                '   → 폴백까지 갖추려면 운영 값을 채우세요 (Vercel 환경변수 DEMO_ACCOUNT_PASSWORD).'
        );
    }

    return { errors, warnings };
}

if (require.main === module) {
    const target = process.argv[2] || DEFAULT_CONFIG_PATH;
    const { errors, warnings } = checkDeployConfig(target, {
        allowEmptyDemoPassword: process.env.ALLOW_EMPTY_DEMO_PASSWORD === '1'
    });
    warnings.forEach((w) => console.warn(`\n⚠️  ${w}\n`));
    if (errors.length > 0) {
        console.error('\n❌ 배포 중단 — js/config.js 가 배포하기에 안전하지 않습니다.\n');
        errors.forEach((e, i) => console.error(` ${i + 1}. ${e}\n`));
        console.error('   (이 검사는 firebase.json 의 hosting predeploy 에 걸려 있습니다.)\n');
        process.exit(1);
    }
    console.log('✅ verify-deploy-config: 배포용 config.js 검사 통과');
}

module.exports = { checkDeployConfig, readExport, DEFAULT_CONFIG_PATH };
