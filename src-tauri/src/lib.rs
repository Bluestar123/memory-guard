use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use sysinfo::{MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, Signal, System};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, State,
};
use tauri_plugin_notification::{NotificationExt, PermissionState};

const MEMORY_UPDATED_EVENT: &str = "memory-summary-updated";
const PANEL_VISIBILITY_EVENT: &str = "panel-visibility-changed";
const PANEL_TAB_EVENT: &str = "panel-tab-requested";
const PANEL_TOP_APPS_LIMIT: usize = 10;
const DEFAULT_THRESHOLD_PERCENT: u8 = 90;
const DEFAULT_REFRESH_INTERVAL_SECS: u64 = 2;
const DEFAULT_COOLDOWN_SECS: u64 = 5 * 60;
const DEFAULT_TOP_APPS_LIMIT: usize = 10;
const SETTINGS_FILE_NAME: &str = "settings.json";
const CRITICAL_PROCESS_NAMES: &[&str] = &[
    "kernel_task",
    "launchd",
    "WindowServer",
    "loginwindow",
    "sysmond",
    "notifyd",
    "configd",
    "powerd",
    "securityd",
    "runningboardd",
    "opendirectoryd",
    "mDNSResponder",
];

#[derive(Clone, serde::Serialize)]
struct MemorySnapshot {
    percentage: u8,
    used_bytes: u64,
    total_bytes: u64,
    used_label: String,
    total_label: String,
    updated_at_ms: u64,
}

#[derive(Clone, serde::Serialize)]
struct SelfMemorySummary {
    memory_bytes: u64,
    memory_label: String,
}

#[derive(Clone, serde::Serialize)]
struct AppMemorySummary {
    pid: u32,
    name: String,
    display_name: String,
    memory_label: String,
    can_quit: bool,
    protection_reason: Option<String>,
    recommendation: String,
    kind: String,
    renderer_count: Option<usize>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
struct AlertSettings {
    threshold_percent: u8,
    refresh_interval_secs: u64,
    cooldown_secs: u64,
    top_apps_limit: usize,
    language: String,
}

#[derive(serde::Deserialize)]
struct AlertSettingsInput {
    threshold_percent: u8,
    refresh_interval_secs: u64,
    cooldown_secs: u64,
    top_apps_limit: usize,
    language: String,
}

#[derive(serde::Deserialize)]
struct TerminateProcessInput {
    pid: u32,
    force: bool,
}

#[derive(serde::Serialize)]
struct TerminateProcessResult {
    pid: u32,
    signal: String,
}

#[derive(serde::Serialize)]
struct NotificationPermissionResult {
    permission: String,
    error: Option<String>,
}

struct AlertRuntime {
    was_over_threshold: bool,
    last_notification_at: Option<Instant>,
}

struct AppState {
    latest_memory: Arc<Mutex<MemorySnapshot>>,
    alert_settings: Arc<Mutex<AlertSettings>>,
    alert_runtime: Arc<Mutex<AlertRuntime>>,
    panel_open: Arc<Mutex<bool>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            latest_memory: Arc::new(Mutex::new(MemorySnapshot::empty())),
            alert_settings: Arc::new(Mutex::new(AlertSettings::default())),
            alert_runtime: Arc::new(Mutex::new(AlertRuntime::new())),
            panel_open: Arc::new(Mutex::new(false)),
        }
    }
}

impl Default for AlertSettings {
    fn default() -> Self {
        Self {
            threshold_percent: DEFAULT_THRESHOLD_PERCENT,
            refresh_interval_secs: DEFAULT_REFRESH_INTERVAL_SECS,
            cooldown_secs: DEFAULT_COOLDOWN_SECS,
            top_apps_limit: DEFAULT_TOP_APPS_LIMIT,
            language: "zh".to_string(),
        }
    }
}

impl AlertRuntime {
    fn new() -> Self {
        Self {
            was_over_threshold: false,
            last_notification_at: None,
        }
    }
}

impl MemorySnapshot {
    fn empty() -> Self {
        Self {
            percentage: 0,
            used_bytes: 0,
            total_bytes: 0,
            used_label: "Waiting".to_string(),
            total_label: "Waiting".to_string(),
            updated_at_ms: 0,
        }
    }
}

