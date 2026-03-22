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

function isValidAndroidSdk(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  return (
    fs.existsSync(path.join(dir, 'platforms')) ||
    fs.existsSync(path.join(dir, 'build-tools'))
  );
}

/** local.properties 의 sdk.dir 값 → 실제 경로 (Gradle 이스케이프 \\: \\ 등 처리) */
function resolveSdkDirFromPropValue(val) {
  const trimmed = String(val || '')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (!trimmed) return null;
  let out = '';
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '\\' && i + 1 < trimmed.length) {
      const n = trimmed[i + 1];
      if (n === ':') {
        out += ':';
        i++;
        continue;
      }
      if (n === '\\') {
        out += '\\';
        i++;
        continue;
      }
    }
    out += trimmed[i];
  }
  return path.normalize(out);
}

/** local.properties 한 줄에서 sdk.dir 파싱 (Gradle과 동일 경로) */
function readSdkDirFromLocalProperties(propPath) {
  if (!fs.existsSync(propPath)) return null;
  try {
    const raw = fs.readFileSync(propPath, 'utf8');
    const m = raw.match(/^\s*sdk\.dir\s*=\s*(.+)\s*$/m);
    if (!m) return null;
    return resolveSdkDirFromPropValue(m[1].replace(/\r$/, '').trim());
  } catch (_) {
    return null;
  }
}

/** ANDROID_HOME → local.properties(sdk.dir) → 일반 경로 순으로 SDK 찾기 → local.properties 갱신 */
function ensureAndroidSdkLocalProperties() {
  const propPath = path.join(androidDir, 'local.properties');
  let sdkDir = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!isValidAndroidSdk(sdkDir)) sdkDir = null;

  if (!sdkDir) {
    const fromFile = readSdkDirFromLocalProperties(propPath);
    if (fromFile && isValidAndroidSdk(fromFile)) {
      sdkDir = fromFile;
    }
  }

  if (!sdkDir) {
    const candidates = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
      process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Android', 'Sdk'),
      /* 일부 PC는 SDK를 C:\\Users\\Public 등 공용 폴더에 둠 (Studio SDK Location 과 동일해야 함) */
      isWin && process.env.PUBLIC ? path.normalize(process.env.PUBLIC) : null,
      isWin ? 'C:\\Android\\Sdk' : null,
      !isWin && process.env.HOME ? path.join(process.env.HOME, 'Android', 'Sdk') : null,
    ].filter(Boolean);
    for (const c of candidates) {
      const resolved = path.resolve(c);
      if (isValidAndroidSdk(resolved)) {
        sdkDir = resolved;
        break;
      }
    }
  }

  if (!sdkDir) {
    const fromFileInvalid = readSdkDirFromLocalProperties(propPath);
    if (fromFileInvalid && !isValidAndroidSdk(fromFileInvalid)) {
      console.error('❌ android/local.properties 의 sdk.dir 은(는) 유효한 Android SDK 가 아닙니다:', fromFileInvalid);
      console.error('   SDK 루트에는 build-tools 또는 platforms 폴더가 있어야 합니다.');
      console.error('   Android Studio → Settings → Android SDK Location 이 SDK 루트(build-tools·platforms 가 있는 폴더)와 일치하는지 확인하세요.');
    } else {
      console.error('❌ Android SDK 경로를 찾을 수 없습니다.');
      console.error('   Android Studio 설치 후 SDK Manager로 플랫폼을 받거나, 다음 중 하나를 설정하세요:');
      console.error('   - 환경 변수 ANDROID_HOME (또는 ANDROID_SDK_ROOT)');
      console.error('   - 파일 android/local.properties 에 한 줄: sdk.dir=본인PC의_SDK_경로 (슬래시 사용 가능, 예: C:/Users/이름/AppData/Local/Android/Sdk)');
      console.error('   (Windows 기본 SDK 위치: %LOCALAPPDATA%\\\\Android\\\\Sdk)');
    }
    process.exit(1);
  }

  // 아래에서 local.properties 갱신에만 쓰임; 호출부에서 SDK 경로로 adb 안내에 사용
  const resolvedSdkDir = sdkDir;

  const sdkDirForProps = sdkDir.replace(/\\/g, '/');
  let needWrite = true;
  if (fs.existsSync(propPath)) {
    const raw = fs.readFileSync(propPath, 'utf8');
    const m = raw.match(/^\s*sdk\.dir\s*=\s*(.+)\s*$/m);
    if (m) {
      const existingResolved = resolveSdkDirFromPropValue(m[1].replace(/\r$/, '').trim());
      if (existingResolved && isValidAndroidSdk(existingResolved)) {
        needWrite = false;
      }
    }
  }
  if (needWrite) {
    let body = '';
    if (fs.existsSync(propPath)) {
      body = fs.readFileSync(propPath, 'utf8');
      if (/^\s*sdk\.dir\s*=/m.test(body)) {
        body = body.replace(/^\s*sdk\.dir\s*=[^\r\n]*/m, `sdk.dir=${sdkDirForProps}`);
      } else {
        body = `sdk.dir=${sdkDirForProps}\n${body}`;
      }
    } else {
      body = `sdk.dir=${sdkDirForProps}\n`;
    }
    fs.writeFileSync(propPath, body, 'utf8');
    console.log('✓ android/local.properties sdk.dir 설정:', sdkDirForProps);
  }

  return resolvedSdkDir;
}

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

