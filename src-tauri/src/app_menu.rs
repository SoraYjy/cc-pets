//! 应用级菜单（macOS 菜单栏）+ 设置窗口生命周期（v1.3.x Task 1）。
//!
//! 菜单在 setup 里构建并 `App::set_menu`（macOS = NSApp 主菜单，仅在应用
//! 任一窗口激活时可见，常规行为）。三个子菜单：
//! - **cc-pets**（app 子菜单）：「设置…」⌘,（自建项，按 id 分发）→ 打开
//!   设置窗口；分隔线；「隐藏 cc-pets」「退出 cc-pets」（原生 role）
//! - **编辑**：Copy / Paste / SelectAll（原生 role，输入框通用）
//! - **窗口**：Minimize / Zoom（原生 role）
//!
//! 「设置…」的窗口打开逻辑放 Rust 侧（plan 裁决：避免跨窗口事件时序问题
//! ——pet 页不必监听菜单事件再转发，点菜单即本线程直开）。
//!
//! 菜单事件不走 muda 内建的 id 派发器，全部汇到 `App::on_menu_event` 按
//! [`ID_OPEN_SETTINGS`] 匹配；预定义 role（Hide/Quit/Minimize/Zoom/
//! Copy/Paste/SelectAll）由系统 selector 直接执行，不产生自建事件。

use tauri::{
    App, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
};

/// 设置窗口 label（capabilities/default.json windows 数组同名——前端
/// `getByLabel` / Rust `get_webview_window` 都按它寻址）。改动必须同步
/// capabilities（tests::settings_label_is_listed_in_capabilities 卡住）。
pub const SETTINGS_LABEL: &str = "settings";

/// 设置窗口页面（vite 多页 input 同名，vite.config.ts / settings.html——
/// 漏接 rollup input 时 dev 偶然能跑、打包后 404，tests 卡住）。
pub const SETTINGS_PAGE: &str = "settings.html";

/// 「设置…」加速键。
pub const SETTINGS_ACCELERATOR: &str = "CmdOrCtrl+,";

/// 「设置…」菜单项 id（on_menu_event 派发键）。
pub const ID_OPEN_SETTINGS: &str = "open-settings";

/// 设置窗规格（plan Task 1）：内窗 360×420。
const SETTINGS_WIDTH: f64 = 360.0;
const SETTINGS_HEIGHT: f64 = 420.0;

/// 构建菜单并安装到应用，注册事件分发。setup 里调用一次。
///
/// 各子菜单给稳定 id（便于日志定位），role 项用 `SubmenuBuilder` 的预定义
/// 方法包装 `PredefinedMenuItem`——macOS 上对应原生 selector（hide:/terminate:/
/// performZoom: 等），标题用传入的自定义文案。
pub fn install(app: &App) -> tauri::Result<()> {
    let app_submenu = SubmenuBuilder::with_id(app, "submenu-app", "cc-pets")
        .item(
            &MenuItemBuilder::with_id(ID_OPEN_SETTINGS, "设置…")
                .accelerator(SETTINGS_ACCELERATOR)
                .build(app)?,
        )
        .separator()
        .hide_with_text("隐藏 cc-pets")
        .quit_with_text("退出 cc-pets")
        .build()?;

    let edit_submenu = SubmenuBuilder::with_id(app, "submenu-edit", "编辑")
        .copy()
        .paste()
        .select_all()
        .build()?;

    // plan 里写 Minimize/Zoom role。tauri 2.12.5 的菜单 API 没有 zoom 包装；
    // muda 层 zoom() 就是 maximize() 的别名，且 macOS 原生标题即 "Zoom"
    // （muda predefined: Maximize => "Zoom"），故用 .maximize() 承载 Zoom
    // role——原生语义一致。
    let window_submenu = SubmenuBuilder::with_id(app, "submenu-window", "窗口")
        .minimize()
        .maximize()
        .build()?;

    let menu = MenuBuilder::with_id(app, "menu-main")
        .item(&app_submenu)
        .item(&edit_submenu)
        .item(&window_submenu)
        .build()?;

    app.set_menu(menu)?;

    app.on_menu_event(|handle, event| {
        if event.id() == ID_OPEN_SETTINGS {
            open_settings_window(handle);
        }
    });
    Ok(())
}

