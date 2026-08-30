/**
 * 목록 순서 끌어 바꾸기 — 기록 항목 설정·메모 설정 공용
 * (docs/user-slot-plan.md §4.2 · docs/user-memo-items.md §4.3)
 *
 * ## 규칙 하나: 끄는 동안에는 데이터를 건드리지 않는다
 *
 * 이전 구현은 손가락이 한 칸을 지날 때마다 배열을 고치고 목록을 통째로 다시
 * 그렸다. 그래서:
 *
 * - 한 행 높이(44~47px)를 다 지나기 전에는 **아무 일도 일어나지 않았다.**
 *   행이 손가락을 따라오지도, 빈자리가 벌어지지도 않는다. 그러다 한 칸을
 *   순간이동한다. "끌기가 뻑뻑하다"의 정체가 이것이다.
 * - 다시 그리면서 **손잡이 노드가 사라진다.** 거기 걸어 둔 포인터 캡처가 함께
 *   풀리므로, 목록 **밖에서 손을 떼면 `pointerup` 이 오지 않는다** — 메모 설정은
 *   거기서 저장을 부르므로 옮겨 놓은 순서가 그대로 날아갔다. 좁은 시트에서
 *   손가락이 목록을 벗어나는 일은 흔하다.
 * - 아이콘이 매번 다시 그려져 깜빡이고, 이름 입력칸의 커서가 날아갔다.
 *
 * 그래서 끄는 동안에는 **픽셀만 움직인다.** DOM 순서도 배열도 그대로 두고
 * `transform` 만 바꾼다. 손을 뗄 때 한 번 `onMove` 로 알린다. 위 셋이 한꺼번에
 * 사라진다 — 손잡이가 살아 있으니 캡처도 유지된다.
 *
 * ## 행 높이가 균일하다고 본다
 *
 * 두 시트 모두 한 줄짜리 행이다(기록 항목 47px, 메모 44px). 균일하다는 가정이
 * 자리 계산을 `Math.round(dy / rowH)` 한 줄로 만든다. 여러 줄 행이 생기면 이
 * 가정부터 깨지므로, 그때는 행마다 높이를 재는 쪽으로 바꿔야 한다.
 */

/** 가장자리 이 안에 손가락이 들어오면 목록이 스스로 스크롤한다 */
const EDGE_BAND = 44;
/** 가장자리에 완전히 붙었을 때의 프레임당 스크롤 픽셀 */
const EDGE_SPEED = 16;

/** 끄는 동안 행에 붙는 클래스 — 전환은 CSS 가 맡는다 */
const ROW_CLASS = 'list-drag__row';
const LIFT_CLASS = 'list-drag__row--lift';

/**
 * @param {{
 *   list: HTMLElement,          // 행들을 담은 스크롤 컨테이너
 *   rowSelector: string,        // 행 하나를 고르는 선택자
 *   handleSelector: string,     // 손잡이(끌기 시작점) 선택자
 *   draggingClass?: string,     // 끄는 행에 얹을 호출부 고유 클래스
 *   isEnabled?: () => boolean,  // 세션이 살아 있는지 — 닫힌 시트에서 끌리지 않게
 *   onStart?: (idx: number) => void,  // 끌기 직전 정리(입력칸 반영·펼친 판 접기).
 *                                     // 여기서 다시 그려도 된다 — 그 뒤에 행을 다시 찾는다
 *   onMove: (from: number, to: number) => void  // 손 뗀 뒤 한 번. 모델 수정·재렌더·저장은 호출부 몫
 * }} options
 */
