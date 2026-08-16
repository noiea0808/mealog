// 유틸리티 함수들
import { storage } from './firebase.js';
import { ref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js";

// 프로덕션 환경 감지 (localhost 또는 127.0.0.1이 아니면 프로덕션)
const isProduction = () => {
    const hostname = window.location.hostname;
    return hostname !== 'localhost' && hostname !== '127.0.0.1' && !hostname.includes('192.168.');
};

/**
 * 스테이징/운영 구분 (푸시·콘텐츠 팝업·연속기록 팝업 등과 동일 기준)
 * — 네이티브(설치형)는 빌드 확정 APP_ENV, 웹은 APP_ENV·호스트.
 */
export function getMealogClientEnv() {
    if (typeof window === 'undefined') return 'production';

    const appEnv = String(window.APP_ENV || '').toLowerCase();
    const hostname = (window.location.hostname || '').toLowerCase();
    const capAppId = String(window.Capacitor?.config?.appId || '').trim();

    // Capacitor 가 config 를 주입하는 경우에만(폴백)
    if (capAppId === 'com.mealog.app.staging') return 'staging';
    if (capAppId === 'com.mealog.app') return 'production';

    try {
        const cap = window.Capacitor;
        if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
            /*
             * 설치형 앱은 WebView 호스트가 localhost 이지만 운영/스테이징이 아님.
             * config.appId 도 주입되지 않으므로 빌드시 확정되는 APP_ENV 로 판별.
             */
            if (appEnv === 'staging') return 'staging';
            if (appEnv === 'production') return 'production';
            // server.url 원격 로드 WebView 폴백
            if (hostname.includes('staging')) return 'staging';
            return hostname === 'www.mealog.net' || hostname === 'mealog.net' ? 'production' : 'staging';
        }
    } catch (e) {
        /* ignore */
    }

    if (appEnv === 'staging') return 'staging';
    if (hostname.includes('staging')) return 'staging';
    const isLocal =
        hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.startsWith('192.168.');
    if (isLocal) return 'staging';
    return 'production';
}

// 프로덕션에서 console.log 제거를 위한 래퍼 함수
export const logger = {
    log: (...args) => {
        if (!isProduction()) {
            console.log(...args);
        }
    },
    warn: (...args) => {
        if (!isProduction()) {
            console.warn(...args);
        }
    },
    error: (...args) => {
        // error는 프로덕션에서도 표시 (중요한 에러 추적)
        console.error(...args);
    },
    info: (...args) => {
        if (!isProduction()) {
            console.info(...args);
        }
    }
};

export function setVal(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
}

/**
 * 앱 첫 기동 시 한글 IME가 준비되지 않아 텍스트가 보이지 않는 현상을 완화합니다.
 * Capacitor 네이티브 앱에서만 실행하며, 숨겨진 input에 잠시 포커스했다 blur하여 IME를 워밍업합니다.
 */
export function warmUpIME() {
    if (typeof window === 'undefined' || !window.Capacitor?.isNativePlatform?.()) return;
    const el = document.getElementById('imeWarmupInput');
    if (!el) return;
    try {
        el.focus();
        setTimeout(() => {
            el.blur();
        }, 80);
    } catch (_) { /* 무시 */ }
}

/** 밀톡 말풍선 롱프레스 등 짧은 촉각 — 앱은 Impact Light, 웹은 Vibration API(약 12ms) */
export function lightUiHaptic() {
    const Haptics = typeof window !== 'undefined' ? window.Capacitor?.Plugins?.Haptics : null;
    if (Haptics?.impact) {
        Haptics.impact({ style: 'LIGHT' }).catch(() => {
            try {
                navigator.vibrate?.(12);
            } catch (_) { /* ignore */ }
        });
        return;
    }
    try {
        if (navigator.vibrate) navigator.vibrate(12);
    } catch (_) { /* ignore */ }
}

/**
 * 한글 등 IME 조합 중일 때 input 핸들러 실행을 지연시킵니다.
 * 모바일에서 조합 중 DOM 업데이트가 텍스트 미표시 문제를 일으키는 것을 방지합니다.
 * @param {HTMLInputElement|HTMLTextAreaElement|HTMLElement} el - input/textarea/contenteditable 요소
 * @param {() => void} handler - input 시 실행할 핸들러 (조합 중에는 실행 안 함)
 */
export function addCompositionAwareInput(el, handler) {
    if (!el) return;
    let isComposing = false;
    let pendingUpdate = false;
    const runHandler = () => {
        if (isComposing) {
            pendingUpdate = true;
            return;
        }
        handler();
    };
    el.addEventListener('compositionstart', () => { isComposing = true; });
    el.addEventListener('compositionend', () => {
        isComposing = false;
        if (pendingUpdate) {
            pendingUpdate = false;
            handler();
        }
    });
    el.addEventListener('input', runHandler);
}

// URL 정규화 함수 (쿼리 파라미터 제거) - 중복 제거
export function normalizeUrl(url) {
    if (!url || typeof url !== 'string') return '';
    return url.split('?')[0];
}

/**
 * 표시용 프로필 반환: 작성자가 현재 로그인 사용자이면 현재 프로필을 사용하고,
 * 다른 사용자이면 프로필 캐시(최신) 또는 저장된 값을 사용합니다.
 * 과거 게시물도 항상 현재 설정된 프로필(아이콘/닉네임)으로 표시됩니다.
 * @param {string} authorId - 작성자 userId
 * @param {{ nickname?: string, icon?: string, photoUrl?: string }} stored - 게시물에 저장된 프로필 (캐시 없을 때 fallback)
 * @param {{ preferStoredNickname?: boolean }} [options] - 댓글 등: 문서에 스냅샷된 닉네임을 캐시·최신 프로필보다 우선 (탈퇴 후에도 표시 유지)
 * @returns {{ nickname: string, icon: string|null, photoUrl: string|null }}
 */
export function getDisplayProfile(authorId, stored = {}, options = {}) {
    const preferStored = options.preferStoredNickname === true;
    const storedNick =
        stored.nickname != null && String(stored.nickname).trim() !== '' ? String(stored.nickname).trim() : '';

    const isCurrentUser = typeof window !== 'undefined' && window.currentUser && authorId === window.currentUser.uid;
    const profile = window?.userSettings?.profile;

    // 댓글 스냅샷: 탈퇴·설정 삭제 후에도 Firestore 댓글 문서의 닉네임만 보이게 (캐시가 카카오 실명 등으로 덮이지 않도록)
    if (preferStored && storedNick) {
        return {
            nickname: storedNick,
            icon: stored.icon ?? null,
            photoUrl: stored.photoUrl ?? null
        };
    }

    if (isCurrentUser && profile) {
        return {
            nickname: profile.nickname || stored.nickname || '익명',
            icon: profile.icon ?? stored.icon ?? null,
            photoUrl: profile.photoUrl ?? stored.photoUrl ?? null
        };
    }
    // 다른 사용자: 프로필 캐시에 최신 데이터가 있으면 사용 (없으면 저장된 값 fallback)
    const cached = typeof window !== 'undefined' && window.userProfileCache?.get?.(authorId);
    if (cached) {
        return {
            nickname: cached.nickname || stored.nickname || '익명',
            icon: cached.icon ?? stored.icon ?? null,
            photoUrl: cached.photoUrl ?? stored.photoUrl ?? null
        };
    }
    return {
        nickname: stored.nickname || '익명',
        icon: stored.icon ?? null,
        photoUrl: stored.photoUrl ?? null
    };
}

/**
 * 프로필 아바타에 표시할 내용 반환 (사진 > 사용자 지정 이모지 > 닉네임 첫 글자)
 * 기본 동물 아이콘(🐻 등)은 예전 기본값이므로 미설정으로 간주합니다.
 * @param {{ nickname?: string, icon?: string|null, photoUrl?: string|null }} profile - getDisplayProfile 결과
 * @returns {{ type: 'photo'|'emoji'|'initial', value: string }}
 */
const DEFAULT_AVATAR_ICONS = ['🐻', '🐰', '🐱', '🐶', '🦊', '🦁', '🐼', '🐨'];

/** 닉네임 첫 글자(서로게이트 쌍 이모지 등은 첫 문자 단위) */
export function getProfileNicknameInitial(nickname) {
    const nick = nickname != null ? String(nickname).trim() : '';
    if (!nick) return '?';
    const ch = [...nick][0];
    return ch || '?';
}

/** 아바타 원 안에 텍스트(이모지·이니셜)로 표시하는 타입인지 */
export function profileAvatarShowsText(type) {
    return type === 'emoji' || type === 'initial';
}

export function getProfileAvatarDisplay(profile) {
    const photoRaw = profile.photoUrl != null ? String(profile.photoUrl).trim() : '';
    if (photoRaw) return { type: 'photo', value: photoRaw };
    const icon = profile.icon != null && profile.icon !== '' ? profile.icon : null;
    if (icon && !DEFAULT_AVATAR_ICONS.includes(icon)) return { type: 'emoji', value: icon };
    return { type: 'initial', value: getProfileNicknameInitial(profile.nickname) };
}

import { getInputIdForSuggestionsContainer } from './modals/entry-form-config.js';

export function getInputIdFromContainer(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return null;
    const mapped = getInputIdForSuggestionsContainer(containerId);
    if (mapped) return mapped;
    const dataId = container.getAttribute('data-input-id');
    if (dataId) return dataId;
    return null;
}

// 뷰포트 기반 최대/최소 너비 (레티나 2배, 상한 1200px)
function getViewportMaxWidth() {
    const vw = typeof window !== 'undefined' ? (window.innerWidth || 390) : 390;
    return Math.min(1200, vw * 2);
}
function getViewportMinWidth() {
    const vw = typeof window !== 'undefined' ? (window.innerWidth || 390) : 390;
    return Math.max(400, vw);
}

