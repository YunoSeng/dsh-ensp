---
name: ensp-automation
description: 用 dsh-ensp 插件操作华为 eNSP：后台批量 GUI 驱动、telnet 下发命令、.topo 文件读写、实验截图与两份交付文档。需要打开拓扑、启动设备、改设备名/IP、跑命令、验证连通性、出实验报告时使用。含实测过的坐标、端口、坑与自愈流程。
---

# eNSP 实验自动化手册（实测版）

本手册的每条结论都在真机上验证过；标 ⚠ 的是环境相关、换机器要重新确认的点。

## 0. 开工顺序（别跳）

1. `ensp_status`：看有没有已打开的 eNSP、本机装了几个版本、桥是否可用（`bridge.elevated` 必须是 true）。
   - 有正在运行的实例 → 直接接管，别重开。
   - 没运行 → 问用户是否要用某个版本（多个版本必须问）。
2. 需要真实点击（启动设备、拖设备）时先提醒用户"将短暂接管鼠标，结束后还原"。
3. 要截图时先问用户：**是否关闭显示调试信息**（`undo debugging all`、`undo terminal monitor`），否则回显里会混入调试日志。
4. 需要改名时问用户：按重要程度编号（SW1/SW2、AR1/AR2、FW1）；用户给了规则以用户为准。
5. **收尾必须保存配置**（见 3.5）：用户没说"不用保存"，就要每台配过的设备都落盘。

## 1. 通道选择（从快到慢）

| 需求 | 用什么 | 说明 |
| --- | --- | --- |
| 看拓扑结构/设备名/端口/IP | `ensp_topo action=list` | 纯文件解析，零延迟 |
| 改设备名、改 PC IP、分配端口 | `ensp_topo action=rename/set-ip/set-ports` | 生成新 .topo，不动 GUI |
| 跑配置/取回显/保存 | `ensp_cli`（telnet） | 单条命令几十毫秒；改配置会自动 `save` |
| 启动/停止设备、开设备窗口 | `ensp_gui`（start_all / open_console） | 必须走 GUI |
| 交付截图 | `ensp_shot` / `ensp_cli echo_to_window` | 窗口 DC 截图，不抢焦点 |

一次 GUI 动作要几百毫秒，一条 telnet 命令只要几十毫秒——**能用 telnet 就别点窗口**。


## 2. GUI 驱动要点

### 批量执行
`ensp_gui` 的 `steps` 数组在一次提权进程里跑完：启动成本约 0.3 s，之后每步 1–70 ms。把一整套点击写进一次调用，不要一步一次调用。

### 常用 steps
```json
{"op":"start_all"}                                  // 激活窗口 + 点空白 + Ctrl+A + 点启动 + 等端口全部起来
{"op":"stop_all"}                                   // 点停止 + 等端口全部关闭
{"op":"open_console","device":"SW1"}                // 需要 topology_path；内部走双击图标
{"op":"close_console","device":"SW1"}               // 截完图把设备窗口收掉，保持桌面干净
{"op":"shot","ensp":true,"out":"shots/1.png"}        // 主窗口截图（也可 hwnd/title）
{"op":"postclick","hwnd":123456,"x":100,"y":200}    // 消息投递点击：不动鼠标
{"op":"click","x":900,"y":400,"restore":true,"expect":"ensp"}   // 真实点击：先抬升窗口再点，结束后还原指针
{"op":"safetype","title":"SW1","text":"display vlan\r"}         // 真实键盘打字，窗口不是前台就拒绝
{"op":"activate","ensp":true}                       // 真正把 eNSP 激活到前台
{"op":"raise","ensp":true}                          // 只把窗口抬到最上层，不抢焦点
{"op":"show","title":"SW1"}                         // ⚠ 对设备窗口无效，见下
{"op":"texts","hwnd":123456,"depth":3}              // 读对话框上的文字（WM_GETTEXT）
```

### 点击策略
- 状态栏、工具栏、菜单在**非客户区**，消息投递无效，只能真实点击（`click` 带 `restore:true`）。
- 画布、设备图标、对话框按钮优先试 `postclick`（不动鼠标、不抢焦点）。
- 真机实测：画布上双击打开设备窗口目前只有真实点击可靠；`postclick` 双击不触发。
- **真实点击一定要带 `expect`**（`"ensp"`/窗口标题/句柄）。实测用户很可能开着别的全屏窗口（浏览器/IDE）盖住 eNSP：这种时候裸点击会打到别人的窗口里。带 `expect` 时桥会先用"置顶再取消置顶"把 eNSP 抬上来，然后确认该坐标真的属于 eNSP 才按下，否则报 `refusing to click ...`。`ensp_rel` 坐标自动带 `expect:"ensp"`。
- 抬升窗口用 `raise`/`activate`；`activate` 依次试 `SwitchToThisWindow` → `SetForegroundWindow` → `raise` → 点标题栏。**打字/快捷键前必须先 `activate`**，否则 Ctrl+A 会打到用户当前窗口里。

