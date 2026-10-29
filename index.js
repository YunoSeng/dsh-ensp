import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

import { Bridge, runProcess, sleep } from './lib/bridge-client.js'
import { VrpSession, probePort } from './lib/cli.js'
import {
  describeDevices, parseTopo, readTopo, renameDevice, renumberComPorts,
  setComPort, setDeviceIpv4, suggestNames, writeTopo,
} from './lib/topo.js'

export const name = 'ensp-automation'
export const inject = ['tools', 'skills', 'systemPrompt']

export const Config = Schema.object({
  pythonExecutable: Schema.string().default(''),
  pythonCandidates: Schema.array(Schema.string()).default([]),
  docsPythonExecutable: Schema.string().default(''),
  mode: Schema.string().default('job'),
  timeoutMs: Schema.number().default(180000),
  restrictToWorkspace: Schema.boolean().default(true),
  textTakeoverNotice: Schema.boolean().default(true),
  registerSkill: Schema.boolean().default(true),
  injectPrompt: Schema.boolean().default(true),
  enspExecutable: Schema.string().default('C:/Program Files/Huawei/eNSP/eNSP_Client.exe'),
  toolbarStart: Schema.array(Schema.number()).default([659, 56]),
  toolbarStop: Schema.array(Schema.number()).default([698, 56]),
  iconHalfSize: Schema.array(Schema.number()).default([32, 28]),
})

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))
const LIB_ROOT = join(PACKAGE_ROOT, 'lib')
const BRIDGE_PATH = join(LIB_ROOT, 'bridge.py')
const LAUNCH_PATH = join(LIB_ROOT, 'launch.py')
const DOCS_SCRIPT = join(LIB_ROOT, 'make_docs.py')
const SKILL_ROOT = join(PACKAGE_ROOT, 'skills', 'ensp-automation')
const SKILL_PATH = join(SKILL_ROOT, 'SKILL.md')

const PROMPT_SECTION = `## eNSP 实验自动化（dsh-ensp）

操作华为 eNSP 网络实验时按下面的顺序执行，不要凭记忆猜坐标或命令。

通道优先级（从快到慢，能上位就不用下位）：
1. \`ensp_topo\` 直接读/改 .topo 文件——拓扑结构、设备名、com_port、PC 的 IP 都能离线改写，不需要点鼠标。
2. \`ensp_cli\` 走 telnet（127.0.0.1:<com_port>）下发命令——比点 GUI 快两个数量级，命令和回显都在返回值里。
3. \`ensp_gui\` 批量步骤——只用于必须点界面的动作（启动/停止设备、打开设备窗口、切换面板）。
4. 真实鼠标点击（\`click\` 带 \`restore:true\`）是最后手段，用完必须把鼠标还原。

硬性工作规范：
- 截图前先问用户：是否关闭显示调试信息（\`undo debugging all\`、\`undo terminal monitor\`），避免回显里出现调试日志。
- 用户提供实训文档时，交付两份文档：一份截图下配一句话说明；一份只在对应题目下贴截图、不写任何说明文字。
- 设备需要改名时先问用户；要改名则按重要程度编号（SW1/SW2、AR1/AR2、FW1）；用户给了命名规则就以用户为准。
- 优先接管已经打开的 eNSP；没有已打开的实例再找本机可用的 eNSP（任意版本）；发现多个版本时问用户用哪一个——不要自己挑。
- 命令不确定就上网搜或先用 \`ensp_cli\` 试一条，再进配置；不要编造命令。
- 防火墙（USG6000V）可能起不来或控制台无回显；遇到就告知用户并继续其余部分，不要卡住。
- 将要接管鼠标（真实点击/拖拽）前必须提醒用户，并说明会还原鼠标位置。
- 交付时列出本次实验改动过的所有密码，以及当前生效的账号/密码对照表（明文写在文档末尾和回复里）。
- **配置要落盘**：实验结束时每台被配置过的设备都必须 \`save\`（\`ensp_cli\` 在改配置时会自动保存，返回值里的 \`saved\` 字段会说明是否成功）。只有用户明确提出"不用保存/临时实验"时才传 \`save:false\`。收尾时逐台核对 \`saved.ok\`，别把"没存盘"的实验交给用户。
- **保存拓扑**：设备 \`save\` 只写进设备 flash，配置能不能跟着 \`.topo\` 走取决于 eNSP 有没有保存拓扑。实验结束时用 \`ensp_gui\` 给主窗口发一次 Ctrl+S，再用拓扑目录里 \`vrpcfg.cfg\`/\`flash.efz\` 的大小和时间戳确认回写；不按的话重开拓扑会回到初始配置（实测）。
- **少抢前台、少弹窗口**：telnet 和主窗口截图都不需要 eNSP 在前台，默认就别激活、别前置。只有两种情况需要把窗口拿到前台：截设备命令行窗口（必须先双击图标打开并抢到前台）和点非客户区（工具栏/菜单）。用完可以用 \`{op:"close_console",device:"SWX"}\` 收掉设备窗口，保持用户桌面干净。

行为要点（已实测，别再踩）：
- eNSP 每个拓扑一个进程，窗口句柄每次都会变：一律按标题/类名重新查找，不要复用旧 hwnd。
- eNSP 是提权进程：普通权限进程的 PostMessage/SetWindowPos 会返回"拒绝访问"。本项目自带的 shell 提权桥（bridge.py）负责点击，别用别的方式模拟输入。
- 提权桥靠 \`ShellExecuteW("runas")\` 启动。本机 UAC 调成"从不通知"时静默通过；**换到 UAC 默认设置的机器，第一次（或每个 job，取决于 mode）会弹出一次 UAC 授权框**，需要用户点一次"是"。遇到桥不可用又看不出别的原因，先问用户是不是把授权框点了拒绝（返回码 1223 = 用户取消）。
- 永远不要给 eNSP 的自绘状态栏发 SB_GETPARTS 之类的 WM_USER 消息——会直接让客户端崩溃。要判断选中数量就看截图。
- 设备图标要先选中（点空白处 + Ctrl+A）再点工具栏"启动"；工具栏在非客户区，只能真实点击。
- 真实点击一定要带 \`expect\`（"ensp" / 窗口标题 / hwnd）：用户很可能开着别的全屏窗口盖住 eNSP，裸点击会打到人家窗口里。带 \`expect\` 时桥会先把 eNSP 抬到最上层再确认坐标归属，否则拒绝点击。
- 发按键（Ctrl+A、打字）前必须先 \`activate\`；\`safetype\` 在窗口没拿到前台时会直接拒绝，别绕过它。
- 设备窗口不能用 ShowWindow 显示（eNSP 会立刻再隐藏），只能双击画布图标打开；**隐藏窗口截图拿到的是旧画面**，所以 \`ensp_shot target=device\` 必须先确保窗口可见（需要 \`topology_path\`）。
- 事件与遮挡的关系：窗口被别的程序**盖住**时，窗口 DC 截图照样正确（不需要置顶）；但真实点击会被前台窗口吃掉（所以有 \`expect\` 守卫），真实键盘输入必须窗口在前台。窗口被**最小化/隐藏**时截图会拿到旧画面或黑图。\`postclick\`（消息投递）不受遮挡影响，但只对客户区控件有效，工具栏/非客户区仍然必须真实点击。
- 截图用 \`ensp_shot\`（窗口 DC 位图，主窗口被别的窗口遮住也能截，约 30–90 ms），不要全屏截图。
- 配置下发/验证用 \`ensp_cli\`；一次不要开太多设备窗口，用完即关。`

