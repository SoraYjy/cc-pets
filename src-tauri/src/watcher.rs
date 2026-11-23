//! Watcher 纯逻辑：session 注册表解析、pid 存活检测、jsonl 行事件解析、
//! transcript 增量尾读分帧。不触碰文件系统 / 网络，全部可单测。
//!
//! 解析全部宽松：未知字段忽略、未知行型/非法 JSON/缺关键字段一律兜底
//! （None / LineEvent::Other），绝不 panic。实测基准：Claude Code 2.1.308。

use serde_json::Value;
use std::path::Path;

/// session 注册表 `<数据目录>/sessions/<pid>.json` 的关键字段子集（camelCase
/// 原始字段见解析函数）。数据目录不在此硬编码——由调用方经
/// `cc_env::claude_data_dir` 解析注入（原生 `~/.claude`；配置了
/// `claudeDataDir` 则为变体数据目录）。
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

/// 从一条 transcript jsonl 行提取「当前活动」摘要（v1.3 Task 1）：assistant
/// 行（`isSidechain != true`，子代理行不算主会话活动）`message.content` 中
/// 首个 `type=="tool_use"` 块 → `"工具名: 参数摘要"`。参数取 input 中按
/// `command > file_path > description > pattern > url > query` 优先级首个
/// 存在且非空的字符串字段；全无 → 仅工具名。brief 连续空白折叠为单空格
/// （单行化）；拼接结果超 60 字符截断到 60 字符加 `…`。无 tool_use / 行型
/// 不符 → None。宽松解析，绝不 panic；单行化后为空（如 name 缺失且无参数
/// 的畸形块）→ None，不产空活动。
pub fn extract_activity(row: &serde_json::Value) -> Option<String> {
    if row.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    if row.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let content = row.get("message")?.get("content")?.as_array()?;
    let block = content
        .iter()
        .find(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))?;
    let name = block.get("name").and_then(Value::as_str).unwrap_or("");
    const PARAM_FIELDS: [&str; 6] = ["command", "file_path", "description", "pattern", "url", "query"];
    let brief = block
        .get("input")
        .and_then(|input| {
            PARAM_FIELDS.iter().find_map(|f| {
                input
                    .get(*f)
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
            })
        });
    let text = match brief {
        Some(b) => format!("{}: {}", name, b),
        None => name.to_string(),
    };
    // 单行化：连续空白（含换行/制表）折叠为一个空格
    let single = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if single.is_empty() {
        return None;
    }
    if single.chars().count() > 60 {
        Some(format!("{}…", truncate_chars(&single, 60)))
    } else {
        Some(single)
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
/// 仅非 unix 平台使用（acceptance-fix-13 主信号制：unix 以 kill-0 为唯一
/// liveness 信号，staleness 分支已不存在）。
#[cfg(not(unix))]
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

/// 轮询循环：每 tick 扫描 `<数据目录>/sessions/*.json`（数据目录由调用方
/// 经 `cc_env::claude_data_dir` 解析注入——原生 `~/.claude`；配置了
/// `claudeDataDir` 则为变体数据目录（本函数不感知具体路径），聚合 working 状态发
/// `session-status`（首 tick 及变化时）；对每个存活 session 增量尾读
/// transcript，遇 turn_duration 行发 `turn-complete`（携带最近一次 end_turn
/// 文本摘要，截断 4000 字符；系统通知由前端自行再截 200）。tick 末尾对
/// alive 列表整体发 `sessions-snapshot`（v1.2 Task 4：多会话视图面板数据源）。
/// stop 置真后立即返回（分段 sleep，停止延迟 ≤200ms 有界）。
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
    // sid → 最近一次工具活动摘要（v1.3 Task 1）：尾读到含 tool_use 的
    // assistant 行时更新；回合结束（idle）不清空——保留最后值。无值的
    // sid 不在 map（snapshot 写 null）。量级：每条 ≤61 字符 × sid 数。
    let mut last_activity: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut prev_working: Option<bool> = None;

    loop {
        // stop 为真 → 立即返回
        if stop.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }

        // ---- 1. 扫描 sessions/*.json，过滤出存活的 session（acceptance-
        // fix-13 主信号制：unix 只按 kill-0 剔除；非 unix 以 staleness 兜底）----
        // v1.2 Task 4：元组扩到五字段（sessionId, cwd, name, status,
        // updatedAtMs）——sessions-snapshot 需要完整行数据，working 聚合与
        // 尾读取用前三项不变。
        let mut alive: Vec<(String, String, String, String, u64)> = Vec::new();
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
                // staleness 兜底仅限非 unix（acceptance-fix-13 主信号制）：
                // unix 的 pid_alive 是真 kill(pid, 0)。实测 Claude Code busy
                // 时 updatedAt 心跳冻结（只在状态迁移时刷新），任务超 60s 就
                // 会被旧 staleness 误杀——working 聚合 / sessions-snapshot
                // 看不到它、忙中通知丢失。忙碌会话必须持续可见：unix 上
                // staleness 不再剔除。取舍（README 已知限制同步）：EPERM 误
                // 判活进程为死时该会话立即消失（macOS 同用户近乎不可达），
                // pid 回绕的幻影条目风险回到「罕见但存在」；非 unix 平台
                // pid_alive 恒 true，staleness 是唯一 liveness 信号（现状）。
                #[cfg(not(unix))]
                if system_time_ms().saturating_sub(e.updated_at_ms) > 60_000 {
                    continue;
                }
                if self_pids.lock().expect("self_pids poisoned").contains(&e.pid) {
                    continue;
                }
                if e.status == "busy" {
                    any_busy = true;
                }
                alive.push((e.session_id, e.cwd, e.name, e.status, e.updated_at_ms));
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
        for (sid, cwd, name, ..) in &alive {
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
                // v1.3 Task 1：活动提取。与 parse_jsonl_line 各自解析一次
                // （extract_activity 以 Value 为入参，纯函数契约）；行小、
                // 2s tick 量级，双解析成本可忽略。有新 tool_use 才更新，
                // 只 insert 不清空 → idle 后保留最后值。
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if let Some(a) = extract_activity(&v) {
                        last_activity.insert(sid.clone(), a);
                    }
                }
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
                        // 摘要上限 4000（acceptance round 6 解除截断）：气泡
                        // 内 md 全量渲染；系统通知由 main.ts 自行再截 200。
                        if session_id == *sid {
                            let summary = last_end_turn.remove(sid).unwrap_or_default();
                            emit(
                                "turn-complete",
                                serde_json::json!({
                                    "sessionId": sid,
                                    "cwd": cwd,
                                    "summary": truncate_chars(&summary, 4000),
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
        // 注册表条目数），内存可忽略。（acceptance-fix-13 后 unix 上已无
        // staleness 间隙——live 会话恒在 alive、持续续读；本保留机制在
        // unix 上仅剩「注册表重写瞬间」的窄窗，在非 unix 平台承担原职责。）

        // ---- 5. sessions-snapshot（v1.2 Task 4）：每 tick 末尾对 alive 列表
        // 整体 emit——右键猫呼出的会话面板数据源。payload 小（N×6 字段），
        // 2s 一次可接受；不做增量/去抖，面板按 status+project 排序自渲染。
        // v1.3 Task 1：字段扩到六项（+activity 最近工具活动）。
        // pet 自有 chat 进程（self_pids）沿用既有过滤、不进 alive——快照如实
        // 反映「对外可见的活跃 session」；行顺序即 read_dir 顺序，不保证。
        emit(
            "sessions-snapshot",
            serde_json::json!({
                "sessions": alive
                    .iter()
                    .map(|(sid, cwd, name, status, updated_at_ms)| {
                        serde_json::json!({
                            "sessionId": sid,
                            "cwd": cwd,
                            "name": name,
                            "status": status,
                            "updatedAtMs": updated_at_ms,
                            // v1.3 Task 1：最近工具活动（尾读最新一次
                            // tool_use 的摘要）；从未观测到 → null。字段
                            // 恒在场（不用 skip_serializing_if），前端按
                            // 「null 不渲染」处理。
                            "activity": last_activity.get(sid),
                        })
                    })
                    .collect::<Vec<serde_json::Value>>(),
            }),
        );

        // ---- 6. 分段 sleep：每 ≤200ms 查一次 stop，保证停止延迟有界 ----
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
    use serde_json::json;

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

    // ===== v1.3 Task 1: extract_activity =====

    /// 构造一条 assistant tool_use 行（sidechain=true 时加 isSidechain 标记）。
    fn tool_use_row(name: &str, input: serde_json::Value, sidechain: bool) -> serde_json::Value {
        let mut row = json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "name": name, "input": input},
                ],
            },
        });
        if sidechain {
            row["isSidechain"] = json!(true);
        }
        row
    }

    #[test]
    fn test_extract_activity_priority_tools() {
        // 简报测试清单：Bash(command) / Edit(file_path) / Read(file_path) /
        // Grep(pattern) 各取对应参数
        assert_eq!(
            extract_activity(&tool_use_row("Bash", json!({"command": "npm test"}), false)),
            Some("Bash: npm test".to_string())
        );
        assert_eq!(
            extract_activity(&tool_use_row("Edit", json!({"file_path": "/x/y.rs"}), false)),
            Some("Edit: /x/y.rs".to_string())
        );
        assert_eq!(
            extract_activity(&tool_use_row("Read", json!({"file_path": "/a/b.md"}), false)),
            Some("Read: /a/b.md".to_string())
        );
        assert_eq!(
            extract_activity(&tool_use_row("Grep", json!({"pattern": "foo"}), false)),
            Some("Grep: foo".to_string())
        );
        assert_eq!(
            extract_activity(&tool_use_row("WebSearch", json!({"query": "rust serde"}), false)),
            Some("WebSearch: rust serde".to_string())
        );
    }

    #[test]
    fn test_extract_activity_priority_order_and_empty_skip() {
        // command 优先于一切在场的字段
        let row = tool_use_row(
            "Bash",
            json!({"command": "c", "file_path": "f", "pattern": "p"}),
            false,
        );
        assert_eq!(extract_activity(&row), Some("Bash: c".to_string()));
        // command 空串 → 跳过，取下一个在场字段 file_path
        let row = tool_use_row("Bash", json!({"command": "", "file_path": "f"}), false);
        assert_eq!(extract_activity(&row), Some("Bash: f".to_string()));
        // command 非字符串 → 跳过
        let row = tool_use_row("Bash", json!({"command": 123, "file_path": "f"}), false);
        assert_eq!(extract_activity(&row), Some("Bash: f".to_string()));
    }

    #[test]
    fn test_extract_activity_truncates_over_60_chars() {
        let long = "x".repeat(80);
        let row = tool_use_row("Bash", json!({ "command": long }), false);
        let out = extract_activity(&row).expect("tool_use present");
        // 整条输出截断到 60 字符 + …（合计 61），前缀保留
        assert_eq!(out.chars().count(), 61);
        assert!(out.starts_with("Bash: "));
        assert!(out.ends_with('…'));
        // 恰 60 字符（"Bash: " + 54）不截断、无省略号
        let cmd54 = "y".repeat(54);
        let row = tool_use_row("Bash", json!({"command": cmd54}), false);
        let out = extract_activity(&row).expect("tool_use present");
        assert_eq!(out.chars().count(), 60);
        assert!(!out.ends_with('…'));
    }

    #[test]
    fn test_extract_activity_collapses_whitespace() {
        let row = tool_use_row(
            "Bash",
            json!({"command": "npm\ntest\t --filter   widget\n"}),
            false,
        );
        assert_eq!(
            extract_activity(&row),
            Some("Bash: npm test --filter widget".to_string())
        );
    }

    #[test]
    fn test_extract_activity_rejects_sidechain_and_non_assistant() {
        // isSidechain=true → None
        let row = tool_use_row("Bash", json!({"command": "c"}), true);
        assert_eq!(extract_activity(&row), None);
        // isSidechain=false 显式在场 → 照常提取
        let mut row = tool_use_row("Bash", json!({"command": "c"}), false);
        row["isSidechain"] = json!(false);
        assert_eq!(extract_activity(&row), Some("Bash: c".to_string()));
        // type=user（tool_result 行）→ None
        let row = json!({"type":"user","message":{"content":[{"type":"tool_result"}]}});
        assert_eq!(extract_activity(&row), None);
        // system 行 → None
        let row = json!({"type":"system","subtype":"turn_duration","sessionId":"s"});
        assert_eq!(extract_activity(&row), None);
    }

    #[test]
    fn test_extract_activity_none_when_no_tool_use() {
        let row = json!({
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "hello"}]},
        });
        assert_eq!(extract_activity(&row), None);
        // content / message 缺失 → None
        assert_eq!(extract_activity(&json!({"type":"assistant"})), None);
        assert_eq!(extract_activity(&json!({"type":"assistant","message":{}})), None);
    }

    #[test]
    fn test_extract_activity_tool_name_only() {
        // input 空对象 → 仅工具名
        assert_eq!(
            extract_activity(&tool_use_row("Bash", json!({}), false)),
            Some("Bash".to_string())
        );
        // 字段不在优先级清单内 → 仅工具名
        let row = tool_use_row("Bash", json!({"path": "/x", "other": "y"}), false);
        assert_eq!(extract_activity(&row), Some("Bash".to_string()));
        // input 缺失 → 仅工具名
        let row = json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}});
        assert_eq!(extract_activity(&row), Some("Bash".to_string()));
        // 畸形块（无 name 无参数）→ 单行化后为空 → None，不产空活动
        let row = json!({"type":"assistant","message":{"content":[{"type":"tool_use"}]}});
        assert_eq!(extract_activity(&row), None);
    }

    #[test]
    fn test_extract_activity_takes_first_tool_use_block() {
        let row = json!({
            "type": "assistant",
            "message": {"content": [
                {"type": "text", "text": "先说两句"},
                {"type": "tool_use", "name": "Read", "input": {"file_path": "/first.rs"}},
                {"type": "tool_use", "name": "Bash", "input": {"command": "second"}},
            ]},
        });
        assert_eq!(
            extract_activity(&row),
            Some("Read: /first.rs".to_string())
        );
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

    /// 造一个「确定已死」的真实 pid：spawn 一个立即退出的子进程并 wait 收尸。
    /// wait 后短时间内不会被系统复用，测试窗口内 kill-0 稳定失败。绝对路径
    /// spawn：PATH 劫持窗口内按名 spawn 会 posix_spawnp ENOENT 连坐。
    fn spawn_dead_pid() -> u32 {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("0")
            .spawn()
            .expect("spawn dead-pid helper (sleep 0)");
        let pid = child.id();
        let _ = child.wait();
        pid
    }

    /// 造 fixture：sessions/<pid>.json（pid 由调用方给——活测用测试进程 pid
    /// 保 pid_alive 通过，死测用 spawn_dead_pid）+ projects/<encode(cwd)>/
    /// test-sid.jsonl（end_turn 文本行 + turn_duration 行）。返回 cwd 供断言。
    fn make_fixture(dir: &std::path::Path, updated_at: u64, pid: u32) -> String {
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
        make_fixture(tmp.path(), now_ms(), std::process::id());
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
        let cwd = make_fixture(tmp.path(), now_ms(), std::process::id());
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

    /// 解除截断（acceptance round 6）：超长摘要按 4000 字符截断进
    /// turn-complete payload（旧上限 200）。
    #[test]
    fn test_summary_truncated_to_4000() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = make_fixture(tmp.path(), now_ms(), std::process::id());
        let (rx, stop) = spawn_poller(tmp.path());

        // 首扫吃掉 fixture（首见不重放），收干首批事件
        thread::sleep(Duration::from_millis(300));
        while rx.try_recv().is_ok() {}

        // 追加一个 5000 字符摘要的回合 → payload 摘要应为 4000 字符
        let long = "字".repeat(5000);
        let appended = format!(
            "{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"stop_reason\":\"end_turn\",\"content\":[{{\"type\":\"text\",\"text\":\"{long}\"}}]}}}}\n\
             {{\"type\":\"system\",\"subtype\":\"turn_duration\",\"sessionId\":\"test-sid\"}}\n"
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

        let hit = wait_for(
            &rx,
            |(e, v)| {
                e == "turn-complete"
                    && v["summary"].as_str().map(|s| s.chars().count()) == Some(4000)
            },
            Duration::from_secs(2),
        );
        stop_and_drain(&stop, &rx);
        assert!(
            hit.is_some(),
            "expected turn-complete with summary truncated to 4000 chars"
        );
    }

    #[test]
    fn test_stale_entry_dropped() {
        let tmp = tempfile::tempdir().unwrap();
        // acceptance-fix-13 主信号制：unix 上 staleness 不再剔除——死进程仍按
        // kill-0 剔除。fixture 用「确定已死」的真实 pid（sleep 0 + wait 收尸
        // ——spawn_dead_pid），120s 前的 updatedAt 同时覆盖非 unix 的
        // staleness 分支语义。
        // 首 tick 语义：prev_working 初始 None，首 tick 必发一次 session-status，
        // 本例无存活 session，值应为 {"working": false}。断言两条：
        // 1) 全程无 {"working": true}；2) 收到过 {"working": false}。
        make_fixture(tmp.path(), now_ms() - 120_000, spawn_dead_pid());
        let (rx, stop) = spawn_poller(tmp.path());

        // 给足若干 tick（500ms / 20ms ≈ 25 tick），再停并收干
        thread::sleep(Duration::from_millis(500));
        let events = stop_and_drain(&stop, &rx);

        assert!(
            !events
                .iter()
                .any(|(e, v)| e == "session-status" && *v == json!({"working": true})),
            "dead-pid entry must not produce working:true, got {:?}",
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

    // ===== L3 场景级 golden（测试基建）=====

    /// snapshot payload 里的 sessionId 列表（按字典序排——alive 顺序即
    /// read_dir 顺序不保证，前端按 status+project 排序显示）。
    fn snapshot_session_ids(v: &serde_json::Value) -> Vec<String> {
        let mut ids: Vec<String> = v["sessions"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|s| s["sessionId"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        ids.sort();
        ids
    }

    /// sessions 数组按 sessionId 排序后的副本，供集合式全等比较（顺序不进断言）。
    fn snapshot_sessions_sorted(v: &serde_json::Value) -> Vec<serde_json::Value> {
        let mut arr: Vec<serde_json::Value> =
            v["sessions"].as_array().cloned().unwrap_or_default();
        arr.sort_by_key(|s| s["sessionId"].as_str().unwrap_or("").to_string());
        arr
    }

    /// snapshot 是否与期望的 sessions 数组集合式相等（排序后比较）。
    fn snapshot_matches(v: &serde_json::Value, expected: &serde_json::Value) -> bool {
        snapshot_sessions_sorted(v) == snapshot_sessions_sorted(expected)
    }

    /// 带超时等一个满足谓词的事件，途中把路过的每个事件都记进 `seen`
    /// （golden 序列断言需要全程无丢弃的事件流）。
    fn recv_collect(
        rx: &Receiver<Ev>,
        pred: impl Fn(&Ev) -> bool,
        timeout: Duration,
        seen: &mut Vec<Ev>,
    ) -> Option<Ev> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.checked_duration_since(Instant::now())?;
            match rx.recv_timeout(remaining) {
                Ok(ev) => {
                    let hit = pred(&ev);
                    seen.push(ev.clone());
                    if hit {
                        return Some(ev);
                    }
                }
                Err(RecvTimeoutError::Timeout) => return None,
                Err(RecvTimeoutError::Disconnected) => return None,
            }
        }
    }

    /// 多 session 场景 fixture：写一个 session 注册表条目（pid 由调用方给，
    /// 文件名含 sid 避免同 pid 覆写）+ 对应 transcript，内含一轮已完成历史
    /// 回合（首见不重放语义下不会出事件）。返回 cwd 字符串供断言用。
    fn make_session(
        dir: &std::path::Path,
        pid: u32,
        sid: &str,
        name: &str,
        status: &str,
        updated_at: u64,
        history_summary: &str,
    ) -> String {
        let cwd = dir.join(format!("cwd-{}", sid)).to_str().unwrap().to_string();

        let sess_dir = dir.join("sessions");
        std::fs::create_dir_all(&sess_dir).unwrap();
        let entry = format!(
            r#"{{"pid":{},"sessionId":"{}","cwd":"{}","name":"{}","status":"{}","updatedAt":{}}}"#,
            pid, sid, cwd, name, status, updated_at
        );
        std::fs::write(sess_dir.join(format!("{}-{}.json", pid, sid)), entry).unwrap();

        let proj_dir = dir.join("projects").join(encode_cwd(&cwd));
        std::fs::create_dir_all(&proj_dir).unwrap();
        let jsonl = format!(
            "{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"stop_reason\":\"end_turn\",\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}}]}}}}\n\
             {{\"type\":\"system\",\"subtype\":\"turn_duration\",\"sessionId\":\"{}\"}}\n",
            history_summary, sid
        );
        std::fs::write(proj_dir.join(format!("{}.jsonl", sid)), jsonl).unwrap();
        cwd
    }

    /// 向 session 的 transcript 追加一轮完成（end_turn 文本 + turn_duration）。
    /// `root` 是 fixture 根目录（cwd 可能等于 root 本身——make_fixture 布局
    /// ——也可能在其下，故不能从 cwd 反推）。
    fn append_turn(
        root: &std::path::Path,
        cwd: &str,
        sid: &str,
        summary: &str,
        duration_ms: Option<u64>,
    ) {
        use std::io::Write as _;
        let proj = root
            .join("projects")
            .join(encode_cwd(cwd))
            .join(format!("{}.jsonl", sid));
        let dur = match duration_ms {
            Some(ms) => format!(r#","durationMs":{}"#, ms),
            None => String::new(),
        };
        let turn = format!(
            "{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"stop_reason\":\"end_turn\",\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}}]}}}}\n\
             {{\"type\":\"system\",\"subtype\":\"turn_duration\",\"sessionId\":\"{}\"{}}}\n",
            summary, sid, dur
        );
        let mut f = std::fs::OpenOptions::new().append(true).open(&proj).unwrap();
        f.write_all(turn.as_bytes()).unwrap();
    }

    /// 多 session 场景 golden（L3）：A busy / B idle / self-pid busy（pid 进
    /// self_pids）/ dead-pid busy（kill-0 剔除）/ frozen-heartbeat busy（心
    /// 跳冻结 90s，主信号制下必须可见）。A/B/frozen 用真实存活子进程 pid 或
    /// 测试进程 pid（self_pids 按 pid 排除，测试进程自己的 pid 进了集合，不
    /// 能复用给 A/B）；self 用测试进程 pid、dead 用 spawn_dead_pid。五者
    /// transcript 各预置一轮历史（首见不重放），随后按 A→B 顺序追加新回合。
    /// 预期事件序列恰好为：
    ///   [session-status{working:true}, turn-complete(A 全 payload), turn-complete(B)]
    /// 实现语义要点（以此为准固定为 golden）：
    /// - working:true 首 tick 必发（prev_working 初始 None ≠ Some(true)），
    ///   且 self-pid 的 busy 不计入聚合（self_pids 在 busy 聚合之前排除），
    ///   dead 的 busy 同样不计（kill-0 先剔）；frozen 的 busy **计入**——
    ///   主信号制下心跳冻结的活会话必须可见（acceptance-fix-13），A 已
    ///   busy 故 working 无翻转、无抖动；
    /// - A/B 顺序由「追加并等到上一事件后再追加下一个」构造性确定
    ///   （read_dir 同 tick 内的顺序不保证，不进 golden）；
    /// - 全程无第二个 session-status（A 恒存活恒 busy，working 无抖动），
    ///   无 history 重放、无 self/dead 洩漏（二者 transcript 各追加一回
    ///   合后 poller 继续跑 ≥5 tick——过滤若被删，追加回合必在窗口内出
    ///   turn-complete 使全等断言确定性变红；正确实现下窗口静默）；
    /// - sessions-snapshot 必须恰好携带 sid-a/sid-b/sid-frozen（frozen 的
    ///   心跳冻结不得再把它踢出；dead/self 永不得洩入）。
    #[test]
    fn test_golden_multi_session_scene() {
        let tmp = tempfile::tempdir().unwrap();
        let now = now_ms();
        // 存活探针子进程：sleep 自带限时，即使断言提前 panic 也会自行退出。
        let mut proc_a = std::process::Command::new("/bin/sleep")
            .arg("20")
            .spawn()
            .expect("spawn live-pid helper (sleep)");
        let mut proc_b = std::process::Command::new("/bin/sleep")
            .arg("20")
            .spawn()
            .expect("spawn live-pid helper (sleep)");
        // frozen 也要独立活 pid：golden 的 poller 把测试进程 pid 登记进了
        // self_pids（自有 chat 进程语义），frozen 若复用会被该过滤器剔除。
        let mut proc_frozen = std::process::Command::new("/bin/sleep")
            .arg("20")
            .spawn()
            .expect("spawn live-pid helper (sleep)");
        let dead_pid = spawn_dead_pid();
        let cwd_a = make_session(
            tmp.path(),
            proc_a.id(),
            "sid-a",
            "alpha",
            "busy",
            now,
            "A 历史回合",
        );
        let cwd_b = make_session(
            tmp.path(),
            proc_b.id(),
            "sid-b",
            "beta",
            "idle",
            now,
            "B 历史回合",
        );
        let cwd_self = make_session(
            tmp.path(),
            std::process::id(),
            "sid-self",
            "self",
            "busy",
            now,
            "self 历史回合",
        );
        let cwd_dead = make_session(
            tmp.path(),
            dead_pid,
            "sid-dead",
            "dead",
            "busy",
            now - 120_000,
            "dead 历史回合",
        );
        let _cwd_frozen = make_session(
            tmp.path(),
            proc_frozen.id(),
            "sid-frozen",
            "frozen",
            "busy",
            now - 90_000,
            "frozen 历史回合",
        );

        // spawn_poller 的 self_pids 为空集，这里需要登记 self-pid 语义 →
        // 自带一份带 self_pids 的启动（逻辑与 spawn_poller 相同）。
        let (tx, rx) = channel();
        let emit = move |e: &str, v: serde_json::Value| {
            let _ = tx.send((e.to_string(), v));
        };
        let stop = Arc::new(AtomicBool::new(false));
        let mut self_pids: HashSet<u32> = HashSet::new();
        self_pids.insert(std::process::id());
        {
            let dir = tmp.path().to_path_buf();
            let thread_stop = stop.clone();
            thread::spawn(move || {
                run_poller(
                    &dir,
                    Arc::new(Mutex::new(self_pids)),
                    Duration::from_millis(20),
                    thread_stop,
                    emit,
                );
            });
        }

        let mut seen: Vec<Ev> = Vec::new();

        // ① 首 tick session-status working:true
        let hit = recv_collect(
            &rx,
            |(e, v)| e == "session-status" && *v == json!({"working": true}),
            Duration::from_secs(2),
            &mut seen,
        );
        assert!(
            hit.is_some(),
            "first tick must emit session-status working:true, got {:?}",
            seen
        );

        // ② A 追加回合 → turn-complete（完整 payload：name + durationMs）
        append_turn(tmp.path(), &cwd_a, "sid-a", "A 新回合", Some(42000));
        let ta = json!({
            "sessionId": "sid-a",
            "cwd": cwd_a,
            "summary": "A 新回合",
            "name": "alpha",
            "durationMs": 42000,
        });
        let hit = recv_collect(
            &rx,
            |(e, v)| e == "turn-complete" && *v == ta,
            Duration::from_secs(2),
            &mut seen,
        );
        assert!(hit.is_some(), "expected turn-complete for A, got {:?}", seen);

        // ③ B 追加回合（durationMs 缺失 → payload null）
        append_turn(tmp.path(), &cwd_b, "sid-b", "B 新回合", None);
        let tb = json!({
            "sessionId": "sid-b",
            "cwd": cwd_b,
            "summary": "B 新回合",
            "name": "beta",
            "durationMs": serde_json::Value::Null,
        });
        let hit = recv_collect(
            &rx,
            |(e, v)| e == "turn-complete" && *v == tb,
            Duration::from_secs(2),
            &mut seen,
        );
        assert!(hit.is_some(), "expected turn-complete for B, got {:?}", seen);

        // ④ self / dead 的 transcript 也各追加一回合 —— 必须全程静默
        //（frozen 不追加：它是主信号制下必须可见的活会话，进 snapshot）。
        append_turn(tmp.path(), &cwd_self, "sid-self", "self 新回合", Some(1000));
        append_turn(tmp.path(), &cwd_dead, "sid-dead", "dead 新回合", Some(1000));

        // ⑤ 保持 poller 运行 ≥5 tick（100ms / 20ms）：给过滤回归留出确定性
        // 显形窗口。若 self_pids 过滤被删，self session 将被首见（offset=历
        // 史长度，跳过历史）并读走 ④ 的追加回合 → tc(self) 出现；若 kill-0
        // 剔除被删，dead session 同理出 tc(dead)。二者的 busy 即使计入聚合
        // 也不改变 working（A 已 busy，无翻转），故回归场景下 drain 恰好多
        // 出的只有 turn-complete——全等断言必红。正确实现下两腿在 metadata
        // 读之前即被 continue，追加内容永远不被读，窗口内确定性静默。
        thread::sleep(Duration::from_millis(100));

        // 收干并固定整场 golden：事件序列恰好为 [status, tc(A), tc(B)]，
        // 窗口与收干的全部事件在内一条不多。
        let rest = stop_and_drain(&stop, &rx);
        seen.extend(rest);
        // poller 已停，存活探针子进程即可收殓（sleep 自限时是兜底）。
        let _ = proc_a.kill();
        let _ = proc_b.kill();
        let _ = proc_frozen.kill();

        // ⑥ v1.2 Task 4：sessions-snapshot 每 tick 携行（独立事件流，payload
        // 形状由专门单测钉），golden 全等只针对 status/turn-complete 流——
        // 过滤后再比。快照自身的过滤语义另行断言：snapshot 必须恰好携带
        // sid-a/sid-b/sid-frozen（frozen 心跳冻结仍可见——主信号制回归钉），
        // self/dead 永不得洩入（快照级回归钉，与上面的尾读级 tc 静默互补——
        // 若 self_pids/kill-0 过滤被删，这里与 tc 双双显红）。
        assert!(
            seen.iter().any(|(e, _)| e == "sessions-snapshot"),
            "every tick must carry a sessions-snapshot, got {:?}",
            seen.iter().map(|(e, _)| e).collect::<Vec<_>>()
        );
        for v in seen
            .iter()
            .filter(|(e, _)| e == "sessions-snapshot")
            .map(|(_, v)| v)
        {
            assert_eq!(
                snapshot_session_ids(v),
                vec![
                    "sid-a".to_string(),
                    "sid-b".to_string(),
                    "sid-frozen".to_string()
                ],
                "snapshot must carry the live sessions incl. frozen-heartbeat one (self/dead excluded), got {v}"
            );
        }
        let streamed: Vec<Ev> = seen
            .iter()
            .filter(|(e, _)| e != "sessions-snapshot")
            .cloned()
            .collect();
        let golden = vec![
            ("session-status".to_string(), json!({"working": true})),
            ("turn-complete".to_string(), ta),
            ("turn-complete".to_string(), tb),
        ];
        assert_eq!(
            streamed, golden,
            "event sequence must match the golden multi-session scene"
        );
    }

    /// v1.2 Task 4：sessions-snapshot payload 单测（复用 golden fixture 布局）。
    /// 两 session（A busy / B idle，pid=测试进程自身，spawn_poller 的
    /// self_pids 为空集 → 均入选）：每 tick 的 snapshot 必须整体携带 alive
    /// 全部六字段（sessionId/cwd/name/status/updatedAtMs/activity；两会话
    /// 历史均无 tool_use → activity 恒 null——「字段恒在场、无值 null」的
    /// 契约由此钉住）。顺序说明：alive 顺序即 read_dir 顺序不保证（前端按
    /// status+project 排序显示），测试把 sessions 数组按 sessionId 排序后
    /// 做全等；drain 窗口内的每一条 snapshot 都断言——缺字段/多会话/漏
    /// 会话即红。
    #[test]
    fn test_sessions_snapshot_payload() {
        let tmp = tempfile::tempdir().unwrap();
        let now = now_ms();
        let pid = std::process::id();
        let cwd_a = make_session(tmp.path(), pid, "sid-a", "alpha", "busy", now, "A 历史回合");
        let cwd_b = make_session(tmp.path(), pid, "sid-b", "beta", "idle", now, "B 历史回合");
        let (rx, stop) = spawn_poller(tmp.path());

        let expected = json!({
            "sessions": [
                {
                    "sessionId": "sid-a",
                    "cwd": cwd_a,
                    "name": "alpha",
                    "status": "busy",
                    "updatedAtMs": now,
                    "activity": serde_json::Value::Null,
                },
                {
                    "sessionId": "sid-b",
                    "cwd": cwd_b,
                    "name": "beta",
                    "status": "idle",
                    "updatedAtMs": now,
                    "activity": serde_json::Value::Null,
                },
            ]
        });

        let hit = wait_for(
            &rx,
            |(e, v)| e == "sessions-snapshot" && snapshot_matches(v, &expected),
            Duration::from_secs(2),
        );
        let events = stop_and_drain(&stop, &rx);
        assert!(
            hit.is_some(),
            "expected a sessions-snapshot carrying exactly the two sessions with all fields, got {:?}",
            events
        );
        // 首条之后窗口内每一条 snapshot 都必须同样成立（alive 每 tick 稳定重建）。
        for (e, v) in events.iter().filter(|(e, _)| e == "sessions-snapshot") {
            assert!(
                snapshot_matches(v, &expected),
                "every snapshot must carry exactly the two sessions with all fields, got {e} {v}"
            );
        }
    }

    /// 排除间隙后续读（acceptance round 2 修复的回归钉，fix-13 形态适配）：
    /// session A 先入监听（首见 offset 记在历史长度）→ 注册表条目改指「确
    /// 定已死」的 pid（kill-0 剔出 alive——unix 上 staleness 已不参与剔除）
    /// → 间隙内 transcript 追加新回合 → 条目改回活 pid（会话重启/恢复场景）
    /// 重新入选后，尾读器/offset 必须跨间隙保留：补读间隙内回合
    ///（turn-complete 到达），且间隙前历史不重放。旧实现（间隙销毁尾读器、
    /// 复活按首见从当前长度起跳）在本测试下 turn-complete 永不到达而超时失败。
    #[test]
    fn test_staleness_gap_resumes_offset() {
        let tmp = tempfile::tempdir().unwrap();
        // make_fixture：busy session（sid=test-sid，pid=测试进程）+ 预置一轮
        // 历史回合（摘要「任务完成摘要」，首见不重放）。
        let cwd = make_fixture(tmp.path(), now_ms(), std::process::id());
        let (rx, stop) = spawn_poller(tmp.path());
        let mut seen: Vec<Ev> = Vec::new();

        // ① 首 tick working:true —— 同时确认 tick 1 已完成首见（offset 定在
        // 历史长度；此后任何追加都只能走增量读）。
        let hit = recv_collect(
            &rx,
            |(e, v)| e == "session-status" && *v == json!({"working": true}),
            Duration::from_secs(2),
            &mut seen,
        );
        assert!(
            hit.is_some(),
            "first tick must emit session-status working:true, got {:?}",
            seen
        );

        // ② 制造排除间隙：注册表条目改指「确定已死」的 pid → kill-0 剔除
        // ≥7 tick（updatedAt 保持 now——unix 上它已不参与剔除判定）。
        let dead_pid = spawn_dead_pid();
        let sess = tmp
            .path()
            .join("sessions")
            .join(format!("{}.json", std::process::id()));
        let stale = format!(
            r#"{{"pid":{},"sessionId":"test-sid","cwd":"{}","name":"t","status":"busy","updatedAt":{}}}"#,
            dead_pid,
            cwd,
            now_ms()
        );
        std::fs::write(&sess, stale).unwrap();
        thread::sleep(Duration::from_millis(150));

        // ③ 间隙内追加新回合（被剔期间不得读、不得发）。
        append_turn(tmp.path(), &cwd, "test-sid", "间隙内完成", Some(61000));

        // ④ 恢复：条目改回活 pid（会话重启/恢复）→ 重新入选，从保留的
        // offset 续读 → 间隙回合补发 turn-complete。
        let fresh = format!(
            r#"{{"pid":{},"sessionId":"test-sid","cwd":"{}","name":"t","status":"busy","updatedAt":{}}}"#,
            std::process::id(),
            cwd,
            now_ms()
        );
        std::fs::write(&sess, fresh).unwrap();

        let expected = json!({
            "sessionId": "test-sid",
            "cwd": cwd,
            "summary": "间隙内完成",
            "name": "t",
            "durationMs": 61000,
        });
        let hit = recv_collect(
            &rx,
            |(e, v)| e == "turn-complete" && *v == expected,
            Duration::from_secs(2),
            &mut seen,
        );
        let _ = stop_and_drain(&stop, &rx);

        assert!(
            hit.is_some(),
            "gap turn must be delivered after staleness recovery, got {:?}",
            seen
        );
        // 全程唯一的 turn-complete 就是间隙内那轮——间隙前历史不重放。
        let completes = seen
            .iter()
            .filter(|(e, _)| e == "turn-complete")
            .count();
        assert_eq!(
            completes, 1,
            "pre-gap history must not be replayed, got {:?}",
            seen
        );
        assert!(
            !seen
                .iter()
                .any(|(e, v)| e == "turn-complete" && v["summary"] == "任务完成摘要"),
            "pre-gap summary must never appear, got {:?}",
            seen
        );
    }

    /// 主信号制回归钉（acceptance-fix-13）：busy 会话 updatedAt 冻结在 90s
    /// 前（> 旧 60s staleness 阈值）、pid 真实存活（测试进程）→ 必须留在
    /// alive：sessions-snapshot 携带它（status=busy 如实透传）、working 聚合
    /// 为 true。旧实现（staleness 先剔）下 snapshot 永不含 sid-busy、working
    /// 恒 false——本测试必红。
    #[test]
    fn test_busy_frozen_heartbeat_stays_visible() {
        let tmp = tempfile::tempdir().unwrap();
        make_session(
            tmp.path(),
            std::process::id(),
            "sid-busy",
            "busy-90s",
            "busy",
            now_ms() - 90_000,
            "busy 历史回合",
        );
        let (rx, stop) = spawn_poller(tmp.path());

        // recv_collect 全程留痕：working:true（首 tick、先于 snapshot）与
        // snapshot 都要留在 seen 里供断言——wait_for 会丢弃非匹配事件。
        let mut seen: Vec<Ev> = Vec::new();
        let hit = recv_collect(
            &rx,
            |(e, v)| {
                e == "sessions-snapshot"
                    && snapshot_session_ids(v) == vec!["sid-busy".to_string()]
            },
            Duration::from_secs(2),
            &mut seen,
        );
        assert!(
            hit.is_some(),
            "frozen-heartbeat busy session must stay visible in the snapshot"
        );

        let rest = stop_and_drain(&stop, &rx);
        seen.extend(rest);
        assert!(
            seen.iter()
                .any(|(e, v)| e == "session-status" && *v == json!({"working": true})),
            "busy aggregation must count the frozen-heartbeat session, got {:?}",
            seen
        );
        let snapshot = hit.expect("checked above");
        assert_eq!(snapshot.1["sessions"][0]["status"], "busy");
    }

    /// v1.3 Task 1 端到端：snapshot 的 activity 新字段。首见不重放吃掉
    /// 历史 → 追加普通 tool_use 行 + sidechain tool_use 行（后者必须被
    /// 忽略——两行同 chunk 顺序处理，若 sidechain 行泄漏更新，最终值会是
    /// sidechain 的命令，精确断言即显红）→ snapshot 携带 "Bash: npm test"；
    /// 再追加一轮 turn（end_turn 文本 + turn_duration，即 idle 信号）→
    /// activity 保留最后值不清空。
    #[test]
    fn test_snapshot_activity_updated_and_retained_after_idle() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = make_session(
            tmp.path(),
            std::process::id(),
            "sid-act",
            "act",
            "busy",
            now_ms(),
            "历史回合",
        );
        let (rx, stop) = spawn_poller(tmp.path());

        // 首扫吃掉历史（首见不重放），收干首批事件
        thread::sleep(Duration::from_millis(300));
        while rx.try_recv().is_ok() {}

        // 追加：普通 tool_use 行 + isSidechain=true 的 tool_use 行
        let proj = tmp
            .path()
            .join("projects")
            .join(encode_cwd(&cwd))
            .join("sid-act.jsonl");
        let mut f = std::fs::OpenOptions::new().append(true).open(&proj).unwrap();
        use std::io::Write as _;
        f.write_all(
            concat!(
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}"#,
                "\n",
                r#"{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"sidechain cmd"}}]}}"#,
                "\n",
            )
            .as_bytes(),
        )
        .unwrap();
        drop(f);

        let expected = "Bash: npm test".to_string();
        let hit = wait_for(
            &rx,
            |(e, v)| {
                e == "sessions-snapshot"
                    && v["sessions"].as_array().map(|a| a.len()) == Some(1)
                    && v["sessions"][0]["activity"].as_str() == Some(expected.as_str())
            },
            Duration::from_secs(2),
        );
        assert!(
            hit.is_some(),
            "snapshot must carry the tool activity ({expected}), sidechain line ignored"
        );

        // idle：追加一轮完成（turn_duration 行到达 → turn-complete），
        // activity 必须保留最后值
        append_turn(tmp.path(), &cwd, "sid-act", "完成", Some(1000));
        let hit = wait_for(
            &rx,
            |(e, _)| e == "turn-complete",
            Duration::from_secs(2),
        );
        assert!(hit.is_some(), "idle turn must produce turn-complete");

        let events = stop_and_drain(&stop, &rx);
        assert!(
            events.iter().any(|(e, v)| e == "sessions-snapshot"
                && v["sessions"][0]["activity"].as_str() == Some(expected.as_str())),
            "activity must be retained after idle, got {:?}",
            events
        );
    }
}