### 遮挡、前台与输入：到底什么时候必须置顶

用户最在意的体验是"别在我屏幕前面乱弹窗口"。先看清每条通道对"窗口被盖住"的敏感度：

| 动作 | 被别的窗口**盖住** | 窗口**最小化/隐藏** |
| --- | --- | --- |
| 窗口 DC 截图（`ensp_shot target=main`） | ✅ 正常，不需要置顶、不需要焦点 | ❌ 黑图或旧画面 |
| 消息投递点击 `postclick` | ✅ 生效（不经过桌面合成） | ⚠️ 能发消息，但控件可能不处理 |
| 真实点击 `click`（SendInput） | ❌ 打到最上层窗口上——所以必须带 `expect`，桥会先抬升再校验 | ❌ 无效 |
| 真实键盘 `safetype`/`key` | ❌ 按键进前台程序——必须先把 eNSP 激活，且桥会校验 | ❌ 拒绝执行 |
| telnet 命令 `ensp_cli` | ✅ 与窗口状态完全无关 | ✅ |

结论：**默认不要抢前台**。telnet 下发、主窗口截图、`.topo` 读写全都不需要 eNSP 在前面。只有两种场景必须置顶：① 截设备命令行窗口（先双击图标打开，`safetype` 要前台）；② 点非客户区（工具栏启动/停止、菜单）。做完了用 `close_console` 收掉设备窗口。

### 坐标
- 工具栏相对主窗口左上角固定：启动 ≈ `(+659,+56)`、停止 ≈ `(+698,+56)`、1:1 ≈ `(+624,+56)`（`ensp_gui` 里的 start_all/stop_all 已内置，可用 Config 覆盖）。
- 设备图标位置 = `.topo` 里的 `cx,cy`（图标左上角）+ 画布偏移 + 约 (32,28) 到图标中心；画布偏移由"标签 Edit 控件矩形 vs `edit_left/edit_top`"实时算出（`ensp` op 返回的 `anchors`），`open_console`/`ensp_shot target=device` 已封装。缩放不是 100% 时要重新校准。

### 设备窗口（实测有坑）
- 设备窗口是 `#32770`，标题就是设备名；PC/Server 的窗口在拓扑加载时就已创建，AR/SW/FW 的在首次双击图标时才**真正**创建。
- **别用 `show`（ShowWindow）去显示设备窗口**：eNSP 会在几百毫秒内把它重新隐藏。唯一可靠的方式就是人类动作——双击画布图标（`open_console` 或 `ensp_shot target=device` + `topology_path`）。
- **隐藏窗口的 BitBlt 是旧画面**（能返回图像，但是几分钟前的帧，看起来"截图成功"其实内容错）。所以截图前一定要确认窗口是可见的；`ensp_shot target=device` 已经强制先确保可见，拿不到可见窗口就报错而不是给你假图。
- **最小化 ≈ 没有**：主窗口最小化时 `rect` 是 `-32000` 的废值，算出来的图标坐标全错（症状：7 个偏移都点不中，报"面板可能不在可见画布内"）；设备窗口最小化时 BitBlt 同样是旧画面。工具现在会自动 `SW_RESTORE` 还原（主窗口或控制台都行，实测 PC1 最小化的控制台能直接还原并截到正确画面），代价是这次动作必定占前台。
- 只读文本用 `texts`，不要往里发自定义 WM_USER 消息。


### 坑（实测崩溃级）
- **不要读 eNSP 状态栏**：给自绘 `msctls_statusbar32` 发 `SB_GETPARTS` 会让整个客户端崩溃。要看"选中数量"就截图。
- 窗口句柄每次拓扑重载都会变，一律按标题/类名重新查找。
- 每个拓扑一个 `eNSP_Client.exe` 进程；关掉一个实例不影响另一个。
- 打开拓扑后 eNSP 可能崩溃（重拓扑尤其明显）。**出现 `no such hwnd` 就是客户端没了**：`taskkill /f /im eNSP_Client.exe` → 重新拉起 → 重开拓扑，别在旧句柄上反复重试。
- 从提权桥里用 Explorer 拉起 eNSP（`{"op":"explore","path":"...eNSP_Client.exe"}`），进程才会在调用结束后继续活着。

## 3. telnet 通道

