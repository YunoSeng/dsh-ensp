// Newline-delimited JSON-RPC 2.0 over stdio — the MCP stdio transport.
//
// Written by hand instead of pulling in @modelcontextprotocol/sdk so the plugin
// keeps zero runtime dependencies (the DSH side installs nothing, and this file
// only needs Node's standard library).
//
// Framing rules (MCP spec, stdio transport): one JSON-RPC message per line, UTF-8,
// no embedded newlines. Nothing else may be written to stdout — logs go to stderr.

import { createInterface } from 'node:readline'

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18'

/**
 * Start the stdio loop. `onMessage(message, send)` is awaited for every inbound
 * message, one at a time, so responses keep request order and tool calls cannot
 * interleave inside the bridge.
 */
export function startStdio({ onMessage, onClose, onError }) {
  const send = (payload) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`)
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
  let queue = Promise.resolve()

  rl.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    queue = queue.then(async () => {
      let message
      try {
        message = JSON.parse(text)
      } catch (error) {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `parse error: ${error.message}` } })
        return
      }
      try {
        await onMessage(message, send)
      } catch (error) {
        onError?.(error)
        const id = message?.id ?? null
        if (id !== null && message?.method) {
          send({ jsonrpc: '2.0', id, error: { code: -32603, message: error?.message ?? String(error) } })
        }
      }
    })
  })

  rl.on('close', () => {
    queue = queue.then(() => onClose?.())
  })

  return { send }
}

export function result(id, value) {
  return { jsonrpc: '2.0', id, result: value }
}

export function errorMessage(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: '2.0', id, error }
}
