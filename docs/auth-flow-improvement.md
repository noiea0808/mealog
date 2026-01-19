# 로그인 및 사용자 관리 복잡도 개선 방안

## 개선 목표

대문(랜딩 페이지)에서의 로그인과 사용자 관리 복잡도를 낮추고, 유지보수성을 향상시키기 위한 구조적 개선 방안입니다.

## 기존 문제점

### 1. 복잡한 인증 플로우
- `main.js`의 `initAuth` 콜백이 200줄 이상으로 복잡함
- 약관 동의, 프로필 설정, 온보딩이 모두 한 곳에 섞여 있음
- 여러 플래그와 조건문으로 인한 가독성 저하

### 2. 상태 관리의 복잡도
- 여러 플래그들 (`_firstLoginChecked`, `shouldCheckFirstLogin`, `settingsLoaded` 등)
- 중복 체크 방지 로직이 복잡함
- 화면 전환 로직이 여러 곳에 분산

### 3. 모달 관리의 복호화
- 여러 모달이 서로 의존적
- 모달 표시/숨김 로직이 여러 곳에 분산

## 개선 방안

### 1. 인증 플로우 관리자 도입 (`auth-flow.js`)

**목적**: 인증 상태와 플로우를 명확하게 관리하는 중앙 집중식 관리자

**주요 기능**:
- **상태 머신 패턴**: 명확한 인증 상태 정의
  - `UNKNOWN`: 초기 상태
  - `GUEST`: 게스트 모드
  - `NEEDS_TERMS`: 약관 동의 필요
  - `NEEDS_PROFILE`: 프로필 설정 필요
  - `NEEDS_ONBOARDING`: 온보딩 필요
  - `READY`: 모든 준비 완료

- **사용자 준비 상태 체크**: `UserReadiness` 클래스로 명확한 체크
  - 약관 동의 여부
  - 프로필 설정 여부
  - 온보딩 완료 여부
  - 기존 사용자 여부 (약관 자동 동의용)

- **상태별 처리**: 각 상태에 맞는 명확한 처리 로직

### 2. main.js 단순화

**변경 전**: 200줄 이상의 복잡한 인증 콜백
**변경 후**: 
- 인증 플로우 관리자에 위임
- 설정 로드 후 자동으로 플로우 처리
- 중복 체크 로직 제거

### 3. 단계별 완료 처리

각 단계(약관 동의, 프로필 설정, 온보딩) 완료 시:
- `authFlowManager`의 해당 메서드 호출
- 다음 단계로 자동 전환
- 명확한 책임 분리

## 구조 개선 효과

### 1. 가독성 향상
- 인증 플로우가 한 곳에 집중되어 이해하기 쉬움
- 상태 전이가 명확하게 정의됨

### 2. 유지보수성 향상
- 새로운 인증 단계 추가가 쉬움
- 각 단계의 로직이 독립적으로 관리됨

### 3. 테스트 용이성
- 각 상태와 전이를 독립적으로 테스트 가능
- 모킹이 쉬운 구조

### 4. 확장성
- 새로운 인증 방법 추가가 쉬움
- 인증 단계 추가/제거가 용이함

## 사용 방법

### 인증 상태 확인
```javascript
import { authFlowManager, AuthState } from './auth-flow.js';

// 현재 상태 확인
console.log(authFlowManager.currentState);

// 상태별 처리
if (authFlowManager.currentState === AuthState.NEEDS_TERMS) {
    // 약관 동의 필요
}
```

### 단계 완료 처리
```javascript
// 약관 동의 완료 후
await authFlowManager.onTermsAgreed();

// 프로필 설정 완료 후
await authFlowManager.onProfileSetup();

// 온보딩 완료 후
await authFlowManager.onOnboardingCompleted();
```

## 마이그레이션 가이드

### 기존 코드
```javascript
// 복잡한 조건문과 플래그들
if (!termsAgreed) {
    if (isExistingUser) {
        // 약관 자동 동의
    } else {
        // 약관 모달 표시
    }
} else if (!hasProfile) {
    // 프로필 설정 모달
} else if (!onboardingCompleted) {
    // 온보딩 표시
} else {
    // 메인 화면 표시
}
```

### 개선된 코드
```javascript
// 명확한 상태 머신
const readiness = await authFlowManager.checkUserReadiness(user);
authFlowManager.currentState = readiness.nextStep;
await authFlowManager.processState(authFlowManager.currentState, readiness);
```

## 향후 개선 사항

1. **에러 처리 개선**: 중앙화된 에러 처리 로직
2. **로깅 개선**: 인증 플로우 추적을 위한 구조화된 로깅
3. **타입 안정성**: TypeScript 도입 고려
4. **단위 테스트**: 각 상태 전이에 대한 테스트 추가

## 결론

인증 플로우 관리자를 도입하여 복잡도를 크게 낮추고, 유지보수성을 향상시켰습니다. 명확한 상태 정의와 단계별 처리로 코드의 가독성과 확장성이 개선되었습니다.
