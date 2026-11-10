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
2. **命令先查表**：`reference/commands.md` 是插件内置的 VRP 命令速查（含 NAT/安全策略/ARP/VLAN/路由/验证命令
   和「报错 → 处理」对照）。表里有的直接下发，**不要联网搜**；只有设备真的回了
   `Error: ...` / `Unrecognized command` / `Wrong parameter` 才去搜，搜到实测通过后补回表里。
3. 需要真实点击（启动设备、拖设备）时先提醒用户"将短暂接管鼠标，结束后还原"。
4. 要截图时先问用户：**是否关闭显示调试信息**（`undo debugging all`、`undo terminal monitor`），否则回显里会混入调试日志。
5. 需要改名时问用户：按重要程度编号（SW1/SW2、AR1/AR2、FW1）；用户给了规则以用户为准。
6. **收尾必须保存配置**（见 3.5）：用户没说"不用保存"，就要每台配过的设备都落盘。

> **无人值守 / 子代理降级策略**：上面 3–5 条要"先问用户"，但被别的 agent 委派时 `ask_user_question`
> 会直接失败（`human interaction is unavailable`）。这种情况下按默认值继续，不要卡住：
> 默认 `undo debugging all` + `undo terminal monitor`；默认不改设备名（除非题目提示符要求）；
> 关掉别人开着的拓扑前先 Ctrl+S 保存。

## 0.4 参考文档可能本身就是错的

题目 .docx、课件 .pptx 只能当**线索**，不能当真理。它们的常见错误：命令少了关键字、
视图写错（接口视图里的 system-view 命令）、显示命令名过时、地址规划与拓扑图不一致、
甚至把别的题目的配置抄了进来。

按影响分两档处理：

- **小错（可以在一次试跑内纠正）**：命令报 `Unrecognized` / `Wrong parameter` / `Incomplete`，
  或显示命令查不到。→ 用 `display ?` / `xxx ?` 探一下正确写法，改用设备接受的命令**继续做完**，
  并在交付文档的备注里记一句「参考文档 X 处写法有误，实际用 Y」。
- **大错（会改变结论或没法判断对错）**：拓扑/地址规划自相矛盾、关键步骤缺失、
  安全策略方向与题意相反、题目要求与设备能力不符。→ **停下来告诉用户**，说明哪一处冲突、
  你打算怎么改，等确认再动；不要自己编一套方案硬做。

交付时随手加一节「参考文档与实现不一致的地方」，把上面两类都列出来——这比默默绕过有价值。

**读文档的方式**：先用 `ensp_ref` 把题目/课件转成 `.txt`（同一份文件自动缓存），之后用检索工具查关键词；反复读取二进制 Office 文件既慢又容易被压缩截断。

## 0.5 效率铁律（比任何技巧都重要）

工具本身只要几百毫秒，**真正的成本是回合数**：每一步都要等模型重新想一遍（实测一步 20–40 s），
所以「一步只发一个工具调用」会让整场实验的时间随步数线性膨胀。实测一条完整实验只要 7% 的时间在工具上，
其余 90%+ 是逐回合的等待——**步数减半，总时长就减半**。

1. **互不依赖的调用必须并行**：一条 assistant 消息里同时发 3–5 个 tool call（配 A / 配 B / 配 C、截 3 张图、
   读 3 个文件），不要一个发完等回显再发下一个。
2. **多设备一次下发**：
   ```json
   ensp_cli {"topology_path":"…topo",
             "devices":[{"device":"FW","commands":[…],"username":"admin","password":"Admin@123"},
                        {"device":"AR","commands":[…]},
                        {"device":"SW","commands":[…]}]}
   ```
   三台设备一次调用并行跑完（实测 ~0.9 s），单台失败只在它自己那项报 `error`，不影响其它设备。
3. **截图成批**：`ensp_shot {"shots":[{out…},{out…,"target":"screen"}]}` 一次调用截多张；
   要截命令行时，把同一台设备的 2–4 条 `display` 串进一次 `ensp_cli echo_to_window`，一张图顶几张。
4. **少读图**：核对以文本为准（`output_file` 落盘 + 检索），截图只在最后抽查 2–3 张确认排版；
   逐张 `read_image` 是纯浪费回合。
5. **一次问完**：需要用户拍板的事（口令、是否改名、是否关调试信息）合并成一次提问，别分三次。
6. **先想好再动手**：一个阶段（打开拓扑→配置→验证→截图→出文档）内的动作应该能在 3–6 步内发完；
   如果发现自己在「配一条→看一眼→再配一条」，立刻改成批量。

