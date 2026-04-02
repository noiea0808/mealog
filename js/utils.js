// 유틸리티 함수들
import { storage } from './firebase.js';
import { ref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-storage.js";

// 프로덕션 환경 감지 (localhost 또는 127.0.0.1이 아니면 프로덕션)
const isProduction = () => {
    const hostname = window.location.hostname;
    return hostname !== 'localhost' && hostname !== '127.0.0.1' && !hostname.includes('192.168.');
};

/**
 * 스테이징/운영 구분 (푸시·콘텐츠 팝업·연속기록 팝업 등과 동일 기준)
 * — 네이티브는 앱 패키지, 웹은 APP_ENV 후 로컬 호스트.
 */
export function getMealogClientEnv() {
    if (typeof window === 'undefined') return 'production';
    const capAppId = String(window.Capacitor?.config?.appId || '').trim();
    if (capAppId === 'com.mealog.app.staging') return 'staging';
    if (capAppId === 'com.mealog.app') return 'production';
    if (window.APP_ENV === 'staging') return 'staging';
    const hostname = window.location.hostname || '';
    const isLocal =
        hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.');
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
 * @returns {{ nickname: string, icon: string|null, photoUrl: string|null }}
 */
export function getDisplayProfile(authorId, stored = {}) {
    const isCurrentUser = typeof window !== 'undefined' && window.currentUser && authorId === window.currentUser.uid;
    const profile = window?.userSettings?.profile;
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
 * 프로필 아바타에 표시할 내용 반환 (사진 > 이모지 아이콘 > 기본 회색 사람 아이콘)
 * 기본 동물 아이콘(🐻 등)은 예전 기본값이므로 미설정으로 간주하고 기본 아이콘을 표시합니다.
 * @param {{ nickname?: string, icon?: string|null, photoUrl?: string|null }} profile - getDisplayProfile 결과
 * @returns {{ type: 'photo'|'emoji'|'default', value: string }}
 */
const DEFAULT_AVATAR_ICONS = ['🐻', '🐰', '🐱', '🐶', '🦊', '🦁', '🐼', '🐨'];

export function getProfileAvatarDisplay(profile) {
    const photoRaw = profile.photoUrl != null ? String(profile.photoUrl).trim() : '';
    if (photoRaw) return { type: 'photo', value: photoRaw };
    const icon = profile.icon != null && profile.icon !== '' ? profile.icon : null;
    if (icon && !DEFAULT_AVATAR_ICONS.includes(icon)) return { type: 'emoji', value: icon };
    return { type: 'default', value: '' };
}

export function getInputIdFromContainer(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return null;
    if (containerId === 'restaurantSuggestions') return 'placeInput';
    if (containerId === 'menuSuggestions') return 'menuDetailInput';
    if (containerId === 'peopleSuggestions') return 'withWhomInput';
    if (containerId === 'snackSuggestions') return 'snackDetailInput';
    if (containerId === 'snackPlaceSuggestions') return 'snackPlaceInput';
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
 * 유령 캡처(Ghost Capture): 화면 밖에 복제본을 만들어 부모 간섭(모달, transform, Flex/Grid) 없이 캡처
 * @param {HTMLElement} originalElement - 캡처할 원본 요소
 * @param {Object} options - html2canvas 옵션 + captureWidth
 * @param {number} [options.captureWidth=420] - 캡처 가로 크기 (정사이즈 고정)
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function captureWithGhostStrategy(originalElement, options = {}) {
    const { captureWidth = 420, ...html2canvasOptions } = options;
    const html2canvasFunc = (typeof window !== 'undefined' && window.html2canvas) || (typeof html2canvas !== 'undefined' ? html2canvas : null);
    if (!html2canvasFunc) throw new Error('html2canvas를 찾을 수 없습니다. HTML에 html2canvas 라이브러리가 로드되었는지 확인하세요.');

    const ghostNode = originalElement.cloneNode(true);
    ghostNode.style.position = 'fixed';
    ghostNode.style.top = '-10000px';
    ghostNode.style.left = '-10000px';
    ghostNode.style.width = `${captureWidth}px`;
    ghostNode.style.height = 'auto';
    ghostNode.style.zIndex = '-1';
    ghostNode.style.transform = 'none';
    ghostNode.style.margin = '0';

    document.body.appendChild(ghostNode);

    try {
        await document.fonts.ready;
        const canvas = await html2canvasFunc(ghostNode, {
            scale: 3,
            useCORS: true,
            backgroundColor: '#ffffff',
            logging: false,
            windowWidth: captureWidth,
            allowTaint: true,
            fontEmbedCSS: true,
            ...html2canvasOptions,
        });
        return canvas;
    } finally {
        document.body.removeChild(ghostNode);
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

/**
 * 앱 로고 + 서브타이틀 이미지 생성 (공유 시 마지막에 추가)
 * @returns {Promise<Blob>}
 */
async function createMealogLogoImage() {
    const cw = 1080;
    const ch = 1080;
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
    const iconUrl = document.querySelector('#landingMealogIcon')?.src || new URL('assets/icon-only.png', window.location.href).href;
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            try {
                const iconSize = 280;
                const iconX = (cw - iconSize) / 2;
                const iconY = ch * 0.28;
                const radius = iconSize * 0.35;
                ctx.save();
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
                ctx.clip();
                ctx.drawImage(img, iconX, iconY, iconSize, iconSize);
                ctx.restore();
                ctx.fillStyle = '#059669';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.font = 'bold 72px "Fredoka", "Malgun Gothic", sans-serif';
                ctx.fillText('mealog', cw / 2, iconY + iconSize + 80);
                ctx.fillStyle = '#059669';
                ctx.font = 'bold 52px "Nanum Square Round", "Malgun Gothic", "Nanum Pen Script", sans-serif';
                ctx.fillText('우리가 함께한,', cw / 2, iconY + iconSize + 160);
                ctx.fillText('맛있었던 이야기', cw / 2, iconY + iconSize + 220);
            } catch (_) {}
            canvas.toBlob((blob) => resolve(blob ? blob : new Blob([], { type: 'image/jpeg' })), 'image/jpeg', 0.92);
        };
        img.onerror = () => {
            ctx.fillStyle = '#059669';
            ctx.font = 'bold 72px "Fredoka", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('mealog', cw / 2, ch / 2 - 60);
            ctx.font = 'bold 52px "Nanum Square Round", "Malgun Gothic", sans-serif';
            ctx.fillText('우리가 함께한,', cw / 2, ch / 2 + 10);
            ctx.fillText('맛있었던 이야기', cw / 2, ch / 2 + 70);
            canvas.toBlob((blob) => resolve(blob ? blob : new Blob([], { type: 'image/jpeg' })), 'image/jpeg', 0.92);
        };
        img.src = iconUrl;
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
                ctx.fillStyle = '#047857';
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

/**
 * 모먼트(앨범) 사진을 카카오톡·인스타그램 등 외부 앱으로 공유합니다.
 * 1) Web Share API(navigator.share)를 먼저 시도하고, 2) 앱에서 실패 시 Capacitor Share로 폴백.
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
    const isNative = typeof window.Capacitor !== 'undefined' && window.Capacitor?.isNativePlatform?.();

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
    try {
        const logoBlob = await createMealogLogoImage();
        if (logoBlob && logoBlob.size > 0) blobs.push(logoBlob);
    } catch (_) {}

    // 1) Web Share API 먼저 시도 (웹·앱 공통, 앱 WebView에서 동작하면 그대로 사용)
    if (navigator.share) {
        const files = blobs.map((blob, i) => {
            const ext = i >= blobs.length - 1 && blobs[blobs.length - 1] === blob ? 'jpg' : (urls[i]?.split('.').pop()?.split('?')[0] || 'jpg');
            const mime = blob.type || (ext === 'png' ? 'image/png' : 'image/jpeg');
            const name = i < urls.length ? `mealog_${i + 1}.${ext}` : 'mealog_logo.jpg';
            return new File([blob], name, { type: mime, lastModified: Date.now() });
        });
        const shareData = { files };
        if (!navigator.canShare || navigator.canShare(shareData)) {
            try {
                await navigator.share(shareData);
                if (typeof window.showToast === 'function') {
                    window.showToast('공유되었습니다.', 'success');
                }
                return true;
            } catch (e) {
                if (e.name === 'AbortError' || (e.message && /cancelled|canceled/i.test(e.message))) return false;
                if (!isNative) {
                    console.error('sharePhotosToExternal(웹) 실패:', e);
                    if (typeof window.showToast === 'function') window.showToast('공유에 실패했습니다.', 'error');
                    return false;
                }
                // 앱: Web Share 실패 → 아래 Capacitor Share 폴백으로 진행
            }
        }
    } else if (!isNative) {
        if (typeof window.showToast === 'function') {
            window.showToast('이 기기에서는 공유 기능을 지원하지 않습니다.', 'error');
        }
        return false;
    }

    // 2) 앱 전용 폴백: Capacitor Share + Filesystem (스크립트로 로드된 플러그인 사용, dynamic import 불가 환경 대응)
    if (!isNative) return false;

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
        for (let i = 0; i < blobs.length; i++) {
            const path = `${prefix}_${i}.jpg`;
            const base64 = await blobToBase64(blobs[i]);
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
        const shareFiles = fileUris.length === 1 ? [fileUris[0], fileUris[0]] : fileUris;
        const shareOptions = {
            files: shareFiles,
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
        console.error('sharePhotosToExternal(네이티브 폴백) 실패:', step, e);
        if (typeof window.showToast === 'function') {
            const stepMsg = step ? ` (${step} 단계)` : '';
            const shortMsg = (msg.length > 60 ? msg.slice(0, 60) + '…' : msg)
                .replace(/\s*@[\w/-]+\s*$/i, '');
            window.showToast('공유 실패.' + stepMsg + (shortMsg ? ' ' + shortMsg : ''), 'error');
        }
        return false;
    }
}



