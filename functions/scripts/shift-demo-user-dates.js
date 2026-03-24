#!/usr/bin/env node
/**
 * dummy@mealog.net 데모 계정: 모든 meal.date(및 연관 필드)를 같은 일수만큼 이동해
 * 기록 중 가장 최근 날짜가 오늘(실행 환경 로컬 달력)이 되도록 맞춤.
 *
 * 예: 기록이 3/15~3/20이고 오늘이 3/22이면 +2일 → 3/17~3/22.
 *
 * 실행 (functions 디렉터리에서):
 *   node scripts/shift-demo-user-dates.js
 *   node scripts/shift-demo-user-dates.js --dry-run
 *
 * 인증: 서비스 계정 JSON 경로를 GOOGLE_APPLICATION_CREDENTIALS에 두거나,
 *       `gcloud auth application-default login` (프로젝트 mealog-r0 권한 필요)
 */

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const APP_ID = 'mealog-r0';
const DEMO_EMAIL = 'dummy@mealog.net';

const BATCH_SIZE = 450;

function parseYmd(s) {
  if (!s || typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

function formatYmd(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

function addDaysToYmd(ymd, deltaDays) {
  const base = parseYmd(ymd);
  if (!base) return null;
  base.setDate(base.getDate() + deltaDays);
  return formatYmd(base);
}

function todayLocalYmd() {
  return formatYmd(new Date());
}

async function commitBatches(db, ops, dryRun) {
  if (dryRun || ops.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < ops.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = ops.slice(i, i + BATCH_SIZE);
    chunk.forEach(({ ref, data, merge }) => {
      if (merge) batch.set(ref, data, { merge: true });
      else batch.update(ref, data);
    });
    await batch.commit();
    n += chunk.length;
  }
  return n;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  initializeApp({
    credential: applicationDefault(),
    projectId: 'mealog-r0'
  });
  const db = getFirestore();
  const auth = getAuth();

  const user = await auth.getUserByEmail(DEMO_EMAIL);
  const uid = user.uid;
  const todayStr = todayLocalYmd();

  const mealsCol = db.collection('artifacts').doc(APP_ID).collection('users').doc(uid).collection('meals');
  const mealSnap = await mealsCol.get();
  if (mealSnap.empty) {
    console.log('식사 기록이 없습니다. 종료.');
    return;
  }

  let maxStr = null;
  mealSnap.docs.forEach((d) => {
    const date = d.data().date;
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      if (!maxStr || date > maxStr) maxStr = date;
    }
  });

  if (!maxStr) {
    console.log('유효한 meal.date가 없습니다. 종료.');
    return;
  }

  const offset = Math.round(
    (parseYmd(todayStr).getTime() - parseYmd(maxStr).getTime()) / 86400000
  );

  console.log(JSON.stringify({ uid, todayStr, maxDateBefore: maxStr, offsetDays: offset, dryRun }, null, 2));

  if (offset === 0) {
    console.log('이미 최신 날짜가 오늘과 같습니다. 변경 없음.');
    return;
  }

  const shiftYmd = (s) => (typeof s === 'string' ? addDaysToYmd(s, offset) : null);

  const mealOps = [];
  let mealUpdates = 0;
  for (const docSnap of mealSnap.docs) {
    const data = docSnap.data();
    const oldDate = data.date;
    if (typeof oldDate !== 'string') continue;
    const newDate = shiftYmd(oldDate);
    if (!newDate || newDate === oldDate) continue;
    mealUpdates++;
    if (!dryRun) {
      mealOps.push({ ref: docSnap.ref, data: { date: newDate }, merge: false });
    }
  }
  console.log(`meals: ${mealUpdates}건 날짜 변경 예정`);
  await commitBatches(db, mealOps, dryRun);

  const sharedCol = db.collection('artifacts').doc(APP_ID).collection('sharedPhotos');
  const sharedSnap = await sharedCol.where('userId', '==', uid).get();
  const sharedOps = [];
  let sharedUpdates = 0;
  sharedSnap.docs.forEach((docSnap) => {
    const data = docSnap.data();
    const oldDate = data.date;
    if (typeof oldDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(oldDate)) return;
    const newDate = shiftYmd(oldDate);
    if (!newDate || newDate === oldDate) return;
    sharedUpdates++;
    if (!dryRun) {
      sharedOps.push({
        ref: docSnap.ref,
        data: { date: newDate, updatedAt: FieldValue.serverTimestamp() },
        merge: false
      });
    }
  });
  console.log(`sharedPhotos: ${sharedUpdates}건 date 필드 변경 예정`);
  await commitBatches(db, sharedOps, dryRun);

  const settingsRef = db
    .collection('artifacts')
    .doc(APP_ID)
    .collection('users')
    .doc(uid)
    .collection('config')
    .doc('settings');
  const settingsSnap = await settingsRef.get();
  if (settingsSnap.exists) {
    const s = settingsSnap.data() || {};
    const dc = s.dailyComments && typeof s.dailyComments === 'object' ? { ...s.dailyComments } : null;
    if (dc && Object.keys(dc).length) {
      const next = {};
      let keysMoved = 0;
      for (const [k, v] of Object.entries(dc)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(k)) {
          const nk = shiftYmd(k);
          if (nk && nk !== k) keysMoved++;
          next[nk || k] = v;
        } else {
          next[k] = v;
        }
      }
      if (keysMoved > 0 && !dryRun) {
        await settingsRef.set({ dailyComments: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        console.log(`settings.dailyComments: ${keysMoved}개 키 이동`);
      } else if (keysMoved > 0) {
        console.log(`settings.dailyComments: [dry-run] ${keysMoved}개 키 이동 예정`);
      }
    }
  }

  console.log(dryRun ? '드라이런 완료 (Firestore 미반영)' : '완료. meal 쓰기 시 onMealWritten이 stats를 갱신합니다.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
