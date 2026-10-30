# Lynn 桌宠 v1.1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 气泡对话升级：历史在应用生命周期内持久（关窗重开不丢）、stderr 不再悬空、chat_send 不卡 UI、纯工具回合有输出有分隔线、气泡窗三套可选主题（默认贴纸风 C）+ 透明度滑杆（设置持久化）。

**Architecture:** 历史由宠物窗（main.ts）持有并经新事件 `chat-history` 推给气泡窗；设置走 Rust 侧 settings.json（新模块 settings.rs + 两个 command）；chat.rs 把 stderr 挂进 50 行环形缓冲并随进程退出落日志，槽锁与 stdin 写锁分离、命令改 async；chat.css 三主题类 + `--win-alpha` 变量，chat.ts 头部 ⚙ 面板即时切换并保存。

**Tech Stack:** 既有栈（Tauri 2 / vanilla-ts / vitest / cargo test）；无新依赖。

**Spec:** 本计划 §设计定稿即规格（v1.1 设计在对话中批准，关键决策已内嵌 Global Constraints）；前版规格 docs/DESIGN.md 仍有效，Windows 为非目标。

## 设计定稿（批准记录）

- 历史 A 档：宠物窗内存数组 `{role:"user"|"assistant"|"system", text, ts}`，上限 200 条丢最旧；应用重启清空
- stderr：50 行环形缓冲，进程退出时连同 exit code 落 debug.log
- chat_send/chat_stop 改 async command；槽锁（Mutex<Option<Arc<ChatProc>>>）与 stdin 锁分离
- done 兜底：无打开中助手气泡且 done.text 非空 → 用该文本建助手气泡；之后总插分隔线
- 主题：theme-c（贴纸手账，默认，无头像）/ theme-a（漫画气泡，带头像+尾巴+打字点）/ theme-b（极简 IM）；窗体背景透明度 --win-alpha 0.3–1.0（默认 0.92）
- 设置面板：chat 窗头部 ⚙ 开合内嵌面板，改动即生效即保存（get_settings 打开时读，save_settings 变更时写）

## Global Constraints

- Mac only；Windows 全线非目标
- 既有事件契约（session-status/turn-complete/turn-summary/chat-event + spawn_chat/chat_send/chat_stop/append_debug 之外）零改动；**新增**仅：事件 `chat-history`（payload `{entries:[{role,text,ts}]}`，pet→chat，开窗时一次）与 `chat-user-message`（payload `{text}`，chat→pet，发送时）；**新增命令**仅 `get_settings` / `save_settings(style,opacity)`
- 历史上限 200；stderr 环形缓冲 50 行；默认 style "c"、默认 opacity 0.92；opacity 合法域 [0.3,1.0]；style 合法域 {"a","b","c"}（非法值归一化为 "c"）
- 主题类名 `theme-a|theme-b|theme-c` 挂 body；透明度走 CSS 变量 `--win-alpha`
- 不动 watcher.rs / assets/pet/ / scripts/；docs 仅 README 允许改；绝不运行 scripts/render_placeholder_pet.py
- 提交 message 末尾 `Co-Authored-By: Claude Code <noreply@anthropic.com>`；Rust 验证 `cargo test` + `cargo check`，前端 `npx vitest run` + `npm run build`
- .superpowers/ 为 SDD 工作区不入库；评审包命令沿用 v1 模式（log --format='%h %B' + stat + diff -U10）

## Review Focus

1. 历史超限：第 201 条进来必须丢第 1 条（Task 3 `test_push_capped_trims_oldest`）
2. settings.json 缺失/损坏/字段非法 → 回默认值不崩溃、不 panic（Task 1 `test_load_missing_file_defaults`、`test_load_corrupt_defaults`、`test_load_invalid_style_normalized`）
3. done 且 text 为空且无开气泡 → 只插分隔线，不出空气泡（Task 3 `test_done_fallback_decision`）
4. chat_send 与 spawn 并发：槽锁持有期间绝不执行 stdin 写（代码结构审查项：slot 取 Arc 后必须先 drop guard 再写，Task 2 评审重点）
5. 主题非法值经设置面板不可能传入，但手改 settings.json 可以 → 归一化 "c"（Task 1 已测，Task 4 应用侧同样走 normalize）

---

### Task 1: settings.rs 设置存储

**Files:**
- Create: `src-tauri/src/settings.rs`（含 `#[cfg(test)]`）
- Modify: `src-tauri/src/lib.rs`（`mod settings;` + invoke_handler 注册两命令）