impl SelfMemorySummary {
    fn empty() -> Self {
        Self {
            memory_bytes: 0,
            memory_label: "Unavailable".to_string(),
        }
    }
}

#[tauri::command]
fn latest_memory_summary(state: State<'_, AppState>) -> MemorySnapshot {
    state
        .latest_memory
        .lock()
        .map(|snapshot| snapshot.clone())
        .unwrap_or_else(|_| MemorySnapshot::empty())
}

#[tauri::command]
fn self_memory_summary() -> SelfMemorySummary {
    let pid = Pid::from_u32(std::process::id());
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_memory(),
    );

    system
        .process(pid)
        .map(|process| SelfMemorySummary {
            memory_bytes: process.memory(),
            memory_label: format_bytes(process.memory()),
        })
        .unwrap_or_else(SelfMemorySummary::empty)
}

#[tauri::command]
fn alert_settings(state: State<'_, AppState>) -> AlertSettings {
    state
        .alert_settings
        .lock()
        .map(|settings| settings.clone())
        .unwrap_or_default()
}

#[tauri::command]
fn update_alert_settings(
    input: AlertSettingsInput,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AlertSettings, String> {
    if !(1..=100).contains(&input.threshold_percent) {
        return Err("Threshold must be between 1 and 100.".to_string());
    }

    if !(1..=60).contains(&input.refresh_interval_secs) {
        return Err("Refresh interval must be between 1 and 60 seconds.".to_string());
    }

    if input.cooldown_secs < 30 {
        return Err("Cooldown must be at least 30 seconds.".to_string());
    }

    if !(3..=20).contains(&input.top_apps_limit) {
        return Err("Top apps count must be between 3 and 20.".to_string());
    }

    if input.language != "zh" && input.language != "en" {
        return Err("Language must be zh or en.".to_string());
    }

    let updated = AlertSettings {
        threshold_percent: input.threshold_percent,
        refresh_interval_secs: input.refresh_interval_secs,
        cooldown_secs: input.cooldown_secs,
        top_apps_limit: input.top_apps_limit,
        language: input.language,
    };

    save_alert_settings(&app_handle, &updated)?;

    let mut settings = state
        .alert_settings
        .lock()
        .map_err(|_| "Alert settings are temporarily unavailable.".to_string())?;
    *settings = updated.clone();
    drop(settings);

    let latest_snapshot = state
        .latest_memory
        .lock()
        .map(|snapshot| snapshot.clone())
        .unwrap_or_else(|_| MemorySnapshot::empty());

    if latest_snapshot.percentage >= updated.threshold_percent {
        if let Ok(mut runtime) = state.alert_runtime.lock() {
            runtime.was_over_threshold = false;
            if should_attempt_threshold_alert(&latest_snapshot, &updated, &mut runtime) {
                if send_threshold_notification(&app_handle, &latest_snapshot, &updated) {
                    mark_threshold_notification_sent(&mut runtime);
                }
            }
        }
    }

    Ok(updated)
}

#[tauri::command]
fn notification_permission_state(app_handle: tauri::AppHandle) -> String {
    current_notification_permission(&app_handle).to_string()
}

#[tauri::command]
fn notification_delivery_target() -> String {
    if cfg!(target_os = "macos") && tauri::is_dev() {
        "terminal".to_string()
    } else {
        "app".to_string()
    }
}

fn settings_file_path<R: tauri::Runtime, M: Manager<R>>(manager: &M) -> Result<PathBuf, String> {
    manager
        .path()
        .app_config_dir()
        .map(|dir| dir.join(SETTINGS_FILE_NAME))
        .map_err(|error| format!("Could not find the app config directory: {error}"))
}

fn load_alert_settings(app: &tauri::App) -> AlertSettings {
    let Ok(path) = settings_file_path(app) else {
        return AlertSettings::default();
    };

    let Ok(contents) = fs::read_to_string(path) else {
        return AlertSettings::default();
    };

    serde_json::from_str::<AlertSettings>(&contents)
        .ok()
        .filter(is_valid_alert_settings)
        .unwrap_or_default()
}

fn save_alert_settings(
    app_handle: &tauri::AppHandle,
    settings: &AlertSettings,
) -> Result<(), String> {
    let path = settings_file_path(app_handle)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Could not find the settings directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the settings directory: {error}"))?;

    let contents = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Could not encode settings: {error}"))?;
    fs::write(path, contents).map_err(|error| format!("Could not save settings: {error}"))
}

fn is_valid_alert_settings(settings: &AlertSettings) -> bool {
    (1..=100).contains(&settings.threshold_percent)
        && (1..=60).contains(&settings.refresh_interval_secs)
        && settings.cooldown_secs >= 30
        && (3..=20).contains(&settings.top_apps_limit)
        && (settings.language == "zh" || settings.language == "en")
}

#[tauri::command]
fn request_notification_permission(app_handle: tauri::AppHandle) -> NotificationPermissionResult {
    let permission = ensure_notification_permission(&app_handle);
    NotificationPermissionResult {
        permission: permission.to_string(),
        error: None,
    }
}

#[tauri::command]
fn open_notification_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.notifications")
            .status()
            .map_err(|error| format!("Could not open System Settings: {error}"))
            .and_then(|status| {
                if status.success() {
                    Ok(())
                } else {
                    Err("Could not open System Settings.".to_string())
                }
            })?;
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Opening notification settings is only supported on macOS.".to_string())
    }
}

