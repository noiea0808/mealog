/**
 * 일간보기 공유용 컴팩트 카드 (html2canvas 캡처용 DOM)
 */
import { SLOTS, SLOT_STYLES } from '../constants.js';
import { escapeHtml } from './utils.js';
export function createDailyShareCard(dateStr, forPreview = false) {
    const dObj = new Date(dateStr + 'T00:00:00');
    const year = dObj.getFullYear();
    const month = dObj.getMonth() + 1;
    const day = dObj.getDate();
    
    // 사용자 정보 가져오기 (아이콘 미설정 시 기본 회색 사람 아이콘)
    const userProfile = window.userSettings?.profile || {};
    const displayProfile = { nickname: userProfile.nickname || '익명', icon: userProfile.icon ?? null, photoUrl: userProfile.photoUrl || null };
    const userNickname = displayProfile.nickname;
    // 기존 컨테이너 제거
    const existing = document.getElementById('dailyShareCardContainer');
    if (existing) existing.remove();
    
    // 공유용 컨테이너 생성 (forPreview: 모달용으로 배치/숨김 없음, !forPreview: 화면 밖에 숨김)
    const container = document.createElement('div');
    container.id = 'dailyShareCardContainer';
    if (!forPreview) {
        container.style.position = 'fixed';
        container.style.left = '-9999px';
        container.style.top = '0';
    } else {
        container.style.margin = '0 auto';
    }
    container.style.width = '420px'; // 모바일 기준 너비
    container.style.maxWidth = '420px';
    container.style.backgroundColor = '#ffffff';
    container.style.padding = '0';
    container.style.fontFamily = 'Pretendard, sans-serif';
    
    // Fredoka 폰트 로드 확인 및 적용
    if (document.fonts && document.fonts.check) {
        // 폰트가 로드되었는지 확인
        const fredokaLoaded = document.fonts.check('1em Fredoka');
        if (!fredokaLoaded) {
            // Fredoka 폰트가 없으면 Google Fonts에서 로드
            const link = document.createElement('link');
            link.href = 'https://fonts.googleapis.com/css2?family=Fredoka:wght@300;400;500;600;700&display=swap';
            link.rel = 'stylesheet';
            document.head.appendChild(link);
        }
    }
    
    // 날짜 포맷팅 (26년 1월21일 형식)
    const shortYear = year.toString().slice(-2);
    const formattedDate = `'${shortYear}년 ${month}월${day}일`;
    
    const blue = '#1877F2';
    const borderLightGray = '#e2e8f0';
    const borderOuterGray = '#cbd5e1';
    const photoAreaEmptyBg = '#e2e8f0'; /* 사진 없을 때 영역: 본문보다 진한 회색 */
    let html = `
        <div style="width: 420px; max-width: 420px; margin: 0 auto; border: 1px solid ${borderOuterGray}; border-radius: 20px; overflow: hidden; background: #f1f5f9;">
            <!-- 헤더 (패딩 6/16/16으로 텍스트 10px 상향) -->
            <div style="background: #ffffff; padding: 6px 16px 16px; border-bottom: 1px solid ${borderLightGray};">
                <!-- 상단: mealog(파란색)와 날짜 (html2canvas 베이스라인 정렬: flex + align-items: center) -->
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                    <span style="font-size: 28.8px; font-weight: 600; color: ${blue}; font-family: 'Fredoka', sans-serif; letter-spacing: -0.5px; text-transform: lowercase;">mealog</span>
                    <span style="font-size: 12px; font-weight: 400; color: #64748b; flex-shrink: 0;">${formattedDate}</span>
                </div>
                <!-- 하단: 닉네임의 하루소감 (html2canvas 베이스라인 정렬: flex + align-items: center) -->
                <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="font-size: 16px; display: flex; align-items: center;">📅</span>
                    <span style="font-size: 15px; font-weight: 700; color: #1e293b; font-family: 'NanumSquareRound', sans-serif;">${escapeHtml(userNickname)}의 하루소감</span>
                </div>
            </div>
            
            <!-- 본문 (패딩 2px 상단으로 10px 상향) -->
            <div style="padding: 2px 0 12px 0; background: #f1f5f9; border-bottom-left-radius: 19px; border-bottom-right-radius: 19px;">
    `;
    
    // 타임라인처럼 모든 슬롯을 순서대로 표시 (간식 포함)
    SLOTS.forEach(slot => {
        const records = window.mealHistory.filter(m => m.date === dateStr && m.slotId === slot.id);
        
        if (slot.type === 'main') {
            // 메인 식사 (아침/점심/저녁)
            const r = records[0];
            const specificStyle = SLOT_STYLES[slot.id] || SLOT_STYLES['default'];
            
            let containerStyle = 'border: 1px solid #cbd5e1; margin: 4px 8px; margin-bottom: 7px; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05); background: rgba(255, 255, 255, 0.9);';
            let iconTextColor = specificStyle.iconText.includes('amber') ? '#d97706' : specificStyle.iconText.includes('emerald') ? '#059669' : specificStyle.iconText.includes('sky') ? '#0284c7' : '#64748b';
            
            let titleLine1 = '';
            let titleLine2 = '';
            let iconHtml = '';
            let iconBoxStyle = '';
            
            if (r) {
                if (r.mealType === 'Skip') {
                    titleLine2 = 'Skip';
                    iconBoxStyle = `background: ${photoAreaEmptyBg}; border-right: 1px solid #e2e8f0;`;
                    iconHtml = '<i class="fa-solid fa-ban" style="font-size: 24px; color: #94a3b8;"></i>';
                } else {
                    const p = r.place || '';
                    const m = r.menuDetail || r.category || '';
                    titleLine2 = escapeHtml(m || '');
                    
                    if (r.photos && Array.isArray(r.photos) && r.photos[0]) {
                        iconBoxStyle = 'border-right: 1px solid #e2e8f0;';
                        const photoUrl = String(r.photos[0]).replace(/'/g, "%27");
                        iconHtml = `<div style="width: 100%; height: 100%; min-height: 130px; background-image: url('${photoUrl}'); background-size: cover; background-position: center;" data-photo-url="${escapeHtml(r.photos[0])}"></div>`;
                    } else if (r.photos && !Array.isArray(r.photos)) {
                        iconBoxStyle = 'border-right: 1px solid #e2e8f0;';
                        const photoUrl = String(r.photos).replace(/'/g, "%27");
                        iconHtml = `<div style="width: 100%; height: 100%; min-height: 130px; background-image: url('${photoUrl}'); background-size: cover; background-position: center;" data-photo-url="${escapeHtml(r.photos)}"></div>`;
                    } else {
                        iconBoxStyle = `background: ${photoAreaEmptyBg}; border-right: 1px solid #e2e8f0;`;
                        iconHtml = `<i class="fa-solid fa-utensils" style="font-size: 24px; color: #94a3b8;"></i>`;
                    }
                }
            } else {
                titleLine2 = '';
                iconBoxStyle = `background: ${photoAreaEmptyBg}; border-right: 1px solid #e2e8f0;`;
                iconHtml = '<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 8px;"><span style="font-size: 32px; font-weight: 700; color: #94a3b8; margin-bottom: 4px;">+</span><span style="font-size: 10px; color: #94a3b8; line-height: 1.2;">입력해주세요</span></div>';
            }
            
            // 날짜 포맷팅 (베스트와 동일한 형식)
            const dateObj = r ? new Date(r.date + 'T00:00:00') : new Date(dateStr + 'T00:00:00');
            const formattedDateForCard = dateObj.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
            
            html += `
                <div style="${containerStyle} min-height: 130px;">
                    <div style="display: flex;">
                        <div style="width: 130px; min-height: 130px; ${iconBoxStyle} display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; border-radius: 12px 0 0 12px;">
                            ${iconHtml}
                        </div>
                        <div style="flex: 1; padding: 10px 12px 12px 12px; display: flex; flex-direction: column; justify-content: center; min-width: 0; min-height: 130px;">
                            <div style="font-size: 11px; color: #64748b; margin-bottom: 6px; line-height: 1.4; display: flex; align-items: center; flex-wrap: wrap; gap: 0 4px;">
                                <span style="font-weight: 700; color: ${iconTextColor};">${escapeHtml(slot.label)}</span>
                                ${r && r.place ? `<span style="color: #94a3b8; font-weight: 700;">@ ${escapeHtml(r.place)}</span>` : ''}
                                <span style="color: #cbd5e1;">·</span>
                                <span style="color: #94a3b8;">${formattedDateForCard}</span>
                            </div>
                            ${titleLine2 ? `<div style="font-size: 13px; font-weight: 700; color: #1e293b; margin-bottom: 6px; line-height: 1.3; word-break: break-word;">
                                ${titleLine2}
                            </div>` : ''}
                            ${r && r.comment ? `<div style="font-size: 11px; color: #94a3b8; margin-bottom: 8px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-style: italic; padding-bottom: 2px;">
                                "${escapeHtml(r.comment)}"
                            </div>` : ''}
                            ${r && r.rating ? `<div style="display: flex; align-items: center; justify-content: flex-start; gap: 4px; margin-top: auto; padding-top: 4px;">
                                <span style="font-size: 10px; color: #ca8a04; font-weight: 900; display: flex; align-items: center; gap: 3px; white-space: nowrap;">
                                    <span style="font-size: 11px; line-height: 1;">⭐</span>
                                    <span style="font-size: 11px; font-weight: 900; line-height: 1;">${r.rating}</span>
                                </span>
                            </div>` : ''}
                        </div>
                    </div>
                </div>
            `;
        } else {
            // 간식 슬롯 (html2canvas 베이스라인 정렬: flex + align-items: center)
            html += `
                <div style="display: flex; align-items: center; margin-bottom: 6px; padding: 4px 8px; min-height: 32px; gap: 12px;">
                    <span style="font-size: 12px; font-weight: 900; color: #1e293b; text-transform: uppercase; flex-shrink: 0; padding: 0 8px; white-space: nowrap;">${escapeHtml(slot.label)}</span>
                    <div style="flex: 1; min-width: 0; display: flex; flex-wrap: nowrap; gap: 6px; align-items: center; justify-content: center; overflow-x: auto;">
                        ${records.length > 0 ? records.map(r => `
                            <div style="display: flex; align-items: center; padding: 2.5px 5px; background: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; flex-shrink: 0; box-sizing: border-box; gap: 6px;">
                                <span style="font-size: 12px; font-weight: 600; color: #334155; word-wrap: break-word; overflow-wrap: break-word; white-space: nowrap;">${escapeHtml(r.menuDetail || r.snackType || '간식')}</span>
                                ${r.rating ? `<span style="font-size: 10px; font-weight: 900; color: #ca8a04; display: flex; align-items: center; gap: 2px; flex-shrink: 0; white-space: nowrap;">
                                    <span style="font-size: 10px; line-height: 1;">⭐</span>
                                    <span style="font-size: 10px; font-weight: 900; line-height: 1;">${r.rating}</span>
                                </span>` : ''}
                            </div>
                        `).join('') : ''}
                    </div>
                </div>
            `;
        }
    });
    
    html += `
            </div>
        </div>
    `;
    
    container.innerHTML = html;
    if (!forPreview) {
        document.body.appendChild(container);
    }
    
    return container;
}
