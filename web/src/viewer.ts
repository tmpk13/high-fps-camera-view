// Recording viewer: current frame display, overlays, transport and playback.

import { frames } from "./frames";
import { fmtFps, fmtUs, frameAtOrBefore, nominalUs } from "./format";
import { store } from "./state";

const $ = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing #${id}`);
    return el as T;
};

export class Viewer {
    private img = $<HTMLImageElement>("rec-img");
    private ovFrame = $("ov-frame");
    private ovTime = $("ov-time");
    private ovRef = $("ov-ref");
    private info = $("rec-info");
    private inFrame = $<HTMLInputElement>("in-frame");
    private frameTotal = $("frame-total");
    private btnPlay = $<HTMLButtonElement>("btn-play");
    private selSpeed = $<HTMLSelectElement>("sel-speed");
    private rangeReadout = $("range-readout");
    private timer: number | null = null;
    private raf: number | null = null;
    private shownFrame = -1;

    constructor() {
        store.on("frame", () => this.showFrame());
        store.on("recording", () => this.onRecording());
        store.on("markers", () => this.updateOverlay());
        store.on("range", () => this.updateRange());
        store.on("play", () => this.onPlayChanged());
        $("btn-first").onclick = () => store.setFrame(0);
        $("btn-last").onclick = () => store.setFrame(store.frameCount - 1);
        $("btn-prev").onclick = () => this.step(-1);
        $("btn-next").onclick = () => this.step(1);
        $("btn-prev-marker").onclick = () => this.jumpMarker(-1);
        $("btn-next-marker").onclick = () => this.jumpMarker(1);
        this.btnPlay.onclick = () => store.setPlaying(!store.playing);
        this.inFrame.onchange = () => store.setFrame(Number(this.inFrame.value));
        this.selSpeed.onchange = () => {
            if (store.playing) {
                this.stopTimers();
                this.startTimers();
            }
        };
        $("btn-set-in").onclick = () => this.setIn();
        $("btn-set-out").onclick = () => this.setOut();
    }

    step(delta: number): void {
        store.setPlaying(false);
        store.setFrame(store.frame + delta);
    }

    jumpMarker(dir: number): void {
        const sorted = [...store.markers].sort((a, b) => a.frame - b.frame);
        const f = store.frame;
        const target = dir > 0 ? sorted.find((m) => m.frame > f) : [...sorted].reverse().find((m) => m.frame < f);
        if (target) {
            store.setPlaying(false);
            store.setFrame(target.frame);
        }
    }

    setIn(): void {
        const r = store.range;
        store.setRange({ a: store.frame, b: r.b !== null && r.b >= store.frame ? r.b : null });
    }

    setOut(): void {
        const r = store.range;
        store.setRange({ a: r.a !== null && r.a <= store.frame ? r.a : null, b: store.frame });
    }

    private onRecording(): void {
        this.stopTimers();
        this.shownFrame = -1;
        const meta = store.meta;
        this.frameTotal.textContent = meta ? `/ ${meta.frame_count - 1}` : "";
        this.inFrame.max = meta ? String(meta.frame_count - 1) : "0";
        if (meta) {
            const parts = [
                `${meta.width}x${meta.height} ${meta.fourcc}`,
                `${fmtFps(meta.fps_measured)} fps measured (${fmtFps(meta.fps_nominal)} nominal)`,
                `${meta.frame_count} frames`,
                `${fmtUs(meta.timestamps_us[meta.frame_count - 1] ?? 0)} span`,
            ];
            if (meta.dropped > 0) parts.push(`${meta.dropped} dropped`);
            if (meta.note) parts.push(meta.note);
            this.info.textContent = parts.join("  |  ");
        }
        this.showFrame();
        this.updateRange();
    }

    private showFrame(): void {
        const meta = store.meta;
        if (!meta) return;
        const i = store.frame;
        this.inFrame.value = String(i);
        this.updateOverlay();
        if (i === this.shownFrame) return;
        this.shownFrame = i;
        const cached = frames.get(i);
        if (cached) {
            this.img.src = cached.src;
        } else {
            void frames.load(i).then((img) => {
                if (store.frame === i) this.img.src = img.src;
            }).catch(() => {});
        }
        frames.prefetch(i, store.playing ? 30 : 10, meta.frame_count);
    }

    private updateOverlay(): void {
        const meta = store.meta;
        if (!meta) return;
        const i = store.frame;
        const ts = store.timestamps;
        const t = ts[i] ?? 0;
        this.ovFrame.textContent = `frame ${i}`;
        this.ovTime.textContent = `t = ${fmtUs(t)}`;
        const ref = store.markers.find((m) => m.id === store.refId);
        if (ref) {
            const d = t - (ts[ref.frame] ?? 0);
            const nominal = nominalUs(i - ref.frame, meta.fps_measured);
            this.ovRef.textContent = `from ${ref.name}: ${fmtUs(d, true)} (${i - ref.frame} frames, nominal ${fmtUs(nominal, true)})`;
        } else if (meta.trigger_frame !== null) {
            const d = t - (ts[meta.trigger_frame] ?? 0);
            this.ovRef.textContent = `from trigger: ${fmtUs(d, true)}`;
        } else {
            this.ovRef.textContent = "";
        }
    }

    private updateRange(): void {
        const { a, b } = store.range;
        const ts = store.timestamps;
        if (a !== null && b !== null) {
            const d = (ts[b] ?? 0) - (ts[a] ?? 0);
            this.rangeReadout.textContent = `In ${a} to Out ${b}: ${fmtUs(d)} (${b - a} frames)`;
        } else if (a !== null) {
            this.rangeReadout.textContent = `In ${a}`;
        } else if (b !== null) {
            this.rangeReadout.textContent = `Out ${b}`;
        } else {
            this.rangeReadout.textContent = "";
        }
    }

    private onPlayChanged(): void {
        this.btnPlay.textContent = store.playing ? "Pause" : "Play";
        if (store.playing) this.startTimers();
        else this.stopTimers();
    }

    private startTimers(): void {
        this.stopTimers();
        const meta = store.meta;
        if (!meta) return;
        if (store.frame >= meta.frame_count - 1) store.setFrame(0);
        const speed = this.selSpeed.value;
        if (speed === "realtime") {
            const ts = store.timestamps;
            const startWall = performance.now();
            const startUs = ts[store.frame] ?? 0;
            const tick = () => {
                const elapsed = (performance.now() - startWall) * 1000;
                const f = frameAtOrBefore(ts, startUs + elapsed);
                store.setFrame(f);
                if (f >= meta.frame_count - 1) {
                    store.setPlaying(false);
                    return;
                }
                this.raf = requestAnimationFrame(tick);
            };
            this.raf = requestAnimationFrame(tick);
        } else {
            const fps = Number(speed);
            this.timer = window.setInterval(() => {
                if (store.frame >= meta.frame_count - 1) {
                    store.setPlaying(false);
                    return;
                }
                store.setFrame(store.frame + 1);
            }, 1000 / fps);
        }
    }

    private stopTimers(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.raf !== null) {
            cancelAnimationFrame(this.raf);
            this.raf = null;
        }
    }
}
