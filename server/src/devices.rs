//! Enumeration of V4L2 capture nodes, used for the device picker and for
//! finding a camera again after it re-enumerates under a new path.

use serde::Serialize;
use v4l::video::Capture as _;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct DeviceInfo {
    pub path: String,
    pub card: String,
    pub driver: String,
}

/// Video nodes that offer at least one capture format, sorted by path.
pub fn list_devices() -> Vec<DeviceInfo> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir("/dev") else {
        return out;
    };
    let mut paths: Vec<String> = rd
        .flatten()
        .map(|e| e.path().to_string_lossy().to_string())
        .filter(|p| p.starts_with("/dev/video"))
        .collect();
    paths.sort_by_key(|p| p.trim_start_matches("/dev/video").parse::<u32>().unwrap_or(u32::MAX));
    for path in paths {
        let Ok(dev) = v4l::Device::with_path(&path) else {
            continue;
        };
        let Ok(caps) = dev.query_caps() else {
            continue;
        };
        // Metadata nodes share the device capability bits, so check for real formats.
        let has_formats = dev.enum_formats().map(|f| !f.is_empty()).unwrap_or(false);
        if !has_formats {
            continue;
        }
        out.push(DeviceInfo { path, card: caps.card, driver: caps.driver });
    }
    out
}

/// Path of the device whose card name matches, preferring the given path when it still matches.
pub fn find_by_card<'a>(devices: &'a [DeviceInfo], card: &str, preferred: &str) -> Option<&'a str> {
    if let Some(d) = devices.iter().find(|d| d.path == preferred && d.card == card) {
        return Some(&d.path);
    }
    devices.iter().find(|d| d.card == card).map(|d| d.path.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(path: &str, card: &str) -> DeviceInfo {
        DeviceInfo { path: path.into(), card: card.into(), driver: "uvcvideo".into() }
    }

    #[test]
    fn prefers_same_path_then_same_card() {
        let list = vec![d("/dev/video0", "Integrated"), d("/dev/video3", "Arducam"), d("/dev/video5", "Arducam")];
        assert_eq!(find_by_card(&list, "Arducam", "/dev/video5"), Some("/dev/video5"));
        assert_eq!(find_by_card(&list, "Arducam", "/dev/video2"), Some("/dev/video3"));
        assert_eq!(find_by_card(&list, "Other", "/dev/video2"), None);
    }
}
