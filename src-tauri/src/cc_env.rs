//! Claude Code 运行形态（数据目录 + 聊天 CLI）：原生 Claude Code（数据目录
//! `~/.claude`，裸 `claude` 启动）之外，还支持**封装变体**——另一种把
//! Claude Code 包了一层（自有数据目录、自有托管启动入口）的发行形态。两
//! 侧数据格式同构（watcher 解析层零改动），差异只在目录与启动链路——本
//! 模块把这两处差异收敛成注入点，形态由 settings.json 的两个可选字段配置：
//!
//! - `claudeDataDir`：变体的数据目录（监控走它）
//! - `claudeChatLauncher`：聊天启动命令（含空格分隔参数；聊天经它启动，
//!   工作目录固定 `~/.cc-pets`——部分托管入口不允许 `$HOME` 作工作目录）
//!
//! 二者相互独立：只配目录则仅监控走变体、聊天仍原生；未配置即原生。
//!
//! 纯逻辑（[`build_command`]，自 chat.rs 迁入）不触碰进程与 IO，全部单测；
//! 探测/解析函数的 IO 面收窄到临时目录 fixture 上测；PATH 相关测试经
//! [`tests::with_path`] 串行化，进程级全局变量无并行竞态。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use serde_json::Value;

// ===== 数据目录 =====

/// 解析监控用的 Claude Code 数据目录：配置了 `claudeDataDir` 用之（支持
/// `~` 前缀 = home），否则原生 `~/.claude`。
pub fn claude_data_dir(home: &Path, configured: Option<&str>) -> PathBuf {
    match configured {
        Some(dir) => expand_tilde(home, dir),
        None => home.join(".claude"),
    }
}

/// `~` 前缀展开为 home；其余原样（绝对路径直用）。
fn expand_tilde(home: &Path, p: &str) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(p),
    }
}

// ===== 聊天 CLI 解析 =====

/// 聊天 CLI 形态：原生 / 变体差异在此一处收敛，[`build_command`] 与
/// spawn 方共用。
#[derive(Debug, Clone, PartialEq)]
pub struct ChatCli {
    /// 可执行程序（原生 "claude"；变体 = 配置的启动器首个空白分隔段，
    /// 经 PATH 探测）。
    pub program: String,
    /// 启动器前缀参数（配置串中除程序名外的空格分隔段；原生为空）。
    pub prefix_args: Vec<String>,
    /// 子进程工作目录：原生 = $HOME（现状不变）；变体 = `~/.cc-pets`
    /// （部分托管入口不允许 `$HOME` 作工作目录）。目录创建归 spawn 调用方，
    /// 本结构只描述形态、不做 IO。
    pub workdir: PathBuf,
}

/// PATH 探测：逐目录检查 `<dir>/<program>` 是否为普通文件。只 `is_file()`
/// 不校验执行位（macOS 惯例）；PATH 缺失视为找不到。
fn find_in_path(program: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join(program).is_file())
}

/// 解析聊天 CLI 形态。配置了 `claudeChatLauncher` → 变体形态：程序名取配
/// 置串首个空白分隔段（PATH 上找不到原地报 Err——不静默回退裸 `claude`，
/// 变体经自有托管/鉴权体系启动，回退只会把失败藏得更深；调用方落日志后失败
/// 返回），其余空白分隔段为前缀参数，workdir=`~/.cc-pets`；未配置 → 原生
/// 形态 "claude"、无前缀、workdir=$HOME（与历史行为逐项一致：原生分支不
/// 做 PATH 探测，保持「spawn 时才报找不到」的现状）。纯判定不做目录 IO
/// （workdir 创建归 spawn_internal，resolve 保持可测的纯函数语义）。
pub fn resolve_chat_cli(
    home: &Path,
    launcher: Option<&str>,
) -> Result<ChatCli, String> {
    let Some(launcher) = launcher else {
        return Ok(ChatCli {
            program: "claude".to_string(),
            prefix_args: Vec::new(),
            workdir: home.to_path_buf(),
        });
    };
    let mut parts = launcher.split_whitespace();
    let Some(program) = parts.next() else {
        return Err("claude chat launcher is empty".to_string());
    };
    if !find_in_path(program) {
        return Err(format!(
            "variant chat cli '{program}' not found in PATH \
             (configured launcher must be installed; check PATH/install)"
        ));
    }
    Ok(ChatCli {
        program: program.to_string(),
        prefix_args: parts.map(|s| s.to_string()).collect(),
        workdir: home.join(".cc-pets"),
    })
}

