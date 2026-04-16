/**
 * 대시보드 서브탭「통계 제외 UID」— 목록 조회·추가·삭제
 */
import { db, appId } from '../firebase.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import {
    getExcludedAnalyticsUidList,
    saveExcludedAnalyticsUidList
} from '../excluded-analytics-uids.js';
import { escapeHtml } from './utils.js';

async function syncPageUsageExcludedFooter() {
    const el = document.getElementById('dashboardPageUsageExcludedUidList');
    if (el) {
        const list = await getExcludedAnalyticsUidList();
        el.textContent = list.join(', ');
    }
}

async function fetchNickname(uid) {
    try {
        const s = await getDoc(doc(db, 'artifacts', appId, 'users', uid, 'config', 'settings'));
        if (!s.exists()) return '—';
        const n = s.data()?.profile?.nickname;
        return n && String(n).trim() ? escapeHtml(String(n).trim()) : '—';
    } catch {
        return '—';
    }
}

function setExcludedPanelLoading() {
    const tbody = document.getElementById('dashboardExcludedUidTableBody');
    if (tbody) {
        tbody.innerHTML =
            '<tr><td colspan="3" class="px-4 py-6 text-center text-slate-400 text-sm">불러오는 중…</td></tr>';
    }
}

export async function loadExcludedAnalyticsAdminPanel() {
    const tbody = document.getElementById('dashboardExcludedUidTableBody');
    if (!tbody) return;
    setExcludedPanelLoading();
    try {
        const uids = await getExcludedAnalyticsUidList();
        if (uids.length === 0) {
            tbody.innerHTML =
                '<tr><td colspan="3" class="px-4 py-6 text-center text-slate-500 text-sm">통계에서 제외한 UID가 없습니다.</td></tr>';
            return;
        }
        const rows = await Promise.all(
            uids.map(async (uid) => {
                const nick = await fetchNickname(uid);
                const safeUid = escapeHtml(uid);
                return `<tr class="border-b border-slate-100 hover:bg-slate-50/80">
                    <td class="px-3 py-2.5 font-mono text-xs text-slate-800 break-all align-top">${safeUid}</td>
                    <td class="px-3 py-2.5 text-sm text-slate-700 align-top">${nick}</td>
                    <td class="px-3 py-2.5 text-right align-top whitespace-nowrap">
                        <button type="button" class="dashboard-excluded-remove inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 text-slate-700 hover:bg-red-50 hover:text-red-700 border border-slate-200 hover:border-red-200 transition-colors" data-uid="${safeUid}">
                            <i class="fa-solid fa-user-minus" aria-hidden="true"></i>제외 해제
                        </button>
                    </td>
                </tr>`;
            })
        );
        tbody.innerHTML = rows.join('');
        tbody.querySelectorAll('.dashboard-excluded-remove').forEach((btn) => {
            btn.addEventListener('click', () => {
                const raw = btn.getAttribute('data-uid');
                if (raw) void removeExcludedUid(raw);
            });
        });
    } catch (e) {
        console.error('통계 제외 UID 목록 로드 실패:', e);
        tbody.innerHTML = `<tr><td colspan="3" class="px-4 py-6 text-center text-red-600 text-sm">불러오지 못했습니다: ${escapeHtml(e?.message || String(e))}</td></tr>`;
    }
}

async function removeExcludedUid(uid) {
    try {
        const list = await getExcludedAnalyticsUidList();
        const next = list.filter((x) => x !== uid);
        await saveExcludedAnalyticsUidList(next);
        await loadExcludedAnalyticsAdminPanel();
        await syncPageUsageExcludedFooter();
    } catch (e) {
        console.error('제외 UID 삭제 실패:', e);
        alert('저장에 실패했습니다: ' + (e?.message || e));
    }
}

export async function addExcludedUidFromAdminInput() {
    const input = document.getElementById('dashboardExcludedUidInput');
    const raw = input?.value?.trim();
    if (!raw) {
        alert('UID를 입력해 주세요.');
        return;
    }
    try {
        const list = await getExcludedAnalyticsUidList();
        if (list.includes(raw)) {
            alert('이미 제외 목록에 있습니다.');
            return;
        }
        await saveExcludedAnalyticsUidList([...list, raw]);
        if (input) input.value = '';
        await loadExcludedAnalyticsAdminPanel();
        await syncPageUsageExcludedFooter();
    } catch (e) {
        console.error('제외 UID 추가 실패:', e);
        alert('저장에 실패했습니다: ' + (e?.message || e));
    }
}