// 이미지를 압축하여 Blob으로 변환 (Storage 업로드용) - 뷰포트 기반 최적화
export function compressImageToBlob(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const reader = new FileReader();
        
        reader.onload = (e) => {
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                
                const targetSizeKB = 600;
                const targetSizeBytes = targetSizeKB * 1024;
                const maxInitialWidth = getViewportMaxWidth();
                const minWidth = getViewportMinWidth();
                
                let width = img.width;
                let height = img.height;
                
                if (width > maxInitialWidth) {
                    height = (height / width) * maxInitialWidth;
                    width = maxInitialWidth;
                }
                
                canvas.width = width;
                canvas.height = height;
                ctx.drawImage(img, 0, 0, width, height);
                
                let quality = 0.6;
                let attempts = 0;
                const maxAttempts = 8;
                
                const compress = () => {
                    attempts++;
                    canvas.toBlob((blob) => {
                        if (!blob) {
                            reject(new Error('이미지 압축 실패'));
                            return;
                        }
                        if (blob.size <= targetSizeBytes || attempts >= maxAttempts) {
                            resolve(blob);
                            return;
                        }
                        quality = Math.max(0.2, quality - 0.15);
                        if (width > minWidth && blob.size > targetSizeBytes * 1.2) {
                            width = Math.max(minWidth, Math.floor(width * 0.85));
                            height = Math.floor((height / canvas.width) * width);
                            canvas.width = width;
                            canvas.height = height;
                            ctx.drawImage(img, 0, 0, width, height);
                        }
                        compress();
                    }, 'image/jpeg', quality);
                };
                
                compress();
            };
            
            img.onerror = () => {
                reject(new Error('이미지 로드 실패'));
            };
            
            img.src = e.target.result;
        };
        
        reader.onerror = () => {
            reject(new Error('파일 읽기 실패'));
        };
        
        reader.readAsDataURL(file);
    });
}

/** 캐릭터 이미지용: PNG 투명 배경 보존 (JPEG 변환 시 투명 영역이 검은색으로 나오는 문제 방지) */
export function compressImageToBlobPreserveTransparency(file) {
    return new Promise((resolve, reject) => {
        if (!file.type.startsWith('image/')) {
            reject(new Error('이미지 파일이 아닙니다'));
            return;
        }
        const img = new Image();
        const reader = new FileReader();
        reader.onload = (e) => {
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                const maxWidth = 512;
                let width = img.width;
                let height = img.height;
                if (width > maxWidth) {
                    height = (height / width) * maxWidth;
                    width = maxWidth;
                }
                canvas.width = width;
                canvas.height = height;
                ctx.drawImage(img, 0, 0, width, height);
                canvas.toBlob((blob) => {
                    if (!blob) reject(new Error('이미지 변환 실패'));
                    else resolve(blob);
                }, file.type === 'image/png' ? 'image/png' : 'image/jpeg', file.type === 'image/png' ? 0.9 : 0.85);
            };
            img.onerror = () => reject(new Error('이미지 로드 실패'));
            img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error('파일 읽기 실패'));
        reader.readAsDataURL(file);
    });
}

/** 밀톡/공지용: 최대 용량 제한 압축 (장당 600KB 이하). 초과 시 에러 throw */
export function compressImageToBlobMaxSize(file, maxSizeKB = 600) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const reader = new FileReader();
        const targetSizeBytes = maxSizeKB * 1024;

        reader.onload = (e) => {
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                const maxInitialWidth = getViewportMaxWidth();
                const minWidth = getViewportMinWidth();

                let width = img.width;
                let height = img.height;

                if (width > maxInitialWidth) {
                    height = (height / width) * maxInitialWidth;
                    width = maxInitialWidth;
                }

                canvas.width = width;
                canvas.height = height;
                ctx.drawImage(img, 0, 0, width, height);

                let quality = 0.6;
                let attempts = 0;
                const maxAttempts = 12;

                const compress = () => {
                    attempts++;
                    canvas.toBlob((blob) => {
                        if (!blob) {
                            reject(new Error('이미지 압축 실패'));
                            return;
                        }
                        if (blob.size <= targetSizeBytes || attempts >= maxAttempts) {
                            if (blob.size > targetSizeBytes) {
                                reject(new Error(`이미지 용량이 ${maxSizeKB}KB를 초과합니다. 다른 사진을 선택해 주세요.`));
                                return;
                            }
                            resolve(blob);
                            return;
                        }
                        quality = Math.max(0.15, quality - 0.1);
                        if (width > minWidth && blob.size > targetSizeBytes * 1.1) {
                            width = Math.max(minWidth, Math.floor(width * 0.85));
                            height = Math.floor((height / canvas.width) * width);
                            canvas.width = width;
                            canvas.height = height;
                            ctx.drawImage(img, 0, 0, width, height);
                        }
                        compress();
                    }, 'image/jpeg', quality);
                };

                compress();
            };

            img.onerror = () => reject(new Error('이미지 로드 실패'));
            img.src = e.target.result;
        };

        reader.onerror = () => reject(new Error('파일 읽기 실패'));
        reader.readAsDataURL(file);
    });
}

// base64 데이터 URL을 Blob으로 변환
export function base64ToBlob(base64DataUrl) {
    return new Promise((resolve, reject) => {
        try {
            // data:image/jpeg;base64,/9j/4AAQ... 형식에서 실제 데이터 추출
            const parts = base64DataUrl.split(',');
            if (parts.length !== 2) {
                reject(new Error('Invalid base64 data URL format'));
                return;
            }
            
            const mimeMatch = base64DataUrl.match(/data:([^;]+);base64/);
            const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
            
            // base64 디코딩
            const base64Data = parts[1];
            const byteCharacters = atob(base64Data);
            const byteNumbers = new Array(byteCharacters.length);
            
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: mimeType });
            
            resolve(blob);
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * 공유 캡처 clone 보정 — 이미지·아이콘·table 셀에 고정 px를 강제해
 * 미리보기와 캡처 PNG의 정렬 오차를 줄인다.
 * @param {Document|HTMLElement} root
 */
export function normalizeShareCaptureClone(root) {
    const doc = root?.querySelector ? root : root?.documentElement ? root : null;
    const scope = doc || root;
    if (!scope?.querySelectorAll) return;

    scope.querySelectorAll('.share-cap-thumb__img').forEach((img) => {
        const isBest = !!img.closest('.best-share-capture__sheet, .share-cap-row--best');
        const w = Number.parseInt(img.getAttribute('width'), 10) || (isBest ? 87 : 92);
        const h = Number.parseInt(img.getAttribute('height'), 10) || w;
        img.setAttribute('width', String(w));
        img.setAttribute('height', String(h));
        img.style.width = `${w}px`;
        img.style.height = `${h}px`;
        img.style.maxWidth = `${w}px`;
        img.style.maxHeight = `${h}px`;
        img.style.objectFit = 'cover';
        img.style.display = 'block';
        img.style.border = '0';
        img.style.verticalAlign = 'top';
    });

    scope.querySelectorAll('.share-cap-thumb').forEach((el) => {
        const isBest = !!el.closest('.best-share-capture__sheet, .share-cap-row--best');
        const s = isBest ? 87 : 92;
        el.style.width = `${s}px`;
        el.style.height = `${s}px`;
        el.style.overflow = 'hidden';
        el.style.display = 'block';
        el.style.position = 'relative';
        if (!isBest) {
            el.style.borderRadius = '13px 0 0 13px';
            el.style.margin = '0';
        } else {
            el.style.borderRadius = '12px';
        }
    });
    scope.querySelectorAll('.daily-share-capture__sheet .share-cap-cell--thumb').forEach((el) => {
        el.style.padding = '0';
        el.style.width = '92px';
        el.style.height = '92px';
        el.style.verticalAlign = 'top';
    });
    scope.querySelectorAll('.best-share-capture__sheet .share-cap-cell--thumb').forEach((el) => {
        el.style.padding = '7px 0';
        el.style.width = '99px';
        el.style.verticalAlign = 'top';
    });

    scope.querySelectorAll('.share-cap-row__inner').forEach((el) => {
        el.style.display = 'table';
        el.style.width = '100%';
        el.style.tableLayout = 'fixed';
        el.style.borderCollapse = 'separate';
        el.style.borderSpacing = '0';
    });
    scope.querySelectorAll('.best-share-capture__sheet .share-cap-row__inner--best').forEach((el) => {
        el.style.height = '101px';
    });

    // vertical-align: middle은 html2canvas가 다르게 계산해 텍스트가 아래로 잠김 → top + CSS padding-top 고정
    scope.querySelectorAll('.share-cap-cell').forEach((el) => {
        el.style.display = 'table-cell';
        el.style.verticalAlign = 'top';
    });
    scope.querySelectorAll('.share-cap-cell--text').forEach((el) => {
        el.style.overflow = 'visible';
        el.style.paddingBottom = '12px';
    });
    scope.querySelectorAll('.best-share-capture__sheet .share-cap-cell--text').forEach((el) => {
        el.style.paddingTop = '28px';
        el.style.paddingBottom = '12px';
    });
    scope.querySelectorAll('.share-cap-meta').forEach((el) => {
        el.style.lineHeight = '18px';
        el.style.paddingBottom = '3px';
    });
    scope.querySelectorAll('.share-cap-title').forEach((el) => {
        el.style.lineHeight = '22px';
        el.style.paddingBottom = '5px';
    });
    scope.querySelectorAll('.share-cap-row').forEach((el) => {
        el.style.overflow = 'visible';
    });

    // 헤더 타이틀(mealog 행)만 10px 위로 — 헤더 높이·다른 요소는 그대로
    scope.querySelectorAll('.daily-share-capture__brand-row, .best-share-capture__brand-row').forEach((el) => {
        el.style.position = 'relative';
        el.style.top = '-10px';
    });

    scope.querySelectorAll('.share-cap-icon svg, .share-cap-icon i, .share-cap-icon .lucide').forEach((el) => {
        el.style.width = '18px';
        el.style.height = '18px';
        el.setAttribute('width', '18');
        el.setAttribute('height', '18');
        if (el.tagName === 'svg' || el.tagName === 'SVG') {
            el.style.display = 'inline-block';
            el.style.verticalAlign = 'middle';
        }
    });
    scope.querySelectorAll('.share-cap-thumb--empty svg, .share-cap-thumb--empty i, .share-cap-thumb--empty .lucide').forEach((el) => {
        const isBest = !!el.closest('.best-share-capture__sheet, .share-cap-row--best');
        const s = isBest ? 32 : 28;
        el.style.width = `${s}px`;
        el.style.height = `${s}px`;
        el.setAttribute('width', String(s));
        el.setAttribute('height', String(s));
        el.style.display = 'inline-block';
        el.style.verticalAlign = 'middle';
        el.style.color = '#a8a29e';
    });
}

/**
 * 캔버스를 흰 배경 위에 합성한다.
 *
 * snapdom 출력은 알파를 보존하므로 둥근 모서리 바깥이 투명하다. 이후 파이프라인
 * (compressBase64ToBlob 의 JPEG 변환 등)에서 투명 영역이 검게 뭉개질 수 있어,
 * html2canvas 시절의 `backgroundColor: '#ffffff'` 와 동일한 결과로 맞춘다.
 */
function flattenCanvasOnWhite(canvas) {
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);
    return out;
}

/**
 * 유령 노드용 조상 컨텍스트 래퍼 체인.
 *
 * 시트만 복제하면 `#dailyShareCardContainer .main-slot-card-group` 같은 조상 스코프
 * CSS 규칙이 유령에서 빠져 프리뷰와 간격이 달라진다(행마다 어긋남이 누적된다).
 * 그래서 body 까지의 조상 id/class 를 그대로 단 래퍼를 만들어 셀렉터 매칭은 살리되,
 * 인라인 오버라이드로 레이아웃 영향(모달 position/transform/스크롤 등)은 전부 죽인다 —
 * 유령 전략의 목적인 "부모 간섭 없는 캡처"는 유지된다.
 *
 * @param {HTMLElement} originalElement
 * @returns {HTMLElement[]} 바깥쪽부터 안쪽 순서의 래퍼 배열 (조상이 없으면 빈 배열)
 */
function buildGhostAncestorWrappers(originalElement) {
    const NEUTRALIZE =
        ';display:block;position:static;transform:none;margin:0;padding:0;border:0;' +
        'width:auto;height:auto;max-width:none;max-height:none;min-width:0;min-height:0;' +
        'inset:auto;flex:none;overflow:visible;visibility:visible;opacity:1;';
    const wrappers = [];
    let node = originalElement.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
        const w = document.createElement('div');
        if (node.id) w.id = node.id;
        if (typeof node.className === 'string' && node.className) w.className = node.className;
        // 인라인 스타일은 유지(폰트 등 상속값 보존)하되, 레이아웃 속성은 뒤의 선언이 덮는다
        w.style.cssText = (node.getAttribute('style') || '') + NEUTRALIZE;
        wrappers.unshift(w);
        node = node.parentElement;
    }
    return wrappers;
}

