# cc-pets v1.0.1 方案:封装变体 Claude Code 接入(配置驱动)

> 状态:随本提交实施
> 需求:支持「另一种封装过的 Claude Code」——自有数据目录、经自有托管入口启动;仓库内不出现任何变体专属名称,一切差异走配置

## 设计

settings.json 两个可选字段(缺省 = 原生 Claude Code,零行为变化):

- `claudeDataDir`(支持 `~` 前缀):变体数据目录 → 监控(watcher 目录/注册表反查)走它
- `claudeChatLauncher`(程序名 + 空格分隔参数):聊天启动命令 → 聊天经它启动,PATH 缺失原地报错不回退;工作目录固定 `~/.cc-pets`(部分托管入口禁 $HOME)

两字段独立生效;要求变体数据格式与原生同构(sessions/projects/transcript 一致)。

## 交付点

- `cc_env.rs`:`claude_data_dir(home, Option<&str>)` / `resolve_chat_cli(home, Option<&str>)`(启动器 PATH 探测 + 空白分段)+ `build_command`/`scan_registry_for_session`
- settings.rs:`Settings` 增可选字段(serde rename camelCase,skip 序列化缺省);`save_settings` 改读-改-写(保手配字段不被整存抹掉)
- init subtype 门 + 引擎 pid 补登(15×400ms + 探活插入门)+ 组杀(process_group(0) + killpg)——变体环境的事件层配套
- README「接入其它封装版 Claude Code」节 + 验收锚点四条

## 验收

本机:原生环境零回归(未配置时行为与 v1.0.0 等价);变体环境验收在配置了上述字段的机器上执行(锚点见 README)。
