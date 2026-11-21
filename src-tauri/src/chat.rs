//! Chat 运行时：spawn 常驻 `claude` CLI（双向 stream-json），把 stdout 行解析
//! 成前端事件，把用户输入写进 stdin。多轮复用同一进程，Done 不杀进程。
//!
//! 纯逻辑（[`parse_chat_line`]；命令构造迁至 [`crate::cc_env::build_command`]，
//! CLI/目录形态探测见 [`crate::cc_env`]）不触碰进程与 IO，全部单测；
//! [`StderrRing`] 单测覆盖丢最旧/空快照；运行时（[`spawn_chat`] / [`chat_send`]
//! / [`chat_stop`]）属集成行为，Task 9 人工验收。解析全程宽松，无 panic 路径。

use crate::AppState;
use crate::cc_env::{build_command, claude_data_dir, resolve_chat_cli, scan_registry_for_session};
use serde_json::Value;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ExitStatus};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

// ===== 纯逻辑 =====

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
/// - `type=="system"` 且 `subtype=="init"` → Init（`session_id` 优先，回退
///   `sessionId`；两键皆缺 → Ignored）。subtype 缺失或非 "init" → Ignored
///   （**即使带 session_id**——system 行家族很宽，hook_started /
///   thinking_tokens 等也携带 session_id，不设门会把回合中的 system 行
///   误当会话初始化，session_id 被其他会话的 id 反复覆盖）
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
            if v.get("subtype").and_then(Value::as_str) != Some("init") {
                return ChatEvent::Ignored;
            }
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

// ===== 运行时（Task 9 人工验收，不做单测；StderrRing 除外） =====

/// stderr 环形缓冲：容量 [`StderrRing::cap`]，超限丢最旧。stderr 读线程
/// 逐行 [`StderrRing::push`]，进程退出（EOF 收尸 / chat_stop）时
/// [`snapshot`](`StderrRing::snapshot`) 一次性落盘——避免 stderr 高频直写
/// 日志。字段私有，读取走拷贝快照。
pub struct StderrRing {
    lines: Mutex<VecDeque<String>>,
    cap: usize,
}

impl StderrRing {
    pub fn new(cap: usize) -> Self {
        StderrRing {
            lines: Mutex::new(VecDeque::new()),
            cap,
        }
    }

    /// 压入一行 stderr；已达容量时丢最旧一行再入队。cap=0 不存任何行。
    pub fn push(&self, line: &str) {
        if self.cap == 0 {
            return;
        }
        let mut q = self.lines.lock().expect("stderr ring poisoned");
        if q.len() >= self.cap {
            q.pop_front();
        }
        q.push_back(line.to_string());
    }

    /// 当前缓冲内容拷贝（旧→新顺序），至多 `cap` 行。
    pub fn snapshot(&self) -> Vec<String> {
        self.lines
            .lock()
            .expect("stderr ring poisoned")
            .iter()
            .cloned()
            .collect()
    }
}

