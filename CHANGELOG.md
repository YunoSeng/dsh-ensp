# Changelog

本项目的所有重要改动都记录在这里，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.6] - 2026-11-03

## [0.2.5] - 2026-11-03

### Fixed

- **控制台空闲超时导致窗口打字丢字符**：设备控制台闲置一段时间会提示
  `Configuration console time out, please press any key to log on`，第一个按键只用于唤醒。
  `ensp_cli` 的 `open()` 现在会识别这句提示并补一个回车；`echo_to_window` 也会先激活窗口、
  发一个空回车再开始打字，同时把逐字符间隔从 0.02 s 提到 0.05 s（0.02 s 时 AR 控制台会丢空格）。
- **设备窗口截图拿到旧画面**：窗口被遮挡或不在前台时，窗口 DC 不重绘，`BitBlt` 返回上一屏。
  截图前统一 `RedrawWindow(+RDW_UPDATENOW)` + `UpdateWindow`，`echo_to_window` 还在截图前重新激活窗口。

### Added

- **新增 `ensp_capture`**：一次调用完成「开设备窗口 → 打字 → 等回显 → 截图 → 关窗」的整套取证动作，清单式传入 `shots:[{device, commands, out}]`，报告里十几张图可以一条调用出完。
- **`ensp_cli` 新增 `expect`**：与 `commands` 等长的断言数组，未命中就在 `checks[]` 里标出，并给一个总的 `ok`；不用把整段回显读回来判断。
- **`ensp_cli` 新增 `devices`**：一次调用配多台设备（`devices:[{device, commands, …}]`），内部并行跑，
  单台失败只在它那一项回 `error`，不影响其它设备。
- **`ensp_shot` 新增 `shots`**：一次调用截多张图（`shots:[{out, target?, device?, crop?}]`），
  适合「一台设备一段回显 + 主窗口 + 全屏」这种成批取证。
- **SKILL 新增「效率铁律」**：工具只占几分钟，真正的成本是回合数——互不依赖的调用要并行发、
  多设备一次下发、截图成批、核对以文本为主、要问用户的事一次问完。
- **内置命令速查 `skills/ensp-automation/reference/commands.md`**：把 VRP 的常用命令固化进插件——
  通用/交换 VLAN/ARP 安全/防火墙基础/安全策略/源 NAT（NAPT、Easy-IP）/目的 NAT 与 NAT Server/双向 NAT/
  路由/验证命令，外加「报错 → 处理」对照表。规则也写进 SKILL §0：**先查表，只有设备真的报错才联网搜，
  搜到实测通过后补回表里**。
- **`ensp_cli` 新增 `output_file`**：把完整回显同时写到工作区里的 `.txt`，返回值多一个 `transcript` 路径。
  用于对抗上层对长工具结果的压缩（结果超过几百字节时可能被替换成 `<<ccr:…>>` 标记），
  写盘后可以再用检索工具精确查。

### Docs

- SKILL 补：**切换拓扑**的可靠做法（`ensp_gui {op:"open",path:…}` 一条调用完成；不要把 `.topo` 当命令行参数
  传给 `eNSP_Client.exe`，那样只会开出一个空白画布）、自绘保存对话框只能截图后真实点击、
  USG6000V 默认凭据、长回显被压缩时的三种对策、**先 display 再下发**（拓扑可能预配过）、
  设备图标名与 VRP 主机名的区别、以及无人值守/子代理场景下「先问用户」类规范的降级默认值。

## [0.2.4] - 2026-11-03

### Added

- **模板模式支持 `anchor: "#picN"`**：按「模板里第 N 张图所在的段落」定位，用于把实际拓扑图
  插在题目自带的参考拓扑图正下方——有些题目图后面直接接正文、没有 `图1 …` 图注，只能靠图片
  定位。有图注的继续用 `heading: "图1"`。

### Docs

