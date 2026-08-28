/**
 * 관리자 > 모니터링 > 로컬 미러 — 상태 확인·재구축·백업 (4단계)
 *
 * 미러는 「원본이 아니라 사본」이다. 그래서 이 화면이 하는 일은 세 가지뿐이다.
 *
 *  1. 지금 무엇을 얼마나 들고 있는지 보여 준다 (마지막 동기화·보유 건수)
 *  2. 여기서 직접 채운다 — 미러는 원래 **소비자 화면을 열 때** 만들어지는데,
 *     새 기기에서 여섯 화면을 순례하게 하는 대신 이 자리에서 한 번에 받는다
 *  3. 의심스러우면 통째로 다시 받게 한다 (전체 재구축)
 *  4. 파일로 내보내고 되불러온다 — 다른 기기에서 부트스트랩을 되풀이하지 않으려고
 *
 * **백업 파일을 git 에 올리지 말 것.** 사용자 기록·프로필이 통째로 들었다.
 * 저장소에 한 번 들어가면 히스토리에서 지우기 어렵고, 공개 저장소면 그대로 유출이다.
 * 기기 사이에 옮길 때는 이 파일을 직접 건네는 방식만 쓴다. — docs/admin-local-mirror.md
 */
import { escapeHtml } from './utils.js';
import { getMealsMirrorStatus, resetMealsMirror, ensureMealsMirrorSynced } from './meals-mirror.js';
import { getUsersMirrorStatus, resetUsersMirror, ensureUsersMirrorSynced } from './users-mirror.js';
import { ALL_COLLECTION_MIRRORS } from './collection-mirror.js';
import { openMirrorDb, idbRequest, readMeta, writeMeta } from './admin-mirror-db.js';
import { refreshLucideIcons } from '../icons.js';

/** 백업 파일 형식 버전 — 구조가 바뀌면 올린다 */
const BACKUP_FORMAT = 2;

function fmtStamp(iso) {
    if (!iso) return '없음';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '알 수 없음';
    return d.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * 상태 뱃지 — 미러의 재구축 정책에 따라 다르게 읽어야 한다.
 *
 * - 정기 재구축이 있는 미러(users·sharedPhotos·feedPosts·boardPosts): 7일이 지나면
 *   다음 동기화가 전체를 다시 받는다 — 그 예고를 보여 준다.
 * - 없는 미러(usageDaily·aiDietReports): 축이 완전하거나 append-only 라 재구축이
 *   잡을 것이 없다. 오래됐다고 나쁜 상태가 아니므로 「7일 전」 경고를 띄우지 않는다.
 * - meals: 재구축 대신 드리프트 감지가 있다 — 걸리면 붉은 뱃지로 알린다.
 */
function ageBadge(r) {
    const iso = r.lastSyncedAt;
    if (!iso) return '<span class="px-2 py-0.5 rounded bg-slate-100 text-slate-500 text-[11px] font-bold">미구축</span>';
    if (r.drift === true) {
        return '<span class="px-2 py-0.5 rounded bg-red-50 text-red-700 text-[11px] font-bold" title="미러가 서버보다 많은 문서를 들고 있습니다 — 서버에서 지워진 문서가 미러에 남아 있다는 신호입니다. 「재구축 예약」으로 정리하세요.">정합성 의심 · 재구축 권장</span>';
    }
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms)) return '';
    const days = Math.floor(ms / 86400000);
    if (r.periodicRebuild !== false && days >= 7) {
        return `<span class="px-2 py-0.5 rounded bg-amber-50 text-amber-700 text-[11px] font-bold">${days}일 전 · 다음 동기화 때 전체 재구축</span>`;
    }
    return '<span class="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[11px] font-bold">최신</span>';
}

/** 정책 설명 — 「왜 이 미러는 정기 재구축이 없나」를 표에서 바로 읽게 */
function policyLabel(r) {
    if (r.key === 'meals') {
        return '<span class="text-[11px] text-slate-400" title="재구축이 비싸(1.2만 읽기) 대신 동기화마다 서버 문서 수와 대조합니다. 어긋나면 위 상태에 「정합성 의심」이 뜹니다.">드리프트 감지</span>';
    }
    if (r.periodicRebuild === false) {
        return '<span class="text-[11px] text-slate-400" title="모든 변경이 델타에 걸리거나(서버 시각 도장) 쓰기 자체가 막혀 있어, 재구축이 잡을 것이 없습니다.">재구축 불필요</span>';
    }
    return '<span class="text-[11px] text-slate-400" title="생성 시각 축이라 남이 고친 값(좋아요·댓글 수 등)이 델타에 안 걸립니다. 7일마다 전체를 다시 받아 정리합니다. users 는 설정 저장이 도장을 찍지 않아 같은 처방이 필요합니다.">7일 재구축</span>';
}

