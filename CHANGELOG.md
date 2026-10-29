# Changelog

本项目的所有重要改动都记录在这里，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.3] - 2026-10-29

### Added

- **`ensp_doc` 新增 `template_path`**：直接用老师发的原始题目 `.docx` 当「纯截图版」的底，
  原文、题号、排版一个字不动，把每个 section 的截图依次填进对应 `步骤N` 标题下面的空白段落
  （空白段落不够时按最后一个空段的格式新建，截图居中、宽度 13.5 cm）。
  - `section.heading` 写 `步骤3` 这种短标识即可自动匹配，也可以用 `anchor` 指定任意行首文字。
  - 找不到锚点会报错并列出缺哪些，不会悄悄生成一份空文档。
  - 实测：任务4 模板 9 个非空文字段落 → 输出仍是 9 个、图片 1 → 10；任务1 模板 75 段、
    3 图 → 输出 75 段、11 图，`文字一致: True`。
  - 这一步以前要临时写一段 python-docx 脚本（半小时起步），现在是一次工具调用的参数。

### Fixed

- **`save` 在 S5700 上卡在「请输入文件名」**：S5700 在 `[Y/N]` 之后还会问
  `Please input the file name ( *.cfg, *.zip ) [vrpcfg.zip]:`，旧逻辑等提示符等到超时、
  `saved.ok` 为 false。现在识别到这个提问就补一个回车（用默认的 `vrpcfg.zip`），
  实测回显 `Save the configuration successfully.`。
- **`ensp_doc` 的截图相对路径失效**：python 子进程的工作目录不是 DSH 工作区，
  传 `工作区/截图/x.png` 会报 `missing image`。现在图片路径进 manifest 之前统一按工作区解析。
- **模板里的「空文本框」被当成非空行**：老师给的模板常用无图片的文本框当照片框，
  旧判定见 `w:drawing`/`w:pict` 就跳过，导致截图滑到下一个标题下面。现在只有真正带图片关系
  的段落才算已占用，图片会被放进文本框内部（宽度按框宽收一点，避免溢出）。

### Docs

- SKILL 交付清单补「纯截图版用 `template_path` 填原题文档」的做法。

## [0.2.2] - 2026-10-29

### Added

- **`ensp_cli` 新增 `new_password`**：USG6000V 用出厂口令首次登录时会强制改密
  （`The password needs to be changed. Change now? [Y/N]:`）。旧版要么把这个提示当成超时，
  要么在答 `N` 之后被设备踢回 `Login authentication`。现在传 `new_password`，工具会按
  `Y → 旧口令 → 新口令 → 确认新口令` 走完，登录后会话直接用新口令。
  实测 USG6000V：`admin` / `Admin@123` → 新口令 `Huawei@123`，改完拿到 `<USG6000V1>` 提示符。

### Fixed

- **防火墙控制台登录判定失效**：`waitFor()` 返回文本后会把缓冲区清空，`loginIfNeeded()`
  再去读 `this.buffer` 就是空的，于是用户名/口令被当成普通命令打进 `Username:` 提示符。
  改为把 `waitFor()` 的返回文本传进登录流程。顺带处理 `Please Press ENTER.` 与
  「又出现一次 `Username:` = 口令错误」两种情况，错误信息也从超时变成
  `console authentication failed for user "admin" (wrong password?)`。
- **`save` 在 AR2220 上必然失败**：旧实现先发 `save`、等确认提示、再发 `y`；AR2220 已经把
  提示符弹回来了，这个 `y` 就成了 `Error: Unrecognized command found at '^' position.`，
  `saved.ok` 恒为 false。改成一次性写 `save\ny\n`（LF 换行，不夹 `\r`），
  S3700 / AR2220 / USG6000V 三型设备实测都能拿到
  `Save the configuration successfully` / `Configuration file had been saved successfully`。

### Docs

- SKILL 错误目录补防火墙登录/改密、`save` 的 AR 时序两条实测记录，并注明
  **eNSP 只有「保存拓扑」（主窗口 Ctrl+S）才会把设备配置写回 `.topo` 目录**：
  只做设备 `save` 然后结束进程，重开拓扑仍会回到初始配置。

## [0.2.1] - 2026-10-29

### Fixed

- **`ensp_cli` 的 `echo_to_window` 从来不提交命令**：回显把每行结尾写成 `\r`，而桥的
  `type_text` 明确跳过 `\r`（只把 `\n` 映射成 VK_RETURN），于是命令被逐字打进设备窗口后
  一直躺在输入缓冲里，截图只有命令行、没有回显。改成 `\n` 后实测能正常执行并截到完整输出。
- 回显的默认停顿加大：`echo_gap_ms` 600 → 900，`echo_settle_ms` 1200 → 1800，避免长回显
  还没打印完就截图。

### Docs

- SKILL 错误目录补两条实测：首条命令超时且 partial output 只有 `##`（设备没就绪，加大
  `command_timeout_ms` 重试）、回显截图缺输出（旧版 `\r` 问题）。

## [0.2.0] - 2026-10-29

### Added

- **MCP 服务器**：同一套六个工具现在也能以 MCP（stdio）形式提供，供 Claude Desktop、
  Claude Code、Cursor、Trae、Cline 等客户端使用。
  - `mcp/server.js` 通过调用 `apply()` 注册工具，复用 DSH 插件用的同一批工具对象
    （同名、同 schema、同 handler），两边行为不会漂移。
  - `mcp/protocol.js` 手写 stdio JSON-RPC 传输，**插件保持零运行时依赖**。
  - `mcp/instructions.js` 把 SKILL.md 里的硬性规则搬成 MCP server instructions。
  - `bin/dsh-ensp-mcp.mjs` 命令行入口，支持 `--workspace`、`--no-restrict`、
    `--mode job|serve`、`--python`、`--version`、`--help`。
- `test/mcp-smoke.mjs` 离线冒烟测试（`npm test`）：协议握手与版本回落、JSON Schema
  映射与必填项、拓扑解析、工作区边界、未知工具/方法错误码，共 24 项断言，不需要
  eNSP、Python 或管理员权限。

### Changed

- `package.json` 增加 `bin`、`scripts.test`、`./mcp` 导出与 `mcp`/`bin`/`test` 文件项。

## [0.1.0] - 2026-10-27

### Added

- 首个可用版本：六个工具（`ensp_status`、`ensp_gui`、`ensp_shot`、`ensp_cli`、
  `ensp_topo`、`ensp_doc`）、`ensp-automation` 技能与系统提示注入。
- 提权 GUI 桥（`lib/bridge.py`，经 `ShellExecuteW("runas")` 启动），一整套界面动作
  只付一次进程启动成本；真实点击带 `expect` 归属校验，抢不到前台就拒绝输入。
- 设备窗口只走"双击画布图标"路径（外部 `ShowWindow` 会被 eNSP 撤销）；最小化的
  主窗口/控制台自动 `SW_RESTORE` 后操作（最小化窗口坐标是 -32000 废值）。
- `ensp_cli` 改配置后自动 `save`（自动应答 `[Y/N]`），返回 `saved.ok`。
- `start_all` / `stop_all` 点完工具栏后轮询控制台端口，不用猜启动耗时。

[Unreleased]: https://github.com/YunoSeng/dsh-ensp/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/YunoSeng/dsh-ensp/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/YunoSeng/dsh-ensp/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/YunoSeng/dsh-ensp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/YunoSeng/dsh-ensp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/YunoSeng/dsh-ensp/releases/tag/v0.1.0