## 1. 通道选择（从快到慢）

| 需求 | 用什么 | 说明 |
| --- | --- | --- |
| 读题目 docx / 课件 pptx | `ensp_ref` | 一次转成 .txt，之后用检索工具查，不要反复解析 Office |
| 看拓扑结构/设备名/端口/IP | `ensp_topo action=list` | 纯文件解析，零延迟 |
| 改设备名、改 PC IP、分配端口 | `ensp_topo action=rename/set-ip/set-ports` | 生成新 .topo，不动 GUI |
| 跑配置/取回显/保存 | `ensp_cli`（telnet） | 单条命令几十毫秒；改配置会自动 `save` |
| 启动/停止设备、开设备窗口 | `ensp_gui`（start_all / open_console） | 必须走 GUI |
| 交付截图（开窗+打字+截图+关窗一条龙） | `ensp_capture` | 一次调用出多张，最省回合 |
| 交付截图（单张 / 特殊裁切） | `ensp_shot` / `ensp_cli echo_to_window` | 窗口 DC 截图，不抢焦点 |

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

### 启动设备（防火墙很慢，别用 sleep 盲等）

- `start_all` 自己轮询端口；第一次点启动后**一个端口都没起来**，它会自动重新全选再点一次。
- 防火墙（USG6000V）是整台虚拟机，启动常要几分钟。**不要写 `Start-Sleep 90` 这种**：
  要么先配不依赖它的设备，要么一次等到位：
  `{"op":"wait_ports","ports":[2000],"timeout_ms":300000}`（返回等了多久、哪些端口开了）。
- **端口被残留进程占用**：eNSP 退出后有时会留下仍监听 2000~2002 的僵尸进程。此时设备"启动失败"、
  telnet 连得上却没有回显、`start_all` 还会误以为设备已经在跑。先清掉再启动：
  `{"op":"free_ports","ports":[2000,2001,2002]}`（返回杀了哪些 pid、还剩哪些端口）。

### 切换拓扑（从 A 拓扑换到 B 拓扑）

**首选一条调用**（`open` 会把 .topo 直接打开，不是只启动 eNSP）：

```json
ensp_gui steps=[
  {"op":"kill","names":["eNSP_Client.exe"]},
  {"op":"sleep","t":3},
  {"op":"open","path":"E:/…/【实训任务3.3】….topo"},
  {"op":"sleep","t":14}
]
```

然后 `start_all`（带 `topology_path`）即可。

- 不想杀进程时：先 Ctrl+S 保存当前拓扑 → `{"op":"close","hwnd":<主窗口>}` → 弹出的是**自绘保存框**，
  `texts` 只读到 `Button1/2/3` 没有文字、`bmclick` 点了没反应，必须 `ensp_shot` 截图看位置再真实点击 →
  最后仍然用 `{"op":"open","path":…}` 打开新拓扑。
- ⚠ **不要把 .topo 路径当命令行参数传给 `eNSP_Client.exe`**（`spawn` / `explore` 带参）：只会开出一个
  空白的「新建拓扑」画布，看起来像打开了、其实 0 台设备。
- 判断到底开没开：`ensp_status` 的实例标题不是「新建拓扑」，且 `ensp_topo action=list` 能列出设备；
  画布空白就是没开。

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
- 防火墙默认凭据：账号 `admin`、口令 `Admin@123`（首次可能强制改密 → 传 `new_password`）。
  **口令只用题目/用户给的值**：不确定就在一次调用里传候选列表 `passwords: ["Admin@123", "Huawei@123"]`，
  工具会按顺序自动重试并告诉你哪个通了；**别猜变体**（试过 `Admin@1234` 这种，纯浪费回合）。
- **长回显可能被上层压缩**：结果超过几百字节时，`results[].output` 可能被替换成 `<<ccr:…,1.2KB>>` 这类标记，
  `| include` 过滤也救不回来。对策（按顺序试）：
  1. 传 `output_file: "工作区/回显/xx.txt"` 把完整回显落盘，再用 `ops_grep` 精确检索；
  2. 用 `echo_to_window:true` + `screenshot_out` 截图，`read_image` 看回显（学生视角也更真实）；
  3. 把一条大命令拆成几条小的（`display current-configuration | include nat` 而不是整份配置）。

典型流程：
```json
ensp_cli { "topology_path": "lab/3-1.topo", "device": "SW1",
           "commands": ["display current-configuration"] }
```

### 用 expect 让工具判对错（省掉「看一眼再决定」的回合）

