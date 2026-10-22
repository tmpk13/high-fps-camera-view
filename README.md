# high-fps-camera-view

Capture, review and measure time in video from a high frame rate USB camera
(tested with an Arducam ezBOX VGA global shutter mono, up to 800 fps).

The Rust server grabs frames from V4L2 and keeps every frame's driver
timestamp. The web UI shows a live preview, records for a chosen duration or
with an armed pre/post-roll trigger, and lets you step frames, drop markers and
read the time between them. An optional Raspberry Pi Pico firmware fires the
trigger from a GPIO input or a timer and flashes an LED so the trigger moment
is visible in the video.

## Setup

- Rust toolchain, `bun`, `mise`, `v4l2-ctl` (v4l-utils), `ffmpeg` for mp4 export.
- Camera on `/dev/video2` by default; pass `--device` to change it.

```sh
mise run web-install
mise run serve              # builds the UI and starts http://127.0.0.1:8070
mise run serve -- --device /dev/video0 --width 320 --height 240 --fps 240
```

`mise run camera-info` lists what the camera offers.

## Using the UI

- **Record** captures for the duration in the box. **Arm** keeps a rolling
  pre-roll buffer and finishes post-roll seconds after a trigger. Trigger from
  the button, the `T` key, or the pico board.
- The **timeline** shows preview frames; scroll to zoom, drag the ruler to pan,
  click to seek. Hovering shows the frame under the cursor with its time.
- `M` adds a marker on the current frame, `R` makes it the reference.
  The marker table shows each marker's time, the delta to the previous marker
  and to the reference. `I` / `O` set a range whose length is shown on the
  timeline. Markers are saved with the recording and can be exported as CSV.
- Times come from the V4L2 frame timestamps, not from the nominal frame rate.
  The measured rate is shown next to the nominal one. See `NOTES.md` for why
  they differ on this camera.
- **Camera** tab: format, size, rate and all V4L2 controls (exposure, gain...).
- **Files** tab: save, reload, delete, and export an mp4 at a chosen playback rate.

Press `?` in the UI for all shortcuts.

## Pico trigger board (optional)

`pico/` holds an embassy based firmware for an RP2040 Pico.

| Pin  | Use |
| ---- | --- |
| GP2  | trigger input, pulled up; button or open collector sensor to GND |
| GP3  | flash output, active high; LED through a resistor |
| GP4  | sync output, 1 ms pulse per trigger |
| GP25 | on board LED, blinks idle, solid armed |

Hold BOOTSEL while plugging the pico in, then `mise run pico-flash`
(or `mise run pico-uf2` and copy the file by hand). The server detects the
board by its USB product name and connects on start; the **Trigger** tab
sets delay, period (auto trigger), flash length and input edge, and shows the
board's lines. The firmware has not been run on hardware yet; the protocol
parser and the server side of the link are covered by tests.

## Layout

- `server/` Rust capture server and HTTP/WebSocket API
- `web/` TypeScript UI built with bun
- `pico/` trigger firmware, `pico/protocol/` its shared command parser
- `ARCHITECTURE.md` component and timing diagrams, `NOTES.md` decisions