**Interfaces:**
- Produces:
  - `#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)] pub struct Settings { pub style: String, pub opacity: f32 }`
  - `pub fn settings_path() -> PathBuf`（`dirs::home_dir()/.lynn-widget/settings.json`，目录在 save 时创建）
  - `pub fn load_from(path: &Path) -> Settings`（缺失/损坏/字段非法 → `Settings{style:"c".into(), opacity:0.92}`；style 非法归一 "c"；opacity 越域 clamp 进 [0.3,1.0]）
  - `pub fn save_to(path: &Path, s: &Settings) -> Result<(), String>`
  - `pub fn load() -> Settings` / `pub fn save(s: &Settings) -> Result<(), String>`（用 settings_path 的包装）
  - `#[tauri::command] pub fn get_settings() -> Settings`
  - `#[tauri::command] pub fn save_settings(style: String, opacity: f32) -> Result<(), String>`（style ∉ {"a","b","c"} → Err；opacity 越域 → clamp 后保存不报错）

- [ ] **Step 1:** 写失败测试（tempfile）：`test_load_missing_file_defaults`；`test_load_corrupt_defaults`（内容 "not json{"）；`test_load_invalid_style_normalized`（`{"style":"d","opacity":0.5}` → style=="c"）；`test_load_opacity_clamped`（opacity:2.0 → 1.0；opacity:0.1 → 0.3）；`test_save_then_load_roundtrip`（save {"b",0.5} → load 相等）
- [ ] **Step 2:** `cargo test` 确认 FAIL
- [ ] **Step 3:** 实现（settings.rs + lib.rs 注册）
- [ ] **Step 4:** `cargo test` 全 PASS；`cargo check`
- [ ] **Step 5:** Commit `feat: settings storage for chat style and opacity`

### Task 2: chat.rs stderr 环形缓冲 + 锁分离/async

**Files:**
- Modify: `src-tauri/src/chat.rs`（命令改 `#[tauri::command(async)]` 写在本文件）

**Interfaces:**
- Consumes: `crate::debug_log::log_line`
- Produces:
  - `pub struct StderrRing { /* Mutex<VecDeque<String>> + cap:usize */ }` + `pub fn new(cap: usize) -> Self` + `pub fn push(&self, line: &str)` + `pub fn snapshot(&self) -> Vec<String>`（cap=50；超限丢最旧）
  - ChatProc 字段改：`stdin: Arc<Mutex<ChildStdin>>`；全局槽改 `Mutex<Option<Arc<ChatProc>>>`
  - `spawn_chat` / `chat_send` / `chat_stop` 标 `#[tauri::command(async)]`；chat_send 流程：slot.lock() → Arc clone + try_wait 活性检查 → **drop guard** → stdin.lock().write_all+flush
  - stderr 读线程：BufReader 按行 push 进 StderrRing；进程退出（EOF 收尸或 chat_stop）时 `log_line` 落 `chat process exited (code=…)` + 环形缓冲内容（前缀 `[stderr] `，最多 50 行）

- [ ] **Step 1:** 写失败测试：`test_stderr_ring_drops_oldest`（cap=3 push 4 条 → snapshot 为后 3 条）；`test_stderr_ring_empty_snapshot`（空 ring → vec![]）
- [ ] **Step 2:** `cargo test` FAIL
- [ ] **Step 3:** 实现 StderrRing + 槽结构改造 + async 命令 + stderr 线程 + 退出落日志（6 枚既有 chat 测试与 16 枚全量必须保持 PASS——build_command/parse_chat_line 语义零改动）
- [ ] **Step 4:** `cargo test` 全 PASS；`cargo check`
- [ ] **Step 5:** Commit `feat: stderr ring buffer and lock-free chat send`

### Task 3: 气泡历史（A 档）+ done 兜底

**Files:**
- Create: `src/history.ts`、`src/history.test.ts`
- Modify: `src/main.ts`（chatLog + 两个新事件 + 开窗推历史）、`src/chat.ts`（渲染历史 + chat-user-message 上报 + done 兜底 + 分隔线恒插）