`commands` 旁边加一个等长的 `expect` 数组，`expect[i]` 必须出现在 `commands[i]` 的回显里
（大小写不敏感的子串；写成 `/正则/` 时按正则匹配）。返回值多出 `checks[]` 和 `ok`，
不需要再把整段回显读进上下文：

```json
ensp_cli { "topology_path": "lab/3-3.topo", "device": "FW", "save": false,
           "commands": ["display nat-policy rule all", "display ip routing-table protocol static"],
           "expect":   ["destination-nat", "2.2.10.10/32"] }
→ { "ok": false, "checks": [ {"command": "…", "pass": true, "missing": []},
                             {"command": "…", "pass": false, "missing": ["2.2.10.10/32"]} ] }
```

配置类命令不写 `expect` 就只返回回显；验证类命令建议都写，`ok` 就是这一批的结论。

### 批量取证：ensp_capture

报告里那些「窗口里一条 display + 一张截图」的图，别再自己 open_console → 打字 → shot → close，
一条调用交清单即可（每项内部会：开窗 → 激活 → 补回车唤醒 → 逐条打字 → 等回显 → 重新激活 → 截图 → 关窗）：

```json
ensp_capture { "topology_path": "lab/3-3.topo",
  "shots": [
    {"device": "FW", "commands": ["display nat-policy rule all"], "out": "截图/t6/05_fw_nat.png"},
    {"device": "AR", "commands": ["display ip routing-table protocol static"], "out": "截图/t6/08_ar_route.png"},
    {"device": "SW", "commands": ["display vlan"], "out": "截图/t6/10_sw_vlan.png"} ] }
```

一项 1–4 条**短的 display** 最合适（图和回显都要放得下）；`settle_ms` 默认 1600，回显特别长时加到 2500。
拓扑图本身（画布那个）还是用 `ensp_shot target=main` 截主窗口再裁。

**先断言再截图**：条目里加 `expect`（与 `commands` 等长），工具会先用 telnet 跑一遍并核对，
**断言不过就不截图**，返回 `skipped: true` + 缺什么；这样「拍完再看一眼对不对」的回合就没了：

```json
ensp_capture { "topology_path": "lab/3-4.topo", "shots": [
  {"device": "FW", "commands": ["display firewall server-map"],
   "expect": ["2.2.10.10"], "out": "截图/t7/04_servermap.png"} ] }
```

## 3.6 ensp_doc 的自检（别自己写脚本数段落）

`ensp_doc` 生成完会自己比对模板和成品，直接返回结构校验，不需要再用 pwsh/python 去数：

```json
"verification": {
  "template": {"paragraphs": 49, "textParagraphs": 9, "images": 1},
  "output":   {"paragraphs": 52, "textParagraphs": 9, "images": 15},
  "addedImages": 14, "textUnchanged": true, "ok": true }
```

- `textUnchanged: false` = 纯截图版的正文被改了，必须停下修。
- `template_path` 找不到时会按名字近似匹配（中文文件名多一个空格、全角括号都能对上），
  返回的 `notes` 会说明匹配到了哪个文件。
- `clean_probe`（默认 true）会删掉成品图所在目录里的 `_` 开头过程截图，避免交付目录里一堆废图。

## 3.5 保存配置（收尾必做）

实测 `save` 的正确姿势：**只能在用户视图**执行（系统视图下会报错），且设备会反问 `Are you sure to continue?[Y/N]`（AR2220 是 `(y/n)[n]:`），必须答 `y`。`ensp_cli` 已经把这套做完：

- 本批命令只要**包含配置改动**（不是纯 `display/ping/tracert/dir`），就会在最后自动 `return` → `save`，耗时约 0.3–1 s。
- 返回值里的 `saved` 字段告诉你结果：`{performed:true, ok:true, output:"Save the configuration successfully."}`。`ok:false` 要人工再查一次。
- 用户明确说"不用保存/临时实验"才传 `save:false`；单条读取想省时间也可以传 `save:false`。
- `stop_all` / 重启设备会让**没 save 的配置全部丢失**（设备从 `vrpcfg.cfg` 重新加载），所以保存必须发生在停设备之前。
- 校验落盘：`display saved-configuration` 能看到刚下发的条目，或 `dir` 里 `vrpcfg.cfg` 时间戳是刚才。

### 3.5.1 保存拓扑（比 save 更容易漏）

