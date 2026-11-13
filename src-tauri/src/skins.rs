//! pet.json 的 skins 映射读取（v1.2 立绘多皮肤）。设置面板经 get_skins 拉取
//! 可用皮肤列表（displayName 渲染芯片、id 用于换肤）；精灵图本身仍由前端经
//! `/pet/` 静态路径加载——本模块只读映射，不碰 PNG。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// pet.json skins 映射的单个条目（id → 定义；id 即 settings 的 petSkin 值）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SkinDef {
    #[serde(rename = "spritesheetPath")]
    pub spritesheet_path: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
}

/// id 有序（BTreeMap），前端芯片组按此顺序渲染，"default" 稳定排最前。
pub type SkinMap = BTreeMap<String, SkinDef>;

/// pet.json 路径：仓库 `assets/pet/pet.json`（src-tauri 的父目录）。编译期
/// 锚定，不受运行时 cwd 影响（打包为非目标，见 v1.2 方案全局约束）。
fn pet_json_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must have a parent dir")
        .join("assets")
        .join("pet")
        .join("pet.json")
}

/// 解析 pet.json 文本 → skins 映射。无 skins 字段（旧版单皮肤结构）→ 合成
/// default 条目指向根 spritesheetPath；JSON 损坏 / skins 结构非法 → Err。
pub fn parse_skins(text: &str) -> Result<SkinMap, String> {
    let v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("parse pet.json failed: {e}"))?;
    let root_path = v
        .get("spritesheetPath")
        .and_then(|p| p.as_str())
        .unwrap_or("spritesheet.png")
        .to_string();
    match v.get("skins") {
        Some(skins) => serde_json::from_value(skins.clone())
            .map_err(|e| format!("parse pet.json skins failed: {e}")),
        None => {
            let mut map = SkinMap::new();
            map.insert(
                "default".to_string(),
                SkinDef {
                    spritesheet_path: root_path,
                    display_name: "默认".to_string(),
                },
            );
            Ok(map)
        }
    }
}

/// 前端设置面板拉取可用皮肤（id → {spritesheetPath, displayName}）。
#[tauri::command]
pub fn get_skins() -> Result<SkinMap, String> {
    let text = std::fs::read_to_string(pet_json_path())
        .map_err(|e| format!("read pet.json failed: {e}"))?;
    parse_skins(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_skins_mapping() {
        let text = r#"{
            "spritesheetPath": "spritesheet.png",
            "skins": {
                "default": {"spritesheetPath": "spritesheet.png", "displayName": "像素猫"},
                "official": {"spritesheetPath": "skins/official/spritesheet.png", "displayName": "official"}
            }
        }"#;
        let map = parse_skins(text).expect("parse");
        assert_eq!(map.len(), 2);
        assert_eq!(map["default"].display_name, "像素猫");
        assert_eq!(map["default"].spritesheet_path, "spritesheet.png");
        assert_eq!(
            map["official"].spritesheet_path,
            "skins/official/spritesheet.png"
        );
        // BTreeMap：default 稳定排最前（芯片组顺序）。
        let ids: Vec<&String> = map.keys().collect();
        assert_eq!(ids[0], "default");
    }

    #[test]
    fn test_parse_skins_missing_field_synthesizes_default() {
        // 旧版单皮肤 pet.json 没有 skins 字段 → 合成 default 指向根图。
        let text = r#"{"spritesheetPath": "spritesheet.png"}"#;
        let map = parse_skins(text).expect("parse");
        assert_eq!(map.len(), 1);
        assert_eq!(map["default"].spritesheet_path, "spritesheet.png");
    }

    #[test]
    fn test_parse_skins_corrupt_errors() {
        assert!(parse_skins("not json{").is_err());
        // skins 不是合法映射结构也要 Err，不静默吞。
        assert!(parse_skins(r#"{"skins": [1, 2]}"#).is_err());
    }

    #[test]
    fn test_repo_pet_json_has_default_skin() {
        // 仓库内 pet.json 冒烟：skins.default 必在（前端回退锚点）。
        let text = std::fs::read_to_string(pet_json_path()).expect("read repo pet.json");
        let map = parse_skins(&text).expect("parse repo pet.json");
        assert!(map.contains_key("default"));
        assert!(!map["default"].spritesheet_path.is_empty());
    }
}
