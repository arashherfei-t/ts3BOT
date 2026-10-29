"use strict"

/**
 * Minimal client for the TeamSpeak 3 ClientQuery plugin (telnet on 127.0.0.1:25639).
 *
 * Unlike ServerQuery this drives a REAL TeamSpeak client, so the bot shows up as
 * an ordinary user that everybody sees - no "Show ServerQuery Clients" needed.
 *
 * The wire format is the same as ServerQuery: escaped `key=value` pairs, records
 * separated by "|", every command answered with an `error id=... msg=...` line,
 * and asynchronous `notify*` lines that can arrive at any time.
 */

const net = require("net")
const EventEmitter = require("events")

/* ------------------------------------------------------------- escaping */

const ESCAPES = [
  ["\\", "\\\\"],
  ["/", "\\/"],
  [" ", "\\s"],
  ["|", "\\p"],
  ["\x07", "\\a"],
  ["\b", "\\b"],
  ["\f", "\\f"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
  ["\v", "\\v"]
]

function escape(value) {
  let out = String(value)
  for (const [plain, esc] of ESCAPES) out = out.split(plain).join(esc)
  return out
}

function unescape(value) {
  let out = ""
  const s = String(value)
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\") {
      out += s[i]
      continue
    }
    const next = s[++i]
    const hit = ESCAPES.find(([, esc]) => esc[1] === next)
    out += hit ? hit[0] : next
  }
  return out
}

/** Parses one response line ("a=1 b=2|a=3 b=4") into an array of objects. */
function parseLine(line) {
  return line
    .split("|")
    .map(record => {
      const obj = {}
      for (const pair of record.split(" ")) {
        if (!pair) continue
        const eq = pair.indexOf("=")
        if (eq === -1) obj[pair] = ""
        else obj[unescape(pair.slice(0, eq))] = unescape(pair.slice(eq + 1))
      }
      return obj
    })
    .filter(o => Object.keys(o).length > 0)
}

/** Builds "command key=value key=value" with every value escaped. */
function buildCommand(command, params = {}, flags = []) {
  const parts = [command]
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    parts.push(`${key}=${escape(value)}`)
  }
  for (const flag of flags) parts.push(flag)
  return parts.join(" ")
}

/* --------------------------------------------------------------- errors */

class QueryError extends Error {
  constructor(id, msg, extra) {
    super(extra ? `${msg} (${extra})` : msg)
    this.id = Number(id)
    this.extra = extra
  }
}

/**
 * Hands a finished command its rows. Commands that answer through a notify
 * event get those rows (minus the schandlerid the plugin prefixes); the rest
 * get whatever arrived inline.
 *
 * An empty servergroupclientlist still yields one row holding just the sgid,
 * so callers filter on the key they actually need (cldbid, sgid, ...) rather
 * than trusting the row count.
 */
function resolveJob(job, cq) {
  if (!job.expect) return job.resolve(cq.collected)
  job.resolve(
    cq.notified.map(row => {
      const { schandlerid, ...rest } = row
      return rest
    })
  )
}

/* --------------------------------------------------------------- client */