export function bindListDragReorder(options) {
    const { list, rowSelector, handleSelector, draggingClass, isEnabled, onStart, onMove } = options || {};
    if (!list || !rowSelector || !handleSelector || typeof onMove !== 'function') return;

    /** 끌기 중에만 사는 상태 */
    let rows = null;
    let dragRow = null;
    let dragIdx = -1;
    let toIdx = -1;
    let rowH = 0;
    let startY = 0;
    let startScroll = 0;
    let pointerY = 0;
    let capturedHandle = null;
    let capturedId = null;
    let rafId = 0;

    const enabled = () => (typeof isEnabled === 'function' ? isEnabled() !== false : true);
    const rowsNow = () => Array.from(list.querySelectorAll(rowSelector));

    /**
     * 지금 손가락 위치로 화면을 다시 칠한다.
     * 끄는 행은 손가락을 1:1로, 사이에 낀 행들은 한 칸씩 비켜선 자리를 그린다.
     */
    function paint() {
        if (dragIdx < 0 || !dragRow) return;
        // 자동 스크롤로 목록이 밀린 만큼도 이동으로 친다
        const dy = pointerY - startY + (list.scrollTop - startScroll);
        // 목록 밖으로는 안 나간다 — 첫 행 위/마지막 행 아래로 끌어도 제자리
        const shown = Math.max(-dragIdx * rowH, Math.min((rows.length - 1 - dragIdx) * rowH, dy));
        // 반 칸에서 자리가 바뀐다 — 한 칸을 다 지나야 했던 것이 뻑뻑함의 원인이었다
        toIdx = dragIdx + Math.round(shown / rowH);

        dragRow.style.transform = `translateY(${shown}px)`;
        for (let i = 0; i < rows.length; i++) {
            if (i === dragIdx) continue;
            let shift = 0;
            if (toIdx > dragIdx && i > dragIdx && i <= toIdx) shift = -rowH;
            else if (toIdx < dragIdx && i >= toIdx && i < dragIdx) shift = rowH;
            rows[i].style.transform = shift ? `translateY(${shift}px)` : '';
        }
    }

    /** 가장자리에 붙어 있는 동안 목록을 민다 — 안 그러면 화면 밖으로 못 옮긴다 */
    function tick() {
        rafId = 0;
        if (dragIdx < 0) return;
        const max = list.scrollHeight - list.clientHeight;
        if (max > 0) {
            const rect = list.getBoundingClientRect();
            let step = 0;
            if (pointerY < rect.top + EDGE_BAND) {
                step = -Math.ceil(((rect.top + EDGE_BAND - pointerY) / EDGE_BAND) * EDGE_SPEED);
            } else if (pointerY > rect.bottom - EDGE_BAND) {
                step = Math.ceil(((pointerY - (rect.bottom - EDGE_BAND)) / EDGE_BAND) * EDGE_SPEED);
            }
            if (step) {
                const before = list.scrollTop;
                list.scrollTop = Math.max(0, Math.min(max, before + step));
                if (list.scrollTop !== before) paint();
            }
        }
        rafId = requestAnimationFrame(tick);
    }

    function cleanup() {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        window.removeEventListener('pointermove', onWindowMove);
        window.removeEventListener('pointerup', onWindowUp);
        window.removeEventListener('pointercancel', onWindowCancel);
        if (rows) {
            for (const row of rows) {
                row.style.transform = '';
                row.classList.remove(ROW_CLASS, LIFT_CLASS);
                if (draggingClass) row.classList.remove(draggingClass);
            }
        }
        try {
            if (capturedHandle && capturedId != null) capturedHandle.releasePointerCapture?.(capturedId);
        } catch (_) {
            /* 이미 풀린 캡처 */
        }
        rows = null;
        dragRow = null;
        capturedHandle = null;
        capturedId = null;
        dragIdx = -1;
        toIdx = -1;
    }

    function onWindowMove(e) {
        if (dragIdx < 0) return;
        pointerY = e.clientY;
        paint();
    }
    function onWindowUp() {
        endDrag(true);
    }
    function onWindowCancel() {
        endDrag(false);
    }

    function endDrag(commit) {
        if (dragIdx < 0) return;
        const from = dragIdx;
        const to = toIdx;
        cleanup();
        if (commit && to !== from && to >= 0) onMove(from, to);
    }

    list.addEventListener('pointerdown', (e) => {
        if (dragIdx >= 0 || !enabled()) return;
        const handle = e.target.closest?.(handleSelector);
        if (!handle || !list.contains(handle)) return;
        const row = handle.closest(rowSelector);
        if (!row) return;

        const idx = rowsNow().indexOf(row);
        if (idx < 0) return;

        /**
         * 정리는 재는 것보다 **먼저** 한다. 메모 설정은 아이콘 판이 펼쳐져 있으면
         * 그 행만 키가 크다 — 접기 전에 재면 rowH 가 틀어져 자리 계산이 다 어긋난다.
         * 정리하면서 다시 그릴 수 있으므로 행·손잡이는 그 뒤에 다시 찾는다.
         */
        if (typeof onStart === 'function') onStart(idx);

        rows = rowsNow();
        dragRow = rows[idx];
        if (!dragRow) {
            rows = null;
            return;
        }
        const liveHandle = dragRow.querySelector(handleSelector) || handle;

        dragIdx = idx;
        toIdx = idx;
        rowH = dragRow.offsetHeight || 44;
        startY = e.clientY;
        pointerY = e.clientY;
        startScroll = list.scrollTop;

        for (const r of rows) r.classList.add(ROW_CLASS);
        dragRow.classList.add(LIFT_CLASS);
        if (draggingClass) dragRow.classList.add(draggingClass);

        try {
            liveHandle.setPointerCapture?.(e.pointerId);
            capturedHandle = liveHandle;
            capturedId = e.pointerId;
        } catch (_) {
            /* 캡처가 안 잡혀도 된다 — 아래 창 리스너가 같은 일을 한다 */
        }
        /**
         * 움직임·뗌은 **창에서** 받는다. 목록에만 걸면 손가락이 목록을 벗어난
         * 뒤 뗐을 때 이벤트가 오지 않아 옮긴 순서가 그대로 날아간다 — 좁은
         * 시트에서 쉽게 벌어지는 일이다. 포인터 캡처가 대개 막아 주지만,
         * 캡처가 안 잡히는 경우까지 여기서 덮는다.
         */
        window.addEventListener('pointermove', onWindowMove);
        window.addEventListener('pointerup', onWindowUp);
        window.addEventListener('pointercancel', onWindowCancel);

        e.preventDefault();
        rafId = requestAnimationFrame(tick);
    });

    /* 브라우저가 제스처를 가져가면(스크롤 인계 등) 거기서 끝낸다 */
    list.addEventListener('lostpointercapture', () => endDrag(true));

    /**
     * 키보드 — 손잡이에 포커스를 두고 ↑/↓.
     *
     * 손잡이가 `role="button"` 인데 눌러도 아무 일이 없으면 보조기기에는
     * 거짓말이 된다. 끌기로는 채울 수 없는 자리라 여기서 받는다.
     */
    list.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        if (dragIdx >= 0 || !enabled()) return;
        const handle = e.target.closest?.(handleSelector);
        if (!handle || !list.contains(handle)) return;
        const row = handle.closest(rowSelector);
        const all = rowsNow();
        const from = all.indexOf(row);
        if (from < 0) return;
        const to = Math.max(0, Math.min(all.length - 1, from + (e.key === 'ArrowUp' ? -1 : 1)));
        if (to === from) return;
        e.preventDefault();
        if (typeof onStart === 'function') onStart(from);
        onMove(from, to);
        /*
         * 옮긴 행의 손잡이로 포커스를 돌려준다 — 안 그러면 다시 그리는 순간
         * 포커스가 body 로 떨어져 두 칸째부터 화살표가 안 먹는다.
         * requestAnimationFrame 은 쓰지 않는다: 창이 가려져 있으면 안 불린다.
         */
        const refocus = () => rowsNow()[to]?.querySelector(handleSelector)?.focus();
        refocus();
        // 호출부가 마이크로태스크 뒤에 그리는 경우까지 한 번 더 덮는다
        if (document.activeElement?.closest?.(handleSelector) == null) {
            Promise.resolve().then(refocus);
        }
    });
}
