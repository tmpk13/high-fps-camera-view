// Trigger board link: port selection, board settings and a line console.

import { api } from "./api";
import { $, el, toast } from "./dom";
import { store } from "./state";

export class TriggerPanel {
    private selPort = $<HTMLSelectElement>("sel-port");
    private consoleEl = $("trigger-console");
    private note = $("trigger-note");

    constructor() {
        $("btn-port-refresh").onclick = () => void this.refreshPorts();
        $("btn-port-connect").onclick = () => void this.connect();
        $("btn-port-disconnect").onclick = () => void api.disconnect().catch((e) => toast((e as Error).message, "error"));
        $("btn-board-apply").onclick = () => void this.applyBoard();
        $("btn-board-arm").onclick = () => void this.send("ARM");
        $("btn-board-disarm").onclick = () => void this.send("DISARM");
        $("btn-board-flash").onclick = () => void this.send("PULSE");
        $<HTMLFormElement>("trigger-send-form").onsubmit = (e) => {
            e.preventDefault();
            const input = $<HTMLInputElement>("in-trigger-line");
            if (input.value.trim()) void this.send(input.value.trim());
            input.value = "";
        };
        store.on("trigger", () => this.render());
        void this.refreshPorts();
        void api.triggerStatus().then((s) => {
            store.trigger.lines = s.last_lines;
            store.setTrigger(s.connected, s.port);
        }).catch(() => {});
    }

    async refreshPorts(): Promise<void> {
        try {
            const ports = await api.ports();
            this.selPort.replaceChildren(
                ...ports.map((p) => el("option", { value: p.path, text: `${p.path}  ${p.description}${p.likely ? "  (trigger board)" : ""}` })),
            );
            const likely = ports.find((p) => p.likely);
            if (likely) this.selPort.value = likely.path;
            if (ports.length === 0) this.selPort.append(el("option", { value: "", text: "no USB serial ports" }));
        } catch (e) {
            toast((e as Error).message, "error");
        }
    }

    private async connect(): Promise<void> {
        if (!this.selPort.value) return;
        try {
            await api.connect(this.selPort.value);
        } catch (e) {
            toast((e as Error).message, "error");
        }
    }

    async send(line: string): Promise<void> {
        if (!store.trigger.connected) {
            toast("trigger board not connected");
            return;
        }
        try {
            await api.send(line);
            store.pushTriggerLine(`> ${line}`);
        } catch (e) {
            toast((e as Error).message, "error");
        }
    }

    private async applyBoard(): Promise<void> {
        await this.send(`DELAY ${$<HTMLInputElement>("in-board-delay").value || 0}`);
        await this.send(`PERIOD ${$<HTMLInputElement>("in-board-period").value || 0}`);
        await this.send(`FLASH ${$<HTMLInputElement>("in-board-flash").value || 0}`);
        await this.send(`EDGE ${$<HTMLSelectElement>("sel-board-edge").value}`);
        await this.send("STATUS");
    }

    private render(): void {
        const t = store.trigger;
        this.consoleEl.textContent = t.lines.join("\n");
        this.consoleEl.scrollTop = this.consoleEl.scrollHeight;
        this.note.textContent = t.connected
            ? `Connected to ${t.port}. TRIG lines from the board fire the armed capture.`
            : "A pico running the optional firmware sends TRIG lines over USB serial. The server fires the armed capture when one arrives.";
        $<HTMLButtonElement>("btn-port-connect").disabled = t.connected;
        $<HTMLButtonElement>("btn-port-disconnect").disabled = !t.connected;
    }
}
