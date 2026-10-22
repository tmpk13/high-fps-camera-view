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
