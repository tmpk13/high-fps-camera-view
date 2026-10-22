//! Camera capture thread. Owns the V4L2 stream, keeps a live preview frame
//! published, and turns frames into recordings on request.

use crate::recording::{Frame, Recording};
use anyhow::{anyhow, Context, Result};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, watch};
use v4l::buffer::Type;
use v4l::control::{Control, Value};
use v4l::io::traits::CaptureStream;
use v4l::prelude::*;
use v4l::video::Capture as _;
use v4l::{Format, FourCC};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CamConfig {
    pub width: u32,
    pub height: u32,
    pub fourcc: String,
    pub fps: f64,
}

impl Default for CamConfig {
    fn default() -> Self {
        CamConfig { width: 640, height: 480, fourcc: "MJPG".into(), fps: 200.0 }
    }
}

#[derive(Debug)]
pub enum Cmd {
    SetConfig(CamConfig),
    /// Record for a fixed duration starting now.
    Record { duration_s: f64 },
    /// Keep a rolling pre-roll buffer, finish `post_s` after a trigger.
    Arm { pre_s: f64, post_s: f64 },
    Trigger,
    Stop,
    Reopen,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Closed,
    Idle,
    Recording,
    Armed,
    Post,
}

#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub state: State,
    pub config: CamConfig,
    pub actual_fps: f64,
    pub frames_buffered: usize,
    pub bytes_buffered: usize,
    pub elapsed_s: f64,
    pub target_s: f64,
    pub dropped_total: u32,
    /// Average time spent per frame in the capture thread, microseconds.
    pub process_us: f64,
    pub error: Option<String>,
    pub device: String,
    pub recording_generation: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Status(Status),
    RecordingReady { id: String, generation: u64 },
    TriggerLine { line: String },
    TriggerState { connected: bool, port: Option<String> },
}

pub struct Limits {
    pub max_frames: usize,
    pub max_bytes: usize,
}

/// Everything shared between the capture thread and the HTTP side.
pub struct Shared {
    pub device: Mutex<Option<Device>>,
    pub status: watch::Sender<Status>,
    pub preview: watch::Sender<Option<Frame>>,
    pub recording: Mutex<Option<Recording>>,
    pub events: broadcast::Sender<Event>,
    pub limits: Limits,
    pub jpeg_quality: u8,
}

enum Mode {
    Idle,
    Recording { start_ts: i64, duration_us: i64 },
    Armed { pre_us: i64, post_us: i64, ring: VecDeque<Frame>, ring_bytes: usize },
    Post { trigger_ts: i64, post_us: i64 },
}

struct Capture {
    shared: Arc<Shared>,
    dev_path: String,
    config: CamConfig,
    stream: Option<MmapStream<'static>>,
    mode: Mode,
    pending: Vec<Frame>,
    pending_bytes: usize,
    trigger_frame: Option<usize>,
    last_seq: Option<u32>,
    dropped_total: u32,
    recent_ts: VecDeque<i64>,
    last_status: Instant,
    generation: u64,
    error: Option<String>,
    note: String,
    process_us: f64,
}

pub fn run(shared: Arc<Shared>, dev_path: String, config: CamConfig, rx: Receiver<Cmd>) {
    let mut cap = Capture {
        shared,
        dev_path,
        config,
        stream: None,
        mode: Mode::Idle,
        pending: Vec::new(),
        pending_bytes: 0,
        trigger_frame: None,
        last_seq: None,
        dropped_total: 0,
        recent_ts: VecDeque::new(),
        last_status: Instant::now(),
        generation: 0,
        error: None,
        note: String::new(),
        process_us: 0.0,
    };
    let mut next_open = Instant::now();
    loop {
        // Commands are drained between frames; a blocked next() returns within its timeout.
        loop {
            match rx.try_recv() {
                Ok(cmd) => cap.handle(cmd),
                Err(_) => break,
            }
        }
        if cap.stream.is_none() {
            if Instant::now() < next_open {
                // Wait for a command instead of spinning while the camera is missing.
                match rx.recv_timeout(next_open.saturating_duration_since(Instant::now())) {
                    Ok(cmd) => cap.handle(cmd),
                    Err(RecvTimeoutError::Disconnected) => return,
                    Err(RecvTimeoutError::Timeout) => {}
                }
                continue;
            }
            match cap.open() {
                Ok(()) => {
                    cap.error = None;
                    cap.publish_status(true);
                }
                Err(e) => {
                    cap.error = Some(format!("{e:#}"));
                    cap.publish_status(true);
                    next_open = Instant::now() + Duration::from_secs(2);
                }
            }
            continue;
        }
        let result = {
            let stream = cap.stream.as_mut().expect("stream checked above");
            stream.next().map(|(buf, meta)| {
                (
                    Bytes::copy_from_slice(&buf[..meta.bytesused as usize]),
                    meta.sequence,
                    meta.timestamp.sec as i64 * 1_000_000 + meta.timestamp.usec as i64,
                )
            })
        };
        match result {
            Ok((data, seq, ts_us)) => cap.on_frame(data, seq, ts_us),
            Err(e) => {
                tracing::warn!("capture error: {e}");
                cap.error = Some(format!("capture error: {e}"));
                cap.stream = None;
                cap.abort_capture();
                cap.publish_status(true);
                next_open = Instant::now() + Duration::from_millis(500);
            }
        }
    }
}

