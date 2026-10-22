// Decoded frame cache so stepping and thumbnails do not refetch.

import { api } from "./api";

const MAX_CACHED = 1200;

class FrameCache {
    private images = new Map<string, HTMLImageElement>();
    private pending = new Map<string, Promise<HTMLImageElement>>();
    private order: string[] = [];
    private generation = 0;
    onLoaded: (() => void) | null = null;

    reset(generation: number): void {
        this.generation = generation;
        this.images.clear();
        this.pending.clear();
        this.order = [];
    }

    get(i: number): HTMLImageElement | undefined {
        return this.images.get(`${this.generation}:${i}`);
    }

    load(i: number): Promise<HTMLImageElement> {
        const key = `${this.generation}:${i}`;
        const have = this.images.get(key);
        if (have) return Promise.resolve(have);
        const inflight = this.pending.get(key);
        if (inflight) return inflight;
        const gen = this.generation;
        const p = new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.decoding = "async";
            img.onload = () => {
                this.pending.delete(key);
                if (gen !== this.generation) return reject(new Error("stale"));
                this.images.set(key, img);
                this.order.push(key);
                while (this.order.length > MAX_CACHED) {
                    const old = this.order.shift();
                    if (old) this.images.delete(old);
                }
                this.onLoaded?.();
                resolve(img);
            };
            img.onerror = () => {
                this.pending.delete(key);
                reject(new Error(`frame ${i} failed to load`));
            };
            img.src = api.frameUrl(i, gen);
        });
        this.pending.set(key, p);
        return p;
    }

    prefetch(center: number, radius: number, count: number): void {
        for (let d = 1; d <= radius; d++) {
            for (const i of [center + d, center - d]) {
                if (i >= 0 && i < count && this.pending.size < 12) void this.load(i).catch(() => {});
            }
        }
    }

    get inflight(): number {
        return this.pending.size;
    }
}

export const frames = new FrameCache();
