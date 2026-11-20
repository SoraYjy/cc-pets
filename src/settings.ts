// cc-pets 设置窗口骨架（v1.3.x Task 1）。
//
// 窗口由 Rust 侧创建与管理（src-tauri/src/app_menu.rs）：菜单「设置… ⌘,」
// open（已存在 → show+focus，不存在 → create），原生关闭按钮被
// CloseRequested 拦下转 hide——本页 webview 生命周期内只 load 一次，与
// chat/sessions 的 hide/show 生命周期策略对齐。
//
// Task 1 范围：载入后 invoke("get_settings") 回填四项到 settings.html 的
// 占位 DOM；不实现保存/控件交互（Task 2）。
//
// Task 2 接线点：
// - `window.__ccPetsSettings.loadSettingsIntoDom()` —— 打开时回填
//   （hide/show 生命周期下页面不重载，T2 若需重开刷新可复用）
// - `applySettingsToDom(s)` —— 保存后同步渲染
// - `Settings` 形状与 settings.html 的 DOM id 契约见下。

import { invoke } from "@tauri-apps/api/core";

/**
 * get_settings 返回形状 = src-tauri/src/settings.rs `Settings` 的 serde
 * 产物：petSkin 驼峰、pet_zoom 保持蛇形——历史字段名契约（chat ⚙ 与 pet
 * 页都按它消费），勿顺手统一。
 */
export interface Settings {
  style: string;
  opacity: number;
  petSkin: string;
  pet_zoom: number;
}

/** 单个占位行回填；元素缺失静默跳过（骨架期间 DOM 契约允许漂移）。 */
function setValue(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/** 把四项设置渲染进占位 DOM（id 契约见 settings.html）。幂等，可重复调用。 */
export function applySettingsToDom(s: Settings): void {
  setValue("value-style", s.style);
  setValue("value-opacity", s.opacity.toFixed(2));
  setValue("value-pet-skin", s.petSkin);
  setValue("value-pet-zoom", s.pet_zoom.toFixed(2));
}

/**
 * 读取当前设置并回填 DOM。读取失败不抛出（骨架只读展示，宁可空着别炸
 * 窗口），返回 null 供调用方判别；成功返回读到的值。
 */
export async function loadSettingsIntoDom(): Promise<Settings | null> {
  try {
    const s = await invoke<Settings>("get_settings");
    applySettingsToDom(s);
    return s;
  } catch (err) {
    console.error("get_settings failed:", err);
    return null;
  }
}

// T2 接线点：全局暴露（module scope 里 T2 的内联脚本/控件绑定取不到
// export，挂 window 才跨模块可达）。
declare global {
  interface Window {
    __ccPetsSettings: {
      applySettingsToDom: typeof applySettingsToDom;
      loadSettingsIntoDom: typeof loadSettingsIntoDom;
    };
  }
}
window.__ccPetsSettings = { applySettingsToDom, loadSettingsIntoDom };

// 载入即回填：窗口创建（visible true）与 hide 后再 show 都走这条——
// hide/show 不重载页面，重复调用幂等无害。
void loadSettingsIntoDom();
