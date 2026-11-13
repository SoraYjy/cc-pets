//! 系统浏览器打开外链（v1.2 链接打开）。气泡里的 markdown 链接点击后由
//! 前端经本命令交给系统默认浏览器——Tauri 默认拦截跨源导航（点击无反应），
//! 所以绕道后端走 macOS `open`。
//!
//! 安全面：URL 白名单校验只放行 http/https（拒绝 file://、ftp://、
//! javascript: 等任意协议滥用）；`open` 不经过 shell、URL 以单参数传入，
//! 无注入面。

/// 校验外链 URL：必须以 `http://` 或 `https://` 开头，否则 Err 拒绝。纯
/// 函数抽出以便单测（`open` 的 Command 构建不进测试）。
pub fn validate_external_url(url: &str) -> Result<(), String> {
    if url.starts_with("http://") || url.starts_with("https://") {
        Ok(())
    } else {
        Err("only http/https urls are allowed".to_string())
    }
}

/// 打开系统默认浏览器。校验不过直接 Err；非成功退出状态同样报错（open 失
/// 败要能浮到前端 toast，而不是静默吞掉）。非 macOS 一律拒绝。
#[tauri::command(async)]
pub fn open_external(url: String) -> Result<(), String> {
    validate_external_url(&url)?;
    #[cfg(target_os = "macos")]
    match std::process::Command::new("open").arg(&url).status() {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("open exited with {status}")),
        Err(e) => Err(format!("spawn open failed: {e}")),
    }
    #[cfg(not(target_os = "macos"))]
    Err("unsupported platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_allows_http_and_https() {
        assert_eq!(validate_external_url("http://example.com"), Ok(()));
        assert_eq!(
            validate_external_url("https://example.com/docs/a?x=1#frag"),
            Ok(())
        );
    }

    #[test]
    fn test_validate_rejects_other_schemes_and_empty() {
        let denied = Err("only http/https urls are allowed".to_string());
        assert_eq!(validate_external_url("ftp://example.com"), denied);
        assert_eq!(validate_external_url("file:///etc/passwd"), denied);
        assert_eq!(validate_external_url("javascript:alert(1)"), denied);
        assert_eq!(validate_external_url(""), denied);
        // 相对路径 / 无协议裸串同拒
        assert_eq!(validate_external_url("relative/path"), denied);
        assert_eq!(validate_external_url("example.com"), denied);
    }
}