/**
 * 유령 캡처(Ghost Capture): 화면 밖에 복제본을 만들어 부모 간섭(모달, transform, Flex/Grid) 없이 캡처
 *
 * ── 엔진 이원화 (2026-08) ─────────────────────────────────────────────────────
 * 기본 엔진은 snapdom(SVG foreignObject) — 프리뷰를 그린 것과 **같은 브라우저 엔진**이
 * 캡처도 그리므로 텍스트 잘림·정렬 밀림이 원천적으로 없다. 따라서 snapdom 경로에서는
 * 순수 클론을 그대로 캡처하고 어떤 보정도 하지 않는다(보정하면 오히려 틀어진다).
 *
 * html2canvas 는 CSS 를 자체 해석해 그리는 별도 렌더러라 오차가 있고, 그 오차를 상쇄하는
 * 층이 `normalizeShareCaptureClone` + 호출부 `onclone` 보정이다. 이 보정 일체는
 * **폴백 경로에서만** 적용한다. snapdom 이 없거나(CDN 차단 등) 실패했을 때 공유 기능이
 * 통째로 죽는 것보다 약간 어긋난 캡처가 낫다는 판단으로 폴백을 유지한다.
 *
 * @param {HTMLElement} originalElement - 캡처할 원본 요소
 * @param {Object} options - 캡처 옵션 (+ html2canvas 폴백용 추가 옵션)
 * @param {number} [options.captureWidth=420] - 캡처 가로 크기 (정사이즈 고정)
 * @param {number} [options.scale=3] - 출력 배율 (양 엔진 공통)
 * @param {Function} [options.prepareGhost] - 유령 노드 DOM 조정(버튼 숨김 등). 엔진 무관하게 항상 적용
 * @param {Function} [options.onclone] - html2canvas 폴백 전용 보정 (snapdom 경로에서는 호출되지 않음)
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function captureWithGhostStrategy(originalElement, options = {}) {
    const { captureWidth = 420, scale = 3, prepareGhost, onclone: userOnClone, ...html2canvasOptions } = options;

    const ghostNode = originalElement.cloneNode(true);
    ghostNode.style.width = `${captureWidth}px`;
    ghostNode.style.height = 'auto';
    ghostNode.style.transform = 'none';
    ghostNode.style.margin = '0';

    // 조상 id/class 컨텍스트를 보존한 래퍼 체인 안에 유령을 넣는다 (없으면 유령이 곧 루트)
    const wrappers = buildGhostAncestorWrappers(originalElement);
    let ghostRoot = ghostNode;
    if (wrappers.length > 0) {
        for (let i = 0; i < wrappers.length - 1; i++) wrappers[i].appendChild(wrappers[i + 1]);
        wrappers[wrappers.length - 1].appendChild(ghostNode);
        ghostRoot = wrappers[0];
    }
    ghostRoot.style.position = 'fixed';
    ghostRoot.style.top = '-10000px';
    ghostRoot.style.left = '-10000px';
    ghostRoot.style.zIndex = '-1';

    document.body.appendChild(ghostRoot);
    if (typeof prepareGhost === 'function') prepareGhost(ghostNode);

    try {
        await document.fonts.ready;

        // 1) snapdom — 브라우저 엔진 렌더링. 보정 없이 프리뷰와 동일하게 나온다.
        const snapdomFunc = typeof window !== 'undefined' ? window.snapdom : null;
        if (snapdomFunc?.toCanvas) {
            try {
                const canvas = await snapdomFunc.toCanvas(ghostNode, {
                    scale,
                    dpr: 1, // 기기 DPR 과 무관하게 출력 크기를 captureWidth×scale 로 고정
                    embedFonts: true,
                });
                return flattenCanvasOnWhite(canvas);
            } catch (e) {
                console.warn('[capture] snapdom 실패 — html2canvas 폴백:', e?.message || e);
            }
        } else {
            console.warn('[capture] snapdom 미로드 — html2canvas 폴백');
        }

        // 2) html2canvas 폴백 — 자체 렌더러 오차를 legacy 보정으로 상쇄한다.
        const html2canvasFunc = (typeof window !== 'undefined' && window.html2canvas) || (typeof html2canvas !== 'undefined' ? html2canvas : null);
        if (!html2canvasFunc) throw new Error('캡처 엔진을 찾을 수 없습니다 (snapdom·html2canvas 모두 미로드).');

        normalizeShareCaptureClone(ghostNode);
        const canvas = await html2canvasFunc(ghostNode, {
            scale,
            useCORS: true,
            backgroundColor: '#ffffff',
            logging: false,
            windowWidth: captureWidth,
            allowTaint: true,
            fontEmbedCSS: true,
            ...html2canvasOptions,
            onclone: (clonedDoc, element) => {
                normalizeShareCaptureClone(clonedDoc);
                if (typeof userOnClone === 'function') userOnClone(clonedDoc, element);
            },
        });
        return canvas;
    } finally {
        document.body.removeChild(ghostRoot);
    }
}

// base64 이미지를 압축하여 Blob으로 변환 (마이그레이션용) - 뷰포트 기반
// maxSizeKB: 목표 최대 용량(KB). 캡쳐3종은 1024(1MB), initialQuality 0.9로 선명도 향상
export function compressBase64ToBlob(base64DataUrl, maxSizeKB = 500, initialQuality = 0.7) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            const targetSizeKB = maxSizeKB;
            const targetSizeBytes = targetSizeKB * 1024;
            // 캡쳐3종(1MB): scale 3 출력(1260px) 보존. 그 외: 뷰포트 기반
            const maxInitialWidth = maxSizeKB >= 1024 ? 1260 : getViewportMaxWidth();
            const minWidth = getViewportMinWidth();
            
            let width = img.width;
            let height = img.height;
            
            if (width > maxInitialWidth) {
                height = (height / width) * maxInitialWidth;
                width = maxInitialWidth;
            }
            
            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(img, 0, 0, width, height);
            
            let quality = initialQuality;
            
            const compress = () => {
                canvas.toBlob((blob) => {
                    if (!blob) {
                        reject(new Error('이미지 압축 실패'));
                        return;
                    }
                    if (blob.size > targetSizeBytes && quality > 0.1) {
                        quality -= 0.1;
                        if (quality < 0.1) quality = 0.1;
                        if (width > minWidth && blob.size > targetSizeBytes) {
                            width = Math.max(minWidth, Math.floor(width * 0.9));
                            height = Math.floor((height / canvas.width) * width);
                            canvas.width = width;
                            canvas.height = height;
                            ctx.drawImage(img, 0, 0, width, height);
                        }
                        compress();
                    } else {
                        resolve(blob);
                    }
                }, 'image/jpeg', quality);
            };
            
            compress();
        };
        
        img.onerror = () => {
            reject(new Error('이미지 로드 실패'));
        };
        
        img.src = base64DataUrl;
    });
}

/** 캐릭터 이미지 업로드: PNG 투명 배경 보존 */
export async function uploadPersonaImageToStorage(file, userId, characterId) {
    try {
        const compressedBlob = await compressImageToBlobPreserveTransparency(file);
        const ext = file.type === 'image/png' ? 'png' : 'jpg';
        const timestamp = Date.now();
        const randomStr = Math.random().toString(36).substring(2, 9);
        const fileName = `${timestamp}_${randomStr}.${ext}`;
        const path = `users/${userId}/persona/${characterId || 'temp'}/${fileName}`;
        const storageRef = ref(storage, path);
        await uploadBytes(storageRef, compressedBlob);
        return await getDownloadURL(storageRef);
    } catch (error) {
        console.error('캐릭터 이미지 업로드 실패:', error);
        throw error;
    }
}

// Firebase Storage에 이미지 업로드
export async function uploadImageToStorage(file, userId, entryId = null) {
    try {
        // 이미지 압축
        const compressedBlob = await compressImageToBlob(file);
        
        // 파일명 생성 (타임스탬프 + 랜덤 문자열)
        const timestamp = Date.now();
        const randomStr = Math.random().toString(36).substring(2, 9);
        const fileName = `${timestamp}_${randomStr}.jpg`;
        
        // Storage 경로 설정
        const path = entryId 
            ? `users/${userId}/meals/${entryId}/${fileName}`
            : `users/${userId}/temp/${fileName}`;
        
        const storageRef = ref(storage, path);
        
        // 업로드
        await uploadBytes(storageRef, compressedBlob);
        
        // 다운로드 URL 가져오기
        const downloadURL = await getDownloadURL(storageRef);
        
        return downloadURL;
    } catch (error) {
        console.error('이미지 업로드 실패:', error);
        throw error;
    }
}