/** 모든 미러의 현재 상태 */
async function collectStatuses() {
    const [meals, users] = await Promise.all([getMealsMirrorStatus(), getUsersMirrorStatus()]);
    const collections = await Promise.all(ALL_COLLECTION_MIRRORS.map((m) => m.getStatus()));
    return [
        { key: 'meals', label: '식사 기록 (meals)', ...meals },
        { key: 'users', label: '사용자 (users)', ...users },
        ...collections.map((s) => ({ key: s.name, label: s.name, ...s }))
    ];
}

/** IndexedDB 가 실제로 얼마나 쓰고 있는지 — 브라우저가 알려 주면 */
async function storageEstimate() {
    try {
        if (!navigator?.storage?.estimate) return null;
        const est = await navigator.storage.estimate();
        const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : null;
        return { usage: est.usage || 0, quota: est.quota || 0, persisted };
    } catch {
        return null;
    }
}

const fmtBytes = (n) => {
    if (!Number.isFinite(n) || n <= 0) return '—';
    const mb = n / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
};

export async function renderMirrorConsole() {
    const mount = document.getElementById('mirrorConsoleContainer');
    if (!mount) return;
    mount.innerHTML =
        '<div class="text-center py-8 text-slate-400"><i data-lucide="loader-circle" class="text-2xl mb-2 lucide-spin"></i><p class="text-sm">미러 상태를 읽는 중…</p></div>';
    refreshLucideIcons(mount);

    let rows;
    let est;
    try {
        [rows, est] = await Promise.all([collectStatuses(), storageEstimate()]);
    } catch (e) {
        mount.innerHTML = `<div class="text-center py-8 text-red-500 text-sm">미러 상태를 읽지 못했습니다: ${escapeHtml(
            e?.message || String(e)
        )}</div>`;
        return;
    }

    const totalDocs = rows.reduce((a, r) => a + (r.docCount || 0), 0);
    const storageLine = est
        ? `브라우저 저장소 ${fmtBytes(est.usage)} 사용 / 한도 ${fmtBytes(est.quota)}${
              est.persisted === true
                  ? ' · <span class="text-emerald-700 font-bold">영구 보관 허용됨</span>'
                  : est.persisted === false
                    ? ' · <span class="text-amber-700 font-bold">자동 정리 대상</span>'
                    : ''
          }`
        : '브라우저가 저장소 사용량을 알려 주지 않습니다.';

    mount.innerHTML = `
        <div class="mb-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p class="text-sm font-black text-slate-800">보유 ${totalDocs.toLocaleString('ko-KR')}건</p>
            <p class="text-[11px] text-slate-500 mt-1">${storageLine}</p>
        </div>

        <div class="overflow-x-auto">
        <table class="w-full text-sm">
            <thead>
                <tr class="text-left text-xs font-bold text-slate-500 border-b border-slate-200">
                    <th class="py-2 pr-3">미러</th>
                    <th class="py-2 pr-3 text-right">보유</th>
                    <th class="py-2 pr-3">마지막 동기화</th>
                    <th class="py-2 pr-3">상태</th>
                    <th class="py-2 pr-3">정책</th>
                    <th class="py-2 text-right">조작</th>
                </tr>
            </thead>
            <tbody>
                ${rows
                    .map(
                        (r) => `
                    <tr class="border-b border-slate-100">
                        <td class="py-2 pr-3 font-bold text-slate-700">${escapeHtml(r.label)}</td>
                        <td class="py-2 pr-3 text-right tabular-nums text-slate-700">${(r.docCount || 0).toLocaleString('ko-KR')}</td>
                        <td class="py-2 pr-3 text-slate-500 text-xs">${escapeHtml(fmtStamp(r.lastSyncedAt))}</td>
                        <td class="py-2 pr-3">${ageBadge(r)}</td>
                        <td class="py-2 pr-3">${policyLabel(r)}</td>
                        <td class="py-2 text-right whitespace-nowrap">
                            <button type="button" data-mirror-sync="${escapeHtml(r.key)}" class="px-2.5 py-1 rounded-lg text-xs font-bold border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-60 disabled:cursor-wait">
                                ${r.bootstrapDone ? '지금 동기화' : '지금 내려받기'}
                            </button>
                            <button type="button" data-mirror-rebuild="${escapeHtml(r.key)}" title="북마크를 무시하고 서버 전체를 지금 다시 받습니다. 서버 읽기가 많습니다." class="ml-1 px-2.5 py-1 rounded-lg text-xs font-bold border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 disabled:opacity-60 disabled:cursor-wait">
                                전체 재구축
                            </button>
                            <button type="button" data-mirror-reset="${escapeHtml(r.key)}" title="지금은 비우기만 하고, 실제 내려받기는 해당 화면을 다음에 열 때 합니다." class="ml-1 px-2.5 py-1 rounded-lg text-xs font-bold border border-slate-200 bg-white text-slate-700 hover:bg-slate-50">
                                재구축 예약
                            </button>
                        </td>
                    </tr>`
                    )
                    .join('')}
            </tbody>
        </table>
        </div>

        <div class="mt-5 rounded-xl border border-slate-200 bg-white px-4 py-3">
            <p class="text-xs font-black text-slate-700 mb-1">비용이 큰 작업</p>
            <p class="text-[11px] text-slate-500 leading-relaxed mb-2">
                Firestore 전체를 다시 읽는 작업은 이 자리에 모아 둡니다 — 각 화면의 새로고침은 바뀐 것만 읽습니다.
            </p>
            <div class="flex flex-wrap gap-2">
                <button type="button" id="mirrorDashboardFullBtn" title="네 미러(meals·users·sharedPhotos·usageDaily)를 통째로 다시 받고 대시보드 통계를 다시 계산해 저장합니다. meals 만 약 1.2만 읽기입니다." class="px-3 py-2 rounded-xl text-sm font-bold border border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 disabled:opacity-60 disabled:cursor-wait">
                    대시보드 전체 재집계
                </button>
            </div>
            <p class="mt-2 text-[11px] text-slate-400">
                미러 하나만 다시 받으려면 위 표의 「전체 재구축」을 쓰세요. 대시보드 숫자는 그 뒤 대시보드 「새로고침」이면 반영됩니다.
            </p>
        </div>

        <div class="mt-5 flex flex-wrap gap-2">
            <button type="button" id="mirrorBuildAllBtn" class="px-3 py-2 rounded-xl text-sm font-bold bg-slate-800 text-white hover:bg-slate-700 disabled:opacity-60 disabled:cursor-wait">
                미구축 미러 전부 채우기
            </button>
            <button type="button" id="mirrorSyncAllBtn" class="px-3 py-2 rounded-xl text-sm font-bold border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-60 disabled:cursor-wait">
                전부 동기화
            </button>
            <button type="button" id="mirrorExportBtn" class="px-3 py-2 rounded-xl text-sm font-bold bg-emerald-600 text-white hover:bg-emerald-700">
                백업 파일로 내보내기
            </button>
            <label class="px-3 py-2 rounded-xl text-sm font-bold border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer">
                백업 파일 불러오기
                <input type="file" id="mirrorImportInput" accept="application/json,.json" class="hidden">
            </label>
            <button type="button" id="mirrorRefreshBtn" class="px-3 py-2 rounded-xl text-sm font-bold border border-slate-200 bg-white text-slate-700 hover:bg-slate-50">
                상태 새로고침
            </button>
        </div>
        <p id="mirrorConsoleMsg" class="mt-3 text-xs text-slate-500"></p>

        <div class="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <p class="text-xs font-black text-amber-800">백업 파일을 git 에 올리지 마세요</p>
            <p class="text-[11px] text-amber-700 leading-relaxed mt-1">
                사용자 기록과 프로필이 통째로 들어 있습니다. 저장소에 한 번 들어가면 히스토리에서 지우기 어렵고,
                공개 저장소라면 그대로 유출입니다. 다른 기기로 옮길 때는 이 파일을 직접 건네주세요.
            </p>
        </div>

        <p class="mt-4 text-[11px] leading-relaxed text-slate-400">
            · 미러는 사본입니다 — 지워져도 원본은 Firestore 에 그대로 있고, 다음 실행 때 다시 받습니다.<br>
            · 「지금 내려받기」는 이 자리에서 바로 받습니다. 첫 구축은 오래 걸립니다 —
            식사 기록은 1만 건 남짓을 한 번에 받습니다(기기당 한 번).<br>
            · 「재구축 예약」은 지금 지우기만 합니다. 실제 내려받기는 해당 화면을 다음에 열 때 일어납니다.<br>
            · 「정책」열이 7일 재구축인 미러는 기한이 차면 배경 유지보수(접속 시 + 6시간 간격)가
            스스로 전체를 다시 받습니다. 재구축 불필요·드리프트 감지인 미러는 정기 재구축이 없습니다.
        </p>
    `;
    refreshLucideIcons(mount);
    bindMirrorConsole(mount, rows);
}

