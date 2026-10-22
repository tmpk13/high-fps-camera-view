//! In-memory recording model plus on-disk save/load.

use anyhow::{Context, Result};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One captured frame, already JPEG encoded.
#[derive(Clone, Debug)]
pub struct Frame {
    /// Driver sequence number, used to detect dropped frames.
    pub seq: u32,
    /// Driver timestamp in microseconds (monotonic clock).
    pub ts_us: i64,
    pub data: Bytes,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Marker {
    pub id: u32,
    pub name: String,
    pub frame: usize,
    pub color: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecordingMeta {
    pub id: String,
    pub created: String,
    pub width: u32,
    pub height: u32,
    pub fourcc: String,
    pub fps_nominal: f64,
    /// Rate derived from the first and last driver timestamps.
    pub fps_measured: f64,
    pub frame_count: usize,
    /// Index of the frame captured right after the trigger, if armed capture was used.
    pub trigger_frame: Option<usize>,
    /// Timestamps relative to the first frame, microseconds.
    pub timestamps_us: Vec<i64>,
    pub sequences: Vec<u32>,
    pub dropped: u32,
    pub markers: Vec<Marker>,
    /// Non-empty when the capture ended earlier than requested.
    pub note: String,
    /// Directory name when the recording has been saved to disk.
    pub saved_as: Option<String>,
}

#[derive(Debug)]
pub struct Recording {
    pub meta: RecordingMeta,
    pub frames: Vec<Frame>,
}

impl Recording {
    pub fn new(
        id: String,
        width: u32,
        height: u32,
        fourcc: String,
        fps_nominal: f64,
        frames: Vec<Frame>,
        trigger_frame: Option<usize>,
        note: String,
    ) -> Self {
        let t0 = frames.first().map(|f| f.ts_us).unwrap_or(0);
        let timestamps_us: Vec<i64> = frames.iter().map(|f| f.ts_us - t0).collect();
        let fps_measured = match timestamps_us.last() {
            Some(&last) if last > 0 && frames.len() > 1 => (frames.len() - 1) as f64 * 1e6 / last as f64,
            _ => fps_nominal,
        };
        let sequences: Vec<u32> = frames.iter().map(|f| f.seq).collect();
        let dropped = count_dropped(&sequences);
        let meta = RecordingMeta {
            id,
            created: chrono::Local::now().to_rfc3339(),
            width,
            height,
            fourcc,
            fps_nominal,
            fps_measured,
            frame_count: frames.len(),
            trigger_frame,
            timestamps_us,
            sequences,
            dropped,
            markers: Vec::new(),
            note,
            saved_as: None,
        };
        Recording { meta, frames }
    }

    pub fn frame(&self, i: usize) -> Option<Bytes> {
        self.frames.get(i).map(|f| f.data.clone())
    }

    /// Write index.json and frames/NNNNNN.jpg under `dir`.
    pub fn save(&mut self, dir: &Path) -> Result<()> {
        let frames_dir = dir.join("frames");
        std::fs::create_dir_all(&frames_dir).context("create frames dir")?;
        for (i, f) in self.frames.iter().enumerate() {
            std::fs::write(frames_dir.join(format!("{i:06}.jpg")), &f.data)?;
        }
        self.meta.saved_as = dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string());
        let json = serde_json::to_vec_pretty(&self.meta)?;
        std::fs::write(dir.join("index.json"), json)?;
        Ok(())
    }

    pub fn load(dir: &Path) -> Result<Self> {
        let json = std::fs::read(dir.join("index.json")).context("read index.json")?;
        let mut meta: RecordingMeta = serde_json::from_slice(&json).context("parse index.json")?;
        let mut frames = Vec::with_capacity(meta.frame_count);
        for i in 0..meta.frame_count {
            let data = std::fs::read(dir.join("frames").join(format!("{i:06}.jpg")))
                .with_context(|| format!("read frame {i}"))?;
            frames.push(Frame {
                seq: meta.sequences.get(i).copied().unwrap_or(i as u32),
                ts_us: meta.timestamps_us.get(i).copied().unwrap_or(0),
                data: Bytes::from(data),
            });
        }
        meta.saved_as = dir.file_name().map(|n| n.to_string_lossy().to_string());
        Ok(Recording { meta, frames })
    }
}

pub fn count_dropped(seqs: &[u32]) -> u32 {
    seqs.windows(2)
        .map(|w| w[1].wrapping_sub(w[0]).saturating_sub(1))
        .sum()
}

/// Summary of a saved recording for listings.
#[derive(Clone, Debug, Serialize)]
pub struct SavedSummary {
    pub name: String,
    pub created: String,
    pub frame_count: usize,
    pub fps_nominal: f64,
    pub width: u32,
    pub height: u32,
    pub markers: usize,
    pub exports: Vec<String>,
}

pub fn list_saved(root: &Path) -> Vec<SavedSummary> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else {
        return out;
    };
    for entry in rd.flatten() {
        let dir = entry.path();
        let Ok(json) = std::fs::read(dir.join("index.json")) else {
            continue;
        };
        let Ok(meta) = serde_json::from_slice::<RecordingMeta>(&json) else {
            continue;
        };
        let exports = std::fs::read_dir(&dir)
            .map(|rd| {
                rd.flatten()
                    .filter_map(|e| {
                        let n = e.file_name().to_string_lossy().to_string();
                        n.ends_with(".mp4").then_some(n)
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.push(SavedSummary {
            name: entry.file_name().to_string_lossy().to_string(),
            created: meta.created,
            frame_count: meta.frame_count,
            fps_nominal: meta.fps_nominal,
            width: meta.width,
            height: meta.height,
            markers: meta.markers.len(),
            exports,
        });
    }
    out.sort_by(|a, b| b.created.cmp(&a.created));
    out
}

/// Reject names that could escape the recordings directory.
pub fn safe_name(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return None;
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        || trimmed.starts_with('.')
    {
        return None;
    }
    Some(trimmed.to_string())
}

pub fn recording_dir(root: &Path, name: &str) -> PathBuf {
    root.join(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropped_counts_gaps() {
        assert_eq!(count_dropped(&[1, 2, 3]), 0);
        assert_eq!(count_dropped(&[1, 3, 4, 8]), 4);
        assert_eq!(count_dropped(&[]), 0);
    }

    #[test]
    fn names_are_filtered() {
        assert!(safe_name("rec-1").is_some());
        assert!(safe_name("../x").is_none());
        assert!(safe_name("a/b").is_none());
        assert!(safe_name(".hidden").is_none());
        assert!(safe_name("").is_none());
    }

    #[test]
    fn save_and_load_round_trip() {
        let tmp = std::env::temp_dir().join(format!("hfcv-test-{}", std::process::id()));
        let frames = vec![
            Frame { seq: 5, ts_us: 1000, data: Bytes::from_static(b"a") },
            Frame { seq: 7, ts_us: 1010, data: Bytes::from_static(b"b") },
        ];
        let mut rec = Recording::new("r".into(), 2, 2, "MJPG".into(), 100.0, frames, Some(1), String::new());
        rec.meta.markers.push(Marker { id: 1, name: "m".into(), frame: 1, color: "#000".into() });
        rec.save(&tmp).unwrap();
        let back = Recording::load(&tmp).unwrap();
        assert_eq!(back.meta.frame_count, 2);
        assert_eq!(back.meta.timestamps_us, vec![0, 10]);
        assert_eq!(back.meta.dropped, 1);
        assert_eq!(back.meta.markers, rec.meta.markers);
        assert_eq!(back.frames[1].data.as_ref(), b"b");
        std::fs::remove_dir_all(&tmp).unwrap();
    }
}
