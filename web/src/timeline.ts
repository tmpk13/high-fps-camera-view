// Canvas timeline: thumbnail strip, time ruler, markers, playhead, range and hover preview.

import type { Marker } from "./api";
import { frames } from "./frames";
import { clamp, fmtUs, frameAtOrBefore, nearestFrame, tickStepUs } from "./format";
import { store } from "./state";

type DragMode = "none" | "scrub" | "pan" | "marker" | "range";

interface Theme {
    fg: string;
    muted: string;
    line: string;
    bg: string;
    thumbBg: string;
    accent: string;
    playhead: string;
    trigger: string;
    rangeFill: string;
    font: string;
    fontPx: number;
}

export class Timeline {
    private ctx: CanvasRenderingContext2D;
    private width = 0;
    private height = 0;
    private dpr = 1;
    private t0 = 0;
    private t1 = 1;
    private dirty = true;
    private drag: DragMode = "none";
    private dragMarker: Marker | null = null;
    private dragStartX = 0;
    private dragStartT0 = 0;
    private hoverX: number | null = null;
    private hoverMarker: Marker | null = null;
    private rangeAnchor = 0;
    private follow = true;

    constructor(
        private canvas: HTMLCanvasElement,
        private hoverCard: HTMLElement,
        private hoverImg: HTMLImageElement,
        private hoverText: HTMLElement,
        private onMarkerRename: (m: Marker) => void,
    ) {
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no 2d context");
        this.ctx = ctx;
        new ResizeObserver(() => this.resize()).observe(canvas);
        frames.onLoaded = () => this.invalidate();
        store.on("recording", () => this.onRecording());
        store.on("frame", () => {
            if (this.follow) this.ensureVisible(store.frame);
            this.invalidate();
        });
        store.on("markers", () => this.invalidate());
        store.on("range", () => this.invalidate());
        store.on("play", () => this.invalidate());
        document.addEventListener("themechange", () => this.invalidate());
        canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
        canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
        canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
        canvas.addEventListener("pointercancel", (e) => this.onPointerUp(e));
        canvas.addEventListener("pointerleave", () => this.onPointerLeave());
        canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
        canvas.addEventListener("dblclick", (e) => this.onDoubleClick(e));
        this.resize();
        this.loop();
    }

    private get fullSpan(): number {
        const ts = store.timestamps;
        if (ts.length === 0) return 1;
        const last = ts[ts.length - 1] as number;
        const interval = ts.length > 1 ? last / (ts.length - 1) : 1000;
        return Math.max(last + interval, 1);
    }

    private get minSpan(): number {
        const ts = store.timestamps;
        const interval = ts.length > 1 ? (ts[ts.length - 1] as number) / (ts.length - 1) : 1000;
        return Math.max(interval * 4, 1);
    }

    private onRecording(): void {
        this.t0 = 0;
        this.t1 = this.fullSpan;
        this.follow = true;
        this.invalidate();
    }

    zoomAll(): void {
        this.t0 = 0;
        this.t1 = this.fullSpan;
        this.invalidate();
    }

    private invalidate(): void {
        this.dirty = true;
    }

    private loop(): void {
        if (this.dirty) {
            this.dirty = false;
            this.render();
        }
        requestAnimationFrame(() => this.loop());
    }

    private resize(): void {
        const rect = this.canvas.getBoundingClientRect();
        this.dpr = window.devicePixelRatio || 1;
        this.width = Math.max(1, rect.width);
        this.height = Math.max(1, rect.height);
        this.canvas.width = Math.round(this.width * this.dpr);
        this.canvas.height = Math.round(this.height * this.dpr);
        this.invalidate();
    }

    private theme(): Theme {
        const cs = getComputedStyle(this.canvas);
        const root = getComputedStyle(document.documentElement);
        const v = (name: string) => root.getPropertyValue(name).trim();
        const fontPx = parseFloat(cs.fontSize) || 14;
        return {
            fg: v("--fg-strong"),
            muted: v("--fg-muted"),
            line: v("--line"),
            bg: v("--bg-alt"),
            thumbBg: v("--thumb-bg"),
            accent: v("--accent"),
            playhead: v("--magenta"),
            trigger: v("--orange"),
            rangeFill: v("--cyan"),
            font: `${Math.round(fontPx * 0.78)}px ${v("--mono")}`,
            fontPx,
        };
    }

