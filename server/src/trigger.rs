//! Optional serial link to the pico trigger board. Lines from the board that
//! start with "TRIG" fire the capture trigger; every line is forwarded to the UI.

use crate::camera::{Cmd, Event};
use anyhow::{Context, Result};
use serde::Serialize;
use std::sync::mpsc::Sender as CamSender;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, mpsc};
use tokio_serial::{SerialPortBuilderExt, SerialPortType};

pub const BAUD: u32 = 115_200;
/// Product string the firmware reports, used to find the board without a flag.
pub const PRODUCT_TAG: &str = "hfcv";

#[derive(Clone, Debug, Serialize)]
pub struct PortInfo {
    pub path: String,
    pub description: String,
    pub likely: bool,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct TriggerState {
    pub connected: bool,
    pub port: Option<String>,
    pub last_lines: Vec<String>,
    pub error: Option<String>,
}

pub enum TriggerCmd {
    Connect(String),
    Disconnect,
    Send(String),
}

struct Ctx {
    cam_tx: CamSender<Cmd>,
    events: broadcast::Sender<Event>,
    state: Arc<Mutex<TriggerState>>,
}

impl Ctx {
    fn set_disconnected(&self, error: Option<String>) {
        let mut s = self.state.lock().unwrap();
        s.connected = false;
        s.port = None;
        s.error = error;
        let _ = self.events.send(Event::TriggerState { connected: false, port: None });
    }
}

pub struct TriggerLink {
    pub tx: mpsc::Sender<TriggerCmd>,
    pub state: Arc<Mutex<TriggerState>>,
}

pub fn list_ports() -> Vec<PortInfo> {
    let mut out = Vec::new();
    if let Ok(ports) = tokio_serial::available_ports() {
        for p in ports {
            let SerialPortType::UsbPort(u) = &p.port_type else {
                continue;
            };
            let description = format!(
                "{} {} ({:04x}:{:04x})",
                u.manufacturer.clone().unwrap_or_default(),
                u.product.clone().unwrap_or_default(),
                u.vid,
                u.pid
            );
            let likely = u
                .product
                .as_deref()
                .map(|s| s.to_lowercase().contains(PRODUCT_TAG))
                .unwrap_or(false);
            out.push(PortInfo { path: p.port_name, description: description.trim().to_string(), likely });
        }
    }
    out
}

pub fn spawn(cam_tx: CamSender<Cmd>, events: broadcast::Sender<Event>) -> TriggerLink {
    let (tx, mut rx) = mpsc::channel::<TriggerCmd>(16);
    let state = Arc::new(Mutex::new(TriggerState::default()));
    let ctx = Arc::new(Ctx { cam_tx, events, state: state.clone() });
    tokio::spawn(async move {
        let mut writer: Option<mpsc::Sender<String>> = None;
        let mut reader_task: Option<tokio::task::JoinHandle<()>> = None;
        while let Some(cmd) = rx.recv().await {
            match cmd {
                TriggerCmd::Connect(path) => {
                    if let Some(t) = reader_task.take() {
                        t.abort();
                    }
                    writer = None;
                    match open(&path, ctx.clone()).await {
                        Ok((wtx, task)) => {
                            writer = Some(wtx);
                            reader_task = Some(task);
                        }
                        Err(e) => ctx.set_disconnected(Some(format!("{e:#}"))),
                    }
                }
                TriggerCmd::Disconnect => {
                    if let Some(t) = reader_task.take() {
                        t.abort();
                    }
                    writer = None;
                    ctx.set_disconnected(None);
                }
                TriggerCmd::Send(line) => {
                    if let Some(w) = &writer {
                        let _ = w.send(line).await;
                    }
                }
            }
        }
    });
    TriggerLink { tx, state }
}

async fn open(path: &str, ctx: Arc<Ctx>) -> Result<(mpsc::Sender<String>, tokio::task::JoinHandle<()>)> {
    let port = tokio_serial::new(path, BAUD)
        .open_native_async()
        .with_context(|| format!("open {path}"))?;
    let (rd, mut wr) = tokio::io::split(port);
    let (wtx, mut wrx) = mpsc::channel::<String>(32);
    {
        let mut s = ctx.state.lock().unwrap();
        s.connected = true;
        s.port = Some(path.to_string());
        s.error = None;
        s.last_lines.clear();
    }
    let _ = ctx.events.send(Event::TriggerState { connected: true, port: Some(path.to_string()) });
    let path_owned = path.to_string();
    let task = tokio::spawn(async move {
        let mut lines = BufReader::new(rd).lines();
        loop {
            tokio::select! {
                line = lines.next_line() => {
                    match line {
                        Ok(Some(line)) => {
                            let line = line.trim().to_string();
                            if line.is_empty() { continue; }
                            if line.starts_with("TRIG") {
                                let _ = ctx.cam_tx.send(Cmd::Trigger);
                            }
                            {
                                let mut s = ctx.state.lock().unwrap();
                                s.last_lines.push(line.clone());
                                if s.last_lines.len() > 50 { s.last_lines.remove(0); }
                            }
                            let _ = ctx.events.send(Event::TriggerLine { line });
                        }
                        Ok(None) | Err(_) => break,
                    }
                }
                out = wrx.recv() => {
                    match out {
                        Some(mut text) => {
                            if !text.ends_with('\n') { text.push('\n'); }
                            if wr.write_all(text.as_bytes()).await.is_err() { break; }
                        }
                        None => break,
                    }
                }
            }
        }
        ctx.set_disconnected(Some(format!("{path_owned} closed")));
    });
    Ok((wtx, task))
}
