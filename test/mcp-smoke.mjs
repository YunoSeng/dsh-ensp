#!/usr/bin/env node
// Smoke test for the MCP front end.
//
// It drives `handleMessage` in-process instead of spawning a child with piped
// stdio, so it runs anywhere Node runs — no eNSP, no Python, no elevated bridge.
// Everything it touches is offline: tool registration, JSON Schema mapping, the
// topology file reader and the workspace boundary.
//
//   npm test        (or: node test/mcp-smoke.mjs)

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createMcpServer } from '../mcp/server.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(HERE, 'fixtures')

const server = createMcpServer({ workspace: WORKSPACE, quiet: true })

const passed = []
const failed = []
const check = (label, condition, detail = '') => {
  if (condition) passed.push(detail ? `${label} — ${detail}` : label)
  else failed.push(detail ? `${label} — ${detail}` : label)
}

/** Send one JSON-RPC message and return the response it produced (if any). */
async function call(message) {
  const sent = []
  await server.handleMessage(message, (payload) => sent.push(payload))
  return sent.at(-1) ?? null
}

const init = await call({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
})
check('initialize 回协议版本', init?.result?.protocolVersion === '2025-06-18', init?.result?.protocolVersion)
check('initialize 声明 tools 能力', Boolean(init?.result?.capabilities?.tools))
check('serverInfo 有名字和版本', init?.result?.serverInfo?.name === 'dsh-ensp', init?.result?.serverInfo?.version)
check('instructions 非空', (init?.result?.instructions?.length ?? 0) > 500, `${init?.result?.instructions?.length} chars`)

const oldInit = await call({
  jsonrpc: '2.0',
  id: 2,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
})
check('旧协议版本被原样回显', oldInit?.result?.protocolVersion === '2024-11-05', oldInit?.result?.protocolVersion)

const unknownInit = await call({
  jsonrpc: '2.0',
  id: 3,
  method: 'initialize',
  params: { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
})
check('未知协议版本回落到默认值', unknownInit?.result?.protocolVersion === '2025-06-18', unknownInit?.result?.protocolVersion)

const list = await call({ jsonrpc: '2.0', id: 4, method: 'tools/list' })
const tools = list?.result?.tools ?? []
check('列出六个工具', tools.length === 6, tools.map((tool) => tool.name).join(', '))
check('工具名齐全', ['ensp_status', 'ensp_gui', 'ensp_shot', 'ensp_cli', 'ensp_topo', 'ensp_doc'].every((name) => tools.some((tool) => tool.name === name)))
check('每个工具都有 object inputSchema', tools.every((tool) => tool.inputSchema?.type === 'object' && tool.inputSchema.properties))
check('每个工具都有描述', tools.every((tool) => typeof tool.description === 'string' && tool.description.length > 20))

const gui = tools.find((tool) => tool.name === 'ensp_gui')
check('ensp_gui 把 steps 标为必填', Array.isArray(gui?.inputSchema?.required) && gui.inputSchema.required.includes('steps'), JSON.stringify(gui?.inputSchema?.required))
check('属性里没有残留的 required 标志', gui?.inputSchema?.properties?.steps?.required === undefined)
check('必填项都在 properties 里', (gui?.inputSchema?.required ?? []).every((key) => key in (gui?.inputSchema?.properties ?? {})))

const topoCall = await call({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: { name: 'ensp_topo', arguments: { action: 'list', topology_path: 'minimal.topo' } },
})
const topoResult = topoCall?.result
let topoValue = null
try { topoValue = JSON.parse(topoResult?.content?.[0]?.text ?? '') } catch {}
check('ensp_topo 调用成功', topoResult?.isError === false)
check('解析出 3 台设备', topoValue?.devices?.length === 3, `${topoValue?.devices?.length}`)
check('保留 comPort', topoValue?.devices?.find((device) => device.name === 'SW1')?.comPort === 2001)
check('PC 的 comPort 为 0', topoValue?.devices?.find((device) => device.name === 'PC1')?.comPort === 0)
check('读到标注数量', topoValue?.annotationCount === undefined || typeof topoValue?.annotationCount === 'number')

const outside = await call({
  jsonrpc: '2.0',
  id: 6,
  method: 'tools/call',
  params: { name: 'ensp_topo', arguments: { action: 'list', topology_path: 'C:/Windows/win.ini' } },
})
check('工作区外路径被拒', outside?.result?.isError === true, (outside?.result?.content?.[0]?.text ?? '').slice(0, 60))

const missing = await call({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name: 'ensp_topo', arguments: { action: 'list', topology_path: 'nope.topo' } },
})
check('不存在的文件报错而不是崩溃', missing?.result?.isError === true, (missing?.result?.content?.[0]?.text ?? '').slice(0, 60))

const unknownTool = await call({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'ensp_nope', arguments: {} } })
check('未知工具返回 -32602', unknownTool?.error?.code === -32602, unknownTool?.error?.message)

const unknownMethod = await call({ jsonrpc: '2.0', id: 9, method: 'nope/nope' })
check('未知方法返回 -32601', unknownMethod?.error?.code === -32601)

const ping = await call({ jsonrpc: '2.0', id: 10, method: 'ping' })
check('ping 返回空对象', ping?.result && Object.keys(ping.result).length === 0)

const notification = await call({ jsonrpc: '2.0', method: 'notifications/initialized' })
check('通知不产生响应', notification === null)

for (const line of passed) console.log(`  ok   ${line}`)
for (const line of failed) console.log(`  FAIL ${line}`)
console.log(`\n${passed.length} passed, ${failed.length} failed`)
if (failed.length > 0) process.exitCode = 1