impl Capture {
    fn open(&mut self) -> Result<()> {
        let dev = Device::with_path(&self.dev_path)
            .with_context(|| format!("open {}", self.dev_path))?;
        let fourcc = fourcc_from(&self.config.fourcc)?;
        let fmt = Format::new(self.config.width, self.config.height, fourcc);
        let applied = dev.set_format(&fmt).context("set format")?;
        let interval = best_interval(&dev, fourcc, applied.width, applied.height, self.config.fps);
        let params = v4l::video::capture::Parameters::new(interval);
        let applied_params = dev.set_params(&params).context("set frame rate")?;
        let fps = fraction_to_fps(applied_params.interval);
        self.config = CamConfig {
            width: applied.width,
            height: applied.height,
            fourcc: applied.fourcc.to_string(),
            fps,
        };
        tracing::info!(
            "camera {}x{} {} at {:.3} fps",
            applied.width,
            applied.height,
            applied.fourcc,
            fps
        );
        let mut stream = MmapStream::with_buffers(&dev, Type::VideoCapture, 8)
            .context("create mmap stream")?;
        stream.set_timeout(Duration::from_millis(1000));
        // The first next() queues every buffer and starts streaming. Starting
        // here instead leaves one buffer in flight and the driver drops the rest.
        *self.shared.device.lock().unwrap() = Some(dev);
        self.stream = Some(stream);
        self.last_seq = None;
        self.recent_ts.clear();
        Ok(())
    }

    fn close(&mut self) {
        self.stream = None;
        *self.shared.device.lock().unwrap() = None;
    }

