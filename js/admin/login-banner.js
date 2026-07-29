// ADMIN 로그인 배너 — 팝업과 유사: 기간·표시환경별 캠페인, 항목별 조회/클릭
import { db, appId } from '../firebase.js';
import {
    collection,
    query,
    orderBy,
    getDocs,
    doc,
    getDoc,
    addDoc,
    updateDoc,
    deleteDoc,
    deleteField,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { escapeHtml, runAdminRefreshAction } from './utils.js';
import { uploadLoginBannerImage } from '../utils.js';

const TARGET_ENV_LABELS = { all: '전체', production: '프로덕션만', staging: '스테이징만 (로컬 포함)' };

/** 로그인 화면은 컬렉션이 비면 이 문서로 폴백함 — 목록에만 특수 행으로 표시 */
const LEGACY_LOGIN_BANNER_ROW_ID = '__legacy_config_loginBanner__';

let currentEditingLoginBannerId = null;
let currentSelectedLoginBannerId = null;

function loginBannerStatusRow(today, start, end) {
    if (!start || !end) return { text: '기간 미설정', cls: 'text-amber-600' };
    if (today < start) return { text: '예정', cls: 'text-blue-600' };
    if (today > end) return { text: '종료', cls: 'text-slate-500' };
    return { text: '게시 중', cls: 'text-emerald-600 font-bold' };
}

/** `main.js` resolveLegacyLoginBanner 와 동일 조건 — 활성·표시 가능한 구버전만 */
function parseLegacyLoginBannerForAdmin(data) {
    if (!data || !data.enabled) return null;
    let imageUrl = '';
    let landingNoticeId = '';
    let landingNoticeTitle = '';
    if (Array.isArray(data.slides) && data.slides.length > 0) {
        const s = data.slides[0];
        if (s && typeof s === 'object') {
            imageUrl = (s.imageUrl && String(s.imageUrl).trim()) || '';
            landingNoticeId = (s.landingNoticeId && String(s.landingNoticeId).trim()) || '';
            landingNoticeTitle = (s.landingNoticeTitle && String(s.landingNoticeTitle).trim()) || '';
        }
    }
    if (!imageUrl) imageUrl = (data.imageUrl && String(data.imageUrl).trim()) || '';
    if (!landingNoticeId) landingNoticeId = (data.landingNoticeId && String(data.landingNoticeId).trim()) || '';
    if (!landingNoticeTitle) landingNoticeTitle = (data.landingNoticeTitle && String(data.landingNoticeTitle).trim()) || '';
    if (!imageUrl && !landingNoticeId) return null;
    const titleRaw = (data.title && String(data.title).trim()) || '';
    return {
        title: titleRaw || '구버전 단일 배너 (config/loginBanner)',
        targetEnv: (data.targetEnv === 'production' || data.targetEnv === 'staging') ? data.targetEnv : 'all',
        startDate: data.startDate || '',
        endDate: data.endDate || '',
        imageUrl,
        landingNoticeId,
        landingNoticeTitle: landingNoticeTitle || '',
        viewCount: Number(data.viewCount) || 0,
        clickCount: Number(data.clickCount) || 0
    };
}

function legacyLoginBannerStatusRow(today, legacy) {
    const start = legacy.startDate || '';
    const end = legacy.endDate || '';
    if (start && end) return loginBannerStatusRow(today, start, end);
    return { text: '게시 중 (구버전)', cls: 'text-amber-700 font-bold' };
}

function rowMillis(docSnap) {
    const d = docSnap.data();
    const t = d.timestamp;
    const u = d.updatedAt;
    const tm = typeof t?.toMillis === 'function' ? t.toMillis() : 0;
    const um = typeof u?.toMillis === 'function' ? u.toMillis() : 0;
    return Math.max(tm, um);
}

function revokeLoginBannerWritePreview() {
    if (window.loginBannerWriteObjectUrl) {
        try { URL.revokeObjectURL(window.loginBannerWriteObjectUrl); } catch (_) {}
        window.loginBannerWriteObjectUrl = null;
    }
}

function paintLoginBannerWriteImagePreview(url) {
    const wrap = document.getElementById('loginBannerWriteImagePreview');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!url) return;
    const img = document.createElement('img');
    img.src = url;
    img.alt = '미리보기';
    img.className = 'max-w-full h-auto rounded-xl border border-slate-200 max-h-32 object-contain';
    wrap.appendChild(img);
}

