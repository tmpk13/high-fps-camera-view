// Marker list with time deltas, reference selection, rename and CSV export.

import { api, type Marker } from "./api";
import { $, debounce, download, el, toast } from "./dom";
import { fmtMs, fmtUs, markerColor, markerRows, markersCsv, nextMarkerId, nominalUs, sortedMarkers } from "./format";
import { store } from "./state";

export class MarkersPanel {
    private tbody: HTMLTableSectionElement;
    private summary = $("markers-summary");
    private persist = debounce(() => this.save(), 300);
    private selected = new Set<number>();

    constructor() {
        const table = $<HTMLTableElement>("markers-table");
        this.tbody = table.tBodies[0] as HTMLTableSectionElement;
        store.on("markers", () => {
            this.render();
            this.persist();
        });
        store.on("recording", () => {
            this.selected.clear();
            this.render();
            this.renderCompare();
        });
        store.on("frame", () => this.highlight());
        $("btn-markers-csv").onclick = () => this.exportCsv();
        $("btn-markers-clear").onclick = () => {
            if (store.markers.length && confirm("Remove all markers?")) store.setMarkers([]);
        };
        $("btn-marker").onclick = () => this.addAtCurrent();
        $("btn-compare-clear").onclick = () => {
            this.selected.clear();
            this.renderCompare();
            this.highlight();
        };
    }

    addAtCurrent(): void {
        if (!store.meta) return;
        const existing = store.markers.find((m) => m.frame === store.frame);
        if (existing) {
            toast(`marker "${existing.name}" is already on frame ${store.frame}`);
            return;
        }
        const id = nextMarkerId(store.markers);
        const marker: Marker = {
            id,
            name: `M${id}`,
            frame: store.frame,
            color: markerColor(store.markers.length),
        };
        store.setMarkers([...store.markers, marker]);
        if (store.markers.length === 1) store.setRef(marker.id);
    }

    removeAtCurrent(): void {
        const m = store.markers.find((x) => x.frame === store.frame);
        if (m) store.setMarkers(store.markers.filter((x) => x.id !== m.id));
    }

    setRefAtCurrent(): void {
        const m = store.markers.find((x) => x.frame === store.frame);
        if (m) store.setRef(m.id);
        else toast("no marker on this frame; press M first");
    }

    rename(m: Marker): void {
        const name = prompt("Marker name", m.name);
        if (name !== null && name.trim()) {
            m.name = name.trim();
            store.setMarkers([...store.markers]);
        }
    }

    private async save(): Promise<void> {
        if (!store.meta) return;
        try {
            await api.putMarkers(store.markers);
        } catch (e) {
            toast(`markers not saved: ${(e as Error).message}`, "error");
        }
    }

    private exportCsv(): void {
        const meta = store.meta;
        if (!meta) return;
        download(`${meta.saved_as ?? meta.id}-markers.csv`, markersCsv(store.markers, store.timestamps, meta.fps_measured, store.refId));
    }

    private highlight(): void {
        for (const tr of Array.from(this.tbody.rows)) {
            tr.classList.toggle("current", Number(tr.dataset.frame) === store.frame);
            tr.classList.toggle("selected", this.selected.has(Number(tr.dataset.id)));
        }
    }

