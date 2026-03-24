#!/usr/bin/env node
/**
 * 데모 계정 Firebase Auth 비밀번호 변경 (dummy@mealog.net 기본)
 *
 *   cd functions
 *   DEMO_ACCOUNT_NEW_PASSWORD='새비밀번호' node scripts/set-demo-user-password.js
 *
 * 로컬(Windows/Git Bash)에서는 서비스 계정 JSON 경로가 필요합니다.
 *   export GOOGLE_APPLICATION_CREDENTIALS="/c/Users/이름/Downloads/xxx-firebase-adminsdk.json"
 *   DEMO_ACCOUNT_NEW_PASSWORD='abc1111' node scripts/set-demo-user-password.js
 *
 * 또는 인자로 JSON 경로:
 *   DEMO_ACCOUNT_NEW_PASSWORD='abc1111' node scripts/set-demo-user-password.js "/c/Users/이름/Downloads/xxx.json"
 *
 * 선택: DEMO_ACCOUNT_EMAIL=other@example.com
 *
 * Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → "새 비공개 키 생성" 으로 받은 .json
 */

const fs = require('fs');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

const DEMO_EMAIL = (process.env.DEMO_ACCOUNT_EMAIL || 'dummy@mealog.net').trim().toLowerCase();
const newPassword = process.env.DEMO_ACCOUNT_NEW_PASSWORD;

function credentialPathCandidates(raw) {
  const candidates = [];
  if (!raw) return candidates;
  candidates.push(path.resolve(raw));
  candidates.push(raw);
  const m = raw.match(/^\/([a-zA-Z])\/(.*)$/);
  if (m) {
    const drive = m[1].toUpperCase();
    const rest = m[2].split('/').join(path.sep);
    candidates.push(`${drive}:${path.sep}${rest}`);
  }
  return [...new Set(candidates)];
}

function resolveCredentialPath() {
  const fromArg = process.argv[2];
  const fromEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const raw = (fromArg || fromEnv || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return null;
  for (const p of credentialPathCandidates(raw)) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}

async function main() {
  if (!newPassword || String(newPassword).length < 6) {
    console.error('필수: DEMO_ACCOUNT_NEW_PASSWORD (Firebase는 최소 6자)');
    console.error('예: DEMO_ACCOUNT_NEW_PASSWORD=\'...\' node scripts/set-demo-user-password.js');
    process.exit(1);
  }

  const keyPath = resolveCredentialPath();
  if (!keyPath) {
    console.error(`
[오류] 서비스 계정 JSON 파일이 필요합니다. (로컬에서는 applicationDefault()가 metadata.google.internal 을 찾다 실패할 수 있음)

  Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → "새 비공개 키 생성" → 받은 .json

  Git Bash 예시:
    export GOOGLE_APPLICATION_CREDENTIALS="/c/Users/본인/Downloads/mealog-r0-firebase-adminsdk-xxxxx.json"
    DEMO_ACCOUNT_NEW_PASSWORD='abc1111' node scripts/set-demo-user-password.js

  또는 JSON 경로를 인자로:
    DEMO_ACCOUNT_NEW_PASSWORD='abc1111' node scripts/set-demo-user-password.js "/c/Users/본인/Downloads/키.json"
`);
    process.exit(1);
  }

  const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  initializeApp({
    credential: cert(serviceAccount),
    projectId: 'mealog-r0'
  });
  const auth = getAuth();
  const user = await auth.getUserByEmail(DEMO_EMAIL);
  await auth.updateUser(user.uid, { password: String(newPassword) });
  console.log(`✅ 비밀번호 변경 완료: ${DEMO_EMAIL} (uid ${user.uid})`);
  console.log('다음: Vercel 환경 변수 DEMO_ACCOUNT_PASSWORD를 동일 값으로 맞추고 웹 재배포하세요.');
}

main().catch((e) => {
  console.error('❌ 실패:', e.message || e);
  process.exit(1);
});