/// 一个常驻 claude 对话进程的持有物。stdin 包 `Arc<Mutex<ChildStdin>>`：
/// chat_send 在槽锁外持 Arc 写入（锁分离，槽锁绝不跨 stdin 写）；child 包
/// `Mutex<Child>`：槽里存共享 Arc，而 try_wait/wait 要 `&mut Child`，互斥
/// 后活性检查在槽锁内即可完成（持锁时间 = 一次 try_wait，不跨界）；child
/// 锁永远在 stdin 锁之前获取、且不同时持有，无锁序环。session_id 在 Init
/// 行到达时回填；stderr_ring 与 stderr 读线程各持一份 Arc（同一实例），
/// 进程退出时由收殓方读出落盘。
pub struct ChatProc {
    pub child: Mutex<Child>,
    pub stdin: Arc<Mutex<ChildStdin>>,
    pub session_id: Mutex<Option<String>>,
    /// 引擎进程 pid（补登）：spawn 时 None，Init 后台补登线程从注册表反查
    /// 命中后写入。包 `Arc<Mutex<_>>` 是补登线程无法经全局槽触碰 ChatProc
    /// 本体（槽可能已被 take/换新）——spawn 时新建共享句柄，槽与线程各持
    /// 一份同一 Arc，stop 时经本字段读出做 self_pids 双移除与诊断。迟到
    /// 写入（stop 之后才命中）只落到无人再读的句柄，不构成误杀面。
    pub engine_pid: Arc<Mutex<Option<u32>>>,
    pub stderr_ring: Arc<StderrRing>,
    /// stderr 读线程句柄：spawn 时存入备查；不在此 join——join 无界等待，
    /// 有界收尾由 [`log_chat_exit`] 经 `stderr_done` 信号完成。本字段按
    /// 设计只写不读（当前无消费点，留作诊断与后续有界 join 的挂点），
    /// dead_code 检查在此放行。
    #[allow(dead_code)]
    pub stderr_join: Option<JoinHandle<()>>,
    /// stderr 线程退出信号接收端：收殓方快照环形缓冲前 recv_timeout 等
    /// 此信号（最多 [`STDERR_TAIL_WAIT`]），保证残行尽量收齐。包 Mutex
    /// 是为满足槽内 `Arc<ChatProc>` 的 Sync 要求（Receiver 本身非 Sync；
    /// 实际消费方同一时刻只有一个——持有 proc 的收殓方）。
    pub stderr_done: Mutex<mpsc::Receiver<()>>,
}

/// 全局唯一 chat 实例槽（存 `Arc<ChatProc>`：chat_send 取 clone 后即可
/// 出锁写 stdin，不必持槽锁）。
///
/// 选 `OnceLock` 静态而非挂 AppState 的理由：chat 生命周期要独立于 Tauri
/// managed state 被两个无调用关系的执行流触碰——读线程在进程自然退出时清理
/// 此槽、`stop_internal` 在 ExitRequested 钩子里清槽，都不想依赖 setup 时序
/// （槽在 setup 之前就可用），也让 chat 模块自包含；AppState 只保留
/// poller_stop / self_pids 这类跨模块基础设施。
static CHAT: OnceLock<Mutex<Option<Arc<ChatProc>>>> = OnceLock::new();

fn chat_slot() -> &'static Mutex<Option<Arc<ChatProc>>> {
    CHAT.get_or_init(|| Mutex::new(None))
}

/// 退出落盘前等待 stderr 线程收尾的上限（有界等待，防收殓方被卡死）。
const STDERR_TAIL_WAIT: Duration = Duration::from_millis(200);

/// 引擎 pid 补登轮询次数上限。注册表 `<pid>.json` 由引擎在 init 行之后
/// 异步落盘，时序无保证——15 次 × 400ms（约 6s）有界轮询，命中即停。
const ENGINE_PID_SCAN_ATTEMPTS: u32 = 15;
/// 引擎 pid 补登轮询间隔。补登只影响面板过滤（self_pids）与 stop 双移除
/// 完整性，组杀按进程组兜底覆盖引擎，超限放弃无安全后果。
const ENGINE_PID_SCAN_INTERVAL: Duration = Duration::from_millis(400);

