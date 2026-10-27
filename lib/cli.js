/**
 * Minimal VRP console client over TCP.
 *
 * eNSP exposes each started device's console on 127.0.0.1:<com_port> (the port
 * saved in the .topo file).  Talking to it directly is ~200x faster than
 * clicking through the GUI and is unaffected by window focus, so it is the
 * default command channel; the GUI is only used when the screenshot must show
 * the console window itself.
 *
 * Handled here: telnet IAC negotiation, ``---- More ----`` paging, optional
 * AAA login, per-command prompt matching, and prompt-style tracking so
 * ``system-view`` is entered before config commands when asked.
 */

import { createConnection } from 'node:net'

const IAC = 255
const DONT = 254
const DO = 253
const WONT = 252
const WILL = 251
const SB = 250
const SE = 240

const PROMPT = /[<\[][^<>\[\]\r\n]{1,64}[>\]]\s*$/u
const MORE = /-{2,}\s*More\s*-{2,}/iu
const MORE_LATIN = /-{2,}\s*More\s*-{2,}/iu
const LOGIN_PROMPTS = [/Username:\s*$/iu, /Password:\s*$/iu, /Login authentication\s*$/iu]
/** ``save`` asks "Are you sure to continue? (y/n)[n]:" or "... [Y/N]:" — both must be answered. */
const SAVE_CONFIRM = /\[\s*y\s*\/\s*n\s*\]|\(\s*y\s*\/\s*n\s*\)|\by\s*\/\s*n\b/iu

/** Drop telnet command sequences so the transcript is plain text. */
function stripIac(buffer) {
  const out = []
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i]
    if (byte !== IAC) {
      out.push(byte)
      continue
    }
    const command = buffer[i + 1]
    if (command === undefined) break
    if (command === IAC) {
      out.push(IAC)
      i += 1
    } else if (command === SB) {
      let j = i + 2
      while (j < buffer.length && !(buffer[j] === IAC && buffer[j + 1] === SE)) j += 1
      i = j + 1
    } else {
      i += 2
    }
  }
  return out
}

function cleanText(buffer) {
  const bytes = stripIac(buffer)
  return Buffer.from(bytes)
    .toString('utf8')
    .replace(/\r\n/gu, '\n')
    .replace(/\r/gu, '')
}

export class VrpSession {
  constructor(options = {}) {
    this.host = options.host ?? '127.0.0.1'
    this.port = Number(options.port)
    this.username = options.username ?? ''
    this.password = options.password ?? ''
    this.commandTimeoutMs = Number(options.commandTimeoutMs ?? 20000)
    this.connectTimeoutMs = Number(options.connectTimeoutMs ?? 4000)
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.collected = ''
    this.prompt = ''
    this.log = []
    this.closed = false
  }