function bindLoginBannerWriteFormOnce() {
    if (window.__loginBannerWriteFormBound) return;
    window.__loginBannerWriteFormBound = true;
    const pick = document.getElementById('loginBannerWritePickImageBtn');
    const input = document.getElementById('loginBannerWriteImage');
    const removeBtn = document.getElementById('loginBannerWriteRemoveImageBtn');
    const landBtn = document.getElementById('loginBannerWriteLandingNoticeBtn');
    const landClear = document.getElementById('loginBannerWriteLandingClearBtn');
    if (pick && input) {
        pick.addEventListener('click', () => input.click());
    }
    if (input) {
        input.addEventListener('change', (e) => {
            const file = (e.target.files && e.target.files[0]) ? e.target.files[0] : null;
            window.loginBannerWriteFile = file && file.type.startsWith('image/') ? file : null;
            window.loginBannerWriteRemoveImage = false;
            revokeLoginBannerWritePreview();
            if (window.loginBannerWriteFile) {
                window.loginBannerWriteObjectUrl = URL.createObjectURL(window.loginBannerWriteFile);
                paintLoginBannerWriteImagePreview(window.loginBannerWriteObjectUrl);
            } else {
                paintLoginBannerWriteImagePreview(window.loginBannerWriteExistingUrl || '');
            }
            e.target.value = '';
        });
    }
    if (removeBtn) {
        removeBtn.addEventListener('click', () => {
            window.loginBannerWriteFile = null;
            window.loginBannerWriteRemoveImage = true;
            window.loginBannerWriteExistingUrl = '';
            revokeLoginBannerWritePreview();
            paintLoginBannerWriteImagePreview('');
            if (input) input.value = '';
        });
    }
    if (landBtn) landBtn.addEventListener('click', () => window.openLoginBannerLandingNoticeSelect());
    if (landClear) {
        landClear.addEventListener('click', () => {
            const landingIdEl = document.getElementById('loginBannerWriteLandingNoticeId');
            const landingLabelEl = document.getElementById('loginBannerWriteLandingLabel');
            const landingSelectedWrap = document.getElementById('loginBannerWriteLandingSelectedWrap');
            const landingSelectedTitle = document.getElementById('loginBannerWriteLandingSelectedTitle');
            if (landingIdEl) landingIdEl.value = '';
            if (landingLabelEl) landingLabelEl.textContent = '공지 선택하기';
            if (landingSelectedWrap) landingSelectedWrap.classList.add('hidden');
            if (landingSelectedTitle) landingSelectedTitle.textContent = '';
            window.loginBannerWriteLandingNoticeTitle = '';
        });
    }
}