function setMsg(text, tone = 'slate') {
    const el = document.getElementById('mirrorConsoleMsg');
    if (!el) return;
    el.className = `mt-3 text-xs text-${tone}-600`;
    el.textContent = text;
}

/**
 * 미러 하나를 지금 동기화한다.
 *
 * 부트스트랩은 몇 분이 걸릴 수 있어 진행 상황을 그대로 흘려 보여 준다 —
 * 아무 반응이 없으면 사람은 버튼을 다시 누르고, 그러면 같은 문서를 두 번 산다.
 */
async function syncMirrorByKey(key, onProgress, options = {}) {
    if (key === 'meals') return ensureMealsMirrorSynced(onProgress, options);
    if (key === 'users') return ensureUsersMirrorSynced(onProgress, options);
    const m = ALL_COLLECTION_MIRRORS.find((x) => x.name === key);
    if (!m) throw new Error(`알 수 없는 미러: ${key}`);
    return m.ensureSynced(onProgress, options);
}

/** 조작 중에는 이 화면의 버튼을 전부 잠근다 — 미러 두 개를 동시에 건드리지 않게 */
function setConsoleBusy(mount, busy) {
    mount.querySelectorAll('button, input[type="file"]').forEach((el) => {
        el.disabled = busy;
    });
}

