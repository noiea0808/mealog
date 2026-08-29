/**
 * 기록 모달 — 시·분·오전/오후 캐러셀(휠) 시간 선택
 */
import { showToast } from './ui.js';
import { mealClock24ToAmPmAndDisplay } from './meal-time-utils.js';

const PANEL_ID = 'mealClockWheelPickerSheet';

/** 휠을 이만큼 굴리면 한 칸 — 보통 마우스 한 노치(약 100px)가 한 칸이 되도록 잡았다 */
const WHEEL_STEP_PX = 100;
/** 한 번의 굴림으로 건너뛸 수 있는 최대 칸 수 */
const WHEEL_MAX_STEPS = 5;

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

    /** 항목을 창 한가운데로 올려놓는 스크롤 위치 */
    const centerTopOf = (item) => item.offsetTop - (scroller.clientHeight - item.offsetHeight) / 2;

    /**
     * 항목을 창 한가운데로 옮긴다.
     *
     * `scrollTo({ behavior: 'smooth' })` 는 쓰지 않는다. 이 스크롤러는 세로 scroll-snap 이
     * mandatory 라 **부드러운 스크롤 요청이 통째로 무시된다** — 실측에서 같은 자리를
     * behavior:'auto' 나 scrollTop 대입으로는 정상 이동했다. 조용히 아무 일도 안 하는 코드는
     * 남기지 않는다.
     */
    const centerOn = (item) => {
        if (!item) return;
        scroller.scrollTop = centerTopOf(item);
        paintActive();
    };

    /** 마우스로 끄는 중인가 */
    let drag = null;

    /**
     * 스크롤 중에는 가운데 강조만 따라간다.
     *
     * 예전에는 여기서 타이머로 가운데 정렬까지 했지만, 손가락으로 끌다 잠깐 멈추면
     * 끼어들어 휠을 빼앗는 자리였다. 터치에서 가운데로 붙이는 일은 CSS scroll-snap 이
     * 이미 한다. 마우스 경로는 각자 끝날 때 centerOn 을 직접 부른다.
     */
    scroller.addEventListener('scroll', paintActive, { passive: true });

    /**
     * 마우스 휠 — 굴린 만큼 우리가 직접 옮긴다.
     *
     * 이 스크롤러는 세로 scroll-snap 이 mandatory 라 브라우저가 휠 입력에 **아무 반응도
     * 하지 않는다**. (실측: 이벤트는 스크롤러까지 도달하는데 스크롤이 일어나지 않고,
     * 같은 입력도 snap 을 끄면 그대로 스크롤된다.) 그래서 기본 동작에 기대지 않는다.
     *
     * 보통 마우스 한 노치가 한 칸이 되게 잡았다 — 시간을 고르는 자리라 한 번에 크게
     * 건너뛰면 되돌리는 품이 더 든다.
     */
    let wheelAcc = 0;
    scroller.addEventListener(
        'wheel',
        (e) => {
            if (!e.deltaY) return;
            // 팝업 위에서 굴린 것이니 뒤 화면이 따라 움직이면 안 된다
            e.preventDefault();
            /**
             * 굴린 양을 모아 한 칸씩 끊는다. 이벤트 한 번에 한 칸으로 하면 장치마다
             * 어긋난다 — 트랙패드는 잔 이벤트를 쏟아내 휙 날아가고, 줄 단위로 보내는
             * 브라우저는 한 칸도 못 간다. deltaMode 는 0=픽셀·1=줄·2=쪽이라 픽셀로 맞춘다.
             */
            const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
            wheelAcc += px;
            let steps = Math.trunc(wheelAcc / WHEEL_STEP_PX);
            if (!steps) return;
            wheelAcc -= steps * WHEEL_STEP_PX;
            // 한 번에 너무 멀리 뛰면 되돌리는 품이 더 든다
            steps = Math.max(-WHEEL_MAX_STEPS, Math.min(WHEEL_MAX_STEPS, steps));
            const list = items();
            const cur = list.indexOf(getActiveItem());
            if (cur < 0) return;
            centerOn(list[Math.max(0, Math.min(list.length - 1, cur + steps))]);
        },
        { passive: false }
    );

    /**
     * 마우스 끌기·클릭 — 터치처럼 굴려서 고르게 한다.
     *
     * 마우스만 가로챈다. 터치는 관성까지 붙는 네이티브 스크롤이 더 낫고, 이미 잘 돈다.
     * 가로채지 않으면 마우스로는 굴릴 방법이 아예 없고, 끌어도 글자만 선택된다.
     */
    scroller.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        drag = {
            y: e.clientY,
            top: scroller.scrollTop,
            moved: false,
            // 포인터를 붙잡으면 이후 이벤트의 target 이 스크롤러로 바뀐다 — 지금 집어 둔다
            hit: e.target.closest?.('.mealog-wheel__item') || null
        };
        /**
         * 여기서 preventDefault 하지 않는다 — 그러면 브라우저가 이 누름을 마우스 포커스로
         * 세지 않아 :focus-visible 이 걸리고, 클릭만 해도 키보드용 포커스 테두리가 뜬다.
         * 끌 때 글자가 잡히는 건 CSS 의 user-select:none 이 막는다.
         */
        scroller.setPointerCapture(e.pointerId);
    });

    scroller.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dy = e.clientY - drag.y;
        // 손떨림을 끌기로 오해하면 클릭으로 고를 수 없게 된다
        if (!drag.moved && Math.abs(dy) < 3) return;
        drag.moved = true;
        scroller.scrollTop = drag.top - dy;
    });

    const endDrag = (e) => {
        if (!drag) return;
        const { moved, hit } = drag;
        drag = null;
        try {
            scroller.releasePointerCapture(e.pointerId);
        } catch (_) {
            // 이미 놓인 포인터 — 붙잡지 못했어도 아래 정렬은 그대로 해야 한다
        }
        // 끌었으면 놓은 자리에서 가장 가까운 칸으로, 안 끌었으면 누른 칸으로
        centerOn(moved ? getActiveItem() : hit);
    };
    scroller.addEventListener('pointerup', endDrag);
    scroller.addEventListener('pointercancel', endDrag);

    return {
        scrollToValue(val) {
            const item = scroller.querySelector(`.mealog-wheel__item[data-val="${val}"]`);
            if (!item) return;
            const top = centerTopOf(item);
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
