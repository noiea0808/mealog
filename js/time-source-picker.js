/**
 * 현재 시각 / 사진 시각 / 직접 입력 — 공통 선택 시트
 */
import { showToast } from './ui.js';
import { scheduleLucideIcons } from './icons.js';
import { bindDialogGrabberPullClose } from './utils/dialog-grabber.js';

const SHEET_ID = 'timeSourcePickerSheet';
const MANUAL_SHEET_ID = 'timeSourceManualSheet';

let escapeHandler = null;

export function dateToDatetimeLocalValue(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function dateToTimeInputValue(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function datetimeLocalValueToDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function timeInputValueToDate(value, baseDate = new Date()) {
    if (!value || !/^\d{2}:\d{2}$/.test(value)) return null;
    const [h, m] = value.split(':').map((v) => parseInt(v, 10));
    const d = new Date(baseDate);
    d.setHours(h, m, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function closeTimeSourceSheets() {
    document.getElementById(SHEET_ID)?.remove();
    document.getElementById(MANUAL_SHEET_ID)?.remove();
    document.getElementById('mealClockWheelPickerSheet')?.remove();
    if (escapeHandler) {
        document.removeEventListener('keydown', escapeHandler);
        escapeHandler = null;
    }
}

function bindSheetDismiss(root, onDismiss) {
    root.querySelectorAll('[data-time-source-dismiss]').forEach((el) => {
        el.addEventListener('click', () => onDismiss());
    });
}

function attachEscapeHandler(onDismiss) {
    if (escapeHandler) document.removeEventListener('keydown', escapeHandler);
    escapeHandler = (e) => {
        if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', escapeHandler);
}

/**
 * @param {{
 *   mode?: 'time' | 'datetime',
 *   initialDate?: Date,
 *   zIndex?: number,
 *   title?: string,
 *   label?: string,
 *   onApply: (date: Date) => void,
 *   onInvalid?: () => void,
 * }} options
 */
export function openTimeManualPanel(options = {}) {
    const {
        mode = 'datetime',
        initialDate = new Date(),
        zIndex = 420,
        title = '시각 직접 입력',
        label = mode === 'time' ? '시간' : '날짜와 시간',
        onApply,
        onInvalid
    } = options;

    closeTimeSourceSheets();

    const root = document.createElement('div');
    root.id = MANUAL_SHEET_ID;
    root.className = 'fixed inset-0 flex items-center justify-center p-4 pointer-events-none';
    root.style.zIndex = String(zIndex);
    root.setAttribute('role', 'presentation');

    const inputType = mode === 'time' ? 'time' : 'datetime-local';
    const inputValue = mode === 'time'
        ? dateToTimeInputValue(initialDate)
        : dateToDatetimeLocalValue(initialDate);
    const inputId = `timeSourceManualInput_${Date.now()}`;

    const rowBase =
        'flex w-full items-center justify-center border-0 bg-transparent px-4 py-3 text-center text-base outline-none active:bg-slate-100';

    root.innerHTML = `
        <div class="absolute inset-0 mealog-action-dim pointer-events-auto" data-time-source-dismiss></div>
        <div class="relative z-[1] w-full max-w-sm pointer-events-auto overflow-hidden rounded-2xl bg-white shadow-xl">
            <div class="px-4 pt-4 pb-2 border-b border-slate-100">
                <h3 class="text-base font-bold text-slate-800 text-center">${title}</h3>
            </div>
            <div class="px-4 py-4">
                <label for="${inputId}" class="block text-sm font-semibold text-slate-600 mb-2">${label}</label>
                <input type="${inputType}" id="${inputId}" step="60" class="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-base text-slate-800" value="${inputValue}">
            </div>
            <div class="grid grid-cols-2 border-t border-slate-200">
                <button type="button" data-time-source-dismiss class="${rowBase} text-slate-700 border-r border-slate-200 font-semibold">취소</button>
                <button type="button" data-time-source-manual-apply class="${rowBase} text-emerald-700 font-bold">적용</button>
            </div>
        </div>`;

    document.body.appendChild(root);
    attachEscapeHandler(() => closeTimeSourceSheets());
    bindSheetDismiss(root, () => closeTimeSourceSheets());

    root.querySelector('[data-time-source-manual-apply]')?.addEventListener('click', () => {
        const input = root.querySelector(`#${inputId}`);
        const date = mode === 'time'
            ? timeInputValueToDate(input?.value, initialDate)
            : datetimeLocalValueToDate(input?.value);
        if (!date) {
            if (onInvalid) onInvalid();
            else showToast('올바른 시간을 입력해주세요.', 'error');
            return;
        }
        closeTimeSourceSheets();
        onApply(date);
    });
}

/**
 * @param {{
 *   title?: string,
 *   zIndex?: number,
 *   showRemove?: boolean,
 *   onNow: () => void,
 *   onPhoto: () => void | Promise<void>,
 *   onManual: () => void,
 *   onEmpty?: () => void,
 *   onRemove?: () => void,
 * }} options
 */
export function openTimeSourceSheet(options = {}) {
    const {
        title = '시간 선택',
        zIndex = 420,
        showRemove = false,
        showEmpty = false,
        onNow,
        onPhoto,
        onManual,
        onEmpty,
        onRemove
    } = options;

    closeTimeSourceSheets();

    const root = document.createElement('div');
    root.id = SHEET_ID;
    root.className = 'fixed inset-0 flex items-center justify-center p-4 pointer-events-none';
    root.style.zIndex = String(zIndex);
    root.setAttribute('role', 'presentation');

    const rowBase =
        'flex w-full items-center justify-center gap-2 border-0 bg-transparent px-4 py-[calc(0.75rem*1.2)] text-center text-base outline-none active:bg-slate-100';

    const emptyRow = showEmpty
        ? `<button type="button" data-time-source-option="empty" class="${rowBase} text-slate-900">
                <i data-lucide="circle-x" class="shrink-0 text-sm text-slate-500" aria-hidden="true"></i>미입력
           </button>`
        : '';

    const removeRow = showRemove
        ? `<button type="button" data-time-source-option="remove" class="${rowBase} text-red-700 active:bg-red-50">
                <i data-lucide="eye-off" class="shrink-0 text-sm" aria-hidden="true"></i>표시 제거
           </button>`
        : '';

    /*
     * 제목도 닫기 버튼도 없다.
     *
     * 목록에 '현재 시각·사진 시각·직접 입력'만 서 있으면 이게 시각을 고르는
     * 자리라는 것은 이미 읽힌다 — '시간 선택'이라는 제목은 같은 말을 한 번 더
     * 한다. 닫기도 마찬가지다. 바깥을 눌러도, ESC 를 눌러도, 항목 하나를 골라도
     * 닫히는데 전용 버튼이 한 줄을 더 차지하고 있었다. 위의 핸들이 그 자리를
     * 대신한다 — 이 앱의 다른 센터 팝업들과 같은 몸짓이다.
     */
    root.innerHTML = `
        <div class="absolute inset-0 mealog-action-dim pointer-events-auto" data-time-source-dismiss></div>
        <div class="time-source-sheet relative z-[1] w-full max-w-sm pointer-events-auto overflow-hidden rounded-2xl bg-white shadow-xl"
            role="dialog" aria-modal="true">
            <div class="mealog-dialog-grabber" role="button" tabindex="0"
                aria-label="아래로 쓸어내려 닫기" title="아래로 쓸어내려 닫기"></div>
            <div class="flex flex-col divide-y divide-slate-200/90">
                <button type="button" data-time-source-option="now" class="${rowBase} text-slate-900">
                    <i data-lucide="clock" class="shrink-0 text-sm text-slate-500" aria-hidden="true"></i>현재 시각
                </button>
                <button type="button" data-time-source-option="photo" class="${rowBase} text-slate-900">
                    <i data-lucide="camera" class="shrink-0 text-sm text-slate-500" aria-hidden="true"></i>사진 시각
                </button>
                <button type="button" data-time-source-option="manual" class="${rowBase} text-slate-900">
                    <i data-lucide="pen" class="shrink-0 text-sm text-slate-500" aria-hidden="true"></i>직접 입력
                </button>
                ${emptyRow}
                ${removeRow}
            </div>
        </div>`;

    document.body.appendChild(root);

    /* 제목이 사라졌으니 이름은 스크린리더에게만 남긴다 — 속성으로 넣어 이스케이프 걱정을 없앤다 */
    const panel = root.querySelector('.time-source-sheet');
    panel?.setAttribute('aria-label', title);
    bindDialogGrabberPullClose({
        root,
        panel,
        onClose: () => closeTimeSourceSheets()
    });
    /* innerHTML 로 심은 <i data-lucide> 는 여기서 불러 줘야 SVG 가 된다 —
       전역 MutationObserver 가 없어 자동으로 그려지지 않는다 (icons.js) */
    scheduleLucideIcons(root);
    attachEscapeHandler(() => closeTimeSourceSheets());
    bindSheetDismiss(root, () => closeTimeSourceSheets());

    root.querySelector('[data-time-source-option="now"]')?.addEventListener('click', () => {
        closeTimeSourceSheets();
        onNow?.();
    });

    root.querySelector('[data-time-source-option="photo"]')?.addEventListener('click', async () => {
        const btn = root.querySelector('[data-time-source-option="photo"]');
        if (btn) btn.disabled = true;
        try {
            await onPhoto?.();
        } finally {
            if (btn) btn.disabled = false;
        }
    });

    root.querySelector('[data-time-source-option="manual"]')?.addEventListener('click', () => {
        onManual?.();
    });

    root.querySelector('[data-time-source-option="empty"]')?.addEventListener('click', () => {
        closeTimeSourceSheets();
        onEmpty?.();
    });

    root.querySelector('[data-time-source-option="remove"]')?.addEventListener('click', () => {
        closeTimeSourceSheets();
        onRemove?.();
    });
}
