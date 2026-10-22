//! HTTP and WebSocket API.

use crate::camera::{self, CamConfig, Cmd, Event, Status};
use crate::recording::{self, Marker, Recording, RecordingMeta};
use crate::trigger::{self, TriggerCmd, TriggerLink};
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::mpsc::Sender as CamSender;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
pub struct AppState {
    pub shared: Arc<camera::Shared>,
    pub cam_tx: CamSender<Cmd>,
    pub trigger: Arc<TriggerLink>,
    pub recordings_dir: PathBuf,
}

type ApiResult<T> = Result<T, ApiError>;

pub struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({ "error": self.1 }))).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}"))
    }
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}

fn ok() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

pub fn router(state: AppState, web_dir: PathBuf) -> Router {
    let index = web_dir.join("index.html");
    let api = Router::new()
        .route("/status", get(get_status))
        .route("/ws", get(ws_handler))
        .route("/preview.mjpg", get(preview_stream))
        .route("/camera/formats", get(get_formats))
        .route("/camera/controls", get(get_controls).post(set_control))
        .route("/camera/config", post(set_config))
        .route("/camera/reopen", post(reopen))
        .route("/camera/devices", get(get_devices))
        .route("/capture/record", post(record))
        .route("/capture/arm", post(arm))
        .route("/capture/trigger", post(trigger_now))
        .route("/capture/stop", post(stop))
        .route("/recording", get(get_recording))
        .route("/recording/frame/{i}", get(get_frame))
        .route("/recording/markers", axum::routing::put(put_markers))
        .route("/recording/save", post(save_recording))
        .route("/recording/export", post(export_recording))
        .route("/recordings", get(list_recordings))
        .route("/recordings/{name}/load", post(load_recording))
        .route("/recordings/{name}", axum::routing::delete(delete_recording))
        .route("/recordings/{name}/file/{file}", get(get_saved_file))
        .route("/trigger/ports", get(trigger_ports))
        .route("/trigger/status", get(trigger_status))
        .route("/trigger/connect", post(trigger_connect))
        .route("/trigger/disconnect", post(trigger_disconnect))
        .route("/trigger/send", post(trigger_send));
    Router::new()
        .nest("/api", api)
        .fallback_service(ServeDir::new(web_dir).not_found_service(ServeFile::new(index)))
        .with_state(state)
}

async fn get_status(State(s): State<AppState>) -> Json<Status> {
    Json(s.shared.status.borrow().clone())
}

async fn ws_handler(ws: WebSocketUpgrade, State(s): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| ws_loop(socket, s))
}

async fn ws_loop(mut socket: WebSocket, s: AppState) {
    let mut status_rx = s.shared.status.subscribe();
    let mut events_rx = s.shared.events.subscribe();
    status_rx.mark_changed();
    let trigger_state = s.trigger.state.lock().unwrap().clone();
    let hello = Event::TriggerState { connected: trigger_state.connected, port: trigger_state.port };
    if send_json(&mut socket, &hello).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            changed = status_rx.changed() => {
                if changed.is_err() { break; }
                let st = status_rx.borrow_and_update().clone();
                if send_json(&mut socket, &Event::Status(st)).await.is_err() { break; }
            }
            ev = events_rx.recv() => {
                match ev {
                    Ok(ev) => { if send_json(&mut socket, &ev).await.is_err() { break; } }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }
}

async fn send_json<T: Serialize>(socket: &mut WebSocket, v: &T) -> Result<(), ()> {
    let text = serde_json::to_string(v).map_err(|_| ())?;
    socket.send(Message::Text(text.into())).await.map_err(|_| ())
}

#[derive(Deserialize)]
struct PreviewQuery {
    fps: Option<f64>,
}

/// Multipart MJPEG stream of the live camera, throttled for the browser.
async fn preview_stream(State(s): State<AppState>, Query(q): Query<PreviewQuery>) -> Response {
    let min_gap = Duration::from_secs_f64(1.0 / q.fps.unwrap_or(30.0).clamp(1.0, 240.0));
    let mut rx = s.shared.preview.subscribe();
    let stream = async_stream(move |tx| async move {
        let mut last = Instant::now() - min_gap;
        loop {
            if rx.changed().await.is_err() {
                break;
            }
            if last.elapsed() < min_gap {
                continue;
            }
            let frame = rx.borrow_and_update().clone();
            let Some(frame) = frame else { continue };
            last = Instant::now();
            let mut chunk = Vec::with_capacity(frame.data.len() + 128);
            chunk.extend_from_slice(
                format!(
                    "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\nX-Timestamp-Us: {}\r\n\r\n",
                    frame.data.len(),
                    frame.ts_us
                )
                .as_bytes(),
            );
            chunk.extend_from_slice(&frame.data);
            chunk.extend_from_slice(b"\r\n");
            if tx.send(Ok::<_, std::io::Error>(bytes::Bytes::from(chunk))).await.is_err() {
                break;
            }
        }
    });
    Response::builder()
        .header(header::CONTENT_TYPE, "multipart/x-mixed-replace; boundary=frame")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(stream))
        .unwrap()
}

