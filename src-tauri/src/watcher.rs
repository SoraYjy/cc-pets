//! Watcher 纯逻辑：session 注册表解析、pid 存活检测、jsonl 行事件解析、
//! transcript 增量尾读分帧。不触碰文件系统 / 网络，全部可单测。
//!
//! 解析全部宽松：未知字段忽略、未知行型/非法 JSON/缺关键字段一律兜底
//! （None / LineEvent::Other），绝不 panic。实测基准：Claude Code 2.1.308。

use serde_json::Value;
use std::path::Path;

/// `~/.claude/sessions/<pid>.json` 的关键字段子集（camelCase 原始字段见解析函数）。
pub struct SessionEntry {
    pub pid: u32,
    pub session_id: String,
    pub cwd: String,
    pub name: String,
    pub status: String,
    pub updated_at_ms: u64,
}

/// 宽松解析一条 session 注册表 JSON。
/// 关键字段 pid / sessionId / cwd / name / status / updatedAt 任一缺失或类型
/// 不符 → None；多余字段忽略。
pub fn parse_session_entry(raw: &str) -> Option<SessionEntry> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let pid = u32::try_from(v.get("pid")?.as_u64()?).ok()?;
    let session_id = v.get("sessionId")?.as_str()?.to_string();
    let cwd = v.get("cwd")?.as_str()?.to_string();
    let name = v.get("name")?.as_str()?.to_string();
    let status = v.get("status")?.as_str()?.to_string();
    let updated_at_ms = v.get("updatedAt")?.as_u64()?;
    Some(SessionEntry {
        pid,
        session_id,
        cwd,
        name,
        status,
        updated_at_ms,
    })
}

/// 进程存活探测：unix 下 `kill(pid, 0)`（0 信号只做权限/存在性检查）；
/// 非 unix 恒 true，调用方以 staleness 兜底。
pub fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum LineEvent {
    /// assistant 行且 stop_reason == "end_turn"：携带 message.content 中
    /// 全部 type=="text" 项的 text 拼接（无 text 项为空串）。
    EndTurnText(String),
    /// system 行且 subtype == "turn_duration"：回合结束信号。duration_ms 取
    /// 行内 durationMs（缺失/非整数 → None）。
    TurnDuration {
        session_id: String,
        duration_ms: Option<u64>,
    },
    /// 其余一切（user / cost-state / 非法 JSON / 缺字段）。
    Other,
}

/// 宽松解析一行 transcript jsonl。未知/非法一律 [`LineEvent::Other`]。
pub fn parse_jsonl_line(raw: &str) -> LineEvent {
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return LineEvent::Other;
    };
    match v.get("type").and_then(Value::as_str) {
        Some("assistant") => {
            let msg = v.get("message");
            if msg.and_then(|m| m.get("stop_reason")).and_then(Value::as_str) != Some("end_turn") {
                return LineEvent::Other;
            }
            let mut text = String::new();
            if let Some(items) = msg.and_then(|m| m.get("content")).and_then(Value::as_array) {
                for item in items {
                    if item.get("type").and_then(Value::as_str) == Some("text") {
                        if let Some(t) = item.get("text").and_then(Value::as_str) {
                            text.push_str(t);
                        }
                    }
                }
            }
            LineEvent::EndTurnText(text)
        }
        Some("system") => {
            if v.get("subtype").and_then(Value::as_str) != Some("turn_duration") {
                return LineEvent::Other;
            }
            match v.get("sessionId").and_then(Value::as_str) {
                // 关键字段 sessionId 缺失/非字符串 → Other（与「缺字段兜底」一致）
                Some(sid) => LineEvent::TurnDuration {
                    session_id: sid.to_string(),
                    duration_ms: v.get("durationMs").and_then(Value::as_u64),
                },
                None => LineEvent::Other,
            }
        }
        _ => LineEvent::Other,
    }
}

/// transcript 增量尾读的分帧器：跨 feed 缓冲残行，按 `\n` 切出完整行。
///
/// `offset` 由调用方按 chunk 字节长度推进，[`Tailer::feed`] 自己不动它。
/// 边界说明：若某次 chunk 恰好把一个多字节 UTF-8 字符切成两半，残行落 buf
/// 时按 lossy 处理（极小概率；真实 transcript 整行 flush，不出现该切法）。
pub struct Tailer {
    pub offset: u64,
    pub buf: String,
}

impl Tailer {
    /// 喂入新读到的字节，返回其中全部完整行（不含 `\n`）；残行留在 `buf`。
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut data = Vec::with_capacity(self.buf.len() + chunk.len());
        data.extend_from_slice(self.buf.as_bytes());
        data.extend_from_slice(chunk);

