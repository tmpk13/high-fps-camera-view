// Entry point: wires the server connection, capture controls, views, panels and keyboard.

import { api, type ServerEvent } from "./api";
import { $, dragHandle, remPx, storageGet, storageSet, toast } from "./dom";
import { fmtBytes, fmtFps } from "./format";
import { frames } from "./frames";
import { CameraPanel } from "./panel_camera";
import { FilesPanel } from "./panel_files";
import { MarkersPanel } from "./panel_markers";
import { TriggerPanel } from "./panel_trigger";
import { store, type View } from "./state";
import { Timeline } from "./timeline";
import { Viewer } from "./viewer";
import { ViewZoom } from "./viewzoom";

// ---- theme ----

function applyTheme(theme: string | null): void {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    document.dispatchEvent(new Event("themechange"));
}
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => document.dispatchEvent(new Event("themechange")));

function currentTheme(): "light" | "dark" {
    const set = document.documentElement.dataset.theme;
    if (set === "light" || set === "dark") return set;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

try {
    applyTheme(localStorage.getItem("theme"));
} catch {
    // storage unavailable; system preference applies
}
$("btn-theme").onclick = () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    applyTheme(next);
    try {
        localStorage.setItem("theme", next);
    } catch {
        // ignore
    }
};
$("btn-help").onclick = () => $<HTMLDialogElement>("help-dialog").showModal();

// ---- full screen ----

function toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => toast("full screen not available", "error"));
}
$("btn-fullscreen").onclick = toggleFullscreen;
document.addEventListener("fullscreenchange", () => {
    $("btn-fullscreen").textContent = document.fullscreenElement ? "exit full screen" : "full screen";
});

// ---- resizable sidebar and timeline ----

const layout = document.querySelector<HTMLElement>(".layout");
const sidebar = $("sidebar");
if (!layout) throw new Error("missing layout");
{
    const savedW = storageGet("sidebar-w");
    if (savedW) sidebar.style.setProperty("--sidebar-w", savedW);
    const savedH = storageGet("timeline-h");
    if (savedH) $("timeline-wrap").style.setProperty("--timeline-h", savedH);
    if (storageGet("sidebar-collapsed") === "1") layout.classList.add("side-collapsed");
}

function setCollapsed(collapsed: boolean): void {
    layout?.classList.toggle("side-collapsed", collapsed);
    $("side-chev").textContent = collapsed ? "<" : ">";
    storageSet("sidebar-collapsed", collapsed ? "1" : "0");
}
setCollapsed(layout.classList.contains("side-collapsed"));

dragHandle(
    $("side-handle"),
    (dx) => {
        if (layout.classList.contains("side-collapsed")) {
            if (dx < -8) setCollapsed(false);
            return;
        }
        const w = Math.max(14 * remPx(), sidebar.getBoundingClientRect().width - dx);
        sidebar.style.setProperty("--sidebar-w", `${(w / remPx()).toFixed(2)}rem`);
    },
    () => setCollapsed(!layout.classList.contains("side-collapsed")),
    () => storageSet("sidebar-w", sidebar.style.getPropertyValue("--sidebar-w")),
);

dragHandle(
    $("timeline-handle"),
    (_dx, dy) => {
        const wrap = $("timeline-wrap");
        const h = Math.min(window.innerHeight * 0.6, Math.max(4 * remPx(), $("timeline").getBoundingClientRect().height - dy));
        wrap.style.setProperty("--timeline-h", `${(h / remPx()).toFixed(2)}rem`);
    },
    undefined,
    () => storageSet("timeline-h", $("timeline-wrap").style.getPropertyValue("--timeline-h")),
);

// ---- views and panels ----

const viewer = new Viewer();
const markersPanel = new MarkersPanel();
const cameraPanel = new CameraPanel();
const triggerPanel = new TriggerPanel();
const filesPanel = new FilesPanel();
const timeline = new Timeline(
    $<HTMLCanvasElement>("timeline"),
    $("hover-card"),
    $<HTMLImageElement>("hover-img"),
    $("hover-text"),
    (m) => markersPanel.rename(m),
);

const viewZoom = new ViewZoom($("viewer"), $("zoom-layer"), $("zoom-note"));
void viewZoom;
const liveImg = $<HTMLImageElement>("live-img");
let liveStreamOn = false;

function setLiveStream(on: boolean): void {
    if (on === liveStreamOn) return;
    liveStreamOn = on;
    if (on) liveImg.src = `/api/preview.mjpg?fps=30&t=${Date.now()}`;
    else liveImg.removeAttribute("src");
}

liveImg.onerror = () => {
    if (liveStreamOn) setTimeout(() => {
        if (liveStreamOn) liveImg.src = `/api/preview.mjpg?fps=30&t=${Date.now()}`;
    }, 1500);
};