export async function renderLoginBanners() {
    const tbody = document.getElementById('loginBannerTableBody');
    if (!tbody) return;
    const today = new Date().toISOString().slice(0, 10);
    try {
        const coll = collection(db, 'artifacts', appId, 'loginBanners');
        let docs = [];
        try {
            const snap = await getDocs(query(coll, orderBy('timestamp', 'desc')));
            docs = snap.docs;
        } catch (qErr) {
            console.warn('로그인 배너 orderBy 조회 실패, 전체 후 정렬:', qErr);
            const snap = await getDocs(coll);
            docs = snap.docs.slice().sort((a, b) => rowMillis(b) - rowMillis(a));
        }

        const legacySnap = await getDoc(doc(db, 'artifacts', appId, 'config', 'loginBanner'));
        const legacyParsed = legacySnap.exists() ? parseLegacyLoginBannerForAdmin(legacySnap.data()) : null;

        const rows = docs.map((d) => {
            const b = d.data();
            const id = d.id;
            const title = escapeHtml((b.title || '제목 없음').trim());
            const start = b.startDate || '';
            const end = b.endDate || '';
            const period = (start && end) ? `${escapeHtml(start)} ~ ${escapeHtml(end)}` : '-';
            const envLabel = escapeHtml(TARGET_ENV_LABELS[b.targetEnv] || TARGET_ENV_LABELS.all);
            const st = loginBannerStatusRow(today, start, end);
            const views = Number(b.viewCount) || 0;
            const clicks = Number(b.clickCount) || 0;
            return `<tr data-banner-id="${escapeHtml(id)}" class="login-banner-table-row border-b border-slate-100 last:border-b-0 cursor-pointer hover:bg-slate-50 transition-colors">
                <td class="px-3 py-3 font-bold text-slate-800 max-w-[200px]"><span class="line-clamp-2">${title}</span></td>
                <td class="px-3 py-3 text-slate-600 whitespace-nowrap text-xs">${period}</td>
                <td class="px-3 py-3 text-slate-600 whitespace-nowrap text-xs">${envLabel}</td>
                <td class="px-3 py-3 whitespace-nowrap"><span class="text-xs ${st.cls}">${escapeHtml(st.text)}</span></td>
                <td class="px-3 py-3 text-right font-bold text-slate-700">${views.toLocaleString()}</td>
                <td class="px-3 py-3 text-right font-bold text-slate-700">${clicks.toLocaleString()}</td>
            </tr>`;
        });

        if (legacyParsed) {
            const st = legacyLoginBannerStatusRow(today, legacyParsed);
            const period = (legacyParsed.startDate && legacyParsed.endDate)
                ? `${escapeHtml(legacyParsed.startDate)} ~ ${escapeHtml(legacyParsed.endDate)}`
                : '-';
            const envLabel = escapeHtml(TARGET_ENV_LABELS[legacyParsed.targetEnv] || TARGET_ENV_LABELS.all);
            const title = escapeHtml(legacyParsed.title);
            const legacyId = escapeHtml(LEGACY_LOGIN_BANNER_ROW_ID);
            rows.push(`<tr data-banner-id="${legacyId}" class="login-banner-table-row border-b border-slate-100 last:border-b-0 cursor-pointer hover:bg-amber-50/80 transition-colors">
                <td class="px-3 py-3 font-bold text-slate-800 max-w-[200px]">
                    <span class="line-clamp-2">${title}</span>
                    <span class="block text-[10px] font-bold text-amber-800 mt-0.5">config/loginBanner · 구버전 폴백</span>
                </td>
                <td class="px-3 py-3 text-slate-600 whitespace-nowrap text-xs">${period}</td>
                <td class="px-3 py-3 text-slate-600 whitespace-nowrap text-xs">${envLabel}</td>
                <td class="px-3 py-3 whitespace-nowrap"><span class="text-xs ${st.cls}">${escapeHtml(st.text)}</span></td>
                <td class="px-3 py-3 text-right font-bold text-slate-700">${legacyParsed.viewCount.toLocaleString()}</td>
                <td class="px-3 py-3 text-right font-bold text-slate-700">${legacyParsed.clickCount.toLocaleString()}</td>
            </tr>`);
        }

        if (rows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="px-3 py-8 text-center text-slate-400">등록된 캠페인이 없습니다.</td></tr>';
            return;
        }
        tbody.innerHTML = rows.join('');
        tbody.querySelectorAll('.login-banner-table-row').forEach((row) => {
            row.addEventListener('click', () => {
                const bid = row.getAttribute('data-banner-id');
                if (bid) window.selectAdminLoginBanner(bid);
            });
        });
    } catch (e) {
        console.error('로그인 배너 목록 로드 실패:', e);
        tbody.innerHTML = '<tr><td colspan="6" class="px-3 py-8 text-center text-red-400">목록을 불러오지 못했습니다.</td></tr>';
    }
}