  async open() {
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port })
      this.socket = socket
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`telnet connect timeout to ${this.host}:${this.port}`))
      }, this.connectTimeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`telnet ${this.host}:${this.port} failed: ${error.message}`))
      })
      socket.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]) })
      socket.on('close', () => { this.closed = true })
    })
    this.socket.write('\r\n')
    const banner = await this.waitFor(() => PROMPT.test(cleanText(this.buffer)) || LOGIN_PROMPTS.some((re) => re.test(cleanText(this.buffer))), this.commandTimeoutMs)
    await this.loginIfNeeded()
    return { banner: banner.output, prompt: this.prompt }
  }

  async loginIfNeeded() {
    const text = cleanText(this.buffer)
    if (!/Username:\s*$/iu.test(text) && !/Login authentication\s*$/iu.test(text)) return
    if (!this.username) throw new Error('device asks for a username but no credentials were provided')
    this.socket.write(`${this.username}\r\n`)
    await this.waitFor(() => /Password:\s*$/iu.test(cleanText(this.buffer)), this.commandTimeoutMs)
    this.socket.write(`${this.password}\r\n`)
    await this.waitFor(() => PROMPT.test(cleanText(this.buffer)), this.commandTimeoutMs)
  }

  /** Wait until ``ready()`` is true, answering paging prompts on the way. */
  async waitFor(ready, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let answered = 0
    while (Date.now() < deadline) {
      if (this.closed) throw new Error('telnet session closed by device')
      const text = cleanText(this.buffer)
      if (MORE.test(text) && answered < 400) {
        // Keep what came before the marker, drop the marker itself (ASCII, so a
        // latin1 scan gives byte offsets that stay valid for Chinese output).
        const latin = this.buffer.toString('latin1')
        const match = MORE_LATIN.exec(latin)
        if (match) {
          this.collected += cleanText(this.buffer.subarray(0, match.index))
          this.buffer = this.buffer.subarray(match.index + match[0].length)
        }
        this.socket.write(' ')
        answered += 1
        await sleep(40)
        continue
      }
      if (ready(text)) {
        const cleaned = this.collected + text
        this.collected = ''
        this.buffer = Buffer.alloc(0)
        if (PROMPT.test(cleaned)) {
          // VRP log lines such as "%%01CFM/4/SAVE(l)[0]" also end in brackets, so
          // take the last bracketed token that is not purely digits.
          const matches = [...cleaned.matchAll(/[<\[][^<>\[\]\r\n]{1,64}[>\]]/gu)]
          const usable = matches.filter((match) => !/^\d+$/u.test(match[0].slice(1, -1)))
          const chosen = usable[usable.length - 1] ?? matches[matches.length - 1]
          if (chosen) this.prompt = chosen[0]
        }
        return { output: cleaned, prompt: this.prompt }
      }
      await sleep(25)
    }
    const partial = this.collected + cleanText(this.buffer)
    this.collected = ''
    this.buffer = Buffer.alloc(0)
    throw new Error(`command timed out after ${timeoutMs} ms; partial output: ${partial.slice(-300)}`)
  }

  async command(line, { timeoutMs } = {}) {
    const budget = Number(timeoutMs ?? this.commandTimeoutMs)
    this.socket.write(`${line}\r\n`)
    const result = await this.waitFor((text) => PROMPT.test(text), budget)
    const entry = { command: line, output: tidy(result.output, line), prompt: result.prompt }
    this.log.push(entry)
    return entry
  }

  /** Run a list of commands, entering system-view when requested. */
  async run(commands, { systemView = false } = {}) {
    const results = []
    if (systemView && !/^\[/u.test(this.prompt)) {
      results.push(await this.command('system-view'))
    }
    for (const raw of commands) {
      const line = String(raw ?? '').trim()
      if (line === '') continue
      results.push(await this.command(line))
    }
    return { prompt: this.prompt, results }
  }

  /**
   * Write the running configuration to flash (``save`` in user view).
   *
   * Lab work is expected to survive a device restart, so this is the default
   * finishing move after any configuration change; pass ``save: false`` when the
   * user explicitly wants a throw-away experiment.  A device left in
   * system-view is returned first, because ``save`` only exists in user view.
   */
  async save({ timeoutMs } = {}) {
    const budget = Number(timeoutMs ?? Math.max(this.commandTimeoutMs, 60000))
    const results = []
    if (/^\[/u.test(this.prompt)) results.push(await this.command('return', { timeoutMs: budget }))
    this.socket.write('save\r\n')
    const asked = await this.waitFor((text) => SAVE_CONFIRM.test(text) || PROMPT.test(text), Math.min(budget, 30000))
    if (SAVE_CONFIRM.test(asked.output)) {
      this.socket.write('y\r\n')
      const done = await this.waitFor((text) => PROMPT.test(text), budget)
      const entry = {
        command: 'save',
        output: tidy(`${asked.output}\n${done.output}`, 'save'),
        prompt: done.prompt,
      }
      this.log.push(entry)
      results.push(entry)
    } else {
      const entry = { command: 'save', output: tidy(asked.output, 'save'), prompt: asked.prompt }
      this.log.push(entry)
      results.push(entry)
    }
    return { prompt: this.prompt, results }
  }

  close() {
    try {
      this.socket?.end()
    } catch {
      // ignore
    }
    this.socket = null
  }
}

/** Remove the echoed command line and trailing prompt from raw output. */
function tidy(output, command) {
  let text = output.replace(/\u0000/gu, '')
  const echo = new RegExp(`^[\\s\\S]{0,120}?${escapeRegExp(command)}[^\\n]*\\n`, 'u')
  text = text.replace(echo, '')
  text = text.replace(/[<\[][^<>\[\]\r\n]{1,64}[>\]]\s*$/u, '')
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, '').trimEnd()
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Quick reachability probe for a console port. */
export function probePort(port, { host = '127.0.0.1', timeoutMs = 700 } = {}) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: Number(port) })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve({ port: Number(port), open: false, reason: 'timeout' })
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve({ port: Number(port), open: true })
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      resolve({ port: Number(port), open: false, reason: error.code ?? error.message })
    })
  })
}