**设备 `save` 只写进设备自己的 flash，关掉 eNSP 后并不保证还在。** 实测：只做设备 `save`、然后结束 `eNSP_Client.exe` 进程，重开同一个 `.topo` 时配置全部回到初始状态（拓扑目录里的 `vrpcfg.cfg` 还是 0 字节、`flash.efz`/`vrpcfg.zip` 还是几个月前的时间戳）。

要把配置真正留在拓扑里，收尾必须再按一次 **主窗口 Ctrl+S（保存拓扑）**：

```
ensp_gui steps=[{"op":"activate","title":"eNSP"},{"op":"key","mods":["ctrl"],"key":"s"},{"op":"sleep","t":5}]
```

按下后拓扑目录里的设备文件会立刻被回写，用文件大小/时间戳就能验证：

```powershell
$dir = Get-ChildItem "E:\...\lab\3-1" -Directory | Select-Object -First 1
Get-ChildItem $dir.FullName -Recurse -File | ForEach-Object { "{0:yyyy-MM-dd HH:mm:ss} {1,8:N0} {2}" -f $_.LastWriteTime, $_.Length, $_.Name }
```

实测 USG6000V 拓扑按 Ctrl+S 后：`vrpcfg.cfg` 0 → 4,913 B、`vrpcfg.zip` 619 → 618 B、`flash.efz` 9,348 → 11,188 B，全部变成当时时间；随后关掉 eNSP 重开，主机名、接口地址、NAT 策略、改过的口令都还在，ping 8.8.8.8 仍然 5/5。

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
5. **先看再配**：拓扑可能已经预配了一部分（接口地址、静态路由），盲配会得到
   `Error: The address already exists.` / `Error: The route already exists.`。
   先跑一条 `display ip interface brief` + `display ip routing-table` 摸清基线，已有的跳过。
   设备名 vs 主机名：`.topo` 里的 `name` 是图标名，VRP 主机名是另一回事（USG 出厂叫 `USG6000V1`）；
   题目提示符写 `[FW]` 时，用 `sysname FW` 对齐，截图和文档才对得上。
