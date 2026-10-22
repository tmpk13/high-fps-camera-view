import { describe, expect, test } from "bun:test";
import { fmtUs, frameAtOrBefore, markerRows, markersCsv, nearestFrame, nextMarkerId, nominalUs, tickStepUs } from "./format";

describe("fmtUs", () => {
    test("picks units", () => {
        expect(fmtUs(250)).toBe("250 us");
        expect(fmtUs(12345)).toBe("12.345 ms");
        expect(fmtUs(1_500_000)).toBe("1.500000 s");
        expect(fmtUs(-4000)).toBe("-4.000 ms");
        expect(fmtUs(4000, true)).toBe("+4.000 ms");
    });
});

describe("nearestFrame", () => {
    const ts = [0, 5000, 10000, 15000];
    test("finds closest timestamp", () => {
        expect(nearestFrame(ts, 0)).toBe(0);
        expect(nearestFrame(ts, 2400)).toBe(0);
        expect(nearestFrame(ts, 2600)).toBe(1);
        expect(nearestFrame(ts, 99999)).toBe(3);
        expect(nearestFrame([], 5)).toBe(0);
    });
    test("frameAtOrBefore never looks ahead", () => {
        expect(frameAtOrBefore(ts, 4999)).toBe(0);
        expect(frameAtOrBefore(ts, 5000)).toBe(1);
        expect(frameAtOrBefore(ts, 14000)).toBe(2);
    });
});

describe("ticks", () => {
    test("step is at least minPx apart", () => {
        const step = tickStepUs(10, 80);
        expect(step).toBeGreaterThanOrEqual(800);
        expect([1, 2, 5]).toContain(step / 10 ** Math.floor(Math.log10(step)));
    });
});

describe("markers", () => {
    const ts = [0, 5000, 10010, 15000, 20000];
    const markers = [
        { id: 2, name: "b", frame: 3, color: "#000" },
        { id: 1, name: "a", frame: 1, color: "#000" },
    ];
    test("rows are sorted and carry deltas", () => {
        const rows = markerRows(markers, ts, 1);
        expect(rows.map((r) => r.marker.name)).toEqual(["a", "b"]);
        expect(rows[0]?.fromPrevUs).toBeNull();
        expect(rows[1]?.fromPrevUs).toBe(10000);
        expect(rows[1]?.fromPrevFrames).toBe(2);
        expect(rows[1]?.fromRefUs).toBe(10000);
        expect(rows[0]?.fromRefUs).toBeNull();
    });
    test("csv has header and one line per marker", () => {
        const csv = markersCsv(markers, ts, 200, 1);
        const lines = csv.trim().split("\n");
        expect(lines.length).toBe(3);
        expect(lines[2]).toContain('"b",3,15000,10000,2,10000.0,10000,2');
    });
    test("ids increase and nominal time follows fps", () => {
        expect(nextMarkerId(markers)).toBe(3);
        expect(nominalUs(2, 200)).toBe(10000);
    });
});
