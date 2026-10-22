// Typed client for the capture server API.

export interface CamConfig {
    width: number;
    height: number;
    fourcc: string;
    fps: number;
}

export type CamState = "closed" | "idle" | "recording" | "armed" | "post";

export interface Status {
    state: CamState;
    config: CamConfig;
    actual_fps: number;
    frames_buffered: number;
    bytes_buffered: number;
    elapsed_s: number;
    target_s: number;
    dropped_total: number;
    process_us: number;
    card: string;
    error: string | null;
    device: string;
    recording_generation: number;
}

export interface Marker {
    id: number;
    name: string;
    frame: number;
    color: string;
}

export interface RecordingMeta {
    id: string;
    created: string;
    width: number;
    height: number;
    fourcc: string;
    fps_nominal: number;
    fps_measured: number;
    frame_count: number;
    trigger_frame: number | null;
    timestamps_us: number[];
    sequences: number[];
    dropped: number;
    markers: Marker[];
    note: string;
    saved_as: string | null;
}

export interface IntervalInfo { numerator: number; denominator: number; fps: number }
export interface SizeInfo { width: number; height: number; intervals: IntervalInfo[] }
export interface FormatInfo { fourcc: string; description: string; supported: boolean; sizes: SizeInfo[] }

export interface MenuEntry { value: number; name: string }
export interface ControlInfo {
    id: number;
    name: string;
    kind: "integer" | "boolean" | "menu" | "button";
    min: number;
    max: number;
    step: number;
    default: number;
    value: number | null;
    inactive: boolean;
    read_only: boolean;
    items: MenuEntry[];
}

export interface DeviceInfo { path: string; card: string; driver: string }
export interface PortInfo { path: string; description: string; likely: boolean }
export interface TriggerState { connected: boolean; port: string | null; last_lines: string[]; error: string | null }
export interface SavedSummary {
    name: string;
    created: string;
    frame_count: number;
    fps_nominal: number;
    width: number;
    height: number;
    markers: number;
    exports: string[];
}

export type ServerEvent =
    | ({ type: "status" } & Status)
    | { type: "recording_ready"; id: string; generation: number }
    | { type: "trigger_line"; line: string }
    | { type: "trigger_state"; connected: boolean; port: string | null };

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers: {} };
    if (body !== undefined) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let data: unknown = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = null;
    }
    if (!res.ok) {
        const msg = (data as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
        throw new Error(msg);
    }
    return data as T;
}

export const api = {
    status: () => req<Status>("GET", "/api/status"),
    formats: () => req<FormatInfo[]>("GET", "/api/camera/formats"),
    controls: () => req<ControlInfo[]>("GET", "/api/camera/controls"),
    setControl: (id: number, value: number) => req<unknown>("POST", "/api/camera/controls", { id, value }),
    setConfig: (cfg: CamConfig) => req<unknown>("POST", "/api/camera/config", cfg),
    reopen: (device?: string) => req<unknown>("POST", "/api/camera/reopen", { device: device ?? null }),
    devices: () => req<DeviceInfo[]>("GET", "/api/camera/devices"),
    record: (duration_s: number) => req<unknown>("POST", "/api/capture/record", { duration_s }),
    arm: (pre_s: number, post_s: number) => req<unknown>("POST", "/api/capture/arm", { pre_s, post_s }),
    trigger: () => req<unknown>("POST", "/api/capture/trigger"),
    stop: () => req<unknown>("POST", "/api/capture/stop"),
    recording: () => req<RecordingMeta | null>("GET", "/api/recording"),
    frameUrl: (i: number, generation: number) => `/api/recording/frame/${i}?g=${generation}`,
    putMarkers: (markers: Marker[]) => req<unknown>("PUT", "/api/recording/markers", markers),
    save: (name: string) => req<{ name: string }>("POST", "/api/recording/save", { name: name || null }),
    exportVideo: (name: string, playback_fps: number) =>
        req<{ name: string; file: string; url: string }>("POST", "/api/recording/export", { name: name || null, playback_fps }),
    list: () => req<SavedSummary[]>("GET", "/api/recordings"),
    load: (name: string) => req<RecordingMeta>("POST", `/api/recordings/${encodeURIComponent(name)}/load`),
    remove: (name: string) => req<unknown>("DELETE", `/api/recordings/${encodeURIComponent(name)}`),
    ports: () => req<PortInfo[]>("GET", "/api/trigger/ports"),
    triggerStatus: () => req<TriggerState>("GET", "/api/trigger/status"),
    connect: (port: string) => req<unknown>("POST", "/api/trigger/connect", { port }),
    disconnect: () => req<unknown>("POST", "/api/trigger/disconnect"),
    send: (line: string) => req<unknown>("POST", "/api/trigger/send", { line }),
};
