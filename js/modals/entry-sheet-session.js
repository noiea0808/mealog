/**
 * 기록 시트 한 번의 열림 = 한 세션. 「열었는데 저장까지 갔나」를 센다.
 *
 * 개편 효과를 재려면 완주율(저장 / 열기)이 필요한데, 지금까지 **분모가 없었다.**
 * 저장된 기록만 남으니 "시트를 열었다가 그냥 닫은" 사건은 흔적조차 없었다.
 * 그래서 기록 건수가 줄면 그게 덜 열어서인지, 열고도 못 끝내서인지 가릴 수 없었다.
 *
 * 세는 규칙 세 가지.
 *
 * 1. **신규 작성만 센다.** 수정 진입은 성격이 다르다 — 이미 있는 기록을 고치는 것이라
 *    "완주"라는 말이 성립하지 않고, 섞으면 분모가 오염된다.
 *
 * 2. **결과는 닫을 때 정확히 한 번.** 저장·삭제·버리기가 각자 closeModal 을 부르므로
 *    닫는 쪽에서 한 번만 확정한다. 두 번 부르거나 세션 없이 부르는 것은 무시한다.
 *
 * 3. **표시가 없으면 이탈이다.** 안드로이드 뒤로가기는 requestCloseEntryModal 을 거치지
 *    않고 closeModal 을 직접 부른다(js/main/event-listeners.js). 그런 경로를 하나씩
 *    찾아 표시하는 대신, 「아무 말 없이 닫혔으면 이탈」을 기본값으로 둔다. 새 닫기 경로가
 *    생겨도 조용히 누락되지 않는다.
 *
 * opened ≈ saved + abandoned + discarded 이며, 차이는 앱이 그대로 죽은 세션이다.
 * 그 차이 자체가 신호라서 opened 를 따로 센다(saved 에서 역산하지 않는다).
 */

/** 이탈 사유 없이 닫힌 경우의 기본 결과 */
const DEFAULT_OUTCOME = 'abandoned';

/**
 * 이 모듈이 발행할 수 있는 usageDaily 키 전부.
 *
 * 여기서 나가는 키는 logUsageMetric('...') 리터럴로 나타나지 않아서, 호출부를 훑는
 * 동기화 검사(test/usage-metric-keys-sync.test.mjs)의 눈에 안 띈다. 그 검사가 읽을 수
 * 있도록 **문자열 리터럴 그대로** 모아 내보낸다. 값을 계산해 채우면 검사가 다시 못 읽는다.
 *
 * 아래 상수·표와 어긋나지 않는 것은 이 모듈의 단위 테스트가 지킨다.
 */
export const ENTRY_SHEET_METRIC_KEYS = Object.freeze([
    'entry_sheet_opened',
    'entry_sheet_saved',
    'entry_sheet_abandoned',
    'entry_sheet_discarded'
]);

export const ENTRY_SHEET_OPENED_KEY = 'entry_sheet_opened';

/** 결과 → usageDaily 키. 'deleted' 는 이탈이 아니므로 세지 않는다 */
const OUTCOME_METRIC_KEYS = {
    saved: 'entry_sheet_saved',
    abandoned: 'entry_sheet_abandoned',
    discarded: 'entry_sheet_discarded',
    deleted: null
};

/** 표시할 수 있는 결과 이름 — 테스트가 전 경로를 훑을 때 쓴다 */
export const ENTRY_SHEET_OUTCOMES = Object.freeze(Object.keys(OUTCOME_METRIC_KEYS));

/**
 * @param {(key: string) => void} log 계측 함수 (기본은 logUsageMetric)
 */
export function createEntrySheetSessionTracker(log) {
    /** @type {{outcome: string|null}|null} */
    let session = null;

    const emit = (key) => {
        if (!key) return;
        try {
            log(key);
        } catch (_) {
            /* 계측 실패가 시트를 막아서는 안 된다 */
        }
    };

    return {
        /**
         * 시트를 열었다. 수정 진입이면 세션을 만들지 않는다.
         * 이전 세션이 결과 없이 남아 있으면(닫기 경로를 못 탄 것) 이탈로 정리하고 시작한다.
         * @param {{isEdit?: boolean}} [opts]
         */
        begin(opts = {}) {
            if (session) this.end();
            if (opts.isEdit) {
                session = null;
                return false;
            }
            session = { outcome: null };
            emit(ENTRY_SHEET_OPENED_KEY);
            return true;
        },

        /**
         * 이 세션이 어떻게 끝났는지 표시한다. 먼저 표시된 값이 이긴다 —
         * 저장 성공 후 closeModal 이 이어지는데, 뒤늦은 표시가 그걸 덮으면 안 된다.
         * @param {'saved'|'abandoned'|'discarded'|'deleted'} outcome
         */
        mark(outcome) {
            if (!session || session.outcome) return false;
            if (!Object.prototype.hasOwnProperty.call(OUTCOME_METRIC_KEYS, outcome)) return false;
            session.outcome = outcome;
            return true;
        },

        /** 시트가 닫혔다. 결과를 확정해 한 번만 기록한다. */
        end() {
            if (!session) return null;
            const outcome = session.outcome || DEFAULT_OUTCOME;
            session = null;
            emit(OUTCOME_METRIC_KEYS[outcome]);
            return outcome;
        },

        /** 테스트·진단용 */
        isActive() {
            return session !== null;
        }
    };
}