// ===== 命令构造（chat.rs 迁入）=====

/// 构造聊天 CLI 命令：prefix_args（变体启动器前缀）→ stream-json 参数组
/// （args 顺序即协议，与迁移前逐参一致），env 剥离嵌套检测，unix 下子进程
/// 独立进程组（`process_group(0)`：pgid = 子 pid，后续组杀 killpg 的前提；
/// cfg(unix) 门保证非 unix 平台 cargo check 通过），三向管道，工作目录 =
/// cli.workdir。
pub fn build_command(cli: &ChatCli) -> Command {
    let mut cmd = Command::new(&cli.program);
    cmd.args(&cli.prefix_args);
    cmd.args([
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--permission-prompt-tool",
        "stdio",
        "--replay-user-messages",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
    ]);
    // 嵌套检测剥离：widget 里 spawn 的 claude 不许被当成嵌套会话拒启。
    // （若实测仍拒启，候选还有 CLAUDE_CODE_ENTRYPOINT，先不加。）
    cmd.env_remove("CLAUDECODE");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.current_dir(&cli.workdir);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd
}

// ===== 注册表反查 =====

/// 在注册表目录按 sessionId 反查引擎 pid：遍历 `<pid>.json`，宽松解析——
/// JSON 里 `sessionId` 或 `session_id` 等于目标值即命中，返回文件名解析出
/// 的 pid。杂字段容忍（变体注册表多 startedAt/version/slug 等）、非法
/// JSON / 文件名非数字 / 值非字符串 / 读失败一律跳过；目录不存在或无人
/// 命中 → None。变体注册表记的是引擎子进程 pid（非包装进程），这正是补
/// 登想要的值；原生环境引擎 pid == spawn pid，命中重复插入幂等无害。
/// 消费点在 chat.rs 的 `backfill_engine_pid_once`（Init 事件补登线程）。
pub fn scan_registry_for_session(sessions_dir: &Path, session_id: &str) -> Option<u32> {
    for entry in std::fs::read_dir(sessions_dir).ok()?.flatten() {
        let name = entry.file_name();
        let Some(pid) = name
            .to_str()
            .and_then(|n| n.strip_suffix(".json"))
            .and_then(|stem| stem.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(content) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&content) else {
            continue;
        };
        let hit = ["sessionId", "session_id"]
            .into_iter()
            .any(|key| v.get(key).and_then(Value::as_str) == Some(session_id));
        if hit {
            return Some(pid);
        }
    }
    None
}

