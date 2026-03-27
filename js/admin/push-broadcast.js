// ADMIN 브로드캐스트 푸시 (즉시 발송 / 예약)
import { app, db, appId, functions } from '../firebase.js';
import { getAuth } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js';
import { collection, query, orderBy, getDocs, limit, doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { escapeHtml } from './utils.js';

const adminAuth = getAuth(app);

// ========== 푸시메시지 관리 (관리자 브로드캐스트) ==========
const adminBroadcastPushNowFn = httpsCallable(functions, 'adminBroadcastPushNow');
const scheduleAdminBroadcastPushFn = httpsCallable(functions, 'scheduleAdminBroadcastPush');
const ADMIN_PUSH_LANDING_LABELS = {
    dashboard: '밀당',
    timeline: '밀로그',
    gallery: '모먼트',
    board: '밀톡',
    settings: '설정'
};
const ADMIN_SCHEDULED_PUSH_STATUS_LABELS = {
    pending: '예약됨',
    sending: '발송 중',
    sent: '발송 완료',
    completed: '주기 완료',
    failed: '실패',
    cancelled: '취소됨'
};

const ADMIN_RECURRING_INTERVAL_LABELS = {
    daily: '매일',
    weekly: '매주',
    monthly: '매월'
};

function formatAdminPushDate(ts) {
    if (!ts) return '—';
    try {
        const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
        if (Number.isNaN(d.getTime())) return '—';
        return d.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
    } catch {
        return '—';
    }
}

function datetimeLocalMinAhead(minutesAhead = 1) {
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date(Date.now() + minutesAhead * 60 * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function setAdminPushScheduleMinDatetime() {
    const minVal = datetimeLocalMinAhead(1);
    ['adminPushScheduleWhen', 'adminPushRecurringStart'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.min = minVal;
    });
}

/**
 * 예약 발송 하위: 특정 일시 1회 vs 주기적
 * @param {'once'|'recurring'} kind
 */
window.setAdminPushScheduleKind = function(kind) {
    const onceTab = document.getElementById('adminPushScheduleKindOnce');
    const recTab = document.getElementById('adminPushScheduleKindRecurring');
    const onceBlock = document.getElementById('adminPushScheduleOnceBlock');
    const recBlock = document.getElementById('adminPushScheduleRecurringBlock');
    const isOnce = kind !== 'recurring';

    if (onceTab) {
        onceTab.classList.toggle('bg-white', isOnce);
        onceTab.classList.toggle('text-amber-800', isOnce);
        onceTab.classList.toggle('shadow-sm', isOnce);
        onceTab.classList.toggle('ring-1', isOnce);
        onceTab.classList.toggle('ring-amber-200/70', isOnce);
        onceTab.classList.toggle('text-slate-500', !isOnce);
        onceTab.classList.toggle('hover:text-slate-700', !isOnce);
        onceTab.classList.toggle('hover:bg-white/60', !isOnce);
        onceTab.setAttribute('aria-selected', isOnce ? 'true' : 'false');
    }
    if (recTab) {
        const recOn = !isOnce;
        recTab.classList.toggle('bg-white', recOn);
        recTab.classList.toggle('text-amber-800', recOn);
        recTab.classList.toggle('shadow-sm', recOn);
        recTab.classList.toggle('ring-1', recOn);
        recTab.classList.toggle('ring-amber-200/70', recOn);
        recTab.classList.toggle('text-slate-500', !recOn);
        recTab.classList.toggle('hover:text-slate-700', !recOn);
        recTab.classList.toggle('hover:bg-white/60', !recOn);
        recTab.setAttribute('aria-selected', recOn ? 'true' : 'false');
    }
    if (onceBlock) onceBlock.classList.toggle('hidden', !isOnce);
    if (recBlock) recBlock.classList.toggle('hidden', isOnce);

    setAdminPushScheduleMinDatetime();
};

/**
 * 푸시메시지 관리: 즉시 / 예약 옵션 전환
 * @param {'now'|'schedule'} mode
 */
window.setAdminPushSendMode = function(mode) {
    const nowTab = document.getElementById('adminPushModeTabNow');
    const schTab = document.getElementById('adminPushModeTabSchedule');
    const nowPanel = document.getElementById('adminPushPanelNow');
    const schPanel = document.getElementById('adminPushPanelSchedule');
    const isNow = mode !== 'schedule';

    if (nowTab) {
        nowTab.classList.toggle('bg-white', isNow);
        nowTab.classList.toggle('text-violet-700', isNow);
        nowTab.classList.toggle('shadow-sm', isNow);
        nowTab.classList.toggle('ring-1', isNow);
        nowTab.classList.toggle('ring-violet-200/70', isNow);
        nowTab.classList.toggle('text-slate-500', !isNow);
        nowTab.classList.toggle('hover:text-slate-700', !isNow);
        nowTab.classList.toggle('hover:bg-white/60', !isNow);
        nowTab.setAttribute('aria-selected', isNow ? 'true' : 'false');
    }
    if (schTab) {
        const schOn = !isNow;
        schTab.classList.toggle('bg-white', schOn);
        schTab.classList.toggle('text-amber-800', schOn);
        schTab.classList.toggle('shadow-sm', schOn);
        schTab.classList.toggle('ring-1', schOn);
        schTab.classList.toggle('ring-amber-200/70', schOn);
        schTab.classList.toggle('text-slate-500', !schOn);
        schTab.classList.toggle('hover:text-slate-700', !schOn);
        schTab.classList.toggle('hover:bg-white/60', !schOn);
        schTab.setAttribute('aria-selected', schOn ? 'true' : 'false');
    }
    if (nowPanel) nowPanel.classList.toggle('hidden', !isNow);
    if (schPanel) schPanel.classList.toggle('hidden', isNow);

    if (!isNow) {
        setAdminPushScheduleMinDatetime();
        window.setAdminPushScheduleKind('once');
    }
};

export async function loadAdminPushMessagesPage() {
    window.setAdminPushSendMode('now');
    window.setAdminPushScheduleKind('once');
    setAdminPushScheduleMinDatetime();
    await refreshAdminScheduledPushes();
}

window.refreshAdminScheduledPushes = async function() {
    const container = document.getElementById('adminScheduledPushesContainer');
    if (!container) return;
    container.innerHTML = '<p class="text-center py-8 text-slate-400 text-sm"><i class="fa-solid fa-spinner fa-spin mr-2"></i>불러오는 중…</p>';
    try {
        const coll = collection(db, 'artifacts', appId, 'adminScheduledPushes');
        const qy = query(coll, orderBy('scheduledAt', 'desc'), limit(40));
        const snap = await getDocs(qy);
        if (snap.empty) {
            container.innerHTML = '<p class="text-center py-8 text-slate-400 text-sm">등록된 예약이 없습니다.</p>';
            return;
        }
        const rows = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
        container.innerHTML = `<div class="divide-y divide-slate-200 bg-white">${rows.map((r) => {
            const st = r.status || 'pending';
            const stLabel = ADMIN_SCHEDULED_PUSH_STATUS_LABELS[st] || st;
            const land = ADMIN_PUSH_LANDING_LABELS[r.landingTab] || r.landingTab || '—';
            const canCancel = st === 'pending';
            const title = escapeHtml((r.title || '').slice(0, 80));
            const bodyPreview = escapeHtml((r.body || '').slice(0, 120));
            const err = r.errorMessage ? `<p class="text-xs text-red-500 mt-1">${escapeHtml(String(r.errorMessage).slice(0, 200))}</p>` : '';
            const isRecurring = r.scheduleType === 'recurring';
            const intv = r.recurringInterval || 'daily';
            const intvLabel = ADMIN_RECURRING_INTERVAL_LABELS[intv] || intv;
            const recurMeta = isRecurring
                ? `<span class="text-xs text-slate-500">주기: ${escapeHtml(intvLabel)} · 종료: ${formatAdminPushDate(r.recurringEndAt)}</span>`
                : '';
            const whenLabel = isRecurring && st === 'pending'
                ? `다음 발송: ${formatAdminPushDate(r.scheduledAt)}`
                : `예약: ${formatAdminPushDate(r.scheduledAt)}`;
            return `
            <div class="px-4 py-3 hover:bg-slate-50/80 transition-colors">
                <div class="flex flex-wrap items-start justify-between gap-2">
                    <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-2 mb-1">
                            <span class="text-xs font-bold px-2 py-0.5 rounded-lg ${st === 'sent' || st === 'completed' ? 'bg-emerald-100 text-emerald-800' : st === 'pending' ? 'bg-amber-100 text-amber-800' : st === 'failed' ? 'bg-red-100 text-red-800' : st === 'cancelled' ? 'bg-slate-200 text-slate-600' : 'bg-slate-100 text-slate-700'}">${escapeHtml(stLabel)}</span>
                            ${isRecurring ? '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-violet-100 text-violet-800">주기</span>' : '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">1회</span>'}
                            <span class="text-xs text-slate-500">${whenLabel}</span>
                            <span class="text-xs text-violet-600 font-bold">→ ${escapeHtml(land)}</span>
                        </div>
                        ${recurMeta ? `<div class="mb-1">${recurMeta}</div>` : ''}
                        <p class="text-sm font-bold text-slate-800 truncate">${title || '(제목 없음)'}</p>
                        <p class="text-xs text-slate-600 line-clamp-2 mt-0.5">${bodyPreview}</p>
                        ${st === 'sent' || st === 'completed' ? `<p class="text-[11px] text-slate-400 mt-1">마지막 발송: ${formatAdminPushDate(r.sentAt || r.lastSentAt)}</p>` : ''}
                        ${err}
                    </div>
                    ${canCancel ? `<button type="button" onclick="window.cancelAdminScheduledPush(${JSON.stringify(r.id)})" class="shrink-0 px-3 py-1.5 text-xs font-bold text-red-600 bg-red-50 hover:bg-red-100 rounded-lg border border-red-100 transition-colors">예약 취소</button>` : ''}
                </div>
            </div>`;
        }).join('')}</div>`;
    } catch (e) {
        console.error('예약 푸시 목록 실패:', e);
        container.innerHTML = `<p class="text-center py-8 text-red-400 text-sm px-4">목록을 불러오지 못했습니다. ${escapeHtml(e.message || '')}</p>`;
    }
};

window.cancelAdminScheduledPush = async function(jobId) {
    if (!jobId || !confirm('이 예약을 취소할까요?')) return;
    try {
        const ref = doc(db, 'artifacts', appId, 'adminScheduledPushes', jobId);
        await setDoc(ref, { status: 'cancelled', cancelledAt: serverTimestamp() }, { merge: true });
        await refreshAdminScheduledPushes();
    } catch (e) {
        console.error(e);
        alert('취소 실패: ' + (e.message || e));
    }
};

window.submitAdminPushNow = async function() {
    const titleEl = document.getElementById('adminPushNowTitle');
    const bodyEl = document.getElementById('adminPushNowBody');
    const landEl = document.getElementById('adminPushNowLanding');
    const btn = document.getElementById('adminPushNowBtn');
    const title = (titleEl?.value || '').trim();
    const body = (bodyEl?.value || '').trim();
    const landingTab = landEl?.value || 'dashboard';
    if (!title) {
        alert('제목을 입력해 주세요.');
        return;
    }
    if (!body) {
        alert('내용을 입력해 주세요.');
        return;
    }
    if (!confirm('알림을 허용한 전체 로그인 사용자에게 지금 발송합니다. 계속할까요?')) return;
    if (btn) {
        btn.disabled = true;
        btn.textContent = '발송 중…';
    }
    try {
        await adminBroadcastPushNowFn({ title, body, landingTab });
        alert('발송 요청이 처리되었습니다.');
        if (titleEl) titleEl.value = '';
        if (bodyEl) bodyEl.value = '';
    } catch (e) {
        console.error(e);
        const msg = e?.message || e?.details || String(e);
        alert('발송 실패: ' + msg);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '지금 전체 발송';
        }
    }
};

window.submitAdminPushSchedule = async function() {
    const recTab = document.getElementById('adminPushScheduleKindRecurring');
    const isRecurring = recTab && recTab.getAttribute('aria-selected') === 'true';
    const whenEl = document.getElementById('adminPushScheduleWhen');
    const startEl = document.getElementById('adminPushRecurringStart');
    const endEl = document.getElementById('adminPushRecurringEnd');
    const intervalEl = document.getElementById('adminPushRecurringInterval');
    const titleEl = document.getElementById('adminPushScheduleTitle');
    const bodyEl = document.getElementById('adminPushScheduleBody');
    const landEl = document.getElementById('adminPushScheduleLanding');
    const btn = document.getElementById('adminPushScheduleBtn');
    const title = (titleEl?.value || '').trim();
    const body = (bodyEl?.value || '').trim();
    const landingTab = landEl?.value || 'dashboard';
    if (!title || !body) {
        alert('제목과 내용을 모두 입력해 주세요.');
        return;
    }
    const minAhead = Date.now() + 50 * 1000;
    let payload;

    if (isRecurring) {
        const sv = startEl?.value;
        const ev = endEl?.value;
        if (!sv || !ev) {
            alert('주기 발송의 시작·종료 일시를 모두 선택해 주세요.');
            return;
        }
        const startMs = new Date(sv).getTime();
        const endMs = new Date(ev).getTime();
        if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
            alert('시작·종료 일시가 올바르지 않습니다.');
            return;
        }
        if (endMs < startMs) {
            alert('종료 일시는 시작 일시보다 이후여야 합니다.');
            return;
        }
        if (startMs < minAhead) {
            alert('시작 시각은 현재보다 최소 약 1분 이후로 설정해 주세요.');
            return;
        }
        const recurringInterval = intervalEl?.value || 'daily';
        if (!['daily', 'weekly', 'monthly'].includes(recurringInterval)) {
            alert('주기 값이 올바르지 않습니다.');
            return;
        }
        payload = {
            scheduleType: 'recurring',
            title: title.slice(0, 80),
            body: body.slice(0, 240),
            landingTab,
            recurringStartMs: startMs,
            recurringEndMs: endMs,
            recurringInterval
        };
    } else {
        const whenVal = whenEl?.value;
        if (!whenVal) {
            alert('발송 일시를 선택해 주세요.');
            return;
        }
        const at = new Date(whenVal);
        if (Number.isNaN(at.getTime())) {
            alert('발송 일시가 올바르지 않습니다.');
            return;
        }
        if (at.getTime() < minAhead) {
            alert('예약 시각은 현재보다 최소 약 1분 이후로 설정해 주세요.');
            return;
        }
        payload = {
            scheduleType: 'once',
            title: title.slice(0, 80),
            body: body.slice(0, 240),
            landingTab,
            scheduledAtMs: at.getTime()
        };
    }

    const uid = adminAuth.currentUser?.uid;
    if (!uid) {
        alert('로그인이 필요합니다.');
        return;
    }
    if (btn) {
        btn.disabled = true;
        btn.textContent = '등록 중…';
    }
    try {
        await scheduleAdminBroadcastPushFn(payload);
        alert('예약이 등록되었습니다.');
        if (titleEl) titleEl.value = '';
        if (bodyEl) bodyEl.value = '';
        if (whenEl) whenEl.value = '';
        if (startEl) startEl.value = '';
        if (endEl) endEl.value = '';
        setAdminPushScheduleMinDatetime();
        await refreshAdminScheduledPushes();
    } catch (e) {
        console.error(e);
        alert('예약 등록 실패: ' + (e.message || e));
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '예약 등록';
        }
    }
};