/// 进程退出统一落盘点（EOF 收尸与 chat_stop 两处共用）：先记退出码
/// （信号死/拿不到写 unknown）；随后对 stderr 线程做有界收尾等待——
/// kill+wait 与 stdout EOF 都不保证 stderr 线程已把残行 push 进环，收不到
/// 完成信号则快照现状并追加一行 `[stderr] (tail may be truncated)`，如实
/// 声明尾行可能缺失；最后把环形缓冲逐行落盘（前缀 `[stderr] `，至多
/// cap=50 行）。
fn log_chat_exit(proc: &ChatProc, status: Option<ExitStatus>) {
    let code = status
        .and_then(|s| s.code())
        .map(|c| c.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    crate::log_line(&format!("chat process exited (code={code})"));
    // 有界等待 stderr 线程收尾。Ok = 线程发来完成信号；Disconnected =
    // sender 已 drop（无 stderr 线程，或线程未发信号即终止）——均视为
    // 收尾；Timeout = 200ms 内未收尾，尾行可能缺失。
    let truncated = match proc
        .stderr_done
        .lock()
        .expect("stderr done poisoned")
        .recv_timeout(STDERR_TAIL_WAIT)
    {
        Ok(()) | Err(RecvTimeoutError::Disconnected) => false,
        Err(RecvTimeoutError::Timeout) => true,
    };
    for l in proc.stderr_ring.snapshot() {
        crate::log_line(&format!("[stderr] {l}"));
    }
    if truncated {
        crate::log_line("[stderr] (tail may be truncated)");
    }
}

/// stop 的内部实现（command 与退出钩子共用）：短暂持锁取走实例，锁外
/// 组杀 → `child.kill()` 兜底 → `child.wait()` 收尸（SIGKILL 后立即返回，
/// 即「有界等待」的形态）→ 落退出码与 stderr 缓冲（[`log_chat_exit`]：
/// 快照前对 stderr 线程做最多 200ms 的有界收尾等待——kill+wait 只保证
/// 进程死，不保证 stderr 线程已写完残行；超时则快照现状并标注尾行可能
/// 截断）→ self_pids 双移除（spawn pid + 补登的引擎 pid）。
///
/// 组杀序列（仅主动 kill 路径）：spawn 时 `process_group(0)` 使 pgid ==
/// 子 pid，先 `killpg(SIGKILL)` 一锅端整个进程组（变体环境 cfuse → 引擎
/// 的子进程链全在组内，裸 kill 只杀得到包装进程、引擎会成孤儿），再
/// `child.kill()` 兜底覆盖 killpg 权限/已退出等失败，最后 wait。EOF 自然
/// 退出收尸路径不做组杀（进程已死，组可能已被复用，killpg 有误伤面）。
pub fn stop_internal(state: &AppState) -> Result<(), String> {
    let taken = chat_slot().lock().expect("chat slot poisoned").take();
    if let Some(p) = taken {
        // kill 前读补登的引擎 pid（可能 None——注册表未及落盘/超限未命中），
        // 供收尾时双移除。
        let engine_pid = *p.engine_pid.lock().expect("engine_pid poisoned");
        // 单次持 child 锁完成组杀 + 兜底 kill + wait 收尸
        let (pid, status) = {
            let mut c = p.child.lock().expect("chat child poisoned");
            let pid = c.id();
            #[cfg(unix)]
            unsafe {
                libc::killpg(pid as libc::pid_t, libc::SIGKILL);
            }
            let _ = c.kill();
            (pid, c.wait().ok())
        };
        log_chat_exit(&p, status);
        let mut pids = state.self_pids.lock().expect("self_pids poisoned");
        pids.remove(&pid);
        if let Some(ep) = engine_pid {
            crate::log_line(&format!("chat stop: engine pid {ep} removed"));
            pids.remove(&ep);
        }
    }
    Ok(())
}

/// spawn 常驻 claude 对话进程。已有活实例直接复用、不再 kill 重启——重复
/// 点击会打断进行中的对话并堆一排「会话已连接」，修复轮 3 裁定废弃原
/// 「已存在先 kill 重启」计划；仅当无实例或旧实例已退出时才 spawn 新进程。
/// 返回 Ok(子进程 pid 字符串；活实例复用时为 "already running")；
/// session_id 稍后随 init 事件异步到达。
#[tauri::command(async)]
pub fn spawn_chat(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    // 活实例探测：try_wait Ok(None) = 进程还活着，直接复用。锁内只做探测，
    // 锁外再走 stop_internal（它要拿同一把锁，持锁调用会死锁）。
    {
        let slot = chat_slot().lock().expect("chat slot poisoned");
        if let Some(p) = slot.as_ref() {
            if p.child
                .lock()
                .expect("chat child poisoned")
                .try_wait()
                .map_or(false, |st| st.is_none())
            {
                crate::log_line("chat already running; reusing (no respawn)");
                return Ok("already running".to_string());
            }
        }
    }
    let _ = stop_internal(&state);

    spawn_internal(&app, &state)
}

/// spawn 的实际执行体（acceptance-fix-10 从 spawn_chat 抽出，供
/// spawn_chat 与 chat_restart 复用）：杀槽内残留实例（探测后正常为空，
/// stop 幂等）→ spawn 新常驻进程，接好 stdin/stdout/stderr 三线程与全局
/// 槽。前置条件：调用方已确认无可复用活实例（spawn_chat 的探测 /
/// chat_restart 的强制重开语义）。
fn spawn_internal(app: &AppHandle, state: &AppState) -> Result<String, String> {
    let _ = stop_internal(state);

    let home = dirs::home_dir().ok_or_else(|| "home dir not found".to_string())?;
    // CLI 形态解析：变体环境 PATH 上缺 cfuse 时落日志原地失败，不静默
    // 回退裸 claude（连不上 antcc 网关，回退只会把失败藏得更深）。
    let cli = match resolve_chat_cli(&home) {
        Ok(cli) => cli,
        Err(e) => {
            crate::log_line(&e);
            return Err(e);
        }
    };
    // workdir 落目录放调用方（resolve 保持纯判定）：变体 workdir 是
    // ~/.cc-pets（cfuse 禁 $HOME 作工作目录）；原生 workdir=home 已存在，
    // create_dir_all 幂等。失败落日志并原地返回——目录落不出，spawn 只会
    // 以更难读的「No such file or directory」失败。
    if let Err(e) = std::fs::create_dir_all(&cli.workdir) {
        let msg = format!(
            "failed to create chat workdir {}: {e}",
            cli.workdir.display()
        );
        crate::log_line(&msg);
        return Err(msg);
    }
    // 引擎 pid 补登的反查目录（与 watcher 同一口径）：claude_data_dir 探测
    // 出的数据目录下 sessions 子目录（原生 ~/.claude/sessions、变体
    // ~/.codefuse/engine/cc/sessions）。Init 后的补登线程按 sessionId 在
    // 这里反查引擎 pid。
    let sessions_dir = claude_data_dir(&home).join("sessions");
    // 引擎 pid 补登句柄：spawn 时 None；槽内 ChatProc 与 stdout 读线程
    // （→ Init 起的补登线程）共享同一 Arc，stop 经 ChatProc 读出。
    let engine_pid = Arc::new(Mutex::new(None::<u32>));
    let mut child = build_command(&cli)
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {e}", cli.program))?;

    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (Some(stdin), Some(stdout)) = (stdin, stdout) else {
        // 半启动失败：不留僵尸 claude
        crate::log_line("chat spawn aborted: claude spawned without piped stdio");
        let _ = child.kill();
        let _ = child.wait();
        return Err("claude spawned without piped stdio".to_string());
    };

    state
        .self_pids
        .lock()
        .expect("self_pids poisoned")
        .insert(pid);

    // stderr 环形缓冲（cap=50）：读线程与 ChatProc 各持一份 Arc（同一
    // 实例），进程退出时由收殓方（EOF 收尸 / chat_stop）快照落盘。读线程
    // 退出前发 done 信号；收殓方 kill/wait 或见 stdout EOF 都不构成 stderr
    // 收尾保证，故快照前以 recv_timeout 有界等待该信号（log_chat_exit）。
    let ring = Arc::new(StderrRing::new(50));
    let (err_tx, err_rx) = mpsc::channel::<()>();
    let mut stderr_join = None;
    if let Some(stderr) = stderr {
        let ring_for_stderr = Arc::clone(&ring);
        stderr_join = Some(std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                match line {
                    Ok(l) => ring_for_stderr.push(&l),
                    Err(_) => break,
                }
            }
            // 收尾信号；send 失败仅意味着接收端已 drop（无人等待）
            let _ = err_tx.send(());
        }));
    }

    *chat_slot().lock().expect("chat slot poisoned") = Some(Arc::new(ChatProc {
        child: Mutex::new(child),
        stdin: Arc::new(Mutex::new(stdin)),
        session_id: Mutex::new(None),
        engine_pid: Arc::clone(&engine_pid),
        stderr_ring: Arc::clone(&ring),
        stderr_join,
        stderr_done: Mutex::new(err_rx),
    }));

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
                    // 引擎 pid 补登（antcc 变体：注册表 <pid>.json 记的是引擎
                    // 子进程 pid，而非 spawn 的 cfuse 包装进程）。注册表落盘
                    // 晚于 init 行，后台线程有界轮询反查；命中 → 补进
                    // self_pids（面板过滤自身会话）+ 回填 ChatProc 的共享
                    // engine_pid 句柄（stop 双移除）。stop 先到：迟到写入只
                    // 落到无人再读的句柄，无误杀面；超限未命中：组杀按进程组
                    // 兜底，只损失面板过滤的完整性。
                    let sid = session_id.clone();
                    let dir = sessions_dir.clone();
                    let engine_slot = Arc::clone(&engine_pid);
                    let pids_for_engine = Arc::clone(&pids);
                    std::thread::spawn(move || {
                        for _ in 0..ENGINE_PID_SCAN_ATTEMPTS {
                            match scan_registry_for_session(&dir, &sid) {
                                Some(ep) => {
                                    crate::log_line(&format!("engine pid backfilled: {ep}"));
                                    pids_for_engine
                                        .lock()
                                        .expect("self_pids poisoned")
                                        .insert(ep);
                                    *engine_slot.lock().expect("engine_pid poisoned") = Some(ep);
                                    break;
                                }
                                None => std::thread::sleep(ENGINE_PID_SCAN_INTERVAL),
                            }
                        }
                    });
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
        // 读线程 EOF：claude 进程已退出。自然退出收殓：仅当槽里仍是自己
        // 这个实例才收走并落退出日志（防 spawn_chat 换新竞态下误收新
        // proc）；槽已空/换新 = chat_stop 已收殓，日志由 stop 路径落，这里
        // 保持幂等 no-op，防双份 stderr 落盘。
        let mut slot = chat_slot().lock().expect("chat slot poisoned");
        if slot
            .as_ref()
            .map(|p| p.child.lock().expect("chat child poisoned").id())
            == Some(pid)
        {
            if let Some(p) = slot.take() {
                // 兜底收尸防僵尸 + 落退出码与 stderr 缓冲（含对 stderr
                // 线程的有界收尾等待，见 log_chat_exit）
                let status = p.child.lock().expect("chat child poisoned").wait().ok();
                log_chat_exit(&p, status);
            }
        }
        drop(slot);
        pids.lock().expect("self_pids poisoned").remove(&pid);
    });

    crate::log_line(&format!("chat spawned (pid={pid})"));
    Ok(pid.to_string())
}

