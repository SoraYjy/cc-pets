use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, RunEvent};

mod chat;
mod opener;
mod settings;
mod skins;
mod watcher;

/// debug 日志设施。命令放子模块：crate 根模块里的 `#[tauri::command]` 会
/// 与 2024 edition 的宏命名空间冲突（E0255），chat.rs 里的命令能编译正是
/// 因为在子模块。
mod debug_log {
    use std::io::Write;
    use std::path::PathBuf;

    /// 平台日志目录：macOS 固定 `~/Library/Logs`（dirs 6/7 已删 log_dir，
    /// 这里显式实现等价路径）；其他平台退 data_dir()。
    #[cfg(target_os = "macos")]
    fn platform_log_dir() -> Option<PathBuf> {
        dirs::home_dir().map(|h| h.join("Library").join("Logs"))
    }

    #[cfg(not(target_os = "macos"))]
    fn platform_log_dir() -> Option<PathBuf> {
        dirs::data_dir()
    }

    /// 日志文件路径：`<log_dir>/lynn-widget/debug.log`；log 目录不可用则退
    /// `home_dir()/.lynn-widget/debug.log`；home 也没有就放弃写日志。
    fn path() -> Option<PathBuf> {
        let base = platform_log_dir()
            .or_else(|| dirs::home_dir().map(|h| h.join(".lynn-widget")))?;
        Some(base.join("lynn-widget").join("debug.log"))
    }

    /// 带本地时间戳追加一行到 debug 日志；目录自动创建，写失败静默——
    /// 日志是诊断设施，不许反向打断主流程。chat.rs 生命周期日志与前端
    /// debug line（append_debug）共用这一个落盘点。
    ///
    /// 行原子性：整行（含时间戳与换行）先格式化进单个 String，再一次
    /// `write_all` 落盘。O_APPEND 只保证单次 write 系统调用的追加原子性，
    /// `writeln!`/`write_fmt` 会按格式碎片多次 write——前端 append_debug
    /// 异步线程与后端日志并发时，时间戳会插进别的行中间（实测日志里 3 处
    /// 乱码）。整行一次写后，行与行只可能整条错序、不会再互相切碎。
    pub(crate) fn log_line(line: &str) {
        use std::fmt::Write as _; // String 的 write!（io::Write 未实现于 String，无歧义）
        let Some(path) = path() else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let mut row = String::with_capacity(line.len() + 32);
        // 唯一可失败点是写入本身，与旧行为一致静默。
        let _ = write!(row, "[{stamp}] {line}\n");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = f.write_all(row.as_bytes());
        }
    }

    /// 前端 debug line 的持久化通道（前端 fire-and-forget，本端不返回错误）。
    #[tauri::command]
    pub fn append_debug(line: String) {
        log_line(&line);
    }

    /// 启动截断（round 5 清理机制）：每次启动 = 全新日志，防历史噪音无限
    /// 累积；随后由 setup 打一条启动标记对齐时间线。
    pub(crate) fn truncate() {
        if let Some(p) = path() {
            let _ = std::fs::write(p, b"");
        }
    }
}

use debug_log::log_line;

/// 全局共享状态。Task 7 的 command 从 `State<AppState>` 取 `self_pids`；
/// `poller_stop` 是轮询线程的唯一停止旗标（退出钩子置真，Task 6 deferred 收口）。
pub struct AppState {
    pub self_pids: Arc<Mutex<HashSet<u32>>>,
    pub poller_stop: Arc<AtomicBool>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance must be registered before all other plugins
        .plugin(tauri_plugin_single_instance::init(|_argv, _cwd, _event| {}))
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // 日志清理（round 5）：每次启动截断 debug 日志 = 全新日志，并打
            // 启动标记，时间线从这里对齐。
            debug_log::truncate();
            log_line("app started");

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
            chat::spawn_chat,
            chat::chat_send,
            chat::chat_stop,
            chat::chat_restart,
            debug_log::append_debug,
            opener::open_external,
            settings::get_settings,
            settings::save_settings,
            skins::get_skins
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