/**
 * dataURL을 긴 변 기준 maxEdge로 리사이즈한 JPEG Blob 생성.
 * 용량(maxKB)은 주된 기준이 아니라 보조 안전장치 — 목표 초과 시 품질만 소폭 낮춘다(해상도 유지 우선).
 */
function resizeDataUrlToBlob(dataUrl, { maxEdge, quality = 0.8, maxKB = 0 } = {}) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            try {
                let width = img.width;
                let height = img.height;
                const longEdge = Math.max(width, height);
                if (maxEdge && longEdge > maxEdge) {
                    const scale = maxEdge / longEdge;
                    width = Math.max(1, Math.round(width * scale));
                    height = Math.max(1, Math.round(height * scale));
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                let q = quality;
                const attempt = () => {
                    canvas.toBlob(
                        (blob) => {
                            if (!blob) {
                                reject(new Error('파생본 생성 실패'));
                                return;
                            }
                            // 용량은 보조 안전장치: 목표 초과 시 품질만 하한(0.5)까지 소폭 인하
                            if (maxKB && blob.size > maxKB * 1024 && q > 0.5) {
                                q = Math.max(0.5, q - 0.08);
                                attempt();
                                return;
                            }
                            resolve(blob);
                        },
                        'image/jpeg',
                        q
                    );
                };
                attempt();
            } catch (e) {
                reject(e);
            }
        };
        img.onerror = () => reject(new Error('파생본용 이미지 로드 실패'));
        img.src = dataUrl;
    });
}

/** 리사이즈 파생본을 meals 경로에 업로드하고 다운로드 URL 반환 */
async function uploadResizedVariant(dataUrl, userId, entryId, { maxEdge, quality, maxKB, variant }) {
    const blob = await resizeDataUrlToBlob(dataUrl, { maxEdge, quality, maxKB });
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 9);
    const fileName = `${timestamp}_${randomStr}_${variant}.jpg`;
    const path = entryId
        ? `users/${userId}/meals/${entryId}/${fileName}`
        : `users/${userId}/temp/${fileName}`;
    const storageRef = ref(storage, path);
    await uploadBytes(storageRef, blob);
    return getDownloadURL(storageRef);
}

/**
 * 식사 사진 1장을 원본 + 표시용(800px) + 썸네일(200px)로 업로드.
 * - 원본 업로드는 필수(실패 시 throw). 파생본은 best-effort — 실패해도 ''로 두어 원본 fallback.
 * - 원본/파생본을 병렬 업로드해 저장 지연을 최소화한다.
 * @returns {Promise<{url:string, displayUrl:string, thumbUrl:string}>}
 */
export async function uploadMealPhotoVariants(dataUrl, userId, entryId) {
    const [origRes, dispRes, thumbRes] = await Promise.allSettled([
        uploadBase64ToStorage(dataUrl, userId, entryId),
        uploadResizedVariant(dataUrl, userId, entryId, {
            maxEdge: 800,
            quality: 0.8,
            maxKB: 300,
            variant: 'd'
        }),
        uploadResizedVariant(dataUrl, userId, entryId, {
            maxEdge: 200,
            quality: 0.75,
            maxKB: 60,
            variant: 't'
        })
    ]);
    if (origRes.status !== 'fulfilled' || !origRes.value) {
        throw origRes.reason || new Error('원본 이미지 업로드 실패');
    }
    if (dispRes.status !== 'fulfilled') {
        console.warn('display(800px) 파생본 실패 — 원본 사용:', dispRes.reason);
    }
    if (thumbRes.status !== 'fulfilled') {
        console.warn('thumb(200px) 파생본 실패 — 상위 해상도 사용:', thumbRes.reason);
    }
    return {
        url: origRes.value,
        displayUrl: dispRes.status === 'fulfilled' ? dispRes.value || '' : '',
        thumbUrl: thumbRes.status === 'fulfilled' ? thumbRes.value || '' : ''
    };
}

// base64 데이터 URL의 바이트 크기 계산 (패딩 제외)
function getBase64ByteSize(dataUrl) {
    const base64Data = (dataUrl && dataUrl.indexOf(',') >= 0) ? dataUrl.split(',')[1] : dataUrl;
    if (!base64Data) return 0;
    const paddingCount = (base64Data.match(/=/g) || []).length;
    return Math.floor(((base64Data.length - paddingCount) * 3) / 4);
}

// base64 이미지를 Storage에 업로드 (마이그레이션용)
// maxSizeKB: 압축 목표 최대 용량(KB). 캡쳐3종은 1024(1MB), initialQuality 0.9로 선명도 향상
// 이미 목표 이하인 base64는 재압축하지 않음 → 모달에서 400KB로 압축된 사진의 이중 압축 방지(화질 저하 완화)
export async function uploadBase64ToStorage(base64DataUrl, userId, entryId, maxSizeKB = 500) {
    try {
        const targetSizeBytes = maxSizeKB * 1024;
        const currentSize = getBase64ByteSize(base64DataUrl);
        const compressedBlob = currentSize > 0 && currentSize <= targetSizeBytes
            ? await base64ToBlob(base64DataUrl)
            : await (async () => {
                const initialQuality = maxSizeKB >= 1024 ? 0.9 : 0.7;
                return compressBase64ToBlob(base64DataUrl, maxSizeKB, initialQuality);
            })();
        
        // 파일명 생성 (타임스탬프 + 랜덤 문자열)
        const timestamp = Date.now();
        const randomStr = Math.random().toString(36).substring(2, 9);
        const fileName = `${timestamp}_${randomStr}.jpg`;
        
        // Storage 경로 설정
        const path = entryId 
            ? `users/${userId}/meals/${entryId}/${fileName}`
            : `users/${userId}/migrated/${fileName}`;
        
        const storageRef = ref(storage, path);
        
        // 업로드
        await uploadBytes(storageRef, compressedBlob);
        
        // 다운로드 URL 가져오기
        const downloadURL = await getDownloadURL(storageRef);
        
        return downloadURL;
    } catch (error) {
        console.error('base64 이미지 업로드 실패:', error);
        throw error;
    }
}

// 여러 이미지를 동시에 업로드 (진행 상황 표시 포함)
export async function uploadMultipleImages(files, userId, entryId = null, progressCallback = null) {
    if (!files || files.length === 0) return [];
    
    // 모든 이미지를 병렬로 압축 (압축이 가장 느린 부분이므로 병렬 처리)
    const compressPromises = files.map(file => compressImageToBlob(file));
    const compressedBlobs = await Promise.all(compressPromises);
    
    // 압축 완료 후 업로드 (병렬 처리)
    const uploadPromises = compressedBlobs.map(async (blob, index) => {
        try {
            // 파일명 생성
            const timestamp = Date.now();
            const randomStr = Math.random().toString(36).substring(2, 9);
            const fileName = `${timestamp}_${randomStr}_${index}.jpg`;
            
            // Storage 경로 설정
            const path = entryId 
                ? `users/${userId}/meals/${entryId}/${fileName}`
                : `users/${userId}/temp/${fileName}`;
            
            const storageRef = ref(storage, path);
            
            // 업로드
            await uploadBytes(storageRef, blob);
            
            // 다운로드 URL 가져오기
            const downloadURL = await getDownloadURL(storageRef);
            
            // 진행 상황 콜백 호출
            if (progressCallback) {
                progressCallback(index + 1, files.length);
            }
            
            return downloadURL;
        } catch (error) {
            console.error(`이미지 ${index + 1} 업로드 실패:`, error);
            throw error;
        }
    });
    
    return Promise.all(uploadPromises);
}

/** 팝업용 이미지 업로드: 최대 3장, 장당 600KB 이하 압축 후 users/{userId}/admin-popups/ 에 저장 */
export async function uploadPopupImages(files, userId) {
    if (!files || files.length === 0) return [];
    const list = Array.from(files).slice(0, 3);
    const compressPromises = list.map(file => compressImageToBlobMaxSize(file, 600));
    const compressedBlobs = await Promise.all(compressPromises);
    const uploadPromises = compressedBlobs.map(async (blob, index) => {
        const timestamp = Date.now();
        const randomStr = Math.random().toString(36).substring(2, 9);
        const fileName = `${timestamp}_${randomStr}_${index}.jpg`;
        const path = `users/${userId}/admin-popups/${fileName}`;
        const storageRef = ref(storage, path);
        await uploadBytes(storageRef, blob);
        return getDownloadURL(storageRef);
    });
    return Promise.all(uploadPromises);
}

/** 공지용 이미지 업로드: 최대 3장, 장당 600KB 이하 압축 후 users/{userId}/admin-notices/ 에 저장 */
export async function uploadNoticeImages(files, userId) {
    if (!files || files.length === 0) return [];
    const list = Array.from(files).slice(0, 3);
    const compressPromises = list.map(file => compressImageToBlobMaxSize(file, 600));
    const compressedBlobs = await Promise.all(compressPromises);
    const uploadPromises = compressedBlobs.map(async (blob, index) => {
        const timestamp = Date.now();
        const randomStr = Math.random().toString(36).substring(2, 9);
        const fileName = `${timestamp}_${randomStr}_${index}.jpg`;
        const path = `users/${userId}/admin-notices/${fileName}`;
        const storageRef = ref(storage, path);
        await uploadBytes(storageRef, blob);
        return getDownloadURL(storageRef);
    });
    return Promise.all(uploadPromises);
}

/** 로그인 배너 이미지 업로드: 1장, 600KB 이하 압축 후 artifacts/{appId}/login-banner/ 에 저장 */
export async function uploadLoginBannerImage(file, appId) {
    if (!file || !appId) return null;
    const blob = await compressImageToBlobMaxSize(file, 600);
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 9);
    const fileName = `${timestamp}_${randomStr}.jpg`;
    const path = `artifacts/${appId}/login-banner/${fileName}`;
    const storageRef = ref(storage, path);
    await uploadBytes(storageRef, blob);
    return getDownloadURL(storageRef);
}

/** 밀톡 게시글용 이미지 업로드: 최대 5장, 장당 600KB 이하 압축 후 users/{userId}/board/ 에 저장 */
export async function uploadBoardImages(files, userId) {
    if (!files || files.length === 0) return [];
    const list = Array.from(files).slice(0, 5);

    const compressPromises = list.map(file => compressImageToBlobMaxSize(file, 600));
    const compressedBlobs = await Promise.all(compressPromises);

    const uploadPromises = compressedBlobs.map(async (blob, index) => {
        const timestamp = Date.now();
        const randomStr = Math.random().toString(36).substring(2, 9);
        const fileName = `${timestamp}_${randomStr}_${index}.jpg`;
        const path = `users/${userId}/board/${fileName}`;
        const storageRef = ref(storage, path);
        await uploadBytes(storageRef, blob);
        return getDownloadURL(storageRef);
    });

    return Promise.all(uploadPromises);
}

