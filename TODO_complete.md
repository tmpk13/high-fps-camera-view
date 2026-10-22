# Completed

- Rust capture server: V4L2 mmap capture thread, MJPG passthrough and YUYV/GREY
  JPEG encoding, per frame timestamps and dropped frame detection.
- Timed recording, armed pre/post-roll capture with trigger from UI, keyboard
  or serial board, manual stop, memory limits.
- HTTP API: status, WebSocket events, 30 fps MJPEG preview, camera formats and
  controls, capture control, recording metadata and frames, markers, save,
  load, delete, list, mp4 export through ffmpeg, trigger port management.
- Web UI (bun, TypeScript, solarized light/dark): live view, recording view
  with transport and playback speeds, canvas timeline with thumbnails, time
  ruler, zoom and pan, hover frame preview, draggable markers, in/out range,
  marker table with deltas and CSV export, camera config and controls panel,
  trigger panel with board console, files panel.
- Pico trigger firmware (embassy-rp): USB CDC line protocol, debounced edge
  input, periodic trigger, delay, flash and sync outputs, status LED; shared
  protocol parser crate with tests.
- Tests: server unit tests, UI helper tests, protocol parser tests; live
  camera smoke tests for every mode and a virtual serial port trigger test.
- mise tasks, README, ARCHITECTURE with mermaid diagrams and Gantt, NOTES.
- UI follow-up: timeline clicks and marker jumps seek without pausing
  playback (real-time mode re-bases on seek), wheel zoom with drag pan on the
  viewer, drag handles for sidebar width and timeline height, full screen
  toggle, capture controls moved into a Capture tab with a thick collapse
  strip on the sidebar.
- Middle mouse drag pans the viewer; sidebar tabs share the bar width and
  shrink with it; camera reconnect from the live view and the Camera tab with
  a device picker, plus name based recovery after USB re-enumeration.