async function renderLegacyLoginBannerDetail() {
    const container = document.getElementById('loginBannerDetailContainer');
    if (!container) return;
    container.innerHTML = '<p class="text-slate-500">로딩 중...</p>';
    const today = new Date().toISOString().slice(0, 10);
    try {
        const snap = await getDoc(doc(db, 'artifacts', appId, 'config', 'loginBanner'));
        if (!snap.exists()) {
            container.innerHTML = '<p class="text-red-400">배너를 찾을 수 없습니다.</p>';
            return;
        }
        const parsed = parseLegacyLoginBannerForAdmin(snap.data());
        if (!parsed) {
            container.innerHTML = '<p class="text-red-400">구버전 배너가 비활성이거나 표시할 내용이 없습니다. Firestore 문서 <span class="font-mono text-sm">artifacts/…/config/loginBanner</span>의 enabled·이미지·슬라이드를 확인해주세요.</p>';
            return;
        }
        const st = legacyLoginBannerStatusRow(today, parsed);
        const envLabel = TARGET_ENV_LABELS[parsed.targetEnv] || TARGET_ENV_LABELS.all;
        const start = parsed.startDate || '';
        const end = parsed.endDate || '';
        const landingHtml = parsed.landingNoticeId
            ? `<p class="text-sm text-slate-600 mt-0.5"><span class="font-bold">연결 공지:</span> ${escapeHtml(parsed.landingNoticeTitle || '(공지)')}</p>`
            : '<p class="text-sm text-slate-500 mt-0.5">공지 미연결</p>';
        const img = parsed.imageUrl ? escapeHtml(parsed.imageUrl) : '';
        const legacyIdJs = escapeHtml(LEGACY_LOGIN_BANNER_ROW_ID);
        container.innerHTML = `
            <div class="mb-4">
                <h2 class="text-lg font-bold text-slate-800 mb-1">구버전 로그인 배너</h2>
                <p class="text-xs text-amber-800 font-bold mb-3">Firestore 단일 문서 · 로그인 앱은 캠페인(<span class="font-mono">loginBanners</span>)이 없을 때만 이 설정을 씁니다.</p>
                <div class="bg-white rounded-xl p-3 mb-4 text-sm border border-slate-200">
                    <p class="font-bold text-slate-700 mb-1.5">통계 (이 문서)</p>
                    <p class="text-slate-600">조회 <span class="font-bold text-slate-800">${parsed.viewCount.toLocaleString()}</span> · 클릭 <span class="font-bold text-slate-800">${parsed.clickCount.toLocaleString()}</span></p>
                    <p class="font-bold text-slate-700 mb-1.5 mt-3">게시 설정</p>
                    <p class="text-slate-600"><span class="font-bold">표시 환경:</span> ${escapeHtml(envLabel)}</p>
                    <p class="text-slate-600 mt-0.5"><span class="font-bold">게시 기간:</span> ${escapeHtml(start || '-')} ~ ${escapeHtml(end || '-')}</p>
                    <p class="text-slate-600 mt-0.5"><span class="font-bold">상태:</span> <span class="${st.cls}">${escapeHtml(st.text)}</span></p>
                    <p class="font-bold text-slate-700 mt-3 mb-0.5">랜딩</p>
                    ${landingHtml}
                </div>
            </div>
            ${img ? `<div class="mb-4"><img src="${img}" alt="" class="max-w-full h-auto rounded-xl border border-slate-200 object-contain max-h-[40vh]"></div>` : '<p class="text-sm text-slate-500 mb-4">등록된 이미지 URL 없음 (공지 랜딩만 가능)</p>'}
            <div class="flex flex-col gap-2 pt-2 border-t border-slate-200">
                <button type="button" onclick="window.endLegacyLoginBanner()" class="px-4 py-2 bg-red-50 text-red-600 rounded-lg text-sm font-bold hover:bg-red-100 border border-red-200">게시 종료</button>
                <button type="button" onclick="window.openLoginBannerWriteModal('${legacyIdJs}')" class="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-bold hover:bg-emerald-700">신규 캠페인으로 복사·등록</button>
                <p class="text-xs text-slate-500">게시 종료 시 <span class="font-bold">enabled</span>가 꺼지며 로그인 화면에 더 이상 표시되지 않습니다. 신규 캠페인(<span class="font-mono">loginBanners</span>)이 있으면 기간·환경에 맞는 캠페인이 우선합니다.</p>
            </div>
        `;
    } catch (e) {
        console.error('구버전 로그인 배너 상세 로드 실패:', e);
        container.innerHTML = '<p class="text-red-400">불러오는 중 오류가 발생했습니다.</p>';
    }
}