    /** Pairwise deltas between the ctrl-selected markers, in frame order, plus the total span. */
    private renderCompare(): void {
        const meta = store.meta;
        const box = $("compare");
        const table = $<HTMLTableElement>("compare-table");
        const body = table.tBodies[0] as HTMLTableSectionElement;
        for (const id of [...this.selected]) if (!store.markers.some((m) => m.id === id)) this.selected.delete(id);
        const chosen = sortedMarkers(store.markers.filter((m) => this.selected.has(m.id)));
        body.replaceChildren();
        if (!meta || chosen.length < 2) {
            box.hidden = chosen.length === 0;
            $("compare-title").textContent = chosen.length === 1 ? `Ctrl+click another marker to compare with ${chosen[0]?.name}` : "";
            return;
        }
        box.hidden = false;
        const ts = store.timestamps;
        const row = (a: typeof chosen[number], b: typeof chosen[number]) => {
            const frames = b.frame - a.frame;
            const dt = (ts[b.frame] ?? 0) - (ts[a.frame] ?? 0);
            return el(
                "tr",
                {},
                el("td", { text: a.name }),
                el("td", { text: b.name }),
                el("td", { class: "num c-frame", text: String(frames) }),
                el("td", { class: "num", text: fmtMs(dt) }),
                el("td", { class: "num c-nom", text: fmtMs(nominalUs(frames, meta.fps_measured)) }),
            );
        };
        for (let i = 1; i < chosen.length; i++) body.append(row(chosen[i - 1]!, chosen[i]!));
        if (chosen.length > 2) {
            const total = row(chosen[0]!, chosen[chosen.length - 1]!);
            total.style.fontWeight = "600";
            body.append(total);
        }
        const first = chosen[0]!;
        const last = chosen[chosen.length - 1]!;
        $("compare-title").textContent = `Comparing ${chosen.length} markers: ${fmtUs((ts[last.frame] ?? 0) - (ts[first.frame] ?? 0))} over ${last.frame - first.frame} frames`;
        store.setRange({ a: first.frame, b: last.frame });
    }

    private render(): void {
        const meta = store.meta;
        this.tbody.replaceChildren();
        if (!meta) {
            this.summary.textContent = "No recording";
            return;
        }
        const rows = markerRows(store.markers, store.timestamps, store.refId);
        this.summary.textContent = rows.length === 0 ? "No markers yet. Press M on a frame." : `${rows.length} marker${rows.length === 1 ? "" : "s"}`;
        for (const r of rows) {
            const m = r.marker;
            const isRef = m.id === store.refId;
            const refBtn = el("button", { class: `ref-btn ${isRef ? "on" : ""}`, title: "Use as reference", text: isRef ? "*" : "o" });
            refBtn.onclick = (e) => {
                e.stopPropagation();
                store.setRef(isRef ? null : m.id);
            };
            const name = el("input", { type: "text", value: m.name });
            name.onchange = () => {
                m.name = name.value.trim() || m.name;
                store.setMarkers([...store.markers]);
            };
            name.onclick = (e) => e.stopPropagation();
            const del = el("button", { class: "small danger", title: "Remove marker", text: "x" });
            del.onclick = (e) => {
                e.stopPropagation();
                store.setMarkers(store.markers.filter((x) => x.id !== m.id));
            };
            const prev = r.fromPrevUs === null ? "" : fmtMs(r.fromPrevUs);
            const prevTitle = r.fromPrevFrames === null ? "" : `${r.fromPrevFrames} frames, nominal ${fmtMs(nominalUs(r.fromPrevFrames, meta.fps_measured))} ms at ${meta.fps_measured.toFixed(2)} fps`;
            const ref = r.fromRefUs === null ? (isRef ? "ref" : "") : fmtMs(r.fromRefUs);
            const refTitle = r.fromRefFrames === null ? "" : `${r.fromRefFrames} frames from the reference`;
            const tr = el(
                "tr",
                { "data-frame": String(m.frame), "data-id": String(m.id) },
                el("td", { class: "c-star" }, refBtn),
                el("td", { class: "name" }, el("span", {}, el("span", { class: "swatch", style: `background:${m.color}` }), name)),
                el("td", { class: "num c-frame", text: String(m.frame) }),
                el("td", { class: "num", text: fmtMs(r.timeUs) }),
                el("td", { class: "num c-prev", text: prev, title: prevTitle }),
                el("td", { class: "num c-ref", text: ref, title: refTitle }),
                el("td", {}, del),
            );
            tr.onclick = (e) => {
                if (e.ctrlKey || e.metaKey) {
                    if (this.selected.has(m.id)) this.selected.delete(m.id);
                    else this.selected.add(m.id);
                    this.renderCompare();
                    this.highlight();
                    return;
                }
                store.setFrame(m.frame);
            };
            this.tbody.append(tr);
        }
        this.highlight();
        this.renderCompare();
    }
}
