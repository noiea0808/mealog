/**
 * 관리자 > 모니터링 > 통계 백필 — 특정 사용자 UID의 meals 기준 daily stats 재집계
 */
import { callableFunctions } from '../firebase.js';

/**
 * Cloud Function adminBackfillUserStats 호출
 */
export async function runAdminStatsBackfillForUid() {
    const input = document.getElementById('adminStatsBackfillUidInput');
    const resultEl = document.getElementById('adminStatsBackfillResult');
    const btn = document.getElementById('adminStatsBackfillRunBtn');
    const uid = (input?.value || '').trim();
    if (!uid) {
        alert('Firebase UID를 입력해주세요.');
        return;
    }
    if (resultEl) {
        resultEl.textContent = '';
        resultEl.className = 'mt-4 text-sm rounded-xl p-4 border border-slate-100 bg-slate-50 text-slate-600';
    }
    if (btn) {
        btn.disabled = true;
        btn.classList.add('opacity-80', 'cursor-wait');
    }
    try {
        const res = await callableFunctions.adminBackfillUserStats({ targetUserId: uid });
        const data = res?.data ?? {};
        const mealCount = data.mealCount ?? 0;
        const dayCount = data.dayCount ?? 0;
        const years = Array.isArray(data.years) ? data.years.join(', ') : String(data.years || '-');
        if (resultEl) {
            resultEl.className =
                'mt-4 text-sm rounded-xl p-4 border border-emerald-200 bg-emerald-50 text-emerald-900 whitespace-pre-wrap break-words';
            resultEl.textContent = `완료\n식사 문서: ${mealCount}건\n집계 일수: ${dayCount}일\n연도 문서: ${years}`;
        }
    } catch (e) {
        const msg =
            (e?.code && e?.message ? `${e.code}: ${e.message}` : null) ||
            e?.message ||
            e?.details ||
            String(e);
        if (resultEl) {
            resultEl.className =
                'mt-4 text-sm rounded-xl p-4 border border-red-200 bg-red-50 text-red-800 whitespace-pre-wrap break-words';
            resultEl.textContent = `실패: ${msg}`;
        } else {
            alert(`실패: ${msg}`);
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('opacity-80', 'cursor-wait');
        }
    }
}
