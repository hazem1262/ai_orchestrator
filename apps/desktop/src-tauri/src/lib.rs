pub mod bridge;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const DAEMON_URL: &str = "http://127.0.0.1:4317";

struct Sidecar(Mutex<Option<CommandChild>>);

fn orc_home() -> PathBuf {
    std::env::var_os("ORC_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = std::env::var_os("HOME").unwrap_or_default();
            PathBuf::from(home).join(".orchestrator")
        })
}

fn read_token() -> Option<String> {
    std::fs::read_to_string(orc_home().join("token")).ok().map(|s| s.trim().to_string())
}

async fn fetch_json(client: &reqwest::Client, path: &str, token: &str) -> Option<serde_json::Value> {
    client
        .get(format!("{DAEMON_URL}{path}"))
        .header("x-orc-token", token)
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .ok()?
        .json::<serde_json::Value>()
        .await
        .ok()
}

async fn daemon_healthy(client: &reqwest::Client) -> bool {
    let token = read_token().unwrap_or_default();
    fetch_json(client, "/api/health", &token).await.is_some()
}

fn show_window(app: &AppHandle, path: &str) {
    if let Some(window) = app.get_webview_window("main") {
        if path != "/" {
            let _ = window.eval(&format!("window.location.assign({path:?})"));
        }
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let Ok(url) = format!("{DAEMON_URL}{path}").parse::<tauri::Url>() else {
        return;
    };
    let token = read_token().unwrap_or_default();
    let script = format!("window.__ORC_TOKEN__ = {token:?};");
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Orchestrator")
        .inner_size(1400.0, 900.0)
        .initialization_script(&script)
        .build();
}

fn spawn_daemon(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let resources = app.path().resource_dir()?;
    let main_js = resources.join("daemon").join("dist").join("main.js");
    let web_dir = resources.join("web");
    let (mut rx, child) = app
        .shell()
        .sidecar("orc-node")?
        .args([main_js.to_string_lossy().to_string()])
        .env("ORC_NOTIFY_BRIDGE", "stdout")
        .env("ORC_WEB_DIR", web_dir.to_string_lossy().to_string())
        .spawn()?;
    if let Ok(mut slot) = app.state::<Sidecar>().0.lock() {
        *slot = Some(child);
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).to_string();
                    if let Some(msg) = bridge::parse_notify_line(&line) {
                        let _ = handle.notification().builder().title(&msg.title).body(&msg.body).show();
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("daemon: {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("daemon exited: {payload:?}");
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn build_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let open = MenuItem::with_id(app, "open", "Open Orchestrator", true, Some("CmdOrCtrl+Shift+O"))?;
    let inbox = MenuItem::with_id(app, "inbox", "Open inbox", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &inbox, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Orchestrator")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_window(app, "/"),
            "inbox" => show_window(app, "/inbox"),
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn start_tray_poller(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        loop {
            let token = read_token().unwrap_or_default();
            let waiting = fetch_json(&client, "/api/live", &token).await.map(|v| bridge::count_waiting(&v));
            let pct = fetch_json(&client, "/api/usage", &token).await.and_then(|v| bridge::block_pct(&v));
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_title(Some(bridge::tray_title(waiting, pct)));
                let _ = tray.set_tooltip(Some(bridge::tray_tooltip(waiting, pct)));
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
                let hotkey = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyO);
                let hotkey_for_handler = hotkey;
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            if shortcut == &hotkey_for_handler && event.state() == ShortcutState::Pressed {
                                show_window(app, "/");
                            }
                        })
                        .build(),
                )?;
                app.global_shortcut().register(hotkey)?;
            }

            build_tray(&handle)?;

            let boot = handle.clone();
            tauri::async_runtime::spawn(async move {
                let client = reqwest::Client::new();
                if !daemon_healthy(&client).await {
                    if let Err(err) = spawn_daemon(&boot) {
                        eprintln!("could not start the daemon sidecar: {err}");
                    }
                }
                for _ in 0..30 {
                    if daemon_healthy(&client).await {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                show_window(&boot, "/");
                start_tray_poller(boot);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Keep the daemon and the tray running; the window is only hidden.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Orchestrator app")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Ok(mut slot) = app.state::<Sidecar>().0.lock() {
                    if let Some(child) = slot.take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
