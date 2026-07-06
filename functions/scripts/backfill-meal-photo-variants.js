/**
 * meals photoDisplayUrls / photoThumbUrls 선택 백필 (로컬 Admin)
 *
 * 사용:
 *   node scripts/backfill-meal-photo-variants.js --dry-run
 *   node scripts/backfill-meal-photo-variants.js --days=60 --max-process=10
 *   node scripts/backfill-meal-photo-variants.js --cursor="artifacts/mealog-r0/users/UID/meals/MEAL_ID"
 *
 * 인증: GOOGLE_APPLICATION_CREDENTIALS 또는 gcloud auth application-default login
 */
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const mealPhotoVariantsBackfill = require('../mealPhotoVariantsBackfill.js');

const APP_ID = 'mealog-r0';

function argValue(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.split('=').slice(1).join('=');
}

const dryRun = process.argv.includes('--dry-run');
const daysBack = Number(argValue('days', '60'));
const maxProcess = Number(argValue('max-process', '15'));
const scanLimit = Number(argValue('scan-limit', '80'));
const cursor = argValue('cursor', '');

try {
  initializeApp({
    credential: applicationDefault(),
    projectId: 'mealog-r0'
  });
} catch (_) {
  try {
    initializeApp({ projectId: 'mealog-r0' });
  } catch (e2) {
    console.error('Firebase Admin init failed. Set GOOGLE_APPLICATION_CREDENTIALS or: gcloud auth application-default login');
    process.exit(1);
  }
}

const db = getFirestore();
const bucket = getStorage().bucket(mealPhotoVariantsBackfill.STORAGE_BUCKET);

async function main() {
  const result = await mealPhotoVariantsBackfill.runMealPhotoVariantsBackfillBatch(db, APP_ID, bucket, {
    dryRun,
    daysBack,
    maxProcess,
    scanLimit,
    cursorDocPath: cursor || undefined,
    concurrency: 5,
    syncSharedPhotos: true
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.aborted) {
    console.error('FAIL: failure rate exceeded threshold — stop and investigate');
    process.exit(2);
  }
  if (!result.done && result.nextCursor) {
    console.log('\nNext cursor (pass to --cursor=):');
    console.log(result.nextCursor);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
