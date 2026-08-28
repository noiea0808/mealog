/**
 * 관리자 users 로컬 미러 — 순수 계산부
 *
 * 루트 users 문서 + config/settings 문서를 「사용자 분석」이 쓰는 행으로 빚는 규칙.
 * users.js 의 목록 빌더와 **같은 함수를 쓴다** — 두 곳이 갈라지면 분석 값이 목록과
 * 어긋나므로, 파생 규칙은 여기 하나만 둔다.
 *
 * DOM·IDB·네트워크를 모르므로 node 테스트로 그대로 돌린다.
 * 설계 문서: docs/admin-local-mirror.md
 */

/**
 * 미러 행의 모양 버전. 행에 필드를 더하거나 뜻을 바꾸면 올린다 —
 * 옛 모양으로 담긴 미러는 `decideUsersSyncMode` 가 전체 재구축으로 되돌린다.
 * (IndexedDB 스키마 버전과는 다른 축이다. 스토어 구조는 그대로이고 행 내용만 바뀐다.)
 *
 * v2: `hasSettings`(고아 문서도 담는다) · `journal`(하루 소감 자국) 추가
 */
export const USERS_MIRROR_ROW_SCHEMA = 2;

/** Firestore Timestamp·Date·숫자·문자열·{seconds,nanoseconds} 를 모두 Date 로 */
export function parseRootTimestampField(raw) {
    if (raw == null || raw === '') return null;
    try {
        if (typeof raw.toDate === 'function') {
            const d = raw.toDate();
            return d != null && !Number.isNaN(d.getTime()) ? d : null;
        }
        if (raw instanceof Date) {
            return !Number.isNaN(raw.getTime()) ? raw : null;
        }
        if (typeof raw === 'number' && Number.isFinite(raw)) {
            const d = new Date(raw);
            return !Number.isNaN(d.getTime()) ? d : null;
        }
        if (typeof raw === 'object' && raw !== null) {
            const secRaw = raw.seconds ?? raw._seconds;
            const nanRaw = raw.nanoseconds ?? raw._nanoseconds ?? 0;
            const sec =
                typeof secRaw === 'number' && Number.isFinite(secRaw)
                    ? secRaw
                    : secRaw != null && secRaw !== ''
                      ? Number(secRaw)
                      : NaN;
            const nan =
                typeof nanRaw === 'number' && Number.isFinite(nanRaw)
                    ? nanRaw
                    : nanRaw != null && nanRaw !== ''
                      ? Number(nanRaw)
                      : 0;
            if (Number.isFinite(sec)) {
                const ms = sec * 1000 + (Number.isFinite(nan) ? nan / 1e6 : 0);
                const d = new Date(ms);
                return !Number.isNaN(d.getTime()) ? d : null;
            }
        }
        const d = new Date(raw);
        return !Number.isNaN(d.getTime()) ? d : null;
    } catch (_) {
        return null;
    }
}