/// 重开会话（acceptance-fix-10）：杀现有会话进程并 spawn 全新进程——模型
/// 侧对话记忆随旧进程终止而丢失，属「重开」语义。前端在调用前已自行清
/// DOM/chatLog（chat-clear-history 事件）。只关心成败，pid 不外泄。
#[tauri::command(async)]
pub fn chat_restart(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    spawn_internal(&app, &state).map(|_| ())
}

/// 向常驻 claude 写一条 user 消息（双向 stream-json 协议）。
///
/// 锁纪律（评审红线）：槽锁只做「查空 + try_wait 活性检查 + clone Arc」，
/// 拿到 Arc 后必须先 drop 槽 guard 再碰 stdin——stdin 写可能阻塞（下游
/// 不读时管道写满即卡），绝不允许持槽锁跨这个阻塞点，否则并发
/// spawn_chat / chat_stop 会被拖死。
#[tauri::command(async)]
pub fn chat_send(text: String) -> Result<(), String> {
    // 只记长度不记内容：日志落盘的是诊断信息，不是对话记录
    crate::log_line(&format!("chat_send (len={})", text.len()));
    let line = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": text }
    });
    // ① 槽锁内：查空 → 活性检查 → clone Arc，随即出锁
    let proc = {
        let slot = chat_slot().lock().expect("chat slot poisoned");
        let p = slot
            .as_ref()
            .ok_or_else(|| "no chat process".to_string())?;
        // Ok(None) = 进程还活着；已退出/探测失败一律拒绝
        if !p
            .child
            .lock()
            .expect("chat child poisoned")
            .try_wait()
            .map_or(false, |st| st.is_none())
        {
            return Err("chat process not running".to_string());
        }
        Arc::clone(p)
    }; // ← 槽 guard 在此 drop；之后任何阻塞都与槽锁无关
    // ② stdin 锁：真正的写点
    let mut stdin = proc.stdin.lock().expect("stdin poisoned");
    writeln!(stdin, "{line}").map_err(|e| format!("write stdin failed: {e}"))?;
    stdin.flush().map_err(|e| format!("flush stdin failed: {e}"))?;
    Ok(())
}

