/**
 * 모먼트 sharedPhotos v2 — 게시물 1문서 + sharedAt 1개 (Cloud Functions)
 */

function sanitizeMomentPostDocId(postId) {
  return String(postId || 'unknown')
    .replace(/\//g, '_')
    .replace(/\s/g, '_')
    .slice(0, 1500);
}

function mealSharePostId(mealData, userId) {
  const uid = String(userId || '').trim();
  const entryId = mealData && mealData.id != null ? String(mealData.id).trim() : '';
  if (entryId) return `${entryId}_${uid}`;
  const d = (mealData && mealData.date) || 'no-date';
  const s = (mealData && mealData.slotId) || 'no-slot';
  return `slot_${d}_${s}_${uid}`;
}

function dailySharePostId(date, userId) {
  return `daily_${date || 'no-date'}_${userId || ''}`;
}

function bestSharePostId(periodType, periodText, userId) {
  const pt = String(periodText || 'no-range').replace(/\s/g, '_');
  return `best_${periodType || 'unknown'}_${pt}_${userId || ''}`;
}

function insightSharePostId(dateRangeText, userId) {
  const range = String(dateRangeText || 'no-range').replace(/\s/g, '_');
  return `insight_${range}_${userId || ''}`;
}

function mealAspectRatio(mealData) {
  if (mealData && mealData.photoAspectRatio === '3:4') return '3:4';
  if (mealData && mealData.photoAspectRatio === '4:3') return '4:3';
  return '1:1';
}

/** mealData의 원본 photos ↔ photoDisplayUrls/photoThumbUrls(index 정렬)를 URL 키 맵으로 변환 */
function buildDerivativeMaps(mealData) {
  const displayByUrl = new Map();
  const thumbByUrl = new Map();
  const photos = mealData && Array.isArray(mealData.photos) ? mealData.photos : [];
  const disp = mealData && Array.isArray(mealData.photoDisplayUrls) ? mealData.photoDisplayUrls : [];
  const thumb = mealData && Array.isArray(mealData.photoThumbUrls) ? mealData.photoThumbUrls : [];
  photos.forEach((u, i) => {
    if (typeof u !== 'string' || !u) return;
    if (typeof disp[i] === 'string' && disp[i]) displayByUrl.set(u, disp[i]);
    if (typeof thumb[i] === 'string' && thumb[i]) thumbByUrl.set(u, thumb[i]);
  });
  return { displayByUrl, thumbByUrl };
}

function buildPhotosArray(photosToShare, aspectRatio, derivativeMaps) {
  const displayByUrl = (derivativeMaps && derivativeMaps.displayByUrl) || null;
  const thumbByUrl = (derivativeMaps && derivativeMaps.thumbByUrl) || null;
  return (photosToShare || []).map((url, index) => {
    const photo = {
      url,
      index,
      aspectRatio: aspectRatio || '1:1'
    };
    const d = displayByUrl ? displayByUrl.get(url) : '';
    const t = thumbByUrl ? thumbByUrl.get(url) : '';
    if (d) photo.displayUrl = d;
    if (t) photo.thumbUrl = t;
    return photo;
  });
}

function buildMealMomentPostV2Fields({
  photosToShare,
  mealData,
  userId,
  profile,
  postId,
  FieldValue
}) {
  const aspectRatio = mealAspectRatio(mealData);
  const photos = buildPhotosArray(photosToShare, aspectRatio, buildDerivativeMaps(mealData));
  const ts = FieldValue.serverTimestamp();
  return {
    schemaVersion: 2,
    postId,
    userId,
    entryId: (mealData && mealData.id) || null,
    type: null,
    sharedAt: ts,
    timestamp: ts,
    photos,
    photoUrl: photos[0] ? photos[0].url : '',
    photoDisplayUrl: photos[0] && photos[0].displayUrl ? photos[0].displayUrl : '',
    photoThumbUrl: photos[0] && photos[0].thumbUrl ? photos[0].thumbUrl : '',
    photoIndex: 0,
    photoAspectRatio: aspectRatio,
    userNickname: profile.nickname || '익명',
    userIcon: profile.icon || '🐻',
    userPhotoUrl: profile.photoUrl || null,
    mealType: (mealData && mealData.mealType) || '',
    place: (mealData && mealData.place) || '',
    menuDetail: (mealData && mealData.menuDetail) || '',
    deliveryVendor: (mealData && mealData.deliveryVendor) || '',
    deliveryPlaceId: (mealData && mealData.deliveryPlaceId) || '',
    deliveryPlaceAddress: (mealData && mealData.deliveryPlaceAddress) || '',
    deliveryPlaceData:
      mealData && mealData.deliveryPlaceData && typeof mealData.deliveryPlaceData === 'object'
        ? mealData.deliveryPlaceData
        : null,
    deliveryKakaoPlace: !!(mealData && mealData.deliveryKakaoPlace),
    snackType: (mealData && mealData.snackType) || '',
    date: (mealData && mealData.date) || '',
    slotId: (mealData && mealData.slotId) || '',
    time:
      (mealData && mealData.time) ||
      new Date().toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }),
    comment: (mealData && mealData.comment) || '',
    likeCount: 0,
    commentCount: 0
  };
}