async function renderLoginBannerDetail(bannerId) {
    const container = document.getElementById('loginBannerDetailContainer');
    if (!container) return;
    if (bannerId === LEGACY_LOGIN_BANNER_ROW_ID) {
        await renderLegacyLoginBannerDetail();
        return;
    }
    container.innerHTML = '<p class="text-slate-500">로딩 중...</p>';
    const today = new Date().toISOString().slice(0, 10);
    try {
        const snap = await getDoc(doc(db, 'artifacts', appId, 'loginBanners', bannerId));
        if (!snap.exists()) {
            container.innerHTML = '<p class="text-red-400">배너를 찾을 수 없습니다.</p>';
            return;
        }
        const b = snap.data();
        const start = b.startDate || '';
        const end = b.endDate || '';
        const st = loginBannerStatusRow(today, start, end);
        const envLabel = TARGET_ENV_LABELS[b.targetEnv] || TARGET_ENV_LABELS.all;
        const viewCount = Number(b.viewCount) || 0;
        const clickCount = Number(b.clickCount) || 0;
        const img = (b.imageUrl && String(b.imageUrl).trim()) ? String(b.imageUrl).trim() : '';
        const landingHtml = b.landingNoticeId
            ? `<p class="text-sm text-slate-600 mt-0.5"><span class="font-bold">연결 공지:</span> ${escapeHtml(b.landingNoticeTitle || '(공지)')}</p>`
            : '<p class="text-sm text-slate-500 mt-0.5">공지 미연결</p>';
        const safeId = escapeHtml(bannerId);
        container.innerHTML = `
            <div class="mb-4">
                <h2 class="text-lg font-bold text-slate-800 mb-3">${escapeHtml(b.title || '제목 없음')}</h2>
                <div class="bg-white rounded-xl p-3 mb-4 text-sm border border-slate-200">
                    <p class="font-bold text-slate-700 mb-1.5">통계 (이 캠페인)</p>
                    <p class="text-slate-600">조회 <span class="font-bold text-slate-800">${viewCount.toLocaleString()}</span> · 클릭 <span class="font-bold text-slate-800">${clickCount.toLocaleString()}</span></p>
                    <p class="font-bold text-slate-700 mb-1.5 mt-3">게시 설정</p>
                    <p class="text-slate-600"><span class="font-bold">표시 환경:</span> ${escapeHtml(envLabel)}</p>
                    <p class="text-slate-600 mt-0.5"><span class="font-bold">게시 기간:</span> ${escapeHtml(start || '-')} ~ ${escapeHtml(end || '-')}</p>
                    <p class="text-slate-600 mt-0.5"><span class="font-bold">상태:</span> <span class="${st.cls}">${escapeHtml(st.text)}</span></p>
                    <p class="font-bold text-slate-700 mt-3 mb-0.5">랜딩</p>
                    ${landingHtml}
                </div>
            </div>
            ${img ? `<div class="mb-4"><img src="${escapeHtml(img)}" alt="" class="max-w-full h-auto rounded-xl border border-slate-200 object-contain max-h-[40vh]"></div>` : '<p class="text-sm text-slate-500 mb-4">등록된 이미지 없음</p>'}
            <div class="flex gap-2 pt-2 border-t border-slate-200">
                <button type="button" onclick="window.openLoginBannerWriteModal('${safeId}')" class="px-4 py-2 bg-blue-50 text-blue-600 rounded-lg text-sm font-bold hover:bg-blue-100">수정</button>
                <button type="button" onclick="window.deleteLoginBanner('${safeId}')" class="px-4 py-2 bg-red-50 text-red-600 rounded-lg text-sm font-bold hover:bg-red-100">삭제</button>
            </div>
        `;
    } catch (e) {
        console.error('로그인 배너 상세 로드 실패:', e);
        container.innerHTML = '<p class="text-red-400">불러오는 중 오류가 발생했습니다.</p>';
    }
}

window.backToLoginBannerList = function () {
    currentSelectedLoginBannerId = null;
    currentEditingLoginBannerId = null;
    document.getElementById('loginBannerListPage')?.classList.remove('hidden');
    document.getElementById('loginBannerDetailPage')?.classList.add('hidden');
    document.getElementById('loginBannerWritePage')?.classList.add('hidden');
    renderLoginBanners();
};

window.backToLoginBannerListFromWrite = function () {
    currentEditingLoginBannerId = null;
    revokeLoginBannerWritePreview();
    window.loginBannerWriteFile = null;
    document.getElementById('loginBannerListPage')?.classList.remove('hidden');
    document.getElementById('loginBannerWritePage')?.classList.add('hidden');
    renderLoginBanners();
};

window.selectAdminLoginBanner = async function (bannerId) {
    currentSelectedLoginBannerId = bannerId;
    document.getElementById('loginBannerListPage')?.classList.add('hidden');
    document.getElementById('loginBannerWritePage')?.classList.add('hidden');
    document.getElementById('loginBannerDetailPage')?.classList.remove('hidden');
    currentEditingLoginBannerId = null;
    await renderLoginBannerDetail(bannerId);
};

