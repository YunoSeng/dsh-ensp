# dsh-ensp

> 让 AI 更好地使用华为 eNSP 做网络实验：后台批量驱动 GUI、telnet 下发命令、读写 `.topo`、自动出实验报告。

[![release](https://img.shields.io/github/v/release/YunoSeng/dsh-ensp)](https://github.com/YunoSeng/dsh-ensp/releases)
[![license](https://img.shields.io/github/license/YunoSeng/dsh-ensp)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-stdio-blue)](mcp/server.js)

一个 [DSH](https://github.com/deepseek-ai)（DeepSeek Harness）插件。给 AI 装上这套工具后，它能自己打开拓扑、启动设备、下发配置、验证连通性、截图，最后生成两份带截图的 Word 实验报告。

**实测环境**：Windows 10/11 + eNSP 1.3.00.100（client 1.2.0.500）+ DSH。所有坐标、坑、耗时都在真机上验证过，下面标 ⚠ 的是换机器要重新确认的点。

同一份代码还带一个 **MCP 服务器**（`bin/dsh-ensp-mcp.mjs`），Claude Desktop / Claude Code / Cursor 等客户端可以直接用，见 [作为 MCP 服务器使用](#作为-mcp-服务器使用)。

---

## 它解决什么问题

AI 操控 eNSP 最慢、最容易翻车的环节是**点鼠标**：真实点击要移动指针、抢前台、等窗口响应，一场实验几百次点击，每次几十毫秒到几秒，还会打到用户正在用的窗口里。

这个插件做了两件事：

1. **把界面动作批量化并提到提权桥上执行**——一整套点击写进一次调用，启动成本约 0.3 s，之后每步 15–90 ms。
2. **把大部分操作改走别的通道**——telnet 下发命令、直接读写 `.topo` 文件、窗口 DC 截图（不抢焦点、不怕被遮挡），只有必须点界面的地方才真的动鼠标。

### 速度对比（本机实测）

| 操作 | 手工 / 逐条调用 | 用本插件 |
| --- | --- | --- |
| 下发一条配置命令 | 开窗口 + 打字 ≈ 3–5 s | telnet **60 ms** |
| 读拓扑（设备名/型号/端口/IP 规划） | 截图肉眼找 | 解析 `.topo` **1 ms** |
| 主窗口截图 | 全屏截图 200 ms+，还怕遮挡 | 窗口 DC **74 ms** |
| 启动全部 11 台设备 | 手工点 + 盲等 | `start_all` **8.7 s**（含等所有端口起来） |
| 保存配置 | 进用户视图 + `save` + 答 `y` | 自动完成 **0.3 s** |
| 一次 `ensp_gui` 调用 | —— | 批内每步 15–90 ms |

---

## 环境要求

| 项 | 要求 |
| --- | --- |
| 系统 | Windows（依赖 UIPI / `ShellExecuteW` / BitBlt，非 Windows 不适用） |
| eNSP | 华为 eNSP（实测 1.3.00.100，客户端 1.2.0.500） |
| 宿主 | DSH Desktop（插件以 `cordis.patch.yml` bundle 形式加载） |
| Python | 3.9+ 且带 `pywin32` + `Pillow`（提权桥用，插件会自动探测候选解释器，也可用配置指定）。生成 docx 用 DSH 自带 Python（含 `python-docx`） |
| 权限 | 建议 **DSH 以管理员身份运行**（原因见 [UAC](#uac会弹几次授权框)） |

---

## 安装

插件是标准的 DSH bundle：`package.json` 里声明 `dsh.bundle.patch`，DSH 启动时按 `cordis.patch.yml` 加载 `index.js`。装法三选一：

| 方式 | 命令 / 写法 | 适合 |
| --- | --- | --- |
| 本地 link（开发） | `"dsh-ensp": "link:E:/dsh-plugins/dsh-ensp"` | 改了代码重启即生效，自己改插件时用 |
| 直接从 GitHub 装 | `pnpm add github:YunoSeng/dsh-ensp#v0.1.0` | 不改代码，只想要某一版 |
| Release zip | [下载 zip](https://github.com/YunoSeng/dsh-ensp/releases) 解压后用 `link:` 挂上 | 不想装 git、或机器不能访问 GitHub |

下面以本地 link 为例（同理可换成 `github:` 写法）：

1. 克隆到本地任意目录：

   ```powershell
   git clone https://github.com/YunoSeng/dsh-ensp.git E:\dsh-plugins\dsh-ensp
   ```

2. 在你的 DSH profile（例如 `C:\Users\<你>\.dsh\profiles\web\package.json`）里挂上它：

   ```json
   {
     "dependencies": {
       "dsh-ensp": "link:E:/dsh-plugins/dsh-ensp"
     },
     "dsh": {
       "profile": {
         "bundles": ["dsh-ensp"]
       }
     }
   }
   ```

   再让 Node 能解析到这个包（junction / symlink 二选一）：

   ```powershell
   New-Item -ItemType Junction `
     -Path "C:\Users\<你>\.dsh\profiles\web\node_modules\dsh-ensp" `
     -Target "E:\dsh-plugins\dsh-ensp"
   ```

3. 重启 DSH。技能目录里会出现 `ensp-automation`，工具列表里会出现 `ensp_*` 六个工具。

4. 验证：让 AI 调一次 `ensp_status`，返回 `bridge.available: true`、`bridge.elevated: true` 就说明提权桥通了。

> 插件会以 `runas` 启动一个提权 Python 侧车（`lib/bridge.py`）来点界面。**这是全插件唯一主动请求提权的地方**，细节见 [UAC](#uac会弹几次授权框)。

---

## 提供的工具

| 工具 | 用途 | 典型耗时 |
| --- | --- | --- |
| `ensp_status` | 开工前探明现状：桥是否可用/已提权、已打开的 eNSP 实例与窗口、本机装了哪些版本、已打开的设备窗口、`.topo` 里的设备与标注、控制台端口是否已开放 | 0.4–1 s |
| `ensp_gui` | 把一整套界面动作塞进一次调用：`start_all` / `stop_all` / `open_console` / `close_console` + 全部底层 op（点击、拖拽、滚轮、打字、按键、截图、读控件） | 0.3 s + 15–90 ms/步 |
| `ensp_shot` | 截图：`main`（主窗口）/ `device`（设备命令行窗口）/ `screen`（整屏），窗口 DC 位图 | 74 ms / 0.7–4.6 s |
| `ensp_cli` | telnet 下发 VRP 命令，自动处理分屏、提示符、AAA 登录、`save` 确认；可选把同样命令用**真实键盘**回显到设备窗口并截图 | 60 ms（+截图 3 s） |
| `ensp_topo` | 纯文件操作：列设备、改设备名、改 PC/Server IP、重排控制台端口（永不原地改源文件） | 1–5 ms |
| `ensp_doc` | 从截图清单一次生成两份 docx：说明版（每图一句话 + 账号表）、纯截图版 | 1–1.5 s |

另外注册了一个技能 `ensp-automation`（`skills/ensp-automation/SKILL.md`），把实测坐标、端口、四层验证流程、错误目录喂给模型——不用每次重新摸索。

### 分层通道：能用轻的就不用重的

```
ensp_topo（读文件） < ensp_cli（telnet） < ensp_shot（窗口 DC） < ensp_gui（消息投递） < ensp_gui（真实点击）
     1 ms              60 ms/条             74 ms            ~20 ms/步            ~50 ms/步 + 抢前台
```

模型被要求在不需要界面的时候**绝不碰界面**。

---

## 作为 MCP 服务器使用

除了 DSH 插件，仓库还带一个 **MCP（Model Context Protocol）服务器**，把同一套六个工具暴露给 Claude Desktop、Claude Code、Cursor、Trae、Cline 等任何支持 MCP 的客户端。

关键点是**不复制代码**：`mcp/server.js` 调 `apply()` 用替身上下文注册工具，拿到的就是 DSH 插件用的同一批工具对象（同名、同 schema、同 handler），所以两边行为不可能漂移。传输层是手写的 stdio JSON-RPC（`mcp/protocol.js`），**整个插件零运行时依赖**。

```powershell
node bin/dsh-ensp-mcp.mjs --workspace E:/labs      # 仓库内直接跑
npx dsh-ensp-mcp --workspace E:/labs               # 装成包之后
```

客户端配置（stdio）：

```json
{
  "mcpServers": {
    "ensp": {
      "command": "node",
      "args": ["E:/dsh-plugins/dsh-ensp/bin/dsh-ensp-mcp.mjs", "--workspace", "E:/labs"]
    }
  }
}
```

`--workspace` 决定相对路径的基准与沙箱边界（默认 `$ENSP_MCP_WORKSPACE`，否则当前目录）。其它开关：`--no-restrict`、`--mode job|serve`、`--python <path>`、`--version`、`--help`。

| 能力 | 状态 |
| --- | --- |
| `tools`（6 个，JSON Schema + 必填项，从 `defineTool` 规范化结果直接映射） | ✅ |
| `initialize` / `notifications/initialized` / `ping` / 未知方法错误码 | ✅ |
| server `instructions`（把 SKILL.md 的硬规则搬成 MCP 说明） | ✅ |
| `resources` / `prompts` / 进度通知 | ⏳ 最小可用版暂未实现 |

两点说明：

- **MCP 不改变速度**，瓶颈仍在 GUI 驱动与窗口同步；它改变的是"谁能用"和"怎么被结构化调用"。
- 只想搭拓扑的话，社区项目 [Heaxu/ensp-mcp](https://github.com/Heaxu/ensp-mcp) 更专业（自动布局、分区背景框、结构校验）。两者可以在同一个客户端里并存：它建图，本服务启动设备、开命令行窗口、截图、出报告。

离线自测（不需要 eNSP、Python 或管理员权限）：

```powershell
npm test        # 24 项断言：协议握手、schema 映射、拓扑解析、沙箱边界、错误码
```

---

## 几个被真机教出来的设计

- **点击守卫**：真实点击必须带 `expect`（`"ensp"` / 窗口标题 / 句柄）。用户很可能开着别的全屏窗口把 eNSP 盖住，裸点击会打到别人的窗口里。带 `expect` 时桥会先"置顶→取消置顶"把 eNSP 抬到最上层，再确认该坐标真的属于 eNSP 才按下，否则**拒绝点击**并报错。
- **激活链**：`SwitchToThisWindow` → `SetForegroundWindow` → 置顶抬升 → 真实点击标题栏，任一步成功即止，并用 `GetForegroundWindow` 复核。发按键前必须激活成功，否则 `safetype` 直接拒绝，而不是把命令打进用户正在用的窗口。
- **设备窗口只能"双击图标"打开**：eNSP 会在 0.2–0.7 s 内把外部 `ShowWindow` 显示出来的设备窗口重新隐藏，唯一可靠路径是模拟人类双击画布图标（图标坐标 = `.topo` 的 `cx/cy` + 画布偏移，偏移由隐藏 `Edit` 标签锚点与 `edit_left/edit_top` 实时匹配算出）。
- **`save` 自动落盘**：本批命令里只要有一条不是 `display/ping/tracert/dir` 这类只读命令，`ensp_cli` 就会自动 `return` → `save` → 答 `[Y/N]`，结果放进返回值的 `saved.ok`，实验不会"重开就没了"。
- **启动/停止自己等结果**：点完工具栏会轮询各设备的 `com_port` 直到所有控制台端口开放（或超时），模型不用 sleep 猜时间。
- **不改宿主、不注入进程**：所有 win32 调用集中在 `lib/bridge.py` 一个文件里，通过临时文件（job 模式）或本机 TCP（serve 模式）通信。

---

## 遮挡、前台与最小化：什么时候必须置顶

用户最在意的体验是"别在我屏幕前面乱弹窗口"。先看清每条通道对窗口状态的敏感度（实测）：

| 动作 | 被别的窗口**盖住** | 窗口**最小化 / 隐藏** |
| --- | --- | --- |
| 窗口 DC 截图（`ensp_shot`） | ✅ 正常，不需要置顶也不需要焦点 | ❌ 黑图或**旧画面**（看起来成功，内容却是几分钟前的） |
| 消息投递点击 `postclick` | ✅ 生效（不走桌面合成） | ⚠️ 发得进去，控件未必处理 |
| 真实点击 `click`（SendInput） | ❌ 落到最上层窗口上 → 必须带 `expect`，桥会先抬升再校验归属 | ❌ 无效 |
| 真实键盘 `safetype` / `key` | ❌ 按键进前台程序 → 必须先激活 | ❌ 拒绝执行 |
| telnet `ensp_cli` | ✅ 与窗口状态完全无关 | ✅ 与窗口状态完全无关 |

由此定下默认策略：**telnet 下发、主窗口截图、`.topo` 读写全部在后台完成**，不激活、不前置窗口；只有"截设备命令行窗口"和"点非客户区（工具栏/菜单）"才把 eNSP 拉到前台，做完立刻用 `close_console` 收掉窗口。

> 最小化是个隐蔽的坑：最小化窗口的 `rect` 是 `-32000` 的废值、客户区 0×0，算出来的图标坐标全在屏幕外（症状：7 个偏移位置都点不中，报"面板可能不在可见画布内"）。插件现在会自动 `SW_RESTORE` 还原主窗口或控制台窗口再操作，代价是那一次动作必定占前台。

---

## UAC：会弹几次授权框

提权桥靠 `ShellExecuteW(None, "runas", pythonw.exe, …)` 启动，**这是唯一主动提权的地方**。弹框次数 = 提权 job 数：

| 工具调用 | 需要的 job 数 |
| --- | --- |
| `ensp_cli`（纯 telnet，含自动 `save`） | **0** |
| `ensp_topo` / `ensp_doc` | **0** |
| `ensp_status` / `ensp_shot target=main` | 1 |
| `ensp_gui` 一批 | 1，另外每个 `open_console` 各 +1 |
| `ensp_shot target=device`，控制台已开 | 2 |
| `ensp_shot target=device`，控制台没开（冷） | 7 |
| `ensp_cli` + `echo_to_window` 截图 | 2 |

所以在 **UAC 默认 + DSH 非提权** 的机器上，一场完整实验会弹 20–60 次授权框（而且 UAC 弹在安全桌面上，自动化点不到它）。三种解法：

| 做法 | 弹框次数 | 说明 |
| --- | --- | --- |
| **以管理员身份运行 DSH** | **0** | `runas` 变成继承权限，最省事 |
| `mode: "serve"` | **1** | 常驻提权侧车，整个会话只弹一次，之后走本机 TCP 复用 |
| UAC 改"从不通知" | 0 | 降低整机安全，不建议给别人配 |

自检：`ensp_status.bridge.elevated` 必须是 `true`，`bridge.transport` 会告诉你当前是 `job` 还是 `serve`。提权失败（例如用户在授权框上点了取消）时 `ShellExecuteW` 返回 **1223**，工具会把原因写进 `notes`。

---

## 配置项

在 `cordis.patch.yml` 的 `config` 里覆盖（全部有默认值）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enspExecutable` | `C:/Program Files/Huawei/eNSP/eNSP_Client.exe` | 没有运行实例时用来拉起 |
| `pythonExecutable` / `pythonCandidates` | 自动探测 | 提权桥用的 Python |
| `docsPythonExecutable` | DSH 自带 Python | 生成 docx 用的 Python |
| `mode` | `job` | `job`＝每次动作起一个提权进程（最快最干净）；`serve`＝常驻侧车（UAC 受限机器用） |
| `timeoutMs` | `180000` | 单批 GUI 动作超时 |
| `restrictToWorkspace` | `true` | 只允许读写会话工作区内的文件 |
| `toolbarStart` / `toolbarStop` | `[659,56]` / `[698,56]` | 工具栏按钮相对主窗口左上角的位置（换分辨率/缩放要重测）⚠ |
| `iconHalfSize` | `[32,28]` | 设备图标中心相对 `.topo` `cx,cy` 的偏移 ⚠ |
| `injectPrompt` / `registerSkill` / `textTakeoverNotice` | `true` | 是否注入系统提示 / 注册技能 / 点击前提醒接管鼠标 |

---

## 目录结构

```
index.js                  插件入口：6 个工具、1 个技能、1 段系统提示
cordis.patch.yml          bundle 清单（DSH 按它加载）
lib/bridge.py             提权 GUI 桥（唯一的 win32 调用方，约 1200 行）
lib/launch.py             ShellExecuteW("runas") 拉起 bridge.py
lib/bridge-client.js      桥的客户端：探测 Python、临时文件 / TCP 通信、超时
lib/cli.js                telnet 会话：提示符、分屏、AAA 登录、save 确认
lib/topo.js               .topo 解析/改写、改名建议
lib/make_docs.py          两份 docx 的排版（python-docx）
skills/ensp-automation/   实测操作手册（模型读的 SKILL.md）
locale/{zh,en}.json       插件显示名
mcp/server.js             MCP 前端：复用 apply() 注册的工具，映射 JSON Schema
mcp/protocol.js           手写的 stdio JSON-RPC 传输（零依赖）
mcp/instructions.js       MCP server instructions（替代 DSH 的技能注入）
bin/dsh-ensp-mcp.mjs      MCP 命令行入口
test/mcp-smoke.mjs        离线冒烟测试（npm test）
```

---

## 已知边界

- **坐标与窗口边框、DPI 缩放强相关**。本机是 100% 缩放、客户区 1440×810；换机器第一次用 `ensp_status` 对一遍，必要时改 `toolbarStart` / `iconHalfSize`。
- **不要给 eNSP 的自绘状态栏发 `SB_GETPARTS` 之类的 WM_USER 消息**——客户端会直接崩溃。要判断选中数量就截图。
- **拓扑别手搓**：手工拼出来的最小 `.topo` 打开是空白画布（缺 `shapes`/`txttips`）。加设备、连线交给 GUI。
- **复制拓扑文件夹后个别拓扑会崩**（设备多、含 S5700 的尤其明显），先试再批量。
- **USG6000V 防火墙可能起不来**：控制台只回 `##` 之类的垃圾，或端口始终不开放。工具会把它报进 `notes` 并继续其余部分。
- **丢配置**：`stop_all`、重启设备、关拓扑都会让 RAM 里没 `save` 的改动全部丢失。插件默认自动保存，除非显式传 `save: false`。
- **`save` 不等于留在拓扑里**：设备 `save` 只写进设备 flash；要让配置跟着 `.topo` 走，收尾得在 eNSP 主窗口按 **Ctrl+S 保存拓扑**（实测：不按的话重开拓扑会回到初始配置，按了之后 `vrpcfg.cfg`/`flash.efz` 会被回写，重开确认配置和改过的口令都在）。
- **USG6000V 首次登录强制改密**：出厂 `admin` / `Admin@123` 会先问 `The password needs to be changed. Change now? [Y/N]:`。给 `ensp_cli` 传 `new_password` 就会自动走完改密；答 `N` 会被踢回登录提示。
- **MCP 端只有 tools + instructions**：没有 resources / prompts / 进度通知；调用是串行处理的，一个长任务（如 `start_all` 8.7 s）期间客户端只能等。
- **仓库不是 npm 包**（`package.json` 保留 `private: true`）：用 `git clone` 后 `node bin/dsh-ensp-mcp.mjs` 启动，或按 [Release zip](https://github.com/YunoSeng/dsh-ensp/releases) 解压。
- 只支持 Windows；只接管 eNSP，不碰其它程序。

---

## 开发与调试

插件运行时的两个依赖 `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery` 由宿主提供。要脱离宿主单测工具定义：

```js
import { apply, Config } from './index.js'

const registered = []
apply({
  tools: { register: (tool) => registered.push(tool) },
  skills: { register: () => {} },
  systemPrompt: { section: () => {} },
}, Config({}))

const exec = { agent: { session: { header: { cwd: process.cwd() } } } }
const status = await registered.find((t) => t.name === 'ensp_status').execute({}, exec)
```

GUI 桥可以单独驱动，便于调试坐标：

```powershell
python lib\launch.py --job job.json     # 用 runas 起一个提权进程，跑 job.json 里的步骤
```

改动 MCP 前端后跑离线冒烟测试（24 项断言，不需要 eNSP / Python / 管理员权限）：

```powershell
npm test
```

工具返回值必须能无损 JSON 化（DSH 会校验），插件内部用 `lossless()` 统一处理 `undefined` / `NaN` / 非普通对象。

---

## License

[MIT](LICENSE) © YunoSeng
