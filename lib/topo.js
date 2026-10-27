/**
 * .topo reader/writer.
 *
 * An eNSP topology is plain UTF-8-with-BOM XML: ``<topo><devices><dev .../>``.
 * Every device carries the facts the automation needs - name, model, console
 * ``com_port`` (the telnet port once started), canvas ``cx``/``cy`` and the
 * label anchor ``edit_left``/``edit_top``.  Edits are textual attribute
 * replacements so unknown elements survive untouched.
 */

import { readFile, writeFile } from 'node:fs/promises'

const DEV_TAG = /<dev\b[^>]*>/gu

function attrsOf(tag) {
  const out = {}
  for (const match of tag.matchAll(/([A-Za-z_][\w-]*)="([^"]*)"/gu)) {
    out[match[1]] = match[2]
  }
  return out
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&')
}

function encodeEntities(text) {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')
}

function numeric(value, fallback = 0) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Parse the parts of a topology that automation cares about. */
export function parseTopo(text) {
  const devices = []
  for (const match of text.matchAll(DEV_TAG)) {
    const tag = match[0]
    const attrs = attrsOf(tag)
    if (!attrs.id || !attrs.name) continue
    devices.push({
      id: attrs.id,
      name: decodeEntities(attrs.name),
      model: attrs.model ?? '',
      comPort: Number.parseInt(attrs.com_port ?? '0', 10) || 0,
      cx: numeric(attrs.cx),
      cy: numeric(attrs.cy),
      editLeft: numeric(attrs.edit_left),
      editTop: numeric(attrs.edit_top),
      mac: attrs.system_mac ?? '',
      settings: decodeEntities(attrs.settings ?? ''),
    })
  }
  const tipMatches = [...text.matchAll(/<txttip\b[^>]*content="([^"]*)"/gu)]
  const versionMatch = /<topo[^>]*version="([^"]*)"/u.exec(text)
  return {
    version: versionMatch?.[1] ?? '',
    devices,
    annotationCount: tipMatches.length,
    annotations: tipMatches.map((m) => decodeEntities(m[1])),
  }
}

export async function readTopo(path) {
  const raw = await readFile(path, 'utf8')
  return { text: raw, ...parseTopo(raw) }
}

/** Replace one attribute on the ``<dev>`` tag whose ``name`` matches. */
function patchDevTag(text, name, patcher) {
  let hit = false
  const next = text.replace(DEV_TAG, (tag) => {
    const attrs = attrsOf(tag)
    if (decodeEntities(attrs.name ?? '') !== name) return tag
    hit = true
    return patcher(tag, attrs)
  })
  return { text: next, hit }
}

function setAttribute(tag, attr, value) {
  const encoded = encodeEntities(String(value))
  const pattern = new RegExp(`(\\b${attr}=")[^"]*(")`, 'u')
  if (pattern.test(tag)) return tag.replace(pattern, `$1${encoded}$2`)
  return tag.replace(/\s*\/?>$/u, (tail) => ` ${attr}="${encoded}"${tail}`)
}

/** Rename a device (the topology-side name shown on the canvas). */
export function renameDevice(text, from, to) {
  const { text: next, hit } = patchDevTag(text, from, (tag) => setAttribute(tag, 'name', to))
  if (!hit) throw new Error(`device "${from}" not found in topology`)
  return next
}

/** Assign a console/telnet port to a device. */
export function setComPort(text, name, port) {
  const { text: next, hit } = patchDevTag(text, name, (tag) => setAttribute(tag, 'com_port', port))
  if (!hit) throw new Error(`device "${name}" not found in topology`)
  return next
}

/** Give every startable device a stable, unique console port. */
export function renumberComPorts(text, { start = 2000 } = {}) {
  let port = start
  const assigned = []
  const next = text.replace(DEV_TAG, (tag, offset) => {
    void offset
    const attrs = attrsOf(tag)
    const model = attrs.model ?? ''
    if (!/^(AR|S\d|USG|NE|Router|WLAN)/iu.test(model)) return tag
    const current = Number.parseInt(attrs.com_port ?? '0', 10) || 0
    if (current > 0) {
      assigned.push({ name: decodeEntities(attrs.name ?? ''), comPort: current })
      port = Math.max(port, current + 1)
      return tag
    }
    const chosen = port++
    assigned.push({ name: decodeEntities(attrs.name ?? ''), comPort: chosen })
    return setAttribute(tag, 'com_port', chosen)
  })
  return { text: next, assigned }
}