export function parseSettingsDate(v) {
    if (v == null || v === '') return null;
    if (typeof v?.toDate === 'function') return v.toDate();
    if (v instanceof Date) return v;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** 루트 createdAt 이 없으면 프로필 완료·약관 동의 시각 중 이른 쪽을 가입일로 본다 */
export function coalesceSignupDate(rootCreated, profileCompletedAt, termsAgreedAt) {
    if (rootCreated) {
        return rootCreated instanceof Date ? rootCreated : new Date(rootCreated);
    }
    const cands = [profileCompletedAt, termsAgreedAt].filter((x) => x != null);
    if (!cands.length) return null;
    const times = cands.map((d) => (d instanceof Date ? d : new Date(d)).getTime()).filter((t) => Number.isFinite(t));
    if (!times.length) return null;
    return new Date(Math.min(...times));
}

export function computeSignupToLastLoginMs(createdAt, lastLoginAt) {
    const c = createdAt ? (createdAt instanceof Date ? createdAt : new Date(createdAt)) : null;
    const l = lastLoginAt ? (lastLoginAt instanceof Date ? lastLoginAt : new Date(lastLoginAt)) : null;
    if (!c || !l) return null;
    const ct = c.getTime();
    const lt = l.getTime();
    if (!Number.isFinite(ct) || !Number.isFinite(lt)) return null;
    if (lt < ct) return null;
    return lt - ct;
}

/**
 * providerId·email·UID 로 로그인 수단을 정한다.
 * providerId 가 빈 레거시·레이스 문서라도 카카오 커스텀 토큰 UID(kakao_*)는 카카오로 —
 * 앱 화면과 표기를 맞춘다.
 */
export function deriveLoginMethod(providerId, email, userId) {
    if (providerId === 'google.com') return '구글';
    if (providerId === 'kakao.com') return '카카오';
    if (email) return '이메일';
    if (typeof userId === 'string' && /^kakao_/i.test(userId)) return '카카오';
    return '게스트';
}

/**
 * 루트 문서 + settings 문서 → 미러 행.
 *
 * **settings 가 없어도 행을 만든다** — `hasSettings: false` 로 표시할 뿐이다.
 * 자가 탈퇴 등으로 루트만 남은 고아 문서인데, 「사용자 분석」과 목록은 이런 행을
 * 건너뛰지만 **대시보드 신규 사용자**는 루트 `createdAt` 기준으로 그대로 센다
 * (서버 전량 조회 시절과 같은 집합을 유지해야 숫자가 어긋나지 않는다).
 * 소비자별 걸러내기는 `buildUserAnalyticsRow` / `getAllUsersFromMirror` 가 한다.
 *
 * @param {string} userId
 * @param {object|null} rootData users/{uid} 문서 데이터
 * @param {object|null} settingsData users/{uid}/config/settings 문서 데이터 (없으면 null)
 * @param {{d:string, r:string}[]} [journalMarks] 하루 소감 자국 — 날짜키와 기록 시각(ISO).
 *        내용 유무 판정(`dailyJournalHasContent`)은 브라우저 쪽에서 끝내고 넘긴다 —
 *        이 파일은 순수 계산부라 앱 유틸을 끌어오지 않는다.
 */
export function buildUserMirrorRow(userId, rootData, settingsData, journalMarks) {
    if (!userId) return null;
    const root = rootData || {};
    const hasSettings = !!settingsData;

    let birthdate = '';
    let lifestyle = '';
    let gender = null;
    if (settingsData?.profile) {
        const p = settingsData.profile;
        if (p.birthdate) birthdate = String(p.birthdate).trim();
        if (p.lifestyle) lifestyle = String(p.lifestyle).trim();
        if (p.gender === 'male' || p.gender === 'female') gender = p.gender;
    }

    const email = settingsData?.email || root.email || null;
    const providerId = settingsData?.providerId || root.providerId || null;
    const loginMethod = deriveLoginMethod(providerId, email, userId);

    const createdAt = parseRootTimestampField(root.createdAt);
    const lastLoginAt = parseRootTimestampField(root.lastLoginAt);
    const createdAtResolved = coalesceSignupDate(
        createdAt,
        parseSettingsDate(settingsData?.profileCompletedAt),
        parseSettingsDate(settingsData?.termsAgreedAt)
    );

    // 게스트는 가입~마지막 로그인 간격을 재지 않는다(활동 기간 버킷에서 따로 센다)
    const signupToLastLoginMs =
        loginMethod === '게스트' ? null : computeSignupToLastLoginMs(createdAtResolved || createdAt, lastLoginAt);

    return {
        userId,
        hasSettings,
        birthdate,
        lifestyle,
        gender,
        loginMethod,
        // Date 는 IndexedDB 에 그대로 담기지만, 저장 형식을 못 박아 두려고 ISO 로 눕힌다
        createdAt: createdAt ? createdAt.toISOString() : null,
        lastLoginAt: lastLoginAt ? lastLoginAt.toISOString() : null,
        signupToLastLoginMs,
        journal: normalizeJournalMarks(journalMarks)
    };
}

/** 하루 소감 자국 배열을 저장 형태로 — 날짜키가 성한 것만, 날짜 오름차순 */
export function normalizeJournalMarks(marks) {
    if (!Array.isArray(marks)) return [];
    const out = [];
    for (const m of marks) {
        const d = typeof m?.d === 'string' ? m.d.trim() : '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
        out.push({ d, r: typeof m?.r === 'string' ? m.r : '' });
    }
    out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    return out;
}

/**
 * 「사용자 분석」·사용자 목록이 쓰는 행 — settings 없는 고아는 예전처럼 null.
 * 파생 규칙은 위 `buildUserMirrorRow` 하나뿐이고, 여기서는 걸러내기만 한다.
 */
export function buildUserAnalyticsRow(userId, rootData, settingsData, journalMarks) {
    if (!userId || !settingsData) return null;
    return buildUserMirrorRow(userId, rootData, settingsData, journalMarks);
}

/** IDB 에 눕혀 둔 ISO 를 분석 코드가 기대하는 Date 로 되살린다 */
export function reviveUserRow(row) {
    if (!row) return null;
    return {
        ...row,
        createdAt: row.createdAt ? new Date(row.createdAt) : null,
        lastLoginAt: row.lastLoginAt ? new Date(row.lastLoginAt) : null
    };
}

/**
 * 델타 동기화의 시작점 — meals 와 같은 이유로 겹침 창만큼 물러난다.
 * users 의 축은 서버 시각(lastLoginAt)이지만, 시계가 어긋난 기기가 쓴 값이 섞일 수
 * 있고 동기화 도중 로그인이 끼어들 수도 있어 겹쳐 읽는 편이 안전하다.
 *
 * @returns {Date|null} null 이면 전체 재구축
 */
export function computeUsersSyncStart(lastSyncedAt, overlapMs = 48 * 3600 * 1000) {
    const t = Date.parse(lastSyncedAt || '');
    if (!Number.isFinite(t)) return null;
    return new Date(t - overlapMs);
}

/**
 * 전체 재구축이 필요한지 판단한다.
 *
 * 삭제는 별도 신호가 없다 — 탈퇴하면 루트 문서째 사라져 델타 쿼리에 걸리지 않는다.
 * 그래서 서버의 루트 문서 수를 1회 세어(getCountFromServer, 1읽기) 미러가 아는 수와
 * 다르면 통째로 다시 받는다. 늘어난 경우(신규 가입)는 델타가 이미 채웠으므로,
 * **줄었을 때만** 삭제로 본다.
 *
 * @param {{bootstrapDone?: boolean, lastSyncedAt?: string, rootDocCount?: number}} meta
 * @param {number|null} serverRootCount 서버가 센 루트 문서 수 (못 셌으면 null)
 * @param {number} maxAgeMs 전체 재구축 주기 (기본 7일)
 * @param {number} nowMs
 */
export function decideUsersSyncMode(meta, serverRootCount, maxAgeMs = 7 * 24 * 3600 * 1000, nowMs = Date.now()) {
    if (!meta || !meta.bootstrapDone) return { mode: 'full', reason: 'no-mirror' };
    const t = Date.parse(meta.lastSyncedAt || '');
    if (!Number.isFinite(t)) return { mode: 'full', reason: 'bad-bookmark' };
    // 행 모양이 바뀌었으면 델타로는 옛 행을 고칠 수 없다 — 통째로 다시 빚는다
    if (Number(meta.rowSchema || 0) !== USERS_MIRROR_ROW_SCHEMA) return { mode: 'full', reason: 'schema-changed' };
    if (nowMs - t > maxAgeMs) return { mode: 'full', reason: 'stale' };
    if (
        typeof serverRootCount === 'number' &&
        Number.isFinite(serverRootCount) &&
        typeof meta.rootDocCount === 'number' &&
        serverRootCount < meta.rootDocCount
    ) {
        return { mode: 'full', reason: 'deletion-detected' };
    }
    return { mode: 'delta', reason: 'ok' };
}
