/**
 * 기록 모달 — 시·분·오전/오후 캐러셀(휠) 시간 선택
 */
import { showToast } from './ui.js';
import { mealClock24ToAmPmAndDisplay } from './meal-time-utils.js';

const PANEL_ID = 'mealClockWheelPickerSheet';

let escapeHandler = null;

function closeSiblingTimeSheets() {
    document.getElementById('timeSourcePickerSheet')?.remove();
    document.getElementById('timeSourceManualSheet')?.remove();
}

function closeMealClockWheelPicker() {
    document.getElementById(PANEL_ID)?.remove();
    if (escapeHandler) {
        document.removeEventListener('keydown', escapeHandler);
        escapeHandler = null;
    }
}

function attachEscape(onDismiss) {
    if (escapeHandler) document.removeEventListener('keydown', escapeHandler);
    escapeHandler = (e) => {
        if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', escapeHandler);
}

function buildWheelItems(items) {
    return items
        .map(
            (item) =>
                `<div class="mealog-wheel__item" data-val="${item.value}" role="option">${item.label}</div>`
        )
        .join('');
}

function createWheelColumn(label, items, ariaLabel) {
    return `<div class="mealog-wheel--time-col" aria-label="${ariaLabel}">
        <span class="mealog-wheel--time-col__label">${label}</span>
        <div class="mealog-wheel mealog-wheel--time">
            <div class="mealog-wheel__indicator" aria-hidden="true"></div>
            <div class="mealog-wheel__scroller" tabindex="0">
                <div class="mealog-wheel__pad"></div>
                ${buildWheelItems(items)}
                <div class="mealog-wheel__pad"></div>
            </div>
        </div>
    </div>`;
}

function initWheelScroller(scroller) {
    const items = () => [...scroller.querySelectorAll('.mealog-wheel__item')];

    const getActiveItem = () => {
        const list = items();
        if (!list.length) return null;
        const center = scroller.scrollTop + scroller.clientHeight / 2;
        let best = null;
        let bestDist = Infinity;
        list.forEach((item) => {
            const itemCenter = item.offsetTop + item.offsetHeight / 2;
            const dist = Math.abs(itemCenter - center);
            if (dist < bestDist) {
                bestDist = dist;
                best = item;
            }
        });
        return best;
    };

    const paintActive = () => {
        const active = getActiveItem();
        items().forEach((item) => {
            item.classList.toggle('mealog-wheel__item--active', item === active);
        });
        return active?.getAttribute('data-val') ?? null;
    };

    let scrollTimer = null;
    scroller.addEventListener(
        'scroll',
        () => {
            paintActive();
            clearTimeout(scrollTimer);
            scrollTimer = setTimeout(() => {
                const active = getActiveItem();
                if (!active) return;
                const top = active.offsetTop - (scroller.clientHeight - active.offsetHeight) / 2;
                scroller.scrollTo({ top, behavior: 'smooth' });
                paintActive();
            }, 100);
        },
        { passive: true }
    );

    return {
        scrollToValue(val) {
            const item = scroller.querySelector(`.mealog-wheel__item[data-val="${val}"]`);
            if (!item) return;
            const top = item.offsetTop - (scroller.clientHeight - item.offsetHeight) / 2;
            scroller.scrollTop = top;
            requestAnimationFrame(() => {
                scroller.scrollTop = top;
                paintActive();
            });
        },
        getValue() {
            return paintActive();
        },
    };
}

/**
 * @param {{
 *   initialDate?: Date,
 *   zIndex?: number,
 *   onApply: (date: Date) => void,
 * }} options
 */
export function openMealClockWheelPanel(options = {}) {
    const { initialDate = new Date(), zIndex = 420, onApply } = options;

    closeSiblingTimeSheets();
    closeMealClockWheelPicker();

    const n24 = `${String(initialDate.getHours()).padStart(2, '0')}:${String(initialDate.getMinutes()).padStart(2, '0')}`;
    const { ampm, display } = mealClock24ToAmPmAndDisplay(n24);
    const [hStr = '12', mStr = '00'] = (display || '12:00').split(':');

    const ampmItems = [
        { value: 'am', label: '오전' },
        { value: 'pm', label: '오후' },
    ];
    const hourItems = Array.from({ length: 12 }, (_, i) => {
        const v = String(i + 1).padStart(2, '0');
        return { value: v, label: v };
    });
    const minuteItems = Array.from({ length: 60 }, (_, i) => {
        const v = String(i).padStart(2, '0');
        return { value: v, label: v };
    });

    const root = document.createElement('div');
    root.id = PANEL_ID;
    root.className = 'fixed inset-0 flex items-center justify-center p-4 pointer-events-none';
    root.style.zIndex = String(zIndex);
    root.setAttribute('role', 'presentation');

    const rowBase =
        'flex w-full items-center justify-center border-0 bg-transparent px-4 py-3 text-center text-base outline-none active:bg-slate-100';

    root.innerHTML = `
        <div class="absolute inset-0 bg-black/45 pointer-events-auto" data-meal-clock-wheel-dismiss></div>
        <div class="relative z-[1] w-full max-w-sm pointer-events-auto overflow-hidden rounded-2xl bg-white shadow-xl">
            <div class="px-4 pt-4 pb-2 border-b border-slate-100">
                <h3 class="text-base font-bold text-slate-800 text-center">시간 직접 입력</h3>
            </div>
            <div class="mealog-wheel--time-picker-row px-3 py-3">
                ${createWheelColumn('오전/오후', ampmItems, '오전 또는 오후')}
                ${createWheelColumn('시', hourItems, '시')}
                ${createWheelColumn('분', minuteItems, '분')}
            </div>
            <div class="grid grid-cols-2 border-t border-slate-200">
                <button type="button" data-meal-clock-wheel-dismiss class="${rowBase} text-slate-700 border-r border-slate-200 font-semibold">취소</button>
                <button type="button" data-meal-clock-wheel-apply class="${rowBase} text-emerald-700 font-bold">적용</button>
            </div>
        </div>`;

    document.body.appendChild(root);
    attachEscape(() => closeMealClockWheelPicker());

    root.querySelectorAll('[data-meal-clock-wheel-dismiss]').forEach((el) => {
        el.addEventListener('click', () => closeMealClockWheelPicker());
    });

    const scrollers = [...root.querySelectorAll('.mealog-wheel__scroller')];
    const [ampmWheel, hourWheel, minuteWheel] = scrollers.map((el) => initWheelScroller(el));

    ampmWheel.scrollToValue(ampm === 'am' ? 'am' : 'pm');
    hourWheel.scrollToValue(hStr.padStart(2, '0'));
    minuteWheel.scrollToValue(mStr.padStart(2, '0'));

    root.querySelector('[data-meal-clock-wheel-apply]')?.addEventListener('click', () => {
        const ap = ampmWheel.getValue();
        const hh12 = hourWheel.getValue();
        const mm = minuteWheel.getValue();
        if (!ap || !hh12 || mm == null) {
            showToast('시간을 선택해주세요.', 'error');
            return;
        }
        let h = parseInt(hh12, 10);
        const mi = parseInt(mm, 10);
        if (!Number.isFinite(h) || h < 1 || h > 12 || !Number.isFinite(mi)) {
            showToast('올바른 시간을 선택해주세요.', 'error');
            return;
        }
        if (ap === 'am') {
            h = h === 12 ? 0 : h;
        } else {
            h = h === 12 ? 12 : h + 12;
        }
        const date = new Date(initialDate);
        date.setHours(h, mi, 0, 0);
        closeMealClockWheelPicker();
        onApply?.(date);
    });
}

export function closeMealClockWheelPickerSheets() {
    closeMealClockWheelPicker();
}
