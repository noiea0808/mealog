/**
 * 기록 시트 — 3층 필드 자동 승격/강등 (docs/entry-sheet-redesign.md §2 3층)
 *
 * 최근 10회 저장 중 5회 이상 쓴 필드(만족도·포만감·메모)는 그 사용자에게
 * 기본 탭에서 처음부터 보인다. 안 쓰면 상세 탭에 접힌 채 그대로다.
 * 시트가 사용자에게 적응한다 — 사용자가 시트에 적응하지 않는다.
 *
 * 구현: 저장 성공 시 사용 여부를 링버퍼(최근 10회)로 기록하고,
 * 시트 열 때 승격된 섹션 DOM을 기본 탭의 승격 컨테이너로 옮긴다.
 * 원위치 복원을 위해 플레이스홀더를 남긴다. 끼니(meal) 모드 전용.
 */
import { appState } from '../state.js';
import { scheduleEntrySettingsSave } from './entry-save-subtags.js';

const HISTORY_LIMIT = 10;
const PROMOTE_THRESHOLD = 5;
const PROMOTED_CONTAINER_ID = 'entryPromotedFields';

/** 승격 대상: 섹션 id와 사용 판정 필드 */
const PROMOTABLE = [
    { key: 'review', sectionId: 'reviewSection' },
    { key: 'comment', sectionId: 'entryCommentDetailFooter' },
];

function getUsage() {
    if (!window.userSettings) return {};
    if (!window.userSettings.entryFieldUsage || typeof window.userSettings.entryFieldUsage !== 'object') {
        window.userSettings.entryFieldUsage = {};
    }
    return window.userSettings.entryFieldUsage;
}

/** @param {number[]} arr @returns {number} */
function usedCount(arr) {
    return Array.isArray(arr) ? arr.reduce((n, v) => n + (v ? 1 : 0), 0) : 0;
}

/**
 * 저장 성공 후 호출 — 이번 기록의 필드 사용 여부를 링버퍼에 기록.
 * 끼니 기록만 집계한다 (간식·건너뜀은 3층 필드 의미가 달라 표본 오염).
 * @param {object} record buildEntrySaveRecord 결과 record
 * @param {'meal'|'snack'} entryMode
 * @param {boolean} isSkip
 */
export function recordEntryFieldUsage(record, entryMode, isSkip) {
    try {
        if (entryMode !== 'meal' || isSkip || !window.userSettings) return;
        const usage = getUsage();
        const push = (key, used) => {
            const arr = Array.isArray(usage[key]) ? usage[key] : [];
            arr.push(used ? 1 : 0);
            usage[key] = arr.slice(-HISTORY_LIMIT);
        };
        push('rating', record.rating != null);
        push('satiety', record.satiety != null);
        push('comment', Boolean((record.comment || '').trim()));
        scheduleEntrySettingsSave();
    } catch (_) {
        /* 집계 실패는 저장과 무관 — 무시 */
    }
}

function isPromoted(key) {
    const usage = getUsage();
    if (key === 'review') {
        return (
            usedCount(usage.rating) >= PROMOTE_THRESHOLD ||
            usedCount(usage.satiety) >= PROMOTE_THRESHOLD
        );
    }
    if (key === 'comment') return usedCount(usage.comment) >= PROMOTE_THRESHOLD;
    return false;
}

function ensurePlaceholder(section) {
    if (section._promotionPlaceholder?.isConnected) return section._promotionPlaceholder;
    const ph = document.createElement('div');
    ph.className = 'hidden';
    ph.setAttribute('data-promotion-placeholder', section.id);
    section.parentNode?.insertBefore(ph, section);
    section._promotionPlaceholder = ph;
    return ph;
}

function moveToPromoted(section) {
    const container = document.getElementById(PROMOTED_CONTAINER_ID);
    if (!container || container.contains(section)) return;
    ensurePlaceholder(section);
    container.appendChild(section);
    container.classList.remove('hidden');
}

function restoreToOrigin(section) {
    const ph = section._promotionPlaceholder;
    if (!ph?.isConnected || ph.nextSibling === section) return;
    ph.parentNode.insertBefore(section, ph.nextSibling);
}

/**
 * 시트 열 때(모드 확정 후) 호출 — 승격 상태를 DOM에 반영.
 * 간식 모드·건너뜀에서는 전부 원위치로 되돌린다.
 */
export function applyEntryFieldPromotion() {
    try {
        const container = document.getElementById(PROMOTED_CONTAINER_ID);
        if (!container) return;
        const isMeal = appState.entryFormMode !== 'snack';
        let anyPromoted = false;
        for (const { key, sectionId } of PROMOTABLE) {
            const section = document.getElementById(sectionId);
            if (!section) continue;
            if (isMeal && isPromoted(key)) {
                moveToPromoted(section);
                anyPromoted = true;
            } else {
                restoreToOrigin(section);
            }
        }
        container.classList.toggle('hidden', !anyPromoted);
    } catch (_) {
        /* 승격 실패 = 기본 배치 유지. 시트 열기에 영향 금지 */
    }
}