- 端口 = `.topo` 里设备的 `com_port`（FW=2000、R1=2001、SW1=2002 …）；设备没启动时端口不开放。
- 连上后先发一次回车拿提示符：`<SW1>` / `[SW1]`。没有用户名密码（除非题目配了 AAA）。
- 分屏：VRP 控制台不支持 `screen-length 0 temporary`（会报 `The type of the included user interface must be VTY.`）；`ensp_cli` 已自动应答 `---- More ----`。
- 配置命令用 `system_view:true` 进入 `system-view`；`quit`/`return` 自己按需写进命令列表。
- 防火墙 USG6000V：控制台可能只回 `##` 之类的垃圾或根本没起来。**不要卡在这里**，告知用户后跳过，其余设备照常做。

典型流程：
```json
ensp_cli { "topology_path": "lab/3-1.topo", "device": "SW1",
           "commands": ["display current-configuration"] }
```

## 3.5 保存配置（收尾必做）

实测 `save` 的正确姿势：**只能在用户视图**执行（系统视图下会报错），且设备会反问 `Are you sure to continue?[Y/N]`，必须答 `y`。`ensp_cli` 已经把这套做完：

- 本批命令只要**包含配置改动**（不是纯 `display/ping/tracert/dir`），就会在最后自动 `return` → `save` → 答 `y`，耗时约 0.3–1 s。
- 返回值里的 `saved` 字段告诉你结果：`{performed:true, ok:true, output:"Save the configuration successfully."}`。`ok:false` 要人工再查一次。
- 用户明确说"不用保存/临时实验"才传 `save:false`；单条读取想省时间也可以传 `save:false`。
- `stop_all` / 重启设备会让**没 save 的配置全部丢失**（设备从 `vrpcfg.cfg` 重新加载），所以保存必须发生在停设备之前。
- 校验落盘：`display saved-configuration` 能看到刚下发的条目，或 `dir` 里 `vrpcfg.cfg` 时间戳是刚才。

## 4. .topo 文件通道

- 是带 BOM 的 XML：`<topo><devices><dev .../></devices><lines/><shapes/><txttips/></topo>`。
- 每个 `<dev>` 上有：`id`(GUID)、`name`、`model`、`com_port`、`cx/cy`（图标左上角）、`edit_left/edit_top`（标签锚点）、`settings`（PC/Server 的 `-simpc_ip`、`-ipaddr` 等）。
- 只能改名/IP/端口这类属性；加设备、连线、改图标很难靠改文件做对，交给 GUI。
- 手工拼出来的最小 topo 打开是**空白画布**（缺 `shapes`/`txttips`），别手搓拓扑。
- 改完要关掉拓扑再重开，eNSP 不会热加载。
- 复制整个拓扑文件夹到别处通常能打开，但个别拓扑（设备多、含 S5700）复制后会崩，先试再批量。

## 5. 实验标准流程

1. `ensp_status` + `ensp_topo list` 摸清现状（设备、型号、端口、标注里的地址规划）。
2. 规划：谁做网关、谁做 DNS/Web、地址段从标注里读，不要自己编。
3. 改名/IP 能离线做就先用 `ensp_topo` 改，再开拓扑。
4. 启动设备 → `ensp_status include_telnet:true` 确认端口开放。
5. 配置依次下发（`ensp_cli` + `system_view`），每台设备配完立刻复制回显留档；**配完就 `save`**（`ensp_cli` 会自动做，检查 `saved.ok`）。
6. **验证**（见下），不通过就查错误目录，不要急着截图。
7. 截图：需要"像学生手动做"的界面时，用 `ensp_cli echo_to_window:true` 把同样命令用**真实键盘**打进设备窗口再截（命令会真的再执行一次，`display` 类命令无所谓，配置类命令要挑不会报错的写法）。回显前工具会先确认窗口可见并抢到前台，抢不到就拒绝打字而不是乱打。截完用 `close_console` 收掉窗口。
8. `ensp_doc` 出两份文档；回复里列改动过的密码和账号表。

### 时间基准（本机实测）
| 动作 | 耗时 |
| --- | --- |
| 一次提权桥启动（一批 steps 的总启动成本） | 0.3–0.4 s |
| 批内单步（点击/截图/读窗口/打字） | 15–90 ms |
| 主窗口截图 | 30–90 ms |
| `open_console`（双击图标 + 确认窗口出现） | 2.5–3.5 s |
| `ensp_shot target=device`（窗口已可见） | 0.6 s |
| `start_all`（含等所有端口起来） | 8–10 s |
| `stop_all`（含等端口全关） | 4–8 s |
| `ensp_cli` 单条命令（telnet 已连） | 30–100 ms |
| `ensp_doc` 两份 docx | 3 s |


## 6. 四层验证（缺一层就不算通过）