- 交付规范补一条：**纯截图版第一个 section 永远是实际拓扑图**，插在题目参考拓扑图正下方，
  不加任何文字说明（成品顺序：题目拓扑图 → 图注 → 实际拓扑图 → 操作步骤）。
  `index.js` 提示词与 `mcp/instructions.js` 同步。

## [0.2.3] - 2026-10-29

### Added

- **`ensp_doc` 新增 `template_path`**：直接用老师发的原始题目 `.docx` 当「纯截图版」的底，
  原文、题号、排版一个字不动，把每个 section 的截图依次填进对应 `步骤N` 标题下面的空白段落
  （空白段落不够时按最后一个空段的格式新建，截图居中、宽度 13.5 cm）。
  - `section.heading` 写 `步骤3` 这种短标识即可自动匹配，也可以用 `anchor` 指定任意行首文字。
  - 找不到锚点会报错并列出缺哪些，不会悄悄生成一份空文档。
  - 这一步以前要临时写一段 python-docx 脚本（半小时起步），现在是一次工具调用的参数。

### Fixed

- **`save` 在 S5700 上卡在「请输入文件名」**：S5700 在 `[Y/N]` 之后还会问
  `Please input the file name ( *.cfg, *.zip ) [vrpcfg.zip]:`，旧逻辑等提示符等到超时、
  `saved.ok` 为 false。现在识别到这个提问就补一个回车（用默认的 `vrpcfg.zip`），保存后正常回
  `Save the configuration successfully.`。
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

### Fixed

- **防火墙控制台登录判定失效**：`waitFor()` 返回文本后会把缓冲区清空，`loginIfNeeded()`
  再去读 `this.buffer` 就是空的，于是用户名/口令被当成普通命令打进 `Username:` 提示符。
  改为把 `waitFor()` 的返回文本传进登录流程。顺带处理 `Please Press ENTER.` 与
  「又出现一次 `Username:` = 口令错误」两种情况，错误信息也从超时变成
  `console authentication failed for user "admin" (wrong password?)`。
- **`save` 在 AR2220 上必然失败**：旧实现先发 `save`、等确认提示、再发 `y`；AR2220 已经把
  提示符弹回来了，这个 `y` 就成了 `Error: Unrecognized command found at '^' position.`，
  `saved.ok` 恒为 false。改成一次性写 `save\ny\n`（LF 换行，不夹 `\r`），
  S3700 / AR2220 / USG6000V 都会回 `Save the configuration successfully` /
  `Configuration file had been saved successfully`。

### Docs

- SKILL 错误目录补防火墙登录/改密、`save` 的 AR 时序两条记录，并注明
  **eNSP 只有「保存拓扑」（主窗口 Ctrl+S）才会把设备配置写回 `.topo` 目录**：
  只做设备 `save` 然后结束进程，重开拓扑仍会回到初始配置。

## [0.2.1] - 2026-10-29

### Fixed

- **`ensp_cli` 的 `echo_to_window` 从来不提交命令**：回显把每行结尾写成 `\r`，而桥的
  `type_text` 明确跳过 `\r`（只把 `\n` 映射成 VK_RETURN），于是命令被逐字打进设备窗口后
  一直躺在输入缓冲里，截图只有命令行、没有回显。改成 `\n` 后能正常执行并截到完整输出。
- 回显的默认停顿加大：`echo_gap_ms` 600 → 900，`echo_settle_ms` 1200 → 1800，避免长回显
  还没打印完就截图。

### Docs

- SKILL 错误目录补两条：首条命令超时且 partial output 只有 `##`（设备没就绪，加大
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

[Unreleased]: https://github.com/YunoSeng/dsh-ensp/compare/v0.2.6...HEAD
[0.2.6]: https://github.com/YunoSeng/dsh-ensp/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/YunoSeng/dsh-ensp/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/YunoSeng/dsh-ensp/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/YunoSeng/dsh-ensp/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/YunoSeng/dsh-ensp/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/YunoSeng/dsh-ensp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/YunoSeng/dsh-ensp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/YunoSeng/dsh-ensp/releases/tag/v0.1.0