/// 停止常驻 claude 对话进程（幂等：无实例也返回 Ok）。
#[tauri::command(async)]
pub fn chat_stop(state: State<'_, AppState>) -> Result<(), String> {
    crate::log_line("chat_stop");
    stop_internal(&state)
}

// ===== 测试 =====

#[cfg(test)]
mod tests {
    use super::*;

    // 命令构造测试（test_command_strips_claudecode_env）随 build_command
    // 迁至 cc_env.rs（原生形态断言原样保持，另补变体前缀形态钉）。

    #[test]
    fn test_parse_init() {
        let ev =
            parse_chat_line(r#"{"type":"system","subtype":"init","session_id":"s-1","model":"x"}"#);
        assert_eq!(
            ev,
            ChatEvent::Init {
                session_id: "s-1".to_string()
            }
        );
    }

    #[test]
    fn test_parse_init_session_id_fallback_key_still_works() {
        // T1 的 sessionId 回退键在 subtype init 门下保持有效
        assert_eq!(
            parse_chat_line(r#"{"type":"system","subtype":"init","sessionId":"s-2"}"#),
            ChatEvent::Init {
                session_id: "s-2".to_string()
            }
        );
    }

    #[test]
    fn test_parse_system_without_subtype_ignored_even_with_sid() {
        // 旧行为变更显式化（T2 收紧）：无 subtype 的 system 行即使带
        // session_id 也不再当 Init
        assert_eq!(
            parse_chat_line(r#"{"type":"system","session_id":"s-1"}"#),
            ChatEvent::Ignored
        );
    }

    #[test]
    fn test_parse_system_non_init_subtypes_ignored() {
        // system 行家族其他 subtype 都可能携带 session_id，不设门会被误当
        // 会话初始化（session_id 被其他会话 id 覆盖）
        assert_eq!(
            parse_chat_line(r#"{"type":"system","subtype":"hook_started","session_id":"s-1"}"#),
            ChatEvent::Ignored
        );
        assert_eq!(
            parse_chat_line(
                r#"{"type":"system","subtype":"thinking_tokens","session_id":"s-1","tokens":5}"#
            ),
            ChatEvent::Ignored
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

    #[test]
    fn test_stderr_ring_drops_oldest() {
        let ring = StderrRing::new(3);
        ring.push("a");
        ring.push("b");
        ring.push("c");
        ring.push("d");
        assert_eq!(
            ring.snapshot(),
            vec!["b".to_string(), "c".to_string(), "d".to_string()]
        );
    }

    #[test]
    fn test_stderr_ring_empty_snapshot() {
        let ring = StderrRing::new(50);
        assert_eq!(ring.snapshot(), Vec::<String>::new());
    }
}