/**
 * 미러 여럿을 차례로 채운다.
 * @param {string[]} keys
 * @param {string} verb 메시지에 쓸 말 ('내려받는' / '동기화하는')
 */
async function syncMirrors(mount, keys, verb, options = {}) {
    if (!keys.length) {
        setMsg('채울 미러가 없습니다 — 전부 이미 구축돼 있습니다.', 'emerald');
        return;
    }
    setConsoleBusy(mount, true);
    const failed = [];
    try {
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            setMsg(`(${i + 1}/${keys.length}) ${key} ${verb} 중…`);
            try {
                await syncMirrorByKey(key, (p) => {
                    setMsg(`(${i + 1}/${keys.length}) ${key} ${verb} 중… ${Number(p?.fetched || 0).toLocaleString('ko-KR')}건`);
                }, options);
            } catch (e) {
                console.error(`[미러 콘솔] ${key} 동기화 실패:`, e);
                failed.push(`${key}(${e?.message || e})`);
            }
        }
    } finally {
        setConsoleBusy(mount, false);
    }
    await renderMirrorConsole();
    if (failed.length) setMsg(`일부 실패: ${failed.join(', ')}`, 'red');
    else setMsg(`${keys.length}개 미러를 ${verb} 일을 마쳤습니다.`, 'emerald');
}

