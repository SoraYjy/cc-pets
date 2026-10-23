//! Chat 运行时：spawn 常驻 `claude` CLI（双向 stream-json），把 stdout 行解析
//! 成前端事件，把用户输入写进 stdin。多轮复用同一进程，Done 不杀进程。
//!
//! 纯逻辑（[`build_command`] / [`parse_chat_line`]）不触碰进程与 IO，全部单测；
//! 运行时（[`spawn_chat`] / [`chat_send`] / [`chat_stop`]）属集成行为，Task 9
//! 人工验收。解析全程宽松，无 panic 路径。

use crate::AppState;
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};

// ===== 纯逻辑 =====

/// 构造 `claude` CLI 命令：args 顺序即协议，env 剥离嵌套检测，
/// 三向管道，工作目录 = 调用方给定目录（spawn 处传用户主目录）。
pub fn build_command(workdir: &Path) -> Command {
    let mut cmd = Command::new("claude");
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
    // （若 Task 9 实测仍拒启，候选还有 CLAUDE_CODE_ENTRYPOINT，先不加。）
    cmd.env_remove("CLAUDECODE");
    cmd.current_dir(workdir);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd
}

/// 一行 stream-json 的解析结果。
#[derive(Debug, Clone, PartialEq)]
pub enum ChatEvent {
    /// system 行：携带会话 id（兼容 `session_id` 与 `sessionId` 两键）。
    Init { session_id: String },
    /// assistant 行：message.content 中全部 type=="text" 的 text 拼接。
    Text(String),
    /// result 行（非 compact）：result 字段字符串，回合结束。
    Done(String),
    /// 其余一切（thinking / compact / 非法 JSON / 缺字段）。
    Ignored,
}

/// 宽松解析一行 stdout stream-json。未知/非法一律 [`ChatEvent::Ignored`]。
/// 规则：
/// - `type=="system"` → Init（`session_id` 优先，回退 `sessionId`；两键皆缺 → Ignored）
/// - `type=="assistant"` → 拼 content 中 type=="text" 的 text（thinking 不计入；
///   拼结果为空 ⟺ 无 text 项 → Ignored）
/// - `type=="result"` 且 subtype 以 "compact" 开头 → Ignored
///   （回合中压缩不是结束；覆盖 `compact` 与 `compact_boundary`）
/// - `type=="result"` 其他 → Done(result 字段字符串；非字符串/缺失 → Ignored)
/// - 其余/非法 JSON → Ignored
pub fn parse_chat_line(raw: &str) -> ChatEvent {
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return ChatEvent::Ignored;
    };
    match v.get("type").and_then(Value::as_str) {
        Some("system") => {
            let sid = v
                .get("session_id")
                .or_else(|| v.get("sessionId"))
                .and_then(Value::as_str);
            match sid {
                Some(s) => ChatEvent::Init {
                    session_id: s.to_string(),
                },
                None => ChatEvent::Ignored,
            }
        }
        Some("assistant") => {
            let mut text = String::new();
            if let Some(items) = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array)
            {
                for item in items {
                    if item.get("type").and_then(Value::as_str) == Some("text") {
                        if let Some(t) = item.get("text").and_then(Value::as_str) {
                            text.push_str(t);
                        }
                    }
                }
            }
            if text.is_empty() {
                ChatEvent::Ignored
            } else {
                ChatEvent::Text(text)
            }
        }
        Some("result") => {
            let subtype = v.get("subtype").and_then(Value::as_str).unwrap_or("");
            if subtype.starts_with("compact") {
                // 回合中压缩不是结束
                return ChatEvent::Ignored;
            }
            match v.get("result").and_then(Value::as_str) {
                Some(r) => ChatEvent::Done(r.to_string()),
                None => ChatEvent::Ignored,
            }
        }
        _ => ChatEvent::Ignored,
    }
}

// ===== 运行时（Task 9 人工验收，不做单测） =====

/// 一个常驻 claude 对话进程的持有物。stdin 用 Option 包一层：
/// 置 None 即语义关闭；session_id 在 Init 行到达时回填。
pub struct ChatProc {
    pub child: Child,
    pub stdin: Mutex<Option<ChildStdin>>,
    pub session_id: Mutex<Option<String>>,
}

/// 全局唯一 chat 实例槽。
///
/// 选 `OnceLock` 静态而非挂 AppState 的理由：chat 生命周期要独立于 Tauri
/// managed state 被两个无调用关系的执行流触碰——读线程在进程自然退出时清理
/// 此槽、`stop_internal` 在 ExitRequested 钩子里清槽，都不想依赖 setup 时序
/// （槽在 setup 之前就可用），也让 chat 模块自包含；AppState 只保留
/// poller_stop / self_pids 这类跨模块基础设施。
static CHAT: OnceLock<Mutex<Option<ChatProc>>> = OnceLock::new();

fn chat_slot() -> &'static Mutex<Option<ChatProc>> {
    CHAT.get_or_init(|| Mutex::new(None))
}

/// stop 的内部实现（command 与退出钩子共用）：短暂持锁取走实例，锁外
/// 关 stdin → start_kill → `child.wait()` 收尸（SIGKILL 后立即返回，即
/// 「有界等待」的形态；不保存读线程 JoinHandle 以维持 ChatProc 字段逐字，
/// 读线程在 stdout EOF 后自行退出并做幂等清理——槽已空、pid 已移除均为
/// no-op）→ 清槽（上面 take 即清）→ self_pids 移除。
pub fn stop_internal(state: &AppState) -> Result<(), String> {
    let taken = chat_slot().lock().expect("chat slot poisoned").take();
    if let Some(mut p) = taken {
        // 先语义关 stdin（部分 CLI 靠 EOF 收尾），再 SIGKILL 兜底
        *p.stdin.lock().expect("stdin poisoned") = None;
        let pid = p.child.id();
        let _ = p.child.kill();
        let _ = p.child.wait();
        state
            .self_pids
            .lock()
            .expect("self_pids poisoned")
            .remove(&pid);
    }
    Ok(())
}

