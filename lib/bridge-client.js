/**
 * Transport for the elevated eNSP bridge.
 *
 * eNSP runs elevated, so nothing at the caller's integrity level can drive its
 * windows (UIPI drops PostMessage/SetWindowPos with ERROR_ACCESS_DENIED).  The
 * bridge is therefore started through ``launch.py`` + ShellExecuteW("runas").
 *
 * Two transports:
 *   job   - one elevated process per batch of steps (~0.3 s fixed cost, then
 *           1-70 ms per step).  Always available, no daemon to babysit.
 *   serve - one long-lived elevated process, newline-delimited JSON over
 *           loopback TCP (~0 ms fixed cost).  Used when it can be kept alive.
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'

const LAUNCH_TIMEOUT_MS = 30000

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fileExists(path) {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/**
 * Run a short-lived program and collect its output.
 *
 * Output goes through temporary files rather than stdio pipes: piped stdio is
 * unavailable inside some harness sandboxes (``spawn EPERM``), while plain file
 * descriptors always work and keep the child console-free.
 */
export async function runProcess(command, args, { timeoutMs = 15000, env = process.env } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ensp-proc-'))
  const outPath = join(dir, 'out.txt')
  const errPath = join(dir, 'err.txt')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  const collect = async () => {
    let stdout = ''
    let stderr = ''
    try {
      stdout = await readFile(outPath, 'utf8')
    } catch {
      // no output file
    }
    try {
      stderr = await readFile(errPath, 'utf8')
    } catch {
      // no error file
    }
    await rm(dir, { recursive: true, force: true })
    return { stdout, stderr }
  }
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', outFd, errFd], windowsHide: true, env })
    } catch (error) {
      closeSync(outFd)
      closeSync(errFd)
      resolve(collect().then((io) => ({ code: -1, ...io, stderr: `${io.stderr}${String(error?.message ?? error)}` })))
      return
    }
    let settled = false
    const finish = async (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      closeSync(outFd)
      closeSync(errFd)
      resolve({ code, ...(await collect()) })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already gone
      }
      finish(-1)
    }, timeoutMs)
    child.on('error', (error) => {
      try {
        writeFileSync(errPath, `${String(error?.message ?? error)}`, { flag: 'a' })
      } catch {
        // ignore
      }
      finish(-1)
    })
    child.on('close', (code) => { void finish(code ?? -1) })
  })
}

const PROBE_SCRIPT = [
  'import sys',
  'mods = {}',
  'for name in ("win32gui", "win32ui", "win32api", "win32process", "win32clipboard", "PIL"):',
  '    try:',
  '        __import__(name)',
  '        mods[name] = True',
  '    except Exception as exc:',
  '        mods[name] = str(exc)',
  'print(sys.executable)',
  'print(sys.version.split()[0])',
  'for key in sorted(mods):',
  '    print(key, mods[key])',
].join('\n')

/**
 * Guess where a pywin32-capable Python lives: the per-user installs first, then
 * machine-wide ones, newest version first so the probe stops early.
 */
export function discoverPythonCandidates() {
  const homes = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Python') : '',
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Python') : '',
    process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'], 'Python') : '',
    'C:/Python313', 'C:/Python312', 'C:/Python311',
  ].filter(Boolean)
  const found = []
  for (const home of homes) {
    let entries = []
    try {
      entries = readdirSync(home, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const dir = entry.isDirectory() ? join(home, entry.name) : home
      const exe = join(dir, 'python.exe')
      if (existsSync(exe)) found.push(exe)
    }
  }
  const unique = [...new Set(found.map((path) => path.replace(/\\/gu, '/')))]
  return unique.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
}

/**
 * Find a Python interpreter that has pywin32 + Pillow, and its pythonw sibling.
 * pythonw matters: it never flashes a console window during a batch.
 */
export async function resolveRuntime(config, cache) {
  if (cache?.runtime) return cache.runtime
  const candidates = []
  for (const entry of [config.pythonExecutable, ...(config.pythonCandidates ?? []), ...discoverPythonCandidates()]) {
    if (typeof entry !== 'string' || entry.trim() === '') continue
    candidates.push(entry.trim())
  }
  const failures = []
  for (const exe of candidates) {
    if (!exe.toLowerCase().endsWith('.exe') && !(await fileExists(exe))) {
      failures.push(`${exe}: not found`)
      continue
    }
    const result = await runProcess(exe, ['-c', PROBE_SCRIPT], { timeoutMs: 20000 })
    if (result.code !== 0) {
      failures.push(`${exe}: probe failed ${result.stderr.trim().slice(0, 160)}`)
      continue
    }
    const lines = result.stdout.trim().split(/\r?\n/u)
    const realExe = lines[0]?.trim() ?? exe
    const version = lines[1]?.trim() ?? ''
    const modules = {}
    for (const line of lines.slice(2)) {
      const [key, ...rest] = line.split(' ')
      modules[key] = rest.join(' ') === 'True'
    }
    const missing = Object.entries(modules).filter(([, ok]) => !ok).map(([key]) => key)
    if (missing.length > 0) {
      failures.push(`${exe}: missing ${missing.join(', ')}`)
      continue
    }
    const pythonw = realExe.replace(/python\.exe$/iu, 'pythonw.exe')
    const runtime = {
      python: realExe,
      pythonw: existsSync(pythonw) ? pythonw : realExe,
      version,
      modules,
    }
    if (cache) cache.runtime = runtime
    return runtime
  }
  const hint = 'Set pythonExecutable to a python.exe that can `import win32gui, win32ui, PIL`.'
  const tried = failures.length > 0 ? failures.join(' | ') : 'no candidate found'
  throw new Error(`dsh-ensp: no usable Python runtime for the GUI bridge (${tried}). ${hint}`)
}

