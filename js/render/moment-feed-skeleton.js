/**
 * 모먼트 피드 초기 로딩: 풀폭 슬롯 + 쉬머(그라데이션 스캔)
 */

/**
 * @param {number} count
 * @param {boolean} layoutV2
 * @param {boolean} useGalleryPostGap — 갤러리 화면2 (`#galleryPostsInsertPoint` gap 전용 셸)
 */
export function buildMomentFeedSkeletonCardsHtml(count, layoutV2, useGalleryPostGap) {
    if (!count || count < 1) return '';
    const shell =
        layoutV2 && useGalleryPostGap
            ? 'moment-feed-skeleton-card instagram-post moment-v2-gallery-post-shell mb-0'
            : layoutV2
              ? 'moment-feed-skeleton-card instagram-post mb-[3px] bg-slate-100 border-b border-slate-200'
              : 'moment-feed-skeleton-card instagram-post mb-2 bg-white border-b border-slate-200';
    const v2Attr = layoutV2 ? ' data-moment-card-layout="2"' : '';
    const innerV2 =
        layoutV2 && useGalleryPostGap
            ? `<div class="moment-feed-v2-scope flex min-w-0 flex-col w-full max-w-full overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 box-border">
        <div class="flex items-center gap-2 px-3 py-2.5 border-b border-slate-200/80">
          <div class="moment-feed-skel-base moment-feed-skel-circle h-9 w-9 flex-shrink-0 rounded-full" aria-hidden="true"></div>
          <div class="min-w-0 flex-1 space-y-2 py-0.5">
            <div class="moment-feed-skel-base h-3 w-[40%] max-w-[140px] rounded"></div>
            <div class="moment-feed-skel-base h-2.5 w-[24%] max-w-[88px] rounded"></div>
          </div>
        </div>
        <div class="moment-feed-skel-base w-full aspect-square" aria-hidden="true"></div>
        <div class="flex items-center gap-3 px-3 py-2.5 border-t border-slate-200/80">
          <div class="moment-feed-skel-base h-6 w-14 rounded-md"></div>
          <div class="moment-feed-skel-base h-6 w-14 rounded-md"></div>
          <div class="moment-feed-skel-base h-6 w-14 rounded-md"></div>
        </div>
      </div>`
            : layoutV2
              ? `<div class="px-3 py-2 border-b border-slate-200 flex items-center gap-2">
        <div class="moment-feed-skel-base h-9 w-9 rounded-full flex-shrink-0"></div>
        <div class="min-w-0 flex-1 space-y-2">
          <div class="moment-feed-skel-base h-3 w-32 rounded"></div>
          <div class="moment-feed-skel-base h-2.5 w-20 rounded"></div>
        </div>
      </div>
      <div class="moment-feed-skel-base w-full aspect-square"></div>`
              : `<div class="flex items-center gap-2 px-3 py-2 border-b border-slate-100">
        <div class="moment-feed-skel-base h-9 w-9 rounded-full flex-shrink-0"></div>
        <div class="min-w-0 flex-1 space-y-2">
          <div class="moment-feed-skel-base h-3 w-32 rounded"></div>
          <div class="moment-feed-skel-base h-2.5 w-20 rounded"></div>
        </div>
      </div>
      <div class="moment-feed-skel-base w-full aspect-square max-h-[min(100vw,520px)]"></div>
      <div class="h-3 px-3 py-2 flex gap-2">
        <div class="moment-feed-skel-base h-6 w-16 rounded"></div>
        <div class="moment-feed-skel-base h-6 w-16 rounded"></div>
      </div>`;

    let html = '';
    for (let i = 0; i < count; i++) {
        html += `<div class="${shell}"${v2Attr} aria-busy="true">${innerV2}</div>`;
    }
    return html;
}

/**
 * 스켈레톤 카드(앞에서부터)를 실제 카드로 순서대로 교체하고, 스켈레톤이 없으면 끝에 붙임.
 *
 * fragment에는 카드 사이의 공백/줄바꿈 텍스트 노드가 섞여 들어올 수 있다.
 * batchSize(카드 개수)로 교체 횟수를 세면 텍스트 노드가 카운트를 소모해 카드 순서가 뒤섞이므로
 * (예: 배치의 둘째 카드가 매번 맨 뒤로 밀려 1·3·5…, 2·4·6… 인터리빙),
 * 여기서는 **요소 노드만** 세어 스켈레톤과 1:1로 교체한다. 비요소(공백 텍스트)는 버린다.
 * @param {HTMLElement} postsInsertPoint
 * @param {DocumentFragment} fragment
 * @param {number} [batchSize] 하위 호환용(무시). 요소 노드 수만큼 자동 교체.
 */
export function replaceMomentSkeletonWithBatch(postsInsertPoint, fragment, batchSize) {
    // fragment는 처리 중 노드가 옮겨지며 비므로, 요소 노드 스냅샷을 먼저 확보한다.
    const elementNodes = Array.from(fragment.childNodes).filter((node) => node.nodeType === 1);
    for (const node of elementNodes) {
        const skel = postsInsertPoint.querySelector('.moment-feed-skeleton-card');
        if (skel) skel.replaceWith(node);
        else postsInsertPoint.appendChild(node);
    }
    // 남은 비요소 노드(공백 텍스트 등)는 레이아웃에 불필요하므로 버린다.
}

export function removeRemainingMomentSkeletons(postsInsertPoint) {
    if (!postsInsertPoint) return;
    postsInsertPoint.querySelectorAll('.moment-feed-skeleton-card').forEach((el) => el.remove());
}
