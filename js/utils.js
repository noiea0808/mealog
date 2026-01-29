// 유틸리티 함수들
import { storage } from './firebase.js';
import { ref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-storage.js";

// 프로덕션 환경 감지 (localhost 또는 127.0.0.1이 아니면 프로덕션)
const isProduction = () => {
    const hostname = window.location.hostname;
    return hostname !== 'localhost' && hostname !== '127.0.0.1' && !hostname.includes('192.168.');
};

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

// URL 정규화 함수 (쿼리 파라미터 제거) - 중복 제거
export function normalizeUrl(url) {
    if (!url || typeof url !== 'string') return '';
    return url.split('?')[0];
}

export function getInputIdFromContainer(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return null;
    if (containerId === 'restaurantSuggestions') return 'placeInput';
    if (containerId === 'menuSuggestions') return 'menuDetailInput';
    if (containerId === 'peopleSuggestions') return 'withWhomInput';
    if (containerId === 'snackSuggestions') return 'snackDetailInput';
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
                
                const targetSizeKB = 400;
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

// base64 이미지를 압축하여 Blob으로 변환 (마이그레이션용) - 뷰포트 기반
export function compressBase64ToBlob(base64DataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            const targetSizeKB = 500;
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
            
            let quality = 0.7;
            
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

// base64 이미지를 Storage에 업로드 (마이그레이션용)
export async function uploadBase64ToStorage(base64DataUrl, userId, entryId) {
    try {
        // base64를 압축된 Blob으로 변환
        const compressedBlob = await compressBase64ToBlob(base64DataUrl);
        
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

// base64 압축 (모달 미리보기/저장용) - 뷰포트 기반, 200KB 이하
export function compressImage(base64) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            const targetSizeKB = 200;
            const targetSizeBytes = targetSizeKB * 1024;
            const maxInitialWidth = getViewportMaxWidth();
            const minWidth = Math.max(300, Math.floor((typeof window !== 'undefined' ? (window.innerWidth || 390) : 390) * 0.8));
            
            let width = img.width;
            let height = img.height;
            
            if (width > maxInitialWidth) {
                height = (height / width) * maxInitialWidth;
                width = maxInitialWidth;
            }
            
            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(img, 0, 0, width, height);
            
            let quality = 0.45;
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
            
            while (currentSizeBytes > targetSizeBytes && quality > 0.1 && attempts < maxAttempts) {
                if (attempts < 5) {
                    quality -= 0.05;
                    if (quality < 0.1) quality = 0.1;
                } else {
                    if (width > minWidth) {
                        width = Math.max(minWidth, Math.floor(width * 0.9));
                        height = Math.floor((height / canvas.width) * width);
                        canvas.width = width;
                        canvas.height = height;
                        ctx.drawImage(img, 0, 0, width, height);
                    }
                    quality -= 0.03;
                    if (quality < 0.1) quality = 0.1;
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



