// Saving, loading, exporting and deleting recordings on the server.

import { api } from "./api";
import { $, el, toast } from "./dom";
import { fmtFps } from "./format";
import { store } from "./state";

export class FilesPanel {
    private list = $("saved-list");
    private note = $("files-note");
    private nameInput = $<HTMLInputElement>("in-save-name");
    onLoaded: (() => Promise<void>) | null = null;

    constructor() {
        $("btn-save").onclick = () => void this.save();
        $("btn-export").onclick = () => void this.exportVideo();
        store.on("recording", () => this.onRecording());
        void this.refresh();
    }

    private onRecording(): void {
        const meta = store.meta;
        this.nameInput.placeholder = meta?.saved_as ?? meta?.id ?? "recording name";
        this.note.textContent = meta
            ? meta.saved_as
                ? `Current recording is saved as "${meta.saved_as}".`
                : "Current recording is only in memory; save it to keep it."
            : "";
    }

    private async save(): Promise<void> {
        if (!store.meta) {
            toast("nothing to save");
            return;
        }
        try {
            const res = await api.save(this.nameInput.value.trim());
            toast(`saved as ${res.name}`, "ok");
            if (store.meta) store.meta.saved_as = res.name;
            this.onRecording();
            await this.refresh();
        } catch (e) {
            toast(`save failed: ${(e as Error).message}`, "error");
        }
    }

    private async exportVideo(): Promise<void> {
        if (!store.meta) {
            toast("nothing to export");
            return;
        }
        const fps = Number($<HTMLInputElement>("in-export-fps").value) || 30;
        toast("exporting with ffmpeg...");
        try {
            const res = await api.exportVideo(this.nameInput.value.trim() || store.meta.saved_as || "", fps);
            toast(`exported ${res.file}`, "ok");
            if (store.meta) store.meta.saved_as = res.name;
            this.onRecording();
            await this.refresh();
        } catch (e) {
            toast(`export failed: ${(e as Error).message}`, "error");
        }
    }

    async refresh(): Promise<void> {
        try {
            const items = await api.list();
            this.list.replaceChildren(
                ...items.map((s) => {
                    const load = el("button", { class: "small primary", text: "Load" });
                    load.onclick = async () => {
                        try {
                            await api.load(s.name);
                            toast(`loaded ${s.name}`, "ok");
                        } catch (e) {
                            toast(`load failed: ${(e as Error).message}`, "error");
                        }
                    };
                    const del = el("button", { class: "small danger", text: "Delete" });
                    del.onclick = async () => {
                        if (!confirm(`Delete recording "${s.name}" from disk?`)) return;
                        try {
                            await api.remove(s.name);
                            await this.refresh();
                        } catch (e) {
                            toast(`delete failed: ${(e as Error).message}`, "error");
                        }
                    };
                    const links = s.exports.map((f) => el("a", { href: `/api/recordings/${encodeURIComponent(s.name)}/file/${encodeURIComponent(f)}`, text: f }));
                    return el(
                        "li",
                        {},
                        el("div", { class: "name", text: s.name }),
                        el("div", { class: "meta", text: `${s.frame_count} frames, ${s.width}x${s.height}, ${fmtFps(s.fps_nominal)} fps, ${s.markers} markers, ${s.created.slice(0, 19).replace("T", " ")}` }),
                        el("div", { class: "actions" }, load, del, ...links),
                    );
                }),
            );
            if (items.length === 0) this.list.append(el("li", { class: "muted", text: "No saved recordings." }));
        } catch (e) {
            toast((e as Error).message, "error");
        }
    }
}
