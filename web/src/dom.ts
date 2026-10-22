// Small DOM helpers shared by the UI modules.

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing #${id}`);
    return el as T;
};

export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Record<string, string | boolean> = {},
    ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (typeof v === "boolean") {
            if (v) node.setAttribute(k, "");
        } else if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else node.setAttribute(k, v);
    }
    node.append(...children);
    return node;
}

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: "info" | "ok" | "error" = "info", ms = 4000): void {
    toastHost ??= $("toasts");
    const t = el("div", { class: `toast ${kind}`, text: message });
    toastHost.append(t);
    setTimeout(() => t.remove(), ms);
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
    let handle: number | null = null;
    return (...args: A) => {
        if (handle !== null) clearTimeout(handle);
        handle = window.setTimeout(() => fn(...args), ms);
    };
}

export function download(filename: string, text: string, type = "text/csv"): void {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el("a", { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

/** Pointer drag on a handle: `onMove` gets deltas since the previous event, `onClick` fires for a tap without movement. */
export function dragHandle(handle: HTMLElement, onMove: (dx: number, dy: number) => void, onClick?: () => void, onEnd?: () => void): void {
    handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        let lastX = e.clientX;
        let lastY = e.clientY;
        let moved = false;
        const startX = e.clientX;
        const startY = e.clientY;
        document.body.classList.add("resizing");
        document.body.style.cursor = getComputedStyle(handle).cursor;
        const move = (ev: PointerEvent) => {
            if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 3) moved = true;
            if (moved) onMove(ev.clientX - lastX, ev.clientY - lastY);
            lastX = ev.clientX;
            lastY = ev.clientY;
        };
        const up = () => {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
            handle.removeEventListener("pointercancel", up);
            document.body.classList.remove("resizing");
            document.body.style.cursor = "";
            if (!moved) onClick?.();
            onEnd?.();
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
    });
}

export function remPx(): number {
    return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

export function storageGet(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

export function storageSet(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // storage unavailable
    }
}
