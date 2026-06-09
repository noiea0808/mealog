/**
 * 카메라 촬영 / 앨범 선택 — UI 버튼에서 각각 직접 호출
 */

function pickViaFileInput({ multiple = false, capture = null } = {}) {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        if (multiple) input.multiple = true;
        if (capture) input.setAttribute('capture', capture);

        let settled = false;
        const settle = (files) => {
            if (settled) return;
            settled = true;
            window.removeEventListener('focus', onWindowFocus);
            input.remove();
            resolve(files);
        };

        input.addEventListener(
            'change',
            () => {
                settle(Array.from(input.files || []));
            },
            { once: true }
        );

        const onWindowFocus = () => {
            window.setTimeout(() => {
                if (!settled && (!input.files || input.files.length === 0)) {
                    settle([]);
                }
            }, 400);
        };
        window.addEventListener('focus', onWindowFocus);

        input.style.cssText = 'position:fixed;left:-9999px;opacity:0;pointer-events:none;';
        document.body.appendChild(input);
        input.click();
    });
}

/** 후면(기본) 또는 전면 카메라로 1장 촬영 */
export function pickCameraImage({ facing = 'environment' } = {}) {
    return pickViaFileInput({ multiple: false, capture: facing });
}

/** 앨범·파일에서 이미지 선택 */
export function pickGalleryImages({ multiple = true } = {}) {
    return pickViaFileInput({ multiple });
}

/** @param {HTMLElement[]} buttons */
export function setPhotoAddButtonsEnabled(buttons, enabled, { disabledTitle = '' } = {}) {
    (buttons || []).forEach((btn) => {
        if (!btn) return;
        btn.disabled = !enabled;
        btn.classList.toggle('opacity-50', !enabled);
        btn.classList.toggle('cursor-not-allowed', !enabled);
        btn.classList.toggle('active:bg-slate-100', enabled);
        btn.title = enabled ? '' : disabledTitle;
    });
}