/// Small helper: run a producer task that pushes chunks into a channel-backed stream.
fn async_stream<F, Fut>(f: F) -> tokio_stream::wrappers::ReceiverStream<Result<bytes::Bytes, std::io::Error>>
where
    F: FnOnce(tokio::sync::mpsc::Sender<Result<bytes::Bytes, std::io::Error>>) -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let (tx, rx) = tokio::sync::mpsc::channel(4);
    tokio::spawn(f(tx));
    tokio_stream::wrappers::ReceiverStream::new(rx)
}

async fn get_formats(State(s): State<AppState>) -> ApiResult<Json<Vec<camera::FormatInfo>>> {
    let shared = s.shared.clone();
    let list = tokio::task::spawn_blocking(move || {
        let guard = shared.device.lock().unwrap();
        let dev = guard.as_ref().ok_or_else(|| anyhow::anyhow!("camera not open"))?;
        camera::enumerate_formats(dev)
    })
    .await
    .map_err(|e| anyhow::anyhow!(e))??;
    Ok(Json(list))
}

async fn get_controls(State(s): State<AppState>) -> ApiResult<Json<Vec<camera::ControlInfo>>> {
    let shared = s.shared.clone();
    let list = tokio::task::spawn_blocking(move || {
        let guard = shared.device.lock().unwrap();
        let dev = guard.as_ref().ok_or_else(|| anyhow::anyhow!("camera not open"))?;
        camera::enumerate_controls(dev)
    })
    .await
    .map_err(|e| anyhow::anyhow!(e))??;
    Ok(Json(list))
}

#[derive(Deserialize)]
struct SetControlReq {
    id: u32,
    value: i64,
}

async fn set_control(State(s): State<AppState>, Json(req): Json<SetControlReq>) -> ApiResult<Json<serde_json::Value>> {
    let shared = s.shared.clone();
    tokio::task::spawn_blocking(move || {
        let guard = shared.device.lock().unwrap();
        let dev = guard.as_ref().ok_or_else(|| anyhow::anyhow!("camera not open"))?;
        camera::set_control(dev, req.id, req.value)
    })
    .await
    .map_err(|e| anyhow::anyhow!(e))??;
    Ok(ok())
}

async fn set_config(State(s): State<AppState>, Json(cfg): Json<CamConfig>) -> ApiResult<Json<serde_json::Value>> {
    if cfg.width == 0 || cfg.height == 0 || !(cfg.fps > 0.0) {
        return Err(bad("width, height and fps must be positive"));
    }
    camera::fourcc_from(&cfg.fourcc).map_err(|e| bad(e.to_string()))?;
    s.cam_tx.send(Cmd::SetConfig(cfg)).map_err(|_| bad("camera thread gone"))?;
    Ok(ok())
}

#[derive(Deserialize, Default)]
struct ReopenReq {
    device: Option<String>,
}

async fn reopen(State(s): State<AppState>, body: Option<Json<ReopenReq>>) -> ApiResult<Json<serde_json::Value>> {
    let device = body.and_then(|b| b.0.device).filter(|d| !d.trim().is_empty());
    if let Some(d) = &device {
        if !d.starts_with("/dev/") {
            return Err(bad("device must be a /dev path"));
        }
    }
    s.cam_tx.send(Cmd::Reopen { device }).map_err(|_| bad("camera thread gone"))?;
    Ok(ok())
}

async fn get_devices() -> Json<Vec<crate::devices::DeviceInfo>> {
    Json(tokio::task::spawn_blocking(crate::devices::list_devices).await.unwrap_or_default())
}

#[derive(Deserialize)]
struct RecordReq {
    duration_s: f64,
}

