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

// mousedown 时一次性：光标 − 窗口原点（均物理坐标）。拖拽全程每帧用
// 「光标 + grabOffset」反推窗口左上角，抓取点在窗口内保持不动。
export function grabOffset(cursor: Physical, origin: Physical): Physical {
  return { x: cursor.x - origin.x, y: cursor.y - origin.y };
}

// 拖拽钳制（纯函数）：
// - 窗口矩形与可见区交集两轴 ≥ margin（默认 48px，猫永不整没）；
// - 左/右/底越界 → 钳到只剩 margin 可见的那条边界；
// - 顶部越界 → 钳到可见区顶（visibleFrame 顶，即菜单栏下缘）——非对称规则：
//   底部拖出半截可接受，顶部必须整窗可见，猫才能「贴住」菜单栏下缘；
// - 完全在屏内 → 原样返回；
// - margin 对「窗口或显示器本身比 margin 还小」的退化场景自动收缩
//   （effMargin = min(margin, 窗宽, 窗高, 可见区宽, 可见区高)），保证钳制
//   区间不倒挂——不会出现负宽/负高的交集。
export function clampDrag(
  pos: Physical,
  winW: number,
  winH: number,
  bounds: MonitorBounds,
  margin = 48,
): Physical {
  const effMargin = Math.min(margin, winW, winH, bounds.width, bounds.height);
  const xLo = bounds.x + effMargin - winW; // 窗右缘最多探出左界，留 effMargin 在屏内
  const xHi = bounds.x + bounds.width - effMargin; // 窗左缘探出右界前至少留 effMargin
  const yTop = bounds.y; // 顶：整窗不得高于可见区顶
  const yBot = bounds.y + bounds.height - effMargin; // 底：至少留 effMargin 可见
  return {
    x: Math.min(Math.max(pos.x, xLo), xHi),
    y: Math.min(Math.max(pos.y, yTop), yBot),
  };
}
