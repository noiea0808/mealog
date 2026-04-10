/**
 * 메인 앱 콘텐츠 팝업(관리자 등록 팝업) + 로그인 배너 조회/클릭 집계
 */
import { auth, db, appId } from '../firebase.js';
import { appState } from '../state.js';
import {
    doc,
    setDoc,
    collection,
    query,
    orderBy,
    limit,
    getDocs,
    runTransaction,
    serverTimestamp,
    increment
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';
import { renderFormattedContent } from '../render/utils.js';

function setContentPopupWidth() {
    const inner = document.getElementById('contentPopupModalInner');
    if (!inner) return;
    const contentWidth = document.body.clientWidth || document.documentElement.clientWidth;
    const popupWidth = Math.max(200, contentWidth - 10);
    inner.style.width = popupWidth + 'px';
}

function fillContentPopupModal(popup) {
    setContentPopupWidth();
    const imagesEl = document.getElementById('contentPopupImages');
    const contentEl = document.getElementById('contentPopupContent');
    const landingWrap = document.getElementById('contentPopupLandingWrap');
    const landingBtn = document.getElementById('contentPopupLandingBtn');
    if (!contentEl) return;
    imagesEl.innerHTML = '';
    if (imagesEl && Array.isArray(popup.imageUrls) && popup.imageUrls.length > 0) {
        popup.imageUrls.forEach(url => {
            const img = document.createElement('img');
            img.src = url;
            img.alt = '팝업 이미지';
            img.className = 'rounded-none';
            img.loading = 'lazy';
            imagesEl.appendChild(img);
        });
    }
    contentEl.innerHTML = renderFormattedContent(popup.content || '');
    if (landingWrap && landingBtn && popup.landingNoticeId) {
        landingWrap.classList.remove('hidden');
        landingBtn.textContent = popup.landingButtonLabel && popup.landingButtonLabel.trim() ? popup.landingButtonLabel.trim() : '선택한 공지 보기';
        landingBtn.onclick = () => {
            recordPopupClick(popup.id);
            window.closeContentPopupModal(false);
            if (appState.currentTab !== 'board') window.switchMainTab('board');
            setTimeout(() => { if (typeof window.openNoticeDetail === 'function') window.openNoticeDetail(popup.landingNoticeId); }, 100);
        };
    } else if (landingWrap) {
        landingWrap.classList.add('hidden');
    }
}

function recordPopupView(popupId) {
    if (!popupId || !auth.currentUser) return;
    const uid = auth.currentUser.uid;
    const popupRef = doc(db, 'artifacts', appId, 'popups', popupId);
    const viewRef = doc(db, 'artifacts', appId, 'popups', popupId, 'views', uid);
    runTransaction(db, async (tx) => {
        const snap = await tx.get(viewRef);
        if (snap.exists()) return;
        tx.set(viewRef, { at: serverTimestamp() });
        tx.update(popupRef, { viewCount: increment(1) });
    }).catch(() => {});
}

function recordPopupClick(popupId) {
    if (!popupId || !auth.currentUser) return;
    const uid = auth.currentUser.uid;
    const popupRef = doc(db, 'artifacts', appId, 'popups', popupId);
    const clickRef = doc(db, 'artifacts', appId, 'popups', popupId, 'clicks', uid);
    runTransaction(db, async (tx) => {
        const snap = await tx.get(clickRef);
        if (snap.exists()) return;
        tx.set(clickRef, { at: serverTimestamp() });
        tx.update(popupRef, { clickCount: increment(1) });
    }).catch(() => {});
}

/** 로그인 배너 조회 수 증가 — 로그인 사용자당 1회, 비로그인은 매번 집계 */
export function recordBannerView() {
    const bannerRef = doc(db, 'artifacts', appId, 'config', 'loginBanner');
    if (auth.currentUser) {
        const uid = auth.currentUser.uid;
        const viewRef = doc(db, 'artifacts', appId, 'config', 'loginBanner', 'views', uid);
        runTransaction(db, async (tx) => {
            const snap = await tx.get(viewRef);
            if (snap.exists()) return;
            tx.set(viewRef, { at: serverTimestamp() });
            tx.update(bannerRef, { viewCount: increment(1) });
        }).catch(() => {});
    } else {
        setDoc(bannerRef, { viewCount: increment(1) }, { merge: true }).catch(() => {});
    }
}

/** 로그인 배너 클릭 수 증가 — 로그인 사용자당 1회, 비로그인은 매번 집계 */
export function recordBannerClick() {
    const bannerRef = doc(db, 'artifacts', appId, 'config', 'loginBanner');
    if (auth.currentUser) {
        const uid = auth.currentUser.uid;
        const clickRef = doc(db, 'artifacts', appId, 'config', 'loginBanner', 'clicks', uid);
        runTransaction(db, async (tx) => {
            const snap = await tx.get(clickRef);
            if (snap.exists()) return;
            tx.set(clickRef, { at: serverTimestamp() });
            tx.update(bannerRef, { clickCount: increment(1) });
        }).catch(() => {});
    } else {
        setDoc(bannerRef, { clickCount: increment(1) }, { merge: true }).catch(() => {});
    }
}

export function registerContentPopup() {
    window.flushPendingContentPopup = function () {
        const tab = window._pendingContentPopupTab;
        if (tab == null) return;
        window._pendingContentPopupTab = null;
        setTimeout(() => {
            if (typeof window.checkAndShowContentPopup === 'function') {
                window.checkAndShowContentPopup(tab);
            }
        }, 0);
    };

    window.checkAndShowContentPopup = async function(tab) {
        if (sessionStorage.getItem('loginBannerLandingNoticeId')) return;
        if (window._attendancePopupResolutionPending) {
            window._pendingContentPopupTab = tab;
            return;
        }
        const attendancePopupEl = document.getElementById('attendancePopup');
        if (attendancePopupEl && !attendancePopupEl.classList.contains('hidden')) {
            window._pendingContentPopupTab = tab;
            return;
        }
        const modal = document.getElementById('contentPopupModal');
        const prevBtn = document.getElementById('contentPopupPrevBtn');
        const nextBtn = document.getElementById('contentPopupNextBtn');
        if (!modal) return;
        try {
            const popupsRef = collection(db, 'artifacts', appId, 'popups');
            const q = query(popupsRef, orderBy('timestamp', 'desc'), limit(50));
            const snap = await getDocs(q);
            const today = new Date().toISOString().slice(0, 10);
            const hostname = window.location.hostname || '';
            const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.');
            const currentEnv = isLocal ? 'staging' : (window.APP_ENV || 'production');
            const list = [];
            snap.forEach(docSnap => {
                const d = docSnap.data();
                const targetEnv = d.targetEnv || 'all';
                if (targetEnv !== 'all' && targetEnv !== currentEnv) return;
                if (d.targetMenu !== tab) return;
                const start = d.startDate || '';
                const end = d.endDate || '';
                if (start && end && today >= start && today <= end) list.push({ id: docSnap.id, ...d });
            });
            const isDismissed = (popup) => {
                if (popup.frequency === 'daily') {
                    return localStorage.getItem(`content_popup_daily_${popup.id}_${today}`) === '1';
                }
                if (popup.frequency === 'on_login') {
                    if (sessionStorage.getItem(`content_popup_${popup.id}`) === '1') return true;
                    return localStorage.getItem(`content_popup_login_${popup.id}_${today}`) === '1';
                }
                if (popup.frequency === 'on_visit') {
                    if (window._contentPopupDismissedVisit && window._contentPopupDismissedVisit.has(popup.id)) return true;
                    return localStorage.getItem(`content_popup_visit_${popup.id}_${today}`) === '1';
                }
                return false;
            };
            const toShowList = list.filter(p => !isDismissed(p));
            if (toShowList.length === 0) return;
            window._contentPopupList = toShowList;
            window._contentPopupIndex = 0;
            setContentPopupWidth();
            fillContentPopupModal(toShowList[0]);
            window._contentPopupCurrent = { id: toShowList[0].id, frequency: toShowList[0].frequency };
            recordPopupView(toShowList[0].id);
            const counterBar = document.getElementById('contentPopupCounterBar');
            const counterEl = document.getElementById('contentPopupCounter');
            const navRow = document.getElementById('contentPopupNavRow');
            const updatePopupNavButtons = () => {
                const total = window._contentPopupList.length;
                if (navRow) {
                    navRow.classList.toggle('hidden', total <= 1);
                }
                if (prevBtn) {
                    prevBtn.disabled = window._contentPopupIndex === 0;
                }
                if (nextBtn) {
                    nextBtn.disabled = window._contentPopupIndex >= total - 1;
                }
                if (counterBar && counterEl) {
                    if (total > 1) {
                        counterEl.textContent = (window._contentPopupIndex + 1) + '/' + total;
                        counterBar.classList.remove('popup-counter-empty');
                    } else {
                        counterEl.textContent = '';
                        counterBar.classList.add('popup-counter-empty');
                    }
                }
            };
            if (prevBtn) {
                prevBtn.onclick = () => {
                    if (window._contentPopupIndex <= 0) return;
                    window._contentPopupIndex -= 1;
                    const p = window._contentPopupList[window._contentPopupIndex];
                    fillContentPopupModal(p);
                    window._contentPopupCurrent = { id: p.id, frequency: p.frequency };
                    recordPopupView(p.id);
                    updatePopupNavButtons();
                };
            }
            if (nextBtn) {
                nextBtn.onclick = () => {
                    if (window._contentPopupIndex >= (window._contentPopupList.length - 1)) return;
                    window._contentPopupIndex += 1;
                    const p = window._contentPopupList[window._contentPopupIndex];
                    fillContentPopupModal(p);
                    window._contentPopupCurrent = { id: p.id, frequency: p.frequency };
                    recordPopupView(p.id);
                    updatePopupNavButtons();
                };
            }
            updatePopupNavButtons();
            modal.classList.remove('hidden');
        } catch (e) {
            console.warn('콘텐츠 팝업 조회 실패:', e);
        }
    };

    window.closeContentPopupModal = function(dismissToday) {
        const modal = document.getElementById('contentPopupModal');
        const prevBtn = document.getElementById('contentPopupPrevBtn');
        const nextBtn = document.getElementById('contentPopupNextBtn');
        if (!modal) return;
        const cur = window._contentPopupCurrent;
        if (cur) {
            const today = new Date().toISOString().slice(0, 10);
            if (cur.frequency === 'daily') {
                localStorage.setItem(`content_popup_daily_${cur.id}_${today}`, '1');
            } else if (cur.frequency === 'on_login') {
                sessionStorage.setItem(`content_popup_${cur.id}`, '1');
                if (dismissToday) localStorage.setItem(`content_popup_login_${cur.id}_${today}`, '1');
            } else if (cur.frequency === 'on_visit') {
                if (dismissToday) {
                    if (!window._contentPopupDismissedVisit) window._contentPopupDismissedVisit = new Set();
                    window._contentPopupDismissedVisit.add(cur.id);
                    localStorage.setItem(`content_popup_visit_${cur.id}_${today}`, '1');
                }
            }
        }
        window._contentPopupCurrent = null;
        window._contentPopupList = null;
        window._contentPopupIndex = 0;
        const navRow = document.getElementById('contentPopupNavRow');
        if (navRow) navRow.classList.add('hidden');
        if (prevBtn) {
            prevBtn.disabled = false;
        }
        if (nextBtn) {
            nextBtn.disabled = false;
        }
        modal.classList.add('hidden');
    };
}