#[tauri::command]
fn is_panel_open(state: State<'_, AppState>) -> bool {
    state
        .panel_open
        .lock()
        .map(|is_open| *is_open)
        .unwrap_or(false)
}

#[tauri::command]
fn top_apps(state: State<'_, AppState>) -> Vec<AppMemorySummary> {
    let limit = state
        .alert_settings
        .lock()
        .map(|settings| settings.top_apps_limit)
        .unwrap_or(PANEL_TOP_APPS_LIMIT);

    scan_top_memory_apps(limit)
}

#[tauri::command]
fn terminate_app(input: TerminateProcessInput) -> Result<TerminateProcessResult, String> {
    let pid = Pid::from_u32(input.pid);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_memory(),
    );

    let process = system
        .process(pid)
        .ok_or_else(|| "That app is no longer running.".to_string())?;
    let name = process.name().to_string_lossy().into_owned();

    if let Some(reason) = process_protection_reason(input.pid, &name) {
        return Err(reason);
    }

    let signal = if input.force {
        Signal::Kill
    } else {
        Signal::Term
    };

    match process.kill_with(signal) {
        Some(true) => Ok(TerminateProcessResult {
            pid: input.pid,
            signal: if input.force {
                "SIGKILL".to_string()
            } else {
                "SIGTERM".to_string()
            },
        }),
        Some(false) => Err(format!("Could not quit {name}.")),
        None => Err("This termination signal is not supported on this system.".to_string()),
    }
}

fn set_panel_open(app: &tauri::AppHandle, is_open: bool) {
    let state = app.state::<AppState>();
    if let Ok(mut panel_open) = state.panel_open.lock() {
        *panel_open = is_open;
    }

    let _ = app.emit(PANEL_VISIBILITY_EVENT, is_open);
}

fn show_panel(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        set_panel_open(app, true);
    }
}

fn show_panel_tab(app: &tauri::AppHandle, tab: &str) {
    show_panel(app);
    let _ = app.emit(PANEL_TAB_EVENT, tab);
}

fn configure_tray(app: &tauri::App) -> tauri::Result<TrayIcon> {
    let show = MenuItem::with_id(app, "show", "Overview", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &settings, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .title("MEM --")
        .tooltip("Memory Guard: waiting for memory data")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_panel_tab(app, "overview"),
            "settings" => show_panel_tab(app, "settings"),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_panel_tab(tray.app_handle(), "overview");
            }
        })
        .build(app)
}

fn collect_memory_snapshot(system: &mut System) -> MemorySnapshot {
    system.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());

    let total_bytes = system.total_memory();
    let used_bytes = system.used_memory();
    let percentage = if total_bytes == 0 {
        0
    } else {
        ((used_bytes as f64 / total_bytes as f64) * 100.0).round() as u8
    };

    MemorySnapshot {
        percentage,
        used_bytes,
        total_bytes,
        used_label: format_bytes(used_bytes),
        total_label: format_bytes(total_bytes),
        updated_at_ms: now_ms(),
    }
}