    fn handle(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::SetConfig(cfg) => {
                self.abort_capture();
                self.close();
                self.config = cfg;
                match self.open() {
                    Ok(()) => self.error = None,
                    Err(e) => self.error = Some(format!("{e:#}")),
                }
            }
            Cmd::Reopen => {
                self.abort_capture();
                self.close();
                match self.open() {
                    Ok(()) => self.error = None,
                    Err(e) => self.error = Some(format!("{e:#}")),
                }
            }
            Cmd::Record { duration_s } => {
                self.abort_capture();
                self.note.clear();
                self.mode = Mode::Recording {
                    start_ts: -1,
                    duration_us: (duration_s.max(0.01) * 1e6) as i64,
                };
            }
            Cmd::Arm { pre_s, post_s } => {
                self.abort_capture();
                self.note.clear();
                self.mode = Mode::Armed {
                    pre_us: (pre_s.max(0.0) * 1e6) as i64,
                    post_us: (post_s.max(0.0) * 1e6) as i64,
                    ring: VecDeque::new(),
                    ring_bytes: 0,
                };
            }
            Cmd::Trigger => {
                if let Mode::Armed { post_us, ring, ring_bytes, .. } = &mut self.mode {
                    let post_us = *post_us;
                    let ring = std::mem::take(ring);
                    self.pending_bytes = *ring_bytes;
                    self.pending = ring.into_iter().collect();
                    self.trigger_frame = Some(self.pending.len());
                    // Trigger time is the timestamp of the next frame; use the
                    // newest buffered frame as the reference until it arrives.
                    let ref_ts = self.pending.last().map(|f| f.ts_us).unwrap_or(-1);
                    self.mode = Mode::Post { trigger_ts: ref_ts, post_us };
                    if post_us == 0 {
                        self.finish();
                    }
                }
            }
            Cmd::Stop => match self.mode {
                Mode::Recording { .. } | Mode::Post { .. } => {
                    self.note = "stopped manually".into();
                    self.finish();
                }
                Mode::Armed { .. } => self.abort_capture(),
                Mode::Idle => {}
            },
        }
        self.publish_status(true);
    }

    fn abort_capture(&mut self) {
        self.mode = Mode::Idle;
        self.pending.clear();
        self.pending_bytes = 0;
        self.trigger_frame = None;
    }

    fn on_frame(&mut self, data: Bytes, seq: u32, ts_us: i64) {
        let t_start = Instant::now();
        if let Some(prev) = self.last_seq {
            self.dropped_total += seq.wrapping_sub(prev).saturating_sub(1);
        }
        self.last_seq = Some(seq);
        self.recent_ts.push_back(ts_us);
        while self.recent_ts.len() > 2 && ts_us - self.recent_ts[0] > 1_000_000 {
            self.recent_ts.pop_front();
        }

        let data = match self.config.fourcc.as_str() {
            "MJPG" => data,
            "YUYV" | "YUY2" => match yuyv_to_jpeg(&data, self.config.width, self.config.height, self.shared.jpeg_quality) {
                Ok(j) => Bytes::from(j),
                Err(e) => {
                    self.error = Some(format!("encode: {e}"));
                    return;
                }
            },
            "GREY" => match gray_to_jpeg(&data, self.config.width, self.config.height, self.shared.jpeg_quality) {
                Ok(j) => Bytes::from(j),
                Err(e) => {
                    self.error = Some(format!("encode: {e}"));
                    return;
                }
            },
            other => {
                self.error = Some(format!("unsupported pixel format {other}"));
                return;
            }
        };
        let frame = Frame { seq, ts_us, data };
        self.shared.preview.send_replace(Some(frame.clone()));

        let limits = &self.shared.limits;
        let mut finish = false;
        match &mut self.mode {
            Mode::Idle => {}
            Mode::Recording { start_ts, duration_us } => {
                if *start_ts < 0 {
                    *start_ts = ts_us;
                }
                let full = self.pending.len() >= limits.max_frames
                    || self.pending_bytes + frame.data.len() > limits.max_bytes;
                if full {
                    self.note = "memory limit reached".into();
                    finish = true;
                } else {
                    self.pending_bytes += frame.data.len();
                    self.pending.push(frame);
                    if ts_us - *start_ts >= *duration_us {
                        finish = true;
                    }
                }
            }
            Mode::Armed { pre_us, ring, ring_bytes, .. } => {
                *ring_bytes += frame.data.len();
                ring.push_back(frame);
                while let Some(front) = ring.front() {
                    let too_old = ring.back().map(|b| b.ts_us - front.ts_us > *pre_us).unwrap_or(false);
                    let too_big = ring.len() > limits.max_frames || *ring_bytes > limits.max_bytes;
                    if too_old || too_big {
                        *ring_bytes -= front.data.len();
                        ring.pop_front();
                    } else {
                        break;
                    }
                }
            }
            Mode::Post { trigger_ts, post_us } => {
                if *trigger_ts < 0 {
                    *trigger_ts = ts_us;
                }
                let full = self.pending.len() >= limits.max_frames
                    || self.pending_bytes + frame.data.len() > limits.max_bytes;
                if full {
                    self.note = "memory limit reached".into();
                    finish = true;
                } else {
                    self.pending_bytes += frame.data.len();
                    self.pending.push(frame);
                    if ts_us - *trigger_ts >= *post_us {
                        finish = true;
                    }
                }
            }
        }
        let spent = t_start.elapsed().as_secs_f64() * 1e6;
        self.process_us = self.process_us * 0.95 + spent * 0.05;
        if finish {
            self.finish();
            self.publish_status(true);
        } else {
            self.publish_status(false);
        }
    }

    fn finish(&mut self) {
        let frames = std::mem::take(&mut self.pending);
        self.pending_bytes = 0;
        let trigger_frame = self.trigger_frame.take();
        self.mode = Mode::Idle;
        if frames.is_empty() {
            return;
        }
        self.generation += 1;
        let id = chrono::Local::now().format("rec-%Y%m%d-%H%M%S").to_string();
        let rec = Recording::new(
            id.clone(),
            self.config.width,
            self.config.height,
            self.config.fourcc.clone(),
            self.config.fps,
            frames,
            trigger_frame,
            std::mem::take(&mut self.note),
        );
        tracing::info!("recording {id}: {} frames, {} dropped", rec.meta.frame_count, rec.meta.dropped);
        *self.shared.recording.lock().unwrap() = Some(rec);
        let _ = self.shared.events.send(Event::RecordingReady { id, generation: self.generation });
    }

    fn publish_status(&mut self, force: bool) {
        if !force && self.last_status.elapsed() < Duration::from_millis(100) {
            return;
        }
        self.last_status = Instant::now();
        let actual_fps = if self.recent_ts.len() >= 2 {
            let span = (self.recent_ts.back().unwrap() - self.recent_ts.front().unwrap()) as f64 / 1e6;
            if span > 0.0 { (self.recent_ts.len() - 1) as f64 / span } else { 0.0 }
        } else {
            0.0
        };
        let now_ts = self.recent_ts.back().copied().unwrap_or(0);
        let (state, elapsed_s, target_s, frames_buffered, bytes_buffered) = match &self.mode {
            Mode::Idle => (
                if self.stream.is_some() { State::Idle } else { State::Closed },
                0.0,
                0.0,
                0,
                0,
            ),
            Mode::Recording { start_ts, duration_us } => (
                State::Recording,
                if *start_ts < 0 { 0.0 } else { (now_ts - start_ts) as f64 / 1e6 },
                *duration_us as f64 / 1e6,
                self.pending.len(),
                self.pending_bytes,
            ),
            Mode::Armed { pre_us, ring, ring_bytes, .. } => (
                State::Armed,
                ring.back()
                    .zip(ring.front())
                    .map(|(b, f)| (b.ts_us - f.ts_us) as f64 / 1e6)
                    .unwrap_or(0.0),
                *pre_us as f64 / 1e6,
                ring.len(),
                *ring_bytes,
            ),
            Mode::Post { trigger_ts, post_us } => (
                State::Post,
                if *trigger_ts < 0 { 0.0 } else { (now_ts - trigger_ts) as f64 / 1e6 },
                *post_us as f64 / 1e6,
                self.pending.len(),
                self.pending_bytes,
            ),
        };
        let status = Status {
            state,
            config: self.config.clone(),
            actual_fps,
            frames_buffered,
            bytes_buffered,
            elapsed_s,
            target_s,
            dropped_total: self.dropped_total,
            process_us: self.process_us,
            error: self.error.clone(),
            device: self.dev_path.clone(),
            recording_generation: self.generation,
        };
        self.shared.status.send_replace(status);
    }
}

