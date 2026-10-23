//! Watcher 纯逻辑：session 注册表解析、pid 存活检测、jsonl 行事件解析、
//! transcript 增量尾读分帧。不触碰文件系统 / 网络，全部可单测。
//!
//! 解析全部宽松：未知字段忽略、未知行型/非法 JSON/缺关键字段一律兜底
//! （None / LineEvent::Other），绝不 panic。实测基准：Claude Code 2.1.308。

use serde_json::Value;

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
    /// system 行且 subtype == "turn_duration"：回合结束信号。
    TurnDuration { session_id: String },
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
            LineEvent::TurnDuration { session_id } => assert_eq!(session_id, "abc-123"),
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
