/**
 * Android 빌드 (Windows/Unix 호환)
 * JAVA_HOME 미설정 시 Android Studio 내장 JDK(jbr) 자동 탐색
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const androidDir = path.join(__dirname, '..', 'android');
const isWin = process.platform === 'win32';
const gradlew = isWin ? 'gradlew.bat' : './gradlew';
const task = process.argv[2] || 'assembleStagingDebug';

// JAVA_HOME 미설정 시 Android Studio jbr 사용 시도
if (!process.env.JAVA_HOME) {
  const candidates = isWin
    ? [
        'C:\\Program Files\\Android\\Android Studio\\jbr',
        'C:\\Program Files\\Android\\Android Studio\\jre',
      ]
    : [path.join(process.env.HOME || '', 'Android/Sdk/../Android Studio.app/Contents/jbr'), '/Applications/Android Studio.app/Contents/jbr'];
  for (const jdk of candidates) {
    const resolved = path.resolve(jdk);
    if (fs.existsSync(resolved)) {
      process.env.JAVA_HOME = resolved;
      console.log('✓ JAVA_HOME:', resolved);
      break;
    }
  }
  if (!process.env.JAVA_HOME) {
    console.error('❌ JAVA_HOME이 설정되지 않았습니다.');
    console.error('   Android Studio를 설치하거나, JDK 설치 후 JAVA_HOME 환경변수를 설정하세요.');
    console.error('   예: set JAVA_HOME=C:\\Program Files\\Android\\Android Studio\\jbr');
    process.exit(1);
  }
}

execSync(`${gradlew} ${task}`, { cwd: androidDir, stdio: 'inherit', env: process.env });
