/**
 * 모먼트 피드 캐시 — 공유/해제 시 전체 reload 없이 부분 갱신
 */
import { sharedPhotoTimestampMs } from './shared-photo-timestamp.js';
import {
  isMomentPostV2,
  mealSharePostId,
  sanitizeMomentPostDocId,
  collectV2PostKeys
} from './moment-post-v2.js';
import { getSharedPhotoGroupKey } from '../render/post-group-utils.js';

function postKeysForDoc(doc) {
  if (!doc) return [];
  const keys = new Set();
  if (doc.postId) keys.add(String(doc.postId));
  if (doc.id) keys.add(String(doc.id));
  if (doc.entryId && doc.userId) keys.add(`${doc.entryId}_${doc.userId}`);
  if (isMomentPostV2(doc)) {
    keys.add(sanitizeMomentPostDocId(doc.postId || doc.id));
  }
  if (!isMomentPostV2(doc)) {
    keys.add(getSharedPhotoGroupKey(doc));
  }
  return [...keys];
}

function docMatchesPostKeys(doc, keys) {
  return postKeysForDoc(doc).some((k) => keys.has(k));
}

/** 새 v2 게시물을 맨 위에 merge (동일 postId·v1 legacy 제거) */
export function mergeMomentPostIntoFeed(feedDocs, newPost) {
  if (!newPost) return [...(feedDocs || [])];
  const keys = new Set(postKeysForDoc(newPost));
  const v2Keys = collectV2PostKeys([newPost]);
  const filtered = (feedDocs || []).filter((d) => {
    if (docMatchesPostKeys(d, keys)) return false;
    if (!isMomentPostV2(d) && d.entryId && newPost.entryId && d.entryId === newPost.entryId && d.userId === newPost.userId) {
      return false;
    }
    if (!isMomentPostV2(d) && v2Keys.size && [...v2Keys].some((k) => postKeysForDoc(d).includes(k))) {
      return false;
    }
    return true;
  });
  return [newPost, ...filtered].sort((a, b) => sharedPhotoTimestampMs(b) - sharedPhotoTimestampMs(a));
}

/** postId / entryId 기준으로 피드에서 제거 (v1 사진 문서 포함) */
export function removeMomentPostFromFeed(feedDocs, postIdOrEntryId, userId) {
  if (!postIdOrEntryId) return [...(feedDocs || [])];
  const keys = new Set([String(postIdOrEntryId)]);
  if (userId && !String(postIdOrEntryId).includes('_')) {
    keys.add(`${postIdOrEntryId}_${userId}`);
    keys.add(sanitizeMomentPostDocId(`${postIdOrEntryId}_${userId}`));
  }
  keys.add(sanitizeMomentPostDocId(postIdOrEntryId));
  return (feedDocs || []).filter((d) => !docMatchesPostKeys(d, keys));
}

export function resolveMealSharePostId(record, userId) {
  return mealSharePostId(record, userId);
}
