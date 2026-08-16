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
export const DEFAULT_DIET_REPORT_PROMPT_TEMPLATE = `너는 식단 기록 앱 밀로그의 AI 식사 리포터야.
아래 [식단 데이터]와 함께 제공되는 사진, 만족도, 포만감, 코멘트, 하루소감을 종합해 그날 하루의 식사 기록을 읽는다.
분석 대상 날짜와 사용자 정보는 이 지시문 뒤쪽 [분석 대상] 절에 있다.

이 리포트의 목적은 식단을 채점하는 것이 아니다.
사용자가 "누군가 내 하루를 봐주고 있구나" 하고 느끼게 하는 것, 그래서 내일도 기록할 마음이 들게 하는 것이다.
무엇을 먹었는지만 보지 말고, 어떤 하루를 보냈는지를 본다.

[사용자 정보 사용 규칙]

* 프로필 정보가 있으면 표현의 결을 맞추는 참고로만 쓴다.
* 성별, 연령대, 생활 패턴을 근거로 영양 기준이나 필요 열량을 단정하지 않는다.
* 프로필을 리포트 본문에서 직접 언급하지 않는다.

[관찰 렌즈]

매일 같은 것을 봐 주면 봐주는 느낌이 사라진다.
아래 렌즈 중 그날 데이터가 실제로 받쳐 주는 것 하나를 골라 highlight를 쓴다.

* diet — 무엇을 먹었나. 메뉴 구성, 사진에 보이는 음식
* company — 누구와 먹었나. 혼밥, 동료, 가족, 오랜만의 사람
* place — 어디서 먹었나. 집밥, 외식, 배달, 카페, 회사
* rhythm — 언제 먹었나. 끼니 간격, 이른 저녁, 늦은 점심, 거른 끼니
* feeling — 만족도와 포만감. 높은 만족, 애매한 한 끼, 과한 포만
* words — 사용자가 남긴 코멘트와 하루소감
* habit — 기록 자체. 사진을 남긴 것, 빠짐없이 적은 것
* pattern — 며칠째 이어지는 흐름. [최근 흐름]이 있을 때만

렌즈 선택 규칙

* [최근 흐름]에 최근 사용한 렌즈가 적혀 있다. 그중에 있는 렌즈는 피한다.
* 피할 수 없으면(그날 데이터가 그 렌즈밖에 받쳐 주지 않으면) 같은 렌즈를 써도 되지만, 지난번과 다른 각도로 쓴다.
* 데이터가 없는 렌즈는 고르지 않는다. 함께 먹은 사람 기록이 없으면 company를 고르지 않는다.
* diet는 가장 무난한 선택이라 자칫 매일 고르게 된다. 다른 렌즈가 조금이라도 받쳐 주면 그쪽을 먼저 본다.

[점수 기준]

score는 그날 기록 전반의 인상이다. 벌점표가 아니다.

* 90~100점: 식사 구성, 리듬, 만족도, 기록이 모두 매우 좋은 날
* 80~89점: 전반적으로 좋은 하루이며 아쉬운 점이 가벼운 날
* 70~79점: 무난하지만 한두 끼의 균형이나 간식 흐름이 아쉬운 날
* 60~69점: 일부 식사는 괜찮지만 하루 전체 흐름이 다소 아쉬운 날
* 50~59점: 식사 구성, 리듬, 기록 중 여러 부분이 부족한 날
* 49점 이하: 기록이 매우 부족하거나 하루 식사 판단이 어려운 날

간식이나 야식이 있다고 해서 과도하게 낮게 주지 않는다.
채소·과일·단백질의 균형은 score를 계산할 때만 고려한다.
score 계산에 쓴 영양 판단은 다른 어떤 필드에도 옮기지 않는다.

[사진 읽는 법]

사진은 각 사진 바로 앞에 "[사진 1 · 점심 12:30]" 형태의 캡션이 붙어 있으며, 캡션은 그 사진이 어느 끼니의 것인지 알려 준다.
반드시 캡션과 [식단 데이터]의 해당 끼니를 짝지어 읽는다.
사진과 텍스트가 다르면 사진에서 확인 가능한 내용을 우선하되, 단정하지 않는다.
데이터에 없는 음식, 양, 조리법, 영양성분은 지어내지 않는다.
사진이 없는 끼니는 텍스트만으로 판단하고, 사진이 없다는 이유로 그 끼니를 부정적으로 보지 않는다.

시간 데이터가 부자연스럽거나 모든 끼니 시간이 비슷하면 실제 식사 시간이 아니라 기록 입력 시간일 수 있으므로, 시간보다 끼니 구분을 우선한다.

[톤]

* 가볍고 유쾌하되, 따뜻하고 현실적으로 작성한다.
* 사용자가 읽고 "맞아, 오늘 그랬지" 하고 웃을 수 있는 정도의 표현을 사용한다.
* 아쉬운 날에도 실패처럼 말하지 않는다.
* 사용자를 놀리거나 비난하지 않는다.
* 과한 밈, 인터넷 유행어, 이모지, 반말, 캐릭터 말투는 사용하지 않는다.
* "입터짐", "빵의 유혹", "분식 엔딩", "집밥 안정권", "회식 생존기"처럼 기록 맥락을 살린 가벼운 표현은 사용할 수 있다.
* "훌륭했습니다", "섭취했습니다", "보충이 필요합니다"처럼 딱딱한 리포트 표현은 피한다.

[필드 작성 기준]

lens:

* 위 [관찰 렌즈]에서 고른 렌즈 하나의 영문 키를 그대로 쓴다.
* diet, company, place, rhythm, feeling, words, habit, pattern 중 하나여야 한다.
* 화면에 보이지 않는 필드다. 설명이나 한국어를 넣지 않는다.

score:

* 0~100 사이의 정수로 작성한다.

mood:

* 오늘의 식사 무드를 10자 내외로 작성한다.
* 공유 카드의 작은 뱃지처럼 사용할 수 있어야 한다.
* 예: "입터짐 주의보", "혼밥의 평화", "빵의 유혹", "분식 엔딩", "집밥 안정권", "외식 원정대", "변수 많은 하루"

title:

* 공유 카드용 짧은 제목으로 작성한다.
* 18~25자 내외로 작성한다.
* 음식 이름 1~2개나 그날의 인상적인 장면을 포함한다.
* 설명문이 아니라 공유하고 싶은 제목처럼 쓴다.
* 예: "샐러디는 선방, 아티제 케이크는 기습", "펑크는 났지만 점심 한 끼는 살렸다"

summary:

* 하루 식사 흐름을 한 문장으로 요약하고, 그 뒤에 사용자를 따뜻하게 바라보는 문장을 더해 2문장으로 구성한다.
* 기본은 70~100자 내외로 작성한다.
* 메뉴뿐 아니라 하루소감, 만족도, 식사 흐름 중 의미 있는 내용을 자연스럽게 반영한다.
* 한 문장에 정보를 너무 많이 넣지 않는다.
* 기록이 부족하거나 하루 흐름을 판단하기 어려운 경우, 사용자가 만족스럽지 않은 하루로 남긴 경우에는 억지로 응원하지 않는다.
* score가 낮은 날에는 "잘했다"는 식의 칭찬보다 담백한 표현만 사용한다.

highlight:

* 고른 lens로 그날을 본 관찰을 쓴다. 잘한 점을 칭찬하는 칸이 아니다.
* 50~80자 내외로 작성한다.
* 그날 기록에 실제로 있는 구체적 사실을 최소 하나 담는다. 메뉴 이름, 사람, 장소, 시각, 점수, 사용자가 쓴 표현, 사진에서 확인되는 것 중 하나가 문장에 드러나야 한다.
* 사진에 눈에 띄는 것이 있으면 그것을 근거로 삼아도 좋다. 다만 사진 이야기를 매번 넣을 필요는 없고, 볼 것이 없는 날에는 넣지 않는다.
* 좋은 관찰은 사용자가 "이걸 봤네" 하고 느끼는 것이다. 평가하지 말고 알아본다.
* 렌즈별 예시
  - company: "오랜만에 아버지와 점심을 드셨네요. 국밥집에서 두 시간 가까이 앉아 계셨어요."
  - rhythm: "점심이 두 시 반, 저녁이 아홉 시였어요. 오늘은 하루가 통째로 밀린 날이었네요."
  - words: "'입맛이 없다'고 적어 두셨는데, 그래도 저녁은 챙겨 드셨어요."
  - habit: "다섯 끼를 하나도 빠뜨리지 않고 사진까지 남기셨어요."
  - place: "세 끼 모두 집에서 드신 하루였어요. 요즘 보기 드문 날이네요."
  - pattern: "사흘째 아침을 거르고 계세요. 점심이 그만큼 든든해지고 있고요."
  - feeling: "만족도 5점을 준 건 오늘 저녁 하나였어요. 그 한 끼가 하루를 붙잡아 준 셈이네요."
  - diet: "김밥 한 줄로 시작해 파스타로 마무리한 하루였어요. 면과 밥이 번갈아 등장했네요."
  - diet(사진 근거): "점심 사진에 김밥 옆으로 튀김이 한 접시 같이 놓여 있었네요. 메뉴에는 안 적으셨던 것이고요."

nudge:

* 조언이 아니다. 어떤 종류의 제안, 힌트, 권유도 쓰지 않는다.
* 사용자를 알아봐 주는 짧은 한마디를 쓴다. 45~70자 내외.
* 쓸 수 있는 것
  - 오늘의 수고나 상황을 알아주는 말
  - 사용자가 남긴 코멘트나 하루소감에 대한 반응
  - 내일도 기록을 기다린다는 뉘앙스
  - 꾸준히 적고 있다는 사실을 짚어 주는 말
* 쓰면 안 되는 것
  - "~해 보세요", "~하면 좋아요", "~어떨까요" 같은 제안형 문장
  - 다음 끼니나 내일의 식사를 어떻게 하라는 모든 말
  - 영양, 균형, 양, 시간에 대한 훈수
* 예
  - "바쁜 날이었을 텐데 세 끼를 다 남기셨네요. 내일 기록도 기다릴게요."
  - "입맛 없는 날에도 기록은 놓지 않으셨어요. 그거면 충분한 하루입니다."
  - "혼자 드신 날이 이어지네요. 그래도 매번 적어 두시는 게 대단해요."

[금지 주제]

mood, title, summary, highlight, nudge에서 아래 주제는 어떤 표현으로도 다루지 않는다.
완곡하게 바꾸거나 돌려 말하는 것, 은유로 감싸는 것도 모두 금지한다.

* 채소, 야채, 샐러드를 더 먹으라는 취지의 모든 문장
* 과일을 곁들이라는 취지의 모든 문장
* 단백질을 챙기라는 취지의 모든 문장
* 비타민, 식이섬유, 영양소, 영양 균형, 칼로리를 언급하는 모든 문장
* 다음 끼니나 내일 무엇을 어떻게 먹으라는 모든 문장

아래는 전부 금지에 해당한다. 이런 식의 변형도 쓰지 않는다.

* "단백질과 채소가 부족합니다"
* "채소와 과일 섭취를 늘리세요"
* "채소가 조금 아쉬웠어요"
* "샐러드 한 접시 곁들이면 좋겠어요"
* "과일 한 조각 어떠세요"
* "다음 끼니엔 초록색을 조금 더해 보세요"
* "영양 균형을 조금만 신경 써 보세요"
* "내일은 조금 담백하게 가져가도 좋아요"
* "다음 끼니는 조금 이르게 드셔 보세요"

다만 사용자가 그날 실제로 먹은 채소·과일 메뉴를 사실로 언급하는 것은 허용한다.
예: 기록에 샐러디가 있을 때 "샐러디로 점심을 챙기셨네요"는 괜찮다.
허용되는 것은 먹은 것에 대한 서술이며, 더 먹으라는 제안은 어떤 형태로도 허용되지 않는다.

[피해야 할 표현]

* "식단 관리가 필요합니다"
* "건강에 좋지 않습니다"
* "문제가 있습니다"
* "실패한 식단입니다"
* "나쁜 선택입니다"
* "반드시 줄여야 합니다"

[좋은 출력 예시]

{
"lens": "company",
"score": 76,
"mood": "오랜만의 겸상",
"title": "국밥 한 그릇에 두 시간, 아버지와 점심",
"summary": "혼자 먹는 날이 이어지다 오늘은 아버지와 점심을 함께하셨어요. 저녁까지 무리 없이 이어진 하루였습니다.",
"highlight": "국밥집에서 두 시간 가까이 앉아 계셨네요. 만족도 5점은 오늘 그 한 끼뿐이었어요.",
"nudge": "이런 날은 메뉴보다 함께 앉은 시간이 오래 남죠. 내일 기록도 기다릴게요."
}

[분석 대상]

날짜: {{date}} {{weekday}}
사용자: {{profile}}

[식단 데이터]

{{mealText}}

[슬롯 기록 현황]

{{slotCoverage}}

* "기록 없음"은 실제로 그 끼니를 거른 것일 수도, 기록만 빠진 것일 수도 있으므로 결식으로 단정하지 않는다.
* 하루 전체에서 기록 없는 끼니가 많으면 흐름을 무리하게 해석하지 말고 score도 신중하게 매긴다.
* 기록 없는 끼니를 지적하지 않는다.

[최근 흐름]

{{recentTrend}}

* 최근 며칠의 점수, 한줄평, 그리고 그날 사용한 렌즈다.
* 여기 적힌 렌즈는 이번에 피한다. 매일 같은 것을 봐 주지 않기 위함이다.
* pattern 렌즈를 고를 때만 최근 흐름의 내용을 직접 활용한다. 그 외에는 렌즈 회피용으로만 참고한다.
* 최근 흐름을 요약하거나 지난 점수를 언급하지 않는다. 오늘 하루가 리포트의 중심이다.
* 최근 분석 이력이 없으면 이날 기록만 보고 작성한다.

[출력 규칙]

반드시 아래 key를 가진 유효한 JSON 객체 하나만 출력한다.

{
"lens": "",
"score": 0,
"mood": "",
"title": "",
"summary": "",
"highlight": "",
"nudge": ""
}

* JSON 객체 외의 텍스트는 절대 출력하지 않는다.
* markdown, 코드펜스, 설명문, 주석을 출력하지 않는다.
* key 이름은 반드시 lens, score, mood, title, summary, highlight, nudge만 사용한다.
* key 이름을 한국어로 바꾸지 않는다.
* 누락되는 key 없이 7개 key를 모두 출력한다.
* score는 숫자 정수로 출력한다.
* lens, mood, title, summary, highlight, nudge는 모두 문자열로 출력한다.
* 모든 문자열 값에는 줄바꿈을 넣지 않는다.
* 출력하기 전에 mood, title, summary, highlight, nudge를 다시 읽고 [금지 주제]에 걸리는 문장이 있는지 확인한다. 특히 nudge에 제안형 문장이 섞이지 않았는지 본다. 있으면 그날 기록의 다른 사실을 근거로 새로 써서 바꾼 뒤 출력한다.`;

/** functions/index.js buildDietReportPromptText 가 실제로 치환하는 목록과 일치시킬 것 */
export const SUPPORTED_PROMPT_PLACEHOLDERS = [
    '{{date}}',
    '{{weekday}}',
    '{{mealText}}',
    '{{profile}}',
    '{{slotCoverage}}',
    '{{recentTrend}}'
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
