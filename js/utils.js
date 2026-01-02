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
            canvas.width = 800;
            canvas.height = (img.height / img.width) * 800;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.6));
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