/** 밀톡 피드 전용 이미지 — users/{userId}/feed/ (게시판 board/ 경로와 분리) */
export async function uploadFeedImages(files, userId) {
    if (!files || files.length === 0) return [];
    const list = Array.from(files).slice(0, 5);

    const compressPromises = list.map((file) => compressImageToBlobMaxSize(file, 600));
    const compressedBlobs = await Promise.all(compressPromises);

    const uploadPromises = compressedBlobs.map(async (blob, index) => {
        const timestamp = Date.now();
        const randomStr = Math.random().toString(36).substring(2, 9);
        const fileName = `${timestamp}_${randomStr}_${index}.jpg`;
        const path = `users/${userId}/feed/${fileName}`;
        const storageRef = ref(storage, path);
        await uploadBytes(storageRef, blob);
        return getDownloadURL(storageRef);
    });

    return Promise.all(uploadPromises);
}

// Storage에서 이미지 삭제
export async function deleteImageFromStorage(imageUrl) {
    if (!imageUrl || typeof imageUrl !== 'string') {
        return;
    }
    
    // base64나 잘못된 URL은 무시
    if (!imageUrl.startsWith('https://')) {
        return;
    }
    
    if (!storage) {
        console.warn('Storage가 활성화되지 않았습니다.');
        return;
    }
    
    try {
        // Storage URL에서 파일 경로 추출
        // URL 형식: https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{path}?alt=media&token=...
        const url = new URL(imageUrl);
        const pathMatch = url.pathname.match(/\/o\/(.+)/);
        
        if (!pathMatch) {
            console.warn('Storage URL 형식이 올바르지 않습니다:', imageUrl);
            return;
        }
        
        const encodedPath = pathMatch[1];
        const path = decodeURIComponent(encodedPath);
        
        if (!path) {
            console.warn('파일 경로를 추출할 수 없습니다:', imageUrl);
            return;
        }
        
        const storageRef = ref(storage, path);
        await deleteObject(storageRef);
        console.log('Storage 파일 삭제 완료:', path);
    } catch (error) {
        // 파일이 이미 없거나 삭제 실패해도 계속 진행 (에러 무시)
        console.warn('Storage 파일 삭제 실패 (무시):', error.message || error);
    }
}

// 여러 이미지를 Storage에서 삭제
export async function deleteMultipleImagesFromStorage(imageUrls) {
    if (!imageUrls || imageUrls.length === 0) return;
    
    // Storage URL만 필터링 (base64는 무시)
    const storageUrls = imageUrls.filter(url => 
        url && typeof url === 'string' && url.startsWith('https://')
    );
    
    if (storageUrls.length === 0) return;
    
    // 모든 삭제 작업을 병렬로 실행 (일부 실패해도 계속 진행)
    const deletePromises = storageUrls.map(url => deleteImageFromStorage(url));
    await Promise.allSettled(deletePromises);
}

// base64 압축 (모달 미리보기/저장용) - 뷰포트 기반, 500KB 이하, 화질 우선
// 500KB로 통일해 업로드 시 재압축을 피하고, 최소 품질 0.25로 과도한 저하 방지
export function compressImage(base64) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            const targetSizeKB = 500;
            const targetSizeBytes = targetSizeKB * 1024;
            const maxInitialWidth = getViewportMaxWidth();
            const minWidth = Math.max(300, Math.floor((typeof window !== 'undefined' ? (window.innerWidth || 390) : 390) * 0.8));
            const minQuality = 0.25;
            
            let width = img.width;
            let height = img.height;
            
            if (width > maxInitialWidth) {
                height = (height / width) * maxInitialWidth;
                width = maxInitialWidth;
            }
            
            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(img, 0, 0, width, height);
            
            let quality = 0.78;
            let dataUrl = canvas.toDataURL('image/jpeg', quality);
            
            const getBase64Size = (dataUrl) => {
                const base64Data = dataUrl.split(',')[1] || dataUrl;
                const paddingCount = (base64Data.match(/=/g) || []).length;
                const actualLength = base64Data.length - paddingCount;
                return (actualLength * 3) / 4;
            };
            
            let currentSizeBytes = getBase64Size(dataUrl);
            let attempts = 0;
            const maxAttempts = 15;
            
            while (currentSizeBytes > targetSizeBytes && quality > minQuality && attempts < maxAttempts) {
                if (attempts < 5) {
                    quality -= 0.05;
                    if (quality < minQuality) quality = minQuality;
                } else {
                    if (width > minWidth) {
                        width = Math.max(minWidth, Math.floor(width * 0.9));
                        height = Math.floor((height / canvas.width) * width);
                        canvas.width = width;
                        canvas.height = height;
                        ctx.drawImage(img, 0, 0, width, height);
                    }
                    quality -= 0.03;
                    if (quality < minQuality) quality = minQuality;
                }
                dataUrl = canvas.toDataURL('image/jpeg', quality);
                currentSizeBytes = getBase64Size(dataUrl);
                attempts++;
            }
            
            resolve(dataUrl);
        };
        img.onerror = () => {
            // 이미지 로드 실패 시 원본 반환
            resolve(base64);
        };
        img.src = base64;
    });
}

export function generateColorMap(data, key, VIBRANT_COLORS) {
    const counts = {};
    data.forEach(m => {
        let val = m[key] || '미지정';
        counts[val] = (counts[val] || 0) + 1;
    });
    const colorMap = {};
    Object.keys(counts).forEach((name, idx) => {
        colorMap[name] = VIBRANT_COLORS[idx % VIBRANT_COLORS.length];
    });
    return colorMap;
}

/**
 * 숫자만 있는 생년월일(8자리)을 YYYY-MM-DD 형식으로 포맷
 * @param {string} digits - 숫자만 (최대 8자리)
 * @returns {string} 예: "19900115" -> "1990-01-15"
 */
export function formatBirthdateFromDigits(digits) {
    const d = (digits || '').replace(/\D/g, '').slice(0, 8);
    if (d.length <= 4) return d;
    if (d.length <= 6) return `${d.slice(0, 4)}-${d.slice(4)}`;
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/**
 * 생년월일 입력값 정규화 및 검증 (숫자만 넣어도 YYYY-MM-DD로 해석)
 * @param {string} raw - 사용자 입력 (예: "19900115" 또는 "1990-01-15")
 * @returns {{ formatted: string, valid: boolean }}
 */
export function normalizeBirthdateRaw(raw) {
    const s = (raw || '').trim();
    if (!s) return { formatted: '', valid: false };

    const digitsOnly = s.replace(/\D/g, '');
    let formatted = s;

    if (digitsOnly.length === 8) {
        formatted = `${digitsOnly.slice(0, 4)}-${digitsOnly.slice(4, 6)}-${digitsOnly.slice(6, 8)}`;
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return { formatted: '', valid: false };
    }

    const parts = formatted.split('-');
    if (parts.length !== 3) return { formatted: '', valid: false };

    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);

    if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return { formatted: '', valid: false };
    if (y < 1900 || y > 2100) return { formatted: '', valid: false };
    if (m < 1 || m > 12) return { formatted: '', valid: false };
    if (d < 1 || d > 31) return { formatted: '', valid: false };

    const birthDateObj = new Date(y, m - 1, d);
    if (Number.isNaN(birthDateObj.getTime())) return { formatted: '', valid: false };
    const valid =
        birthDateObj.getFullYear() === y &&
        birthDateObj.getMonth() === m - 1 &&
        birthDateObj.getDate() === d;

    return { formatted: valid ? formatted : '', valid };
}

/**
 * 생년월일 input 요소에 숫자만 입력 시 자동으로 하이픈 포맷 적용
 * @param {HTMLInputElement} el
 */
export function setupBirthdateInputFormatting(el) {
    if (!el || el.dataset.birthdateFormatted === 'true') return;
    el.dataset.birthdateFormatted = 'true';

    el.addEventListener('input', function () {
        const digits = this.value.replace(/\D/g, '').slice(0, 8);
        if (digits.length <= 4) {
            this.value = digits;
        } else if (digits.length <= 6) {
            this.value = `${digits.slice(0, 4)}-${digits.slice(4)}`;
        } else {
            this.value = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
        }
    });
}

/**
 * 주민번호 앞 6 + 성별코드 1자리 입력 포맷 (예: 801102-1)
 * @param {string} raw
 * @returns {string}
 */
export function formatRrnPartialInput(raw) {
    const d = String(raw || '').replace(/\D/g, '').slice(0, 7);
    if (d.length <= 6) return d;
    return `${d.slice(0, 6)}-${d.slice(6)}`;
}

/**
 * 성별코드(주민 뒷자리 첫 숫자) → 세기·성별
 * 1·2(1900s), 3·4(2000s), 5·6(1900s 외국인), 7·8(2000s 외국인), 9·0(1800s)
 * @param {string|number} sexDigit
 * @returns {{ century: number, gender: 'male'|'female' }|null}
 */
export function decodeRrnSexDigit(sexDigit) {
    const d = String(sexDigit ?? '').trim();
    if (!/^[0-9]$/.test(d)) return null;
    const n = Number(d);
    const gender = n % 2 === 1 ? 'male' : 'female';
    let century;
    if (n === 9 || n === 0) century = 1800;
    else if (n === 1 || n === 2 || n === 5 || n === 6) century = 1900;
    else century = 2000; // 3,4,7,8
    return { century, gender };
}

/**
 * 저장된 생년월일·성별로 주민번호 앞자리 성별코드 추정 (국내 출생 1~4 기준)
 * @param {string} birthdate YYYY-MM-DD
 * @param {'male'|'female'|string|null|undefined} gender
 * @returns {string} '1'|'2'|… 또는 ''
 */
export function encodeRrnSexDigit(birthdate, gender) {
    const { valid, formatted } = normalizeBirthdateRaw(birthdate || '');
    if (!valid || (gender !== 'male' && gender !== 'female')) return '';
    const y = Number(formatted.slice(0, 4));
    const isMale = gender === 'male';
    if (y >= 2000 && y <= 2099) return isMale ? '3' : '4';
    if (y >= 1900 && y <= 1999) return isMale ? '1' : '2';
    if (y >= 1800 && y <= 1899) return isMale ? '9' : '0';
    return '';
}

