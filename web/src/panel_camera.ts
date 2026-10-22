// Camera format and control editing.

import { api, type ControlInfo, type FormatInfo } from "./api";
import { $, debounce, el, toast } from "./dom";
import { fmtFps } from "./format";
import { store } from "./state";

export class CameraPanel {
    private selFormat = $<HTMLSelectElement>("sel-format");
    private selSize = $<HTMLSelectElement>("sel-size");
    private selFps = $<HTMLSelectElement>("sel-fps");
    private note = $("config-note");
    private form = $("controls-form");
    private formats: FormatInfo[] = [];
    private controls: ControlInfo[] = [];
    private loaded = false;

    constructor() {
        this.selFormat.onchange = () => this.fillSizes();
        this.selSize.onchange = () => this.fillFps();
        $("btn-apply-config").onclick = () => void this.apply();
        $("btn-controls-refresh").onclick = () => void this.loadControls();
        $("btn-controls-reset").onclick = () => void this.resetControls();
        store.on("status", () => this.updateNote());
    }

    /** Called when the panel becomes visible or the camera reopens. */
    async refresh(): Promise<void> {
        try {
            this.formats = await api.formats();
            this.fillFormats();
            await this.loadControls();
            this.loaded = true;
        } catch (e) {
            this.note.textContent = `camera not available: ${(e as Error).message}`;
        }
    }

    ensureLoaded(): void {
        if (!this.loaded) void this.refresh();
    }

    private fillFormats(): void {
        const cfg = store.status?.config;
        this.selFormat.replaceChildren(
            ...this.formats.map((f) =>
                el("option", { value: f.fourcc, text: `${f.fourcc} - ${f.description}${f.supported ? "" : " (not supported)"}`, disabled: !f.supported }),
            ),
        );
        if (cfg) this.selFormat.value = cfg.fourcc;
        this.fillSizes();
    }

    private fillSizes(): void {
        const cfg = store.status?.config;
        const f = this.formats.find((x) => x.fourcc === this.selFormat.value);
        this.selSize.replaceChildren(
            ...(f?.sizes ?? []).map((s) => el("option", { value: `${s.width}x${s.height}`, text: `${s.width} x ${s.height}` })),
        );
        if (cfg && f?.fourcc === cfg.fourcc) this.selSize.value = `${cfg.width}x${cfg.height}`;
        this.fillFps();
    }

    private fillFps(): void {
        const cfg = store.status?.config;
        const f = this.formats.find((x) => x.fourcc === this.selFormat.value);
        const [w, h] = this.selSize.value.split("x").map(Number);
        const s = f?.sizes.find((x) => x.width === w && x.height === h);
        this.selFps.replaceChildren(
            ...(s?.intervals ?? []).map((i) => el("option", { value: String(i.fps), text: `${fmtFps(i.fps)} fps` })),
        );
        if (cfg && f?.fourcc === cfg.fourcc && w === cfg.width && h === cfg.height) {
            const match = Array.from(this.selFps.options).find((o) => Math.abs(Number(o.value) - cfg.fps) < 0.5);
            if (match) this.selFps.value = match.value;
        }
        this.updateNote();
    }

    private updateNote(): void {
        const st = store.status;
        if (!st) return;
        const parts = [
            `Current: ${st.config.width}x${st.config.height} ${st.config.fourcc}, driver says ${fmtFps(st.config.fps)} fps, measured ${fmtFps(st.actual_fps)} fps.`,
        ];
        if (Math.abs(st.actual_fps - st.config.fps) > st.config.fps * 0.1 && st.actual_fps > 0) {
            parts.push("The camera streams at a different rate than it advertises; measurements use timestamps so they stay correct.");
        }
        if (st.config.fourcc !== "MJPG") parts.push(`Raw frames are JPEG encoded on the host (${st.process_us.toFixed(0)} us per frame).`);
        this.note.textContent = parts.join(" ");
    }

    private async apply(): Promise<void> {
        const [width, height] = this.selSize.value.split("x").map(Number);
        const fps = Number(this.selFps.value);
        if (!width || !height || !fps) return;
        try {
            await api.setConfig({ width, height, fourcc: this.selFormat.value, fps });
            toast("camera reconfigured", "ok");
            setTimeout(() => void this.loadControls(), 500);
        } catch (e) {
            toast(`config failed: ${(e as Error).message}`, "error");
        }
    }

    private async loadControls(): Promise<void> {
        try {
            this.controls = await api.controls();
            this.renderControls();
        } catch (e) {
            this.form.replaceChildren(el("p", { class: "muted small-text", text: `controls unavailable: ${(e as Error).message}` }));
        }
    }

    private async resetControls(): Promise<void> {
        for (const c of this.controls) {
            if (c.kind === "button" || c.read_only) continue;
            try {
                await api.setControl(c.id, c.default);
            } catch {
                // some controls refuse while inactive; the refresh below shows the real state
            }
        }
        await this.loadControls();
    }

    private renderControls(): void {
        this.form.replaceChildren();
        for (const c of this.controls) {
            const row = el("div", { class: `ctrl ${c.inactive ? "inactive" : ""}` });
            row.append(el("span", { text: c.name, title: c.name }));
            const send = async (value: number) => {
                try {
                    await api.setControl(c.id, value);
                    // Menu changes (auto exposure) toggle which controls are active.
                    if (c.kind === "menu" || c.kind === "boolean") setTimeout(() => void this.loadControls(), 150);
                } catch (e) {
                    toast(`${c.name}: ${(e as Error).message}`, "error");
                }
            };
            if (c.kind === "integer") {
                const val = el("span", { class: "val", text: String(c.value ?? "") });
                const range = el("input", {
                    type: "range",
                    min: String(c.min),
                    max: String(c.max),
                    step: String(c.step || 1),
                    value: String(c.value ?? c.default),
                    disabled: c.read_only,
                });
                const sendDebounced = debounce((v: number) => void send(v), 80);
                range.oninput = () => {
                    val.textContent = range.value;
                    sendDebounced(Number(range.value));
                };
                val.title = "click to type a value";
                val.onclick = () => {
                    const v = prompt(`${c.name} (${c.min} to ${c.max})`, range.value);
                    if (v !== null && v.trim() !== "" && !Number.isNaN(Number(v))) {
                        range.value = v;
                        val.textContent = v;
                        void send(Number(v));
                    }
                };
                row.append(range, val);
            } else if (c.kind === "boolean") {
                const cb = el("input", { type: "checkbox", disabled: c.read_only });
                cb.checked = (c.value ?? c.default) !== 0;
                cb.onchange = () => void send(cb.checked ? 1 : 0);
                row.append(cb, el("span"));
            } else if (c.kind === "menu") {
                const sel = el("select", { disabled: c.read_only }, ...c.items.map((i) => el("option", { value: String(i.value), text: i.name })));
                sel.value = String(c.value ?? c.default);
                sel.onchange = () => void send(Number(sel.value));
                row.append(sel, el("span"));
            } else {
                const b = el("button", { class: "small", text: "Run" });
                b.onclick = () => void send(0);
                row.append(b, el("span"));
            }
            this.form.append(row);
        }
    }
}
