/**
 * 체험(데모) 계정: 하단 네비 메뉴별 빨간 점 + 개별 안내 패널
 */
import { isDemoUser } from './demo-account.js';

const SEEN_PREFIX = 'mealog_demo_nav_seen_';
const TABS = ['dashboard', 'gallery', 'timeline', 'board', 'settings'];

const DEFAULT_GUIDE_TEXT = {
    dashboard: { label: '밀당', desc: '기간별 참견 코멘트와 식사·간식·건강 분석을 볼 수 있어요.' },
    gallery:   { label: '모먼트', desc: '공유된 사진 피드와 반응을 모아 볼 수 있어요.' },
    timeline:  { label: '밀로그', desc: '날짜별 끼니·하루 기록을 홈 피드로 확인해요.' },
    board:     { label: '라운지', desc: '밀톡으로 대화하고, 게시판에 글을 남길 수 있어요.' },
    settings:  { label: '마이', desc: '프로필·알림·태그를 관리할 수 있어요.' },
};

let GUIDE_TEXT = { ...DEFAULT_GUIDE_TEXT };
let guideTextLoaded = false;

async function ensureGuideText() {
    if (guideTextLoaded) return;
    guideTextLoaded = true;
    try {
        const { db, appId } = await import('./firebase.js');
        const { doc, getDoc } = await import('https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js');
        const snap = await getDoc(doc(db, 'artifacts', appId, 'content', 'demoGuide'));
        if (snap.exists()) {
            const data = snap.data();
            for (const key of TABS) {
                if (data[key]?.label || data[key]?.desc) {
                    GUIDE_TEXT[key] = {
                        label: data[key].label || DEFAULT_GUIDE_TEXT[key].label,
                        desc:  data[key].desc  || DEFAULT_GUIDE_TEXT[key].desc,
                    };
                }
            }
        }
    } catch (_) { /* fallback to defaults */ }
}

function isTabSeen(tab) {
    try { return sessionStorage.getItem(SEEN_PREFIX + tab) === '1'; } catch (_) { return false; }
}
function markTabSeen(tab) {
    try { sessionStorage.setItem(SEEN_PREFIX + tab, '1'); } catch (_) {}
}

let pendingTab = null;

/** 각 탭의 점 표시/숨김 */
export function syncDemoNavGuideDots() {
    const demo = !!(window.currentUser && isDemoUser(window.currentUser));
    TABS.forEach(tab => {
        const btn = document.getElementById(tab === 'settings' ? 'nav-settings' : `nav-${tab}`);
        const dot = btn?.querySelector('.demo-nav-guide-dot');
        if (!dot) return;
        dot.classList.toggle('hidden', !demo || isTabSeen(tab));
    });
    if (!demo) {
        document.getElementById('demoNavGuidePanel')?.classList.add('hidden');
        document.getElementById('demoNavGuideBackdrop')?.classList.add('hidden');
        pendingTab = null;
        try { TABS.forEach(t => sessionStorage.removeItem(SEEN_PREFIX + t)); } catch (_) {}
    }
}

async function showGuideForTab(tab) {
    await ensureGuideText();
    const panel = document.getElementById('demoNavGuidePanel');
    const title = document.getElementById('demoNavGuideTitle');
    const desc = document.getElementById('demoNavGuideDesc');
    if (!panel || !title || !desc) return;
    const g = GUIDE_TEXT[tab];
    if (!g) return;
    title.textContent = g.label;
    desc.textContent = g.desc;
    panel.classList.remove('hidden');
    document.getElementById('demoNavGuideBackdrop')?.classList.remove('hidden');
}

function closePanel() {
    pendingTab = null;
    document.getElementById('demoNavGuidePanel')?.classList.add('hidden');
    document.getElementById('demoNavGuideBackdrop')?.classList.add('hidden');
}

/**
 * 네비 클릭 시 가이드 상태를 갱신한다.
 * - 안 본 탭이면 seen 처리 후 pendingTab에 저장 → 호출측이 탭 전환 후 showPendingDemoGuide() 호출
 * - 이미 본 탭이면 열려 있던 패널만 닫는다
 * 탭 전환 자체는 항상 호출측에서 수행하므로, 여기서는 가이드 표시 여부만 결정한다.
 */
export function handleDemoAwareNavClick(tab) {
    if (!(window.currentUser && isDemoUser(window.currentUser))) return;

    const panel = document.getElementById('demoNavGuidePanel');
    const panelVisible = panel && !panel.classList.contains('hidden');

    if (!isTabSeen(tab)) {
        markTabSeen(tab);
        syncDemoNavGuideDots();
        pendingTab = tab;
    } else {
        if (panelVisible) closePanel();
    }
}

/** 탭 전환이 끝난 직후 호출 — pendingTab이 있으면 가이드 표시 */
export function showPendingDemoGuide() {
    const t = pendingTab;
    if (!t) return;
    setTimeout(() => showGuideForTab(t), 80);
}

/** Android 뒤로가기 */
export function tryCloseDemoNavGuideFromBack() {
    const panel = document.getElementById('demoNavGuidePanel');
    if (!panel || panel.classList.contains('hidden')) return false;
    closePanel();
    return true;
}

export function registerDemoNavGuideHandlers() {
    const closeBtn = document.getElementById('demoNavGuideCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', closePanel);
}