function showView(view: View): void {
    store.setView(view);
}

store.on("view", () => {
    const rec = store.view === "recording";
    $("view-live").hidden = rec;
    $("view-rec").hidden = !rec;
    $("rec-overlay").hidden = !rec;
    $("rec-info").hidden = !rec;
    $("live-note").hidden = rec;
    $("live-closed").hidden = rec || store.status?.state !== "closed";
    $("transport").hidden = !rec;
    $("timeline-wrap").hidden = !rec;
    document.querySelectorAll<HTMLButtonElement>(".mode-tabs .tab").forEach((b) => b.classList.toggle("active", b.dataset.view === store.view));
    setLiveStream(!rec && store.status?.state !== "closed");
    if (!rec) store.setPlaying(false);
});

document.querySelectorAll<HTMLButtonElement>(".mode-tabs .tab").forEach((b) => {
    b.onclick = () => showView(b.dataset.view as View);
});

function showPanel(name: string): void {
    setCollapsed(false);
    document.querySelector<HTMLButtonElement>(`.side-tabs .tab[data-panel=${name}]`)?.click();
}

document.querySelectorAll<HTMLButtonElement>(".side-tabs .tab").forEach((b) => {
    b.onclick = () => {
        document.querySelectorAll<HTMLButtonElement>(".side-tabs .tab").forEach((x) => x.classList.toggle("active", x === b));
        document.querySelectorAll<HTMLElement>(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${b.dataset.panel}`));
        $("side-label").textContent = b.textContent ?? "";
        if (b.dataset.panel === "camera") cameraPanel.ensureLoaded();
        if (b.dataset.panel === "files") void filesPanel.refresh();
    };
});

// ---- capture controls ----

const btnRecord = $<HTMLButtonElement>("btn-record");
const btnArm = $<HTMLButtonElement>("btn-arm");
const btnTrigger = $<HTMLButtonElement>("btn-trigger");
const btnStop = $<HTMLButtonElement>("btn-stop");
const progress = $("capture-progress");
const progressBar = $("capture-progress-bar");
const progressText = $("capture-progress-text");

function num(id: string, fallback: number): number {
    const v = Number($<HTMLInputElement>(id).value);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
}

btnRecord.onclick = () => {
    showView("live");
    api.record(num("in-duration", 1)).catch((e) => toast((e as Error).message, "error"));
};
btnArm.onclick = () => {
    showView("live");
    api.arm(num("in-pre", 1), num("in-post", 1)).catch((e) => toast((e as Error).message, "error"));
};
btnTrigger.onclick = () => api.trigger().catch((e) => toast((e as Error).message, "error"));
btnStop.onclick = () => api.stop().catch((e) => toast((e as Error).message, "error"));
$("btn-live-reopen").onclick = () => void cameraPanel.reopen();
$("btn-live-choose").onclick = () => {
    showPanel("camera");
    void cameraPanel.refreshDevices();
};

function renderStatus(): void {
    const st = store.status;
    if (!st) return;
    const pillCam = $("pill-camera");
    const pillFps = $("pill-fps");
    const pillDrop = $("pill-dropped");
    const names: Record<string, string> = {
        closed: "camera closed",
        idle: "camera ready",
        recording: "recording",
        armed: "armed",
        post: "post roll",
    };
    const busyText = st.target_s > 0 ? ` ${st.elapsed_s.toFixed(1)} / ${st.target_s.toFixed(1)} s` : "";
    pillCam.textContent = st.error
        ? `camera: ${st.error}`
        : st.state === "idle" || st.state === "closed"
          ? `${names[st.state] ?? st.state}  ${st.config.width}x${st.config.height} ${st.config.fourcc}`
          : `${names[st.state] ?? st.state}${busyText}`;
    pillCam.className = `pill ${st.error ? "bad" : st.state === "idle" ? "ok" : st.state === "closed" ? "warn" : "busy"}`;
    pillFps.textContent = `${fmtFps(st.actual_fps)} fps`;
    pillFps.className = `pill ${st.actual_fps > 0 ? "ok" : ""}`;
    pillDrop.textContent = `${st.dropped_total} dropped`;
    pillDrop.className = `pill ${st.dropped_total > 0 ? "warn" : ""}`;

    const busy = st.state === "recording" || st.state === "armed" || st.state === "post";
    btnRecord.disabled = st.state !== "idle";
    btnArm.disabled = st.state !== "idle";
    btnTrigger.disabled = st.state !== "armed";
    btnStop.disabled = !busy;
    btnArm.classList.toggle("active-state", st.state === "armed");
    progress.hidden = !busy;
    if (busy) {
        const frac = st.target_s > 0 ? Math.min(1, st.elapsed_s / st.target_s) : 0;
        progressBar.style.width = `${frac * 100}%`;
        const label = st.state === "armed" ? "pre-roll buffer" : st.state === "post" ? "post roll" : "recording";
        progressText.textContent = `${label}: ${st.elapsed_s.toFixed(2)} / ${st.target_s.toFixed(2)} s, ${st.frames_buffered} frames, ${fmtBytes(st.bytes_buffered)}`;
    }
    const closed = st.state === "closed";
    $("live-note").textContent = closed ? "" : `live preview is rate limited to 30 fps; capture runs at ${fmtFps(st.actual_fps)} fps`;
    $("live-closed").hidden = !closed || store.view !== "live";
    $("live-closed-text").textContent = st.error ?? "camera closed";
    // No preview request while the camera is closed; the stream would never deliver a frame.
    setLiveStream(store.view === "live" && !closed);
}

store.on("status", renderStatus);
store.on("link", () => {
    const pill = $("pill-link");
    pill.textContent = store.linkUp ? "server connected" : "server disconnected";
    pill.className = `pill ${store.linkUp ? "ok" : "bad"}`;
});
store.on("trigger", () => {
    const pill = $("pill-trigger");
    const t = store.trigger;
    pill.textContent = t.connected ? `trigger board ${t.port}` : "no trigger board";
    pill.className = `pill ${t.connected ? "ok" : ""}`;
});

// ---- recording loading ----

async function loadRecording(generation: number): Promise<void> {
    try {
        const meta = await api.recording();
        frames.reset(generation);
        store.setRecording(meta, generation);
        if (meta) {
            $<HTMLButtonElement>("tab-recording").disabled = false;
            showView("recording");
            const parts = [`${meta.frame_count} frames at ${fmtFps(meta.fps_measured)} fps`];
            if (meta.dropped) parts.push(`${meta.dropped} dropped`);
            if (meta.note) parts.push(meta.note);
            toast(`recording ready: ${parts.join(", ")}`, meta.dropped ? "error" : "ok");
        }
    } catch (e) {
        toast(`could not load recording: ${(e as Error).message}`, "error");
    }
}

// ---- server connection ----

function connectWs(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    ws.onopen = () => store.setLink(true);
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as ServerEvent;
        switch (msg.type) {
            case "status":
                store.setStatus(msg);
                break;
            case "recording_ready":
                void loadRecording(msg.generation);
                break;
            case "trigger_line":
                store.pushTriggerLine(msg.line);
                if (msg.line.startsWith("TRIG")) toast(`trigger: ${msg.line}`);
                break;
            case "trigger_state":
                store.setTrigger(msg.connected, msg.port);
                break;
        }
    };
    ws.onclose = () => {
        store.setLink(false);
        setTimeout(connectWs, 1500);
    };
    ws.onerror = () => ws.close();
}

// ---- keyboard ----

function isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

document.addEventListener("keydown", (e) => {
    if (isTyping(e)) return;
    if (e.key === "t" && store.status?.state === "armed") {
        void api.trigger();
        e.preventDefault();
        return;
    }
    if (e.key === "f" || e.key === "F") {
        toggleFullscreen();
        e.preventDefault();
        return;
    }
    if (e.key === "Escape") {
        store.setPlaying(false);
        return;
    }
    if (store.view !== "recording" || !store.meta) return;
    const big = e.shiftKey ? 10 : 1;
    switch (e.key) {
        case "ArrowLeft":
            viewer.step(-big);
            break;
        case "ArrowRight":
            viewer.step(big);
            break;
        case "Home":
            store.setFrame(0);
            break;
        case "End":
            store.setFrame(store.frameCount - 1);
            break;
        case " ":
            store.setPlaying(!store.playing);
            break;
        case "m":
        case "M":
            markersPanel.addAtCurrent();
            break;
        case "r":
        case "R":
            markersPanel.setRefAtCurrent();
            break;
        case "[":
            viewer.jumpMarker(-1);
            break;
        case "]":
            viewer.jumpMarker(1);
            break;
        case "i":
        case "I":
            viewer.setIn();
            break;
        case "o":
        case "O":
            viewer.setOut();
            break;
        case "Delete":
        case "Backspace":
            markersPanel.removeAtCurrent();
            break;
        case "a":
        case "A":
            timeline.zoomAll();
            break;
        default:
            return;
    }
    e.preventDefault();
});

// ---- boot ----

store.emit("view");
store.emit("link");
store.emit("trigger");
connectWs();
void api.status().then((s) => {
    store.setStatus(s);
    void loadRecording(s.recording_generation);
    cameraPanel.ensureLoaded();
}).catch(() => {});
void triggerPanel;
