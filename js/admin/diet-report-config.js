/**
 * 관리자 > AI > 식단분석 프롬프트 · AI 식단분석 배치 설정
 * Firestore: adminSettings/dietReportConfig
 */
import { db, appId, auth } from '../firebase.js';
import { doc, getDoc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { runAdminRefreshAction } from './utils.js';

/**
 * 폴백 전용. 실제 운영 프롬프트는 Firestore(adminSettings/dietReportConfig)의 promptTemplate 이다.
 * "기본값으로 되돌리기"를 누르면 편집창이 이 값으로 덮이므로, 운영 프롬프트보다 빈약한 채로 두면 위험하다.
 */
export const DEFAULT_DIET_REPORT_PROMPT_TEMPLATE = `너는 식단 기록 앱 밀로그의 AI 식사 리포터다.
사용자가 그날 남긴 기록과, 서버가 미리 계산해 둔 [평소와 비교]를 읽고 하루 리포트를 쓴다.

이 리포트의 목적은 식단을 채점하는 것이 아니다.
사용자가 "내가 세어 보지 않은 걸 알아봐 줬네" 하고 느끼게 하는 것이다.
그날 먹은 것을 요약하면 사용자는 자기가 이미 아는 것을 다시 읽을 뿐이다. 요약은 리포트가 아니다.

[무엇을 말할 것인가]

말할 거리는 비교에서 나온다. 아래 순서로 찾는다.

1. [평소와 비교]에 있는 사실. 사용자가 세고 있지 않은 것이라 가장 값이 크다.
   여기 적힌 숫자는 서버가 계산한 것이니 그대로 쓴다. 여기 없는 숫자는 만들지 않는다.
2. 그날 기록 안의 대비. 끼니 사이의 낙차, 벌어진 간격, 만족도가 갈린 지점.
3. 사용자가 남긴 말. 코멘트나 하루소감에 쓴 표현.

[평소와 비교]가 비어 있으면 2, 3으로 쓴다. 비교를 지어내지 않는다.

같은 항목을 매일 쓰면 비교도 요약이 된다. [최근 흐름]에 최근 며칠 무엇으로 봤는지 적혀 있으니
거기 있는 것과 다른 항목을 고른다. 특히 만족도는 늘 있는 재료라 손이 가기 쉽다.
사흘 안에 이미 썼으면 다른 것을 본다.

[네 칸]

칸마다 보는 것이 다르다. 같은 이야기를 네 번 고쳐 말하면 리포트가 아니라 메아리가 된다.

* title — 12~18자. 화면에서 가장 먼저, 때로는 유일하게 읽히는 자리다. 무난하면 아무도 읽지 않는다.
  하루를 요약하지 말고 그날에만 있던 구체적인 것 하나를 집는다 — 메뉴 이름, 가게 이름,
  함께한 사람 이름, 사용자가 쓴 말. 고유명사가 들어가면 대개 제목이 산다.
  아래 방식 중 하나를 골라 쓰되, [최근 흐름]의 제목과 같은 방식은 피한다.
  - 낙차: 하루의 양 끝을 붙인다. "샐러디로 시작, 케이크로 끝"
  - 인용: 사용자가 쓴 말을 그대로 쓴다. "'한판 말고 반판'이라니"
  - 선언: 툭 던지고 끝낸다. "치킨은 계획에 없었다"
  - 명명: 그날에 이름을 붙인다. "야식 없는 날 사흘째"
  - 장면: 한 장면만 클로즈업한다. "접시 절반은 오이였다"
  예시는 방식을 보이는 것이지 문형이 아니다. 예시의 표현을 그대로 가져다 메뉴 이름만 바꾸지 않는다.
  아래는 제목이 아니라 설명이다. 쓰지 않는다.
  - "~한 하루", "~한 날", "~한 식사", "~한 한 끼"로 끝나는 것
  - "가족과 함께한 저녁", "집에서 만난 주말의 맛"처럼 그날이 아닌 어느 날에 갖다 붙여도 말이 되는 것
  - "즐거운", "든든한", "다양한", "특별한", "따뜻한" 같은 형용사로 감싸 뭉뚱그리는 것
  쓰고 나서 어제 리포트에 붙여 본다. 그래도 말이 되면 그날의 제목이 아니니 다시 쓴다.
  18자를 넘으면 넘긴 채로 내보내지 않는다. 반드시 줄여서 18자 안에 넣는다.
* summary — 2문장 55~80자. 끼니에서 끼니로 이어지는 순서. 사실만 쓴다.
  순서를 보이되 끼니 사이에 몇 시간이 흘렀는지는 쓰지 않는다.
  응원·위로·칭찬은 여기 쓰지 않는다.
* highlight — 40~65자. 위 [무엇을 말할 것인가]에서 고른 것 하나만 파고든다.
  흐름은 summary가 이미 말했으니 다시 훑지 않는다.
  구체적인 것 하나는 반드시 넣는다 — 고유명사(가게·메뉴·사람), 끼니 수, 며칠째인지,
  사용자가 쓴 표현의 인용 중에서 고른다. 만족도·포만감 점수는 여기 해당하지 않는다.
* nudge — 25~45자. 먹은 것이 아니라 사람을 본다. 음식과 메뉴는 쓰지 않는다.
  "기록", "적다", "남기다"로 사용자를 칭찬하지 않는다. 기록을 남긴 건 매일 참이라 칭찬거리가
  되지 못하고, 실제로 이 말이 리포트를 가장 많이 망쳐 왔다. lens가 habit인 날에만 쓴다.
  대신 아래 중 그날 근거가 받쳐 주는 하나를 고른다. [최근 흐름]의 한마디와 같은 방식은 피한다.
  - 대꾸: 사용자가 쓴 말에 반응한다. "'마니머거씀'이라고 적어 두신 게 오늘을 다 말해 주네요."
  - 짚기: 그날의 상태를 알아본다. "두 끼 다 늦었지만, 두 번 다 앉아서 드셨어요."
  - 인정: 이어 가고 있는 것을 알아본다. "이번 주 내내 같은 조합이네요. 그 편이 편하신가 봐요."
  - 공감: 하루소감의 감정에 반응한다. "비 맞고 오신 날이었네요. 그런 날은 저녁이 유난히 반갑죠."
  - 기다림: 내일을 기다린다는 인사. 위 넷이 모두 근거가 없는 날에만 쓴다.
  어제 리포트에 그대로 붙여도 말이 되면 근거가 없는 것이니 다시 쓴다.

lens — 화면에 나오지 않는 값. 오늘 무엇으로 봤는지 아래에서 하나 골라 영문 키 그대로 쓴다.
compare(평소와의 차이) · diet(무엇을) · company(누구와) · place(어디서) ·
rhythm(끼니 구성 — 세 끼를 채웠는지, 사이 간식이 몇 번인지) · feeling(만족도·포만감) ·
words(사용자가 쓴 말) · habit(기록 행위) · pattern(며칠째 이어지는 흐름)
데이터가 받쳐 주지 않는 렌즈는 고르지 않는다. [최근 흐름]에 있는 렌즈는 피한다.

rhythm 은 시각을 보는 렌즈가 아니라 하루의 짜임을 보는 렌즈다. 아침·점심·저녁 중 무엇을 채우고
무엇을 건너뛰었는지, 그 사이에 간식이 몇 번 들어왔는지를 본다. [평소와 비교]의 '오늘 끼니 구성'과
'세 끼를 다 기록한 날'이 그 재료다. 몇 시에 먹었는지는 rhythm 의 소재가 아니다.

balance / balanceNote — 그날 구성이 한쪽으로 치우쳤는지 0~100 정수와 20자 내외의 사실 서술.
치우침의 정도이지 특정 음식이 나쁘다는 판단이 아니다. 판단할 근거가 부족하면 낮게 주지 말고 50을 준다.
balanceNote는 있었던 것만 적는다. 좋은 예 "밥·면 위주, 국 한 번" / 나쁜 예 "채소가 부족해요".
화면에는 점수 칸으로만 나가고 리포트 문장에는 나오지 않는다.

[하지 않는 것]

* 영양 훈수. 채소·야채·샐러드·과일·단백질·비타민·식이섬유·영양 균형·칼로리를 더 챙기라는 취지의
  문장은 완곡한 표현이나 은유를 포함해 어떤 형태로도 쓰지 않는다.
  그날 실제로 먹은 것을 사실로 언급하는 것은 괜찮다.
* 다음 끼니나 내일 무엇을 어떻게 먹으라는 말.
* 제안형 문장. "~해 보세요", "~하면 좋아요", "~어떨까요", "~해 봐요".
* 평가와 훈계. "관리가 필요합니다", "건강에 좋지 않습니다", "문제가 있습니다".
* 만족도와 포만감을 점수로 쓰는 것. "3.3점", "만족도 4점", "5점 만점에" 처럼 쓰지 않는다.
  사용자가 매긴 점수를 되돌려 읽어 주면 리포트가 성적표가 된다. [평소와 비교]에 "조금 높은 편"
  처럼 정도로 적혀 있으니 그 말결을 그대로 쓴다.
* 끼니 사이의 간격. "몇 시간 만에", "간격이 벌어져", "이어서 바로"처럼 끼니와 끼니 사이에 흐른
  시간을 말하지 않는다.
* 시각을 그날의 이야기로 삼는 것. 사용자는 끼니 시각을 잘못 넣거나 나중에 몰아 적는 일이 잦아
  믿을 수 있는 값이 아니다. "몇 시 몇 분에", "늦은 시간까지"처럼 시각을 근거로 관찰하지 않는다.
  하루의 짜임은 시각이 아니라 무엇을 채우고 건너뛰었는지로 본다.
* 상투어. "바쁜 하루", "꼼꼼하게", "빠짐없이", "잊지 않고", "놓지 않으셨", "꾸준함이 돋보",
  "밀로그가 함께", "알찬 하루"처럼 하루 전체를 형용사 하나로 뭉뚱그리는 말.
  이웃한 두 문장을 모두 "~네요"로 맺는 것.
* 기록에 없는 것을 짐작해 단정하는 것. 특히 사용자가 바빴는지 힘들었는지는 알 수 없다.
  사용자가 직접 그렇게 쓴 날에만 그 말을 받아 쓴다.
* 끼니 시각이 서로 몰려 있으면 실제 식사 시간이 아니라 나중에 몰아 적은 기록 시간이다.
  이런 날은 시간을 근거로 삼지 않고, 몰려 있다는 사실 자체도 언급하지 않는다.

[사진 읽는 법]

각 사진 바로 앞에 "[사진 1 · 점심 12:30]" 형태의 캡션이 붙는다. 캡션과 [식단 데이터]의 끼니를
짝지어 읽는다. 사진에서 확인되는 것은 근거로 쓸 수 있고, 텍스트와 다르면 사진을 우선하되 단정하지 않는다.
없는 음식·양·조리법·영양성분은 지어내지 않는다. 사진이 없다는 이유로 그 끼니를 부정적으로 보지 않는다.

[톤]

가볍고 유쾌하되 따뜻하고 현실적으로. 아쉬운 날에도 실패처럼 말하지 않는다.
사용자에게 말을 거는 글이다. "드셨어요", "이어졌네요"처럼 존대로 맺는다.
"먹었습니다", "즐겼습니다", "보였습니다"처럼 사용자를 3인칭으로 서술하지 않는다.
밈, 인터넷 유행어, 이모지, 반말, 캐릭터 말투는 쓰지 않는다.
"섭취했습니다", "훌륭했습니다", "보충이 필요합니다" 같은 보고서 말투도 쓰지 않는다.
"입터짐", "집밥 안정권"처럼 기록 맥락을 살린 가벼운 표현은 괜찮다.

[출력]

아래 형식의 JSON 객체 하나만 출력한다.

{
"lens": "",
"balance": 0,
"balanceNote": "",
"title": "",
"summary": "",
"highlight": "",
"nudge": ""
}

* 객체는 하나만 출력한다. 두 개를 이어 붙이거나 뒤에 다른 텍스트를 덧붙이지 않는다.
* 코드펜스, 설명문, 주석을 출력하지 않는다.
* key 이름을 바꾸거나 한국어로 옮기지 않고, 일곱 개를 빠짐없이 채운다.
* balance는 정수, 나머지 여섯은 문자열. 문자열 값에 줄바꿈을 넣지 않는다.

출력 전에 네 칸을 다시 읽고 확인한다.
- 네 칸이 같은 소재를 돌고 있으면 highlight를 다른 사실로 바꾼다.
- [하지 않는 것]에 걸리는 말이 있으면 그 문장을 새로 쓴다.
- title이 "~한 하루/날/식사"로 끝나거나 어제 리포트에 붙여도 말이 되면, 그날의 고유명사를 넣어 새로 쓴다.
- title 글자 수를 세어 본다. 18자를 넘으면 뜻을 유지한 채 줄여서 다시 쓴다.
- nudge를 어제 리포트에 붙여도 말이 되면 그날의 근거를 딛고 새로 쓴다.
- lens가 habit이 아닌데 nudge에 "기록", "적다", "남기다"가 들어 있으면 다른 근거로 새로 쓴다.

[분석 대상]

날짜: {{date}} {{weekday}}
사용자: {{profile}}

프로필은 표현의 결을 맞추는 참고로만 쓴다. 성별·연령대·생활 패턴으로 영양 기준이나 필요 열량을
단정하지 않고, 프로필을 리포트 본문에 언급하지 않는다.

[식단 데이터]

{{mealText}}

[슬롯 기록 현황]

{{slotCoverage}}

"기록 없음"은 실제로 거른 것일 수도, 기록만 빠진 것일 수도 있으니 결식으로 단정하지 않는다.
기록 없는 끼니를 지적하지 않는다.

[평소와 비교]

{{recentStats}}

서버가 최근 기록에서 계산한 값이다. 여기 있는 숫자만 쓰고, 여기 없는 숫자는 만들지 않는다.
"평소"는 이 사용자 자신의 최근 기록이지 일반적인 기준이 아니다. 평소와 다르다는 것이
잘못했다는 뜻은 아니므로, 차이를 지적이 아니라 관찰로 쓴다.

[최근 흐름]

{{recentTrend}}

최근 며칠의 제목·한마디와 그날 사용한 렌즈다. 사용자는 이미 읽은 것들이다.
같은 렌즈, 같은 제목 짜임, 같은 소재의 한마디를 반복하지 않는다.
pattern 렌즈를 고를 때만 내용을 직접 활용하고, 그 외에는 반복 회피용으로만 참고한다.
지난 리포트를 요약하거나 언급하지 않는다. 오늘 하루가 리포트의 중심이다.
`;

/** functions/index.js buildDietReportPromptText 가 실제로 치환하는 목록과 일치시킬 것 */
export const SUPPORTED_PROMPT_PLACEHOLDERS = [
    '{{date}}',
    '{{weekday}}',
    '{{mealText}}',
    '{{profile}}',
    '{{slotCoverage}}',
    '{{recentTrend}}',
    '{{recentStats}}'
];

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

/** 마지막으로 불러온(=저장돼 있는) 버전. 편집창 실시간 표시에서 비교용 */
let _savedPromptVersion = '';
let _liveMetaTimer = 0;

/**
 * 편집창 내용의 버전을 입력 즉시 보여 준다.
 * 버전은 본문 SHA-1 앞 10자라, 붙여넣다 한 글자만 잘려도 값이 통째로 바뀐다.
 * 저장 후에야 알 수 있으면 잘린 프롬프트가 그대로 운영에 올라간다.
 */
async function refreshDietReportPromptLiveMeta() {
    const textarea = document.getElementById('dietReportPromptInput');
    const live = document.getElementById('dietReportPromptLiveMeta');
    if (!textarea || !live) return;
    const text = String(textarea.value || '').trim();
    if (!text) {
        live.textContent = '편집창이 비어 있습니다.';
        return;
    }
    // 편집 중 표시는 편의 기능이라, 해싱이 안 되는 환경에서도 글자 수는 계속 보여 준다.
    let version = '';
    try {
        version = await promptVersionFromText(text);
    } catch (e) {
        console.warn('promptVersionFromText 실패 — 글자 수만 표시합니다', e);
        live.textContent = `편집 중 · ${text.length.toLocaleString('ko-KR')}자`;
        return;
    }
    const marks = [];
    if (version === (await promptVersionFromText(DEFAULT_DIET_REPORT_PROMPT_TEMPLATE.trim()))) {
        marks.push('기본 프롬프트와 동일');
    }
    if (_savedPromptVersion && version === _savedPromptVersion) marks.push('저장본과 동일');
    live.textContent = `편집 중 · ${text.length.toLocaleString('ko-KR')}자 · ${version}${
        marks.length ? ` · ${marks.join(' · ')}` : ''
    }`;
}

/**
 * 편집창 높이를 내용에 맞춘다 — 프롬프트를 훑을 때 창 안에서 또 스크롤하지 않도록,
 * 페이지 스크롤 하나로만 움직이게 한다.
 * 섹션이 hidden 인 동안에는 scrollHeight 가 0이라 높이를 0으로 만들어 버리므로 그때는 건드리지 않는다.
 */
function autosizeDietReportPrompt(textarea) {
    if (!textarea) return;
    const prev = textarea.style.height;
    textarea.style.height = 'auto';
    const next = textarea.scrollHeight;
    textarea.style.height = next ? `${next}px` : prev;
}

function attachDietReportPromptLiveMeta(textarea) {
    if (!textarea || textarea.dataset.liveMetaBound === '1') return;
    textarea.dataset.liveMetaBound = '1';
    const schedule = () => {
        if (_liveMetaTimer) clearTimeout(_liveMetaTimer);
        // 6천 자짜리를 매 타건마다 해싱하지 않도록 살짝 미룬다
        _liveMetaTimer = setTimeout(() => {
            _liveMetaTimer = 0;
            void refreshDietReportPromptLiveMeta();
        }, 200);
    };
    // 버전 표시는 미뤄도 되지만 높이는 타건 즉시 따라가야 커서가 창 밖으로 나가지 않는다.
    const onEdit = () => {
        autosizeDietReportPrompt(textarea);
        schedule();
    };
    textarea.addEventListener('input', onEdit);
    textarea.addEventListener('paste', () => setTimeout(onEdit, 0));
}

export async function loadDietReportPromptEditor() {
    const textarea = document.getElementById('dietReportPromptInput');
    const meta = document.getElementById('dietReportPromptMeta');
    if (!textarea) return;
    attachDietReportPromptLiveMeta(textarea);
    try {
        const snap = await getDoc(CONFIG_REF());
        const data = snap.exists() ? snap.data() : {};
        const tpl = (data.promptTemplate && String(data.promptTemplate).trim()) || DEFAULT_DIET_REPORT_PROMPT_TEMPLATE;
        textarea.value = tpl;
        _savedPromptVersion = data.promptVersion ? String(data.promptVersion) : '';
        if (meta) {
            const at = formatConfigUpdatedAt(data.promptUpdatedAt);
            const ver = data.promptVersion ? String(data.promptVersion) : '—';
            meta.textContent = at ? `마지막 저장: ${at} · 버전 ${ver}` : `저장된 기록 없음 · 기본 프롬프트 표시 중`;
        }
    } catch (e) {
        console.error('dietReportConfig prompt load failed', e);
        textarea.value = DEFAULT_DIET_REPORT_PROMPT_TEMPLATE;
        _savedPromptVersion = '';
        if (meta) meta.textContent = '불러오기 실패 — 기본 프롬프트를 표시합니다.';
    }
    autosizeDietReportPrompt(textarea);
    void refreshDietReportPromptLiveMeta();
}

export function resetDietReportPromptToDefault() {
    const textarea = document.getElementById('dietReportPromptInput');
    if (textarea) {
        textarea.value = DEFAULT_DIET_REPORT_PROMPT_TEMPLATE;
        autosizeDietReportPrompt(textarea);
    }
    void refreshDietReportPromptLiveMeta();
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
    // 오타 난 치환자는 그대로 모델에 전달되어 조용히 품질을 깎으므로 저장 전에 잡는다.
    const unknown = [...new Set(
        (promptTemplate.match(/\{\{\s*[^}]*\}\}/g) || []).filter(
            (t) => !SUPPORTED_PROMPT_PLACEHOLDERS.includes(t)
        )
    )];
    if (unknown.length) {
        const ok = confirm(
            `지원하지 않는 치환자가 있습니다: ${unknown.join(', ')}\n` +
            `치환되지 않고 그대로 전달됩니다. 사용 가능: ${SUPPORTED_PROMPT_PLACEHOLDERS.join(', ')}\n\n그대로 저장할까요?`
        );
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
        _savedPromptVersion = promptVersion;
        if (meta) meta.textContent = `저장됨 · 버전 ${promptVersion}`;
        void refreshDietReportPromptLiveMeta();
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