export class Bridge {
  constructor(config, paths) {
    this.config = config
    this.paths = paths
    this.cache = {}
    this.serving = null
  }

  async runtime() {
    return resolveRuntime(this.config, this.cache)
  }

  async workDir() {
    if (!this.cache.dir) this.cache.dir = await mkdtemp(join(tmpdir(), 'dsh-ensp-'))
    return this.cache.dir
  }

  /** Launch the bridge elevated and wait for the job result file. */
  async runJob(steps, { timeoutMs } = {}) {
    const runtime = await this.runtime()
    const dir = await this.workDir()
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const jobPath = join(dir, `job-${stamp}.json`)
    const resultPath = join(dir, `res-${stamp}.json`)
    await writeFile(jobPath, JSON.stringify({ steps, result: resultPath }), 'utf8')
    const budget = Number(timeoutMs ?? this.config.timeoutMs)
    const launched = await runProcess(runtime.python, [
      this.paths.launch, '--bridge', this.paths.bridge, '--python', runtime.pythonw, '--job', jobPath,
    ], { timeoutMs: 20000 })
    if (launched.code !== 0) {
      throw new Error(`dsh-ensp: could not start the elevated bridge (UAC refused?). ${launched.stdout.trim()} ${launched.stderr.trim()}`.trim())
    }
    const deadline = Date.now() + budget
    while (Date.now() < deadline) {
      if (await fileExists(resultPath)) {
        const raw = await readFile(resultPath, 'utf8')
        try {
          const parsed = JSON.parse(raw)
          await rm(jobPath, { force: true })
          await rm(resultPath, { force: true })
          return parsed
        } catch {
          // still being written
        }
      }
      await sleep(25)
    }
    throw new Error(`dsh-ensp: bridge batch timed out after ${budget} ms`)
  }

  /** One request/response over the resident bridge socket. */
  async request(payload, { timeoutMs = 120000 } = {}) {
    const info = await this.ensureServing()
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: info.port })
      let buffer = ''
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('dsh-ensp: resident bridge request timed out'))
      }, timeoutMs)
      socket.setEncoding('utf8')
      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ ...payload, token: info.token })}\n`)
      })
      socket.on('data', (chunk) => {
        buffer += chunk
        const index = buffer.indexOf('\n')
        if (index === -1) return
        clearTimeout(timer)
        const line = buffer.slice(0, index)
        socket.destroy()
        try {
          resolve(JSON.parse(line))
        } catch (error) {
          reject(error)
        }
      })
      socket.on('error', (error) => {
        clearTimeout(timer)
        info.healthy = false
        reject(error)
      })
    })
  }

  async ensureServing() {
    if (this.serving?.healthy) return this.serving
    const runtime = await this.runtime()
    const dir = await this.workDir()
    const port = 20000 + Math.floor(Math.random() * 20000)
    const token = Math.random().toString(36).slice(2)
    const logPath = join(dir, 'bridge.log')
    const started = await runProcess(runtime.python, [
      this.paths.launch, '--bridge', this.paths.bridge, '--python', runtime.pythonw,
      '--args', `--port ${port} --token ${token} --log "${logPath}"`,
    ], { timeoutMs: 20000 })
    if (started.code !== 0) throw new Error('dsh-ensp: could not start the resident bridge')
    this.serving = { port, token, logPath, healthy: false }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(100)
      try {
        const pong = await this.request({ op: 'ping', token }, { timeoutMs: 2000 })
        if (pong?.ok) {
          this.serving.healthy = true
          this.serving.info = pong
          return this.serving
        }
      } catch {
        // not up yet
      }
    }
    throw new Error(`dsh-ensp: resident bridge did not answer on port ${port}`)
  }

  /** Run steps through whichever transport is configured, with a job fallback. */
  async steps(steps, opts = {}) {
    const mode = this.config.mode ?? 'auto'
    if (mode === 'job') return this.runJob(steps, opts)
    try {
      const results = []
      for (const [index, step] of steps.entries()) {
        const payload = await this.request(step, { timeoutMs: opts.timeoutMs ?? this.config.timeoutMs })
        results.push({ ...payload, index })
        if (step.op === 'exit') this.serving = null
      }
      return { ok: true, steps: results, transport: 'serve' }
    } catch (error) {
      if (mode === 'serve') throw error
      return this.runJob(steps, opts)
    }
  }

  async ping() {
    try {
      const result = await this.steps([{ op: 'ping' }], { timeoutMs: 30000 })
      return { available: true, ...result.steps[0], transport: result.transport ?? 'job' }
    } catch (error) {
      return { available: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

export { LAUNCH_TIMEOUT_MS }
