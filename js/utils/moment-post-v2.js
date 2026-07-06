/**
 * 모먼트 sharedPhotos v2 — 게시물 1문서 + sharedAt (클라이언트)
 */
import { getSharedPhotoGroupKey, getPostIdFromPhotoGroup, processPhotosToGroups } from '../render/post-group-utils.js';
import { sharedPhotoGroupSortMs, sharedPhotoTimestampMs } from './shared-photo-timestamp.js';

export function sanitizeMomentPostDocId(postId) {
  return String(postId || 'unknown')
    .replace(/\//g, '_')
    .replace(/\s/g, '_')
    .slice(0, 1500);
}

export function mealSharePostId(mealData, userId) {
  const uid = String(userId || '').trim();
  const entryId = mealData?.id != null ? String(mealData.id).trim() : '';
  if (entryId) return `${entryId}_${uid}`;
  const d = mealData?.date || 'no-date';
  const s = mealData?.slotId || 'no-slot';
  return `slot_${d}_${s}_${uid}`;
}

export function isMomentPostV2(doc) {
  if (!doc) return false;
  if (doc.schemaVersion === 2) return true;
  return Array.isArray(doc.photos) && doc.photos.length > 0 && !!(doc.postId || doc.sharedAt);
}

/** v2 게시물 → renderPostGroupHtml용 photoGroup 배열 */
export function momentPostV2ToPhotoGroup(doc) {
  if (!doc) return [];
  const photos = Array.isArray(doc.photos) ? doc.photos : [];
  const aspectDefault =
    doc.photoAspectRatio === '3:4' || doc.photoAspectRatio === '4:3' ? doc.photoAspectRatio : '1:1';
  const ts = doc.sharedAt || doc.timestamp;
  if (photos.length === 0 && doc.photoUrl) {
    return [{
      id: doc.id,
      photoUrl: doc.photoUrl,
      photoDisplayUrl: doc.photoDisplayUrl || '',
      photoThumbUrl: doc.photoThumbUrl || '',
      photoIndex: 0,
      photoAspectRatio: aspectDefault,
      userId: doc.userId,
      userNickname: doc.userNickname,
      userIcon: doc.userIcon,
      userPhotoUrl: doc.userPhotoUrl,
      entryId: doc.entryId,
      type: doc.type,
      date: doc.date,
      slotId: doc.slotId,
      time: doc.time,
      mealType: doc.mealType,
      place: doc.place,
      menuDetail: doc.menuDetail,
      snackType: doc.snackType,
      comment: doc.comment,
      timestamp: ts,
      sharedAt: ts,
      banned: doc.banned,
      periodType: doc.periodType,
      periodText: doc.periodText,
      dateRangeText: doc.dateRangeText,
      likeCount: doc.likeCount,
      commentCount: doc.commentCount,
      _v2Parent: doc
    }];
  }
  return photos.map((p, idx) => ({
    id: doc.id,
    photoUrl: p.url || p.photoUrl || '',
    photoDisplayUrl: p.displayUrl || p.photoDisplayUrl || '',
    photoThumbUrl: p.thumbUrl || p.photoThumbUrl || '',
    photoIndex: typeof p.index === 'number' ? p.index : idx,
    photoAspectRatio:
      p.aspectRatio === '3:4' || p.aspectRatio === '4:3' ? p.aspectRatio : aspectDefault,
    userId: doc.userId,
    userNickname: doc.userNickname,
    userIcon: doc.userIcon,
    userPhotoUrl: doc.userPhotoUrl,
    entryId: doc.entryId,
    type: doc.type,
    date: doc.date,
    slotId: doc.slotId,
    time: doc.time,
    mealType: doc.mealType,
    place: doc.place,
    menuDetail: doc.menuDetail,
    snackType: doc.snackType,
    comment: doc.comment,
    timestamp: ts,
    sharedAt: ts,
    banned: doc.banned,
    periodType: doc.periodType,
    periodText: doc.periodText,
    dateRangeText: doc.dateRangeText,
    likeCount: doc.likeCount,
    commentCount: doc.commentCount,
    _v2Parent: doc
  }));
}

export function collectV2PostKeys(docs) {
  const keys = new Set();
  for (const d of docs || []) {
    if (!isMomentPostV2(d)) continue;
    keys.add(String(d.postId || d.id || ''));
    keys.add(String(d.id || ''));
    if (d.entryId && d.userId) keys.add(`${d.entryId}_${d.userId}`);
    if (d.type === 'daily' && d.date && d.userId) keys.add(`daily_${d.date}_${d.userId}`);
  }
  return keys;
}

function isV1DocSupersededByV2(photo, v2Keys) {
  if (!photo || isMomentPostV2(photo)) return false;
  const groupKey = getSharedPhotoGroupKey(photo);
  const postId = getPostIdFromPhotoGroup([photo]);
  return v2Keys.has(groupKey) || v2Keys.has(postId);
}

/** Firestore 문서 목록 → 피드 게시물(photoGroup) 배열, 최신순 */
export function docsToSortedPhotoGroups(docs) {
  const v2Keys = collectV2PostKeys(docs);
  const v2Docs = (docs || []).filter(isMomentPostV2);
  const v1Photos = (docs || []).filter((d) => !isMomentPostV2(d) && !isV1DocSupersededByV2(d, v2Keys));
  const groups = [
    ...v2Docs.map(momentPostV2ToPhotoGroup),
    ...processPhotosToGroups(v1Photos)
  ];
  return groups.sort((a, b) => {
    const cmp = sharedPhotoGroupSortMs(b) - sharedPhotoGroupSortMs(a);
    return cmp !== 0 ? cmp : (getPostIdFromPhotoGroup(a) || '').localeCompare(getPostIdFromPhotoGroup(b) || '', 'en');
  });
}

/** 피드 캐시용: 상위 N개 게시물에 해당하는 원본 문서만 (v2=1문서, v1=사진 문서들) */
export function collapseDocsToFeedPage(allDocs, targetPosts = 10) {
  const groups = docsToSortedPhotoGroups(allDocs);
  const kept = groups.slice(0, targetPosts);
  const feedDocs = [];
  const seen = new Set();
  for (const group of kept) {
    const parent = group[0]?._v2Parent;
    if (parent) {
      if (!seen.has(parent.id)) {
        seen.add(parent.id);
        feedDocs.push(parent);
      }
      continue;
    }
    for (const p of group) {
      if (p.id && !seen.has(p.id)) {
        seen.add(p.id);
        feedDocs.push(p);
      }
    }
  }
  feedDocs.sort((a, b) => sharedPhotoTimestampMs(b) - sharedPhotoTimestampMs(a));
  return {
    feedDocs,
    groups: kept,
    hasMorePosts: groups.length > targetPosts
  };
}

export function countMomentPostsFromDocs(docs) {
  return docsToSortedPhotoGroups(docs).length;
}

export function buildOptimisticMomentPostV2(record, photosToShare, profile, userId) {
  const uid = userId || record?.userId;
  const postId = mealSharePostId(record, uid);
  const now = new Date().toISOString();
  const aspectRatio =
    record?.photoAspectRatio === '3:4' || record?.photoAspectRatio === '4:3' ? record.photoAspectRatio : '1:1';
  // record.photos ↔ photoDisplayUrls/photoThumbUrls(index 정렬)에서 공유 URL별 파생본 매칭
  const recPhotos = Array.isArray(record?.photos) ? record.photos : [];
  const recDisplay = Array.isArray(record?.photoDisplayUrls) ? record.photoDisplayUrls : [];
  const recThumb = Array.isArray(record?.photoThumbUrls) ? record.photoThumbUrls : [];
  const displayByUrl = new Map();
  const thumbByUrl = new Map();
  recPhotos.forEach((u, i) => {
    if (typeof u !== 'string' || !u) return;
    if (recDisplay[i]) displayByUrl.set(u, recDisplay[i]);
    if (recThumb[i]) thumbByUrl.set(u, recThumb[i]);
  });
  const photos = (photosToShare || []).map((url, index) => {
    const photo = { url, index, aspectRatio };
    const d = displayByUrl.get(url);
    const t = thumbByUrl.get(url);
    if (d) photo.displayUrl = d;
    if (t) photo.thumbUrl = t;
    return photo;
  });
  return {
    schemaVersion: 2,
    id: sanitizeMomentPostDocId(postId),
    postId,
    userId: uid,
    entryId: record?.id || null,
    sharedAt: now,
    timestamp: now,
    photos,
    photoUrl: photos[0]?.url || '',
    photoDisplayUrl: photos[0]?.displayUrl || '',
    photoThumbUrl: photos[0]?.thumbUrl || '',
    photoIndex: 0,
    photoAspectRatio: aspectRatio,
    userNickname: profile?.nickname || '익명',
    userIcon: profile?.icon || '🐻',
    userPhotoUrl: profile?.photoUrl || null,
    date: record?.date || '',
    slotId: record?.slotId || '',
    time: record?.time || '',
    mealType: record?.mealType || '',
    place: record?.place || '',
    menuDetail: record?.menuDetail || '',
    snackType: record?.snackType || '',
    comment: record?.comment || '',
    likeCount: 0,
    commentCount: 0
  };
}
