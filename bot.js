"use strict"

/**
 * CMT bot - drives a real TeamSpeak client through its ClientQuery plugin, so
 * the bot is an ordinary user that everyone sees (no ServerQuery, no
 * "Show ServerQuery Clients" needed).
 */

const fs = require("fs")
const path = require("path")
const { ClientQuery } = require("./clientquery")

const CONFIG_PATH = process.env.CMT_CONFIG || path.join(__dirname, "config.json")

/** the two role kinds this bot manages */
const KINDS = ["cmtserver", "cmtticket"]

/** ClientQuery answers these through a notify event instead of inline */
const NOTIFY = {
  servergrouplist: "notifyservergrouplist",
  servergroupclientlist: "notifyservergroupclientlist",
  servergroupsbyclientid: "notifyservergroupsbyclientid",
  clientdblist: "notifyclientdblist",
  clientgetdbidfromuid: "notifyclientdbidfromuid"
}

/* ------------------------------------------------------------------ config */

function loadConfig() {
  let raw
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf8")
  } catch (e) {
    fatal(`config file not found: ${CONFIG_PATH}`)
  }
  let cfg
  try {
    cfg = JSON.parse(raw)
  } catch (e) {
    fatal(`config file is not valid JSON: ${e.message}`)
  }

  const clean = obj => {
    if (Array.isArray(obj) || obj === null || typeof obj !== "object") return obj
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith("_comment")) continue
      out[k] = clean(v)
    }
    return out
  }
  cfg = clean(cfg)

  if (!cfg.teamspeak || !cfg.teamspeak.host) fatal("teamspeak.host is not set in config.json")
  if (!cfg.groups) fatal("the 'groups' section is missing from config.json")
  cfg.clientquery = cfg.clientquery || {}

  // a host with the port glued on ("1.2.3.4:9987") is a common slip
  const hostPort = String(cfg.teamspeak.host).match(/^(.+):(\d+)$/)
  if (hostPort && !/^\[/.test(cfg.teamspeak.host)) {
    console.error(
      `[WARN] teamspeak.host contained a port ("${cfg.teamspeak.host}"). ` +
        `Using host "${hostPort[1]}" - set the port via serverport instead.`
    )
    cfg.teamspeak.host = hostPort[1]
  }

  cfg.commands = cfg.commands || {}
  for (const key of ["cmtserver", "cmtticket", "list", "help"]) {
    const v = cfg.commands[key]
    cfg.commands[key] = v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]
  }
  return cfg
}

function fatal(msg) {
  console.error(`[FATAL] ${msg}`)
  process.exit(1)
}

let config = loadConfig()

/** The API key the ClientQuery plugin generated for this Windows user. */
function readApiKey() {
  const cq = config.clientquery
  if (cq.apiKey) return cq.apiKey
  const file =
    cq.apiKeyFile || path.join(process.env.APPDATA || "", "TS3Client", "clientquery.ini")
  let ini
  try {
    ini = fs.readFileSync(file, "utf8")
  } catch (e) {
    fatal(
      `could not read the ClientQuery api key from ${file}\n` +
        "        Set clientquery.apiKey in config.json, or point clientquery.apiKeyFile at the right clientquery.ini."
    )
  }
  const m = ini.match(/^api_key\s*=\s*(.+)$/m)
  if (!m) fatal(`no api_key entry found in ${file}`)
  return m[1].trim()
}

/* ----------------------------------------------------------------- logging */

const LEVELS = { debug: 10, info: 20, error: 30 }
function log(level, ...args) {
  const min = LEVELS[(config.logging && config.logging.level) || "info"] || LEVELS.info
  if (LEVELS[level] < min) return
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19)
  const sink = level === "error" ? console.error : console.log
  sink(`[${ts}] [${level.toUpperCase()}]`, ...args)
}

/* ---------------------------------------------------------------- messages */