/// spawn 常驻 claude 对话进程。已有实例先 stop（幂等换新）。
/// 返回 Ok(子进程 pid 字符串)；session_id 稍后随 init 事件异步到达。
#[tauri::command]
pub fn spawn_chat(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let _ = stop_internal(&state);

    let home = dirs::home_dir().ok_or_else(|| "home dir not found".to_string())?;
    let mut child = build_command(&home)
        .spawn()
        .map_err(|e| format!("failed to spawn claude: {e}"))?;

    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let (Some(stdin), Some(stdout)) = (stdin, stdout) else {
        // 半启动失败：不留僵尸 claude
        let _ = child.kill();
        let _ = child.wait();
        return Err("claude spawned without piped stdio".to_string());
    };

    state
        .self_pids
        .lock()
        .expect("self_pids poisoned")
        .insert(pid);

    *chat_slot().lock().expect("chat slot poisoned") = Some(ChatProc {
        child,
        stdin: Mutex::new(Some(stdin)),
        session_id: Mutex::new(None),
    });

    // 读线程：逐行解析 stdout → emit；Done 不杀进程（保持多轮）；
    // stdout EOF（进程自然退出）→ 清全局槽 + self_pids 移除。
    let handle = app.clone();
    let pids: Arc<Mutex<std::collections::HashSet<u32>>> = state.self_pids.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            match parse_chat_line(&line) {
                ChatEvent::Init { session_id } => {
                    if let Some(p) = chat_slot().lock().expect("chat slot poisoned").as_ref() {
                        *p.session_id.lock().expect("session_id poisoned") =
                            Some(session_id.clone());
                    }
                    let _ = handle.emit(
                        "chat-event",
                        serde_json::json!({ "kind": "init", "text": session_id }),
                    );
                }
                ChatEvent::Text(text) => {
                    let _ = handle.emit(
                        "chat-event",
                        serde_json::json!({ "kind": "text", "text": text }),
                    );
                }
                ChatEvent::Done(text) => {
                    let _ = handle.emit(
                        "chat-event",
                        serde_json::json!({ "kind": "done", "text": text }),
                    );
                }
                ChatEvent::Ignored => {}
            }
        }
        // 自然退出清理：仅当槽里仍是自己这个实例才收走（防 spawn_chat
        // 换新竞态下误收新 proc）；槽已空 = chat_stop 已收殓，均为幂等 no-op。
        let mut slot = chat_slot().lock().expect("chat slot poisoned");
        if slot.as_ref().map(|p| p.child.id()) == Some(pid) {
            if let Some(mut p) = slot.take() {
                let _ = p.child.wait(); // 兜底收尸，防僵尸
            }
        }
        drop(slot);
        pids.lock().expect("self_pids poisoned").remove(&pid);
    });

    Ok(pid.to_string())
}

/// 向常驻 claude 写一条 user 消息（双向 stream-json 协议）。
#[tauri::command]
pub fn chat_send(text: String) -> Result<(), String> {
    let guard = chat_slot().lock().expect("chat slot poisoned");
    let p = guard.as_ref().ok_or_else(|| "no chat process".to_string())?;
    let mut stdin_guard = p.stdin.lock().expect("stdin poisoned");
    let stdin = stdin_guard
        .as_mut()
        .ok_or_else(|| "stdin closed".to_string())?;
    let line = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": text }
    });
    writeln!(stdin, "{line}").map_err(|e| format!("write stdin failed: {e}"))?;
    stdin.flush().map_err(|e| format!("flush stdin failed: {e}"))?;
    Ok(())
}

/// 停止常驻 claude 对话进程（幂等：无实例也返回 Ok）。
#[tauri::command]
pub fn chat_stop(state: State<'_, AppState>) -> Result<(), String> {
    stop_internal(&state)
}

// ===== 测试 =====

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_command_strips_claudecode_env() {
        let home = dirs::home_dir().expect("home dir must exist");
        let cmd = build_command(&home);
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
        assert_eq!(cmd.get_current_dir(), Some(home.as_path()));
    }

    #[test]
    fn test_parse_init() {
        let ev = parse_chat_line(r#"{"type":"system","session_id":"s-1","model":"x"}"#);
        assert_eq!(
            ev,
            ChatEvent::Init {
                session_id: "s-1".to_string()
            }
        );
    }

    #[test]
    fn test_parse_assistant_text() {
        let ev = parse_chat_line(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","text":"hmm"},{"type":"text","text":"你好"}]}}"#,
        );
        assert_eq!(ev, ChatEvent::Text("你好".to_string()));
    }

    #[test]
    fn test_compact_result_ignored() {
        assert_eq!(
            parse_chat_line(r#"{"type":"result","subtype":"compact","result":"..."}"#),
            ChatEvent::Ignored
        );
        assert_eq!(
            parse_chat_line(r#"{"type":"result","subtype":"compact_boundary","result":"..."}"#),
            ChatEvent::Ignored
        );
    }

    #[test]
    fn test_parse_done() {
        let ev = parse_chat_line(r#"{"type":"result","subtype":"success","result":"完成了"}"#);
        assert_eq!(ev, ChatEvent::Done("完成了".to_string()));
    }

    #[test]
    fn test_garbage_ignored() {
        assert_eq!(parse_chat_line("oops{"), ChatEvent::Ignored);
        assert_eq!(parse_chat_line("{}"), ChatEvent::Ignored);
    }
}