class ClientQuery extends EventEmitter {
  constructor({ host = "127.0.0.1", port = 25639, timeout = 10000 } = {}) {
    super()
    this.host = host
    this.port = port
    this.timeout = timeout
    this.socket = null
    this.buffer = ""
    this.ready = false
    /** commands are strictly serialised: one in flight, the rest queued */
    this.pending = null
    this.queue = []
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host: this.host, port: this.port })
      this.socket.setEncoding("utf8")
      this.socket.setNoDelay(true)

      // the plugin greets with a banner; commands are only sent once it settles
      const settle = () => {
        if (this.ready) return
        this.ready = true
        clearTimeout(greetTimer)
        resolve(this)
        this.dequeue()
      }
      const greetTimer = setTimeout(settle, 2000)

      this.socket.on("data", chunk => this.onData(chunk, settle))
      this.socket.on("error", e => {
        clearTimeout(greetTimer)
        if (!this.ready) reject(e)
        this.emit("error", e)
      })
      this.socket.on("close", () => {
        this.ready = false
        const err = new Error("clientquery connection closed")
        if (this.pending) {
          this.pending.reject(err)
          this.pending = null
        }
        while (this.queue.length) this.queue.shift().reject(err)
        this.emit("close")
      })
    })
  }

  onData(chunk, settle) {
    this.buffer += chunk
    let nl
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      // the plugin terminates lines with "\n\r", so strip CR from both ends
      const line = this.buffer.slice(0, nl).replace(/^\r+|\r+$/g, "")
      this.buffer = this.buffer.slice(nl + 1)
      if (line.trim()) this.onLine(line, settle)
    }
  }

  onLine(line, settle) {
    this.emit("raw", line)

    if (!this.ready) {
      // "selected schandlerid=1" is the last thing the banner prints
      if (/^selected schandlerid=/.test(line)) return settle()
      if (/ClientQuery interface|^TS3 Client/i.test(line)) return
      return
    }

    if (line.startsWith("notify")) {
      const space = line.indexOf(" ")
      const event = space === -1 ? line : line.slice(0, space)
      const payload = space === -1 ? [] : parseLine(line.slice(space + 1))
      // list commands answer through a notify line that precedes their error line
      if (this.pending && this.pending.expect === event) this.notified.push(...payload)
      this.emit("notify", event, payload)
      this.emit(event, payload)
      return
    }

    if (!this.pending) return // stray line with nothing waiting for it

    if (line.startsWith("error ")) {
      const [status] = parseLine(line.slice(6))
      const job = this.pending
      this.pending = null
      clearTimeout(job.timer)
      if (Number(status.id) === 0) resolveJob(job, this)
      else job.reject(new QueryError(status.id, status.msg, status.extra_msg))
      this.dequeue()
      return
    }

    // the plugin explains this one in prose instead of returning an error line,
    // and then never answers at all - fail fast rather than sit until timeout
    if (/requires you to register for a notification/i.test(line)) {
      const job = this.pending
      this.pending = null
      clearTimeout(job.timer)
      job.reject(new Error(`${job.command}: ${line}`))
      this.dequeue()
      return
    }

    this.collected.push(...parseLine(line))
  }

  dequeue() {
    if (this.pending || !this.ready || this.queue.length === 0) return
    const job = this.queue.shift()
    this.collected = []
    this.notified = []
    this.pending = job
    job.timer = setTimeout(() => {
      if (this.pending !== job) return
      this.pending = null
      job.reject(new Error(`clientquery command timed out: ${job.command}`))
      this.dequeue()
    }, this.timeout)
    this.socket.write(job.command + "\n")
  }

  /**
   * Sends a raw command line and resolves with the parsed response records.
   * `expect` names the notify event a list command answers through - see send().
   */
  sendRaw(command, expect) {
    return new Promise((resolve, reject) => {
      this.queue.push({ command, expect, resolve, reject })
      this.dequeue()
    })
  }

  /**
   * `expect` is the notify event carrying the answer, for the commands that do
   * not reply inline (servergrouplist, servergroupclientlist, ...). Without it
   * those commands print a hint and never answer.
   */
  send(command, params, flags, expect) {
    return this.sendRaw(buildCommand(command, params, flags), expect)
  }

  /**
   * Like send(), but treats "empty result set" as an empty list.
   * TeamSpeak answers a query with no rows with error 1281 instead of no rows.
   */
  async sendAllowEmpty(command, params, flags, expect) {
    try {
      return await this.send(command, params, flags, expect)
    } catch (e) {
      if (e.id === 1281 || /empty result set/i.test(e.message || "")) return []
      throw e
    }
  }

  close() {
    if (this.socket) this.socket.destroy()
  }
}

module.exports = { ClientQuery, QueryError, escape, unescape, parseLine, buildCommand }
