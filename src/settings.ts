// cc-pets 设置窗口（v1.3.x Task 2：四项设置完整 UI + 事件接线）。
//
// 窗口由 Rust 侧创建与管理（src-tauri/src/app_menu.rs）：菜单「设置… ⌘,」
// open（已存在 → show+focus，不存在 → create），原生关闭按钮被
// CloseRequested 拦下转 hide——本页 webview 生命周期内只 load 一次，
// hide/show 不重载页面。
//
// 数据流（单向广播）：本窗改动 → save_settings（持久化全四项）+ 对应事件：
// - 皮肤        → skin-changed {skinId}        （pet 窗重载精灵，即时换肤）
// - 大小        → pet-zoom-changed {zoom}      （pet 窗实时缩放+命中映射）
// - 风格/透明度 → chat-appearance-changed {style, opacity}（chat 窗应用，
//   v1.3.x 新增事件——四项设置 UI 已自气泡 ⚙ 面板迁入本窗）
// 反向：本窗不监听任何回传；每次显示（重获焦点）时重新 get_settings 刷新
// 控件，防止 hide/show 不重载页面导致的滞后显示。

import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  clampOpacity,
  clampPetZoom,
  normalizePetSkin,
  normalizeStyle,
  type ThemeStyle,
} from "./theme";

/**
 * get_settings 返回形状 = src-tauri/src/settings.rs `Settings` 的 serde
 * 产物：petSkin 驼峰、pet_zoom 保持蛇形——历史字段名契约（save_settings
 * 入参用驼峰 petZoom，勿顺手统一）。
 */
export interface Settings {
  style: string;
  opacity: number;
  petSkin: string;
  pet_zoom: number;
}

// get_skins payload（src-tauri/src/skins.rs）：pet.json skins 映射，
// id（= settings.petSkin 值）→ { spritesheetPath, displayName }。
// 照搬 chat ⚙ 面板既有做法（get_skins 拉取，displayName 渲染芯片），
// 当前 pet.json 实际只有两枚（像素猫/lynn），不新增动态拉取机制。
interface SkinDefPayload {
  spritesheetPath: string;
  displayName: string;
}

type SkinsPayload = Record<string, SkinDefPayload>;

const styleChips = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".style-chips .chip"),
);
const skinChipsEl = document.getElementById("skin-chips") as HTMLElement;
const alphaRange = document.getElementById("alpha") as HTMLInputElement;
const alphaValue = document.getElementById("alpha-value") as HTMLElement;
const petZoomRange = document.getElementById("pet-zoom") as HTMLInputElement;
const petZoomValue = document.getElementById("pet-zoom-value") as HTMLElement;

// debug.log 时间线（与 chat/sessions 窗同款 logLine）。
function logLine(text: string): void {
  void invoke("append_debug", { line: text }).catch(() => {});
}

let currentStyle: ThemeStyle = "c";
let currentOpacity = 0.92;
let currentSkin = "default";
let currentPetZoom = 1.0;

// get_skins 结果缓存（终审 Nit-2）：applySettingsToControls 校验 petSkin
// 可用性用。get_skins 与 get_settings 到达顺序不定——启动路径只在
// get_skins.then 里校验一次，晚到的 get_settings 若带回手改的非法 petSkin
// 会出现「芯片无高亮」；缓存到位后任何一次回填都做可用性兜底。
let skinsCache: SkinsPayload | null = null;

// petSkin 可用性兜底：集合未知（get_skins 未到）或为空时不判；不在集内 →
// 回 default（Rust 侧刻意不校验可用性，见 settings.rs）。
function resolveAvailableSkin(id: string): string {
  if (skinsCache && Object.keys(skinsCache).length > 0 && !skinsCache[id]) {
    return "default";
  }
  return id;
}

function syncStyleChips(): void {
  for (const chip of styleChips) {
    chip.classList.toggle("active", chip.dataset.style === currentStyle);
  }
}

function syncSkinChips(): void {
  for (const chip of skinChipsEl.querySelectorAll<HTMLButtonElement>(".chip")) {
    chip.classList.toggle("active", chip.dataset.skin === currentSkin);
  }
}

// 把四项设置应用到控件（normalize/clamp 兜手改的 settings.json）。
// 幂等，启动载入与 show 后重读共用。
function applySettingsToControls(s: Settings): void {
  currentStyle = normalizeStyle(s.style);
  currentOpacity = clampOpacity(s.opacity);
  currentPetZoom = clampPetZoom(s.pet_zoom);
  currentSkin = resolveAvailableSkin(normalizePetSkin(s.petSkin));
  alphaRange.value = String(currentOpacity);
  alphaValue.textContent = String(currentOpacity);
  petZoomRange.value = String(currentPetZoom);
  petZoomValue.textContent = currentPetZoom.toFixed(2);
  syncStyleChips();
  syncSkinChips();
}

// 读失败时的兜底展示（= settings.rs 默认值），窗口不空着打开。
function applyDefaultsToControls(): void {
  applySettingsToControls({
    style: "c",
    opacity: 0.92,
    petSkin: "default",
    pet_zoom: 1.0,
  });
}