pub fn fourcc_from(s: &str) -> Result<FourCC> {
    let b = s.as_bytes();
    if b.len() != 4 {
        return Err(anyhow!("fourcc must be 4 characters, got {s:?}"));
    }
    Ok(FourCC::new(&[b[0], b[1], b[2], b[3]]))
}

pub fn fraction_to_fps(f: v4l::Fraction) -> f64 {
    if f.numerator == 0 {
        0.0
    } else {
        f.denominator as f64 / f.numerator as f64
    }
}

/// Pick the enumerated interval closest to the wanted rate, or build one when
/// the driver enumerates nothing usable.
fn best_interval(dev: &Device, fourcc: FourCC, w: u32, h: u32, fps: f64) -> v4l::Fraction {
    let mut best: Option<(f64, v4l::Fraction)> = None;
    if let Ok(list) = dev.enum_frameintervals(fourcc, w, h) {
        for fi in list {
            if let v4l::frameinterval::FrameIntervalEnum::Discrete(fr) = fi.interval {
                let d = (fraction_to_fps(fr) - fps).abs();
                if best.map(|(bd, _)| d < bd).unwrap_or(true) {
                    best = Some((d, fr));
                }
            }
        }
    }
    match best {
        Some((d, fr)) if d < 0.5 => fr,
        _ => v4l::Fraction::new(1000, (fps.max(1.0) * 1000.0).round() as u32),
    }
}

fn yuyv_to_jpeg(data: &[u8], w: u32, h: u32, quality: u8) -> Result<Vec<u8>> {
    let need = (w * h * 2) as usize;
    if data.len() < need {
        return Err(anyhow!("short YUYV frame: {} < {need}", data.len()));
    }
    let y: Vec<u8> = data[..need].chunks_exact(2).map(|c| c[0]).collect();
    gray_to_jpeg(&y, w, h, quality)
}

fn gray_to_jpeg(y: &[u8], w: u32, h: u32, quality: u8) -> Result<Vec<u8>> {
    let need = (w * h) as usize;
    if y.len() < need {
        return Err(anyhow!("short gray frame: {} < {need}", y.len()));
    }
    let mut out = Vec::with_capacity(need / 4);
    let enc = jpeg_encoder::Encoder::new(&mut out, quality);
    enc.encode(&y[..need], w as u16, h as u16, jpeg_encoder::ColorType::Luma)
        .map_err(|e| anyhow!("jpeg encode: {e}"))?;
    Ok(out)
}

// ---- Device queries used by the API (run with the device lock held) ----