async fn record(State(s): State<AppState>, Json(r): Json<RecordReq>) -> ApiResult<Json<serde_json::Value>> {
    if !(r.duration_s > 0.0) {
        return Err(bad("duration must be positive"));
    }
    s.cam_tx.send(Cmd::Record { duration_s: r.duration_s }).map_err(|_| bad("camera thread gone"))?;
    Ok(ok())
}

#[derive(Deserialize)]
struct ArmReq {
    pre_s: f64,
    post_s: f64,
}

async fn arm(State(s): State<AppState>, Json(r): Json<ArmReq>) -> ApiResult<Json<serde_json::Value>> {
    if r.pre_s < 0.0 || r.post_s < 0.0 || r.pre_s + r.post_s <= 0.0 {
        return Err(bad("pre and post roll must be non-negative and not both zero"));
    }
    s.cam_tx.send(Cmd::Arm { pre_s: r.pre_s, post_s: r.post_s }).map_err(|_| bad("camera thread gone"))?;
    Ok(ok())
}

async fn trigger_now(State(s): State<AppState>) -> ApiResult<Json<serde_json::Value>> {
    s.cam_tx.send(Cmd::Trigger).map_err(|_| bad("camera thread gone"))?;
    Ok(ok())
}

async fn stop(State(s): State<AppState>) -> ApiResult<Json<serde_json::Value>> {
    s.cam_tx.send(Cmd::Stop).map_err(|_| bad("camera thread gone"))?;
    Ok(ok())
}

async fn get_recording(State(s): State<AppState>) -> ApiResult<Json<Option<RecordingMeta>>> {
    let guard = s.shared.recording.lock().unwrap();
    Ok(Json(guard.as_ref().map(|r| r.meta.clone())))
}

async fn get_frame(State(s): State<AppState>, Path(i): Path<usize>) -> Response {
    let data = {
        let guard = s.shared.recording.lock().unwrap();
        guard.as_ref().and_then(|r| r.frame(i))
    };
    match data {
        Some(bytes) => (
            [(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "private, max-age=3600")],
            bytes,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn put_markers(State(s): State<AppState>, Json(markers): Json<Vec<Marker>>) -> ApiResult<Json<serde_json::Value>> {
    let mut guard = s.shared.recording.lock().unwrap();
    let rec = guard.as_mut().ok_or_else(|| bad("no recording"))?;
    for m in &markers {
        if m.frame >= rec.meta.frame_count {
            return Err(bad(format!("marker {} outside recording", m.name)));
        }
    }
    rec.meta.markers = markers;
    Ok(ok())
}

#[derive(Deserialize)]
struct SaveReq {
    name: Option<String>,
}

#[derive(Serialize)]
struct SaveResp {
    name: String,
}

fn take_name(req: &Option<String>, fallback: &str) -> ApiResult<String> {
    let raw = req.as_deref().filter(|n| !n.trim().is_empty()).unwrap_or(fallback);
    recording::safe_name(raw).ok_or_else(|| bad("name may only contain letters, digits, '-', '_' and '.'"))
}

async fn save_recording(State(s): State<AppState>, Json(req): Json<SaveReq>) -> ApiResult<Json<SaveResp>> {
    let shared = s.shared.clone();
    let root = s.recordings_dir.clone();
    let name = {
        let guard = shared.recording.lock().unwrap();
        let rec = guard.as_ref().ok_or_else(|| bad("no recording"))?;
        take_name(&req.name, &rec.meta.id)?
    };
    let name2 = name.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let mut guard = shared.recording.lock().unwrap();
        let rec = guard.as_mut().ok_or_else(|| anyhow::anyhow!("no recording"))?;
        rec.save(&recording::recording_dir(&root, &name2))
    })
    .await
    .map_err(|e| anyhow::anyhow!(e))??;
    Ok(Json(SaveResp { name }))
}

#[derive(Deserialize)]
struct ExportReq {
    name: Option<String>,
    /// Playback rate of the produced video; lower than capture rate gives slow motion.
    playback_fps: f64,
}

#[derive(Serialize)]
struct ExportResp {
    name: String,
    file: String,
    url: String,
}

async fn export_recording(State(s): State<AppState>, Json(req): Json<ExportReq>) -> ApiResult<Json<ExportResp>> {
    if !(req.playback_fps > 0.0) {
        return Err(bad("playback_fps must be positive"));
    }
    let saved = save_recording(State(s.clone()), Json(SaveReq { name: req.name })).await?.0.name;
    let dir = recording::recording_dir(&s.recordings_dir, &saved);
    let file = format!("{}_{}fps.mp4", saved, req.playback_fps.round() as u32);
    let status = tokio::process::Command::new("ffmpeg")
        .arg("-y")
        .arg("-loglevel")
        .arg("error")
        .arg("-framerate")
        .arg(format!("{}", req.playback_fps))
        .arg("-i")
        .arg(dir.join("frames").join("%06d.jpg"))
        .arg("-c:v")
        .arg("libx264")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-crf")
        .arg("18")
        .arg(dir.join(&file))
        .status()
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, format!("ffmpeg: {e}")))?;
    if !status.success() {
        return Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, format!("ffmpeg exited with {status}")));
    }
    Ok(Json(ExportResp {
        url: format!("/api/recordings/{saved}/file/{file}"),
        name: saved,
        file,
    }))
}

