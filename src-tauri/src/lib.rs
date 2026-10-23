use std::collections::HashSet;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

mod watcher;

/// 全局共享状态。Task 7 的 command 从 `State<AppState>` 取 `self_pids`。
pub struct AppState {
    pub self_pids: Arc<Mutex<HashSet<u32>>>,
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 全局停止信号：watcher 轮询线程的生命周期开关（应用常驻，正常不置真）
    let stop = Arc::new(AtomicBool::new(false));

    tauri::Builder::default()
        // single-instance must be registered before all other plugins
        .plugin(tauri_plugin_single_instance::init(|_argv, _cwd, _event| {}))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            // 管理全局状态：Task 7 的 command 从 State 取
            app.manage(AppState {
                self_pids: Arc::new(Mutex::new(HashSet::new())),
            });

            // watcher 轮询线程：独立 std::thread，不阻塞主线程
            let claude_dir = dirs::home_dir()
                .expect("home dir must exist")
                .join(".claude");
            let app_handle = app.handle().clone();
            let poller_stop = stop.clone();
            std::thread::spawn(move || {
                watcher::run_poller(
                    &claude_dir,
                    app_handle.state::<AppState>().self_pids.clone(),
                    std::time::Duration::from_millis(2000),
                    poller_stop,
                    |event, payload| {
                        let _ = app_handle.emit(event, payload);
                    },
                );
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