**Interfaces:**
- Consumes: 既有 chat-event / turn-summary
- Produces:
  - `src/history.ts`: `export interface ChatEntry { role: "user" | "assistant" | "system"; text: string; ts: string }`；`export function pushCapped<T>(arr: T[], item: T, cap: number): T[]`（push 后超 cap 从头部移除，返回同一数组引用）；`export function decideDoneFallback(doneText: string, hasOpenBubble: boolean): "bubble" | "separator-only"`（doneText 非空且 !hasOpenBubble → "bubble"，否则 "separator-only"）
  - main.ts: `chatLog: ChatEntry[]`（pushCapped cap=200）；listen("chat-user-message") → push user；listen("chat-event") 内 text 累积缓冲、done 定稿 push assistant（累积空且 done.text 非空用 done.text）；turn-summary 处 push system；openChatWindow 创建成功后 `emit("chat-history", { entries: [...chatLog] })`
  - chat.ts: listen("chat-history") → 清空消息区重渲染 entries；发送时本地回显之外 `emit("chat-user-message", { text })`；done 按 decideDoneFallback 兜底建气泡；**分隔线恒插**（不再依赖存在开气泡）

- [ ] **Step 1:** 写失败测试 `src/history.test.ts`：`test_push_capped_trims_oldest`（cap=3 push a,b,c,d → ["b","c","d"]）；`test_push_capped_under_cap_keeps_all`（cap=5 push 2 条 → 2 条）；`test_done_fallback_decision`（decideDoneFallback("文本",false)==="bubble"；decideDoneFallback("",false)==="separator-only"；decideDoneFallback("文本",true)==="separator-only"）
- [ ] **Step 2:** `npx vitest run` FAIL
- [ ] **Step 3:** 实现 history.ts + main.ts/chat.ts 接线
- [ ] **Step 4:** `npx vitest run` 全 PASS（含 sprite 6 枚）；`npm run build` EXIT=0
- [ ] **Step 5:** Commit `feat: in-memory chat history and done fallback`

### Task 4: 三主题 + 透明度 + 设置面板

**Files:**
- Create: `src/theme.ts`、`src/theme.test.ts`
- Modify: `src/chat.html`（头部加 ⚙ 按钮与设置面板骨架）、`src/chat.css`（theme-a/b/c 三套类 + --win-alpha + 面板样式，参照 assets/chat-style-mockup.html 的 A/B/C 配色逐项移植）、`src/chat.ts`（加载/应用/保存设置 + 面板交互）

**Interfaces:**
- Consumes: Task 1 `get_settings` / `save_settings(style,opacity)`；Task 3 历史渲染
- Produces:
  - `src/theme.ts`: `export function normalizeStyle(s: string | undefined): "a" | "b" | "c"`（非法 → "c"）与 `export function clampOpacity(n: number): number`（clamp [0.3,1.0]，NaN → 0.92）
  - body 类 `theme-a|theme-b|theme-c`（默认 theme-c）；`--win-alpha`（默认 0.92）；三主题窗体背景色：c=#fff8ec、a=rgba(24,28,44,·)、b=#1b2030，均乘 --win-alpha
  - 面板交互：⚙ toggle；三枚风格芯片点选即 apply+save；滑杆 input 即时 apply（CSS 变量）、change 时 save
- Test: `src/theme.test.ts`

- [ ] **Step 1:** 写失败测试 `src/theme.test.ts`：`test_normalize_style_valid`（"a"→"a"、"c"→"c"）；`test_normalize_style_invalid_defaults_c`（"d"→"c"、undefined→"c"）；`test_clamp_opacity`（2→1、0.1→0.3、0.7→0.7、NaN→0.92）
- [ ] **Step 2:** `npx vitest run` FAIL
- [ ] **Step 3:** 实现 theme.ts + chat.css 三主题（对照 mockup 移植）+ chat.html 面板 + chat.ts 加载/应用/保存
- [ ] **Step 4:** `npx vitest run` 全 PASS；`npm run build` EXIT=0；`cargo check`（settings 命令签名核对）
- [ ] **Step 5:** Commit `feat: three chat themes with opacity and settings panel`

### Task 5: 验收清单更新 + 人工验收

**Files:**
- Modify: `README.md`（v1.1 特性：三主题/透明度/历史语义 A 档/设置文件路径 `~/.lynn-widget/settings.json`；验收清单追加 ⑦⑧⑨）

**Interfaces:** 无

- [ ] **Step 1:** README 更新 + 追加验收项：⑦ 气泡开→说两轮→点 × 关→再点猫重开 → 历史还在（重启应用后清空属预期）；⑧ ⚙ 切换三主题与拖滑杆 → 即时生效，重启气泡后保持；⑨ 让 Lynn 跑一个纯工具回合（如「运行 ls 看看当前目录」）→ 气泡有输出且有分隔线
- [ ] **Step 2:** Commit `docs: v1.1 readme and acceptance items`
- [ ] **Step 3:** 【人工检查点】用户按 ⑦⑧⑨ 验收（另回归：点猫连点不再刷「会话已连接」、× 关闭正常、日志有 stderr 落盘）
