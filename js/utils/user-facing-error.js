/**
 * Firestore/Callable/네트워크 오류를 사용자용 짧은 문구로 변환 (긴 gRPC·스택 문자열 노출 방지)
 * @param {unknown} err
 * @param {'save' | 'delete' | 'settings' | 'share' | 'comment' | 'generic'} context
 * @returns {string}
 */
export function getUserFacingErrorMessage(err, context = 'generic') {
    const code = err?.code != null ? String(err.code) : '';
    const raw = err?.message != null ? String(err.message) : '';
    const low = `${code} ${raw}`.toLowerCase();

    const networkish =
        code === 'unavailable' ||
        code === 'deadline-exceeded' ||
        code === 'cancelled' ||
        code === 'resource-exhausted' ||
        code === 'auth/network-request-failed' ||
        /network|failed to fetch|fetch failed|load failed|offline|timeout|quic|unreachable|connection refused|econn|ecconn|socket|reset|errno|aborted/i.test(
            low
        );

    if (networkish) {
        if (context === 'save') return '연결이 불안정해요. 잠시 후 다시 저장해 주세요.';
        if (context === 'delete') return '연결이 불안정해요. 잠시 후 다시 시도해 주세요.';
        if (context === 'settings') return '연결이 불안정해요. 잠시 후 다시 시도해 주세요.';
        if (context === 'share') return '연결이 불안정해요. 잠시 후 다시 시도해 주세요.';
        if (context === 'comment') return '연결이 불안정해요. 잠시 후 다시 시도해 주세요.';
        return '연결이 불안정해요. 잠시 후 다시 시도해 주세요.';
    }

    if (code === 'permission-denied' || /permission-denied/.test(low)) {
        if (context === 'delete') {
            return '삭제할 수 없어요. 잠시 후 다시 시도하거나 다시 로그인해 주세요.';
        }
        return '저장할 수 없어요. 잠시 후 다시 시도하거나 다시 로그인해 주세요.';
    }

    if (raw.includes('Quota exceeded')) {
        return '잠시 후 다시 시도해 주세요.';
    }

    if (/functions\/internal|^internal$|unavailable/i.test(code) || /internal error|try again/i.test(low)) {
        return '잠시 후 다시 시도해 주세요.';
    }

    if (context === 'save') return '저장하지 못했어요. 잠시 후 다시 시도해 주세요.';
    if (context === 'delete') return '삭제하지 못했어요. 잠시 후 다시 시도해 주세요.';
    if (context === 'settings') return '설정을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.';
    if (context === 'share') return '처리하지 못했어요. 잠시 후 다시 시도해 주세요.';
    if (context === 'comment') return '댓글을 달지 못했어요. 잠시 후 다시 시도해 주세요.';
    return '문제가 발생했어요. 잠시 후 다시 시도해 주세요.';
}
