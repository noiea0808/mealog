/**
 * 라운지 게시판·공지 검색 필터 (board-notice ↔ board-search 순환 import 방지)
 */
import { appState } from './state.js';
import { getPlainTextPreview } from './render/utils.js';

const TRACE_LABELS = { like: '좋아요', comment: '댓글', bookmark: '북마크' };

export function timestampToYmd(ts) {
    if (!ts) return null;
    try {
        let d;
        if (ts.toDate && typeof ts.toDate === 'function') d = ts.toDate();
        else if (typeof ts === 'string' || ts instanceof Date) d = new Date(ts);
        else d = new Date(ts);
        if (Number.isNaN(d.getTime())) return null;
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    } catch (_) {
        return null;
    }
}

export function isYmdInRange(ymd, start, end) {
    if (!ymd || !start || !end) return true;
    return ymd >= start && ymd <= end;
}

export function boardPostMatchesKeyword(post, keyword) {
    if (!keyword) return true;
    const q = keyword.toLowerCase();
    const parts = [];
    const push = (v) => {
        if (v != null && String(v).trim()) parts.push(String(v));
    };
    push(post?.title);
    push(post?.content);
    push(post?.authorNickname);
    push(getPlainTextPreview(post?.content || ''));
    return parts.some((t) => t.toLowerCase().includes(q));
}

export function noticeMatchesKeyword(notice, keyword) {
    if (!keyword) return true;
    const q = keyword.toLowerCase();
    const parts = [];
    const push = (v) => {
        if (v != null && String(v).trim()) parts.push(String(v));
    };
    push(notice?.title);
    push(notice?.content);
    push(getPlainTextPreview(notice?.content || ''));
    return parts.some((t) => t.toLowerCase().includes(q));
}

export function formatBoardSearchSummary() {
    const parts = [];
    const range = appState.boardSearchDateRange;
    if (range?.start && range?.end) {
        parts.push(`${range.start.replace(/-/g, '.')} ~ ${range.end.replace(/-/g, '.')}`);
    }
    if (appState.boardTraceFilter) {
        parts.push(TRACE_LABELS[appState.boardTraceFilter] || appState.boardTraceFilter);
    }
    const kw = (appState.boardSearchKeyword || '').trim();
    if (kw) parts.push(`「${kw}」`);
    return parts.join(' · ');
}

export function getBoardSearchModalTitle() {
    return appState.boardListSubTab === 'notice' ? '공지 검색' : '게시판 검색';
}