/**
 * 주민번호 부분 입력 파싱 → birthdate(YYYY-MM-DD) + gender
 * @param {string} raw
 * @returns {{ empty: boolean, valid: boolean, birthdate: string, gender: 'male'|'female'|null, sexDigit: string, front6: string, formatted: string, error?: string }}
 */
export function parseRrnPartial(raw) {
    const digits = String(raw || '').replace(/\D/g, '').slice(0, 7);
    const empty = {
        empty: true,
        valid: true,
        birthdate: '',
        gender: null,
        sexDigit: '',
        front6: '',
        formatted: ''
    };
    if (!digits) return empty;
    if (digits.length < 7) {
        return {
            empty: false,
            valid: false,
            birthdate: '',
            gender: null,
            sexDigit: digits.length === 7 ? digits[6] : '',
            front6: digits.slice(0, 6),
            formatted: formatRrnPartialInput(digits),
            error: 'incomplete'
        };
    }
    const front6 = digits.slice(0, 6);
    const sexDigit = digits[6];
    const decoded = decodeRrnSexDigit(sexDigit);
    if (!decoded) {
        return {
            empty: false,
            valid: false,
            birthdate: '',
            gender: null,
            sexDigit,
            front6,
            formatted: formatRrnPartialInput(digits),
            error: 'sex'
        };
    }
    const yy = Number(front6.slice(0, 2));
    const mm = front6.slice(2, 4);
    const dd = front6.slice(4, 6);
    const year = decoded.century + yy;
    const birthdateCandidate = `${year}-${mm}-${dd}`;
    const { formatted, valid } = normalizeBirthdateRaw(birthdateCandidate);
    if (!valid) {
        return {
            empty: false,
            valid: false,
            birthdate: '',
            gender: decoded.gender,
            sexDigit,
            front6,
            formatted: formatRrnPartialInput(digits),
            error: 'date'
        };
    }
    const today = new Date();
    const birth = new Date(Number(formatted.slice(0, 4)), Number(formatted.slice(5, 7)) - 1, Number(formatted.slice(8, 10)));
    if (birth.getTime() > today.getTime()) {
        return {
            empty: false,
            valid: false,
            birthdate: '',
            gender: decoded.gender,
            sexDigit,
            front6,
            formatted: formatRrnPartialInput(digits),
            error: 'future'
        };
    }
    return {
        empty: false,
        valid: true,
        birthdate: formatted,
        gender: decoded.gender,
        sexDigit,
        front6,
        formatted: formatRrnPartialInput(digits)
    };
}

/**
 * birthdate + gender → 입력란용 `YYMMDD-G`
 * @param {string} birthdate
 * @param {'male'|'female'|string|null|undefined} gender
 * @returns {string}
 */
export function birthdateGenderToRrnPartial(birthdate, gender) {
    const { valid, formatted } = normalizeBirthdateRaw(birthdate || '');
    if (!valid) return '';
    const sex = encodeRrnSexDigit(formatted, gender);
    if (!sex) return '';
    const yymmdd = `${formatted.slice(2, 4)}${formatted.slice(5, 7)}${formatted.slice(8, 10)}`;
    return `${yymmdd}-${sex}`;
}

/**
 * 프로필 표시용 `YYMMDD-G******`
 * @param {string} birthdate
 * @param {'male'|'female'|string|null|undefined} gender
 * @returns {string} 없으면 ''
 */
export function formatProfileRrnDisplay(birthdate, gender) {
    const partial = birthdateGenderToRrnPartial(birthdate, gender);
    if (partial) return `${partial}******`;
    const { valid, formatted } = normalizeBirthdateRaw(birthdate || '');
    if (!valid) return '';
    const yymmdd = `${formatted.slice(2, 4)}${formatted.slice(5, 7)}${formatted.slice(8, 10)}`;
    return `${yymmdd}-*******`;
}

/**
 * 주민번호 부분 input 자동 포맷 (######-#) — 레거시 단일 입력용
 * @param {HTMLInputElement} el
 */
export function setupRrnPartialInputFormatting(el) {
    if (!el || el.dataset.rrnPartialFormatted === 'true') return;
    el.dataset.rrnPartialFormatted = 'true';
    el.addEventListener('input', function () {
        this.value = formatRrnPartialInput(this.value);
    });
}

const RRN_DIGIT_COUNT = 7;
const RRN_DIGIT_LABELS = [
    '생년 십의 자리',
    '생년 일의 자리',
    '월 십의 자리',
    '월 일의 자리',
    '일 십의 자리',
    '일 일의 자리',
    '성별 코드'
];

function syncRrnDigitHidden(root) {
    const hiddenId = root?.dataset?.rrnHidden;
    if (!hiddenId) return;
    const hidden = document.getElementById(hiddenId);
    if (hidden) hidden.value = getRrnDigitGroupValue(root);
}

/**
 * 주민번호 앞 7자리 숫자 칸 그룹 값 (하이픈 포함 포맷 또는 빈 문자열)
 * @param {string|HTMLElement} rootOrId
 * @returns {string}
 */
export function getRrnDigitGroupValue(rootOrId) {
    const root = typeof rootOrId === 'string' ? document.getElementById(rootOrId) : rootOrId;
    if (!root) return '';
    const cells = root.querySelectorAll('.rrn-digit');
    let digits = '';
    cells.forEach((el) => {
        digits += String(el.value || '').replace(/\D/g, '').slice(0, 1);
    });
    return formatRrnPartialInput(digits);
}

/**
 * 주민번호 숫자 칸 그룹에 값 채우기
 * @param {string|HTMLElement} rootOrId
 * @param {string} raw
 */
export function setRrnDigitGroupValue(rootOrId, raw) {
    const root = typeof rootOrId === 'string' ? document.getElementById(rootOrId) : rootOrId;
    if (!root) return;
    const digits = String(raw || '').replace(/\D/g, '').slice(0, RRN_DIGIT_COUNT);
    const cells = root.querySelectorAll('.rrn-digit');
    cells.forEach((el, i) => {
        el.value = digits[i] || '';
    });
    syncRrnDigitHidden(root);
}

/**
 * 주민번호 숫자 칸 포커스 (첫 빈 칸, 없으면 마지막)
 * @param {string|HTMLElement} rootOrId
 */
export function focusRrnDigitGroup(rootOrId) {
    const root = typeof rootOrId === 'string' ? document.getElementById(rootOrId) : rootOrId;
    if (!root) return;
    const cells = [...root.querySelectorAll('.rrn-digit')];
    const empty = cells.find((el) => !el.value);
    (empty || cells[0])?.focus();
}

/**
 * 주민번호 앞 6 + 성별 1 숫자 칸 UI 마운트/바인딩
 * @param {string|HTMLElement} rootOrId
 * @param {{ hiddenId?: string }} [options]
 */
export function mountRrnDigitGroup(rootOrId, options = {}) {
    const root = typeof rootOrId === 'string' ? document.getElementById(rootOrId) : rootOrId;
    if (!root) return null;
    if (options.hiddenId) root.dataset.rrnHidden = options.hiddenId;

    if (!root.dataset.rrnDigitsBuilt) {
        root.dataset.rrnDigitsBuilt = 'true';
        root.classList.add('rrn-digits');
        root.setAttribute('role', 'group');
        if (!root.getAttribute('aria-label')) {
            root.setAttribute('aria-label', '주민등록번호 앞 6자리와 뒤 첫 자리');
        }
        const frag = document.createDocumentFragment();
        for (let i = 0; i < RRN_DIGIT_COUNT; i++) {
            if (i === 6) {
                const hyphen = document.createElement('span');
                hyphen.className = 'rrn-digits__hyphen';
                hyphen.setAttribute('aria-hidden', 'true');
                hyphen.textContent = '-';
                frag.appendChild(hyphen);
            }
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'rrn-digit';
            input.inputMode = 'numeric';
            input.autocomplete = 'one-time-code';
            input.maxLength = 1;
            input.pattern = '[0-9]*';
            input.setAttribute('data-rrn-i', String(i));
            input.setAttribute('aria-label', RRN_DIGIT_LABELS[i] || `자리 ${i + 1}`);
            input.setAttribute('enterkeyhint', i === RRN_DIGIT_COUNT - 1 ? 'done' : 'next');
            frag.appendChild(input);
        }
        const mask = document.createElement('span');
        mask.className = 'rrn-digits__mask';
        mask.setAttribute('aria-hidden', 'true');
        mask.textContent = '******';
        frag.appendChild(mask);
        root.textContent = '';
        root.appendChild(frag);
    }

    if (root.dataset.rrnDigitsBound === 'true') {
        syncRrnDigitHidden(root);
        return root;
    }
    root.dataset.rrnDigitsBound = 'true';

    const cells = () => [...root.querySelectorAll('.rrn-digit')];

    const fillFromDigits = (digitStr, startIndex = 0) => {
        const list = cells();
        const digits = String(digitStr || '').replace(/\D/g, '');
        let i = startIndex;
        for (const ch of digits) {
            if (i >= list.length) break;
            list[i].value = ch;
            i += 1;
        }
        syncRrnDigitHidden(root);
        const next = list[Math.min(i, list.length - 1)];
        next?.focus();
        if (next && i < list.length) next.select();
    };

    root.addEventListener('input', (e) => {
        const t = e.target;
        if (!(t instanceof HTMLInputElement) || !t.classList.contains('rrn-digit')) return;
        const list = cells();
        const idx = list.indexOf(t);
        if (idx < 0) return;
        const raw = t.value.replace(/\D/g, '');
        if (raw.length > 1) {
            fillFromDigits(raw, idx);
            return;
        }
        t.value = raw.slice(0, 1);
        syncRrnDigitHidden(root);
        if (t.value && idx < list.length - 1) {
            list[idx + 1].focus();
            list[idx + 1].select();
        }
    });

    root.addEventListener('keydown', (e) => {
        const t = e.target;
        if (!(t instanceof HTMLInputElement) || !t.classList.contains('rrn-digit')) return;
        const list = cells();
        const idx = list.indexOf(t);
        if (idx < 0) return;
        if (e.key === 'Backspace') {
            if (t.value) {
                t.value = '';
                syncRrnDigitHidden(root);
                e.preventDefault();
                return;
            }
            if (idx > 0) {
                e.preventDefault();
                list[idx - 1].focus();
                list[idx - 1].value = '';
                syncRrnDigitHidden(root);
            }
            return;
        }
        if (e.key === 'ArrowLeft' && idx > 0) {
            e.preventDefault();
            list[idx - 1].focus();
            list[idx - 1].select();
            return;
        }
        if (e.key === 'ArrowRight' && idx < list.length - 1) {
            e.preventDefault();
            list[idx + 1].focus();
            list[idx + 1].select();
            return;
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !/\d/.test(e.key)) {
            e.preventDefault();
        }
    });

    root.addEventListener('paste', (e) => {
        const t = e.target;
        if (!(t instanceof HTMLInputElement) || !t.classList.contains('rrn-digit')) return;
        e.preventDefault();
        const list = cells();
        const idx = list.indexOf(t);
        const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
        fillFromDigits(text, idx >= 0 ? idx : 0);
    });

    root.addEventListener('focusin', (e) => {
        const t = e.target;
        if (t instanceof HTMLInputElement && t.classList.contains('rrn-digit')) {
            requestAnimationFrame(() => t.select());
        }
    });

    syncRrnDigitHidden(root);
    return root;
}

