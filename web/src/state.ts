// Application state with a small topic based change notification.

import type { Marker, RecordingMeta, Status } from "./api";

export type Topic = "status" | "recording" | "frame" | "markers" | "range" | "trigger" | "view" | "play" | "link";
export type View = "live" | "recording";

export interface Range {
    a: number | null;
    b: number | null;
}

type Listener = () => void;

class Store {
    status: Status | null = null;
    linkUp = false;
    meta: RecordingMeta | null = null;
    generation = 0;
    frame = 0;
    playing = false;
    view: View = "live";
    markers: Marker[] = [];
    refId: number | null = null;
    range: Range = { a: null, b: null };
    trigger = { connected: false, port: null as string | null, lines: [] as string[] };

    private listeners = new Map<Topic, Set<Listener>>();

    on(topic: Topic, fn: Listener): () => void {
        let set = this.listeners.get(topic);
        if (!set) {
            set = new Set();
            this.listeners.set(topic, set);
        }
        set.add(fn);
        return () => set?.delete(fn);
    }

    emit(topic: Topic): void {
        this.listeners.get(topic)?.forEach((fn) => fn());
    }

    get timestamps(): number[] {
        return this.meta?.timestamps_us ?? [];
    }

    get frameCount(): number {
        return this.meta?.frame_count ?? 0;
    }

    setStatus(s: Status): void {
        this.status = s;
        this.emit("status");
    }

    setLink(up: boolean): void {
        if (this.linkUp !== up) {
            this.linkUp = up;
            this.emit("link");
        }
    }

    setRecording(meta: RecordingMeta | null, generation: number): void {
        this.meta = meta;
        this.generation = generation;
        this.markers = meta?.markers ?? [];
        this.refId = this.markers.find((m) => m.name === "ref")?.id ?? null;
        this.range = { a: null, b: null };
        this.playing = false;
        this.frame = meta?.trigger_frame ?? 0;
        this.emit("recording");
        this.emit("markers");
        this.emit("range");
        this.emit("frame");
        this.emit("play");
    }

    setFrame(i: number): void {
        const n = this.frameCount;
        if (n === 0) return;
        const clamped = Math.min(n - 1, Math.max(0, Math.round(i)));
        if (clamped !== this.frame) {
            this.frame = clamped;
            this.emit("frame");
        }
    }

    setPlaying(p: boolean): void {
        if (this.playing !== p) {
            this.playing = p;
            this.emit("play");
        }
    }

    setView(v: View): void {
        if (this.view !== v) {
            this.view = v;
            this.emit("view");
        }
    }

    setMarkers(markers: Marker[]): void {
        this.markers = markers;
        if (this.refId !== null && !markers.some((m) => m.id === this.refId)) this.refId = null;
        this.emit("markers");
    }

    setRef(id: number | null): void {
        this.refId = id;
        this.emit("markers");
    }

    setRange(r: Range): void {
        this.range = r;
        this.emit("range");
    }

    setTrigger(connected: boolean, port: string | null): void {
        this.trigger.connected = connected;
        this.trigger.port = port;
        this.emit("trigger");
    }

    pushTriggerLine(line: string): void {
        this.trigger.lines.push(line);
        if (this.trigger.lines.length > 200) this.trigger.lines.shift();
        this.emit("trigger");
    }
}

export const store = new Store();
