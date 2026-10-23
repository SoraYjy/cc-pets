# Lynn 桌宠挂件

Claude Code 桌宠挂件——卡通小猫常驻桌面，实时反映本机 Claude Code session 状态，任务完成弹系统通知带结果摘要，点击可与自己 spawn 的 Claude Code 会话流式对话。

## 构建与运行

前置：node ≥ 20、rust（含 cargo）。

```bash
npm install
npm run tauri dev     # 开发运行
npm run tauri build   # 打包
```

> 本仓库自带 `src-tauri/.cargo/config.toml`，将 crates.io 指向 rsproxy.cn 镜像（原因：镜像区域网络，直连不稳）。如需还原官方源，删除该文件即可。

## 人工验收清单

1. **启动**：操作——`npm run tauri dev` 启动应用。预期——桌面出现透明小猫（192×208 置顶窗），播 idle 呼吸动画，可拖动。
2. **状态联动**：操作——另开终端跑一个 Claude Code 任务。预期——猫切 working 动画。
3. **完成通知**：操作——等该任务跑完。预期——猫播 done（弹跳星光）+ 系统通知「任务完成」带结果摘要。（macOS 未签名 dev 构建可能收不到通知，已知限制。）
4. **唤起对话**：操作——点击猫。预期——wave 挥爪 + 头顶弹出深色气泡窗。
5. **流式对话**：操作——气泡输入文字回车。预期——流式回复逐字上屏。观察点：点击猫会重启对话进程属当前设计；纯工具回合可能少一条分隔线。
6. **退出干净**：操作——完全退出应用后执行 `pgrep -fl claude`。预期——无该应用残留的子进程。

## 换形象

按 docs/ART.md 的规格生成网格图后，执行 `python3 -I scripts/import_generated_sheet.py` 导入（详见 docs/ART.md）。

⚠️ 勿运行 `scripts/render_placeholder_pet.py`（会覆盖回占位猫）。

## 技术文档指引

- [docs/DESIGN.md](docs/DESIGN.md) —— 架构与坑清单
- [docs/ART.md](docs/ART.md) —— 美术资产