// 로컬 타임존 기준으로 YYYY-MM-DD 형식 문자열 반환
// toISOString()은 UTC로 변환되어 한국 시간(KST, UTC+9)에서 날짜가 하루 전으로 나올 수 있음
export function toLocalDateString(date) {
    if (!date || !(date instanceof Date)) {
        console.warn('toLocalDateString: 유효하지 않은 날짜 객체', date);
        return '';
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** Asia/Seoul 달력 기준 YYYY-MM-DD (연속 기록·관리자 웰컴 API와 동일) */
export function toSeoulDateString(date) {
    if (!date || !(date instanceof Date)) {
        console.warn('toSeoulDateString: 유효하지 않은 날짜 객체', date);
        return '';
    }
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);
}

/** 게시판·공지 등 UI 표시용 — 날짜·시각 모두 Asia/Seoul (로컬/OS 타임존과 무관) */
export const SEOUL_LOCALE_OPTIONS = { timeZone: 'Asia/Seoul' };

/**
 * 서울 YYYY-MM-DD에 delta일(음수 가능)을 더한 서울 달력 날짜.
 * functions/index.js adminYmdAddDays와 동일한 산술.
 */
export function addCalendarDaysSeoulYmd(ymd, deltaDays) {
    if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '';
    const [y, m, d] = ymd.split('-').map(Number);
    const ms = Date.UTC(y, m - 1, d, 12, 0, 0) + deltaDays * 86400000;
    return toSeoulDateString(new Date(ms));
}

/**
 * 공유 로고 카드 태그라인 — 웰컴(출석) 팝업과 동일 Yeon Sung
 * Google Fonts Yeon Sung은 Regular(400)만 제공(별도 Bold 없음). 캔버스에서 600이면 가짜 볼드가 음절마다 달라질 수 있어 normal(400)만 사용.
 * 폴백 글꼴을 섞지 않음(Noto 등) — 한 줄 안에서 티 나는 이질감 방지.
 */
async function drawShareLogoTagline(ctx, cx, centerY, maxW, splitLines) {
    ctx.fillStyle = '#3cb889';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    if ('fontKerning' in ctx) ctx.fontKerning = 'normal';
    const fontAt = (size) => `normal ${size}px "Yeon Sung", serif`;

    let size = 58;
    while (size >= 34) {
        try {
            if (document.fonts?.load) {
                await document.fonts.load(fontAt(size));
            }
        } catch (_) {}
        ctx.font = fontAt(size);
        const lsPx = Math.max(0, Math.round(size * 0.04));
        if ('letterSpacing' in ctx) {
            ctx.letterSpacing = `${lsPx}px`;
        }
        const w1 = ctx.measureText(splitLines[0]).width;
        const w2 = ctx.measureText(splitLines[1]).width;
        if (Math.max(w1, w2) <= maxW) {
            drawShareLogoTaglineTwoLines(ctx, cx, centerY, splitLines, size);
            if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
            return;
        }
        size -= 2;
    }
    try {
        if (document.fonts?.load) await document.fonts.load(fontAt(32));
    } catch (_) {}
    ctx.font = fontAt(32);
    if ('letterSpacing' in ctx) {
        ctx.letterSpacing = `${Math.round(32 * 0.04)}px`;
    }
    drawShareLogoTaglineTwoLines(ctx, cx, centerY, splitLines, 32);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}

/** alphabetic 두 줄 — baseline 간격은 line-height(≈1.42em), 블록 세로 중앙은 actualBoundingBox로 맞춤 */
function drawShareLogoTaglineTwoLines(ctx, cx, centerY, splitLines, size) {
    const [line1, line2] = splitLines;
    const m1 = ctx.measureText(line1);
    const m2 = ctx.measureText(line2);
    const a1 = m1.actualBoundingBoxAscent ?? size * 0.74;
    const d2 = m2.actualBoundingBoxDescent ?? size * 0.26;
    const lineHeightPx = Math.round(size * 1.42);
    const y1 = centerY + (a1 - lineHeightPx - d2) / 2;
    const y2 = y1 + lineHeightPx;
    ctx.fillText(line1, cx, y1);
    ctx.fillText(line2, cx, y2);
}

/**
 * 앱 로고 + 서브타이틀 이미지 생성 (공유 시 마지막에 추가)
 * @returns {Promise<Blob>}
 */
async function createMealogLogoImage() {
    const TAGLINE_SPLIT = ['우리가 함께한,', '맛있었던 이야기'];
    const cw = 1080;
    const ch = 1080;
    const maxTextW = cw - 160;
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);

    const iconUrl = document.querySelector('#landingMealogIcon')?.src || new URL('assets/icon-only.png', window.location.href).href;

    try {
        if (document.fonts?.ready) await document.fonts.ready;
        if (document.fonts?.load) await document.fonts.load('normal 60px "Yeon Sung"').catch(() => {});
    } catch (_) {}

    let imgEl = null;
    try {
        imgEl = await new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('icon'));
            img.src = iconUrl;
        });
    } catch (_) {
        imgEl = null;
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const drawRoundedIconClip = (iconX, iconY, iconSize) => {
        const radius = iconSize * 0.35;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(iconX, iconY, iconSize, iconSize, radius);
        } else {
            const r = Math.min(radius, iconSize / 2);
            ctx.moveTo(iconX + r, iconY);
            ctx.lineTo(iconX + iconSize - r, iconY);
            ctx.quadraticCurveTo(iconX + iconSize, iconY, iconX + iconSize, iconY + r);
            ctx.lineTo(iconX + iconSize, iconY + iconSize - r);
            ctx.quadraticCurveTo(iconX + iconSize, iconY + iconSize, iconX + iconSize - r, iconY + iconSize);
            ctx.lineTo(iconX + r, iconY + iconSize);
            ctx.quadraticCurveTo(iconX, iconY + iconSize, iconX, iconY + iconSize - r);
            ctx.lineTo(iconX, iconY + r);
            ctx.quadraticCurveTo(iconX, iconY, iconX + r, iconY);
        }
    };

    if (imgEl) {
        try {
            const iconSize = 280;
            const iconX = (cw - iconSize) / 2;
            const iconY = ch * 0.28;
            ctx.save();
            drawRoundedIconClip(iconX, iconY, iconSize);
            ctx.clip();
            ctx.drawImage(imgEl, iconX, iconY, iconSize, iconSize);
            ctx.restore();
            ctx.fillStyle = '#3cb889';
            ctx.font = 'bold 72px "Fredoka", "Malgun Gothic", sans-serif';
            ctx.fillText('mealog', cw / 2, iconY + iconSize + 80);
            await drawShareLogoTagline(ctx, cw / 2, iconY + iconSize + 200, maxTextW, TAGLINE_SPLIT);
        } catch (_) {
            imgEl = null;
        }
    }
    if (!imgEl) {
        ctx.fillStyle = '#3cb889';
        ctx.font = 'bold 72px "Fredoka", sans-serif';
        ctx.fillText('mealog', cw / 2, ch / 2 - 60);
        await drawShareLogoTagline(ctx, cw / 2, ch / 2 + 72, maxTextW, TAGLINE_SPLIT);
    }

    return new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob ? blob : new Blob([], { type: 'image/jpeg' })), 'image/jpeg', 0.92);
    });
}

/**
 * 이미지에 메뉴@장소 캡션을 하단에 오버레이하여 Blob 반환
 * @param {Blob} imageBlob - 원본 이미지 Blob
 * @param {string} caption - 캡션 텍스트 (메뉴 @ 장소)
 * @returns {Promise<Blob>}
 */
async function addCaptionToImage(imageBlob, caption) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(imageBlob);
        img.onload = () => {
            try {
                const cw = img.width;
                const ch = img.height;
                const barH = Math.max(44, Math.min(56, Math.floor(cw * 0.1)));
                const canvas = document.createElement('canvas');
                canvas.width = cw;
                canvas.height = ch + barH;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                ctx.fillStyle = '#2d9f74';
                ctx.fillRect(0, ch, cw, barH);
                ctx.fillStyle = '#ffffff';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                const fontSize = Math.round(barH * 0.65);
                ctx.font = `${fontSize}px "나눔손글씨 가람연꽃", "Nanum Garam Yeonkot", "Nanum Pen Script", cursive`;
                const padding = 12;
                const maxW = cw - padding * 2;
                let text = caption;
                if (ctx.measureText(text).width > maxW) {
                    while (text.length > 1 && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
                    text = text + '…';
                }
                ctx.fillText(text, padding, ch + barH / 2);
                canvas.toBlob((blob) => {
                    URL.revokeObjectURL(url);
                    resolve(blob || imageBlob);
                }, imageBlob.type || 'image/jpeg', 0.92);
            } catch (err) {
                URL.revokeObjectURL(url);
                resolve(imageBlob);
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(imageBlob);
        };
        img.src = url;
    });
}

/** Blob을 base64 문자열로 변환 (Capacitor Filesystem 공유용) */
function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result;
            const base64 = dataUrl.indexOf(',') >= 0 ? dataUrl.split(',')[1] : dataUrl;
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

