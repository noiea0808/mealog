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

/**
 * 피드 캐시의 likeCount/commentCount 패치 — 탭 재진입 시 시드값이 유지되도록
 * @param {object[]} feedDocs
 * @param {string} postId
 * @param {{ likeCount?: number, commentCount?: number, likeDelta?: number, commentDelta?: number }} patch
 */
export function patchMomentFeedSocialCounts(feedDocs, postId, patch = {}) {
  const pid = String(postId || '').trim();
  if (!pid || !patch) return [...(feedDocs || [])];
  const matchKeys = new Set([pid, sanitizeMomentPostDocId(pid)]);
  return (feedDocs || []).map((d) => {
    if (!docMatchesPostKeys(d, matchKeys)) return d;
    const next = { ...d };
    if (typeof patch.likeCount === 'number') {
      next.likeCount = Math.max(0, patch.likeCount);
    } else if (typeof patch.likeDelta === 'number') {
      next.likeCount = Math.max(0, (Number(d.likeCount) || 0) + patch.likeDelta);
    }
    if (typeof patch.commentCount === 'number') {
      next.commentCount = Math.max(0, patch.commentCount);
    } else if (typeof patch.commentDelta === 'number') {
      next.commentCount = Math.max(0, (Number(d.commentCount) || 0) + patch.commentDelta);
    }
    return next;
  });
}

/** DOM 카드의 data-seed-*-count 동기화 (재로드·재진입 시 시드 적용용) */
export function syncMomentPostSeedCounts(postId, { likeCount, commentCount } = {}) {
  const pid = String(postId || '').trim();
  if (!pid) return;
  document.querySelectorAll(`[data-post-id="${pid}"][data-moment-card-layout]`).forEach((el) => {
    if (typeof likeCount === 'number') {
      el.setAttribute('data-seed-like-count', String(Math.max(0, likeCount)));
    }
    if (typeof commentCount === 'number') {
      el.setAttribute('data-seed-comment-count', String(Math.max(0, commentCount)));
    }
  });
  document.querySelectorAll(`.instagram-post[data-post-id="${pid}"]`).forEach((el) => {
    if (typeof likeCount === 'number' && el.hasAttribute('data-seed-like-count')) {
      el.setAttribute('data-seed-like-count', String(Math.max(0, likeCount)));
    }
    if (typeof commentCount === 'number' && el.hasAttribute('data-seed-comment-count')) {
      el.setAttribute('data-seed-comment-count', String(Math.max(0, commentCount)));
    }
  });
}