function bindMirrorConsole(mount, rows) {
    mount.querySelectorAll('[data-mirror-sync]').forEach((btn) => {
        btn.addEventListener('click', () => {
            void syncMirrors(mount, [btn.getAttribute('data-mirror-sync')], '동기화하는');
        });
    });

    mount.querySelectorAll('[data-mirror-rebuild]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const key = btn.getAttribute('data-mirror-rebuild');
            const costNote = key === 'meals' ? '\nmeals 는 약 1.2만 문서를 다시 받습니다.' : '';
            if (!confirm(`「${key}」 미러의 서버 전체를 지금 다시 받습니다. 서버 읽기가 많습니다.${costNote}\n계속할까요?`)) return;
            void syncMirrors(mount, [key], '재구축하는', { force: true });
        });
    });

    document.getElementById('mirrorBuildAllBtn')?.addEventListener('click', () => {
        const pending = rows.filter((r) => !r.bootstrapDone).map((r) => r.key);
        void syncMirrors(mount, pending, '내려받는');
    });

    document.getElementById('mirrorSyncAllBtn')?.addEventListener('click', () => {
        void syncMirrors(mount, rows.map((r) => r.key), '동기화하는');
    });

    document.getElementById('mirrorDashboardFullBtn')?.addEventListener('click', async () => {
        if (
            !confirm(
                '대시보드 전체 재집계 — 네 미러(meals·users·sharedPhotos·usageDaily)를 통째로 다시 받고 통계를 다시 계산합니다.\nmeals 만 약 1.2만 읽기입니다. 계속할까요?'
            )
        ) {
            return;
        }
        if (typeof window.refreshDashboardStatsFull !== 'function') {
            setMsg('대시보드 모듈이 아직 준비되지 않았습니다 — 대시보드 탭을 한 번 연 뒤 다시 시도해 주세요.', 'red');
            return;
        }
        setConsoleBusy(mount, true);
        setMsg('대시보드 전체 재집계 중… (몇 분 걸릴 수 있습니다)');
        try {
            await window.refreshDashboardStatsFull();
            setMsg('대시보드 전체 재집계를 마쳤습니다.', 'emerald');
            await renderMirrorConsole();
        } catch (e) {
            setConsoleBusy(mount, false);
            setMsg(`전체 재집계 실패: ${e?.message || e}`, 'red');
        }
    });

    mount.querySelectorAll('[data-mirror-reset]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const key = btn.getAttribute('data-mirror-reset');
            if (!confirm(`「${key}」 미러를 비웁니다. 다음에 해당 화면을 열 때 전체를 다시 받습니다.\n계속할까요?`)) return;
            try {
                await resetMirrorByKey(key);
                setMsg(`${key} 미러를 비웠습니다 — 다음 실행 때 전체를 다시 받습니다.`, 'emerald');
                await renderMirrorConsole();
            } catch (e) {
                setMsg(`실패: ${e?.message || e}`, 'red');
            }
        });
    });

    document.getElementById('mirrorRefreshBtn')?.addEventListener('click', () => void renderMirrorConsole());
    document.getElementById('mirrorExportBtn')?.addEventListener('click', () => void exportMirrorBackup());
    document.getElementById('mirrorImportInput')?.addEventListener('change', (e) => {
        const file = e.target?.files?.[0];
        if (file) void importMirrorBackup(file);
    });
}

async function resetMirrorByKey(key) {
    if (key === 'meals') return resetMealsMirror();
    if (key === 'users') return resetUsersMirror();
    const m = ALL_COLLECTION_MIRRORS.find((x) => x.name === key);
    if (!m) throw new Error(`알 수 없는 미러: ${key}`);
    return m.reset();
}

/** 스토어 하나를 통째로 읽는다 */
async function dumpStore(storeName) {
    const database = await openMirrorDb();
    const tx = database.transaction(storeName, 'readonly');
    return (await idbRequest(tx.objectStore(storeName).getAll())) || [];
}

async function exportMirrorBackup() {
    setMsg('백업을 만드는 중…');
    try {
        const collectionNames = ALL_COLLECTION_MIRRORS.map((m) => m.name);
        const storeNames = ['meals', 'users', ...collectionNames];
        const stores = {};
        const metas = {};
        for (const name of storeNames) {
            stores[name] = await dumpStore(name);
            metas[name] = await readMeta(name, {});
        }
        const payload = {
            format: BACKUP_FORMAT,
            app: 'mealog-admin-mirror',
            exportedAt: new Date().toISOString(),
            metas,
            stores
        };
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mealog-admin-mirror-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);

        const total = storeNames.reduce((acc, n) => acc + stores[n].length, 0);
        setMsg(
            `백업 ${total.toLocaleString('ko-KR')}건을 내려받았습니다 (${fmtBytes(blob.size)}). git 에는 올리지 마세요.`,
            'emerald'
        );
    } catch (e) {
        console.error('[미러 백업] 내보내기 실패:', e);
        setMsg(`내보내기 실패: ${e?.message || e}`, 'red');
    }
}