fn scan_top_memory_apps(limit: usize) -> Vec<AppMemorySummary> {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory(),
    );

    let mut apps = Vec::new();
    let mut chrome_total_memory = 0;
    let mut chrome_renderer_count = 0;

    for process in system.processes().values() {
        if process.memory() == 0 {
            continue;
        }

        let name = process.name().to_string_lossy().into_owned();
        if is_chrome_process(&name) {
            chrome_total_memory += process.memory();
            if is_chrome_renderer_process(&name) {
                chrome_renderer_count += 1;
            }
            continue;
        }

        let pid = process.pid().as_u32();
        let protection_reason = process_protection_reason(pid, &name);
        let display_name = friendly_process_name(&name);
        let recommendation = process_recommendation(&name, protection_reason.as_deref());

        apps.push((
            process.memory(),
            AppMemorySummary {
                pid,
                name,
                display_name,
                memory_label: format_bytes(process.memory()),
                can_quit: protection_reason.is_none(),
                protection_reason,
                recommendation,
                kind: "process".to_string(),
                renderer_count: None,
            },
        ));
    }

    if chrome_total_memory > 0 {
        apps.push((
            chrome_total_memory,
            AppMemorySummary {
                pid: 0,
                name: "Google Chrome".to_string(),
                display_name: "Google Chrome".to_string(),
                memory_label: format_bytes(chrome_total_memory),
                can_quit: false,
                protection_reason: Some(
                    "Close unused Chrome tabs first. Renderer processes are not quit directly."
                        .to_string(),
                ),
                recommendation:
                    "Close unused Chrome tabs first instead of quitting renderer processes."
                        .to_string(),
                kind: "chrome_group".to_string(),
                renderer_count: Some(chrome_renderer_count),
            },
        ));
    }

    apps.sort_by(|left, right| right.0.cmp(&left.0));
    apps.truncate(limit);
    apps.into_iter().map(|(_, app)| app).collect()
}

fn is_chrome_process(name: &str) -> bool {
    name == "Google Chrome" || is_chrome_renderer_process(name)
}

fn is_chrome_renderer_process(name: &str) -> bool {
    name.contains("Google Chrome Helper") || name.contains("Chrome Helper")
}

fn friendly_process_name(name: &str) -> String {
    if is_chrome_renderer_process(name) {
        return "Google Chrome renderer".to_string();
    }

    if name.contains("WebKit.WebContent") {
        return "Safari web page".to_string();
    }

    if name.contains("Electron") {
        return "Electron app helper".to_string();
    }

    if name.contains('.') {
        return name
            .split('.')
            .next_back()
            .unwrap_or(name)
            .replace('-', " ");
    }

    name.to_string()
}

fn process_recommendation(name: &str, protection_reason: Option<&str>) -> String {
    if let Some(reason) = protection_reason {
        return reason.to_string();
    }

    if name.contains("Google Chrome Helper")
        || name.contains("Chrome Helper")
        || name.contains("WebKit.WebContent")
    {
        return "Close unused browser tabs first. Quit only if memory stays high.".to_string();
    }

    if name == "Google Chrome" || name == "Safari" || name == "Firefox" {
        return "Try closing unused windows or restart the browser.".to_string();
    }

    "Safe to quit if you are not actively using it.".to_string()
}

fn process_protection_reason(pid: u32, name: &str) -> Option<String> {
    if pid == std::process::id() {
        return Some("Memory Guard cannot quit itself.".to_string());
    }

    if CRITICAL_PROCESS_NAMES
        .iter()
        .any(|protected_name| protected_name.eq_ignore_ascii_case(name))
    {
        return Some("This looks like a critical system process.".to_string());
    }

    None
}

