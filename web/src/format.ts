// Pure helpers for time formatting, tick spacing and marker bookkeeping.

import type { Marker } from "./api";

/** Format a duration in microseconds with a unit that keeps the digits readable. */
export function fmtUs(us: number, signed = false): string {
    const sign = us < 0 ? "-" : signed ? "+" : "";
    const a = Math.abs(us);
    let text: string;
    if (a < 1000) text = `${a.toFixed(0)} us`;
    else if (a < 1_000_000) text = `${(a / 1000).toFixed(3)} ms`;
    else text = `${(a / 1_000_000).toFixed(6)} s`;
    return sign + text;
}

/** Same as fmtUs but with the unit implied by the caller (ms with 3 decimals). */
export function fmtMs(us: number): string {
    return (us / 1000).toFixed(3);
}

export function fmtFps(fps: number): string {
    return fps >= 100 ? fps.toFixed(0) : fps.toFixed(1);
}

export function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Duration of `frames` frame intervals at a nominal rate, microseconds. */
export function nominalUs(frames: number, fps: number): number {
    return fps > 0 ? (frames / fps) * 1_000_000 : 0;
}

/** Pick a tick spacing (microseconds) so ticks are at least `minPx` apart. */
export function tickStepUs(usPerPx: number, minPx: number): number {
    const minUs = usPerPx * minPx;
    const steps = [1, 2, 5];
    let mag = 1;
    for (let i = 0; i < 12; i++) {
        for (const s of steps) {
            const step = s * mag;
            if (step >= minUs) return step;
        }
        mag *= 10;
    }
    return mag;
}

/** Index of the frame whose timestamp is closest to `us` (timestamps ascending). */
export function nearestFrame(ts: number[], us: number): number {
    if (ts.length === 0) return 0;
    let lo = 0;
    let hi = ts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((ts[mid] as number) < us) lo = mid + 1;
        else hi = mid;
    }
    if (lo > 0 && Math.abs((ts[lo - 1] as number) - us) <= Math.abs((ts[lo] as number) - us)) return lo - 1;
    return lo;
}

/** Index of the last frame with timestamp at or before `us`, or 0. */
export function frameAtOrBefore(ts: number[], us: number): number {
    const i = nearestFrame(ts, us);
    if ((ts[i] as number) > us && i > 0) return i - 1;
    return i;
}

const PALETTE = ["#b58900", "#cb4b16", "#dc322f", "#d33682", "#6c71c4", "#268bd2", "#2aa198", "#859900"];

export function markerColor(index: number): string {
    return PALETTE[index % PALETTE.length] as string;
}

export function nextMarkerId(markers: Marker[]): number {
    return markers.reduce((m, x) => Math.max(m, x.id), 0) + 1;
}

export function sortedMarkers(markers: Marker[]): Marker[] {
    return [...markers].sort((a, b) => a.frame - b.frame || a.id - b.id);
}

export interface MarkerRow {
    marker: Marker;
    timeUs: number;
    fromPrevUs: number | null;
    fromPrevFrames: number | null;
    fromRefUs: number | null;
    fromRefFrames: number | null;
}

/** Table rows for the marker list: deltas to the previous marker and to the reference. */
export function markerRows(markers: Marker[], ts: number[], refId: number | null): MarkerRow[] {
    const sorted = sortedMarkers(markers);
    const ref = sorted.find((m) => m.id === refId) ?? null;
    const rows: MarkerRow[] = [];
    let prev: Marker | null = null;
    for (const m of sorted) {
        const t = ts[m.frame] ?? 0;
        rows.push({
            marker: m,
            timeUs: t,
            fromPrevUs: prev ? t - (ts[prev.frame] ?? 0) : null,
            fromPrevFrames: prev ? m.frame - prev.frame : null,
            fromRefUs: ref && ref.id !== m.id ? t - (ts[ref.frame] ?? 0) : null,
            fromRefFrames: ref && ref.id !== m.id ? m.frame - ref.frame : null,
        });
        prev = m;
    }
    return rows;
}

export function markersCsv(markers: Marker[], ts: number[], fps: number, refId: number | null): string {
    const lines = ["name,frame,time_us,from_prev_us,from_prev_frames,from_prev_nominal_us,from_ref_us,from_ref_frames"];
    for (const r of markerRows(markers, ts, refId)) {
        const name = `"${r.marker.name.replace(/"/g, '""')}"`;
        lines.push(
            [
                name,
                r.marker.frame,
                r.timeUs,
                r.fromPrevUs ?? "",
                r.fromPrevFrames ?? "",
                r.fromPrevFrames != null ? nominalUs(r.fromPrevFrames, fps).toFixed(1) : "",
                r.fromRefUs ?? "",
                r.fromRefFrames ?? "",
            ].join(","),
        );
    }
    return lines.join("\n") + "\n";
}

export function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}
