#!/usr/bin/env node
// CLI entry for the dsh-ensp MCP server.
//
//   node bin/dsh-ensp-mcp.mjs --workspace E:/labs
//   npx dsh-ensp-mcp --workspace E:/labs
//
// stdout is the MCP channel, so console.log is redirected to stderr before the
// server starts — a stray log line would corrupt the JSON-RPC stream.

import { createMcpServer } from '../mcp/server.js'

const HELP = `dsh-ensp MCP server

Usage: dsh-ensp-mcp [options]

Options:
  --workspace <dir>   Working directory for relative paths and the sandbox
                      boundary (default: $ENSP_MCP_WORKSPACE, else cwd)
  --no-restrict       Allow tools to touch paths outside the workspace
  --mode <job|serve>  Bridge mode: job (default, one elevated process per batch)
                      or serve (one long-lived elevated sidecar, one UAC prompt)
  --python <path>     Python used by the elevated GUI bridge
  --version           Print the version and exit
  --help              Print this help and exit

MCP client config (stdio):
  {"command": "npx", "args": ["-y", "dsh-ensp-mcp", "--workspace", "E:/labs"]}
`

function parseArgs(argv) {
  const options = { overrides: {} }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      index += 1
      return value
    }
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--version' || arg === '-v') options.version = true
    else if (arg === '--workspace') options.workspace = next()
    else if (arg.startsWith('--workspace=')) options.workspace = arg.slice('--workspace='.length)
    else if (arg === '--no-restrict') options.restrictToWorkspace = false
    else if (arg === '--mode') options.overrides.mode = next()
    else if (arg.startsWith('--mode=')) options.overrides.mode = arg.slice('--mode='.length)
    else if (arg === '--python') options.overrides.pythonExecutable = next()
    else if (arg.startsWith('--python=')) options.overrides.pythonExecutable = arg.slice('--python='.length)
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`dsh-ensp-mcp: ${error.message}\n\n${HELP}`)
    process.exit(2)
  }

  if (options.help) {
    process.stdout.write(HELP)
    return
  }

  const { SERVER_VERSION } = await import('../mcp/server.js')
  if (options.version) {
    process.stdout.write(`${SERVER_VERSION}\n`)
    return
  }

  // Keep the JSON-RPC channel clean: everything that would have gone to stdout
  // (ours, or any library's) is redirected to stderr.
  console.log = (...args) => console.error(...args)
  console.info = (...args) => console.error(...args)

  const server = createMcpServer(options)
  server.start()
}

main().catch((error) => {
  process.stderr.write(`dsh-ensp-mcp: ${error?.stack ?? error}\n`)
  process.exit(1)
})
