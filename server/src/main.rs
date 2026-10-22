mod api;
mod camera;
mod devices;
mod recording;
mod trigger;

use anyhow::Result;
use clap::Parser;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, watch};

#[derive(Parser, Debug)]
#[command(name = "hfcv-server", about = "High fps camera capture server")]
struct Args {
    /// V4L2 device path.
    #[arg(long, default_value = "/dev/video2")]
    device: String,
    /// Address to listen on.
    #[arg(long, default_value = "127.0.0.1:8070")]
    bind: String,
    /// Directory with the built web UI.
    #[arg(long, default_value = "web/dist")]
    web_dir: PathBuf,
    /// Directory where recordings are saved.
    #[arg(long, default_value = "recordings")]
    recordings_dir: PathBuf,
    #[arg(long, default_value_t = 640)]
    width: u32,
    #[arg(long, default_value_t = 480)]
    height: u32,
    #[arg(long, default_value = "MJPG")]
    fourcc: String,
    #[arg(long, default_value_t = 200.0)]
    fps: f64,
    /// Upper bound on frames held in memory for one capture.
    #[arg(long, default_value_t = 60000)]
    max_frames: usize,
    /// Upper bound on bytes held in memory for one capture.
    #[arg(long, default_value_t = 2_000_000_000)]
    max_bytes: usize,
    /// JPEG quality used when the camera delivers raw frames.
    #[arg(long, default_value_t = 92)]
    jpeg_quality: u8,
    /// Serial port of the trigger board; auto-detected when omitted.
    #[arg(long)]
    trigger_port: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let args = Args::parse();
    std::fs::create_dir_all(&args.recordings_dir)?;

    let config = camera::CamConfig {
        width: args.width,
        height: args.height,
        fourcc: args.fourcc.clone(),
        fps: args.fps,
    };
    let (status_tx, _) = watch::channel(camera::Status {
        state: camera::State::Closed,
        config: config.clone(),
        actual_fps: 0.0,
        frames_buffered: 0,
        bytes_buffered: 0,
        elapsed_s: 0.0,
        target_s: 0.0,
        dropped_total: 0,
        process_us: 0.0,
        card: String::new(),
        error: None,
        device: args.device.clone(),
        recording_generation: 0,
    });
    let (preview_tx, _) = watch::channel(None);
    let (events_tx, _) = broadcast::channel(256);
    let shared = Arc::new(camera::Shared {
        device: Mutex::new(None),
        status: status_tx,
        preview: preview_tx,
        recording: Mutex::new(None),
        events: events_tx.clone(),
        limits: camera::Limits { max_frames: args.max_frames, max_bytes: args.max_bytes },
        jpeg_quality: args.jpeg_quality,
    });

    let (cam_tx, cam_rx) = std::sync::mpsc::channel();
    {
        let shared = shared.clone();
        let dev = args.device.clone();
        std::thread::Builder::new()
            .name("capture".into())
            .spawn(move || camera::run(shared, dev, config, cam_rx))?;
    }

    let link = Arc::new(trigger::spawn(cam_tx.clone(), events_tx.clone()));
    let port = args.trigger_port.clone().or_else(|| {
        trigger::list_ports().into_iter().find(|p| p.likely).map(|p| p.path)
    });
    if let Some(port) = port {
        tracing::info!("connecting trigger board on {port}");
        let _ = link.tx.send(trigger::TriggerCmd::Connect(port)).await;
    }

    let state = api::AppState {
        shared,
        cam_tx,
        trigger: link,
        recordings_dir: args.recordings_dir.clone(),
    };
    let app = api::router(state, args.web_dir.clone());
    let listener = tokio::net::TcpListener::bind(&args.bind).await?;
    tracing::info!("listening on http://{}", args.bind);
    axum::serve(listener, app).await?;
    Ok(())
}
