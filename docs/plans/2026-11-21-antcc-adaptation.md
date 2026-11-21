# cc-pets v1.0.1 拆分方案:antcc(自设数据目录 CC 变体)适配

> 状态:待 Sora 确认后开工(superpowers 流程:本方案 → 逐任务子代理实现+评审 → 人工验收在**公司环境**执行)
> 基线:HEAD=164466a(main,含 v1.3.x 原生设置窗口),远端已关联
> 依据:公司侧实测报告(2026-11,蚂蚁 antcc 环境)——数据格式与原生同构,差异集中在目录/启动链路/策略层

## 背景

antcc(蚂蚁内部 CC 变体)差异四点:①数据目录 `~/.codefuse/engine/cc`(格式与原生同构,多 startedAt/version/slug 等杂字段,宽松解析可直接读)②引擎须经 `cfuse --skip-update` 托管入口启动(PATH 上的 `claude` 连不上蚂蚁网关)③cfuse 禁止 `$HOME` 作工作目录;注册表 pid 是引擎子进程而非 cfuse 包装进程 ④hook/thinking 事件行也是 `type:"system"`+session_id(init 判定需收紧)。

**范围外(明确不做)**:SDK 入口会话(cc-connect 等桥接类)——注册表无 status/updatedAt、transcript 无回合结束信号,维持现状。

## 设计(公司报告口径,两个注入点 + 一处收紧 + 三件配套)

1. **数据目录探测**:`cc_env::claude_data_dir(home)`——`~/.codefuse/engine/cc/sessions` 是目录则用变体,否则回退 `~/.claude`。watcher 启动入参与聊天侧共用。变体与原生并存时只看变体(报告口径)。
2. **聊天 CLI 解析**:`cc_env::resolve_chat_cli(home)`——变体环境 → program=`cfuse`(PATH 探测,缺则**原地报错落日志,不静默回退**)、prefix_args=`["--skip-update"]`、workdir=`~/.cc-pets`(不存在则创建,cfuse 禁 $HOME);原生环境 → `claude`、无前缀、workdir=$HOME(现状不变)。
3. **组杀**:spawn 加 `process_group(0)`(unix,libc 已有依赖);stop_internal 的 kill 改为先 `libc::killpg(pid, SIGKILL)` 再 `child.kill()` 兜底再 wait——包装进程被杀不留孤儿引擎树。仅主动 kill 路径组杀(自然 EOF 不杀,避免 pgid 复用误伤)。
4. **引擎 pid 补登**:Init 事件后异步扫注册表按 sessionId 反查引擎 pid 补登 self_pids(15 次 × 400ms 退避;引擎写注册表晚于 init 行)。原生环境引擎 pid==spawn pid,重复插入幂等无害,统一执行。
5. **init 判定收紧**:system 行需 `subtype=="init"` 且有 session_id/sessionId 才算 Init;`hook_started`/`hook_response`/`thinking_tokens`/无 subtype → Ignored。原生 init 恒带 subtype,无损。

## 全局约束

- 解析层(watcher 的 parse_session_entry/parse_jsonl_line)零改动(格式同构)
- 既有事件契约零改动;原生环境(~/.codefuse 不存在)行为逐项与现状等价——**本机回归 + 公司环境验收双层**
- libc 已有依赖(0.2),process_group/killpg 不新增依赖
- 回归网:cargo 新增纯函数测试(目录探测三分支/CLI 解析含 PATH 缺失报错/init 收紧含 hook 噪音钉);`npm run test:all` 为门
- 每任务独立提交 + 评审;message 末尾 Co-Authored-By

## Task 1: cc_env 模块 + watcher/build_command 接线

**Files**: Create `src-tauri/src/cc_env.rs`(含 #[cfg(test)]);Modify `src-tauri/src/lib.rs`(mod 声明 + watcher claude_dir 改用探测)、`src-tauri/src/chat.rs`(build_command 改签名接 ChatCli;spawn_internal 用 resolve_chat_cli,Err 落日志原地返回)、`src-tauri/Cargo.toml`(如需)
**Interfaces**:
- `pub fn claude_data_dir(home: &Path) -> PathBuf`(探测口径见设计 1)
- `pub struct ChatCli { pub program: String, pub prefix_args: Vec<String>, pub workdir: PathBuf }` + `pub fn resolve_chat_cli(home: &Path) -> Result<ChatCli, String>`
- `pub fn build_command(cli: &ChatCli) -> Command`(原 args 顺序/env_remove("CLAUDECODE") 零改动;unix 加 `process_group(0)`;current_dir=cli.workdir)
- `pub fn scan_registry_for_session(sessions_dir: &Path, session_id: &str) -> Option<u32>`(lenient:遍历 `<pid>.json`,sessionId/session_id 匹配 → 文件名 pid;T2 使用,T1 一并交付+测试)
**测试**:目录探测三分支(变体在场/缺席/sessions 非目录)、CLI 解析(变体含 cfuse 在 PATH/变体缺 cfuse → Err 文案/原生回退)、scan_registry(命中/不命中/杂字段容忍)
**验收**:本机(~/.codefuse 不存在)cargo test 全绿,行为与现状等价

## Task 2: init 收紧 + 引擎 pid 补登 + 组杀 + 验收锚点文档

**Files**: Modify `src-tauri/src/chat.rs`(parse_chat_line 收紧;Init 事件处理补登线程;stop_internal 组杀)、`README.md`(公司环境验收锚点四条 + 变体适配说明)
**行为**:
- parse_chat_line:system 分支加 `subtype=="init"` 门;测试 fixture 更新(`test_parse_init` 补 subtype)+ 新钉:hook_started/thinking_tokens/无 subtype → Ignored
- stop_internal:`libc::killpg(pid, SIGKILL)` → `child.kill()` 兜底 → wait(仅主动 kill 路径;EOF 收尸路径不动)
- Init 事件处理:起后台线程,15 次 × 400ms 扫注册表按 sessionId 补登引擎 pid 进 self_pids(用 Task 1 的 scan_registry_for_session + claude_data_dir;命中即停)
- README:「antcc 环境适配」节(目录探测/CLI 解析/workdir 策略/pid 补登)+ 公司环境验收锚点四条(动画联动/通知/面板含过滤/退出无孤儿)
**测试**:parse 收紧钉(含旧行为变更:无 subtype 的 system 行从 Init → Ignored,fixture 更新)
**验收**:本机原生回归全绿;公司环境四锚点由 Sora/同事执行

## 顺序与依赖

T1(模块+接线)→ T2(事件层+组杀+文档)。版本号不动,公司环境验收通过后再打 v1.0.1。

## 明确非目标

SDK 入口会话适配、双目录并存监控、行型映射(格式不同构场景)、antcc 网关连通性调试
