// Wheel zoom and drag pan for the viewer; applies to live and recorded views alike.

import { clamp } from "./format";

const MIN_SCALE = 1;
const MAX_SCALE = 24;

export class ViewZoom {
    private scale = 1;
    private ox = 0;
    private oy = 0;

    constructor(private host: HTMLElement, private layer: HTMLElement, private note: HTMLElement) {
        host.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
        host.addEventListener("pointerdown", (e) => this.onPointerDown(e));
        host.addEventListener("dblclick", () => this.reset());
        new ResizeObserver(() => this.apply()).observe(host);
    }

    reset(): void {
        this.scale = 1;
        this.ox = 0;
        this.oy = 0;
        this.apply();
    }

    private onWheel(e: WheelEvent): void {
        e.preventDefault();
        const rect = this.host.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const factor = Math.exp(-e.deltaY * 0.0015);
        const next = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
        const f = next / this.scale;
        this.ox = cx - (cx - this.ox) * f;
        this.oy = cy - (cy - this.oy) * f;
        this.scale = next;
        this.apply();
    }

    private onPointerDown(e: PointerEvent): void {
        if (this.scale <= 1 || e.button !== 0) return;
        e.preventDefault();
        this.host.setPointerCapture(e.pointerId);
        this.host.classList.add("panning");
        let lastX = e.clientX;
        let lastY = e.clientY;
        const move = (ev: PointerEvent) => {
            this.ox += ev.clientX - lastX;
            this.oy += ev.clientY - lastY;
            lastX = ev.clientX;
            lastY = ev.clientY;
            this.apply();
        };
        const up = () => {
            this.host.removeEventListener("pointermove", move);
            this.host.removeEventListener("pointerup", up);
            this.host.removeEventListener("pointercancel", up);
            this.host.classList.remove("panning");
        };
        this.host.addEventListener("pointermove", move);
        this.host.addEventListener("pointerup", up);
        this.host.addEventListener("pointercancel", up);
    }

    private apply(): void {
        const w = this.host.clientWidth;
        const h = this.host.clientHeight;
        if (this.scale <= 1) {
            this.ox = 0;
            this.oy = 0;
        } else {
            // The layer is as large as the host, so keep its scaled box covering the host.
            this.ox = clamp(this.ox, w * (1 - this.scale), 0);
            this.oy = clamp(this.oy, h * (1 - this.scale), 0);
        }
        this.layer.style.transform = `translate(${this.ox}px, ${this.oy}px) scale(${this.scale})`;
        this.host.classList.toggle("zoomed", this.scale > 1);
        this.note.hidden = this.scale <= 1;
        this.note.textContent = `${this.scale.toFixed(1)}x  double click to reset`;
    }
}
