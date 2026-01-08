// 유틸리티 함수들
export function setVal(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
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

export function compressImage(base64) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            // 이미지당 200KB 이하로 제한 (base64 문자열 크기 기준)
            const targetSizeKB = 200;
            const targetSizeBytes = targetSizeKB * 1024;
            
            // 원본 비율 유지하면서 리사이즈
            let width = img.width;
            let height = img.height;
            
            // 초기 리사이즈 (최대 800px)
            const maxInitialWidth = 800;
            if (width > maxInitialWidth) {
                height = (height / width) * maxInitialWidth;
                width = maxInitialWidth;
            }
            
            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(img, 0, 0, width, height);
            
            // 품질 0.45부터 시작
            let quality = 0.45;
            let dataUrl = canvas.toDataURL('image/jpeg', quality);
            
            // base64 문자열 크기 계산 (실제로는 base64가 약 33% 더 크지만, 문자열 길이로 계산)
            // base64 문자열의 바이트 크기 = (문자열 길이 * 3) / 4 (대략)
            // 하지만 더 정확하게는 실제 base64 데이터 부분만 계산
            const getBase64Size = (dataUrl) => {
                const base64Data = dataUrl.split(',')[1] || dataUrl;
                // base64는 패딩을 제외하고 실제 데이터 크기 = (문자열 길이 * 3) / 4
                // 패딩 문자(=)는 제외하고 계산
                const paddingCount = (base64Data.match(/=/g) || []).length;
                const actualLength = base64Data.length - paddingCount;
                return (actualLength * 3) / 4;
            };
            
            let currentSizeBytes = getBase64Size(dataUrl);
            
            // 200KB 이하가 될 때까지 품질을 낮춰가며 반복 압축
            let attempts = 0;
            const maxAttempts = 15;
            
            while (currentSizeBytes > targetSizeBytes && quality > 0.1 && attempts < maxAttempts) {
                if (attempts < 5) {
                    // 처음 5번은 품질만 조정
                    quality -= 0.05;
                    if (quality < 0.1) quality = 0.1;
                } else {
                    // 이후에는 해상도도 줄임
                    if (width > 300) {
                        width = Math.max(300, Math.floor(width * 0.9));
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



