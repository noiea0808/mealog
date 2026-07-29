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

/**
 * 사용자 관리 목록(users.js)과 동일 기준: 루트 users/{uid} + config/settings
 * @returns {{ nick: string, email: string, loginMethod: string }} HTML 이스케이프된 표시 문자열
 */
async function fetchExcludedUidUserColumns(uid) {
    const dash = '—';
    try {
        const rootRef = doc(db, 'artifacts', appId, 'users', uid);
        const settingsRef = doc(db, 'artifacts', appId, 'users', uid, 'config', 'settings');
        const [rootSnap, settingsSnap] = await Promise.all([getDoc(rootRef), getDoc(settingsRef)]);

        let email = null;
        let providerId = null;
        let nickname = null;

        if (rootSnap.exists()) {
            const d = rootSnap.data();
            if (d.email != null && String(d.email).trim()) email = String(d.email).trim();
            if (d.providerId != null && String(d.providerId).trim()) providerId = String(d.providerId).trim();
        }
        if (settingsSnap.exists()) {
            const s = settingsSnap.data();
            const pn = s?.profile?.nickname;
            if (pn != null && String(pn).trim() && String(pn).trim() !== '게스트') nickname = String(pn).trim();
            if (s?.email != null && String(s.email).trim()) email = String(s.email).trim();
            if (s?.providerId != null && String(s.providerId).trim()) providerId = String(s.providerId).trim();
        }

        const nick = nickname ? escapeHtml(nickname) : dash;
        const emailStr = email ? escapeHtml(email) : dash;

        let loginMethod = '게스트';
        if (providerId === 'google.com') loginMethod = '구글';
        else if (providerId === 'kakao.com') loginMethod = '카카오';
        else if (email) loginMethod = '이메일';
        else if (typeof uid === 'string' && /^kakao_/i.test(uid)) loginMethod = '카카오';

        return { nick, email: emailStr, loginMethod: escapeHtml(loginMethod) };
    } catch {
        return { nick: dash, email: dash, loginMethod: dash };
    }
}

function setExcludedPanelLoading() {
    const tbody = document.getElementById('dashboardExcludedUidTableBody');
    if (tbody) {
        tbody.innerHTML =
            '<tr><td colspan="5" class="px-4 py-6 text-center text-slate-400 text-sm">불러오는 중…</td></tr>';
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
                '<tr><td colspan="5" class="px-4 py-6 text-center text-slate-500 text-sm">통계에서 제외한 UID가 없습니다.</td></tr>';
            return;
        }
        const rows = await Promise.all(
            uids.map(async (uid) => {
                const cols = await fetchExcludedUidUserColumns(uid);
                const safeUid = escapeHtml(uid);
                return `<tr class="border-b border-slate-100 hover:bg-slate-50/80">
                    <td class="px-3 py-2.5 font-mono text-xs text-slate-800 break-all align-top">${safeUid}</td>
                    <td class="px-3 py-2.5 text-sm text-slate-700 align-top">${cols.nick}</td>
                    <td class="px-3 py-2.5 text-sm text-slate-700 align-top break-all">${cols.email}</td>
                    <td class="px-3 py-2.5 text-sm text-slate-700 align-top whitespace-nowrap">${cols.loginMethod}</td>
                    <td class="px-3 py-2.5 text-right align-top whitespace-nowrap">
                        <button type="button" class="dashboard-excluded-remove inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 text-slate-700 hover:bg-red-50 hover:text-red-700 border border-slate-200 hover:border-red-200 transition-colors" data-uid="${safeUid}">
                            <i data-lucide="user-minus" aria-hidden="true"></i>제외 해제
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
        tbody.innerHTML = `<tr><td colspan="5" class="px-4 py-6 text-center text-red-600 text-sm">불러오지 못했습니다: ${escapeHtml(e?.message || String(e))}</td></tr>`;
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
