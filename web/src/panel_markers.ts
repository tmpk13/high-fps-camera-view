// Marker list with time deltas, reference selection, rename and CSV export.

import { api, type Marker } from "./api";
import { $, debounce, download, el, toast } from "./dom";
import { fmtUs, markerColor, markerRows, markersCsv, nextMarkerId, nominalUs } from "./format";
import { store } from "./state";

export class MarkersPanel {
    private tbody: HTMLTableSectionElement;
    private summary = $("markers-summary");
    private persist = debounce(() => this.save(), 300);

    constructor() {
        const table = $<HTMLTableElement>("markers-table");
        this.tbody = table.tBodies[0] as HTMLTableSectionElement;
        store.on("markers", () => {
            this.render();
            this.persist();
        });
        store.on("recording", () => this.render());
        store.on("frame", () => this.highlight());
        $("btn-markers-csv").onclick = () => this.exportCsv();
        $("btn-markers-clear").onclick = () => {
            if (store.markers.length && confirm("Remove all markers?")) store.setMarkers([]);
        };
        $("btn-marker").onclick = () => this.addAtCurrent();
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
        }
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
            const prev = r.fromPrevUs === null ? "" : `${fmtUs(r.fromPrevUs, true)} / ${r.fromPrevFrames} f`;
            const prevTitle = r.fromPrevFrames === null ? "" : `nominal ${fmtUs(nominalUs(r.fromPrevFrames, meta.fps_measured), true)} at ${meta.fps_measured.toFixed(2)} fps`;
            const ref = r.fromRefUs === null ? (isRef ? "ref" : "") : `${fmtUs(r.fromRefUs, true)} / ${r.fromRefFrames} f`;
            const tr = el(
                "tr",
                { "data-frame": String(m.frame) },
                el("td", {}, refBtn),
                el("td", {}, el("span", { class: "swatch", style: `background:${m.color}` }), name),
                el("td", { text: String(m.frame) }),
                el("td", { text: fmtUs(r.timeUs) }),
                el("td", { text: prev, title: prevTitle }),
                el("td", { text: ref }),
                el("td", {}, del),
            );
            tr.onclick = () => {
                store.setPlaying(false);
                store.setFrame(m.frame);
            };
            this.tbody.append(tr);
        }
        this.highlight();
    }
}
