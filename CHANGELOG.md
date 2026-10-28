# Changelog

本项目的所有重要改动都记录在这里，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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

[Unreleased]: https://github.com/YunoSeng/dsh-ensp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/YunoSeng/dsh-ensp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/YunoSeng/dsh-ensp/releases/tag/v0.1.0
