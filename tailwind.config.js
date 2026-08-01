/**
 * Tailwind 빌드 설정 (Play CDN 대체).
 * 산출물: css/tailwind.build.css — scripts/build-tailwind.js가 생성.
 *
 * 중요 1: 산출물은 반드시 css/style.css **뒤**에 로드해야 한다.
 *   Play CDN은 <style>을 <head> 끝에 주입해 style.css를 이기고 있었다.
 *   앞에 두면 캐스케이드가 뒤집혀 전역 스타일이 어긋난다.
 *
 * 중요 2: emerald 브랜드 팔레트 오버라이드는 의도적으로 넣지 않았다.
 *   index.html의 인라인 `tailwind.config`가 CDN 스크립트보다 먼저 실행돼
 *   ReferenceError로 죽어 왔고(CDN이 window.tailwind를 생성한다),
 *   그 결과 앱은 지금까지 stock emerald로 렌더돼 왔다.
 *   여기서 오버라이드를 켜면 emerald-* 유틸리티 301곳의 색이 한 번에 바뀐다.
 *   성능 전환과 색상 변경을 분리하기 위해 색 통일은 별도 커밋에서 다룬다.
 */
module.exports = {
    content: [
        './index.html',
        './admin.html',
        './download.html',
        './js/**/*.js'
    ],
    theme: {
        extend: {}
    },
    plugins: []
};