    private xOf(us: number): number {
        return ((us - this.t0) / (this.t1 - this.t0)) * this.width;
    }

    private usOf(x: number): number {
        return this.t0 + (x / this.width) * (this.t1 - this.t0);
    }

    private rulerH(th: Theme): number {
        return th.fontPx * 1.5;
    }

    private frameAtX(x: number): number {
        return nearestFrame(store.timestamps, this.usOf(x));
    }

    private markerAt(x: number, th: Theme): Marker | null {
        const ts = store.timestamps;
        let best: Marker | null = null;
        let bestD = th.fontPx * 0.5;
        for (const m of store.markers) {
            const d = Math.abs(this.xOf(ts[m.frame] ?? 0) - x);
            if (d < bestD) {
                bestD = d;
                best = m;
            }
        }
        return best;
    }

    private ensureVisible(frame: number): void {
        const t = store.timestamps[frame];
        if (t === undefined) return;
        const span = this.t1 - this.t0;
        if (t < this.t0 || t > this.t1) {
            this.t0 = clamp(t - span * 0.2, 0, this.fullSpan - span);
            this.t1 = this.t0 + span;
        }
    }

    private setWindow(t0: number, t1: number): void {
        const full = this.fullSpan;
        let span = clamp(t1 - t0, this.minSpan, full);
        t0 = clamp(t0, 0, full - span);
        this.t0 = t0;
        this.t1 = t0 + span;
        this.invalidate();
    }

    // ---- rendering ----

    private render(): void {
        const th = this.theme();
        const ctx = this.ctx;
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.clearRect(0, 0, this.width, this.height);
        const meta = store.meta;
        ctx.fillStyle = th.bg;
        ctx.fillRect(0, 0, this.width, this.height);
        if (!meta || meta.frame_count === 0) {
            ctx.fillStyle = th.muted;
            ctx.font = th.font;
            ctx.fillText("no recording", 10, this.height / 2);
            return;
        }
        const rulerH = this.rulerH(th);
        this.drawThumbs(th, rulerH, meta.width / meta.height);
        this.drawRange(th, rulerH);
        this.drawRuler(th, rulerH);
        this.drawTrigger(th, rulerH);
        this.drawMarkers(th, rulerH);
        this.drawPlayhead(th);
        if (this.hoverX !== null && this.drag === "none") {
            ctx.strokeStyle = th.muted;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(this.hoverX + 0.5, rulerH);
            ctx.lineTo(this.hoverX + 0.5, this.height);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }

    private drawThumbs(th: Theme, rulerH: number, aspect: number): void {
        const ctx = this.ctx;
        const ts = store.timestamps;
        const top = rulerH + 1;
        const thumbH = this.height - top - 1;
        const thumbW = Math.max(8, thumbH * aspect);
        const usPerPx = (this.t1 - this.t0) / this.width;
        const interval = ts.length > 1 ? (ts[ts.length - 1] as number) / (ts.length - 1) : 1000;
        const framePx = interval / usPerPx;
        ctx.fillStyle = th.thumbBg;
        ctx.fillRect(0, top, this.width, thumbH);
        let wanted: number[] = [];
        if (framePx >= thumbW) {
            // Zoomed in: every frame gets its own tile at its timestamp.
            const first = Math.max(0, frameAtOrBefore(ts, this.t0));
            const last = Math.min(ts.length - 1, nearestFrame(ts, this.t1) + 1);
            for (let i = first; i <= last; i++) {
                const x = this.xOf(ts[i] as number);
                const next = i + 1 < ts.length ? this.xOf(ts[i + 1] as number) : x + framePx;
                const w = Math.min(thumbW, next - x - 1);
                this.drawTile(th, i, x, top, w, thumbH);
                wanted.push(i);
                this.divider(th, x, top, thumbH);
            }
        } else {
            const slots = Math.ceil(this.width / thumbW);
            let prevFrame = -1;
            for (let k = 0; k < slots; k++) {
                const x = k * thumbW;
                const i = nearestFrame(ts, this.usOf(x + thumbW / 2));
                if (i === prevFrame) continue;
                prevFrame = i;
                this.drawTile(th, i, x, top, thumbW - 2, thumbH);
                wanted.push(i);
                if (k > 0) this.divider(th, x, top, thumbH);
            }
        }
        // Load the visible frames that are not cached yet, nearest to the playhead first.
        wanted = wanted.filter((i) => !frames.get(i));
        wanted.sort((a, b) => Math.abs(a - store.frame) - Math.abs(b - store.frame));
        for (const i of wanted.slice(0, 16)) {
            if (frames.inflight >= 8) break;
            void frames.load(i).catch(() => {});
        }
    }

    private divider(th: Theme, x: number, top: number, h: number): void {
        const ctx = this.ctx;
        ctx.strokeStyle = th.muted;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.round(x), top);
        ctx.lineTo(Math.round(x), top + h);
        ctx.stroke();
        ctx.lineWidth = 1;
    }

