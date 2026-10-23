# Lynn 桌宠挂件 v1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面常驻的 Lynn 猫挂件：按本机 Claude Code session 状态切动画（idle/working/done），任务完成发系统通知带结果摘要，点击弹气泡与自己 spawn 的 Claude Code session 流式对话。

**Architecture:** Tauri 2 单应用、双窗口（pet 192×208 透明置顶 + chat 气泡窗）。Rust 侧两个模块：watcher（2s 轮询 ~/.claude/sessions 与 projects/*.jsonl 增量尾读，发 session-status / turn-complete 事件）、chat（spawn 常驻 claude CLI 双向 stream-json，发 chat-event）。前端 vanilla-ts：精灵播放器 + 事件驱动状态机 + 气泡 UI。

**Tech Stack:** Tauri 2.x、vanilla-ts + Vite、vitest（前端纯逻辑）、cargo test（Rust）、tauri-plugin-notification、tauri-plugin-single-instance、serde_json、libc（unix pid 检测）、dirs、tempfile（dev-dep）

**Spec:** docs/DESIGN.md（监听方案、cc-connect 协议、窗口参数、坑清单均在其中）；美术资产规格见 docs/ART.md

## Global Constraints

- 不使用 --dangerously-skip-permissions；chat 固定 `--permission-mode acceptEdits`
- 绝不运行 `scripts/render_placeholder_pet.py`（会把 assets/pet/spritesheet.png 覆盖回占位猫）；`assets/pet/` 下两个文件是只读资产
- 事件与命令用本计划的确切字符串：emit `"session-status"` `{working:bool}`、`"turn-complete"` `{sessionId,cwd,summary}`、`"chat-event"` `{kind:"init"|"text"|"done",text}`；invoke `spawn_chat` / `chat_send(text)` / `chat_stop`
- 轮询间隔 2000ms（测试可参数化）；通知正文截断 200 字符
- identifier 固定 `com.sora.lynn`；pet 窗口 label `pet`，chat 窗口 label `chat`
- Rust 改动以 `cargo test`（src-tauri 下）验证，前端以 `npx vitest run` + `npm run build` 验证；每任务测试通过后 commit
- 版本前置：node ≥20、cargo/rustc 可用；缺失则中止该任务并报告，不得自行安装工具链

## Review Focus

1. jsonl 中出现非法 JSON 行或未知事件类型 → 宽松跳过不 panic（Task 5 `test_garbage_line_is_other`）
2. sessions/*.json 死进程残留条目 → pid 检测 + updated_at 60s 阈值剔除（Task 5 `test_dead_pid_filtered`、Task 6 `test_stale_entry_dropped`）
3. 挂件在 claude session 内启动导致环境含 CLAUDECODE → build_command 必须剥离，否则 CLI 拒绝启动（Task 7 `test_command_strips_claudecode_env`）
4. result 事件 subtype=="compact" 是回合中压缩不是结束 → 不算 Done（Task 7 `test_compact_result_ignored`）
5. 大 jsonl 追加半行 → Tailer 缓冲残行、增量读不整读文件（Task 5 `test_partial_line_buffered`）

---

### Task 1: 仓库基线

**Files:**
- Create: `.gitignore`、`README.md`（两行占位：项目名 + 指向 docs/DESIGN.md）

- [ ] **Step 1:** `git init`（main 分支）；写 `.gitignore`：`node_modules/`、`src-tauri/target/`、`dist/`、`__pycache__/`、`.DS_Store`
- [ ] **Step 2:** 提交现有基线（scripts/ assets/ docs/ .gitignore README.md），message: `chore: baseline assets, docs and asset scripts`
- [ ] **Step 3:** 验证 `git status` 干净、`git log --oneline` 有 1 条

### Task 2: Tauri 2 脚手架

**Files:**
- Create（脚手架生成到仓库根）: `package.json`、`vite.config.ts`、`index.html`、`src/`、`src-tauri/`（含 `tauri.conf.json`、`Cargo.toml`、`capabilities/`）

**Interfaces:**
- Produces: 可 `cargo check` 与 `npm run build` 的空壳应用；后续任务的窗口配置、依赖落点

- [ ] **Step 1:** 前置检查：`node --version`(≥20)、`npm --version`、`cargo --version`、`rustc --version` 全部可用，否则中止报告
- [ ] **Step 2:** 在 /tmp 下 `npm create tauri-app@latest -- lynn-tmp --template vanilla-ts --manager npm --identifier com.sora.lynn --yes`（若 CLI flag 不符以 `--help` 实际为准，目标是非交互生成 vanilla-ts 模板）；将生成内容（不含其 .git）移入仓库根，删除 lynn-tmp
- [ ] **Step 3:** tauri.conf.json 确认 identifier=com.sora.lynn；src-tauri/Cargo.toml 增加 `tauri-plugin-notification = "2"`、`tauri-plugin-single-instance = "2"`、`serde_json`、`libc = "0.2"`、`dirs`、dev-dep `tempfile`；lib.rs 注册两插件（single-instance 必须最先注册）；`npm install @tauri-apps/plugin-notification`
- [ ] **Step 4:** 验证 `cd src-tauri && cargo check` 通过；仓库根 `npm install && npm run build` 通过
- [ ] **Step 5:** Commit `feat: scaffold tauri 2 app (vanilla-ts)`

### Task 3: 精灵播放器

**Files:**
- Create: `src/sprite.ts`、`src/sprite.test.ts`
- Modify: `src/main.ts`（加载并显示 idle）

**Interfaces:**
- Produces: `export interface AnimationDef { name: string; row: number; frames: number; fps: number; loop: boolean }`；`export function frameAt(anim: AnimationDef, elapsedMs: number): number`（`Math.floor(elapsedMs/1000*fps) % frames`，loop=false 时 clamp 到 frames-1）；`export function offsetFor(row: number, col: number, cellW = 192, cellH = 208): string`（返回 `-${col*cellW}px -${row*cellH}px`）；`export function loadPet(baseUrl: string): Promise<{anims: AnimationDef[], sheet: string}>`（fetch pet.json + spritesheetPath 解析）

- [ ] **Step 1:** 安装 vitest（`npm i -D vitest`，package.json 加 `"test": "vitest run"`）；写失败测试：idle(4帧,3fps,loop) frameAt(0)=0、frameAt(334)=1、frameAt(1400)=0（回绕）；done(4帧,4fps,loop=false) frameAt(2000)=3（clamp）；offsetFor(0,1)="-192px 0px"、offsetFor(2,3)="-576px -416px"
- [ ] **Step 2:** `npx vitest run` 确认 FAIL
- [ ] **Step 3:** 实现 sprite.ts
- [ ] **Step 4:** `npx vitest run` PASS；main.ts：fetch(`/pet/pet.json`) 相对资产（dev 下把 public/ 指向 assets，vite.config.ts 设 `publicDir: "assets"`），requestAnimationFrame 播 idle，元素 192×208、background-size 1536px 832px、`image-rendering: pixelated`；`npm run build` 通过
- [ ] **Step 5:** Commit `feat: sprite player with pure frame math`

### Task 4: 宠物窗口与拖拽/点击

**Files:**
- Modify: `src-tauri/tauri.conf.json`（app.windows[0]：label "pet"、width 192、height 208、transparent、decorations false、shadow false、alwaysOnTop、skipTaskbar、resizable false）
- Modify: `src-tauri/capabilities/default.json`（core:default + `core:window:allow-start-dragging` + `notification:default`）
- Modify: `src/main.ts`（拖拽/点击判定）

**Interfaces:**
- Produces: 主窗口内 `mousedown→位移>4px→getCurrentWindow().startDragging()`（一次置 flag）；`mouseup 且位移≤4 且时长<400ms` → 触发本文件内 `onClickPet()` 回调（本任务仅 console.log）

- [ ] **Step 1:** 按上面配置窗口与 capabilities
- [ ] **Step 2:** main.ts 实现拖拽/点击判定
- [ ] **Step 3:** `cd src-tauri && cargo check`；`npm run build`
- [ ] **Step 4:** 【人工检查点】`npm run tauri dev`：透明窗只显示猫、可拖动、点击有 log
- [ ] **Step 5:** Commit `feat: pet window with drag and click`

### Task 5: watcher 纯逻辑

**Files:**
- Create: `src-tauri/src/watcher.rs`（含 `#[cfg(test)]` 测试）
- Modify: `src-tauri/src/lib.rs`（`mod watcher;`）

**Interfaces:**
- Produces:
  - `pub struct SessionEntry { pub pid: u32, pub session_id: String, pub cwd: String, pub name: String, pub status: String, pub updated_at_ms: u64 }`
  - `pub fn parse_session_entry(raw: &str) -> Option<SessionEntry>`（serde_json Value 宽松解析，缺关键字段→None）
  - `pub fn pid_alive(pid: u32) -> bool`（`#[cfg(unix)]` 用 libc::kill(pid,0)；非 unix 恒 true，由调用方 staleness 兜底）
  - `pub enum LineEvent { EndTurnText(String), TurnDuration { session_id: String }, Other }`
  - `pub fn parse_jsonl_line(raw: &str) -> LineEvent`：assistant 行且 `message.stop_reason=="end_turn"` → 拼接 `message.content[]` 中 `type=="text"` 的 text 为 EndTurnText；system 行且 `subtype=="turn_duration"` → TurnDuration；其余（含非法 JSON）→ Other
  - `pub struct Tailer { offset: u64, buf: String }` + `pub fn feed(&mut self, chunk: &[u8]) -> Vec<String>`（按 \n 分帧、残行留 buf、offset 由调用方按 chunk 长度推进）

- [ ] **Step 1:** 写失败测试：`test_garbage_line_is_other`（"not json{" → Other）；`test_dead_pid_filtered`（pid_alive(当前进程 pid)=true、pid_alive(极大不存在值) 在 unix 为 false）；`test_partial_line_buffered`（两次 feed 分半行，残行留 buf 不产出）；`test_end_turn_extracts_text`（fixture 行：assistant+end_turn+content[{"type":"text","text":"你好"}] → EndTurnText("你好")）；`test_turn_duration_parsed`；`test_parse_session_entry_ok_and_missing`
- [ ] **Step 2:** `cargo test` FAIL
- [ ] **Step 3:** 实现
- [ ] **Step 4:** `cargo test` PASS；`cargo check`
- [ ] **Step 5:** Commit `feat: watcher pure parsing and tail logic`

### Task 6: watcher 轮询循环

**Files:**
- Modify: `src-tauri/src/watcher.rs`（新增 poller）、`src-tauri/src/lib.rs`（setup 启动）

**Interfaces:**
- Consumes: Task 5 全部
- Produces: `pub fn run_poller<E>(claude_dir: &Path, self_pids: Arc<Mutex<HashSet<u32>>>, interval: Duration, stop: Arc<AtomicBool>, emit: E) where E: Fn(&str, serde_json::Value)`（emit 抽象成闭包，生产侧传 `|e,p| app.emit(e,p)`，测试侧收 channel）；启动后每 interval：扫描 `<claude_dir>/sessions/*.json` → parse → pid_alive 过滤 → `updated_at_ms` 距今 >60_000 剔除 → 排除 self_pids；聚合 `working = any(status=="busy")`，变化时 emit("session-status", {working})；对每个 session 维护 `HashMap<String, Tailer>`，tail `projects/<编码cwd>/<session_id>.jsonl`（编码规则：路径中非字母数字→'-'，即直接对 cwd 字符串逐字符替换）从上次 offset 读到末尾喂 Tailer；EndTurnText 暂存 last_end_turn[sid]，遇 TurnDuration{session_id} → emit("turn-complete", {sessionId, cwd, summary: last_end_take 截断 200 字符}) 并移除暂存

- [ ] **Step 1:** 写失败测试（tempfile 造 fixture：sessions/pid.json 一条 busy + 对应 projects 目录 jsonl 先写入 end_turn assistant 行 + turn_duration system 行）：`test_stale_entry_dropped`（updated_at 过期不计数）；`test_turn_complete_emitted_with_summary`（run_poller interval=20ms + channel，1s 内收到 turn-complete 且 summary 正确）；`test_status_event_emitted`
- [ ] **Step 2:** `cargo test` FAIL
- [ ] **Step 3:** 实现 run_poller + lib.rs setup 中以真实路径（`dirs::home_dir()/.claude`）、2000ms、真实 emit 启动后台线程（stop 由 app 退出触发）
- [ ] **Step 4:** `cargo test` PASS；`cargo check`
- [ ] **Step 5:** Commit `feat: session poller emitting status and turn-complete`

### Task 7: chat.rs 运行时

**Files:**
- Create: `src-tauri/src/chat.rs`
- Modify: `src-tauri/src/lib.rs`（mod + invoke_handler 注册 + RunEvent::ExitRequested 时 chat_stop）

**Interfaces:**
- Consumes: watcher 的 `self_pids: Arc<Mutex<HashSet<u32>>>`（spawn 后注册 child id）
- Produces:
  - `pub fn build_command(workdir: &Path) -> std::process::Command`：程序 "claude"，args `["--output-format","stream-json","--input-format","stream-json","--permission-prompt-tool","stdio","--replay-user-messages","--verbose","--permission-mode","acceptEdits"]`，`env_remove("CLAUDECODE")`，current_dir(workdir)，stdin/stdout/stderr piped；workdir = `dirs::home_dir()`
  - `pub enum ChatEvent { Init { session_id: String }, Text(String), Done(String), Ignored }`；`pub fn parse_chat_line(raw: &str) -> ChatEvent`：system→Init(session_id)；assistant→拼 text→Text；result 且 subtype=="compact"→Ignored；result 其他→Done(result 字段字符串)；非法/其他→Ignored
  - invoke：`spawn_chat()`（已存在先 kill 重启）、`chat_send(text: String)`（写 `{"type":"user","message":{"role":"user","content":<text>}}\n`，Mutex 护 stdin）、`chat_stop()`；读线程逐行 parse → emit("chat-event", {kind, text})，Init 的 session_id 存状态；Done 后**进程不退出**（保持多轮）
- [ ] **Step 1:** 写失败测试：`test_command_strips_claudecode_env`（get_env CLAUDECODE 不存在、args 顺序正确）；`test_parse_init`；`test_parse_assistant_text`；`test_compact_result_ignored`；`test_parse_done`；`test_garbage_ignored`
- [ ] **Step 2:** `cargo test` FAIL
- [ ] **Step 3:** 实现（kill 用 child.start_kill；Drop 兜底）
- [ ] **Step 4:** `cargo test` PASS；`cargo check`
- [ ] **Step 5:** Commit `feat: chat runtime spawning claude stream-json`

### Task 8: 气泡窗口 + 通知 + 状态接线

**Files:**
- Create: `chat.html`（根目录，与 index.html 同级）、`src/chat.ts`、`src/chat.css`
- Modify: `index.html`、`src/main.ts`、`vite.config.ts`（rollupOptions.input 多入口 chat）

**Interfaces:**
- Consumes: Task 3 sprite、Task 4 onClickPet、Task 6/7 事件与 invoke

- [ ] **Step 1:** vite 多入口 + chat.html 骨架（消息列表 + 输入框）
- [ ] **Step 2:** main.ts：`listen("pet-clicked")` → play("wave")（one-shot 回 idle）+ 若无则 `new WebviewWindow("chat", {url:"chat.html", width:340, height:420, decorations:false, transparent:true, alwaysOnTop:true, skipTaskbar:true})` 并按宠物 outerPosition 上方定位（clamp 进 monitor 可视区）+ `invoke("spawn_chat")`；`listen("session-status")` → play(working/idle)；`listen("turn-complete")` → play("done") + `sendNotification({title:"任务完成", body:summary})`
- [ ] **Step 3:** chat.ts：`listen("chat-event")` 追加流式文本（done 后加分隔）；Enter → invoke("chat_send",{text}) + 本地回显；窗口 onCloseRequested → invoke("chat_stop")
- [ ] **Step 4:** `npm run build` + `cargo check`；【人工检查点】dev 运行点击出气泡、能收发
- [ ] **Step 5:** Commit `feat: chat bubble window and notifications`

### Task 9: 端到端验收 + README

**Files:**
- Modify: `README.md`（构建运行方法、验收清单、换形象：生成网格图 → `python3 -I scripts/import_generated_sheet.py`）

- [ ] **Step 1:** 写 README
- [ ] **Step 2:** 【人工验收】`npm run tauri dev` 全清单：①猫 idle 呼吸 ②另开终端跑一个 claude 任务 → 变 working ③任务完成 → done 动画 + 系统通知含结果摘要 ④点猫 → wave + 气泡 ⑤气泡对话流式回复 ⑥退出后 `ps aux | grep claude` 无本挂件残留子进程。任一不过先修复再全量重验
- [ ] **Step 3:** Commit `docs: readme and acceptance checklist`