/// 设置窗口 open 语义（plan Task 1）：已存在 → unminimize + show + set_focus；
/// 不存在 → `WebviewWindowBuilder` 创建（visible true，原生标题栏
/// decorations、resizable false、标题「cc-pets 设置」、内窗 360×420），
/// 创建成功后聚焦；创建失败记 debug 日志返回（不 panic——菜单点击不该
/// 有崩应用路径）。
///
/// 窗口所有权：close = hide（chat/sessions 同生命周期策略）。chat/sessions
/// 是无边框窗，close 入口是页面内 ×/Esc → 前端直接 `hide()`；settings 有
/// 原生标题栏，close 走系统按钮 → `CloseRequested` → 这里拦下 hide，窗口
/// 与页面状态保留（T2 的表单不因关闭丢失）。监听挂 Rust 侧（窗口在本模块
/// 创建，挂监听与创建同点完成，无时序竞态）。
pub fn open_settings_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(SETTINGS_LABEL) {
        crate::log_line("settings window exists → show+focus");
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }

    let win =
        match WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::App(SETTINGS_PAGE.into()))
            .title("cc-pets 设置")
            .inner_size(SETTINGS_WIDTH, SETTINGS_HEIGHT)
            .resizable(false)
            .decorations(true)
            .visible(true)
            .build()
        {
            Ok(w) => w,
            Err(e) => {
                crate::log_line(&format!("settings window create failed: {e}"));
                return;
            }
        };

    // close → hide：拦原生关闭按钮，prevent_close 后自己 hide（窗口保留，
    // 再点菜单走 show+focus 路径）。hide 失败不静默，落一行 debug 日志留
    // 时间线证据（chat 前端 hide() 失败同样具名落日志，口径一致）。
    let for_close = win.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            crate::log_line("settings close requested → hide");
            if let Err(e) = for_close.hide() {
                crate::log_line(&format!("settings hide failed: {e}"));
            }
        }
    });
    let _ = win.set_focus();
    crate::log_line("settings window created");
}

// ===== 测试 =====
//
// 菜单/窗口创建本身是集成行为（人工验收，plan Task 1 测试行）；这里只放
// 可在无头环境验证的契约测试：把跨文件接线点（capabilities / vite input）
// 用编译期内嵌字符串卡住——漏接线时 cargo test 直接红，而不是运行期静默 404。

#[cfg(test)]
mod tests {
    use super::{ID_OPEN_SETTINGS, SETTINGS_ACCELERATOR, SETTINGS_LABEL, SETTINGS_PAGE};

    /// settings 窗 label 必须在 capabilities windows 数组里——漏了则窗口
    /// 前端拿不到 core 权限（T2 的 invoke/listen 全数拒）。
    #[test]
    fn settings_label_is_listed_in_capabilities() {
        let cap = include_str!("../capabilities/default.json");
        assert!(
            cap.contains(r#""settings""#),
            "capabilities/default.json windows 数组必须含 \"settings\""
        );
    }

    /// settings.html 必须接进 vite 多页 input 的字面条目（key: value）——
    /// 只 contains 页面名会被注释豁免（T2 评审加固），漏了则 devServer 偶然
    /// 可跑、打包版打开设置窗 404。
    #[test]
    fn settings_page_is_registered_in_vite_inputs() {
        let vite = include_str!("../../vite.config.ts");
        assert!(
            vite.contains(r#"settings: "settings.html""#),
            r#"vite.config.ts rollupOptions.input 必须含字面条目 settings: "settings.html""#
        );
    }

    /// 对外契约常量冻结（plan Task 1 + 上游简报）：label / 页面 / 加速键 /
    /// 菜单事件 id 改动都是跨文件破坏性变更，测试先红。
    #[test]
    fn contract_constants_are_frozen() {
        assert_eq!(SETTINGS_LABEL, "settings");
        assert_eq!(SETTINGS_PAGE, "settings.html");
        assert_eq!(SETTINGS_ACCELERATOR, "CmdOrCtrl+,");
        assert_eq!(ID_OPEN_SETTINGS, "open-settings");
    }
}