window.openLoginBannerWriteModal = async function (bannerId = null) {
    bindLoginBannerWriteFormOnce();
    const isLegacyPrefill = bannerId === LEGACY_LOGIN_BANNER_ROW_ID;
    currentEditingLoginBannerId = isLegacyPrefill ? null : (bannerId || null);
    revokeLoginBannerWritePreview();
    window.loginBannerWriteFile = null;
    window.loginBannerWriteRemoveImage = false;
    window.loginBannerWriteExistingUrl = '';
    const listPage = document.getElementById('loginBannerListPage');
    const detailPage = document.getElementById('loginBannerDetailPage');
    const writePage = document.getElementById('loginBannerWritePage');
    const titleEl = document.getElementById('loginBannerWritePageTitle');
    const submitBtn = document.getElementById('loginBannerSubmitBtn');
    const titleInput = document.getElementById('loginBannerWriteTitle');
    const startDateInput = document.getElementById('loginBannerStartDate');
    const endDateInput = document.getElementById('loginBannerEndDate');
    const targetEnvEl = document.getElementById('loginBannerWriteTargetEnv');
    const imgInput = document.getElementById('loginBannerWriteImage');
    const landingIdEl = document.getElementById('loginBannerWriteLandingNoticeId');
    const landingLabelEl = document.getElementById('loginBannerWriteLandingLabel');
    const landingSelectedWrap = document.getElementById('loginBannerWriteLandingSelectedWrap');
    const landingSelectedTitle = document.getElementById('loginBannerWriteLandingSelectedTitle');
    if (!writePage) return;
    if (listPage) listPage.classList.add('hidden');
    if (detailPage) detailPage.classList.add('hidden');
    writePage.classList.remove('hidden');
    const today = new Date().toISOString().slice(0, 10);
    if (titleInput) titleInput.value = '';
    if (startDateInput) startDateInput.value = today;
    if (endDateInput) endDateInput.value = today;
    if (targetEnvEl) targetEnvEl.value = 'all';
    if (imgInput) imgInput.value = '';
    if (landingIdEl) landingIdEl.value = '';
    if (landingLabelEl) landingLabelEl.textContent = '공지 선택하기';
    if (landingSelectedWrap) landingSelectedWrap.classList.add('hidden');
    if (landingSelectedTitle) landingSelectedTitle.textContent = '';
    window.loginBannerWriteLandingNoticeTitle = '';
    paintLoginBannerWriteImagePreview('');

    if (bannerId && !isLegacyPrefill) {
        if (titleEl) titleEl.textContent = '배너 수정';
        if (submitBtn) submitBtn.textContent = '수정';
        try {
            const snap = await getDoc(doc(db, 'artifacts', appId, 'loginBanners', bannerId));
            if (snap.exists()) {
                const d = snap.data();
                if (titleInput) titleInput.value = d.title || '';
                if (startDateInput) startDateInput.value = d.startDate || today;
                if (endDateInput) endDateInput.value = d.endDate || today;
                if (targetEnvEl) targetEnvEl.value = (d.targetEnv === 'production' || d.targetEnv === 'staging') ? d.targetEnv : 'all';
                const url = (d.imageUrl && String(d.imageUrl).trim()) || '';
                window.loginBannerWriteExistingUrl = url;
                paintLoginBannerWriteImagePreview(url);
                if (d.landingNoticeId) {
                    window.loginBannerWriteLandingNoticeTitle = d.landingNoticeTitle || '';
                    if (landingIdEl) landingIdEl.value = d.landingNoticeId;
                    if (landingLabelEl) landingLabelEl.textContent = '공지 변경하기';
                    if (landingSelectedWrap) landingSelectedWrap.classList.remove('hidden');
                    if (landingSelectedTitle) landingSelectedTitle.textContent = d.landingNoticeTitle || '(공지)';
                }
            }
        } catch (e) {
            console.error(e);
            alert('배너를 불러오지 못했습니다.');
        }
    } else if (isLegacyPrefill) {
        if (titleEl) titleEl.textContent = '배너 등록 (구버전에서 복사)';
        if (submitBtn) submitBtn.textContent = '등록';
        try {
            const cfgSnap = await getDoc(doc(db, 'artifacts', appId, 'config', 'loginBanner'));
            const parsed = parseLegacyLoginBannerForAdmin(cfgSnap.data());
            if (!parsed) {
                alert('구버전 배너 설정을 불러올 수 없습니다.');
                window.backToLoginBannerListFromWrite();
                return;
            }
            if (titleInput) titleInput.value = parsed.title;
            if (startDateInput) startDateInput.value = parsed.startDate || today;
            if (endDateInput) endDateInput.value = parsed.endDate || today;
            if (targetEnvEl) targetEnvEl.value = parsed.targetEnv;
            window.loginBannerWriteExistingUrl = parsed.imageUrl;
            paintLoginBannerWriteImagePreview(parsed.imageUrl);
            if (parsed.landingNoticeId) {
                window.loginBannerWriteLandingNoticeTitle = parsed.landingNoticeTitle || '';
                if (landingIdEl) landingIdEl.value = parsed.landingNoticeId;
                if (landingLabelEl) landingLabelEl.textContent = '공지 변경하기';
                if (landingSelectedWrap) landingSelectedWrap.classList.remove('hidden');
                if (landingSelectedTitle) landingSelectedTitle.textContent = parsed.landingNoticeTitle || '(공지)';
            }
        } catch (e) {
            console.error(e);
            alert('구버전 배너를 불러오지 못했습니다.');
        }
    } else {
        if (titleEl) titleEl.textContent = '배너 등록';
        if (submitBtn) submitBtn.textContent = '등록';
    }
};