#[derive(Clone, Debug, Serialize)]
pub struct IntervalInfo {
    pub numerator: u32,
    pub denominator: u32,
    pub fps: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct SizeInfo {
    pub width: u32,
    pub height: u32,
    pub intervals: Vec<IntervalInfo>,
}

#[derive(Clone, Debug, Serialize)]
pub struct FormatInfo {
    pub fourcc: String,
    pub description: String,
    pub supported: bool,
    pub sizes: Vec<SizeInfo>,
}

pub fn enumerate_formats(dev: &Device) -> Result<Vec<FormatInfo>> {
    let mut out = Vec::new();
    for desc in dev.enum_formats()? {
        let mut sizes: Vec<SizeInfo> = Vec::new();
        for fs in dev.enum_framesizes(desc.fourcc)? {
            let v4l::framesize::FrameSizeEnum::Discrete(d) = fs.size else {
                continue;
            };
            if sizes.iter().any(|s| s.width == d.width && s.height == d.height) {
                continue;
            }
            let mut intervals: Vec<IntervalInfo> = Vec::new();
            for fi in dev.enum_frameintervals(desc.fourcc, d.width, d.height)? {
                let v4l::frameinterval::FrameIntervalEnum::Discrete(fr) = fi.interval else {
                    continue;
                };
                if intervals.iter().any(|i| i.numerator == fr.numerator && i.denominator == fr.denominator) {
                    continue;
                }
                intervals.push(IntervalInfo {
                    numerator: fr.numerator,
                    denominator: fr.denominator,
                    fps: fraction_to_fps(fr),
                });
            }
            intervals.sort_by(|a, b| b.fps.partial_cmp(&a.fps).unwrap());
            sizes.push(SizeInfo { width: d.width, height: d.height, intervals });
        }
        sizes.sort_by_key(|s| std::cmp::Reverse(s.width * s.height));
        let fourcc = desc.fourcc.to_string();
        out.push(FormatInfo {
            supported: matches!(fourcc.as_str(), "MJPG" | "YUYV" | "YUY2" | "GREY"),
            fourcc,
            description: desc.description,
            sizes,
        });
    }
    Ok(out)
}

#[derive(Clone, Debug, Serialize)]
pub struct MenuEntry {
    pub value: i64,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ControlInfo {
    pub id: u32,
    pub name: String,
    pub kind: String,
    pub min: i64,
    pub max: i64,
    pub step: u64,
    pub default: i64,
    pub value: Option<i64>,
    pub inactive: bool,
    pub read_only: bool,
    pub items: Vec<MenuEntry>,
}

pub fn enumerate_controls(dev: &Device) -> Result<Vec<ControlInfo>> {
    use v4l::control::{Flags, Type as CType};
    let mut out = Vec::new();
    for d in dev.query_controls()? {
        let kind = match d.typ {
            CType::Integer | CType::Integer64 => "integer",
            CType::Boolean => "boolean",
            CType::Menu | CType::IntegerMenu => "menu",
            CType::Button => "button",
            _ => continue,
        };
        if d.flags.contains(Flags::DISABLED) {
            continue;
        }
        let value = dev.control(d.id).ok().and_then(|c| match c.value {
            Value::Integer(v) => Some(v),
            Value::Boolean(b) => Some(b as i64),
            _ => None,
        });
        let items = d
            .items
            .as_ref()
            .map(|items| {
                items
                    .iter()
                    .map(|(v, item)| MenuEntry {
                        value: *v as i64,
                        name: match item {
                            v4l::control::MenuItem::Name(n) => n.clone(),
                            v4l::control::MenuItem::Value(x) => x.to_string(),
                        },
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.push(ControlInfo {
            id: d.id,
            name: d.name,
            kind: kind.into(),
            min: d.minimum,
            max: d.maximum,
            step: d.step,
            default: d.default,
            value,
            inactive: d.flags.contains(Flags::INACTIVE),
            read_only: d.flags.contains(Flags::READ_ONLY),
            items,
        });
    }
    Ok(out)
}

pub fn set_control(dev: &Device, id: u32, value: i64) -> Result<()> {
    let desc = dev
        .query_controls()?
        .into_iter()
        .find(|d| d.id == id)
        .ok_or_else(|| anyhow!("unknown control {id}"))?;
    let v = match desc.typ {
        v4l::control::Type::Boolean => Value::Boolean(value != 0),
        v4l::control::Type::Button => Value::None,
        _ => Value::Integer(value),
    };
    dev.set_control(Control { id, value: v })
        .with_context(|| format!("set {}", desc.name))?;
    Ok(())
}