/**
 * Commands that only read state (or only move around the CLI). A batch built
 * from these never needs ``save``; anything else is treated as a configuration
 * change and saved automatically, because lab work must survive a restart.
 */
const READ_ONLY_COMMAND = /^(display\b|dis\s|ping\b|tracert\b|dir\b|more\b|save\b|screen-length\b|system-view\b|quit\b|return\b|undo\s+terminal\b|terminal\b|reset\s+counters\b|refresh\b)/iu

function isReadOnlyCommand(line) {
  const text = String(line ?? '').trim()
  return text === '' || READ_ONLY_COMMAND.test(text)
}

function readSkillDefinition(path) {
  const raw = readFileSync(path, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(raw)
  if (match === null) throw new Error(`dsh-ensp: invalid skill frontmatter at ${path}`)
  const nameMatch = /^name:\s*(.+)$/mu.exec(match[1])
  const descriptionMatch = /^description:\s*(.+)$/mu.exec(match[1])
  if (nameMatch === null || descriptionMatch === null) {
    throw new Error(`dsh-ensp: skill requires name and description at ${path}`)
  }
  return { name: nameMatch[1].trim(), description: descriptionMatch[1].trim(), content: match[2].trim() }
}

function sessionWorkspace(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return resolve(typeof cwd === 'string' && cwd.trim() !== '' ? cwd : process.cwd())
}

function isWithin(root, target) {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel))
}

async function resolveWorkspacePath(rawPath, exec, config, { mustExist = false, kind = 'path' } = {}) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') throw new Error(`${kind} must be a non-empty string`)
  const workspace = sessionWorkspace(exec)
  const target = resolve(isAbsolute(rawPath) ? rawPath : join(workspace, rawPath))
  if (!config.restrictToWorkspace) return target
  if (!isWithin(workspace, target)) {
    throw new Error(`${kind} must stay inside the dsh session workspace: ${workspace}`)
  }
  const workspaceReal = await realpath(workspace)
  if (mustExist) {
    const targetReal = await realpath(target).catch((error) => {
      if (error?.code === 'ENOENT') throw new Error(`${kind} does not exist: ${target}`)
      throw error
    })
    if (!isWithin(workspaceReal, targetReal)) throw new Error(`${kind} resolves outside the dsh session workspace`)
    return target
  }
  return target
}