const androidSdkDir = ensureAndroidSdkLocalProperties();

function isInstallGradleTask(t) {
  return /^install/i.test(String(t || ''));
}

/** install* 전에 adb 상태 안내 (unauthorized / 기기 없음) */
function warnAdbForInstallTask(sdkDir, t) {
  if (!isInstallGradleTask(t) || !sdkDir) return;
  const adb = path.join(sdkDir, 'platform-tools', isWin ? 'adb.exe' : 'adb');
  if (!fs.existsSync(adb)) return;
  try {
    const out = execSync(`"${adb}" devices`, { encoding: 'utf8' });
    const body = out.split(/\r?\n/).filter((line) => line.trim() && !/^List of devices/i.test(line));
    const hasDevice = body.some((line) => /\tdevice\s*$/.test(line));
    const unauthorized = body.some((line) => /unauthorized/i.test(line));
    if (hasDevice) return;
    if (unauthorized) {
      console.error('\n⚠ adb: 기기가 UNAUTHORIZED 입니다. 폰 화면에서 「USB 디버깅 허용」을 눌러 주세요.');
      console.error('   (이전에 거부했다면: 개발자 옵션 → USB 디버깅 끄고 다시 켜기 → 케이블 재연결)\n');
    } else if (body.length === 0) {
      console.warn('\n⚠ adb에 연결된 기기가 없습니다. USB 연결·개발자 옵션·USB 디버깅을 확인하세요.\n');
    } else {
      console.warn('\n⚠ adb: 사용 가능한 기기(device)가 없습니다. `adb devices` 출력을 확인하세요.\n');
    }
    console.error('   APK만 빌드(설치 생략): npm run cap:build:staging\n');
  } catch (_) {
    /* 무시 */
  }
}

warnAdbForInstallTask(androidSdkDir, task);

try {
  execSync(`${gradlew} ${task}`, { cwd: androidDir, stdio: 'inherit', env: process.env });
} catch (err) {
  if (isInstallGradleTask(task)) {
    console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('install* 작업 실패 (Gradle은 성공했을 수 있음 — 마지막 단계만 실패).');
    console.error('• USB 디버깅 미승인: 폰에서 RSA/「이 컴퓨터 허용」확인');
    console.error('• 기기 없음: 케이블·드라이버·adb devices');
    console.error('• 설치 없이 APK만: npm run cap:build:staging');
    console.error('   → android/app/build/outputs/apk/staging/debug/*.apk');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  }
  process.exit(err.status != null ? err.status : 1);
}
