/**
 * Android 빌드 (Windows/Unix 호환)
 * JAVA_HOME 미설정 시 JDK 자동 탐색 (java.exe 존재 여부 검증)
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const androidDir = path.join(__dirname, '..', 'android');
const isWin = process.platform === 'win32';
const gradlew = isWin ? 'gradlew.bat' : './gradlew';
const task = process.argv[2] || 'assembleStagingDebug';

function hasJavaExe(jdkPath) {
  const javaExe = path.join(jdkPath, 'bin', isWin ? 'java.exe' : 'java');
  return fs.existsSync(javaExe);
}

// JAVA_HOME 미설정 또는 유효하지 않을 때 JDK 자동 탐색
const currentJavaHome = process.env.JAVA_HOME;
if (!currentJavaHome || !hasJavaExe(currentJavaHome)) {
  const explicitCandidates = isWin
    ? [
        'C:\\Program Files\\Android\\Android Studio\\jbr',
        'C:\\Program Files\\Android\\Android Studio\\jre',
        'C:\\Program Files\\Microsoft\\jdk-17.0.14.101-hotspot',
        'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.10.7-hotspot',
        'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.8.7-hotspot',
        'C:\\Program Files\\Java\\jdk-17',
        'C:\\Program Files\\Java\\jdk-21',
        'C:\\Program Files\\Java\\jdk-11',
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Eclipse Adoptium', 'jdk-17.0.8.7-hotspot') : null,
      ].filter(Boolean)
    : [
        path.join(process.env.HOME || '', 'Android/Sdk/../Android Studio.app/Contents/jbr'),
        '/Applications/Android Studio.app/Contents/jbr',
        '/usr/lib/jvm/java-17-openjdk',
        '/usr/lib/jvm/java-21-openjdk',
        '/usr/lib/jvm/default-java',
      ];
  // Eclipse Adoptium, Microsoft, Java 폴더 내 첫 번째 유효한 jdk 찾기
  const dynamicDirs = isWin
    ? ['C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Microsoft', 'C:\\Program Files\\Java']
    : [];
  const dynamicCandidates = [];
  for (const dir of dynamicDirs) {
    if (fs.existsSync(dir)) {
      try {
        const subs = fs.readdirSync(dir).filter((n) => n.startsWith('jdk'));
        for (const sub of subs) {
          dynamicCandidates.push(path.join(dir, sub));
        }
      } catch (_) {}
    }
  }
  const candidates = [...explicitCandidates, ...dynamicCandidates];
  for (const jdk of candidates) {
    const resolved = path.resolve(jdk);
    if (fs.existsSync(resolved) && hasJavaExe(resolved)) {
      process.env.JAVA_HOME = resolved;
      console.log('✓ JAVA_HOME:', resolved);
      break;
    }
  }
  if (!process.env.JAVA_HOME || !hasJavaExe(process.env.JAVA_HOME)) {
    console.error('❌ 유효한 JDK를 찾을 수 없습니다. (JAVA_HOME/bin/java.exe 필요)');
    console.error('   다음 중 하나를 설치하고 JAVA_HOME을 설정하세요:');
    console.error('   - Microsoft Build of OpenJDK: https://learn.microsoft.com/ko-kr/java/openjdk/download');
    console.error('   - Eclipse Temurin: https://adoptium.net/');
    console.error('   예: set JAVA_HOME=C:\\Program Files\\Microsoft\\jdk-17.0.14.101-hotspot');
    process.exit(1);
  }
}

execSync(`${gradlew} ${task}`, { cwd: androidDir, stdio: 'inherit', env: process.env });
