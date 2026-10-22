# Notes

## Camera facts (Arducam ezBOX VGA GS Mono over UVC)

- The UVC descriptor lists at most 240 fps, but the camera streams faster in
  the small MJPG modes: 160x120 gives about 800 fps and 320x240 about 400 fps
  while the driver still reports 240. 640x480 MJPG is a true 200 fps. The UI
  therefore shows the measured rate next to the driver's number and every
  measurement uses the per frame V4L2 timestamps, never the nominal rate.
- YUYV modes are bandwidth limited to 160 fps at 320x240 and 60 fps at 640x480.
  Raw frames are JPEG encoded on the host (gray, quality 92) so recordings
  have one representation; at 640x480 this costs about 13 ms per frame in a
  dev build with optimized dependencies, which still keeps up at 60 fps.
- `uvcvideo` runs with `hwtimestamps=0` here, so timestamps are host arrival
  times of the first packet of each frame. Spacing jitter measured with
  `v4l2-ctl --verbose` is about 0.1 ms, fine for frame level measurement.

## Decisions and traps

- **Do not call `stream.start()` on a v4l `MmapStream`.** The first `next()`
  queues all buffers and starts streaming. Starting by hand marks the stream
  active, so `next()` only ever queues one buffer; the driver then has no free
  buffer while a frame is processed and drops every other frame at high rates
  with no error, only sequence gaps.
- `tokio::sync::watch::Sender::send` does not store the value when no receiver
  exists, so status read through `borrow()` stayed stale until a WebSocket
  client connected. `send_replace` always stores.
- Dependencies are built with `opt-level = 3` even in the dev profile. The
  capture thread copies and encodes frames; unoptimized `jpeg-encoder` could
  not keep up. The server itself stays a dev build.
- `.cargo/config.toml` forces `LIBCLANG_PATH` to the system clang because the
  ESP toolchain exported in the shell has no x86_64 backend and bindgen for
  the V4L2 bindings fails with a pointer width assertion.
- Timeline axis is time, not frame index, so dropped frames appear as gaps
  rather than being hidden. Thumbnails are one tile per frame when zoomed in
  and one tile per slot when zoomed out.
- Markers live in the recording on the server and are written back with a
  short debounce, so a saved recording always carries its markers.
- Memory limits (`--max-frames`, `--max-bytes`) end a capture early with a
  note in the recording rather than growing without bound.
- The pico firmware drops outgoing lines when the host is not reading instead
  of blocking the trigger path, and sends a zero length USB packet when a line
  is an exact multiple of the packet size so the host gets it immediately.
- The firmware uses VID 0x2e8a PID 0x000a (the Pico SDK CDC defaults); the
  server finds the board by the product string `hfcv-trigger`, not by ids.
- The camera re-enumerated once during testing (`/dev/video2` became
  `/dev/video3`), so a fixed path is not enough. The server remembers the
  card name of the last opened device and, when the path fails, searches the
  capture nodes for the same name; the UI also offers a device picker.
- Metadata nodes of a UVC camera report the same capability bits as the
  video node, so the device list keeps only nodes that enumerate formats.
- `pkill -f hfcv-server` matches the shell running it; use `pkill -x`.
