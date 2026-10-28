// MCP server for dsh-ensp.
//
// The six tools are not re-implemented here: `apply()` from ../index.js is called
// with a stand-in context, which registers exactly the same tool objects the DSH
// plugin uses (same names, same schemas, same handlers). This file only translates
// between MCP's JSON-RPC surface and those tools, so behaviour cannot drift between
// the two front ends.
//
// Start it with:  node bin/dsh-ensp-mcp.mjs --workspace E:/labs

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Config, apply } from '../index.js'
import { INSTRUCTIONS } from './instructions.js'
import { DEFAULT_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, errorMessage, result, startStdio } from './protocol.js'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PACKAGE_JSON = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8'))

const SERVER_NAME = 'dsh-ensp'
const SERVER_VERSION = PACKAGE_JSON.version

/**
 * DSH's `defineTool` already normalizes a parameter record into a JSON Schema
 * object (`{type:'object', properties, required}`) and lifts the `required: true`
 * property flags into that array, so the normalized form is passed straight
 * through. The property-record form is still handled in case a future tool is
 * registered without going through defineTool.
 */
function toInputSchema(parameters = {}) {
  if (parameters && parameters.type === 'object' && parameters.properties) {
    return { ...parameters, additionalProperties: parameters.additionalProperties ?? false }
  }
  const properties = {}
  const required = []
  for (const [key, schema] of Object.entries(parameters)) {
    const { required: isRequired, ...rest } = schema ?? {}
    properties[key] = rest
    if (isRequired === true) required.push(key)
  }
  const inputSchema = { type: 'object', properties, additionalProperties: false }
  if (required.length > 0) inputSchema.required = required
  return inputSchema
}

/**
 * Build the tool registry through the same code path the DSH plugin uses.
 * `cwd` is the only piece of the DSH exec context the tools read.
 */
export function createRegistry({ workspace, restrictToWorkspace = true, overrides = {} } = {}) {
  const config = Config({
    registerSkill: false,
    injectPrompt: false,
    restrictToWorkspace,
    ...overrides,
  })

  const registered = []
  const ctx = {
    tools: { register: (tool) => registered.push(tool) },
    skills: { register: () => {} },
    systemPrompt: { section: () => {} },
  }
  apply(ctx, config)

  const cwd = resolve(workspace ?? process.env.ENSP_MCP_WORKSPACE ?? process.cwd())
  const exec = { agent: { session: { header: { cwd } } } }

  const tools = registered.map((tool) => ({
    name: tool.name,
    // defineTool keeps only name/description/parameters/output/execute, so the
    // renderer lives under output and there is no separate title.
    title: tool.title ?? tool.name,
    description: tool.description ?? '',
    inputSchema: toInputSchema(tool.parameters),
    handler: tool.execute,
    render: typeof tool.output?.render === 'function' ? tool.output.render : null,
    isConcurrencySafe: false,
  }))

  return { config, cwd, exec, tools }
}

/** Turn a tool return value into MCP content blocks. */
function toContent(tool, args, value) {
  if (tool.render) {
    const blocks = tool.render(args, value)
    if (Array.isArray(blocks) && blocks.length > 0) return blocks
  }
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

export function createMcpServer(options = {}) {
  const registry = createRegistry(options)
  const byName = new Map(registry.tools.map((tool) => [tool.name, tool]))
  const log = options.quiet ? () => {} : (message) => process.stderr.write(`[dsh-ensp] ${message}\n`)

  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION }
  const capabilities = { tools: { listChanged: false } }
  let initialized = false

  async function handleMessage(message, send) {
    const { id, method, params } = message ?? {}
    // Notifications (no id) never get a response.
    const isNotification = id === undefined || id === null

    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION
        initialized = true
        log(`initialize from ${params?.clientInfo?.name ?? 'unknown'} (${protocolVersion}), workspace ${registry.cwd}`)
        send(result(id, {
          protocolVersion,
          capabilities,
          serverInfo,
          instructions: INSTRUCTIONS,
        }))
        return
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return
      case 'ping':
        if (!isNotification) send(result(id, {}))
        return
      case 'tools/list': {
        const tools = registry.tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }))
        send(result(id, { tools }))
        return
      }
      case 'tools/call': {
        const name = params?.name
        const args = params?.arguments ?? {}
        const tool = byName.get(name)
        if (!tool) {
          send(errorMessage(id, -32602, `unknown tool: ${name}`, { available: [...byName.keys()] }))
          return
        }
        const started = Date.now()
        try {
          const value = await tool.handler(args, registry.exec)
          log(`${name} ok in ${Date.now() - started} ms`)
          send(result(id, { content: toContent(tool, args, value), isError: false }))
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error)
          log(`${name} failed in ${Date.now() - started} ms: ${text}`)
          send(result(id, { content: [{ type: 'text', text }], isError: true }))
        }
        return
      }
      // Nothing is advertised in these namespaces, but answering with an empty
      // list is friendlier than -32601 for clients that probe anyway.
      case 'resources/list':
        send(result(id, { resources: [] }))
        return
      case 'resources/templates/list':
        send(result(id, { resourceTemplates: [] }))
        return
      case 'prompts/list':
        send(result(id, { prompts: [] }))
        return
      default:
        if (isNotification) return
        send(errorMessage(id, -32601, `method not found: ${method}`))
    }
  }

  function start() {
    if (!initialized) log(`serving on stdio, workspace ${registry.cwd}, ${registry.tools.length} tools`)
    startStdio({
      onMessage: handleMessage,
      onClose: () => {
        log('stdin closed, exiting')
        process.exit(0)
      },
      onError: (error) => log(`unhandled: ${error?.stack ?? error}`),
    })
  }

  return { registry, start, handleMessage }
}

export { SERVER_NAME, SERVER_VERSION }