async fn list_recordings(State(s): State<AppState>) -> Json<Vec<recording::SavedSummary>> {
    Json(recording::list_saved(&s.recordings_dir))
}

async fn load_recording(State(s): State<AppState>, Path(name): Path<String>) -> ApiResult<Json<RecordingMeta>> {
    let name = recording::safe_name(&name).ok_or_else(|| bad("bad name"))?;
    let dir = recording::recording_dir(&s.recordings_dir, &name);
    let rec = tokio::task::spawn_blocking(move || Recording::load(&dir))
        .await
        .map_err(|e| anyhow::anyhow!(e))??;
    let meta = rec.meta.clone();
    *s.shared.recording.lock().unwrap() = Some(rec);
    let gen = s.shared.status.borrow().recording_generation;
    let _ = s.shared.events.send(Event::RecordingReady { id: meta.id.clone(), generation: gen });
    Ok(Json(meta))
}

async fn delete_recording(State(s): State<AppState>, Path(name): Path<String>) -> ApiResult<Json<serde_json::Value>> {
    let name = recording::safe_name(&name).ok_or_else(|| bad("bad name"))?;
    let dir = recording::recording_dir(&s.recordings_dir, &name);
    if !dir.join("index.json").exists() {
        return Err(ApiError(StatusCode::NOT_FOUND, "no such recording".into()));
    }
    tokio::fs::remove_dir_all(&dir)
        .await
        .map_err(|e| anyhow::anyhow!("remove: {e}"))?;
    Ok(ok())
}

async fn get_saved_file(State(s): State<AppState>, Path((name, file)): Path<(String, String)>) -> Response {
    let (Some(name), Some(file)) = (recording::safe_name(&name), recording::safe_name(&file)) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let path = recording::recording_dir(&s.recordings_dir, &name).join(&file);
    match tokio::fs::read(&path).await {
        Ok(data) => {
            let ct = if file.ends_with(".mp4") { "video/mp4" } else { "application/octet-stream" };
            (
                [
                    (header::CONTENT_TYPE, ct.to_string()),
                    (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{file}\"")),
                ],
                data,
            )
                .into_response()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn trigger_ports() -> Json<Vec<trigger::PortInfo>> {
    Json(trigger::list_ports())
}

async fn trigger_status(State(s): State<AppState>) -> Json<trigger::TriggerState> {
    Json(s.trigger.state.lock().unwrap().clone())
}

#[derive(Deserialize)]
struct ConnectReq {
    port: String,
}

async fn trigger_connect(State(s): State<AppState>, Json(r): Json<ConnectReq>) -> ApiResult<Json<serde_json::Value>> {
    s.trigger.tx.send(TriggerCmd::Connect(r.port)).await.map_err(|_| bad("trigger task gone"))?;
    Ok(ok())
}

async fn trigger_disconnect(State(s): State<AppState>) -> ApiResult<Json<serde_json::Value>> {
    s.trigger.tx.send(TriggerCmd::Disconnect).await.map_err(|_| bad("trigger task gone"))?;
    Ok(ok())
}

#[derive(Deserialize)]
struct SendReq {
    line: String,
}

async fn trigger_send(State(s): State<AppState>, Json(r): Json<SendReq>) -> ApiResult<Json<serde_json::Value>> {
    s.trigger.tx.send(TriggerCmd::Send(r.line)).await.map_err(|_| bad("trigger task gone"))?;
    Ok(ok())
}