function buildSpecialMomentPostV2Fields({
  type,
  userId,
  profile,
  postId,
  photoUrl,
  FieldValue,
  extra = {}
}) {
  const aspectRatio = '1:1';
  const photos = [{ url: photoUrl, index: 0, aspectRatio }];
  const ts = FieldValue.serverTimestamp();
  return {
    schemaVersion: 2,
    postId,
    userId,
    entryId: null,
    type,
    sharedAt: ts,
    timestamp: ts,
    photos,
    photoUrl,
    photoIndex: 0,
    photoAspectRatio: aspectRatio,
    userNickname: profile.nickname || '익명',
    userIcon: profile.icon || '🐻',
    userPhotoUrl: profile.photoUrl || null,
    comment: extra.comment || '',
    likeCount: 0,
    commentCount: 0,
    ...extra
  };
}

async function deleteLegacyPhotoDocsForQuery(batch, sharedColl, querySnap) {
  querySnap.docs.forEach((docSnap) => {
    const data = docSnap.data() || {};
    if (data.schemaVersion === 2) return;
    batch.delete(docSnap.ref);
  });
}

async function deleteMomentPostV2ByPostId(batch, sharedColl, postId) {
  if (!postId) return;
  const docId = sanitizeMomentPostDocId(postId);
  batch.delete(sharedColl.doc(docId));
}

function legacyGroupKey(data, docId) {
  if (data.type === 'daily') return dailySharePostId(data.date, data.userId);
  if (data.type === 'best') {
    if (data.periodType && data.periodText) {
      return bestSharePostId(data.periodType, data.periodText, data.userId);
    }
    return `best_${docId}_${data.userId || ''}`;
  }
  if (data.type === 'insight') return insightSharePostId(data.dateRangeText, data.userId);
  if (data.entryId) return `${data.entryId}_${data.userId || ''}`;
  return `slot_${data.date || 'no-date'}_${data.slotId || 'no-slot'}_${data.userId || 'unknown'}`;
}

function legacyTimestampMs(t) {
  if (!t) return 0;
  if (typeof t.toDate === 'function') return t.toDate().getTime();
  if (typeof t === 'object' && typeof t.seconds === 'number') return t.seconds * 1000;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * legacy v1 sharedPhotos(사진 1문서) → v2 게시물 1문서 백필
 * @returns {Promise<{ groups: number, written: number, skipped: number, dryRun: boolean }>}
 */
async function migrateLegacySharedPhotosToV2(db, appId, options = {}) {
  const dryRun = options.dryRun === true;
  const chunkSize = Math.min(Math.max(Number(options.chunkSize) || 40, 1), 100);
  const cursor = options.cursor ? String(options.cursor) : '';
  const { Timestamp } = require('firebase-admin/firestore');
  const coll = db.collection('artifacts').doc(appId).collection('sharedPhotos');
  const snap = await coll.get();
  const buckets = new Map();

  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    if (data.schemaVersion === 2) continue;
    const key = legacyGroupKey(data, docSnap.id);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ id: docSnap.id, data });
  }

  const sortedKeys = [...buckets.keys()].sort();
  let startIdx = 0;
  if (cursor) {
    const numeric = Number(cursor);
    if (Number.isFinite(numeric) && numeric >= 0) {
      startIdx = Math.min(Math.floor(numeric), sortedKeys.length);
    } else {
      const idx = sortedKeys.indexOf(cursor);
      startIdx = idx >= 0 ? idx + 1 : 0;
    }
  }
  const endIdx = Math.min(startIdx + chunkSize, sortedKeys.length);
  const keysToProcess = sortedKeys.slice(startIdx, endIdx);

  let written = 0;
  let skipped = 0;
  let batch = db.batch();
  let batchCount = 0;

  const commitBatch = async () => {
    if (dryRun || batchCount === 0) {
      batch = db.batch();
      batchCount = 0;
      return;
    }
    await batch.commit();
    batch = db.batch();
    batchCount = 0;
  };

  for (const postId of keysToProcess) {
    const items = buckets.get(postId) || [];
    if (!items.length) continue;
    const docId = sanitizeMomentPostDocId(postId);
    const existing = await coll.doc(docId).get();
    if (existing.exists && existing.data().schemaVersion === 2) {
      skipped++;
      continue;
    }

    items.sort((a, b) => {
      const ai = a.data.photoIndex;
      const bi = b.data.photoIndex;
      if (typeof ai === 'number' && typeof bi === 'number' && ai !== bi) return ai - bi;
      return legacyTimestampMs(b.data.timestamp) - legacyTimestampMs(a.data.timestamp);
    });

    const first = items[0].data;
    const maxTs = items.reduce((m, it) => Math.max(m, legacyTimestampMs(it.data.timestamp)), 0);
    const sharedAt = maxTs ? Timestamp.fromDate(new Date(maxTs)) : Timestamp.now();
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

    if (!dryRun) {
      batch.set(coll.doc(docId), payload, { merge: false });
      batchCount++;
      if (batchCount >= 20) await commitBatch();
    }
    written++;
  }

  await commitBatch();

  const done = endIdx >= sortedKeys.length;
  const nextCursor = done ? null : String(endIdx);

  return {
    groups: sortedKeys.length,
    processed: keysToProcess.length,
    written,
    skipped,
    dryRun,
    cursor,
    nextCursor,
    startIdx,
    endIdx,
    done
  };
}

module.exports = {
  sanitizeMomentPostDocId,
  mealSharePostId,
  dailySharePostId,
  bestSharePostId,
  insightSharePostId,
  buildMealMomentPostV2Fields,
  buildSpecialMomentPostV2Fields,
  deleteLegacyPhotoDocsForQuery,
  deleteMomentPostV2ByPostId,
  migrateLegacySharedPhotosToV2
};