1. **配置层**：`display current-configuration` 里能看到刚下发的条目。
2. **接口层**：`display ip interface brief` 全部 Up/Up。
3. **路由层**：`display ip routing-table` 有明细路由或默认路由。
4. **连通层**：`ping` 5 个包全通，`tracert` 路径符合规划。

时间与 NAT：跨设备 ping 要等 ARP/路由收敛，**首包超时是正常现象**，截图前等 10–14 s；NAT 转换用 `display nat session all` 或抓包确认，别只看 ping 通就写"配置正确"。

## 7. 错误目录（实测）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `(5, 'PostMessage', '拒绝访问')` | 调用方权限低于 eNSP | 走 `ensp_gui`（自带提权桥），别自己调 win32 API |
| `refusing to click ... belongs to '<别的程序>'` | 目标坐标被别的窗口盖住 | 先 `{"op":"activate","ensp":true}`，或直接用带 `expect` 的点击让桥自己抬升 |
| `refusing to send keystrokes ...` / `refusing to type` | 目标窗口没拿到前台，怕把按键打到用户窗口里 | 先 `activate`，再 `safetype`；确认 eNSP 真的在最前面 |
| `no such hwnd ...` | 客户端崩溃或窗口重建 | 重新 `ensp_status`，必要时重启 eNSP 并重开拓扑 |
| 点启动没反应 | 没有选中设备 / 窗口没激活 | `start_all` 已含激活+点空白+Ctrl+A；若仍无反应，检查是否被别的窗口盖住 |
| telnet 端口 timeout | 设备没启动 / 还没起完 | `start_all` 会自己等端口；手动等 5–15 s；FW 可能要几分钟或直接失败 |
| `Error: The type of the included user interface must be VTY.` | 在控制台用了 VTY 专属命令 | 改用自动应答分屏 |
| 截图为全黑/旧画面 | 窗口没绘制、已隐藏，或被遮挡 | 设备窗口必须用 `open_console` 打开后再截；主窗口用 `ensp_shot` 的窗口 DC 截图，不需要置顶 |
| 打开拓扑即崩溃 | 拓扑本身/副本有问题 | 用原路径打开；先关掉其它实例 |
| `设备窗口「SW1」当前没有显示` | 传了 `target=device` 但没给 `topology_path` | 补上 `topology_path`，或先 `open_console` |
| GUI 桥不可用 / 一直超时 | 没装 pywin32·Pillow、`pythonExecutable` 指错，或 **UAC 授权框被拒绝**（`ShellExecuteW` 返回 1223 = 用户取消） | 看 `ensp_status.notes`；让用户以管理员身份运行 DSH，或点"是"授权一次 |
| 换机器后第一次 GUI 动作卡住十几秒 | 该机 UAC 是默认级别，`runas` 会给**每个 job** 弹授权框（实测一次冷启动开设备窗口 ≈ 7 个 job，一场实验 20–60 次） | 让用户点一次，或把 `mode` 设成 `"serve"`（提权侧车只启动一次），最省事是让用户以管理员身份运行 DSH（`runas` 变成继承，0 次弹框） |
| `面板可能不在可见画布内（试过 7 个图标位置）` | eNSP 主窗口被**最小化**了，`rect` 是 `-32000` 废值 | 已自动 `SW_RESTORE` 后重算；若仍失败让用户先还原 eNSP 窗口 |
| `bridge.elevated:false` 但 eNSP 在跑 | 桥没提权，对提权窗口的消息会被 UIPI 拒绝 | 以管理员身份运行 DSH；telnet/.topo 通道仍然可用 |
| `saved.ok:false` | `save` 回显里没有成功字样 | 补 `display saved-configuration` 核对，或 `dir` 看 `vrpcfg.cfg` 时间戳 |
| 停设备后配置全丢 | 重启会从 `vrpcfg.cfg` 重新加载，RAM 里没 `save` 的改动全丢 | 停设备**之前**先 `save`；`ensp_cli` 改配置时会自动保存 |


## 8. 交付清单

- **两份文档**：`<任务>-说明版.docx`（每张截图下一句话说明 + 账号表）、`<任务>-纯截图版.docx`（只在题目下贴图，无任何说明文字）。
- **密码清单**：本次实验改动过的所有口令（console/VTY/AAA/SSH/enable），以及当前生效的"账号—口令"明文对照表，写在文档末尾和回复里。
- **回显留档**：关键验证输出（ping/路由表/接口状态）连同命令一起保存。
- **配置已落盘**：每台配过的设备 `save` 成功（`saved.ok:true`），交付时说明已保存；若用户要求不保存，明确写出来。
- 交付前自查：设备名是否按规则、接口是否全 Up、截图是否与题目一一对应、有没有残留调试日志、设备窗口/多余窗口是否已关掉。