function msg(key, vars = {}) {
  const template = (config.messages && config.messages[key]) || key
  return String(template).replace(/\{(\w+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m
  )
}

/* ------------------------------------------------------------------ helpers */

function groupIdOf(kind) {
  const id = config.groups[kind]
  return id ? String(id) : null
}

/** cached display names for the configured server groups, filled on connect */
const groupNames = { cmtserver: "CMT Server", cmtticket: "CMT Ticket" }

/**
 * Strips the BB-code TeamSpeak wraps around pasted nicknames and collapses
 * runs of whitespace, so "cmt   1   Ali" is read the same as "cmt 1 Ali".
 */
function normalize(text) {
  return String(text)
    .replace(/\[URL=[^\]]*\]/gi, "")
    .replace(/\[\/URL\]/gi, "")
    .replace(/\[\/?[bius]\]/gi, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Matches a chat line against the configured command names.
 *
 * Names may contain spaces ("cmt 1"), so a plain first-token split will not do:
 * the longest name that the line starts with wins, and the match has to end on
 * a word boundary so "cmt 12" is not read as "cmt 1" with the argument "2".
 *
 * Returns { command, argument } or null.
 */
function matchCommand(text) {
  const line = normalize(text)
  if (!line) return null

  const sensitive = config.commands.caseSensitive === true
  const haystack = sensitive ? line : line.toLowerCase()

  const aliases = []
  for (const key of ["cmtserver", "cmtticket", "list", "help"]) {
    for (const raw of config.commands[key]) {
      const alias = normalize(raw)
      if (alias) aliases.push({ key, alias: sensitive ? alias : alias.toLowerCase() })
    }
  }
  aliases.sort((a, b) => b.alias.length - a.alias.length)

  for (const { key, alias } of aliases) {
    if (!haystack.startsWith(alias)) continue
    if (haystack.length !== alias.length && haystack[alias.length] !== " ") continue
    return { command: key, argument: line.slice(alias.length).trim() }
  }
  return null
}

/** True when a client counts as away under the configured trigger. */
function isAway(client, trigger) {
  const deafened = client.client_output_muted === "1"
  const muted = client.client_input_muted === "1"
  if (trigger === "mute") return muted
  if (trigger === "both") return deafened || muted
  return deafened
}

/** True when `held` contains one of `listed` - an empty list matches nobody. */
function isListed(held, listed) {
  if (!Array.isArray(listed) || listed.length === 0) return false
  const mine = (held || []).map(String)
  return listed.map(String).some(x => mine.includes(x))
}

/** True when `mine` contains at least one of `allowed` (empty list = everyone). */
function hasAnyGroup(mine, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return true
  const held = (mine || []).map(String)
  return allowed.map(String).some(g => held.includes(g))
}

/* --------------------------------------------------------------------- bot */

class CmtBot {
  constructor() {
    this.cq = null
    this.selfClid = null
    this.selfDbid = null
    /** serialises commands so group edits and channel renames never interleave */
    this.queue = Promise.resolve()
    /** the plugin delivers each chat message more than once - remember what we saw */
    this.seen = new Map()
    /** clid -> { since, movedFrom } for people who are currently away */
    this.afkState = new Map()
    /** uid -> { until, warned } rate limit, one entry per person */
    this.cooldowns = new Map()
    /** uid -> server group ids, so the cooldown exemption needs no lookup */
    this.groupCache = new Map()
    this.stopping = false
  }

  /* ------------------------------------------------------------- transport */

  /** Convenience wrapper that supplies the right notify event for list commands. */
  cmd(command, params, flags) {
    return this.cq.send(command, params, flags, NOTIFY[command])
  }

  async start() {
    const cq = config.clientquery
    const host = cq.host || "127.0.0.1"
    const port = Number(cq.port) || 25639
    log("info", `connecting to the ClientQuery plugin on ${host}:${port} ...`)

    this.cq = new ClientQuery({ host, port })
    this.cq.on("error", e => log("error", "clientquery error:", e.message))
    this.cq.on("close", () => {
      if (this.stopping) return
      log("error", "clientquery connection closed, retrying in 10s...")
      setTimeout(() => this.restart(), 10000)
    })

    try {
      await this.cq.connect()
    } catch (e) {
      if (/ECONNREFUSED/i.test(e.message)) {
        throw new Error(
          `could not reach the ClientQuery plugin on ${host}:${port}. ` +
            "Is the TeamSpeak client running with the ClientQuery addon enabled?"
        )
      }
      throw e
    }

    const key = readApiKey()
    await this.cq.send("auth", { apikey: key })
    log("info", `authenticated with the ClientQuery plugin (api key ...${key.slice(-4)})`)

    await this.cq.send("clientnotifyregister", { schandlerid: 1, event: "any" })

    await this.ensureOnServer()
    await this.afterConnect()

    // The ClientQuery socket stays up even when the TS3 client itself drops off
    // the server, so nothing else notices - every command would just start
    // failing with "not connected". This is the only thing that catches it.
    clearInterval(this.healthTimer)
    this.healthTimer = setInterval(() => {
      this.healthCheck().catch(e => log("error", "health check failed:", e.message))
    }, 30000)
  }

  /** Puts the client back on the server if it has dropped off. */
  async healthCheck() {
    if (this.stopping || this.rejoining) return
    if (await this.whoami()) return

    this.rejoining = true
    log("error", "the TeamSpeak client is no longer on the server - reconnecting")
    try {
      await this.ensureOnServer()
      await this.afterConnect()
      log("info", "back on the server")
    } finally {
      this.rejoining = false
    }
  }

  async restart() {
    if (this.stopping) return
    try {
      await this.start()
    } catch (e) {
      log("error", "restart failed:", e.message)
      setTimeout(() => this.restart(), 15000)
    }
  }

  /** whoami fails outright while the client is not on any server. */
  async whoami() {
    try {
      const [row] = await this.cq.send("whoami")
      return row && row.clid && row.clid !== "0" ? row : null
    } catch (e) {
      if (/not connected/i.test(e.message)) return null
      throw e
    }
  }

  async ensureOnServer() {
    let me = await this.whoami()
    if (me) return me

    const t = config.teamspeak
    if (t.autoConnect === false) {
      throw new Error("the TeamSpeak client is not connected to a server (autoConnect is off)")
    }

    const address = `${t.host}:${t.serverport || 9987}`
    log("info", `client is not on a server - connecting to ${address} ...`)
    const params = { address, nickname: t.nickname || "CMT Bot" }
    if (t.serverPassword) params.password = t.serverPassword
    if (Number(t.defaultChannelId)) params.channel = String(t.defaultChannelId)
    await this.cq.send("connect", params)

    for (let i = 0; i < 25 && !me; i++) {
      await new Promise(r => setTimeout(r, 1000))
      me = await this.whoami()
    }
    if (!me) throw new Error(`the client did not finish connecting to ${address} within 25s`)
    return me
  }

  async afterConnect() {
    const me = await this.whoami()
    this.selfClid = String(me.clid)

    const [self] = await this.cq.send("clientvariable", {
      clid: this.selfClid,
      client_unique_identifier: "",
      client_nickname: ""
    })
    const [byUid] = await this.cmd("clientgetdbidfromuid", {
      cluid: self.client_unique_identifier
    })
    this.selfDbid = String(byUid.cldbid)
    log(
      "info",
      `on the server as "${self.client_nickname}" clid=${this.selfClid} cldbid=${this.selfDbid}`
    )

    await this.cacheGroupNames()

    this.cq.removeAllListeners("notifytextmessage")
    this.cq.on("notifytextmessage", rows => {
      for (const row of rows) {
        this.onTextMessage(row).catch(e =>
          log("error", "message handler failed:", e.stack || e.message)
        )
      }
    })

    // A channel message only reaches clients standing in that channel, so a poke
    // is the way to reach the bot from anywhere on the server. It carries no
    // channel context, so the answer goes back as a private message.
    this.cq.removeAllListeners("notifyclientpoke")
    this.cq.on("notifyclientpoke", rows => {
      for (const row of rows) {
        this.onTextMessage({ ...row, targetmode: "1", target: row.invokerid }).catch(e =>
          log("error", "poke handler failed:", e.stack || e.message)
        )
      }
    })

    // someone leaving should lose the role, and leaving is what this event means
    const auto = config.autoRemoveOnLeave || {}
    this.cq.removeAllListeners("notifyclientleftview")
    if (auto.enabled) {
      this.cq.on("notifyclientleftview", () => this.scheduleReconcile("client left"))
      log("info", "auto-remove on leave is enabled.")
      await this.reconcile("startup").catch(e =>
        log("error", `startup auto-remove failed: ${e.message}`)
      )
    }

    if (config.channels && config.channels.enabled && config.channels.updateOnStart !== false) {
      for (const kind of KINDS) {
        await this.updateChannelName(kind).catch(e =>
          log("error", `startup channel update for ${kind} failed: ${e.message}`)
        )
      }
    }

    // a periodic sweep is the backstop: leave events only reach us for channels
    // the client is subscribed to, and a bot restart can miss them entirely
    const sweep = Number(auto.intervalSeconds) || 0
    clearInterval(this.sweepTimer)
    if (auto.enabled && sweep > 0) {
      this.sweepTimer = setInterval(() => this.enqueue(() => this.reconcile("periodic")), sweep * 1000)
      log("info", `auto-remove will also sweep every ${sweep}s.`)
    }

    // AFK parking runs on its own timer, outside the command queue, so a slow
    // chat command never delays somebody being carried back to their channel
    const afk = config.afk || {}
    clearInterval(this.afkTimer)
    this.afkState.clear()
    if (afk.enabled) {
      const target = Number(afk.channelId) || 0
      if (!target) {
        log("error", "afk.enabled is true but afk.channelId is 0 - AFK moving is off.")
      } else {
        const poll = Math.max(1, Number(afk.pollSeconds) || 2)
        this.afkTimer = setInterval(() => {
          this.afkTick().catch(e => log("error", "AFK tick failed:", e.message))
        }, poll * 1000)
        log(
          "info",
          `AFK: moving to channel ${target} after ${Number(afk.delaySeconds) || 5}s ` +
            `of "${afk.trigger || "deaf"}", checked every ${poll}s.`
        )
      }
    }

    const every = Number(config.channels && config.channels.refreshIntervalSeconds) || 0
    clearInterval(this.refreshTimer)
    if (every > 0) {
      this.refreshTimer = setInterval(() => {
        for (const kind of KINDS) this.updateChannelName(kind).catch(() => {})
      }, every * 1000)
      log("info", `channel names will also refresh every ${every}s.`)
    }

    log("info", "ready - listening for chat commands.")
  }

  async cacheGroupNames() {
    let list = []
    try {
      list = await this.cmd("servergrouplist")
    } catch (e) {
      log("error", "could not read the server group list:", e.message)
      return
    }
    for (const kind of KINDS) {
      const sgid = groupIdOf(kind)
      if (!sgid) {
        log("error", `groups.${kind} is not set in config.json - that command will not work.`)
        continue
      }
      const found = list.find(g => String(g.sgid) === sgid)
      if (!found) {
        log("error", `no server group with sgid ${sgid} exists on this server (groups.${kind}).`)
        continue
      }
      groupNames[kind] = found.name
      log("info", `groups.${kind} = ${sgid} ("${found.name}")`)

      // The [CMT Server] tag in front of member nicknames is rendered by
      // TeamSpeak from the group's own `i_group_show_name_in_tree` permission.
      // No client can rename another client, so the tag has to come from the
      // group - point at the helper rather than leaving it quietly missing.
      if (String(found.namemode) !== "1") {
        log(
          "info",
          `  hint: "${found.name}" does not show its name next to member nicknames ` +
            `(i_group_show_name_in_tree=${found.namemode}). Run "node set-group-display.js" to fix.`
        )
      }
    }
    log(
      "info",
      "available server groups:\n" + list.map(g => `    sgid=${g.sgid}  ${g.name}`).join("\n")
    )
  }

  /** Members of a server group. The empty-group reply carries only the sgid. */
  async membersOf(sgid) {
    const rows = await this.cq.sendAllowEmpty(
      "servergroupclientlist",
      { sgid },
      ["-names"],
      NOTIFY.servergroupclientlist
    )
    return rows.filter(r => r.cldbid)
  }

  /**
   * Current nicknames, keyed by database id.
   *
   * `servergroupclientlist -names` reports the nickname the server has stored
   * for an identity, which can be badly out of date - an identity that once
   * connected under another name keeps that name in the database. Anyone
   * online right now is reported under the name people actually see.
   */
  async liveNicknames() {
    const rows = await this.cq.send("clientlist").catch(() => [])
    const map = new Map()
    for (const c of rows) {
      if (c.client_database_id && c.client_nickname) {
        map.set(String(c.client_database_id), c.client_nickname)
      }
    }
    return map
  }

  /** Group members named as they appear right now, falling back to the database. */
  async displayNames(members) {
    const live = await this.liveNicknames()
    return members.map(m => live.get(String(m.cldbid)) || m.client_nickname || `dbid:${m.cldbid}`)
  }

  /* ------------------------------------------------------------------- afk */

  /**
   * Parks people who deafen themselves in the AFK channel and puts them back
   * where they were once they come back.
   *
   * This polls rather than relying on notifyclientupdated alone: that event was
   * observed to fire on undeafen but not on deafen, and a missed event would
   * strand someone. `clientlist` is a local cache read, so polling is cheap.
   */
  async afkTick() {
    const afk = config.afk || {}
    if (!afk.enabled) return
    const target = String(Number(afk.channelId) || 0)
    if (target === "0") return

    const clients = await this.cq.send("clientlist", {}, ["-voice", "-groups"]).catch(() => null)
    if (!clients) return

    const now = Date.now()
    const delay = (Number(afk.delaySeconds) || 5) * 1000
    const alive = new Set()

    for (const c of clients) {
      const clid = String(c.clid)
      alive.add(clid)
      if (clid === this.selfClid) continue

      const groups = String(c.client_servergroups || "")
        .split(",")
        .filter(Boolean)
      const exempt = isListed(groups, afk.ignoreGroups)
      const state = this.afkState.get(clid)

      if (isAway(c, afk.trigger) && !exempt) {
        if (!state) {
          this.afkState.set(clid, { since: now, movedFrom: null })
          continue
        }
        if (state.movedFrom) continue // already parked
        if (now - state.since < delay) continue

        const from = String(c.cid)
        if (from === target) continue // already sitting in the AFK channel
        if (isListed([from], afk.ignoreChannels)) continue

        try {
          await this.cq.send("clientmove", { cid: target, clid })
          state.movedFrom = from
          log(
            "info",
            `AFK: moved "${c.client_nickname}" from channel ${from} to ${target} ` +
              `(away for ${Math.round((now - state.since) / 1000)}s)`
          )
        } catch (e) {
          log("error", `AFK: could not move "${c.client_nickname}": ${e.message}`)
        }
        continue
      }

      if (!state) continue
      this.afkState.delete(clid)

      // only carry them back if they are still where we parked them - if they
      // walked off somewhere else in the meantime, leave them alone
      if (state.movedFrom && afk.returnWhenBack !== false && String(c.cid) === target) {
        try {
          await this.cq.send("clientmove", { cid: state.movedFrom, clid })
          log("info", `AFK: returned "${c.client_nickname}" to channel ${state.movedFrom}`)
        } catch (e) {
          log("error", `AFK: could not return "${c.client_nickname}": ${e.message}`)
        }
      }
    }

    for (const clid of [...this.afkState.keys()]) {
      if (!alive.has(clid)) this.afkState.delete(clid)
    }
  }

  /* ------------------------------------------------------------ reconciling */

  /**
   * These roles are only meant to be held by people who are on the server, so
   * anyone holding one who is no longer connected loses it.
   *
   * `clientlist` only covers channels the TS3 client is subscribed to, so it is
   * cross-checked against the occupancy the server reports per channel. When
   * those disagree the pass is skipped: taking a role off someone who is merely
   * invisible to us would be far worse than leaving a stale one in place.
   */
  async reconcile(reason) {
    const auto = config.autoRemoveOnLeave || {}
    if (!auto.enabled) return

    const clients = await this.cq.send("clientlist").catch(() => null)
    const channels = await this.cq.send("channellist").catch(() => null)
    if (!clients || !channels) return

    const occupancy = channels.reduce((n, c) => n + (Number(c.total_clients) || 0), 0)
    if (occupancy !== clients.length) {
      log(
        "error",
        `skipping auto-remove (${reason}): clientlist sees ${clients.length} of the ${occupancy} ` +
          'clients the server reports. Enable "Subscribe to all channels" in the TeamSpeak client.'
      )
      return
    }

    const online = new Set(clients.map(c => String(c.client_database_id)))

    for (const kind of KINDS) {
      const sgid = groupIdOf(kind)
      if (!sgid) continue

      const members = await this.membersOf(sgid)
      let removed = 0
      for (const m of members) {
        if (online.has(String(m.cldbid))) continue
        try {
          await this.cq.send("servergroupdelclient", { sgid, cldbid: m.cldbid })
          removed++
          log(
            "info",
            `auto-removed "${groupNames[kind]}" from "${m.client_nickname}" ` +
              `(dbid=${m.cldbid}) - no longer on the server [${reason}]`
          )
        } catch (e) {
          log("error", `auto-remove failed for dbid=${m.cldbid}: ${e.message}`)
        }
      }
      if (removed > 0) await this.updateChannelName(kind)
    }
  }

  /**
   * A mass disconnect fires one leave event per client, and the server needs a
   * moment to settle, so the events are coalesced into a single pass.
   */
  scheduleReconcile(reason) {
    if (this.reconcileTimer) return
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null
      this.enqueue(() => this.reconcile(reason))
    }, 3000)
  }

  /* ---------------------------------------------------------- chat handling */

  /**
   * True the first time a given message is seen; the plugin repeats each one.
   * A poke carries no timestamp, so repeats are collapsed per whole second -
   * close enough to catch a double delivery without blocking a real retry.
   */
  isDuplicate(row) {
    const stamp = row.timestamp || `poke${Math.floor(Date.now() / 1000)}`
    const key = `${row.invokerid}|${stamp}|${row.targetmode}|${row.msg}`
    const now = Date.now()
    for (const [k, at] of this.seen) if (now - at > 30000) this.seen.delete(k)
    if (this.seen.has(key)) return true
    this.seen.set(key, now)
    return false
  }

  /** Identifies a person across reconnects - the unique id outlives their clid. */
  static keyOf(row) {
    return row.invokeruid || `clid:${row.invokerid}`
  }

  /**
   * Rate limits each person to one command per cooldown window.
   *
   * This deliberately runs before any lookup: every command costs the server
   * several requests, so a check that happened later would still let a spammer
   * generate the traffic this exists to prevent.
   *
   * Returns { blocked, remaining, warn } - `warn` is true only on the first
   * blocked message of a window, so spamming cannot provoke a reply per message.
   */
  checkCooldown(row, command) {
    const cd = config.cooldown || {}
    if (!cd.enabled) return { blocked: false }
    if (Array.isArray(cd.exemptCommands) && cd.exemptCommands.includes(command)) {
      return { blocked: false }
    }

    const key = CmtBot.keyOf(row)
    // groups come from the cache filled by the person's previous command, so
    // this stays a purely local check
    if (isListed(this.groupCache.get(key), cd.exemptGroups)) return { blocked: false }

    const now = Date.now()

    // opportunistic sweep so the map cannot grow without bound on a busy server
    if (this.cooldowns.size > 500) {
      for (const [k, v] of this.cooldowns) if (v.until <= now) this.cooldowns.delete(k)
    }

    const entry = this.cooldowns.get(key)
    if (entry && entry.until > now) {
      const warn = cd.warnOnce === false || !entry.warned
      entry.warned = true
      return { blocked: true, remaining: Math.ceil((entry.until - now) / 1000), warn }
    }

    const seconds = Number(cd.seconds) || 5
    this.cooldowns.set(key, { until: now + seconds * 1000, warned: false })
    return { blocked: false }
  }

  async onTextMessage(row) {
    if (!row || !row.msg) return
    if (String(row.invokerid) === this.selfClid) return // never react to our own output
    if (this.isDuplicate(row)) return

    const hit = matchCommand(row.msg)
    if (!hit) return
    const { command, argument } = hit

    const gate = this.checkCooldown(row, command)
    if (gate.blocked) {
      log(
        "info",
        `cooldown: ignored ${command} from "${row.invokername}" (${gate.remaining}s left)`
      )
      if (gate.warn) {
        await this.reply(row, msg("cooldown", { seconds: gate.remaining })).catch(() => {})
      }
      return
    }

    log(
      "info",
      `command ${command} from "${row.invokername}" (clid=${row.invokerid}) arg="${argument}"`
    )

    return this.enqueue(async () => {
      try {
        const invoker = await this.resolveInvoker(row)
        if (!hasAnyGroup(invoker.groups, config.permissions && config.permissions.allowedGroups)) {
          return await this.reply(row, msg("noPermission"))
        }
        if (command === "help") return await this.reply(row, this.helpText())
        if (command === "list") return await this.handleList(row)
        return await this.handleToggle(command, argument, invoker, row)
      } catch (e) {
        log("error", `command ${command} failed:`, e.stack || e.message)
        await this.reply(row, msg("error", { error: e.message })).catch(() => {})
      }
    })
  }

  /** Runs work one item at a time so group edits and channel renames never interleave. */
  enqueue(fn) {
    this.queue = this.queue
      .then(fn)
      .catch(e => log("error", "queued task failed:", e.stack || e.message))
    return this.queue
  }

  /**
   * The chat event carries the sender's unique id, which resolves to a database
   * id regardless of which channels the bot is subscribed to.
   */
  async resolveInvoker(row) {
    const [byUid] = await this.cmd("clientgetdbidfromuid", { cluid: row.invokeruid })
    const cldbid = String(byUid.cldbid)
    const groups = await this.cq.sendAllowEmpty(
      "servergroupsbyclientid",
      { cldbid },
      [],
      NOTIFY.servergroupsbyclientid
    )
    const held = groups.map(g => String(g.sgid))
    this.groupCache.set(CmtBot.keyOf(row), held)
    return { cldbid, nickname: row.invokername, groups: held }
  }

  helpText() {
    const first = key => config.commands[key][0] || "-"
    return msg("help", {
      cmtserver: first("cmtserver"),
      cmtticket: first("cmtticket"),
      list: first("list")
    })
  }

  /** `!cmtserver` / `!cmtticket` - no argument targets the invoker, otherwise the named user. */
  async handleToggle(kind, argument, invoker, row) {
    const sgid = groupIdOf(kind)
    if (!sgid) return this.reply(row, msg("groupNotConfigured", { cmd: kind }))

    const perms = config.permissions || {}
    const isSelf = argument === ""

    if (isSelf && perms.allowSelfAssign === false) {
      return this.reply(row, msg("selfAssignDisabled"))
    }
    if (!isSelf && !hasAnyGroup(invoker.groups, perms.adminGroups)) {
      return this.reply(row, msg("noPermissionOther"))
    }

    let target
    if (isSelf) {
      target = { cldbid: invoker.cldbid, nickname: invoker.nickname }
    } else {
      const found = await this.resolveTarget(argument)
      if (found.ambiguous) {
        return this.reply(
          row,
          msg("multipleMatches", { user: argument, list: found.ambiguous.slice(0, 8).join(" | ") })
        )
      }
      if (!found.cldbid) return this.reply(row, msg("userNotFound", { user: argument }))
      target = found
    }

    const groups = await this.cq.sendAllowEmpty(
      "servergroupsbyclientid",
      { cldbid: target.cldbid },
      [],
      NOTIFY.servergroupsbyclientid
    )
    const has = groups.some(g => String(g.sgid) === sgid)

    if (has) {
      await this.cq.send("servergroupdelclient", { sgid, cldbid: target.cldbid })
      log("info", `removed "${groupNames[kind]}" from "${target.nickname}" (dbid=${target.cldbid})`)
      await this.reply(row, msg("removed", { user: target.nickname, group: groupNames[kind] }))
    } else {
      await this.cq.send("servergroupaddclient", { sgid, cldbid: target.cldbid })
      log("info", `added "${groupNames[kind]}" to "${target.nickname}" (dbid=${target.cldbid})`)
      await this.reply(row, msg("added", { user: target.nickname, group: groupNames[kind] }))
    }

    await this.updateChannelName(kind)
  }

  /** `!cmts` - prints the members of both managed groups. */
  async handleList(row) {
    const lines = [msg("listHeader")]
    for (const kind of KINDS) {
      const sgid = groupIdOf(kind)
      if (!sgid) {
        lines.push(msg("groupNotConfigured", { cmd: kind }))
        continue
      }
      const members = await this.membersOf(sgid)
      lines.push("")
      lines.push(msg("listGroupLine", { group: groupNames[kind], count: members.length }))
      if (members.length === 0) lines.push("  " + msg("listEmpty"))
      else for (const name of await this.displayNames(members)) lines.push(`  • ${name}`)
    }
    await this.reply(row, lines.join("\n"))
  }

  /* ------------------------------------------------------ target resolution */

  /**
   * Finds a user by nickname: online clients first, then the server's client
   * database. Also accepts `dbid:123` and a raw unique identifier.
   * Returns { cldbid, nickname } or { ambiguous: [names] } or {}.
   */
  async resolveTarget(input) {
    const name = input.trim().replace(/^"(.*)"$/, "$1")
    if (!name) return {}

    const dbidMatch = name.match(/^(?:dbid|cldbid)[:=](\d+)$/i)
    if (dbidMatch) return { cldbid: dbidMatch[1], nickname: `dbid:${dbidMatch[1]}` }

    if (/^[A-Za-z0-9+/]{27}=$/.test(name)) {
      const [byUid] = await this.cmd("clientgetdbidfromuid", { cluid: name }).catch(() => [])
      if (byUid && byUid.cldbid) return { cldbid: String(byUid.cldbid), nickname: name }
    }

    const lower = name.toLowerCase()

    // clientlist only covers channels the client is subscribed to, so it is a
    // fast path rather than the whole answer
    const online = (await this.cq.send("clientlist").catch(() => []))
      .filter(c => c.clid && String(c.clid) !== this.selfClid && c.client_nickname)
      .map(c => ({ cldbid: String(c.client_database_id), nickname: c.client_nickname }))

    let hits = online.filter(c => c.nickname.toLowerCase() === lower)
    if (hits.length === 0) hits = online.filter(c => c.nickname.toLowerCase().includes(lower))
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) return { ambiguous: hits.map(c => c.nickname) }

    return this.searchDatabase(lower)
  }

  /** Pages through the server's identity database looking for a nickname match. */
  async searchDatabase(lower) {
    const cap = Number(config.clientquery.maxDbSearch) || 500
    const page = 100
    const exact = []
    const partial = []

    for (let start = 0; start < cap; start += page) {
      const rows = await this.cq
        .sendAllowEmpty("clientdblist", { start, duration: page }, [], NOTIFY.clientdblist)
        .catch(() => [])
      if (rows.length === 0) break

      for (const r of rows) {
        const nickname = r.client_nickname
        if (!nickname) continue
        const entry = { cldbid: String(r.cldbid), nickname }
        if (nickname.toLowerCase() === lower) exact.push(entry)
        else if (nickname.toLowerCase().includes(lower)) partial.push(entry)
      }
      if (rows.length < page) break
    }

    if (exact.length === 1) return exact[0]
    if (exact.length > 1) return { ambiguous: exact.map(e => e.nickname) }
    if (partial.length === 1) return partial[0]
    if (partial.length > 1) return { ambiguous: partial.map(e => e.nickname) }
    return {}
  }

  /* --------------------------------------------------------- channel naming */

  /** Renames the configured channel to "CMT Server : name1, name2" for the given kind. */
  async updateChannelName(kind) {
    const ch = config.channels || {}
    if (!ch.enabled) return
    const cid = Number(ch[kind]) || 0
    if (!cid) return

    const sgid = groupIdOf(kind)
    if (!sgid) return

    const members = await this.membersOf(sgid)
    const names = await this.displayNames(members)

    const template = (ch.nameTemplate && ch.nameTemplate[kind]) || "{users}"
    const separator = ch.separator === undefined ? ", " : ch.separator
    const emptyText = ch.emptyText === undefined ? "-" : ch.emptyText
    const maxLen = Number(ch.maxNameLength) || 40

    const users = names.length === 0 ? emptyText : this.fitNames(names, template, separator, maxLen)
    let channelName = template.replace("{users}", users)
    if (channelName.length > maxLen) channelName = channelName.slice(0, maxLen)

    try {
      await this.cq.send("channeledit", { cid: String(cid), channel_name: channelName })
      log("info", `renamed channel ${cid} to "${channelName}"`)
    } catch (e) {
      // 771 = channel name already in use, 768 = invalid channel id
      log("error", `could not rename channel ${cid}: ${e.message}`)
    }
  }

  /**
   * Packs as many nicknames as fit in the channel-name budget, then adds "+N"
   * for whatever is left over. TeamSpeak caps channel names at 40 characters.
   */
  fitNames(names, template, separator, maxLen) {
    const budget = maxLen - template.replace("{users}", "").length
    if (budget <= 0) return ""

    const kept = []
    for (let i = 0; i < names.length; i++) {
      const remaining = names.length - (i + 1)
      const suffix = remaining > 0 ? `${separator}+${remaining}` : ""
      const candidate = [...kept, names[i]].join(separator)
      if (candidate.length + suffix.length <= budget) kept.push(names[i])
      else break
    }

    if (kept.length === 0) return names[0].slice(0, budget)
    const left = names.length - kept.length
    return left > 0 ? `${kept.join(separator)}${separator}+${left}` : kept.join(separator)
  }

  /* ------------------------------------------------------------------ reply */

  /**
   * Answers in the same chat the command arrived from.
   * targetmode 1 = private, 2 = current channel, 3 = server.
   */
  async reply(row, text) {
    if (!text) return
    const mode = Number(row.targetmode) || 1
    try {
      if (mode === 1) {
        return await this.cq.send("sendtextmessage", {
          targetmode: 1,
          target: row.invokerid,
          msg: text
        })
      }
      return await this.cq.send("sendtextmessage", { targetmode: mode, msg: text })
    } catch (e) {
      log("error", `reply failed (${e.message}), falling back to a private message...`)
      try {
        await this.cq.send("sendtextmessage", { targetmode: 1, target: row.invokerid, msg: text })
      } catch (e2) {
        log("error", "private message also failed:", e2.message)
      }
    }
  }
}

/* -------------------------------------------------------------------- main */

module.exports = { CmtBot, normalize, matchCommand, hasAnyGroup, loadConfig }

function main() {
  const bot = new CmtBot()

  bot.start().catch(e => {
    log("error", "bot failed to start:", e.message)
    process.exit(1)
  })

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      log("info", "shutting down...")
      bot.stopping = true
      if (bot.cq) bot.cq.close()
      process.exit(0)
    })
  }

  process.on("unhandledRejection", e => log("error", "unhandledRejection:", (e && e.stack) || e))
}

if (require.main === module) main()
