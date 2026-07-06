/**
 * meals photoDisplayUrls / photoThumbUrls 선택 백필 (최근 N일, Admin 전용)
 * - Storage 원본 다운로드 → sharp 800/200 JPEG → 별도 업로드
 * - Firestore: photos 불변, 파생 URL 필드만 부분 업데이트
 */
const crypto = require('crypto');
const sharp = require('sharp');
const momentPostV2 = require('./momentPostV2.js');

const STORAGE_BUCKET = 'mealog-r0.firebasestorage.app';

const DISPLAY_OPTS = { maxEdge: 800, quality: 0.8, maxKB: 300 };
const THUMB_OPTS = { maxEdge: 200, quality: 0.75, maxKB: 60 };

function ymdDaysAgo(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - Math.max(1, Number(daysBack) || 60));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function storagePathFromDownloadUrl(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return null;
  if (!imageUrl.includes('firebasestorage.googleapis.com')) return null;
  try {
    const url = new URL(imageUrl);
    const pathMatch = url.pathname.match(/\/o\/(.+)$/);
    if (!pathMatch) return null;
    return decodeURIComponent(pathMatch[1]);
  } catch {
    return null;
  }
}

/** 공유 캡처·비식사 경로·이미 파생본 파일 제외 */
function isExcludedPhotoUrl(url) {
  const path = storagePathFromDownloadUrl(url);
  if (!path) return true;
  if (!/^users\/[^/]+\/meals\/[^/]+\//.test(path)) return true;
  if (/\/meals\/daily_/i.test(path)) return true;
  if (/\/meals\/migrated\//i.test(path)) return true;
  if (/_([dt])\.jpg$/i.test(path)) return true;
  if (/_bf_[dt]\.jpg$/i.test(path)) return true;
  return false;
}

function sanitizePhotoArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((p) => typeof p === 'string' && p.trim() && !p.startsWith('data:image'));
}

function mealNeedsVariantBackfill(mealData) {
  const photos = sanitizePhotoArray(mealData && mealData.photos);
  if (photos.length === 0) return false;
  const disp = Array.isArray(mealData.photoDisplayUrls) ? mealData.photoDisplayUrls : [];
  const thumb = Array.isArray(mealData.photoThumbUrls) ? mealData.photoThumbUrls : [];
  if (disp.length !== photos.length || thumb.length !== photos.length) return true;
  for (let i = 0; i < photos.length; i++) {
    if (!disp[i] || !thumb[i]) return true;
  }
  return false;
}

function parseMealPathIds(storagePath) {
  const m = storagePath.match(/^users\/([^/]+)\/meals\/([^/]+)\//);
  if (!m) return null;
  return { userId: m[1], entryId: m[2] };
}

async function resizeJpegBuffer(inputBuffer, { maxEdge, quality, maxKB }) {
  const meta = await sharp(inputBuffer).metadata();
  const w = meta.width || 1;
  const h = meta.height || 1;
  const long = Math.max(w, h);
  const resizeOpts =
    long > maxEdge
      ? {
          width: w >= h ? maxEdge : undefined,
          height: h > w ? maxEdge : undefined,
          fit: 'inside',
          withoutEnlargement: true
        }
      : null;
  let q = quality;
  for (let attempt = 0; attempt < 10; attempt++) {
    let p = sharp(inputBuffer).rotate();
    if (resizeOpts) p = p.resize(resizeOpts);
    const buf = await p.jpeg({ quality: Math.round(q * 100), mozjpeg: true }).toBuffer();
    if (!maxKB || buf.length <= maxKB * 1024 || q <= 0.5) return buf;
    q = Math.max(0.5, q - 0.08);
  }
  let p = sharp(inputBuffer).rotate();
  if (resizeOpts) p = p.resize(resizeOpts);
  return p.jpeg({ quality: 50, mozjpeg: true }).toBuffer();
}

async function uploadVariantBuffer(bucket, storagePathDir, variant, buffer) {
  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  const fileName = `${ts}_${rand}_bf_${variant}.jpg`;
  const fullPath = `${storagePathDir.replace(/\/$/, '')}/${fileName}`;
  const file = bucket.file(fullPath);
  const token = crypto.randomUUID();
  await file.save(buffer, {
    metadata: {
      contentType: 'image/jpeg',
      metadata: { firebaseStorageDownloadTokens: token }
    }
  });
  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(fullPath)}?alt=media&token=${token}`;
  return url;
}

async function withRetry(fn, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, 400 * Math.pow(2, i)));
      }
    }
  }
  throw lastErr;
}

async function processOnePhotoUrl(bucket, photoUrl) {
  const storagePath = storagePathFromDownloadUrl(photoUrl);
  if (!storagePath || isExcludedPhotoUrl(photoUrl)) {
    return { skipped: true, reason: 'excluded_url', displayUrl: '', thumbUrl: '' };
  }
  const ids = parseMealPathIds(storagePath);
  if (!ids) {
    return { skipped: true, reason: 'bad_path', displayUrl: '', thumbUrl: '' };
  }
  const dir = storagePath.replace(/\/[^/]+$/, '');
  const file = bucket.file(storagePath);
  const [exists] = await file.exists();
  if (!exists) {
    return { skipped: true, reason: 'storage_missing', displayUrl: '', thumbUrl: '' };
  }

  const [contents] = await withRetry(() => file.download());
  const [displayBuf, thumbBuf] = await Promise.all([
    resizeJpegBuffer(contents, DISPLAY_OPTS),
    resizeJpegBuffer(contents, THUMB_OPTS)
  ]);
  const [displayUrl, thumbUrl] = await Promise.all([
    uploadVariantBuffer(bucket, dir, 'd', displayBuf),
    uploadVariantBuffer(bucket, dir, 't', thumbBuf)
  ]);
  return { skipped: false, displayUrl, thumbUrl };
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function backfillMealDocument(db, appId, userId, mealId, mealData, bucket, opts) {
  const photos = sanitizePhotoArray(mealData.photos);
  const dryRun = opts.dryRun === true;
  const concurrency = Math.min(Math.max(Number(opts.concurrency) || 5, 1), 8);

  if (dryRun) {
    const eligible = photos.filter((u) => !isExcludedPhotoUrl(u)).length;
    return {
      mealId,
      userId,
      photoCount: photos.length,
      photoFailures: 0,
      photoSkipped: photos.length - eligible,
      updated: false,
      dryRun: true,
      wouldUpdate: eligible > 0
    };
  }

  const displayUrls = [];
  const thumbUrls = [];
  let photoFailures = 0;
  let photoSkipped = 0;

  const photoResults = await mapPool(photos, concurrency, async (url) => {
    if (isExcludedPhotoUrl(url)) {
      photoSkipped++;
      return { displayUrl: '', thumbUrl: '', skipped: true };
    }
    try {
      const r = await withRetry(() => processOnePhotoUrl(bucket, url));
      if (r.skipped) {
        photoSkipped++;
        return { displayUrl: '', thumbUrl: '', skipped: true };
      }
      return { displayUrl: r.displayUrl, thumbUrl: r.thumbUrl, skipped: false };
    } catch (e) {
      photoFailures++;
      return { displayUrl: '', thumbUrl: '', skipped: false, error: e.message || String(e) };
    }
  });

  for (const r of photoResults) {
    displayUrls.push(r.displayUrl || '');
    thumbUrls.push(r.thumbUrl || '');
  }

  const hasAnyVariant = displayUrls.some(Boolean) && thumbUrls.some(Boolean);
  if (hasAnyVariant) {
    const mealRef = db
      .collection('artifacts')
      .doc(appId)
      .collection('users')
      .doc(userId)
      .collection('meals')
      .doc(mealId);
    await mealRef.update({
      photoDisplayUrls: displayUrls,
      photoThumbUrls: thumbUrls
    });
    if (opts.syncSharedPhotos !== false) {
      await patchSharedPhotosV2FromMeal(db, appId, userId, { ...mealData, id: mealId }, photos, displayUrls, thumbUrls);
    }
  }

  return {
    mealId,
    userId,
    photoCount: photos.length,
    photoFailures,
    photoSkipped,
    updated: hasAnyVariant,
    dryRun: false
  };
}

async function patchSharedPhotosV2FromMeal(db, appId, userId, mealData, photos, displayUrls, thumbUrls) {
  const postId = momentPostV2.mealSharePostId(mealData, userId);
  const docId = momentPostV2.sanitizeMomentPostDocId(postId);
  const ref = db.collection('artifacts').doc(appId).collection('sharedPhotos').doc(docId);
  const snap = await ref.get();
  if (!snap.exists) return { patched: false, reason: 'no_shared_post' };
  const data = snap.data() || {};
  if (data.schemaVersion !== 2) return { patched: false, reason: 'not_v2' };
  if (data.type === 'daily' || data.type === 'best' || data.type === 'insight') {
    return { patched: false, reason: 'special_share' };
  }

  const displayByUrl = new Map();
  const thumbByUrl = new Map();
  photos.forEach((u, i) => {
    if (displayUrls[i]) displayByUrl.set(u, displayUrls[i]);
    if (thumbUrls[i]) thumbByUrl.set(u, thumbUrls[i]);
  });

  const srcPhotos = Array.isArray(data.photos) ? data.photos : [];
  const updatedPhotos = srcPhotos.map((p) => {
    const url = p && p.url;
    if (!url) return p;
    const d = displayByUrl.get(url);
    const t = thumbByUrl.get(url);
    const next = { ...p };
    if (d) next.displayUrl = d;
    if (t) next.thumbUrl = t;
    return next;
  });
  const first = updatedPhotos[0] || {};
  await ref.update({
    photos: updatedPhotos,
    photoDisplayUrl: first.displayUrl || '',
    photoThumbUrl: first.thumbUrl || ''
  });
  return { patched: true };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} appId
 * @param {import('firebase-admin/storage').Bucket} bucket
 * @param {object} options
 */
async function runMealPhotoVariantsBackfillBatch(db, appId, bucket, options = {}) {
  const daysBack = Math.min(Math.max(Number(options.daysBack) || 60, 1), 365);
  const cutoffDate = options.cutoffDate || ymdDaysAgo(daysBack);
  const scanLimit = Math.min(Math.max(Number(options.scanLimit) || 80, 1), 200);
  const maxProcess = Math.min(Math.max(Number(options.maxProcess) || 15, 1), 50);
  const dryRun = options.dryRun === true;
  const failRateAbort = Number(options.failRateAbort) || 0.05;

  let query = db.collectionGroup('meals').where('date', '>=', cutoffDate).orderBy('date', 'asc').limit(scanLimit);
  if (options.cursorDocPath) {
    const cursorSnap = await db.doc(String(options.cursorDocPath)).get();
    if (cursorSnap.exists) {
      query = query.startAfter(cursorSnap);
    }
  }

  const snap = await query.get();
  const candidates = [];
  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    if (!mealNeedsVariantBackfill(data)) continue;
    const pathParts = docSnap.ref.path.split('/');
    const userIdx = pathParts.indexOf('users');
    const userId = userIdx >= 0 ? pathParts[userIdx + 1] : null;
    if (!userId) continue;
    candidates.push({ docSnap, userId, mealId: docSnap.id, data });
    if (candidates.length >= maxProcess) break;
  }

  const results = [];
  let totalPhotoFailures = 0;
  let totalPhotos = 0;

  for (const item of candidates) {
    const r = await backfillMealDocument(db, appId, item.userId, item.mealId, item.data, bucket, {
      dryRun,
      concurrency: options.concurrency,
      syncSharedPhotos: options.syncSharedPhotos
    });
    results.push(r);
    totalPhotoFailures += r.photoFailures || 0;
    totalPhotos += r.photoCount || 0;
  }

  const failRate = totalPhotos > 0 ? totalPhotoFailures / totalPhotos : 0;
  const lastDoc = snap.docs.length ? snap.docs[snap.docs.length - 1] : null;
  const nextCursor = lastDoc ? lastDoc.ref.path : null;

  return {
    cutoffDate,
    dryRun,
    scanned: snap.size,
    candidates: candidates.length,
    processed: results.length,
    updated: results.filter((r) => r.updated).length,
    totalPhotoFailures,
    totalPhotos,
    failRate,
    aborted: failRate > failRateAbort && totalPhotos > 0,
    results,
    nextCursor,
    done: snap.empty || snap.docs.length < scanLimit
  };
}

module.exports = {
  ymdDaysAgo,
  mealNeedsVariantBackfill,
  isExcludedPhotoUrl,
  runMealPhotoVariantsBackfillBatch,
  patchSharedPhotosV2FromMeal,
  STORAGE_BUCKET
};
