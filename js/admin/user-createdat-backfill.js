/**
 * 관리자 > 모니터링 > 가입일 백필 — users 루트 createdAt 을 Auth UID 생성 시각으로 채움 (서버 RunAll 또는 단일 UID)
 */
import { callableFunctions } from '../firebase.js';

function getEl(id) {
    return document.getElementById(id);
}

/**
 * 관리자 화면 버튼에서 호출
 */
export async function runAdminUserCreatedAtBackfill() {
    const dryRun = getEl('adminCreatedAtBackfillDryRun')?.checked === true;
    const overwrite = getEl('adminCreatedAtBackfillOverwrite')?.checked === true;
    const singleUid = (getEl('adminCreatedAtBackfillSingleUid')?.value || '').trim();
    const resultEl = getEl('adminCreatedAtBackfillResult');
    const btn = getEl('adminCreatedAtBackfillRunBtn');

    if (resultEl) {
        resultEl.textContent = '';
        resultEl.className = 'mt-4 text-sm rounded-xl p-4 border border-slate-100 bg-slate-50 text-slate-600';
    }
    if (btn) {
        btn.disabled = true;
        btn.classList.add('opacity-80', 'cursor-wait');
    }

    if (singleUid) {
        try {
            const res = await callableFunctions.adminBackfillUserRootCreatedAtForUid({
                targetUserId: singleUid,
                dryRun,
                overwrite
            });
            const data = res?.data ?? {};
            if (resultEl) {
                resultEl.className =
                    'mt-4 text-sm rounded-xl p-4 border border-slate-100 bg-slate-50 text-slate-800 whitespace-pre-wrap break-words font-mono text-xs';
                if (data.ok === false) {
                    resultEl.className =
                        'mt-4 text-sm rounded-xl p-4 border border-amber-200 bg-amber-50 text-amber-950 whitespace-pre-wrap break-words';
                    resultEl.textContent = JSON.stringify(data, null, 2);
                } else if (data.skipped) {
                    resultEl.className =
                        'mt-4 text-sm rounded-xl p-4 border border-slate-200 bg-white text-slate-800 whitespace-pre-wrap break-words';
                    resultEl.textContent = JSON.stringify(data, null, 2);
                } else {
                    resultEl.className =
                        'mt-4 text-sm rounded-xl p-4 border border-emerald-200 bg-emerald-50 text-emerald-900 whitespace-pre-wrap break-words';
                    resultEl.textContent = JSON.stringify(data, null, 2);
                }
            }
        } catch (e) {
            const msg =
                (e?.code && e?.message ? `${e.code}: ${e.message}` : null) ||
                e?.message ||
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
        return;
    }

    try {
        const res = await callableFunctions.adminBackfillUserRootCreatedAtFromAuthRunAll({
            dryRun,
            overwrite
        });
        const data = res?.data ?? {};
        const t = data.totals || {};
        const mode = dryRun ? 'DRY-RUN (쓰기 없음)' : overwrite ? '적용 (기존 가입일 덮어쓰기 포함)' : '적용 (가입일 없는 문서만)';

        if (resultEl) {
            resultEl.className =
                'mt-4 text-sm rounded-xl p-4 border border-emerald-200 bg-emerald-50 text-emerald-900 whitespace-pre-wrap break-words';
            resultEl.textContent = [
                `완료 — ${mode} (서버 전체 순회)`,
                `라운드(배치): ${data.rounds ?? '—'}`,
                data.truncated ? '⚠️ 라운드 상한에 도달했을 수 있음(truncated)' : '',
                `스캔 문서 수(합계): ${t.scanned ?? 0}`,
                `갱신(또는 dry-run 시도): ${t.updated ?? 0}`,
                `기존 createdAt 유지(스킵): ${t.skippedHasDate ?? 0}`,
                `Auth에 사용자 없음: ${t.skippedNoAuth ?? 0}`,
                `오류·경고: ${t.errors ?? 0}`
            ]
                .filter(Boolean)
                .join('\n');
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
