/**
 * '무엇을' 축 통합 판정 — 끼니·간식으로 갈린 저장 키를 언제 하나로 볼 것인가.
 *
 * 설계: `docs/food-axis-rollout.md` §6, `js/utils/food-axis-subtags.js` 머리주석.
 *
 * 파일럿 목록을 비우는 것만으로 통합이 꺼지면 안 된다는 것이 여기서 지키려는 전부다.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setFormAxisPilotUids } from '../js/utils/form-axis-pilot.js';
import { isWhatAxisUnified } from '../js/utils/food-axis-subtags.js';

const PILOT_UID = 'pilot-uid';

/** 파일럿 게이트는 uid 목록 + window.currentUser 로 판정한다 — 브라우저 전역의 대역 */
function setPilot(on, tags = null) {
    globalThis.window = { currentUser: { uid: PILOT_UID }, userSettings: tags ? { tags } : {} };
    setFormAxisPilotUids(on ? [PILOT_UID] : []);
}

beforeEach(() => setPilot(false));

describe('isWhatAxisUnified', () => {
    it('파일럿이면 관리자 문서가 옛 축이어도 통합으로 본다', () => {
        setPilot(true, { category: ['한식', '양식'], snackType: ['커피'] });
        assert.equal(isWhatAxisUnified(), true);
    });

    it('전환 전(두 축 목록이 다름)에는 통합이 아니다', () => {
        setPilot(false, { category: ['한식', '양식'], snackType: ['커피', '베이커리'] });
        assert.equal(isWhatAxisUnified(), false);
    });

    /**
     * 전환일에 파일럿 목록을 비우는 것만으로 통합이 꺼지면 안 된다 — 관리자 저장이
     * 두 필드에 같은 목록을 쓰므로(admin/tags.js saveTags) 그때는 축이 이미 하나다.
     */
    it('파일럿이 아니어도 두 축 목록이 같으면 통합으로 본다 (전환 완료 상태)', () => {
        const forms = ['밥류', '면류', '베이커리/떡'];
        setPilot(false, { category: forms, snackType: [...forms] });
        assert.equal(isWhatAxisUnified(), true);
    });

    it('설정이 아직 없으면 통합이 아니다 — 기본은 옛 동작', () => {
        setPilot(false);
        assert.equal(isWhatAxisUnified(), false);
    });
});
