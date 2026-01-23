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

