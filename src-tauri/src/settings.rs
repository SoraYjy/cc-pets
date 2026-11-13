use std::path::{Path, PathBuf};

/// 聊天窗设置：style 三选一（"a"|"b"|"c"，默认 "c"），opacity ∈ [0.3,1.0]（默认 0.92），
/// petSkin 宠物皮肤 id（默认 "default"，v1.2 多皮肤）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Settings {
    pub style: String,
    pub opacity: f32,
    #[serde(rename = "petSkin", default = "default_pet_skin")]
    pub pet_skin: String,
}

const DEFAULT_STYLE: &str = "c";
const DEFAULT_OPACITY: f32 = 0.92;
const OPACITY_MIN: f32 = 0.3;
const OPACITY_MAX: f32 = 1.0;
const DEFAULT_PET_SKIN: &str = "default";

fn default_pet_skin() -> String {
    DEFAULT_PET_SKIN.to_string()
}

fn defaults() -> Settings {
    Settings {
        style: DEFAULT_STYLE.into(),
        opacity: DEFAULT_OPACITY,
        pet_skin: default_pet_skin(),
    }
}

fn valid_style(s: &str) -> bool {
    matches!(s, "a" | "b" | "c")
}

fn clamp_opacity(o: f32) -> f32 {
    if o.is_nan() {
        return DEFAULT_OPACITY;
    }
    o.clamp(OPACITY_MIN, OPACITY_MAX)
}

/// 设置文件路径：`~/.lynn-widget/settings.json`（父目录在 save 时创建）。
pub fn settings_path() -> PathBuf {
    dirs::home_dir()
        .expect("home dir must exist")
        .join(".lynn-widget")
        .join("settings.json")
}

/// 宽松加载：文件缺失、JSON 损坏、字段缺失或非法都回默认值——
/// 设置读不出来不该崩桌面宠，宁可退到 style "c" + opacity 0.92。
/// style ∉ {"a","b","c"} 归一化 "c"；opacity 越域 clamp 进 [0.3,1.0]；
/// petSkin 空/空白归一化 "default"。petSkin **不**校验在可用皮肤集内——
/// 后端不知道 assets（皮肤集合归 pet.json 管），可用性由前端判断。
pub fn load_from(path: &Path) -> Settings {
    let Ok(text) = std::fs::read_to_string(path) else {
        return defaults();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return defaults();
    };
    let style = match v.get("style").and_then(|s| s.as_str()) {
        Some(s) if valid_style(s) => s.to_string(),
        _ => DEFAULT_STYLE.to_string(),
    };
    let opacity = v
        .get("opacity")
        .and_then(|o| o.as_f64())
        .map(|o| o as f32)
        .unwrap_or(DEFAULT_OPACITY);
    let pet_skin = match v.get("petSkin").and_then(|s| s.as_str()) {
        Some(s) if !s.trim().is_empty() => s.to_string(),
        _ => DEFAULT_PET_SKIN.to_string(),
    };
    Settings {
        style,
        opacity: clamp_opacity(opacity),
        pet_skin,
    }
}

/// 保存设置，自动创建父目录。
pub fn save_to(path: &Path, s: &Settings) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create settings dir failed: {e}"))?;
    }
    let text =
        serde_json::to_string_pretty(s).map_err(|e| format!("serialize settings failed: {e}"))?;
    std::fs::write(path, text).map_err(|e| format!("write settings failed: {e}"))
}

/// 用 settings_path() 的包装。
pub fn load() -> Settings {
    load_from(&settings_path())
}

/// 用 settings_path() 的包装。
pub fn save(s: &Settings) -> Result<(), String> {
    save_to(&settings_path(), s)
}

/// 前端打开设置面板时读取当前设置。
#[tauri::command]
pub fn get_settings() -> Settings {
    load()
}

/// 前端改动设置时保存；style 非法拒收（Err），opacity 越域 clamp 后照存不报错，
/// petSkin 空/空白归一化 "default" 后照存（不校验在皮肤集内，可用性归前端）。
#[tauri::command]
pub fn save_settings(style: String, opacity: f32, pet_skin: String) -> Result<(), String> {
    if !valid_style(&style) {
        return Err(format!("invalid style: {style} (expected a|b|c)"));
    }
    let pet_skin = if pet_skin.trim().is_empty() {
        DEFAULT_PET_SKIN.to_string()
    } else {
        pet_skin
    };
    save(&Settings {
        style,
        opacity: clamp_opacity(opacity),
        pet_skin,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(name);
        (dir, path)
    }

    #[test]
    fn test_load_missing_file_defaults() {
        let (_dir, path) = tmp("settings.json");
        assert_eq!(
            load_from(&path),
            Settings {
                style: "c".into(),
                opacity: 0.92,
                pet_skin: "default".into()
            }
        );
    }

    #[test]
    fn test_load_corrupt_defaults() {
        let (_dir, path) = tmp("settings.json");
        std::fs::write(&path, "not json{").expect("write");
        assert_eq!(
            load_from(&path),
            Settings {
                style: "c".into(),
                opacity: 0.92,
                pet_skin: "default".into()
            }
        );
    }

    #[test]
    fn test_load_invalid_style_normalized() {
        let (_dir, path) = tmp("settings.json");
        std::fs::write(&path, r#"{"style":"d","opacity":0.5}"#).expect("write");
        let s = load_from(&path);
        assert_eq!(s.style, "c");
        assert_eq!(s.opacity, 0.5);
    }

    #[test]
    fn test_load_opacity_clamped() {
        let dir = tempfile::tempdir().expect("tempdir");
        let hi = dir.path().join("hi.json");
        std::fs::write(&hi, r#"{"style":"a","opacity":2.0}"#).expect("write");
        assert_eq!(load_from(&hi).opacity, 1.0);
        let lo = dir.path().join("lo.json");
        std::fs::write(&lo, r#"{"style":"a","opacity":0.1}"#).expect("write");
        assert_eq!(load_from(&lo).opacity, 0.3);
    }

    #[test]
    fn test_load_empty_pet_skin_normalized() {
        // petSkin 空串 → 回 "default"（手改 settings.json / 旧版本缺字段同理）。
        // 不校验在皮肤集内：可用集归前端判断（pet.json skins）。
        let (_dir, path) = tmp("settings.json");
        std::fs::write(&path, r#"{"style":"a","opacity":0.5,"petSkin":""}"#).expect("write");
        let s = load_from(&path);
        assert_eq!(s.style, "a");
        assert_eq!(s.opacity, 0.5);
        assert_eq!(s.pet_skin, "default");
    }

    #[test]
    fn test_save_then_load_roundtrip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nested").join("settings.json");
        let s = Settings {
            style: "b".into(),
            opacity: 0.5,
            pet_skin: "official".into(),
        };
        save_to(&path, &s).expect("save");
        assert_eq!(load_from(&path), s);
    }
}
