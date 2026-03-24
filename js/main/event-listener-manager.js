/**
 * DOM 이벤트 리스너 중복 등록 방지·정리 (디버깅용 Mealog.eventListenerManager)
 */
export const eventListenerManager = {
    listeners: new Map(),

    add(element, eventType, handler, options = false) {
        if (!element) return;

        const key = `${eventType}_${options ? JSON.stringify(options) : 'default'}`;

        if (this.listeners.has(element)) {
            const elementListeners = this.listeners.get(element);
            if (elementListeners.has(key)) {
                const oldHandler = elementListeners.get(key);
                element.removeEventListener(eventType, oldHandler, options);
            }
        } else {
            this.listeners.set(element, new Map());
        }

        this.listeners.get(element).set(key, handler);
        element.addEventListener(eventType, handler, options);
    },

    removeAll(element) {
        if (!element || !this.listeners.has(element)) return;

        const elementListeners = this.listeners.get(element);
        elementListeners.forEach((handler, key) => {
            const [eventType, optionsStr] = key.split('_');
            const opts = optionsStr !== 'default' ? JSON.parse(optionsStr) : false;
            element.removeEventListener(eventType, handler, opts);
        });

        this.listeners.delete(element);
    },

    clear() {
        this.listeners.forEach((elementListeners, element) => {
            elementListeners.forEach((handler, key) => {
                const [eventType, optionsStr] = key.split('_');
                const opts = optionsStr !== 'default' ? JSON.parse(optionsStr) : false;
                element.removeEventListener(eventType, handler, opts);
            });
        });
        this.listeners.clear();
    }
};

export function registerEventListenerManager() {
    window.Mealog = window.Mealog || {};
    window.Mealog.eventListenerManager = eventListenerManager;
}