6. 配置依次下发（`ensp_cli` + `system_view`），每台设备配完立刻复制回显留档；**配完就 `save`**（`ensp_cli` 会自动做，检查 `saved.ok`）。
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
| 首条命令超时、partial output 只有 `##` | 端口已开放但设备还没就绪（AR2220 冷启动实测第一次 20 s 超时） | 加 `command_timeout_ms: 45000` 重试一次；实测重试 269 ms 就正常，不是链路问题 |
| `Error: The type of the included user interface must be VTY.` | 在控制台用了 VTY 专属命令 | 改用自动应答分屏 |
| 截图为全黑/旧画面 | 窗口没绘制、已隐藏，或被遮挡 | 设备窗口必须用 `open_console` 打开后再截；主窗口用 `ensp_shot` 的窗口 DC 截图，不需要置顶 |
| 回显截图里只有命令行、没有输出 | 旧版把行尾写成 `\r`，桥的 `type_text` 会跳过 `\r`，命令没提交 | 0.2.1 已改成 `\n`（映射 VK_RETURN）；若仍缺输出，加大 `echo_settle_ms` |
| 打开拓扑即崩溃 | 拓扑本身/副本有问题 | 用原路径打开；先关掉其它实例 |
| `设备窗口「SW1」当前没有显示` | 传了 `target=device` 但没给 `topology_path` | 补上 `topology_path`，或先 `open_console` |
| GUI 桥不可用 / 一直超时 | 没装 pywin32·Pillow、`pythonExecutable` 指错，或 **UAC 授权框被拒绝**（`ShellExecuteW` 返回 1223 = 用户取消） | 看 `ensp_status.notes`；让用户以管理员身份运行 DSH，或点"是"授权一次 |
| 换机器后第一次 GUI 动作卡住十几秒 | 该机 UAC 是默认级别，`runas` 会给**每个 job** 弹授权框（实测一次冷启动开设备窗口 ≈ 7 个 job，一场实验 20–60 次） | 让用户点一次，或把 `mode` 设成 `"serve"`（提权侧车只启动一次），最省事是让用户以管理员身份运行 DSH（`runas` 变成继承，0 次弹框） |
| `面板可能不在可见画布内（试过 7 个图标位置）` | eNSP 主窗口被**最小化**了，`rect` 是 `-32000` 废值 | 已自动 `SW_RESTORE` 后重算；若仍失败让用户先还原 eNSP 窗口 |
| `bridge.elevated:false` 但 eNSP 在跑 | 桥没提权，对提权窗口的消息会被 UIPI 拒绝 | 以管理员身份运行 DSH；telnet/.topo 通道仍然可用 |
| `saved.ok:false` | `save` 回显里没有成功字样 | 补 `display saved-configuration` 核对，或 `dir` 看 `vrpcfg.cfg` 时间戳 |
| AR2220 `save` 报 `Error: Unrecognized command found at '^' position.` | 旧版先发 `save`、等提示再发 `y`，AR 已经把提示符弹回来了 | 0.2.2 已改成一次写 `save\ny\n`（LF）；旧版可传 `commands:["save\ny"]` 手动补 |
| `console authentication failed for user "admin"` | 口令不对，或改密流程没走完（答 `N` 会被踢回 `Login authentication`） | 先试出厂 `Admin@123`；设备要求改密时传 `new_password`（工具会走 Y→旧→新→确认） |
| USG6000V 登录卡在 `The password needs to be changed. Change now? [Y/N]:` | 出厂口令首次登录强制改密 | `ensp_cli` 传 `username`/`password`/`new_password`，例如 `admin` + `Admin@123` → `Huawei@123` |
| 重开 `.topo` 后配置全没了 | 只做了设备 `save`，**没保存拓扑**；eNSP 只在 Ctrl+S 时把设备 flash 写回拓扑目录 | 收尾按主窗口 **Ctrl+S**，再用 `vrpcfg.cfg`/`flash.efz` 的大小和时间戳确认 |
| 设备窗口截图是旧画面（不刷新） | 窗口被遮挡/不在前台时，窗口 DC 不重绘，BitBlt 拿到上一屏 | 工具已在截图前 `RedrawWindow`+`UpdateWindow`；仍不行就先 `activate` 该窗口再截 |
| telnet 能用但窗口打字乱码/丢字符 | 控制台空闲超时（`Configuration console time out, please press any key to log on`），第一个按键被吃掉；或打字太快 | 工具已自动先发一个回车唤醒；`echo_to_window` 的 `per_char` 已提到 0.05 |
| 重置拓扑文件夹后设备配置还在 | eNSP 的设备状态保存在设备镜像里，重新解压 .zip 不等于复位 | 真复位要在设备上 `reset saved-configuration` 再 `reboot`；否则先 `display current-configuration` 核对残留 |
| 会话表查不到刚做的 HTTP 访问 | HTTP 会话读完响应很快就拆，查询有个时间窗 | 触发访问后 0.3 s 内查；或连查 2–3 次 / 用 `display firewall session table verbose` |
| 停设备后配置全丢 | 重启会从 `vrpcfg.cfg` 重新加载，RAM 里没 `save` 的改动全丢 | 停设备**之前**先 `save`；`ensp_cli` 改配置时会自动保存 |


## 8. 交付清单

- **两份文档**：`<任务>-说明版.docx`（每张截图下一句话说明 + 账号表）、`<任务>-纯截图版.docx`。
  纯截图版**必须以用户给的原始题目文档为底**：原文字、原题号、原排版一律不动，只把截图塞进
  对应题号/步骤下面的空白处。**不要自己建章节、不要重排或补题号**——生成一份只有
  自己编号的"截图册"是错的。
  直接给 `ensp_doc` 传 `template_path: "题目.docx"`，`sections[].heading` 写 `步骤3` 这种短标识，
  工具会自己找锚点、按顺序填空白段落（不够时按最后一个空段的格式新建）。以前这步要现写
  python-docx 脚本，半小时起步。
- **纯截图版的第一个 section 永远是实际拓扑图**：插在题目自带的参考拓扑图**正下方**，同样不加
  任何文字说明。题目有 `图1 …拓扑连接图` 这种图注就用 `heading: "图1"`；没有图注（图后面直接接
  正文）就用 `anchor: "#pic1"`，表示「模板里第 1 张图所在的那一段」。成品顺序应为：
  题目拓扑图 → 图注 → 实际拓扑图 → 操作步骤，与用户认可的样例一致。
- **密码清单**：本次实验改动过的所有口令（console/VTY/AAA/SSH/enable），以及当前生效的"账号—口令"明文对照表，写在文档末尾和回复里。
- **回显留档**：关键验证输出（ping/路由表/接口状态）连同命令一起保存。
- **配置已落盘**：每台配过的设备 `save` 成功（`saved.ok:true`），交付时说明已保存；若用户要求不保存，明确写出来。
- 交付前自查：设备名是否按规则、接口是否全 Up、截图是否与题目一一对应、有没有残留调试日志、设备窗口/多余窗口是否已关掉。

