use serde::Deserialize;

#[derive(Debug, Deserialize, PartialEq)]
pub struct NotifyMsg {
    pub title: String,
    pub body: String,
    pub url: String,
    #[serde(default)]
    pub kind: String,
}

pub const NOTIFY_PREFIX: &str = "ORC_NOTIFY ";

/// Parses one stdout line from the daemon bridge. Anything else (pino logs) is ignored.
pub fn parse_notify_line(line: &str) -> Option<NotifyMsg> {
    let json = line.trim().strip_prefix(NOTIFY_PREFIX)?;
    serde_json::from_str(json).ok()
}

pub fn count_waiting(live: &serde_json::Value) -> usize {
    live.as_array()
        .map(|rows| {
            rows.iter()
                .filter(|s| s.pointer("/live/status").and_then(|v| v.as_str()) == Some("waiting"))
                .count()
        })
        .unwrap_or(0)
}

/// `UsageSnapshot.block.pctOfLimit` is a fraction (1.0 = 100%).
pub fn block_pct(usage: &serde_json::Value) -> Option<f64> {
    usage.pointer("/block/pctOfLimit").and_then(|v| v.as_f64())
}

pub fn tray_title(waiting: Option<usize>, pct: Option<f64>) -> String {
    match (waiting, pct) {
        (None, _) => "–".to_string(),
        (Some(w), Some(p)) => format!("{w}⏳ {}%", (p * 100.0).round() as i64),
        (Some(w), None) => format!("{w}⏳"),
    }
}

pub fn tray_tooltip(waiting: Option<usize>, pct: Option<f64>) -> String {
    match (waiting, pct) {
        (None, _) => "Orchestrator: daemon not reachable".to_string(),
        (Some(w), Some(p)) => format!("Orchestrator: {w} waiting · 5-hour block {}%", (p * 100.0).round() as i64),
        (Some(w), None) => format!("Orchestrator: {w} waiting"),
    }
}

/// Script that hands dropped paths to the page. `x`/`y` are CSS pixels from the window's top-left.
pub fn drop_paths_script(paths: &[String], x: f64, y: f64) -> String {
    let detail = serde_json::json!({ "paths": paths, "x": x, "y": y });
    format!("window.dispatchEvent(new CustomEvent('orc:drop-paths', {{ detail: {detail} }}));")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_only_bridge_lines() {
        let line = r#"ORC_NOTIFY {"title":"Waiting · SAF-1787","body":"waiting for input","url":"http://127.0.0.1:4317/sessions/claude/s1","kind":"waiting"}"#;
        let msg = parse_notify_line(line).expect("parsed");
        assert_eq!(msg.title, "Waiting · SAF-1787");
        assert_eq!(msg.kind, "waiting");
        assert!(parse_notify_line(r#"{"level":30,"msg":"indexed"}"#).is_none());
        assert!(parse_notify_line("ORC_NOTIFY not json").is_none());
    }

    #[test]
    fn counts_waiting_sessions() {
        let live = json!([
            { "live": { "status": "waiting" } },
            { "live": { "status": "busy" } },
            { "live": null },
            { "live": { "status": "waiting" } }
        ]);
        assert_eq!(count_waiting(&live), 2);
        assert_eq!(count_waiting(&json!({})), 0);
    }

    #[test]
    fn builds_the_drop_script() {
        let script = drop_paths_script(&["/Users/me/My \"Repo\"".to_string()], 10.5, 20.0);
        assert_eq!(
            script,
            r#"window.dispatchEvent(new CustomEvent('orc:drop-paths', { detail: {"paths":["/Users/me/My \"Repo\""],"x":10.5,"y":20.0} }));"#
        );
    }

    #[test]
    fn formats_the_tray() {
        assert_eq!(block_pct(&json!({ "block": { "pctOfLimit": 0.42 } })), Some(0.42));
        assert_eq!(block_pct(&json!({ "block": {} })), None);
        assert_eq!(tray_title(Some(3), Some(0.42)), "3⏳ 42%");
        assert_eq!(tray_title(Some(0), None), "0⏳");
        assert_eq!(tray_title(None, Some(0.5)), "–");
        assert_eq!(tray_tooltip(Some(1), Some(0.5)), "Orchestrator: 1 waiting · 5-hour block 50%");
        assert_eq!(tray_tooltip(None, None), "Orchestrator: daemon not reachable");
    }
}