fn format_bytes(bytes: u64) -> String {
    const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MIB: f64 = 1024.0 * 1024.0;

    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.1} GB", bytes as f64 / GIB)
    } else {
        format!("{:.0} MB", bytes as f64 / MIB)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn should_attempt_threshold_alert(
    snapshot: &MemorySnapshot,
    settings: &AlertSettings,
    runtime: &mut AlertRuntime,
) -> bool {
    let is_over_threshold = snapshot.percentage >= settings.threshold_percent;
    let crossed_threshold = is_over_threshold && !runtime.was_over_threshold;
    runtime.was_over_threshold = is_over_threshold;

    if !crossed_threshold {
        return false;
    }

    let cooldown = Duration::from_secs(settings.cooldown_secs);
    let is_cooled_down = runtime
        .last_notification_at
        .map(|last| last.elapsed() >= cooldown)
        .unwrap_or(true);

    is_cooled_down
}

fn mark_threshold_notification_sent(runtime: &mut AlertRuntime) {
    runtime.last_notification_at = Some(Instant::now());
}

fn current_notification_permission(app_handle: &tauri::AppHandle) -> PermissionState {
    app_handle
        .notification()
        .permission_state()
        .unwrap_or(PermissionState::Denied)
}

fn ensure_notification_permission(app_handle: &tauri::AppHandle) -> PermissionState {
    let permission = current_notification_permission(app_handle);

    if matches!(
        permission,
        PermissionState::Prompt | PermissionState::PromptWithRationale
    ) {
        app_handle
            .notification()
            .request_permission()
            .unwrap_or(PermissionState::Denied)
    } else {
        permission
    }
}

fn send_threshold_notification(
    app_handle: &tauri::AppHandle,
    snapshot: &MemorySnapshot,
    settings: &AlertSettings,
) -> bool {
    let (title, body) = if settings.language == "zh" {
        (
            "内存占用过高".to_string(),
            format!(
                "当前内存已达 {}%，超过你设置的 {}% 阈值。请打开面板查看详情并处理。",
                snapshot.percentage, settings.threshold_percent
            ),
        )
    } else {
        (
            "Memory usage is high".to_string(),
            format!(
                "Memory is at {}%, above your {}% threshold. Open the panel to review details and take action.",
                snapshot.percentage, settings.threshold_percent
            ),
        )
    };

    let permission = ensure_notification_permission(app_handle);

    if matches!(permission, PermissionState::Granted) {
        app_handle
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .is_ok()
    } else {
        false
    }
}

fn start_memory_monitor(
    app_handle: tauri::AppHandle,
    tray: TrayIcon,
    latest_memory: Arc<Mutex<MemorySnapshot>>,
    alert_settings: Arc<Mutex<AlertSettings>>,
    alert_runtime: Arc<Mutex<AlertRuntime>>,
) {
    thread::Builder::new()
        .name("memory-monitor".to_string())
        .spawn(move || {
            let mut system = System::new();

            loop {
                let snapshot = collect_memory_snapshot(&mut system);
                let settings = alert_settings
                    .lock()
                    .map(|settings| settings.clone())
                    .unwrap_or_default();
                let title = format!("MEM {}%", snapshot.percentage);
                let tooltip = format!(
                    "Memory Guard: {} used of {}",
                    snapshot.used_label, snapshot.total_label
                );

                if let Ok(mut latest) = latest_memory.lock() {
                    *latest = snapshot.clone();
                }

                let _ = tray.set_title(Some(title));
                let _ = tray.set_tooltip(Some(tooltip));
                let _ = app_handle.emit(MEMORY_UPDATED_EVENT, snapshot.clone());

                if let Ok(mut runtime) = alert_runtime.lock() {
                    if should_attempt_threshold_alert(&snapshot, &settings, &mut runtime) {
                        if send_threshold_notification(&app_handle, &snapshot, &settings) {
                            mark_threshold_notification_sent(&mut runtime);
                        }
                    }
                }

                thread::sleep(Duration::from_secs(settings.refresh_interval_secs));
            }
        })
        .expect("failed to start memory monitor thread");
}

fn configure_panel_window(app: &tauri::App) {
    if let Some(window) = app.get_webview_window("main") {
        let app_handle = app.handle().clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.hide();
                }
                set_panel_open(&app_handle, false);
            }
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            configure_panel_window(app);
            let tray = configure_tray(app)?;
            let loaded_settings = load_alert_settings(app);
            if let Ok(mut settings) = app.state::<AppState>().alert_settings.lock() {
                *settings = loaded_settings;
            }
            let latest_memory = app.state::<AppState>().latest_memory.clone();
            let alert_settings = app.state::<AppState>().alert_settings.clone();
            let alert_runtime = app.state::<AppState>().alert_runtime.clone();
            start_memory_monitor(
                app.handle().clone(),
                tray,
                latest_memory,
                alert_settings,
                alert_runtime,
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            latest_memory_summary,
            self_memory_summary,
            alert_settings,
            update_alert_settings,
            notification_permission_state,
            notification_delivery_target,
            request_notification_permission,
            open_notification_settings,
            is_panel_open,
            top_apps,
            terminate_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running Memory Guard");
}
