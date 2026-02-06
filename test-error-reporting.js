// 에러 리포팅 테스트 스크립트
// 브라우저 콘솔에서 실행하세요

console.log('🧪 에러 리포팅 테스트 시작...');

// 1. JavaScript 에러 테스트
console.log('\n1️⃣ JavaScript 에러 테스트');
setTimeout(() => {
    try {
        throw new Error('테스트 에러: JavaScript 에러 리포팅 시스템 테스트');
    } catch (e) {
        console.error('에러 발생:', e);
    }
}, 1000);

// 2. Promise rejection 테스트
console.log('\n2️⃣ Promise Rejection 테스트');
setTimeout(() => {
    Promise.reject(new Error('테스트: Promise rejection 에러'));
}, 2000);

// 3. 커스텀 에러 리포팅 테스트
console.log('\n3️⃣ 커스텀 에러 리포팅 테스트');
setTimeout(() => {
    if (window.reportError) {
        window.reportError({
            message: '테스트: 커스텀 에러 리포팅',
            type: 'test_error',
            timestamp: new Date().toISOString(),
            context: {
                test: true,
                source: 'manual_test'
            }
        });
        console.log('✅ 커스텀 에러 리포팅 호출 완료');
    } else {
        console.warn('⚠️ window.reportError 함수를 찾을 수 없습니다. 에러 리포팅 모듈이 로드되지 않았을 수 있습니다.');
    }
}, 3000);

// 4. API 에러 테스트
console.log('\n4️⃣ API 에러 리포팅 테스트');
setTimeout(() => {
    if (window.reportApiError) {
        window.reportApiError('testApi', new Error('테스트 API 에러'), { endpoint: '/test' });
        console.log('✅ API 에러 리포팅 호출 완료');
    } else {
        console.warn('⚠️ window.reportApiError 함수를 찾을 수 없습니다.');
    }
}, 4000);

console.log('\n✅ 모든 테스트가 실행되었습니다.');
console.log('📊 Firebase Console에서 에러 로그를 확인하세요:');
console.log('   https://console.firebase.google.com/project/mealog-r0/firestore/data');
console.log('   경로: artifacts/mealog-r0/errorLogs');