// 持久化当前四项；保存失败保留已应用的界面并落一行日志。
function saveSettings(): void {
  invoke("save_settings", {
    style: currentStyle,
    opacity: currentOpacity,
    petSkin: currentSkin,
    petZoom: currentPetZoom,
  }).catch((err: unknown) => {
    console.error("save_settings failed:", err);
    logLine(`[settings] save_settings failed: ${String(err)}`);
  });
}

// 风格/透明度统一走 chat-appearance-changed（chat 窗监听应用）。
function emitChatAppearance(): void {
  void emit("chat-appearance-changed", {
    style: currentStyle,
    opacity: currentOpacity,
  }).catch((err: unknown) => {
    console.error("chat-appearance-changed emit failed:", err);
    logLine(`[settings] chat-appearance-changed emit failed: ${String(err)}`);
  });
}

// ===== 风格芯片：点选即保存 + 广播 =====

for (const chip of styleChips) {
  chip.addEventListener("click", () => {
    currentStyle = normalizeStyle(chip.dataset.style);
    syncStyleChips();
    saveSettings();
    emitChatAppearance();
  });
}

// ===== 透明度滑杆：input 实时广播（chat 窗拖动全程平滑预览，与旧 ⚙ 滑杆
// 同手感），change 才 save（持久化）=====
alphaRange.addEventListener("input", () => {
  currentOpacity = clampOpacity(Number(alphaRange.value));
  alphaValue.textContent = String(currentOpacity);
  emitChatAppearance();
});
alphaRange.addEventListener("change", saveSettings);

// ===== 大小滑杆：input 实时广播 pet-zoom-changed（pet 窗实时 transform
// 缩放并同步命中映射），change 才 save（pet_zoom 持久化）=====
petZoomRange.addEventListener("input", () => {
  currentPetZoom = clampPetZoom(Number(petZoomRange.value));
  petZoomValue.textContent = currentPetZoom.toFixed(2);
  void emit("pet-zoom-changed", { zoom: currentPetZoom }).catch(
    (err: unknown) => {
      console.error("pet-zoom-changed emit failed:", err);
      logLine(`[settings] pet-zoom-changed emit failed: ${String(err)}`);
    },
  );
});
petZoomRange.addEventListener("change", saveSettings);

// ===== 皮肤芯片（照搬 chat ⚙ 既有链路）=====

// 点选皮肤：本地态更新 + save（持久化 petSkin）+ 全局广播 skin-changed——
// pet 窗监听后重新 loadPet 并重启精灵动画，换肤即时生效、无需重启。
function selectSkin(id: string): void {
  if (id === currentSkin) return;
  currentSkin = id;
  syncSkinChips();
  saveSettings();
  void emit("skin-changed", { skinId: id }).catch((err: unknown) => {
    console.error("skin-changed emit failed:", err);
    logLine(`[settings] skin-changed emit failed: ${String(err)}`);
  });
}

// 芯片从 get_skins 动态渲染；displayName 取 pet.json skins 映射，空则退回 id。
function renderSkinChips(skins: SkinsPayload): void {
  skinChipsEl.textContent = "";
  for (const [id, def] of Object.entries(skins)) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.skin = id;
    chip.textContent = def.displayName || id;
    chip.addEventListener("click", () => selectSkin(id));
    skinChipsEl.appendChild(chip);
  }
  syncSkinChips();
}

void invoke<SkinsPayload>("get_skins")
  .then((skins) => {
    skinsCache = skins; // 供 applySettingsToControls 做可用性兜底（Nit-2）
    // 可用集在前端判断：settings 里的 petSkin 若不在 skins 集 → 回 default
    //（Rust 侧刻意不校验，见 settings.rs）。此分支兜「get_settings 先到、
    // 当时缓存未建立」的顺序；skins 后到时当前选中值在这里复查。
    if (Object.keys(skins).length > 0 && !skins[currentSkin]) {
      currentSkin = "default";
    }
    renderSkinChips(skins);
  })
  .catch((err: unknown) => {
    // get_skins 失败（pet.json 读不出）：退一枚 default 芯片，面板仍可用。
    console.error("get_skins failed:", err);
    logLine(`[settings] get_skins failed: ${String(err)}`);
    renderSkinChips({
      default: { spritesheetPath: "spritesheet.png", displayName: "默认" },
    });
  });

// ===== 载入与 show 后重读 =====

// hide/show 不重载页面：每次显示（= 重获焦点，chat/sessions/main 窗同款
// onFocusChanged 感知）重新 get_settings 刷新控件，防上一轮改动滞后。
// 创建时机的 focused=true 事件先于本监听注册（chat.ts 同款踩坑），所以启动
// 仍走显式载入；监听只负责后续轮次。
async function reloadSettings(): Promise<void> {
  try {
    applySettingsToControls(await invoke<Settings>("get_settings"));
  } catch (err) {
    // 重读失败保留当前控件（瞬时失败不该重置用户视图），只留一行日志。
    console.error("get_settings failed:", err);
    logLine(`[settings] get_settings failed: ${String(err)}`);
  }
}

void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
  if (focused) void reloadSettings();
});

// 载入即回填：先落默认值（读不出来窗口也不空板），get_settings 到达后覆盖。
applyDefaultsToControls();
void reloadSettings();
