use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, RunEvent};

mod chat;
mod watcher;

/// 全局共享状态。Task 7 的 command 从 `State<AppState>` 取 `self_pids`；
/// `poller_stop` 是轮询线程的唯一停止旗标（退出钩子置真，Task 6 deferred 收口）。
pub struct AppState {
    pub self_pids: Arc<Mutex<HashSet<u32>>>,
    pub poller_stop: Arc<AtomicBool>,
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance must be registered before all other plugins
        .plugin(tauri_plugin_single_instance::init(|_argv, _cwd, _event| {}))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 管理全局状态：Task 7 的 command 从 State 取
            let poller_stop = Arc::new(AtomicBool::new(false));
            app.manage(AppState {
                self_pids: Arc::new(Mutex::new(HashSet::new())),
                poller_stop: poller_stop.clone(),
            });

            // watcher 轮询线程：独立 std::thread，不阻塞主线程；
            // 停止来源 = AppState.poller_stop（退出钩子置真）
            let claude_dir = dirs::home_dir()
                .expect("home dir must exist")
                .join(".claude");
            let app_handle = app.handle().clone();
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
        .invoke_handler(tauri::generate_handler![
            greet,
            chat::spawn_chat,
            chat::chat_send,
            chat::chat_stop
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 退出前收口：停轮询线程 + 停常驻 chat 进程，然后放行退出
            if let RunEvent::ExitRequested { .. } = event {
                let state = app_handle.state::<AppState>();
                state.poller_stop.store(true, Ordering::Relaxed);
                let _ = chat::stop_internal(state.inner());
            }
        });
}
