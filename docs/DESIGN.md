# Lynn 桌宠挂件 · 技术设计（调研结论）

本文沉淀 widget 桌宠挂件的前期调研结论，作为后续实现的参考依据。美术资产规范见 [ART.md](./ART.md)。

## 0. 目标与首版范围

桌面小挂件（macOS + Windows）：

- 卡通形象常驻桌面，按 Claude Code session 状态切换动画（idle / working / done）；
- 任务完成时发系统通知 + 结果摘要；
- 点击宠物可与自己 spawn 的 Claude Code session 对话（气泡流式回复）。

**技术栈：Tauri 2。** 选型理由：

- 内存 / 体积优势明显；
- 文件监听与子进程管理在 Rust 侧成熟；
- 参照项目 [ayangweb/BongoCat](https://github.com/ayangweb/BongoCat)（24k★）在同场景（透明桌面挂件 + Tauri 2）下已验证可行。

Electron 作为纯 TS 团队的备选方案保留。

## 1. 监听所有 Claude Code session（零配置方案）

不修改任何 Claude Code 配置，仅监听其磁盘产物即可感知所有 session 状态。

### 1.1 数据来源

**Session 注册表：`~/.claude/sessions/<pid>.json`**

活跃 session 注册表（实测 Claude Code 2.1.308），每个存活进程一个文件，字段：

| 字段 | 说明 |
| --- | --- |
| `pid` | 进程号（即文件名） |
| `sessionId` | 会话 ID |
| `cwd` | 工作目录 |
| `name` / `kind` | 会话名 / 类型 |
| `status` | `"busy"` 或 `"idle"` |
| `startedAt` / `updatedAt` | 起止时间戳 |
| `messagingSocketPath` | 消息 socket，形如 `/tmp/cc-socks/<pid>.sock` |

**坑：** 进程死后 json 文件残留（僵尸条目），需用 `ps -p <pid>` 或检查 socket 文件存在性来剔除。

**Transcript：`~/.claude/projects/<编码路径>/<sessionId>.jsonl`**

- 逐行 JSON、整行 flush、纯 append——可放心按 byte offset 增量读；
- 路径编码规则：非字母数字字符一律替换为 `-`：
  - macOS：`/Users/sora/WorkSpace/Sora/widget` → `-Users-sora-WorkSpace-Sora-widget`
  - Windows：`C:\Users\x\proj` → `C--Users-x-proj`（冒号与反斜杠各贡献一个 `-`，出现连续两个）

**回合结束标志：** 追加一条 `stop_reason:"end_turn"` 的 assistant 行，随后是
`{"type":"system","subtype":"turn_duration","durationMs":...,...}`。
**完成结果 = end_turn assistant 行 `message.content` 的最终文本。**

**其他可利用行：**

- `cost-state`：累计费用；
- `queue-operation`：排队操作；
- `~/.claude/history.jsonl`：每次用户提交 prompt 记一行（字段 `display` / `project` / `sessionId` / `timestamp`），可当作「新任务开始」信号。

**子 agent：** transcript 同目录下有同名子目录 `<sessionId>/subagents/agent-*.jsonl`（行内 `isSidechain:true`），是子 agent 的独立 transcript。监听需递归覆盖该子目录；注意子 agent 的完成不会实时反映在主 transcript 文件里。

### 1.2 方案决策

**2s 轮询为主干**：

- 每轮 `stat` 所有 `sessions/*.json`；对 mtime/size 有变化的 jsonl 从上次 offset 增量读取；
- 零依赖、跨平台行为一致；0~2s 的延迟对挂件场景完全够用；
- 可选升级：chokidar（前端）/ notify（Rust）事件驱动，作为后续优化而非首版依赖。

**hooks（Stop / Notification / SessionEnd）不推荐首版使用**：需要侵入用户 Claude 配置，且拿到事件后结果仍要回读 jsonl，收益不抵成本。

**大文件防护**：transcript 可达 50MB+，绝不做全量重读；检测到文件 size 变小（被截断/重写）则重置 offset 从头读。

## 2. 自有对话：spawn Claude Code 运行时

点击宠物发起的对话，通过直接 spawn `claude` CLI 实现，参照 [cc-connect](https://github.com/)（Go）`agent/claudecode/session.go` 的协议：

```text
spawn:
  claude --output-format stream-json --input-format stream-json \
         --permission-prompt-tool stdio --replay-user-messages --verbose \
         [--permission-mode acceptEdits] [--resume <sessionId>]

发消息（互斥锁保护写入）:
  stdin ← {"type":"user","message":{"role":"user","content":"…"}}\n

收事件:
  system(init → session_id / model)
    → assistant(text / thinking / tool_use 增量)
    → result(最终文本 + usage + Done)
```

- **多轮对话** = 进程常驻，继续向 stdin 写入即可；
- **跨重启续聊** = 持久化 system 事件里的 `session_id`，重启后 `--resume` 接上。

**三个实测坑：**

1. spawn 前必须从环境变量中剥掉 `CLAUDECODE`，否则 CLI 判定为嵌套调用、拒绝启动；
2. `result` 事件的 `subtype == "compact"` 是回合中的上下文压缩，不是回合结束，不要当完成处理；
3. assistant 事件里的 `output_tokens` 是占位值，真实 token 用量只在 `result` 事件里。

**权限策略：** 首版用 `--permission-mode acceptEdits` 放行文件编辑；但保留 `control_request(can_use_tool)` / `control_response` 协议通道，便于后续加「审批按钮」交互。

**自过滤：** 挂件自己 spawn 的 claude 进程同样会出现在 `sessions/` 注册表里，监听逻辑要按 pid 把自己排除。

## 3. Tauri 2 窗口与渲染

**窗口参数：**

```text
transparent: true, decorations: false, shadow: false,
alwaysOnTop: true, skipTaskbar: true, resizable: false
```

- `shadow: false` 是 macOS 透明窗口的必须项，否则透明区域会渲染出一圈发黑的阴影；
- 主窗口尺寸贴合精灵本体即可，避免引入点击穿透（set_ignore_cursor_events）的复杂度；
- 气泡对话用第二个 frameless 子窗承载。

**动画：** CSS `steps()` 切换 spritesheet 的 `background-position`（预览页已验证该方案），配合 `image-rendering: pixelated`；无需 Canvas / Lottie。

**通知：** `tauri-plugin-notification`。注意：

- Windows 需走 NSIS / MSI 安装包，toast 通知才可用；
- macOS 通知点击回调需要 Developer ID 签名。

**单实例与自启：** `tauri-plugin-single-instance`（首个实例注册）+ autostart 插件，设置里提供开关。

**Rust 侧：**

- 文件监听直接用 `notify` crate——`tauri-plugin-fs-watch` 有回调只触发一次的已知毛病；
- 子进程用标准库 `std::process::Command`。

**工程结构：** 参照 ayangweb/BongoCat 的 Cargo workspace 多 crate 架构。

## 4. 美术资产

见 [ART.md](./ART.md)：格式契约（8 列 × 192×208 网格、pet.json、四状态动画表）、Lynn 官方形象生成 prompt、导入流水线。

当前 spritesheet 由 `scripts/import_generated_sheet.py` 从大模型生成的网格图导入。

## 5. 首版状态机

1. 每 2s 轮询 `~/.claude/sessions/*.json`（剔除自身 spawn 的 pid，剔除僵尸条目）；
2. 存在 `status: "busy"` 的 session → working 动画；全部 idle → idle 动画；
3. 某 session 的 transcript 出现 `turn_duration` 系统行 → done 动画 + 系统通知 + 气泡展示结果摘要；
4. 点击宠物 → 打开对话气泡 → 向自有 claude 常驻进程发消息，流式渲染回复。

## 6. 待定 / 风险

- **Windows 适配点**：路径编码出现连续两个 `-`（`C:\` → `C--`）、cwd 含反斜杠、通知需要 AppUserModelID、autostart 插件偶发失效；
- **macOS 通知点击**事件需 Developer ID 签名；未签名状态下首版可只做横幅展示、不做点击交互；
- **帧间抖动**：导入流水线的 bottom-center 对齐依赖内容 bbox，若正式图带动作线等装饰，可能引入轻微水平抖动，届时可改为 alpha 质心对齐；
- **增量读的半行问题**：按 offset 增量读时文件尾部可能是不完整的一行，需缓冲至凑齐换行符再 JSON 解析（与「size 变小则重置 offset」配合处理）；
- **格式漂移**：`sessions/*.json` 与 transcript 行格式随 Claude Code 版本演进可能变化，解析需宽松容错（未知字段忽略、字段缺失兜底），并注明实测基准版本（2.1.308）；
- **多 session 并发完成**：多个 session 同时结束时需对通知与气泡摘要做合并或排队，避免通知风暴；
- **`--resume` 依赖 transcript 留存**：用户清理 `~/.claude/projects/` 会导致自有对话无法跨重启续聊。