/** 공유용 이미지 Blob 리사이즈 (대용량 미잘라낸 사진으로 인한 공유 실패 방지). maxWidth 초과 시 비율 유지해 축소, jpeg 0.88 */
function resizeBlobForShare(blob, maxWidth = 1200) {
    if (!blob || !blob.type || !blob.type.startsWith('image/')) return Promise.resolve(blob);
    return new Promise((resolve) => {
        const img = new Image();
        const url = URL.createObjectURL(blob);
        img.onload = () => {
            try {
                let w = img.width;
                let h = img.height;
                if (w <= maxWidth && blob.size <= 800 * 1024) {
                    URL.revokeObjectURL(url);
                    resolve(blob);
                    return;
                }
                if (w > maxWidth) {
                    h = Math.round((h / w) * maxWidth);
                    w = maxWidth;
                }
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                URL.revokeObjectURL(url);
                canvas.toBlob((out) => resolve(out || blob), 'image/jpeg', 0.88);
            } catch (e) {
                URL.revokeObjectURL(url);
                resolve(blob);
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(blob);
        };
        img.src = url;
    });
}

function downloadBlob(blob, filename = 'mealog_share.jpg') {
    if (!blob) return false;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
}

/**
 * 준비된 이미지 Blob을 카카오톡·인스타 등 외부 앱으로 공유합니다.
 * @param {Blob[]} blobs
 * @param {{ caption?: string, appendLogo?: boolean, resize?: boolean, fileNamePrefix?: string }} [options]
 * @returns {Promise<boolean>}
 */
export async function shareBlobsToExternal(blobs, options = {}) {
    const {
        caption = '',
        appendLogo = true,
        resize = true,
        fileNamePrefix = 'mealog'
    } = options;
    const captionText = (caption || '').trim();
    const isNative = typeof window.Capacitor !== 'undefined' && window.Capacitor?.isNativePlatform?.();

    let prepared = (Array.isArray(blobs) ? blobs : []).filter((b) => b && b.size > 0);
    if (!prepared.length) {
        if (typeof window.showToast === 'function') {
            window.showToast('공유할 이미지가 없습니다.', 'error');
        }
        return false;
    }

    if (resize) {
        prepared = await Promise.all(prepared.map((blob) => resizeBlobForShare(blob)));
    }
    const mainBlobCount = prepared.length;
    if (appendLogo) {
        try {
            const logoBlob = await createMealogLogoImage();
            if (logoBlob && logoBlob.size > 0) prepared.push(logoBlob);
        } catch (_) {}
    }

    const webShareFiles = (fileBlobs) =>
        fileBlobs.map((blob, i) => {
            const isLogo = appendLogo && i === fileBlobs.length - 1 && fileBlobs.length > mainBlobCount;
            const ext = blob.type === 'image/png' ? 'png' : 'jpg';
            const mime = blob.type || (ext === 'png' ? 'image/png' : 'image/jpeg');
            const name = isLogo ? 'mealog_logo.jpg' : `${fileNamePrefix}_${i + 1}.${ext}`;
            return new File([blob], name, { type: mime, lastModified: Date.now() });
        });

    const tryWebShare = async (fileBlobs) => {
        if (isNative || !navigator.share || !fileBlobs.length) return null;
        const files = webShareFiles(fileBlobs);
        const shareData = { files };
        if (navigator.canShare && !navigator.canShare(shareData)) return null;
        await navigator.share(shareData);
        if (typeof window.showToast === 'function') {
            window.showToast('공유되었습니다.', 'success');
        }
        return true;
    };

    // 1) Web Share API
    if (!isNative && navigator.share) {
        try {
            const shared = await tryWebShare(prepared);
            if (shared) return true;
        } catch (e) {
            if (e.name === 'AbortError' || (e.message && /cancelled|canceled/i.test(e.message))) return false;
            if (e.name === 'NotAllowedError' && prepared.length > 1) {
                try {
                    const shared = await tryWebShare([prepared[0]]);
                    if (shared) return true;
                } catch (e2) {
                    if (e2.name === 'AbortError' || (e2.message && /cancelled|canceled/i.test(e2.message))) return false;
                }
            }
            if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
                if (downloadBlob(prepared[0], `${fileNamePrefix}.jpg`)) {
                    if (typeof window.showToast === 'function') {
                        window.showToast('브라우저에서 공유를 허용하지 않아 이미지를 저장했어요.', 'info');
                    }
                    return true;
                }
            }
            console.error('shareBlobsToExternal(웹) 실패:', e);
            if (typeof window.showToast === 'function') window.showToast('공유에 실패했습니다.', 'error');
            return false;
        }
        if (downloadBlob(prepared[0], `${fileNamePrefix}.jpg`)) {
            if (typeof window.showToast === 'function') {
                window.showToast('이 기기에서는 공유 창을 열 수 없어 이미지를 저장했어요.', 'info');
            }
            return true;
        }
        if (typeof window.showToast === 'function') {
            window.showToast('이 기기에서는 공유 기능을 지원하지 않습니다.', 'error');
        }
        return false;
    }

    if (!isNative) {
        if (downloadBlob(prepared[0], `${fileNamePrefix}.jpg`)) {
            if (typeof window.showToast === 'function') {
                window.showToast('이미지를 저장했어요. 앨범에서 공유해 주세요.', 'info');
            }
            return true;
        }
        if (typeof window.showToast === 'function') {
            window.showToast('이 기기에서는 공유 기능을 지원하지 않습니다.', 'error');
        }
        return false;
    }

    // 2) 앱 전용: Capacitor Share + Filesystem
    const Share = window.Capacitor?.Plugins?.Share;
    const Filesystem = window.Capacitor?.Plugins?.Filesystem;
    const DirectoryCache = (Filesystem?.Directory?.Cache !== undefined) ? Filesystem.Directory.Cache : 'CACHE';
    if (!Share || !Filesystem) {
        if (typeof window.showToast === 'function') {
            window.showToast('공유 플러그인을 사용할 수 없습니다.', 'error');
        }
        return false;
    }

    let step = '';
    try {
        const prefix = `mealog_share_${Date.now()}`;
        const fileUris = [];
        step = '파일 저장';
        for (let i = 0; i < prepared.length; i++) {
            const path = `${prefix}_${i}.jpg`;
            const base64 = await blobToBase64(prepared[i]);
            if (!base64 || base64.length > 6 * 1024 * 1024) continue;
            await Filesystem.writeFile({
                path,
                data: base64,
                directory: DirectoryCache,
            });
            const { uri } = await Filesystem.getUri({ path, directory: DirectoryCache });
            fileUris.push(uri);
        }
        if (fileUris.length === 0) {
            if (typeof window.showToast === 'function') {
                window.showToast('공유용 파일을 준비하지 못했습니다.', 'error');
            }
            return false;
        }
        step = '공유 창 열기';
        const shareOptions = {
            files: fileUris,
            text: captionText || 'mealog',
            title: 'mealog',
            dialogTitle: '공유하기',
        };
        try {
            await Share.share(shareOptions);
        } catch (shareErr) {
            try {
                await Share.share({
                    url: fileUris[0],
                    text: captionText || 'mealog',
                    title: 'mealog',
                    dialogTitle: '공유하기',
                });
                if (typeof window.showToast === 'function') window.showToast('공유되었습니다.', 'success');
                return true;
            } catch (_) {}
            try {
                await Share.share({
                    text: captionText ? `mealog - ${captionText}` : 'mealog',
                    title: 'mealog',
                    dialogTitle: '공유하기',
                });
                if (typeof window.showToast === 'function') {
                    window.showToast('이미지 공유가 제한되어 캡션만 공유했습니다.', 'info');
                }
                return true;
            } catch (textErr) {
                throw shareErr;
            }
        }
        if (typeof window.showToast === 'function') {
            window.showToast('공유되었습니다.', 'success');
        }
        return true;
    } catch (e) {
        if (e.name === 'AbortError' || (e.message && /cancelled|canceled/i.test(e.message))) return false;
        const msg = e.message || String(e);
        const errDetail = { step, message: msg, name: e.name, stack: e.stack };
        try {
            window.__lastShareError = errDetail;
        } catch (_) {}
        console.error('shareBlobsToExternal(네이티브) 실패:', step, e);
        if (typeof window.showToast === 'function') {
            const stepMsg = step ? ` (${step} 단계)` : '';
            const shortMsg = (msg.length > 60 ? msg.slice(0, 60) + '…' : msg)
                .replace(/\s*@[\w/-]+\s*$/i, '');
            window.showToast('공유 실패.' + stepMsg + (shortMsg ? ' ' + shortMsg : ''), 'error');
        }
        return false;
    }
}

/**
 * 모먼트(앨범) 사진을 카카오톡·인스타그램 등 외부 앱으로 공유합니다.
 * 웹: Web Share API(navigator.share). 네이티브 앱: Capacitor Share만 사용(웹뷰 공유와 수신 앱 호환).
 * caption이 있으면 모먼트처럼 이미지 하단에 메뉴@장소를 녹색 바로 오버레이합니다.
 * @param {string|string[]} photoUrls - 쉼표로 구분된 사진 URL 또는 URL 배열
 * @param {string} [caption] - 메뉴@장소 캡션 (있으면 이미지 하단에 오버레이)
 * @param {boolean} [skipCaptionBar] - true면 베스트/일간/인사이트 등 캡쳐 3종에 하단 캡션바 미적용
 * @returns {Promise<boolean>} - 공유 성공 여부
 */
export async function sharePhotosToExternal(photoUrls, caption = '', skipCaptionBar = false) {
    const urls = typeof photoUrls === 'string'
        ? photoUrls.split(',').map(u => u.trim()).filter(Boolean)
        : Array.isArray(photoUrls) ? photoUrls.filter(Boolean) : [];
    if (urls.length === 0) return false;

    const captionText = (caption || '').trim();

    // 공통: 이미지 fetch → blob (캡션·리사이즈 적용)
    const blobs = [];
    for (let i = 0; i < Math.min(urls.length, 5); i++) {
        const url = urls[i];
        try {
            const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
            if (!res.ok) continue;
            let blob = await res.blob();
            if (!blob.type || !blob.type.startsWith('image/')) continue;
            if (!skipCaptionBar && captionText) {
                blob = await addCaptionToImage(blob, captionText);
            }
            blob = await resizeBlobForShare(blob);
            blobs.push(blob);
        } catch (imgErr) {
            console.warn('SNS 공유용 이미지 로드 실패:', url?.slice(0, 60), imgErr);
        }
    }
    if (blobs.length === 0) {
        if (typeof window.showToast === 'function') {
            window.showToast('사진을 불러오지 못했습니다. (네트워크 또는 접근 제한)', 'error');
        }
        return false;
    }

    return shareBlobsToExternal(blobs, {
        caption: captionText,
        appendLogo: true,
        resize: false,
        fileNamePrefix: 'mealog'
    });
}



