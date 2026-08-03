/**
 * 좋아요 누른 사람 목록 팝업 (하트 숫자 탭)
 */
import { postInteractions } from '../db.js';
import { fetchUserProfiles } from '../render/user-profiles.js';
import { escapeHtml } from '../render/index.js';
import { getDisplayProfile, getProfileAvatarDisplay } from '../utils.js';

function avatarHtml(profile) {
    const av = getProfileAvatarDisplay(profile || {});
    if (av.type === 'photo') {
        return `<span class="post-likes-row-avatar" aria-hidden="true"><img src="${escapeHtml(av.value)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`;
    }
    const emojiClass = av.type === 'emoji' ? ' post-likes-row-avatar--emoji' : '';
    return `<span class="post-likes-row-avatar${emojiClass}" aria-hidden="true">${escapeHtml(av.value)}</span>`;
}

export function initPostLikesModal() {
    document.getElementById('postLikesBackdrop')?.addEventListener('click', window.closePostLikesModal);
    document.getElementById('postLikesDismissBtn')?.addEventListener('click', window.closePostLikesModal);
}

window.closePostLikesModal = () => {
    document.getElementById('postLikesModal')?.classList.add('hidden');
};

/** 좋아요 카운트 탭 시 호출 — 누른 사람 아바타·닉네임 목록 표시 */
window.openPostLikesModal = async (postId) => {
    const pid = String(postId || '').trim();
    const modal = document.getElementById('postLikesModal');
    const listEl = document.getElementById('postLikesList');
    const emptyEl = document.getElementById('postLikesEmpty');
    if (!pid || !modal || !listEl || !emptyEl) return;
    modal.classList.remove('hidden');
    listEl.classList.remove('hidden');
    listEl.innerHTML = '<div class="post-likes-loading">불러오는 중…</div>';
    emptyEl.classList.add('hidden');
    try {
        const likes = await postInteractions.getLikes(pid);
        if (!likes.length) {
            listEl.innerHTML = '';
            listEl.classList.add('hidden');
            emptyEl.textContent = '아직 좋아요가 없습니다.';
            emptyEl.classList.remove('hidden');
            return;
        }
        const uids = [...new Set(likes.map((l) => String(l.userId || '').trim()).filter(Boolean))];
        await fetchUserProfiles(uids);
        listEl.innerHTML = likes
            .map((l) => {
                const uid = String(l.userId || '').trim();
                if (!uid) return '';
                const profile = getDisplayProfile(uid, {});
                const nickname = escapeHtml(String(profile?.nickname || '익명'));
                return `<div class="post-likes-row">${avatarHtml(profile)}<span class="post-likes-row-name">${nickname}</span></div>`;
            })
            .join('');
        emptyEl.classList.add('hidden');
    } catch (e) {
        console.error('좋아요 목록 로드 실패:', e);
        listEl.innerHTML = '';
        listEl.classList.add('hidden');
        emptyEl.textContent = '목록을 불러올 수 없습니다.';
        emptyEl.classList.remove('hidden');
    }
};
