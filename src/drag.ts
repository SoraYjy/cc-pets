// 自绘拖拽几何（v1.3 Task 2，test-infra 提取的纯函数层）：光标 → 窗口位置
// 的换算与钳制，全部物理像素，不触 DOM / Tauri IPC —— 可被 vitest 直测。
// main.ts 的状态机（见 setupPointerInteractions）负责取数与落窗。

export interface Physical {
  x: number;
  y: number;
}

// 显示器「可见区」矩形（物理像素）：macOS 上等价于 NSScreen.visibleFrame——
// 顶部为菜单栏下缘。来自 currentMonitor().workArea；workArea 缺失时由
// main.ts 以「完整 bounds − 菜单栏常高」兜底合成同构矩形。
export interface MonitorBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// mousedown 时一次性：光标 − 窗口原点（均物理坐标）。刚性拖拽不变量
// origin_new = cursor_new − (cursor₀ − origin₀)：每帧用「光标 − grabOffset」
// 反推窗口左上角，抓取点相对屏幕始终不动（随光标平移的是整窗）。
export function grabOffset(cursor: Physical, origin: Physical): Physical {
  return { x: cursor.x - origin.x, y: cursor.y - origin.y };
}

// 物理坐标过 IPC 前取整（「完全拖不动」实修）：macOS 光标物理坐标是分数
// （缩放分辨率下非整数 scaleFactor 所致），而 set_position 的 PhysicalPosition
// 参数是 i32——浮点直传每帧都被 IPC 参数校验拒绝。取整放 IPC 边界（调用侧），
// 纯函数层保持全精度数学可测。
export function roundPhysical(p: Physical): Physical {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

// 垂直目标拆分（「贴不到顶」终修 + 「重抓跳变」实修）：NSWindow
// .setFrameTopLeftPoint（tao set_position 的落点）会过 constrainFrameRect:
// toScreen:——窗口顶边被无声钳在屏幕顶，负 y 不可达。因此窗口 y ≥ 0，剩余
// 向上位移由精灵窗内上滑（shift ≤ 0）承担。
// 增量式（重抓零跳变）：头以「抓取瞬间的头位置」为基准跟随光标增量，
//   head = max(head₀ + dy, line)，dy = 光标纵向位移（逻辑 px）
//   winY = max(win₀ + dy, 0)，shift = head − winY − K
// 重抓瞬间 dy=0 → winY/win₀、shift/head₀−win₀−K 原值返回，位置连续；
// 下行时窗口先承接全部位移（shift 冻结在初值），贴顶后 shift 才加深。
export function splitVerticalTarget(
  cursorY: number, // 当前光标 y（物理 px）
  cursor0Y: number, // 抓取瞬间光标 y（物理 px）
  win0Y: number, // 抓取瞬间窗口 y（物理 px，≥0）
  sf: number,
  kLogical: number, // shift=0 时的猫头窗口内偏移（逻辑 px）
  head0Logical: number, // 抓取瞬间猫头全局位置（逻辑 px）
  headLineLogical: number, // 猫头钳制线（逻辑 px，菜单栏下缘）
): { winY: number; shift: number } {
  const dy = (cursorY - cursor0Y) / sf;
  const head = Math.max(head0Logical + dy, headLineLogical);
  const winYLogical = Math.max(win0Y / sf + dy, 0);
  const shift = head - winYLogical - kLogical;
  return { winY: winYLogical * sf, shift };
}

// 拖拽钳制（纯函数）：
// - 窗口矩形与可见区交集在水平/底部 ≥ margin（默认 48px，窗口永不整没）；
// - 顶部默认与左右同语义（窗口可悬挂越出直到只剩 margin）；但调用侧传
//   yMin（猫头基准钳制线）时顶界改用它——猫锚在窗底，「窗口留 margin」
//   会让猫身几乎整只滑进菜单栏（实测仅剩 ~9px 脚尖可见，用户感知为
//   「卡住/猫没了」）；yMin = 可见区顶 − 猫头窗口内偏移，猫头贴线即停；
// - 完全在屏内（交集两轴已达窗尺寸）→ 原样返回；
// - margin 对「窗口或显示器本身比 margin 还小」的退化场景自动收缩
//   （effMargin = min(margin, 窗宽, 窗高, 可见区宽, 可见区高)），保证钳制
//   区间不倒挂——不会出现负宽/负高的交集。
export function clampDrag(
  pos: Physical,
  winW: number,
  winH: number,
  bounds: MonitorBounds,
  margin = 48,
  yMin?: number,
): Physical {
  const effMargin = Math.min(margin, winW, winH, bounds.width, bounds.height);
  const xLo = bounds.x + effMargin - winW; // 窗右缘最多探出左界，留 effMargin 在屏内
  const xHi = bounds.x + bounds.width - effMargin; // 窗左缘探出右界前至少留 effMargin
  const yTop = yMin !== undefined ? yMin : bounds.y + effMargin - winH;
  const yBot = bounds.y + bounds.height - effMargin; // 底：至少留 effMargin 可见
  return {
    x: Math.min(Math.max(pos.x, xLo), xHi),
    y: Math.min(Math.max(pos.y, yTop), yBot),
  };
}