window.submitLoginBanner = async function () {
    const isEdit = !!currentEditingLoginBannerId;
    const titleInput = document.getElementById('loginBannerWriteTitle');
    const startDateInput = document.getElementById('loginBannerStartDate');
    const endDateInput = document.getElementById('loginBannerEndDate');
    const targetEnvEl = document.getElementById('loginBannerWriteTargetEnv');
    const landingIdEl = document.getElementById('loginBannerWriteLandingNoticeId');
    const submitBtn = document.getElementById('loginBannerSubmitBtn');
    if (!titleInput) return;
    const title = titleInput.value.trim();
    const startDate = startDateInput ? startDateInput.value : '';
    const endDate = endDateInput ? endDateInput.value : '';
    const targetEnv = (targetEnvEl && (targetEnvEl.value === 'production' || targetEnvEl.value === 'staging')) ? targetEnvEl.value : 'all';
    const landingNoticeId = (landingIdEl && landingIdEl.value) ? landingIdEl.value.trim() : '';
    const landingNoticeTitle = window.loginBannerWriteLandingNoticeTitle || '';
    if (!title) {
        alert('관리용 제목을 입력해주세요.');
        return;
    }
    if (!startDate || !endDate) {
        alert('게시 시작일·종료일을 입력해주세요.');
        return;
    }
    if (new Date(startDate) > new Date(endDate)) {
        alert('시작일이 종료일보다 늦을 수 없습니다.');
        return;
    }
    let imageUrl = window.loginBannerWriteRemoveImage ? '' : (window.loginBannerWriteExistingUrl || '');
    if (window.loginBannerWriteFile) {
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = '업로드 중...';
        }
        try {
            imageUrl = await uploadLoginBannerImage(window.loginBannerWriteFile, appId);
            window.loginBannerWriteExistingUrl = imageUrl;
            window.loginBannerWriteFile = null;
        } catch (e) {
            console.error(e);
            alert('이미지 업로드에 실패했습니다.');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = isEdit ? '수정' : '등록';
            }
            return;
        }
    }
    if (!imageUrl || !String(imageUrl).trim()) {
        alert('배너 이미지를 등록해주세요.');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = isEdit ? '수정' : '등록';
        }
        return;
    }
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = isEdit ? '저장 중...' : '등록 중...';
    }
    try {
        if (currentEditingLoginBannerId) {
            const base = {
                title,
                startDate,
                endDate,
                targetEnv: targetEnv || 'all',
                imageUrl: String(imageUrl).trim(),
                updatedAt: serverTimestamp()
            };
            if (landingNoticeId) {
                base.landingNoticeId = landingNoticeId;
                base.landingNoticeTitle = landingNoticeTitle || '';
            } else {
                base.landingNoticeId = deleteField();
                base.landingNoticeTitle = deleteField();
            }
            await updateDoc(doc(db, 'artifacts', appId, 'loginBanners', currentEditingLoginBannerId), base);
            alert('저장되었습니다.');
        } else {
            const createPayload = {
                title,
                startDate,
                endDate,
                targetEnv: targetEnv || 'all',
                imageUrl: String(imageUrl).trim(),
                viewCount: 0,
                clickCount: 0,
                timestamp: serverTimestamp(),
                updatedAt: serverTimestamp()
            };
            if (landingNoticeId) {
                createPayload.landingNoticeId = landingNoticeId;
                createPayload.landingNoticeTitle = landingNoticeTitle || '';
            }
            await addDoc(collection(db, 'artifacts', appId, 'loginBanners'), createPayload);
            alert('등록되었습니다.');
        }
        window.backToLoginBannerListFromWrite();
    } catch (e) {
        console.error('로그인 배너 저장 실패:', e);
        alert('저장에 실패했습니다: ' + (e.message || e));
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = isEdit ? '수정' : '등록';
        }
    }
};