        let mut lines = Vec::new();
        match data.iter().rposition(|&b| b == b'\n') {
            Some(last_nl) => {
                for line in data[..last_nl].split(|&b| b == b'\n') {
                    lines.push(String::from_utf8_lossy(line).into_owned());
                }
                self.buf = String::from_utf8_lossy(&data[last_nl + 1..]).into_owned();
            }
            // buf+chunk 全程无换行：整块内容留存 buf，等待后续 chunk 凑齐
            None => {
                self.buf = String::from_utf8_lossy(&data).into_owned();
            }
        }
        lines
    }
}

// ===== Task 6: 轮询循环 =====

/// cwd → projects 目录名编码：逐字符，非 ASCII 字母数字 → '-'。
fn encode_cwd(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// 当前 unix 时间（毫秒）。时钟回退等异常 → 0。
fn system_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 按 char_indices 安全截断到 max 个字符（不切多字节字符内部）。
fn truncate_chars(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((idx, _)) => s[..idx].to_string(),
        None => s.to_string(),
    }
}

/// 轮询循环：每 tick 扫描 `~/.claude/sessions/*.json`，聚合 working 状态发
/// `session-status`（首 tick 及变化时）；对每个存活 session 增量尾读
/// transcript，遇 turn_duration 行发 `turn-complete`（携带最近一次 end_turn
/// 文本摘要，截断 200 字符）。stop 置真后立即返回（分段 sleep，停止延迟
/// ≤200ms 有界）。
pub fn run_poller<E>(
    claude_dir: &Path,
    self_pids: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<u32>>>,
    interval: std::time::Duration,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    emit: E,
) where
    E: Fn(&str, serde_json::Value),
{
    use std::io::Read;
    use std::io::Seek;

    // sid → (尾读分帧器, 已读字节 offset)。offset 由本函数按读到的字节数推进。
    let mut tails: std::collections::HashMap<String, (Tailer, u64)> =
        std::collections::HashMap::new();
    // sid → 最近一次 end_turn 文本（turn_duration 行到达时取出作摘要）。
    let mut last_end_turn: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut prev_working: Option<bool> = None;

    loop {
        // stop 为真 → 立即返回
        if stop.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }

        // ---- 1. 扫描 sessions/*.json，过滤出存活且新鲜的 session ----
        let mut alive: Vec<(String, String, String)> = Vec::new(); // (sessionId, cwd, name)
        let mut any_busy = false;
        if let Ok(dir) = std::fs::read_dir(claude_dir.join("sessions")) {
            for entry in dir.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                let Ok(raw) = std::fs::read_to_string(&path) else {
                    continue; // 读失败跳过
                };
                let Some(e) = parse_session_entry(&raw) else {
                    continue; // 非法 JSON / 缺字段跳过
                };
                if !pid_alive(e.pid) {
                    continue;
                }
                // staleness 兜底（>60s 未心跳剔除；同时覆盖 EPERM 误判与 pid 回绕）
                if system_time_ms().saturating_sub(e.updated_at_ms) > 60_000 {
                    continue;
                }
                if self_pids.lock().expect("self_pids poisoned").contains(&e.pid) {
                    continue;
                }
                if e.status == "busy" {
                    any_busy = true;
                }
                alive.push((e.session_id, e.cwd, e.name));
            }
        }

        // ---- 2. working 状态聚合：首 tick 及变化时 emit ----
        let working = any_busy;
        if prev_working != Some(working) {
            prev_working = Some(working);
            emit(
                "session-status",
                serde_json::json!({ "working": working }),
            );
        }

        // ---- 3. 逐存活 session 增量尾读 transcript ----
        for (sid, cwd, name) in &alive {
            let path = claude_dir
                .join("projects")
                .join(encode_cwd(cwd))
                .join(format!("{}.jsonl", sid));
            let Ok(meta) = std::fs::metadata(&path) else {
                continue; // transcript 尚未创建
            };
            let len = meta.len();

            // 首次见到该 sid：offset 初始化为当前文件长度——「从现在开始听」，
            // 不重放历史。否则挂件启动/会话复活时，老多轮会话文件里的全部
            // turn_duration 行会被重放成 turn-complete/turn-summary 海量刷屏
            // （Task 6 deferred 重放问题的首启变体，round 5 关闭）。
            // 文件中途变小的重置逻辑不变（仍是从头重读）。
            let slot = tails
                .entry(sid.clone())
                .or_insert_with(|| (Tailer { offset: len, buf: String::new() }, len));
            if len < slot.1 {
                // 文件变小（重写/轮转）→ 重置该 sid 的 Tailer 与 offset，从头重读
                *slot = (Tailer { offset: 0, buf: String::new() }, 0);
            }
            if len <= slot.1 {
                continue; // 无新内容
            }

            let Ok(mut file) = std::fs::File::open(&path) else {
                continue;
            };
            if file.seek(std::io::SeekFrom::Start(slot.1)).is_err() {
                continue;
            }
            let want = (len - slot.1) as usize;
            let mut chunk = vec![0u8; want];
            let mut got = 0usize;
            while got < want {
                match file.read(&mut chunk[got..]) {
                    Ok(0) => break,
                    Ok(n) => got += n,
                    Err(_) => break, // 读中断：本轮放弃，offset 未推进，下轮重读
                }
            }
            if got == 0 {
                continue;
            }
            chunk.truncate(got);

            let lines = slot.0.feed(&chunk);
            slot.1 += got as u64;

            for line in lines {
                match parse_jsonl_line(&line) {
                    LineEvent::EndTurnText(s) => {
                        last_end_turn.insert(sid.clone(), s);
                    }
                    LineEvent::TurnDuration {
                        session_id,
                        duration_ms,
                    } => {
                        // 仅当行内 sessionId 与本文件归属 session 一致才发事件。
                        // name/durationMs 为会话上下文增量字段（acceptance
                        // round 4）：既有字段一律不动，前端按缺失容错。
                        if session_id == *sid {
                            let summary = last_end_turn.remove(sid).unwrap_or_default();
                            emit(
                                "turn-complete",
                                serde_json::json!({
                                    "sessionId": sid,
                                    "cwd": cwd,
                                    "summary": truncate_chars(&summary, 200),
                                    "name": name,
                                    "durationMs": duration_ms,
                                }),
                            );
                        }
                    }
                    LineEvent::Other => {}
                }
            }
        }

        // ---- 4. 尾读状态跨 staleness 间隙保留（acceptance round 2）----
        // 不再按本轮 alive 清理 tails/last_end_turn：注册表 updatedAt 只在
        // 状态迁移时刷新（实测 2.1.302/2.1.310：busy 期间心跳可冻结 82s/
        // 185s 以上），busy 超过 60s 的回合会被 staleness 剔出 alive——旧
        // 逻辑把尾读器一并销毁，回合结束心跳刷新重新入选时按「首见」从当
        // 前文件长度起跳，回合中段追加的 turn_duration 行被永久跳过，通知
        // 就此丢失。保留状态后，重新入选从上次 offset 续读，间隙内完成的
        // 回合照常出 turn-complete。状态量 = 见过的 sid 数（个位数字节 ×
        // 注册表条目数），内存可忽略；staleness 本身仍继续拦截 pid 回绕
        // （陈旧条目 updatedAt 老，不因 pid 复活变新鲜）。

        // ---- 5. 分段 sleep：每 ≤200ms 查一次 stop，保证停止延迟有界 ----
        let deadline = std::time::Instant::now() + interval;
        while !stop.load(std::sync::atomic::Ordering::Relaxed) {
            let now = std::time::Instant::now();
            if now >= deadline {
                break;
            }
            std::thread::sleep(std::cmp::min(
                std::time::Duration::from_millis(200),
                deadline - now,
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_garbage_line_is_other() {
        assert!(matches!(parse_jsonl_line("not json{"), LineEvent::Other));
        assert!(matches!(parse_jsonl_line("{}"), LineEvent::Other));
    }

    #[test]
    fn test_dead_pid_filtered() {
        assert!(pid_alive(std::process::id()));
        #[cfg(unix)]
        assert!(!pid_alive(u32::MAX / 2));
    }

    #[test]
    fn test_partial_line_buffered() {
        let mut t = Tailer {
            offset: 0,
            buf: String::new(),
        };
        assert_eq!(t.feed(b"line1\npar"), vec!["line1".to_string()]);
        assert_eq!(t.buf, "par");
        let lines = t.feed(b"tial\nline2\n");
        assert_eq!(lines, vec!["partial".to_string(), "line2".to_string()]);
        assert_eq!(t.buf, "");
    }

    #[test]
    fn test_no_newline_chunk_retained() {
        let mut t = Tailer {
            offset: 0,
            buf: String::new(),
        };
        // buf 空 + chunk 无换行 → 整块留存，不产出行
        assert_eq!(t.feed(b"par"), Vec::<String>::new());
        assert_eq!(t.buf, "par");
        // 残行 + 带换行 chunk → 凑齐出帧
        assert_eq!(t.feed(b"tial\n"), vec!["partial".to_string()]);
        // 出帧后 buf 空，再喂无换行 chunk → 继续留存
        assert_eq!(t.feed(b"line2"), Vec::<String>::new());
        assert_eq!(t.buf, "line2");
    }

    #[test]
    fn test_end_turn_extracts_text() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"thinking","text":"hmm"},{"type":"text","text":"你好"},{"type":"text","text":"世界"}]}}"#;
        match parse_jsonl_line(line) {
            LineEvent::EndTurnText(t) => assert_eq!(t, "你好世界"),
            other => panic!("expected EndTurnText, got {:?}", other),
        }
    }

    #[test]
    fn test_turn_duration_parsed() {
        match parse_jsonl_line(r#"{"type":"system","subtype":"turn_duration","sessionId":"abc-123"}"#)
        {
            LineEvent::TurnDuration {
                session_id,
                duration_ms,
            } => {
                assert_eq!(session_id, "abc-123");
                // durationMs 缺失 → None
                assert_eq!(duration_ms, None);
            }
            other => panic!("expected TurnDuration, got {:?}", other),
        }
    }

    #[test]
    fn test_turn_duration_with_ms() {
        match parse_jsonl_line(
            r#"{"type":"system","subtype":"turn_duration","sessionId":"abc","durationMs":42000}"#,
        ) {
            LineEvent::TurnDuration {
                session_id,
                duration_ms,
            } => {
                assert_eq!(session_id, "abc");
                assert_eq!(duration_ms, Some(42000));
            }
            other => panic!("expected TurnDuration, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_session_entry_ok_and_missing() {
        let raw = r#"{"pid":123,"sessionId":"s1","cwd":"/x/y","name":"widget-ef","status":"busy","updatedAt":1730000000000}"#;
        let e = parse_session_entry(raw).expect("complete entry should parse");
        assert_eq!(e.pid, 123);
        assert_eq!(e.session_id, "s1");
        assert_eq!(e.cwd, "/x/y");
        assert_eq!(e.name, "widget-ef");
        assert_eq!(e.status, "busy");
        assert_eq!(e.updated_at_ms, 1730000000000);

        // 删掉 status 字段 → 缺关键字段 → None
        let missing = r#"{"pid":123,"sessionId":"s1","cwd":"/x/y","name":"widget-ef","updatedAt":1730000000000}"#;
        assert!(parse_session_entry(missing).is_none());
    }
}

#[cfg(test)]
mod poller_tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    type Ev = (String, serde_json::Value);

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    /// 造 fixture：sessions/<pid>.json（pid=测试进程自身，保 pid_alive 通过）
    /// + projects/<encode(cwd)>/test-sid.jsonl（end_turn 文本行 + turn_duration 行）。
    /// 返回 cwd 字符串供断言用。
    fn make_fixture(dir: &std::path::Path, updated_at: u64) -> String {
        let pid = std::process::id();
        let cwd = dir.to_str().unwrap().to_string();

        let sess_dir = dir.join("sessions");
        std::fs::create_dir_all(&sess_dir).unwrap();
        let entry = format!(
            r#"{{"pid":{},"sessionId":"test-sid","cwd":"{}","name":"t","status":"busy","updatedAt":{}}}"#,
            pid, cwd, updated_at
        );
        std::fs::write(sess_dir.join(format!("{}.json", pid)), entry).unwrap();

        let proj_dir = dir.join("projects").join(encode_cwd(&cwd));
        std::fs::create_dir_all(&proj_dir).unwrap();
        let jsonl = concat!(
            r#"{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"任务完成摘要"}]}}"#,
            "\n",
            r#"{"type":"system","subtype":"turn_duration","sessionId":"test-sid"}"#,
            "\n",
        );
        std::fs::write(proj_dir.join("test-sid.jsonl"), jsonl).unwrap();
        cwd
    }

    /// 独立线程跑 run_poller（阻塞当前线程则收不到事件），返回 (rx, stop)。
    fn spawn_poller(claude_dir: &std::path::Path) -> (Receiver<Ev>, Arc<AtomicBool>) {
        let (tx, rx) = channel();
        let emit = move |e: &str, v: serde_json::Value| {
            let _ = tx.send((e.to_string(), v));
        };
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let dir = claude_dir.to_path_buf();
        thread::spawn(move || {
            run_poller(
                &dir,
                Arc::new(Mutex::new(HashSet::new())),
                Duration::from_millis(20),
                thread_stop,
                emit,
            );
        });
        (rx, stop)
    }

    /// 停轮询器并收干 channel 里剩余的全部事件（poller 退出后 tx drop →
    /// Disconnected，或超时兜底）。
    fn stop_and_drain(stop: &AtomicBool, rx: &Receiver<Ev>) -> Vec<Ev> {
        stop.store(true, Ordering::Relaxed);
        let mut events = Vec::new();
        loop {
            match rx.recv_timeout(Duration::from_secs(2)) {
                Ok(ev) => events.push(ev),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        events
    }

    /// 带超时等一个满足谓词的事件。
    fn wait_for(
        rx: &Receiver<Ev>,
        pred: impl Fn(&Ev) -> bool,
        timeout: Duration,
    ) -> Option<Ev> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.checked_duration_since(Instant::now())?;
            match rx.recv_timeout(remaining) {
                Ok(ev) => {
                    if pred(&ev) {
                        return Some(ev);
                    }
                }
                Err(RecvTimeoutError::Timeout) => return None,
                Err(RecvTimeoutError::Disconnected) => return None,
            }
        }
    }

    #[test]
    fn test_status_event_emitted() {
        let tmp = tempfile::tempdir().unwrap();
        make_fixture(tmp.path(), now_ms());
        let (rx, stop) = spawn_poller(tmp.path());

        let hit = wait_for(
            &rx,
            |(e, v)| e == "session-status" && *v == json!({"working": true}),
            Duration::from_secs(2),
        );
        stop_and_drain(&stop, &rx);
        assert!(
            hit.is_some(),
            "expected session-status working:true event"
        );
    }

    /// 首启不重放（round 5 新语义）：poller 首次见到已存在的 transcript 从
    /// 当前文件长度开始听，历史 turn_duration 不产生 turn-complete；
    /// 之后新增的 turn 正常出事件。
    #[test]
    fn test_first_sight_no_replay_then_append_emits() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = make_fixture(tmp.path(), now_ms());
        let (rx, stop) = spawn_poller(tmp.path());

        // 给足若干 tick 吃掉首扫：历史内容不得重放。
        // （只非阻塞收干 channel，poller 必须保持运行——后面还要看追加。）
        thread::sleep(Duration::from_millis(300));
        let mut drained: Vec<Ev> = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            drained.push(ev);
        }
        assert!(
            !drained.iter().any(|(e, _)| e == "turn-complete"),
            "history must not be replayed on first sight, got {:?}",
            drained
        );

        // 同一 poller 运行期间追加一个新 turn → 应出 turn-complete
        let appended = concat!(
            r#"{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"新增摘要"}]}}"#,
            "\n",
            r#"{"type":"system","subtype":"turn_duration","sessionId":"test-sid","durationMs":61000}"#,
            "\n",
        );
        let proj = tmp
            .path()
            .join("projects")
            .join(encode_cwd(&cwd))
            .join("test-sid.jsonl");
        let mut f = std::fs::OpenOptions::new().append(true).open(&proj).unwrap();
        use std::io::Write as _;
        f.write_all(appended.as_bytes()).unwrap();
        drop(f);

        let expected = json!({
            "sessionId": "test-sid",
            "cwd": cwd,
            "summary": "新增摘要",
            "name": "t",
            "durationMs": 61000,
        });
        let hit = wait_for(
            &rx,
            |(e, v)| e == "turn-complete" && *v == expected,
            Duration::from_secs(2),
        );
        stop_and_drain(&stop, &rx);
        assert!(
            hit.is_some(),
            "expected turn-complete for appended turn with payload {:?}",
            expected
        );
    }

    #[test]
    fn test_stale_entry_dropped() {
        let tmp = tempfile::tempdir().unwrap();
        // updatedAt 距今 120s > 60s 阈值 → 被剔。
        // 首 tick 语义：prev_working 初始 None，首 tick 必发一次 session-status，
        // 本例无存活 session，值应为 {"working": false}。断言两条：
        // 1) 全程无 {"working": true}；2) 收到过 {"working": false}。
        make_fixture(tmp.path(), now_ms() - 120_000);
        let (rx, stop) = spawn_poller(tmp.path());

        // 给足若干 tick（500ms / 20ms ≈ 25 tick），再停并收干
        thread::sleep(Duration::from_millis(500));
        let events = stop_and_drain(&stop, &rx);

        assert!(
            !events
                .iter()
                .any(|(e, v)| e == "session-status" && *v == json!({"working": true})),
            "stale entry must not produce working:true, got {:?}",
            events
        );
        assert!(
            events
                .iter()
                .any(|(e, v)| e == "session-status" && *v == json!({"working": false})),
            "first tick should emit working:false when no live session, got {:?}",
            events
        );
    }
}
