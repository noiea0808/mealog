/**
 * legacy sharedPhotos(v1 사진 문서) → v2 게시물 1문서 백필
 * 사용: node scripts/migrate-moment-posts-v2.js [--dry-run]
 */
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const momentPostV2 = require('../momentPostV2.js');

const APP_ID = 'mealog-r0';
const dryRun = process.argv.includes('--dry-run');

try {
  initializeApp({
    credential: applicationDefault(),
    projectId: 'mealog-r0'
  });
} catch (_) {
  try {
    initializeApp({ projectId: 'mealog-r0' });
  } catch (e2) {
    console.error('Firebase Admin init failed. Set GOOGLE_APPLICATION_CREDENTIALS or run: gcloud auth application-default login');
    process.exit(1);
  }
}

const db = getFirestore();

function legacyGroupKey(data, docId) {
  if (data.type === 'daily') return `daily_${data.date || 'no-date'}_${data.userId || ''}`;
  if (data.type === 'best') {
    if (data.periodType && data.periodText) {
      return momentPostV2.bestSharePostId(data.periodType, data.periodText, data.userId);
    }
    return `best_${docId}_${data.userId || ''}`;
  }
  if (data.type === 'insight') {
    return momentPostV2.insightSharePostId(data.dateRangeText, data.userId);
  }
  if (data.entryId) return `${data.entryId}_${data.userId || ''}`;
  return `slot_${data.date || 'no-date'}_${data.slotId || 'no-slot'}_${data.userId || 'unknown'}`;
}

function toMs(t) {
  if (!t) return 0;
  if (typeof t.toDate === 'function') return t.toDate().getTime();
  if (typeof t === 'object' && typeof t.seconds === 'number') return t.seconds * 1000;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

async function main() {
  const coll = db.collection('artifacts').doc(APP_ID).collection('sharedPhotos');
  const snap = await coll.get();
  const buckets = new Map();

  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    if (data.schemaVersion === 2) continue;
    const key = legacyGroupKey(data, docSnap.id);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ id: docSnap.id, data });
  }

  let written = 0;
  let skipped = 0;

  for (const [postId, items] of buckets.entries()) {
    const docId = momentPostV2.sanitizeMomentPostDocId(postId);
    const existing = await coll.doc(docId).get();
    if (existing.exists && existing.data().schemaVersion === 2) {
      skipped++;
      continue;
    }

    items.sort((a, b) => {
      const ai = a.data.photoIndex;
      const bi = b.data.photoIndex;
      if (typeof ai === 'number' && typeof bi === 'number' && ai !== bi) return ai - bi;
      return toMs(b.data.timestamp) - toMs(a.data.timestamp);
    });

    const first = items[0].data;
    const maxTs = items.reduce((m, it) => Math.max(m, toMs(it.data.timestamp)), 0);
    const sharedAt = maxTs ? new Date(maxTs) : new Date();
    const aspectRatio =
      first.photoAspectRatio === '3:4' || first.photoAspectRatio === '4:3' ? first.photoAspectRatio : '1:1';
    const photos = items.map((it, idx) => ({
      url: it.data.photoUrl,
      index: typeof it.data.photoIndex === 'number' ? it.data.photoIndex : idx,
      aspectRatio
    }));

    const payload = {
      schemaVersion: 2,
      postId,
      userId: first.userId,
      entryId: first.entryId || null,
      type: first.type || null,
      sharedAt,
      timestamp: sharedAt,
      photos,
      photoUrl: photos[0]?.url || '',
      photoIndex: 0,
      photoAspectRatio: aspectRatio,
      userNickname: first.userNickname || '익명',
      userIcon: first.userIcon || '🐻',
      userPhotoUrl: first.userPhotoUrl || null,
      mealType: first.mealType || '',
      place: first.place || '',
      menuDetail: first.menuDetail || '',
      snackType: first.snackType || '',
      date: first.date || '',
      slotId: first.slotId || '',
      time: first.time || '',
      comment: first.comment || '',
      periodType: first.periodType || null,
      periodText: first.periodText || null,
      dateRangeText: first.dateRangeText || null,
      likeCount: 0,
      commentCount: 0
    };

    if (dryRun) {
      console.log('[dry-run] would write', docId, 'photos=', photos.length, 'sharedAt=', sharedAt.toISOString());
    } else {
      await coll.doc(docId).set(payload, { merge: false });
    }
    written++;
  }

  console.log(JSON.stringify({ dryRun, groups: buckets.size, written, skipped }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