async function putAll(storeName, rows) {
    if (!rows?.length) return 0;
    const database = await openMirrorDb();
    // 큰 배열을 한 트랜잭션에 다 넣으면 오래 잠기므로 끊어서 넣는다
    const CHUNK = 2000;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const tx = database.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        rows.slice(i, i + CHUNK).forEach((r) => store.put(r));
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('중단'));
        });
    }
    return rows.length;
}

async function importMirrorBackup(file) {
    setMsg('백업을 읽는 중…');
    try {
        const text = await file.text();
        const payload = JSON.parse(text);
        if (payload?.app !== 'mealog-admin-mirror' || !payload.stores) {
            throw new Error('이 파일은 미러 백업이 아닙니다.');
        }
        if (Number(payload.format) > BACKUP_FORMAT) {
            throw new Error(`더 새로운 형식의 백업입니다(format ${payload.format}). 관리자 페이지를 새로고침해 주세요.`);
        }
        if (!confirm(`${fmtStamp(payload.exportedAt)} 백업을 불러옵니다.\n같은 문서는 백업 값으로 덮어씁니다. 계속할까요?`)) {
            setMsg('취소했습니다.');
            return;
        }

        const database = await openMirrorDb();
        const available = new Set([...database.objectStoreNames]);
        let total = 0;
        const skipped = [];
        for (const [name, rows] of Object.entries(payload.stores)) {
            if (!available.has(name)) {
                skipped.push(name);
                continue;
            }
            total += await putAll(name, rows);
            const meta = payload.metas?.[name];
            if (meta) await writeMeta(name, { ...meta, k: undefined });
        }
        const skipNote = skipped.length ? ` (모르는 스토어 ${skipped.join(', ')}은 건너뜀)` : '';
        setMsg(`${total.toLocaleString('ko-KR')}건을 불러왔습니다${skipNote}.`, 'emerald');
        await renderMirrorConsole();
    } catch (e) {
        console.error('[미러 백업] 불러오기 실패:', e);
        setMsg(`불러오기 실패: ${e?.message || e}`, 'red');
    }
}

/**
 * 정기 유지보수 — 관리자 페이지가 열려 있는 동안, 이미 구축된 미러를 조용히 동기화한다.
 *
 * 7일 재구축은 원래 「그 화면을 다음에 열 때」만 돌았다. 자주 안 여는 화면의 미러는
 * 기한이 지나도 계속 낡은 채였고, 어쩌다 열면 그 자리에서 전체 재구축이 돌아 뜸금없이
 * 느렸다. 여기서는 부팅 직후와 6시간 간격으로 각 미러의 `ensureSynced` 를 불러
 * **각자 판단**(델타/전체)에 맡긴다 — 기한이 찼으면 그때 배경에서 전체가 돈다.
 *
 * **미구축 미러는 건드리지 않는다.** 부트스트랩(meals 1.2만 읽기)은 사람이 콘솔에서
 * 「지금 내려받기」로 부르는 것이지, 배경 작업이 불청객으로 부를 일이 아니다.
 */
let mirrorMaintenanceTimer = null;

export async function runMirrorMaintenance() {
    let rows;
    try {
        rows = await collectStatuses();
    } catch (e) {
        console.warn('[미러 유지보수] 상태를 읽지 못해 건너뜁니다:', e?.message || e);
        return;
    }
    for (const r of rows) {
        if (!r.bootstrapDone) continue;
        try {
            const res = await syncMirrorByKey(r.key);
            if (res?.mode && res.mode !== 'delta') {
                console.log(`[미러 유지보수] ${r.key}: ${res.mode}(${res.reason || ''}) 재구축이 돌았습니다.`);
            }
        } catch (e) {
            console.warn(`[미러 유지보수] ${r.key} 동기화 실패 — 다음 주기에 다시 시도합니다:`, e?.message || e);
        }
    }
}

/** 관리자 인증 뒤 한 번 부른다 — 즉시 1회 + 6시간 간격. 중복 호출은 무시. */
export function startMirrorMaintenance() {
    if (mirrorMaintenanceTimer) return;
    void runMirrorMaintenance();
    mirrorMaintenanceTimer = setInterval(() => void runMirrorMaintenance(), 6 * 3600 * 1000);
}

if (typeof window !== 'undefined') {
    window.renderMirrorConsole = renderMirrorConsole;
}
