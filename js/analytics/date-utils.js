// 날짜 관련 유틸리티 함수들

// 주 범위 계산 (일요일 시작 ~ 토요일 끝)
export function getWeekRange(year, month, week) {
    const firstDay = new Date(year, month - 1, 1);
    const firstDayOfWeek = firstDay.getDay(); // 0 = 일요일
    
    // 해당 달의 첫 번째 일요일 찾기
    let firstSunday = new Date(firstDay);
    if (firstDayOfWeek !== 0) {
        firstSunday.setDate(1 - firstDayOfWeek);
    }
    
    // week번째 주의 시작일 (일요일)
    const weekStart = new Date(firstSunday);
    weekStart.setDate(firstSunday.getDate() + (week - 1) * 7);
    
    // week번째 주의 종료일 (토요일)
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    
    return { start: weekStart, end: weekEnd };
}

// 한 달의 총 주 수 계산
export function getWeeksInMonth(year, month) {
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0);
    const firstDayOfWeek = firstDay.getDay();
    const lastDayOfWeek = lastDay.getDay();
    
    const daysInMonth = lastDay.getDate();
    const daysFromFirstSunday = (7 - firstDayOfWeek) % 7;
    const fullWeeks = Math.floor((daysInMonth - daysFromFirstSunday) / 7);
    const remainingDays = (daysInMonth - daysFromFirstSunday) % 7;
    
    let totalWeeks = fullWeeks;
    if (daysFromFirstSunday > 0) totalWeeks++;
    if (remainingDays > 0 || (remainingDays === 0 && lastDayOfWeek === 6)) totalWeeks++;
    
    return totalWeeks;
}

// 현재 날짜가 해당 달의 몇 번째 주인지 계산
export function getCurrentWeekInMonth(year, month) {
    const today = new Date();
    if (today.getFullYear() !== year || today.getMonth() + 1 !== month) {
        return 1;
    }
    
    const firstDay = new Date(year, month - 1, 1);
    const firstDayOfWeek = firstDay.getDay();
    
    const firstSunday = new Date(firstDay);
    if (firstDayOfWeek !== 0) {
        firstSunday.setDate(1 - firstDayOfWeek);
    }
    
    const todayDate = today.getDate();
    const daysFromFirstSunday = Math.floor((todayDate + firstDayOfWeek - 1) / 7) * 7;
    const week = Math.floor(daysFromFirstSunday / 7) + 1;
    
    return week;
}

// 요일 이름 가져오기
export function getDayName(date) {
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    return days[date.getDay()];
}

// 날짜 형식 변환 (월.일(요일))
export function formatDateWithDay(date) {
    return `${date.getMonth() + 1}.${date.getDate()}(${getDayName(date)})`;
}

// 주 시작일(일요일)이 해당 달의 몇 번째 주인지 계산 (표시 라벨용 - 월 경계 중복 방지)
export function getWeekNumberForDate(date) {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const firstDay = new Date(year, month - 1, 1);
    const firstDayOfWeek = firstDay.getDay();

    let firstSunday = new Date(firstDay);
    if (firstDayOfWeek !== 0) {
        firstSunday.setDate(1 - firstDayOfWeek);
    }

    const dateTime = date.getTime();
    for (let w = 1; w <= 6; w++) {
        const weekStart = new Date(firstSunday);
        weekStart.setDate(firstSunday.getDate() + (w - 1) * 7);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        if (dateTime >= weekStart.getTime() && dateTime <= weekEnd.getTime()) {
            return w;
        }
    }
    return 1;
}

// 주 범위(start, end)에 대한 표시 라벨 - 주 시작일(일요일) 기준으로 월/주차 표시 (동일 기간이 1월 6주/2월 1주 등으로 중복 표시되는 문제 방지)
export function getWeekDisplayLabel(start, end) {
    const { year, month, week } = getWeekInfoFromDate(start);
    return `${year}년 ${month}월 ${week}주`;
}

// 주 시작일로부터 (year, month, week) 정보 반환 - periodKey 등 통일용
export function getWeekInfoFromDate(start) {
    const year = start.getFullYear();
    const month = start.getMonth() + 1;
    const week = getWeekNumberForDate(start);
    return { year, month, week };
}