// ===== 测试 =====

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::{OsStr, OsString};
    use std::sync::Mutex;
    use tempfile::tempdir;

    /// PATH 是进程级全局（edition 2024 起 set_var 为 unsafe）。crate 内
    /// 唯一 env 读写点就是本模块，凡动 PATH 的测试统一经 [`with_path`]
    /// / [`with_path_unset`] 抢这把锁串行执行，锁区内无并发读方，竞态封死。
    static PATH_LOCK: Mutex<()> = Mutex::new(());

    /// PATH 还原 drop guard：无论正常返回还是 `f()` panic 都还原 PATH——
    /// 原顺序还原写法在 panic 时被跳过，「防连坐」恰好变成连坐。
    struct PathGuard(Option<OsString>);

    impl Drop for PathGuard {
        fn drop(&mut self) {
            match self.0.take() {
                Some(p) => unsafe { std::env::set_var("PATH", p) },
                None => unsafe { std::env::remove_var("PATH") },
            }
        }
    }

    /// 串行区执行 `f`：抢 PATH_LOCK → 存旧 PATH → 设新值 → 跑断言 →
    /// 还旧值（Drop guard，panic 路径也还原）。毒化锁直接 into_inner
    /// 继续（单测失败不应连坐后续测试）。
    fn with_path<R>(path: &OsStr, f: impl FnOnce() -> R) -> R {
        let _lock = PATH_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _guard = PathGuard(std::env::var_os("PATH"));
        // SAFETY：全 crate 唯一 env 写点，且在 PATH_LOCK 串行区内执行；
        // 还原交 PathGuard::drop（声明顺序保证先还原 PATH 再放锁）。
        unsafe { std::env::set_var("PATH", path) };
        f()
    }

    /// PATH 未设（remove_var）的串行区：与 [`with_path`] 同锁同还原，
    /// 覆盖 `var_os("PATH") == None` 分支的测试。
    fn with_path_unset<R>(f: impl FnOnce() -> R) -> R {
        let _lock = PATH_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _guard = PathGuard(std::env::var_os("PATH"));
        // SAFETY：全 crate 唯一 env 写点，且在 PATH_LOCK 串行区内执行。
        unsafe { std::env::remove_var("PATH") };
        f()
    }

    // ---- 数据目录 ----

    #[test]
    fn test_data_dir_configured_used_verbatim() {
        let home = tempdir().unwrap();
        let configured = home.path().join("variants").join("mycc");
        assert_eq!(
            claude_data_dir(home.path(), Some(configured.to_str().unwrap())),
            configured
        );
    }

    #[test]
    fn test_data_dir_configured_tilde_expands_to_home() {
        let home = tempdir().unwrap();
        assert_eq!(
            claude_data_dir(home.path(), Some("~/my-cc")),
            home.path().join("my-cc")
        );
    }

    #[test]
    fn test_data_dir_unconfigured_falls_back_native() {
        let home = tempdir().unwrap();
        assert_eq!(claude_data_dir(home.path(), None), home.path().join(".claude"));
    }

    // ---- PATH 探测 ----

    #[test]
    fn test_find_in_path_matches_file_not_dir() {
        let d1 = tempdir().unwrap();
        let d2 = tempdir().unwrap();
        let d3 = tempdir().unwrap();
        std::fs::create_dir_all(d1.path().join("mycc-launcher")).unwrap(); // 目录不算数
        std::fs::write(d3.path().join("mycc-launcher"), b"#!/bin/sh\n").unwrap();
        let joined = std::env::join_paths([d1.path(), d2.path(), d3.path()]).unwrap();
        with_path(&joined, || {
            assert!(find_in_path("mycc-launcher"), "file entry in PATH must match");
            assert!(!find_in_path("nope"), "missing entry must not match");
        });
    }

    #[test]
    fn test_find_in_path_absent() {
        let empty = tempdir().unwrap();
        with_path(empty.path().as_os_str(), || {
            assert!(!find_in_path("mycc-launcher"));
        });
    }

    #[test]
    fn test_find_in_path_unset() {
        // PATH 未设（var_os 为 None）：找不到任何程序，不 panic
        with_path_unset(|| {
            assert!(!find_in_path("claude"), "unset PATH must not match");
        });
    }

    // ---- CLI 解析 ----

    #[test]
    fn test_resolve_launcher_configured_splits_program_and_args() {
        let home = tempdir().unwrap();
        let bin = tempdir().unwrap();
        std::fs::write(bin.path().join("mycc-launcher"), b"#!/bin/sh\n").unwrap();
        with_path(bin.path().as_os_str(), || {
            let cli = resolve_chat_cli(home.path(), Some("mycc-launcher --skip-update"))
                .expect("launcher present in PATH");
            assert_eq!(cli.program, "mycc-launcher");
            assert_eq!(cli.prefix_args, vec!["--skip-update".to_string()]);
            assert_eq!(cli.workdir, home.path().join(".cc-pets"));
            // resolve 不做目录 IO：workdir 由 spawn_internal 落，此处必须未创建
            assert!(
                !home.path().join(".cc-pets").exists(),
                "resolve_chat_cli must not create the workdir"
            );
        });
    }

    #[test]
    fn test_resolve_launcher_missing_is_err() {
        let home = tempdir().unwrap();
        let bin = tempdir().unwrap(); // 空 bin：启动器不在 PATH
        with_path(bin.path().as_os_str(), || {
            let err = resolve_chat_cli(home.path(), Some("mycc-launcher")).unwrap_err();
            assert!(err.contains("mycc-launcher"), "err must name the cli: {err}");
            assert!(err.contains("PATH"), "err must point at PATH: {err}");
        });
    }

    #[test]
    fn test_resolve_launcher_whitespace_only_is_err() {
        let home = tempdir().unwrap();
        assert!(resolve_chat_cli(home.path(), Some("   ")).is_err());
    }

    #[test]
    fn test_resolve_native_fallback_unchanged() {
        let home = tempdir().unwrap(); // 未配置 → 原生
        let bin = tempdir().unwrap(); // PATH 里连 claude 都没有：原生不做 PATH 探测，保持现状
        with_path(bin.path().as_os_str(), || {
            let cli = resolve_chat_cli(home.path(), None).expect("native needs no PATH check");
            assert_eq!(cli.program, "claude");
            assert_eq!(cli.prefix_args, Vec::<String>::new());
            assert_eq!(cli.workdir, home.path());
        });
    }

    // ---- 命令构造（chat.rs 迁入的测试随函数迁来）----

    #[test]
    fn test_build_command_native_form_protocol_unchanged() {
        let workdir = tempdir().unwrap();
        let cli = ChatCli {
            program: "claude".to_string(),
            prefix_args: Vec::new(),
            workdir: workdir.path().to_path_buf(),
        };
        let cmd = build_command(&cli);
        // 注：stable std 无 Command::get_env（单键 getter 未稳定），
        // 用 get_envs() 验证显式 remove 项 ("CLAUDECODE", None)。
        let removed = cmd
            .get_envs()
            .any(|(k, v)| k == "CLAUDECODE" && v.is_none());
        assert!(removed, "CLAUDECODE must be env_remove'd");
        assert_eq!(cmd.get_program().to_string_lossy(), "claude");
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "--output-format",
                "stream-json",
                "--input-format",
                "stream-json",
                "--permission-prompt-tool",
                "stdio",
                "--replay-user-messages",
                "--verbose",
                "--permission-mode",
                "acceptEdits",
            ]
        );
        assert_eq!(cmd.get_current_dir(), Some(workdir.path()));
    }

    #[test]
    fn test_build_command_variant_prefixes_protocol_args() {
        let workdir = tempdir().unwrap();
        let cli = ChatCli {
            program: "mycc-launcher".to_string(),
            prefix_args: vec!["--skip-update".to_string()],
            workdir: workdir.path().to_path_buf(),
        };
        let cmd = build_command(&cli);
        assert_eq!(cmd.get_program().to_string_lossy(), "mycc-launcher");
        let removed = cmd
            .get_envs()
            .any(|(k, v)| k == "CLAUDECODE" && v.is_none());
        assert!(removed, "CLAUDECODE must be env_remove'd in variant form too");
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "--skip-update", // 变体启动器前缀在最前，协议参数原序其后
                "--output-format",
                "stream-json",
                "--input-format",
                "stream-json",
                "--permission-prompt-tool",
                "stdio",
                "--replay-user-messages",
                "--verbose",
                "--permission-mode",
                "acceptEdits",
            ]
        );
        assert_eq!(cmd.get_current_dir(), Some(workdir.path()));
    }

    // ---- 注册表反查 ----

    #[test]
    fn test_scan_registry_hit_camel_with_junk_fields() {
        let dir = tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(
            sessions.join("4242.json"),
            r#"{"sessionId":"s-abc","status":"working","startedAt":"2026-11-21","version":9,"slug":"x"}"#,
        )
        .unwrap();
        assert_eq!(scan_registry_for_session(&sessions, "s-abc"), Some(4242));
    }

    #[test]
    fn test_scan_registry_hit_snake_case_key() {
        let dir = tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(sessions.join("77.json"), r#"{"session_id":"s-x"}"#).unwrap();
        assert_eq!(scan_registry_for_session(&sessions, "s-x"), Some(77));
    }

    #[test]
    fn test_scan_registry_miss_and_lenient_skips() {
        let dir = tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(sessions.join("1.json"), r#"{"sessionId":"s-other"}"#).unwrap();
        std::fs::write(sessions.join("dead.json"), "{{{ not json").unwrap(); // 非法 JSON → 跳过
        std::fs::write(sessions.join("9.json"), r#"{"sessionId":42}"#).unwrap(); // 值非字符串 → 跳过
        std::fs::write(
            sessions.join("engine.json"),
            r#"{"sessionId":"s-target"}"#,
        )
        .unwrap(); // 文件名非数字 → 跳过（否则此处会误命中）
        std::fs::write(sessions.join("notes.txt"), "junk").unwrap(); // 非 .json → 跳过
        assert_eq!(scan_registry_for_session(&sessions, "s-target"), None);
    }

    #[test]
    fn test_scan_registry_missing_dir_is_none() {
        let dir = tempdir().unwrap();
        assert_eq!(
            scan_registry_for_session(&dir.path().join("nope"), "s-1"),
            None
        );
    }
}