async function assertRegularFile(path, label) {
  const info = await stat(path).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`${label} does not exist: ${path}`)
    throw error
  })
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${path}`)
  return info
}

async function prepareOutput(path, allowOverwrite, label) {
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`${label} exists and is not a regular file: ${path}`)
    if (!allowOverwrite) throw new Error(`${label} already exists; choose a versioned path or set allow_overwrite=true`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await mkdir(dirname(path), { recursive: true })
  return path
}

function renderJson(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * DSH rejects tool results that cannot round-trip through JSON, so `undefined`
 * fields must disappear (not become the string "undefined") and non-finite
 * numbers must become null. Every tool return value goes through this.
 */
function lossless(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((item) => lossless(item))
  if (typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) {
      const item = value[key]
      if (item === undefined) continue
      out[key] = lossless(item)
    }
    return out
  }
  return String(value)
}

// --------------------------------------------------------------- device mapping

/**
 * Match topology labels (canvas coordinates) to the live ``Edit`` controls that
 * eNSP places over every device name, yielding the canvas -> screen offset.
 */
function labelOffset(devices, rects) {
  if (rects.length === 0) return null
  let best = null
  for (const device of devices) {
    for (const rect of rects) {
      const dx = rect[0] - device.editLeft
      const dy = rect[1] - device.editTop
      let score = 0
      for (const other of devices) {
        const hit = rects.some((candidate) => Math.abs(candidate[0] - (other.editLeft + dx)) <= 3
          && Math.abs(candidate[1] - (other.editTop + dy)) <= 3)
        if (hit) score += 1
      }
      if (best === null || score > best.score) best = { dx, dy, score }
    }
  }
  return best
}

async function deviceScreenPoint(bridge, config, devices, deviceName) {
  const device = devices.find((item) => item.name.toLowerCase() === deviceName.toLowerCase())
  if (!device) throw new Error(`device "${deviceName}" is not in the topology (have: ${devices.map((d) => d.name).join(', ')})`)
  let result = await bridge.steps([{ op: 'ensp' }])
  let payload = result.steps[0] ?? {}
  let windows = payload.windows ?? []
  if (windows.length === 0) throw new Error('no eNSP window is open')
  let main = windows.find((item) => !item.minimized) ?? windows[0]
  let restored = false
  if (main.minimized) {
    // A minimized window reports a 0×0 client at -32000, so every derived click
    // point would land off screen. Restore it first, then re-read the anchors.
    result = await bridge.steps([
      { op: 'activate', hwnd: main.hwnd },
      { op: 'sleep', t: 0.5 },
      { op: 'ensp' },
    ])
    payload = result.steps[2] ?? {}
    windows = payload.windows ?? []
    main = windows.find((item) => item.hwnd === main.hwnd) ?? windows[0]
    restored = true
    if (!main || main.minimized || (main.client_size?.[0] ?? 0) <= 0) {
      throw new Error('eNSP 主窗口处于最小化状态且自动还原失败，请先手动还原 eNSP 窗口')
    }
  }
  const group = (payload.anchors ?? []).find((entry) => entry.main === main.hwnd)
  const rects = (group?.items ?? []).map((item) => item.rect)
  const offset = labelOffset(devices, rects)
  if (!offset) {
    throw new Error('could not read the canvas label anchors; pass explicit x/y with {op:"click"} instead')
  }
  const [halfW, halfH] = config.iconHalfSize
  return {
    main,
    offset,
    restored,
    point: [Math.round(device.cx + halfW + offset.dx), Math.round(device.cy + halfH + offset.dy)],
    device,
  }
}

/** Visible, non-minimized top-level windows whose title is exactly ``title``. */
async function visibleWindows(bridge, title) {
  const result = await bridge.steps([{ op: 'windows', filter: title, visible_only: true }])
  const windows = result.steps[0]?.windows ?? []
  return windows.filter((item) => (item.title ?? '').toLowerCase() === title.toLowerCase()
    && !item.minimized
    && (item.client_size?.[0] ?? 0) > 0)
}

/**
 * A user-minimized console is not the same trap as a hidden one: ``SW_RESTORE``
 * works on it, while a ShowWindow call on a hidden console is undone by eNSP.
 * Also, BitBlt of a minimized window yields a stale frame, so treat it as closed.
 */
async function restoreMinimizedWindow(bridge, title) {
  const listed = await bridge.steps([{ op: 'windows', filter: title, visible_only: true }])
  const windows = (listed.steps[0]?.windows ?? []).filter((item) => (item.title ?? '').toLowerCase() === title.toLowerCase())
  const minimized = windows.find((item) => item.minimized)
  if (!minimized) return { hwnd: 0 }
  await bridge.steps([{ op: 'activate', hwnd: minimized.hwnd }, { op: 'sleep', t: 0.45 }])
  const after = await visibleWindows(bridge, title)
  return { hwnd: after[0]?.hwnd ?? 0, restored: after.length > 0 }
}

/**
 * Make a device window visible.
 *
 * eNSP re-hides a device window that is shown with ShowWindow from outside, and
 * a hidden window only yields a stale BitBlt image, so the only reliable way to
 * reveal one is the same double-click a human uses on the device icon.
 */
async function ensureDeviceWindow(bridge, config, devices, title, { offset, settle = 1.1 } = {}) {
  const existing = await visibleWindows(bridge, title)
  if (existing.length > 0) return { open: true, method: 'already-visible', hwnd: existing[0].hwnd }
  const revived = await restoreMinimizedWindow(bridge, title)
  if (revived.hwnd) return { open: true, method: 'restored', hwnd: revived.hwnd }
  if (!devices || devices.length === 0) {
    return { open: false, method: 'none', needsTopology: true }
  }
  const mapped = await deviceScreenPoint(bridge, config, devices, title)
  const [bx, by] = mapped.point
  const offsets = offset
    ? [offset]
    : [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8], [12, 12], [-12, -12]]
  for (const [ox, oy] of offsets) {
    await bridge.steps([
      { op: 'click', x: bx + ox, y: by + oy, double: true, restore: true, expect: mapped.main.hwnd },
      { op: 'sleep', t: settle },
    ])
    const now = await visibleWindows(bridge, title)
    if (now.length > 0) return { open: true, method: 'icon-click', hwnd: now[0].hwnd, point: [bx + ox, by + oy] }
  }
  return { open: false, method: 'icon-click', tried: offsets.length, point: [bx, by] }
}

// --------------------------------------------------------------- tool factory

function createTools(config, bridge) {
  const tools = []

  tools.push(defineTool({
    name: 'ensp_status',
    description: 'Report the eNSP situation before doing anything else: running client windows (pid/rect/topology path when detectable), installed eNSP versions, GUI-bridge health and privilege, and the device inventory of a topology file.',
    parameters: {
      topology_path: { type: 'string', description: 'Optional .topo path; when given its devices, models and telnet ports are returned.' },
      include_telnet: { type: 'boolean', description: 'Probe the telnet console ports of the topology; defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspaceRoot: { type: 'string', required: true },
          bridge: { type: 'object', additionalProperties: true, required: true },
          instances: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          installed: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          deviceWindows: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          topology: { type: 'object', additionalProperties: true },
          telnet: { type: 'array', items: { type: 'object', additionalProperties: true } },
          notes: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const notes = []
      const installed = await listInstalledEnsp(config)
      const steps = [{ op: 'ping' }, { op: 'ensp' }, ...installed.map((entry) => ({ op: 'exeinfo', path: entry.path }))]
      let bridgeInfo = { available: false, error: 'bridge not started' }
      let instances = []
      let deviceWindows = []
      try {
        const probeStarted = Date.now()
        const batch = await bridge.steps(steps)
        const ping = batch.steps[0] ?? {}
        bridgeInfo = {
          available: ping.pong === true,
          elevated: ping.elevated,
          dpiAware: ping.dpi_aware,
          screen: ping.screen,
          transport: batch.transport ?? 'job',
          elapsedMs: Date.now() - probeStarted,
        }
        const payload = batch.steps[1] ?? {}
        instances = (payload.windows ?? []).map((w) => ({
          hwnd: w.hwnd, pid: w.pid, rect: w.rect, minimized: w.minimized,
          title: w.title, cls: w.cls,
        }))
        deviceWindows = (payload.devices ?? []).map((w) => ({ hwnd: w.hwnd, title: w.title, rect: w.rect }))
        for (const [index, entry] of installed.entries()) {
          const info = batch.steps[2 + index]
          if (info?.exe?.version) entry.version = info.exe.version
          if (info?.exe?.modified) entry.modified = info.exe.modified
        }
        if (instances.length === 0) {
          notes.push('没有发现已打开的 eNSP 窗口：可以用 ensp_gui 的 {op:"explore",path:"…eNSP_Client.exe"} 拉起，或先问用户想用哪个版本。')
        }
        if (instances.some((item) => item.minimized)) {
          notes.push('eNSP 主窗口当前是最小化的：截图（窗口 DC）不受影响，但真实点击/双击图标前工具会自动把它还原到前台（最小化窗口的坐标是 -32000，全是废值）。')
        }
        if (bridgeInfo.available && bridgeInfo.elevated === false) {
          notes.push('提权桥当前没有管理员权限：对提权运行的 eNSP 发窗口消息会被拒绝（UIPI）。请以管理员身份运行 DSH；或在 UAC 未放行的机器上用 mode "serve"，让提权进程只启动一次（每次启动都可能弹一次 UAC 授权框）。')
        }
      } catch (error) {
        bridgeInfo = { available: false, error: error instanceof Error ? error.message : String(error) }
        notes.push(`GUI 桥不可用：${bridgeInfo.error}。telnet 通道和 .topo 文件通道不受影响。`)
        notes.push('常见原因：没装 pywin32/Pillow、pythonExecutable 指错、或 UAC 授权框被拒绝（返回码 1223 = 用户取消）。')
      }
      if (installed.length > 1) notes.push('本机存在多个 eNSP 版本，请先问用户使用哪一个。')

      let topology
      let telnet = []
      if (args.topology_path) {
        const path = await resolveWorkspacePath(args.topology_path, exec, config, { mustExist: true, kind: 'topology_path' })
        const parsed = await readTopo(path)
        topology = {
          path,
          version: parsed.version,
          devices: describeDevices(parsed),
          annotations: parsed.annotations,
        }
        if (args.include_telnet) {
          telnet = await Promise.all(parsed.devices
            .filter((device) => device.comPort > 0)
            .map((device) => probePort(device.comPort)))
          const down = telnet.filter((entry) => !entry.open)
          if (down.length > 0) notes.push(`以下控制台端口未开放（设备未启动或起不来）：${down.map((entry) => entry.port).join(', ')}`)
        }
      }

      return lossless({
        workspaceRoot: sessionWorkspace(exec),
        bridge: bridgeInfo,
        instances,
        installed,
        deviceWindows,
        topology,
        telnet: args.include_telnet ? telnet : undefined,
        notes,
      })
    },
  }))

  tools.push(defineTool({
    name: 'ensp_gui',
    description: 'Drive the eNSP window in one batched call. Steps run in a single elevated process, so a whole UI flow costs one launch (~0.3 s) instead of one per action. Convenience ops: start_all, stop_all, open_console (device), device_window (device, alias of open_console), close_console (device). Raw ops: click, postclick, drag, wheel, type, posttext, key, paste, settext, bmclick, show, focus, close, resize, wait, texts, children, wndat, info, shot, screen, open, explore, kill, sleep, ensp.',
    parameters: {
      steps: {
        type: 'array',
        required: true,
        description: 'Ordered steps. Raw steps use bridge op names and arguments (e.g. {"op":"postclick","hwnd":123,"x":10,"y":20}). Convenience steps take {op:"open_console", device:"SW1"} (needs topology_path), {op:"close_console", device:"SW1"}, {op:"start_all"}, {op:"stop_all"}.',
        items: { type: 'object', additionalProperties: true },
      },
      topology_path: { type: 'string', description: 'Needed by open_console / device_window / start_all to map device names to canvas coordinates.' },
      icon_offset: { type: 'array', items: { type: 'integer' }, description: 'Force one icon hit offset [dx, dy] for open_console instead of the built-in retry spiral.' },
      timeout_ms: { type: 'integer', description: 'Batch timeout; defaults to the configured value.' },
      allow_cursor_takeover: { type: 'boolean', description: 'Acknowledge that a real click will move the user pointer (it is restored afterwards). Defaults to false.' },
      start_wait_ms: { type: 'integer', description: 'How long start_all waits for console ports to come up; defaults to 25000.' },
      stop_wait_ms: { type: 'integer', description: 'How long stop_all waits for console ports to close; defaults to 12000.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          transport: { type: 'string' },
          steps: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          elapsedMs: { type: 'integer', required: true },
          requiresCursorTakeover: { type: 'boolean', required: true },
          notes: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      if (!Array.isArray(args.steps) || args.steps.length === 0) throw new Error('steps must be a non-empty array')
      const started = Date.now()
      const notes = []
      let devices = null
      if (args.topology_path) {
        const path = await resolveWorkspacePath(args.topology_path, exec, config, { mustExist: true, kind: 'topology_path' })
        devices = (await readTopo(path)).devices
      }

      const results = []
      let pending = []
      let needsCursor = false
      let startAllRequested = false
      let stopAllRequested = false
      const flush = async () => {
        if (pending.length === 0) return
        const batch = pending
        pending = []
        const batchResult = await bridge.steps(batch, { timeoutMs: args.timeout_ms })
        for (const step of batchResult.steps) results.push({ ...step, index: results.length })
      }
      const run = async (steps) => {
        const batchResult = await bridge.steps(steps, { timeoutMs: args.timeout_ms })
        for (const step of batchResult.steps) results.push({ ...step, index: results.length })
        return batchResult
      }

      for (const step of args.steps) {
        const op = String(step.op ?? '')
        if (op === 'start_all' || op === 'stop_all') {
          needsCursor = true
          if (op === 'start_all') startAllRequested = true
          else stopAllRequested = true
          const [dx, dy] = op === 'start_all' ? config.toolbarStart : config.toolbarStop
          if (op === 'start_all') {
            pending.push({ op: 'activate', ensp: true })
            pending.push({ op: 'click', ensp_rel: [400, 470], restore: true })
            pending.push({ op: 'key', key: 'a', mods: ['ctrl'], ensp: true })
            pending.push({ op: 'sleep', t: 0.4 })
          }
          pending.push({ op: 'click', ensp_rel: [dx, dy], restore: true })
          pending.push({ op: 'sleep', t: step.settle ?? 1.0 })
          continue
        }
        if (op === 'open_console' || op === 'device_window') {
          if (!devices) throw new Error(`${op} needs topology_path`)
          const target = String(step.device)
          await flush()
          needsCursor = true
          const outcome = await ensureDeviceWindow(bridge, config, devices, target, {
            offset: step.icon_offset ?? args.icon_offset,
            settle: step.settle ?? 1.1,
          })
          if (outcome.open && outcome.method === 'already-visible') {
            notes.push(`${target} 窗口本来就开着，直接用就行。`)
          } else if (outcome.open) {
            notes.push(`${target} 窗口已打开（图标点击 ${outcome.point?.join(',')}）。`)
          } else {
            notes.push(`没打开 ${target} 的窗口：试过 ${outcome.tried} 个图标位置都没出现该窗口。请确认画布缩放是 100%、该设备在可见画布内，或用 {op:"click",x:…,y:…,double:true} 直接给坐标。`)
          }
          continue
        }
        if (op === 'close_console') {
          pending.push({ op: 'close', title: String(step.device) })
          notes.push(`${step.device} 窗口已关闭（需要时再 open_console 打开）。`)
          continue
        }
        // Raw file-writing ops must land in the session workspace, not in the
        // bridge's own working directory (which is the plugin's lib folder).
        if (typeof step.out === 'string' && step.out !== '') {
          const out = await resolveWorkspacePath(step.out, exec, config, { kind: 'out' })
          await prepareOutput(out, true, 'out')
          pending.push({ ...step, out })
          continue
        }
        pending.push(step)
      }
      await flush()

      // Device consoles need several seconds to come up (or go down); poll the
      // console ports so the caller does not have to guess or sleep blindly.
      const watchPorts = async (ports, want, timeoutMs) => {
        const deadline = Date.now() + timeoutMs
        let open = []
        for (;;) {
          const probes = await Promise.all(ports.map((port) => probePort(port, { timeoutMs: 700 })))
          open = probes.filter((probe) => probe.open).map((probe) => probe.port)
          const settled = want === 'open' ? open.length === ports.length : open.length === 0
          if (settled || Date.now() > deadline) return open
          await new Promise((resolve) => { setTimeout(resolve, 800) })
        }
      }
      if (devices) {
        const ports = devices.filter((device) => device.comPort > 0).map((device) => device.comPort)
        if (startAllRequested && ports.length > 0) {
          const open = await watchPorts(ports, 'open', args.start_wait_ms ?? 25000)
          const missing = ports.filter((port) => !open.includes(port))
          if (missing.length === 0) {
            notes.push(`全部 ${ports.length} 个控制台端口已开放（${open.join(', ')}），可以开始下发命令。`)
          } else {
            notes.push(`这些控制台端口还没通：${missing.join(', ')}。常见原因：设备还在启动（可再等几秒）、防火墙/USG 起不来、或该设备本来就没有控制台。`)
          }
        }
        if (stopAllRequested && ports.length > 0) {
          const open = await watchPorts(ports, 'closed', args.stop_wait_ms ?? 12000)
          notes.push(open.length === 0
            ? '设备已全部停止（控制台端口全部关闭）。'
            : `停止后仍有控制台端口在线：${open.join(', ')}。可能只关掉了部分设备，或不在这张拓扑里的设备。`)
        }
      }

      if (needsCursor && !args.allow_cursor_takeover) {
        notes.push('本批包含真实鼠标点击（会短暂接管指针，结束后还原）。如用户尚未知晓，请在回复里说明。')
      }
      const failures = results.filter((step) => step.ok === false)
      if (failures.length > 0) {
        notes.push(`${failures.length} 个步骤失败：${failures.map((step) => `#${step.index} ${step.op} ${step.error}`).join(' | ')}`)
      }
      return lossless({
        transport: bridge.serving?.healthy ? 'serve' : 'job',
        steps: results,
        elapsedMs: Date.now() - started,
        requiresCursorTakeover: needsCursor,
        notes,
      })
    },
  }))

  tools.push(defineTool({
    name: 'ensp_shot',
    description: 'Screenshot the eNSP main window, a device window, or the whole screen into PNG. Captures through the window DC, so the window may stay behind other windows and unfocused (~15 ms).',
    parameters: {
      out: { type: 'string', required: true, description: 'Output .png path inside the workspace.' },
      target: { type: 'string', description: 'main | device | screen; defaults to main.' },
      device: { type: 'string', description: 'Device window title when target=device (e.g. SW1).' },
      hwnd: { type: 'integer', description: 'Explicit window handle instead of a name.' },
      crop: { type: 'array', items: { type: 'integer' }, description: 'Optional [x, y, width, height] crop in image pixels.' },
      topology_path: { type: 'string', description: 'Needed when target=device and that window is not visible yet (it is then opened by double-clicking the device icon).' },
      allow_overwrite: { type: 'boolean', description: 'Replace an existing file; defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          window: { type: 'object', additionalProperties: true },
          notes: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const out = await resolveWorkspacePath(args.out, exec, config, { kind: 'out' })
      await prepareOutput(out, args.allow_overwrite === true, 'out')
      const target = args.target ?? 'main'
      const notes = []
      let devices = null
      if (args.topology_path) {
        const path = await resolveWorkspacePath(args.topology_path, exec, config, { mustExist: true, kind: 'topology_path' })
        devices = (await readTopo(path)).devices
      }
      const steps = []
      if (target === 'screen') {
        steps.push({ op: 'screen', out, crop: args.crop })
      } else if (target === 'device') {
        const title = args.device ?? ''
        if (!title) throw new Error('target=device needs device (window title) or hwnd')
        // A hidden device window only yields a stale bitmap, so make it visible first.
        const outcome = await ensureDeviceWindow(bridge, config, devices, title, { settle: 1.1 })
        if (!outcome.open) {
          if (outcome.needsTopology) {
            throw new Error(`设备窗口「${title}」当前没有显示，用 ShowWindow 打开会被 eNSP 立刻隐藏。请传 topology_path 让工具走双击图标的路径，或先用 ensp_gui 的 open_console。`)
          }
          throw new Error(`设备窗口「${title}」打不开：面板可能不在可见画布内（试过 ${outcome.tried} 个图标位置）。`)
        }
        steps.push({ op: 'shot', title, out, crop: args.crop })
        notes.push(`设备窗口来源：${outcome.method}。`)
      } else {
        steps.push(args.hwnd
          ? { op: 'shot', hwnd: args.hwnd, out, crop: args.crop }
          : { op: 'shot', ensp: true, out, crop: args.crop })
      }
      const result = await bridge.steps(steps)
      const shot = result.steps.filter((step) => step.ok && step.width).pop()
      if (!shot) {
        const failure = result.steps.find((step) => !step.ok)
        throw new Error(`screenshot failed: ${failure?.error ?? 'unknown error'}`)
      }
      return lossless({
        path: out,
        width: shot.width,
        height: shot.height,
        window: shot.window,
        notes,
      })
    },
  }))

  tools.push(defineTool({
    name: 'ensp_cli',
    description: 'Send commands to a started eNSP device over its console telnet port (com_port from the .topo) and return the cleaned transcript. Optionally echo the same commands into the device CLI window and screenshot it, which is what lab reports need.',
    parameters: {
      commands: { type: 'array', items: { type: 'string' }, required: true, description: 'VRP commands in order, without the trailing newline.' },
      device: { type: 'string', description: 'Device name from the topology (resolves the port).' },
      port: { type: 'integer', description: 'Explicit console port; overrides device lookup.' },
      topology_path: { type: 'string', description: '.topo path used to resolve device -> port.' },
      system_view: { type: 'boolean', description: 'Enter system-view first; defaults to false.' },
      username: { type: 'string', description: 'Username when the console asks for AAA login.' },
      password: { type: 'string', description: 'Password when the console asks for AAA login.' },
      new_password: { type: 'string', description: 'New password to set when the device forces a password change on first login (a USG that still has the factory password asks this). Omit to decline the change.' },
      command_timeout_ms: { type: 'integer', description: 'Per-command timeout; defaults to 20000.' },
      echo_to_window: { type: 'boolean', description: 'Open the device console window and type the same commands there with real keystrokes (they execute a second time) so the window can be screenshotted the way a student would see it.' },
      save: { type: 'boolean', description: 'Write the running configuration to flash after the commands. Leave empty to save automatically whenever this batch changes the configuration (lab work must survive a device restart); pass false only when the user explicitly wants a throw-away configuration.' },
      screenshot_out: { type: 'string', description: '.png path for the echoed window screenshot (requires echo_to_window).' },
      echo_settle_ms: { type: 'integer', description: 'Wait after typing before the screenshot; defaults to 1200.' },
      echo_gap_ms: { type: 'integer', description: 'Pause between echoed commands; defaults to 600.' },
      allow_cursor_takeover: { type: 'boolean', description: 'Acknowledge a real click may be used to open the device window.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: { type: 'string' },
          port: { type: 'integer', required: true },
          prompt: { type: 'string', required: true },
          results: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          echo: { type: 'object', additionalProperties: true },
          screenshot: { type: 'string' },
          saved: { type: 'object', additionalProperties: true },
          notes: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const notes = []
      let port = args.port
      let deviceName = args.device
      if (!port) {
        if (!args.topology_path || !deviceName) throw new Error('provide port, or device + topology_path')
        const path = await resolveWorkspacePath(args.topology_path, exec, config, { mustExist: true, kind: 'topology_path' })
        const parsed = await readTopo(path)
        const device = parsed.devices.find((item) => item.name.toLowerCase() === deviceName.toLowerCase())
        if (!device) throw new Error(`device "${deviceName}" is not in ${path}`)
        if (!device.comPort) throw new Error(`device "${deviceName}" has no console port (it never started)`)
        port = device.comPort
      }
      const session = new VrpSession({
        port,
        username: args.username,
        password: args.password,
        newPassword: args.new_password,
        commandTimeoutMs: args.command_timeout_ms,
      })
      let prompt = ''
      let results = []
      let saved
      try {
        const opened = await session.open()
        prompt = opened.prompt
        const ran = await session.run(args.commands, { systemView: args.system_view === true })
        prompt = ran.prompt
        results = ran.results
        const mutating = args.commands.some((line) => !isReadOnlyCommand(String(line)))
        const wantSave = args.save === false ? false : (args.save === true ? true : mutating)
        if (wantSave) {
          const done = await session.save()
          results = [...results, ...done.results]
          const entry = done.results[done.results.length - 1] ?? {}
          const ok = /successfully|had been saved|已保存|保存成功/iu.test(entry.output ?? '')
          saved = { performed: true, ok, output: entry.output ?? '' }
          if (!ok) notes.push('保存配置的回显里没有出现成功字样，请再确认一次（display saved-configuration 或 dir）。')
        } else {
          saved = { performed: false, reason: args.save === false ? 'disabled-by-args' : 'read-only batch' }
        }
      } finally {
        session.close()
      }

      let echo
      let screenshot
      if (args.echo_to_window) {
        if (!deviceName) throw new Error('echo_to_window needs device so the window can be found')
        if (!args.allow_cursor_takeover) {
          notes.push('回显需要打开设备窗口（会短暂接管鼠标并还原）。')
        }
        let devices = null
        if (args.topology_path) {
          const path = await resolveWorkspacePath(args.topology_path, exec, config, { mustExist: true, kind: 'topology_path' })
          devices = (await readTopo(path)).devices
        }
        const opened = await ensureDeviceWindow(bridge, config, devices, deviceName, { settle: 1.1 })
        if (!opened.open) {
          throw new Error(opened.needsTopology
            ? `设备窗口「${deviceName}」没有显示：回显需要 topology_path 才能双击图标打开它。`
            : `设备窗口「${deviceName}」打不开（试过 ${opened.tried} 个图标位置）。`)
        }
        // Real keystrokes, guarded: refuse rather than leak them into another app.
        //
        // The line must end with "\n": bridge type_text maps "\n" to VK_RETURN and
        // deliberately skips "\r", so a "\r" terminator types the command but never
        // submits it — the text then sits in the input buffer and the screenshot
        // shows no output at all.
        const steps = []
        for (const line of args.commands) {
          steps.push({ op: 'safetype', title: deviceName, text: `${line}\n`, per_char: 0.02 })
          steps.push({ op: 'sleep', t: Number(args.echo_gap_ms ?? 900) / 1000 })
        }
        steps.push({ op: 'sleep', t: Number(args.echo_settle_ms ?? 1800) / 1000 })
        if (args.screenshot_out) {
          const out = await resolveWorkspacePath(args.screenshot_out, exec, config, { kind: 'screenshot_out' })
          await prepareOutput(out, true, 'screenshot_out')
          steps.push({ op: 'shot', title: deviceName, out })
          screenshot = out
        }
        const echoed = await bridge.steps(steps)
        const failures = echoed.steps.filter((step) => !step.ok)
        echo = {
          window: opened.method,
          typed: echoed.steps.filter((step) => step.op === 'safetype' && step.ok).length,
          reexecutes: true,
        }
        if (failures.length > 0) notes.push(`回显失败 ${failures.length} 步：${failures[0].error}`)
      }

      return lossless({ device: deviceName, port, prompt, results, echo, screenshot, saved, notes })
    },
  }))

  tools.push(defineTool({
    name: 'ensp_topo',
    description: 'Read or rewrite an eNSP .topo file without touching the GUI: list devices with models and console ports, rename devices, set PC/server IPv4, renumber console ports, or propose SW1/SW2/AR1 names.',
    parameters: {
      topology_path: { type: 'string', required: true, description: 'Existing .topo file inside the workspace.' },
      action: { type: 'string', required: true, description: 'list | suggest-names | rename | set-ip | set-ports.' },
      renames: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'For rename: [{from, to}].' },
      device: { type: 'string', description: 'For set-ip: device name.' },
      ip: { type: 'string' },
      mask: { type: 'string' },
      gateway: { type: 'string' },
      port: { type: 'integer', description: 'For set-ports: starting console port; defaults to 2000.' },
      out_path: { type: 'string', description: 'Write the result to this path (never edits the source in place).' },
      allow_overwrite: { type: 'boolean' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          topologyPath: { type: 'string', required: true },
          action: { type: 'string', required: true },
          version: { type: 'string', required: true },
          devices: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          suggestions: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          written: { type: 'string' },
          notes: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const path = await resolveWorkspacePath(args.topology_path, exec, config, { mustExist: true, kind: 'topology_path' })
      await assertRegularFile(path, 'topology_path')
      if (extname(path).toLowerCase() !== '.topo') throw new Error('topology_path must end in .topo')
      const parsed = await readTopo(path)
      const action = String(args.action)
      const notes = []
      let text = parsed.text
      let written

      if (action === 'rename') {
        const renames = Array.isArray(args.renames) ? args.renames : []
        if (renames.length === 0) throw new Error('rename needs renames: [{from, to}]')
        for (const item of renames) text = renameDevice(text, String(item.from), String(item.to))
      } else if (action === 'set-ip') {
        if (!args.device) throw new Error('set-ip needs device')
        text = setDeviceIpv4(text, String(args.device), { ip: args.ip, mask: args.mask, gateway: args.gateway })
      } else if (action === 'set-ports') {
        const renumbered = renumberComPorts(text, { start: args.port ?? 2000 })
        text = renumbered.text
        notes.push(`已分配/保留控制台端口：${renumbered.assigned.map((entry) => `${entry.name}=${entry.comPort}`).join(', ')}`)
      } else if (action !== 'list' && action !== 'suggest-names') {
        throw new Error(`unknown action ${action}`)
      }

      if (action === 'rename' || action === 'set-ip' || action === 'set-ports') {
        const out = args.out_path
          ? await resolveWorkspacePath(args.out_path, exec, config, { kind: 'out_path' })
          : join(dirname(path), `${basename(path, '.topo')}.edited.topo`)
        await prepareOutput(out, args.allow_overwrite === true, 'out_path')
        await writeTopo(out, text)
        written = out
        notes.push('eNSP 需要在关闭该拓扑后重新打开，改动才会显示。')
      }

      const after = parseTopo(text)
      return lossless({
        topologyPath: path,
        action,
        version: after.version ?? '',
        devices: describeDevices(after),
        suggestions: action === 'suggest-names' ? suggestNames(after.devices) : [],
        written,
        notes,
      })
    },
  }))

  tools.push(defineTool({
    name: 'ensp_doc',
    description: 'Build the two lab deliverables from a screenshot manifest: a captioned report (one short sentence under each screenshot) and a bare copy (screenshots only, no prose), plus the plaintext credential table.',
    parameters: {
      title: { type: 'string', required: true, description: 'Report title, usually the lab task name.' },
      output_dir: { type: 'string', required: true, description: 'Directory inside the workspace for the .docx files.' },
      sections: {
        type: 'array',
        required: true,
        description: 'Ordered sections: {heading, paragraphs?, commands?, images:[{path, caption?}]}. In the bare copy only heading + images survive.',
        items: { type: 'object', additionalProperties: true },
      },
      subtitle: { type: 'string', description: 'Line under the title (name / class / date).' },
      credentials: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Password table rows: {item, value}.' },
      notes: { type: 'array', items: { type: 'string' }, description: 'Closing notes (captioned copy only).' },
      file_stem: { type: 'string', description: 'Base file name; defaults to the sanitized title.' },
      allow_overwrite: { type: 'boolean' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          captioned: { type: 'string' },
          bare: { type: 'string' },
          images: { type: 'integer', required: true },
          notes: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const notes = []
      const dir = await resolveWorkspacePath(args.output_dir, exec, config, { kind: 'output_dir' })
      await mkdir(dir, { recursive: true })
      const stem = (args.file_stem ?? args.title ?? '实验报告').replace(/[\\/:*?"<>|]/gu, '_')
      const captionedOut = join(dir, `${stem}-说明版.docx`)
      const bareOut = join(dir, `${stem}-纯截图版.docx`)
      if (args.allow_overwrite !== true) {
        if (existsSync(captionedOut)) throw new Error(`captioned report already exists: ${captionedOut}`)
        if (existsSync(bareOut)) throw new Error(`bare report already exists: ${bareOut}`)
      }
      const sections = Array.isArray(args.sections) ? args.sections : []
      const manifestBase = {
        title: args.title,
        subtitle: args.subtitle,
        credentials: args.credentials,
        notes: args.notes,
        sections,
      }
      const python = await resolveDocsPython(config, notes)
      const dirWork = await mkdtemp(join(tmpdir(), 'dsh-ensp-doc-'))
      const built = []
      for (const [mode, out] of [['captioned', captionedOut], ['bare', bareOut]]) {
        const manifest = { ...manifestBase, mode, output: out }
        const manifestPath = join(dirWork, `${mode}.json`)
        await writeFile(manifestPath, JSON.stringify(manifest, null, 1), 'utf8')
        const run = await runProcess(python, [DOCS_SCRIPT, manifestPath], { timeoutMs: 120000 })
        if (run.code !== 0) {
          throw new Error(`document build failed (${mode}): ${run.stderr.trim() || run.stdout.trim()}`)
        }
        built.push(out)
      }
      const images = sections.reduce((sum, section) => sum + (section.images?.length ?? 0), 0)
      return lossless({ captioned: captionedOut, bare: bareOut, images, notes })
    },
  }))

  return tools
}

// --------------------------------------------------------------- environment

async function listInstalledEnsp(config) {
  const roots = new Set()
  const candidates = [
    'C:/Program Files/Huawei',
    'C:/Program Files (x86)/Huawei',
    'D:/Program Files/Huawei',
    config.enspExecutable,
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    const path = candidate.replace(/\//gu, '\\')
    if (path.toLowerCase().endsWith('ensp_client.exe')) {
      if (existsSync(path)) roots.add(dirname(path))
      continue
    }
    try {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (!/^ensp/iu.test(entry.name)) continue
        const exe = join(path, entry.name, 'eNSP_Client.exe')
        if (existsSync(exe)) roots.add(join(path, entry.name))
      }
    } catch {
      // missing folder
    }
  }
  const rows = []
  for (const root of roots) {
    rows.push({ path: join(root, 'eNSP_Client.exe'), root })
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path))
}

async function resolveDocsPython(config, notes) {
  const explicit = (config.docsPythonExecutable ?? '').trim()
  if (explicit && existsSync(explicit)) return explicit
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const runtimeRoot = home ? join(home, '.dsh', 'dsh-runtimes') : ''
  if (runtimeRoot) {
    try {
      const entries = await readdir(runtimeRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const exe = join(runtimeRoot, entry.name, 'dependencies', 'python', 'python.exe')
        if (existsSync(exe)) {
          notes.push(`使用 DSH 自带 Python 生成文档：${exe}`)
          return exe
        }
      }
    } catch {
      // no runtimes folder
    }
  }
  notes.push('没有找到带 python-docx 的 Python，改用 PATH 上的 python；如果失败请设置 docsPythonExecutable。')
  return 'python'
}

// --------------------------------------------------------------- registration

export function apply(ctx, config) {
  const bridge = new Bridge(config, { bridge: BRIDGE_PATH, launch: LAUNCH_PATH })
  if (config.registerSkill) {
    const definition = readSkillDefinition(SKILL_PATH)
    ctx.skills.register({
      ...definition,
      source: 'bundled',
      provider: 'dsh-ensp',
      resourceBase: { kind: 'directory', path: SKILL_ROOT },
    })
  }
  if (config.injectPrompt && ctx.systemPrompt) {
    ctx.systemPrompt.section({
      name: 'ensp:automation',
      order: 130,
      text: PROMPT_SECTION,
    })
  }
  for (const tool of createTools(config, bridge)) ctx.tools.register(tool)
}

export { PROMPT_SECTION, BRIDGE_PATH, DOCS_SCRIPT }
