// 외부 SNS 공유용 캡처 blob 예열 캐시
//
// navigator.share() 는 사용자 제스처 안에서 호출돼야 한다. 그런데 공유 카드 캡처는
// 폰트·이미지 로드까지 기다리느라 수백 ms ~ 수 초가 걸려서, 버튼을 누른 뒤에 캡처하면
// 제스처가 만료돼 공유 시트가 아예 안 열린다. 그래서 모달이 열릴 때 미리 캡처해 두고
// 버튼 클릭 시점에는 준비된 blob 을 꺼내 쓰기만 한다.
//
// diet-report.js 가 먼저 이 문제를 겪고 만든 패턴(refreshSnsShareBlobCache)을
// 네 곳(하루 기록·베스트·인사이트·AI 리포트)이 공유할 수 있게 일반화한 것이다.

/**
 * @param {object} opts
 * @param {() => Promise<HTMLCanvasElement>} opts.capture 캡처를 수행해 canvas 를 돌려주는 함수
 * @param {(busy: boolean) => void} [opts.onBusy] 예열 중 버튼 상태 표시용
 * @param {string} [opts.mimeType] 기본 image/jpeg — 공유 첨부는 용량이 작을수록 유리하다
 * @param {number} [opts.quality]
 * @param {string} [opts.label] 로그 식별용
 */
export function createShareBlobCache({
    capture,
    onBusy,
    mimeType = 'image/jpeg',
    quality = 0.92,
    label = 'share'
} = {}) {
    let blob = null;
    let blobKey = '';
    let pending = null;
    let pendingKey = '';

    function clear() {
        blob = null;
        blobKey = '';
    }

    function setBusy(busy) {
        try {
            if (typeof onBusy === 'function') onBusy(busy);
        } catch (e) {
            console.warn(`${label} blob cache onBusy 실패:`, e);
        }
    }

    /**
     * 캡처를 시작해 blob 을 채운다. 같은 key 로 이미 채워져 있으면 아무것도 하지 않고,
     * 같은 key 의 캡처가 진행 중이면 그 작업에 합류한다.
     * 실패해도 throw 하지 않는다 — 예열은 어디까지나 최적화라, 실패하면 클릭 시점에
     * ensure() 가 다시 시도한다.
     */
    async function warm(key = '') {
        if (typeof capture !== 'function') return;
        if (blob && blobKey === key) return;
        if (pending && pendingKey === key) {
            await pending;
            return;
        }

        clear();
        setBusy(true);
        pendingKey = key;
        pending = (async () => {
            try {
                const canvas = await capture();
                if (!canvas) return;
                const made = await new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
                if (!made) return;
                blob = made;
                blobKey = key;
            } catch (e) {
                console.warn(`${label} 공유 blob 예열 실패:`, e);
                clear();
            }
        })();

        try {
            await pending;
        } finally {
            if (pendingKey === key) {
                setBusy(false);
                pending = null;
                pendingKey = '';
            }
        }
    }

    /** 예열된 blob 을 즉시 돌려준다. 없으면 null — 제스처를 잃지 않으려면 이걸 먼저 쓴다. */
    function get(key = '') {
        return blob && blobKey === key ? blob : null;
    }

    /**
     * 예열이 없거나 키가 어긋났으면 지금 캡처해서라도 blob 을 만든다.
     * 여기까지 오면 제스처는 이미 놓쳤을 수 있으므로, 호출부는 get() 이 비었을 때만 쓴다.
     */
    async function ensure(key = '') {
        const ready = get(key);
        if (ready) return ready;
        await warm(key);
        return get(key);
    }

    return { warm, get, ensure, clear };
}