    private drawTile(th: Theme, i: number, x: number, y: number, w: number, h: number): void {
        const img = frames.get(i);
        if (w <= 0) return;
        if (img) {
            const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
            const dw = img.naturalWidth * scale;
            const dh = img.naturalHeight * scale;
            this.ctx.drawImage(img, x, y + (h - dh) / 2, dw, dh);
        } else {
            this.ctx.fillStyle = th.line;
            this.ctx.fillRect(x + 1, y + h * 0.45, Math.max(1, w - 2), 2);
        }
    }

    private drawRuler(th: Theme, rulerH: number): void {
        const ctx = this.ctx;
        ctx.fillStyle = th.bg;
        ctx.fillRect(0, 0, this.width, rulerH);
        ctx.strokeStyle = th.line;
        ctx.beginPath();
        ctx.moveTo(0, rulerH + 0.5);
        ctx.lineTo(this.width, rulerH + 0.5);
        ctx.stroke();
        const usPerPx = (this.t1 - this.t0) / this.width;
        const step = tickStepUs(usPerPx, th.fontPx * 5.5);
        const minor = step / 5;
        ctx.font = th.font;
        ctx.textBaseline = "top";
        const start = Math.floor(this.t0 / minor) * minor;
        for (let t = start; t <= this.t1; t += minor) {
            const x = Math.round(this.xOf(t)) + 0.5;
            const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
            ctx.strokeStyle = major ? th.muted : th.line;
            ctx.beginPath();
            ctx.moveTo(x, major ? rulerH * 0.45 : rulerH * 0.75);
            ctx.lineTo(x, rulerH);
            ctx.stroke();
            if (major) {
                ctx.fillStyle = th.muted;
                ctx.fillText(fmtUs(Math.round(t)), x + 3, 2);
            }
        }
    }

    private drawRange(th: Theme, rulerH: number): void {
        const { a, b } = store.range;
        const ts = store.timestamps;
        if (a === null && b === null) return;
        const ctx = this.ctx;
        const ta = a !== null ? (ts[a] ?? 0) : null;
        const tb = b !== null ? (ts[b] ?? 0) : null;
        if (ta !== null && tb !== null) {
            const x0 = this.xOf(Math.min(ta, tb));
            const x1 = this.xOf(Math.max(ta, tb));
            ctx.fillStyle = th.rangeFill;
            ctx.globalAlpha = 0.18;
            ctx.fillRect(x0, rulerH, Math.max(1, x1 - x0), this.height - rulerH);
            ctx.globalAlpha = 1;
            const label = `${fmtUs(Math.abs(tb - ta))}  (${Math.abs((b as number) - (a as number))} frames)`;
            ctx.font = th.font;
            ctx.textBaseline = "bottom";
            const tw = ctx.measureText(label).width + 8;
            const lx = clamp((x0 + x1) / 2 - tw / 2, 0, this.width - tw);
            ctx.fillStyle = th.rangeFill;
            ctx.fillRect(lx, this.height - th.fontPx * 1.3, tw, th.fontPx * 1.2);
            ctx.fillStyle = "#fdf6e3";
            ctx.fillText(label, lx + 4, this.height - 2);
        }
        for (const [t, name] of [[ta, "I"], [tb, "O"]] as const) {
            if (t === null) continue;
            const x = Math.round(this.xOf(t)) + 0.5;
            ctx.strokeStyle = th.rangeFill;
            ctx.beginPath();
            ctx.moveTo(x, rulerH);
            ctx.lineTo(x, this.height);
            ctx.stroke();
            ctx.fillStyle = th.rangeFill;
            ctx.font = th.font;
            ctx.textBaseline = "top";
            ctx.fillText(name, x + 2, rulerH + 2);
        }
    }