window.endLegacyLoginBanner = async function () {
    if (!confirm('구버전 로그인 배너 게시를 종료할까요?\n\n로그인 화면에 더 이상 표시되지 않습니다. (통계·설정 내용은 Firestore에 유지됩니다)')) return;
    try {
        await updateDoc(doc(db, 'artifacts', appId, 'config', 'loginBanner'), {
            enabled: false,
            updatedAt: serverTimestamp()
        });
        alert('게시가 종료되었습니다.');
        window.backToLoginBannerList();
    } catch (e) {
        console.error('구버전 로그인 배너 게시 종료 실패:', e);
        alert('게시 종료에 실패했습니다: ' + (e.message || e));
    }
};

window.deleteLoginBanner = async function (bannerId) {
    if (!confirm('이 배너를 삭제하시겠습니까?')) return;
    try {
        await deleteDoc(doc(db, 'artifacts', appId, 'loginBanners', bannerId));
        alert('삭제되었습니다.');
        window.backToLoginBannerList();
    } catch (e) {
        console.error(e);
        alert('삭제에 실패했습니다: ' + (e.message || e));
    }
};

window.refreshLoginBannerStats = async function () {
    await runAdminRefreshAction(
        document.getElementById('loginBannerRefreshStatsBtn'),
        async () => {
            await renderLoginBanners();
            if (currentSelectedLoginBannerId) {
                await renderLoginBannerDetail(currentSelectedLoginBannerId);
            }
        },
        { loadingText: '재조회 중', tightSpinner: true }
    );
};

window.openLoginBannerLandingNoticeSelect = async function () {
    const modal = document.getElementById('loginBannerLandingNoticeModal');
    const listEl = document.getElementById('loginBannerLandingNoticeList');
    if (!modal || !listEl) return;
    listEl.innerHTML = '<div class="text-center py-8 text-slate-400"><i data-lucide="loader-circle" class="text-xl mb-2 lucide-spin"></i><p class="text-sm">로딩 중...</p></div>';
    modal.classList.remove('hidden');
    try {
        const noticesColl = collection(db, 'artifacts', appId, 'notices');
        const snap = await getDocs(query(noticesColl, orderBy('timestamp', 'desc')));
        if (snap.empty) {
            listEl.innerHTML = '<div class="text-center py-8 text-slate-400"><p class="text-sm">등록된 공지가 없습니다.</p></div>';
            return;
        }
        listEl.innerHTML = snap.docs.map(d => {
            const n = d.data();
            const id = d.id;
            const title = (n.title || '제목 없음').trim();
            return `<button type="button" data-notice-id="${escapeHtml(id)}" data-notice-title="${escapeHtml(title)}" class="login-banner-landing-notice-btn w-full text-left px-4 py-3 rounded-xl border border-slate-200 hover:bg-slate-50 hover:border-emerald-300 transition-colors">
                <span class="font-bold text-slate-800">${escapeHtml(title)}</span>
            </button>`;
        }).join('');
        listEl.querySelectorAll('.login-banner-landing-notice-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const noticeId = btn.getAttribute('data-notice-id');
                const noticeTitle = btn.getAttribute('data-notice-title') || '(공지)';
                window.loginBannerWriteLandingNoticeTitle = noticeTitle;
                const landingIdEl = document.getElementById('loginBannerWriteLandingNoticeId');
                const landingLabelEl = document.getElementById('loginBannerWriteLandingLabel');
                const landingSelectedWrap = document.getElementById('loginBannerWriteLandingSelectedWrap');
                const landingSelectedTitle = document.getElementById('loginBannerWriteLandingSelectedTitle');
                if (landingIdEl) landingIdEl.value = noticeId;
                if (landingLabelEl) landingLabelEl.textContent = '공지 변경하기';
                if (landingSelectedWrap) landingSelectedWrap.classList.remove('hidden');
                if (landingSelectedTitle) landingSelectedTitle.textContent = noticeTitle;
                window.closeLoginBannerLandingNoticeSelect();
            });
        });
    } catch (e) {
        console.error('공지 목록 로드 실패:', e);
        listEl.innerHTML = '<div class="text-center py-8 text-red-400"><p class="text-sm">공지 목록을 불러오는 중 오류가 발생했습니다.</p></div>';
    }
};

window.closeLoginBannerLandingNoticeSelect = function () {
    const modal = document.getElementById('loginBannerLandingNoticeModal');
    if (modal) modal.classList.add('hidden');
};

export async function loadLoginBannerConfig() {
    bindLoginBannerWriteFormOnce();
    window.backToLoginBannerList();
}
