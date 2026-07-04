/**
 * 관리자 > AI > 식단분석 프롬프트 · AI 식단분석 배치 설정
 * Firestore: adminSettings/dietReportConfig
 */
import { db, appId, auth } from '../firebase.js';
import { doc, getDoc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { runAdminRefreshAction } from './utils.js';

export const DEFAULT_DIET_REPORT_PROMPT_TEMPLATE = `너는 식단 기록 앱의 영양 코치야. 아래 [식단 데이터]와 함께 제공되는 사진들을 종합해 그날 하루({{date}}) 식단을 평가한다.

[평가 기준 · 100점 만점]
- 균형(주식·단백질·채소/과일의 고른 구성)
- 단백질 충분함
- 채소·과일 포함 여부
- 과식·잦은 간식·야식 여부(감점 요인)
- 기록의 충실도(메뉴·사진 등)
위 항목을 종합해 0~100점을 매긴다. 데이터가 빈약하면 무리하게 높은 점수를 주지 말 것.

[작성 원칙]
- 한국어. 담백하고 따뜻한 어투. 캐릭터·이모지·과장 없이.
- 의학적 진단·치료·질병 단정 표현 금지("~에 좋다/나쁘다" 수준의 일반적 조언까지만).
- 사진에 음식이 보이면 실제로 반영하되, 데이터에 없는 사실은 지어내지 말 것.
- summary는 한 줄(공백 포함 60자 내외).
- goodPoint(좋았던 점), improvePoint(아쉬운 점)은 각각 한 줄, 없으면 빈 문자열.

[식단 데이터 · {{date}}]
{{mealText}}

[출력 형식]
아래 JSON만 출력한다. 다른 텍스트·설명·코드펜스 없이 JSON 객체 하나만.
{"score": 0-100 정수, "summary": "한줄평", "goodPoint": "좋았던 점", "improvePoint": "아쉬운 점"}`;

const CONFIG_REF = () => doc(db, 'artifacts', appId, 'adminSettings', 'dietReportConfig');

function formatConfigUpdatedAt(value) {
    if (!value) return '';
    try {
        const d = value.toDate ? value.toDate() : new Date(value);
        if (Number.isNaN(d.getTime())) return '';
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${y}-${m}-${day} ${hh}:${mm}`;
    } catch (_) {
        return '';
    }
}

async function promptVersionFromText(text) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    const hex = Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    return `diet-${hex.slice(0, 10)}`;
}

function normalizeBatchRunTime(raw) {
    const s = String(raw || '').trim();
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!m) return '00:10';
    const h = Math.min(23, Math.max(0, Number(m[1])));
    const min = Math.min(59, Math.max(0, Number(m[2])));
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function batchRunTimeForInput(hm) {
    const n = normalizeBatchRunTime(hm);
    return n;
}

export async function loadDietReportPromptEditor() {
    const textarea = document.getElementById('dietReportPromptInput');
    const meta = document.getElementById('dietReportPromptMeta');
    if (!textarea) return;
    try {
        const snap = await getDoc(CONFIG_REF());
        const data = snap.exists() ? snap.data() : {};
        const tpl = (data.promptTemplate && String(data.promptTemplate).trim()) || DEFAULT_DIET_REPORT_PROMPT_TEMPLATE;
        textarea.value = tpl;
        if (meta) {
            const at = formatConfigUpdatedAt(data.promptUpdatedAt);
            const ver = data.promptVersion ? String(data.promptVersion) : '—';
            meta.textContent = at ? `마지막 저장: ${at} · 버전 ${ver}` : `저장된 기록 없음 · 기본 프롬프트 표시 중`;
        }
    } catch (e) {
        console.error('dietReportConfig prompt load failed', e);
        textarea.value = DEFAULT_DIET_REPORT_PROMPT_TEMPLATE;
        if (meta) meta.textContent = '불러오기 실패 — 기본 프롬프트를 표시합니다.';
    }
}

export function resetDietReportPromptToDefault() {
    const textarea = document.getElementById('dietReportPromptInput');
    if (textarea) textarea.value = DEFAULT_DIET_REPORT_PROMPT_TEMPLATE;
}

export async function saveDietReportPrompt(buttonEl) {
    const textarea = document.getElementById('dietReportPromptInput');
    const meta = document.getElementById('dietReportPromptMeta');
    if (!textarea) return;
    const promptTemplate = String(textarea.value || '').trim();
    if (!promptTemplate) {
        alert('프롬프트 내용을 입력해 주세요.');
        return;
    }
    if (!promptTemplate.includes('{{date}}') || !promptTemplate.includes('{{mealText}}')) {
        const ok = confirm('{{date}} 또는 {{mealText}} 치환자가 없습니다. 그대로 저장할까요?');
        if (!ok) return;
    }
    await runAdminRefreshAction(buttonEl || null, async () => {
        const promptVersion = await promptVersionFromText(promptTemplate);
        const uid = auth.currentUser?.uid || null;
        await setDoc(
            CONFIG_REF(),
            {
                promptTemplate,
                promptVersion,
                promptUpdatedAt: serverTimestamp(),
                promptUpdatedBy: uid
            },
            { merge: true }
        );
        if (meta) meta.textContent = `저장됨 · 버전 ${promptVersion}`;
    }, { loadingLabel: '저장 중…' });
}

export async function loadDietReportBatchSettings() {
    const enabledEl = document.getElementById('dietReportBatchEnabled');
    const timeEl = document.getElementById('dietReportBatchRunTime');
    const meta = document.getElementById('dietReportBatchMeta');
    if (!enabledEl || !timeEl) return;
    try {
        const snap = await getDoc(CONFIG_REF());
        const data = snap.exists() ? snap.data() : {};
        enabledEl.checked = data.batchEnabled === true;
        timeEl.value = batchRunTimeForInput(data.batchRunTime || '00:10');
        if (meta) {
            const parts = [];
            if (data.lastBatchRunDate) parts.push(`마지막 배치 실행일: ${data.lastBatchRunDate}`);
            const stats = data.lastBatchStats;
            if (stats && typeof stats === 'object') {
                parts.push(`처리 ${stats.ok ?? 0}건 · 건너뜀 ${stats.skip ?? 0} · 실패 ${stats.err ?? 0}`);
            }
            const at = formatConfigUpdatedAt(data.batchSettingsUpdatedAt);
            if (at) parts.push(`설정 저장: ${at}`);
            meta.textContent = parts.length ? parts.join(' · ') : '배치 설정을 저장하면 자동 분석 스케줄에 반영됩니다.';
        }
    } catch (e) {
        console.error('dietReportConfig batch load failed', e);
        if (meta) meta.textContent = '설정 불러오기 실패';
    }
}

export async function saveDietReportBatchSettings(buttonEl) {
    const enabledEl = document.getElementById('dietReportBatchEnabled');
    const timeEl = document.getElementById('dietReportBatchRunTime');
    if (!enabledEl || !timeEl) return;
    const batchEnabled = enabledEl.checked === true;
    const batchRunTime = normalizeBatchRunTime(timeEl.value || '00:10');
    timeEl.value = batchRunTime;
    await runAdminRefreshAction(buttonEl || null, async () => {
        const uid = auth.currentUser?.uid || null;
        await setDoc(
            CONFIG_REF(),
            {
                batchEnabled,
                batchRunTime,
                batchSettingsUpdatedAt: serverTimestamp(),
                batchSettingsUpdatedBy: uid
            },
            { merge: true }
        );
        await loadDietReportBatchSettings();
    }, { loadingLabel: '저장 중…' });
}

window.loadDietReportPromptEditor = loadDietReportPromptEditor;
window.resetDietReportPromptToDefault = resetDietReportPromptToDefault;
window.saveDietReportPrompt = saveDietReportPrompt;
window.loadDietReportBatchSettings = loadDietReportBatchSettings;
window.saveDietReportBatchSettings = saveDietReportBatchSettings;