    private drawTrigger(th: Theme, rulerH: number): void {
        const tf = store.meta?.trigger_frame;
        if (tf === null || tf === undefined) return;
        const t = store.timestamps[tf];
        if (t === undefined) return;
        const x = Math.round(this.xOf(t)) + 0.5;
        const ctx = this.ctx;
        ctx.strokeStyle = th.trigger;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, this.height);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = th.trigger;
        ctx.font = th.font;
        ctx.textBaseline = "top";
        ctx.fillText("trigger", x + 3, rulerH * 0.5);
    }

    private drawMarkers(th: Theme, rulerH: number): void {
        const ctx = this.ctx;
        const ts = store.timestamps;
        ctx.font = th.font;
        ctx.textBaseline = "middle";
        for (const m of store.markers) {
            const t = ts[m.frame];
            if (t === undefined) continue;
            const x = Math.round(this.xOf(t)) + 0.5;
            if (x < -50 || x > this.width + 50) continue;
            const isRef = m.id === store.refId;
            ctx.strokeStyle = m.color;
            ctx.lineWidth = isRef ? 2 : 1;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, this.height);
            ctx.stroke();
            ctx.lineWidth = 1;
            const label = (isRef ? "* " : "") + m.name;
            const tw = ctx.measureText(label).width + 6;
            const flagH = rulerH * 0.6;
            ctx.fillStyle = m.color;
            ctx.fillRect(x, rulerH - flagH, tw, flagH);
            ctx.fillStyle = "#fdf6e3";
            ctx.fillText(label, x + 3, rulerH - flagH / 2);
        }
    }

    private drawPlayhead(th: Theme): void {
        const t = store.timestamps[store.frame];
        if (t === undefined) return;
        const x = Math.round(this.xOf(t)) + 0.5;
        const ctx = this.ctx;
        ctx.strokeStyle = th.playhead;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, this.height);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.fillStyle = th.playhead;
        ctx.beginPath();
        ctx.moveTo(x - 5, 0);
        ctx.lineTo(x + 5, 0);
        ctx.lineTo(x, 6);
        ctx.closePath();
        ctx.fill();
    }

    // ---- interaction ----

    private localX(e: PointerEvent | MouseEvent): number {
        return e.clientX - this.canvas.getBoundingClientRect().left;
    }

    private localY(e: PointerEvent | MouseEvent): number {
        return e.clientY - this.canvas.getBoundingClientRect().top;
    }

    private onPointerDown(e: PointerEvent): void {
        if (!store.meta) return;
        const th = this.theme();
        const x = this.localX(e);
        const y = this.localY(e);
        this.canvas.setPointerCapture(e.pointerId);
        const marker = this.markerAt(x, th);
        if (marker && !e.shiftKey) {
            this.drag = "marker";
            this.dragMarker = marker;
            store.setFrame(marker.frame);
        } else if (e.button === 1 || y < this.rulerH(th)) {
            this.drag = "pan";
            this.dragStartX = x;
            this.dragStartT0 = this.t0;
        } else if (e.shiftKey) {
            this.drag = "range";
            this.rangeAnchor = this.frameAtX(x);
            store.setRange({ a: this.rangeAnchor, b: this.rangeAnchor });
        } else {
            this.drag = "scrub";
            this.follow = false;
            store.setFrame(this.frameAtX(x));
        }
        this.hideHover();
        this.invalidate();
    }

    private onPointerMove(e: PointerEvent): void {
        if (!store.meta) return;
        const x = this.localX(e);
        const th = this.theme();
        switch (this.drag) {
            case "scrub":
                store.setFrame(this.frameAtX(x));
                break;
            case "pan": {
                const usPerPx = (this.t1 - this.t0) / this.width;
                const span = this.t1 - this.t0;
                const t0 = this.dragStartT0 - (x - this.dragStartX) * usPerPx;
                this.setWindow(t0, t0 + span);
                break;
            }
            case "marker":
                if (this.dragMarker) {
                    const f = this.frameAtX(x);
                    this.dragMarker.frame = f;
                    store.setFrame(f);
                    this.invalidate();
                }
                break;
            case "range": {
                const f = this.frameAtX(x);
                store.setRange({ a: Math.min(this.rangeAnchor, f), b: Math.max(this.rangeAnchor, f) });
                store.setFrame(f);
                break;
            }
            case "none": {
                this.hoverX = x;
                const m = this.markerAt(x, th);
                this.hoverMarker = m;
                const frame = m ? m.frame : this.frameAtX(x);
                this.showHover(x, frame, m);
                this.invalidate();
                this.canvas.style.cursor = m ? "ew-resize" : this.localY(e) < this.rulerH(th) ? "grab" : "crosshair";
                break;
            }
        }
    }

    private onPointerUp(e: PointerEvent): void {
        if (this.drag === "marker" && this.dragMarker) {
            store.setMarkers([...store.markers]);
        }
        if (this.drag === "scrub") this.follow = true;
        this.drag = "none";
        this.dragMarker = null;
        try {
            this.canvas.releasePointerCapture(e.pointerId);
        } catch {
            // pointer was already released
        }
        this.invalidate();
    }

    private onPointerLeave(): void {
        if (this.drag !== "none") return;
        this.hoverX = null;
        this.hideHover();
        this.invalidate();
    }

    private onWheel(e: WheelEvent): void {
        if (!store.meta) return;
        e.preventDefault();
        const x = this.localX(e);
        const span = this.t1 - this.t0;
        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
            const delta = (e.shiftKey ? e.deltaY : e.deltaX) * (span / this.width);
            this.setWindow(this.t0 + delta, this.t1 + delta);
            return;
        }
        const factor = Math.exp(e.deltaY * 0.0015);
        const anchor = this.usOf(x);
        const newSpan = clamp(span * factor, this.minSpan, this.fullSpan);
        const t0 = anchor - (x / this.width) * newSpan;
        this.setWindow(t0, t0 + newSpan);
        if (this.hoverX !== null) this.onPointerMove(e as unknown as PointerEvent);
    }

    private onDoubleClick(e: MouseEvent): void {
        const m = this.markerAt(this.localX(e), this.theme());
        if (m) this.onMarkerRename(m);
    }

    private showHover(x: number, frame: number, marker: Marker | null): void {
        const ts = store.timestamps;
        const t = ts[frame] ?? 0;
        const img = frames.get(frame);
        if (img) this.hoverImg.src = img.src;
        else {
            this.hoverImg.removeAttribute("src");
            void frames.load(frame).then((loaded) => {
                if (this.hoverX !== null && this.frameAtX(this.hoverX) === frame) this.hoverImg.src = loaded.src;
            }).catch(() => {});
        }
        const ref = store.markers.find((m) => m.id === store.refId);
        const lines = [`frame ${frame}`, `t = ${fmtUs(t)}`];
        if (marker) lines.unshift(marker.name);
        if (ref && ref.frame !== frame) lines.push(`from ${ref.name}: ${fmtUs(t - (ts[ref.frame] ?? 0), true)}`);
        else if (store.frame !== frame) lines.push(`from playhead: ${fmtUs(t - (ts[store.frame] ?? 0), true)}`);
        this.hoverText.textContent = lines.join("\n");
        this.hoverCard.hidden = false;
        const cardW = this.hoverCard.offsetWidth || 200;
        const left = clamp(x - cardW / 2, 0, Math.max(0, this.width - cardW));
        this.hoverCard.style.left = `${left}px`;
    }

    private hideHover(): void {
        this.hoverCard.hidden = true;
        this.hoverMarker = null;
    }
}