function setSetting(settings, key, value) {
  const pattern = new RegExp(`(^|\\s)${key}\\s+[^\\s]+`, 'u')
  if (pattern.test(settings)) return settings.replace(pattern, `$1${key} ${value}`)
  return `${settings}${settings.endsWith(' ') || settings === '' ? '' : ' '} ${key} ${value}`.trimStart()
}

/** Set IPv4 of a PC (``-simpc_*``) or a Server/Client (``-ipaddr``...) device. */
export function setDeviceIpv4(text, name, { ip, mask, gateway }) {
  const { text: next, hit } = patchDevTag(text, name, (tag, attrs) => {
    let settings = decodeEntities(attrs.settings ?? '')
    const isPc = /-simpc_/iu.test(settings) || (attrs.model ?? '').toUpperCase() === 'PC'
    if (ip !== undefined) settings = setSetting(settings, isPc ? '-simpc_ip' : '-ipaddr', ip)
    if (mask !== undefined) settings = setSetting(settings, isPc ? '-simpc_mask' : '-ipmask', mask)
    if (gateway !== undefined) settings = setSetting(settings, isPc ? '-simpc_gateway' : '-gateway', gateway)
    return setAttribute(tag, 'settings', settings)
  })
  if (!hit) throw new Error(`device "${name}" not found in topology`)
  return next
}

export async function writeTopo(path, text) {
  await writeFile(path, text, 'utf8')
}

/** Devices worth showing a human: name, model, telnet port. */
export function describeDevices(parsed) {
  return parsed.devices.map((device) => ({
    name: device.name,
    model: device.model,
    comPort: device.comPort,
    telnet: device.comPort > 0 ? `127.0.0.1:${device.comPort}` : null,
  }))
}

const CLIENT_MODELS = /^(PC|Client|Server|MCS|STA)/iu
const SWITCH_MODELS = /^(S\d|LSW)/iu
const ROUTER_MODELS = /^(AR|Router|NE)/iu
const FIREWALL_MODELS = /^(USG|FW|Eudemon)/iu

/**
 * Suggest SW1/SW2..., AR1/AR2..., FW1... names by role.
 *
 * Devices that already follow the convention keep their name, so renumbering
 * never swaps two existing devices. Numbering follows the topology's device
 * order, which is the order the devices were placed.
 */
export function suggestNames(devices) {
  const roleOf = (model) => {
    if (CLIENT_MODELS.test(model)) return null
    if (FIREWALL_MODELS.test(model)) return 'FW'
    if (SWITCH_MODELS.test(model)) return 'SW'
    if (ROUTER_MODELS.test(model)) return 'AR'
    return null
  }
  const taken = new Set()
  for (const device of devices) {
    const role = roleOf(device.model ?? '')
    if (role && new RegExp(`^${role}\\d+$`, 'u').test(device.name)) taken.add(device.name.toUpperCase())
  }
  const counters = { SW: 0, AR: 0, FW: 0 }
  const nextFree = (role) => {
    let number = 1
    for (;;) {
      const candidate = `${role}${number}`
      if (!taken.has(candidate)) {
        taken.add(candidate)
        return candidate
      }
      number += 1
    }
  }
  return devices.map((device) => {
    const model = device.model ?? ''
    const role = roleOf(model)
    if (!role) return { name: device.name, keep: true, reason: '终端设备保持原名' }
    if (new RegExp(`^${role}\\d+$`, 'u').test(device.name)) {
      counters[role] += 1
      return { name: device.name, keep: true, reason: '已符合命名规则' }
    }
    return { name: nextFree(role), from: device.name, keep: false }
  })
}
