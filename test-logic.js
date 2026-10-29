"use strict"

/**
 * Offline sanity check - runs without a TeamSpeak client or server:
 *   node test-logic.js
 */

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

// bot.js validates config.json at import time, so point it at a fixture
const fixture = path.join(os.tmpdir(), "cmt-bot-test-config.json")
fs.writeFileSync(
  fixture,
  JSON.stringify({
    teamspeak: { host: "127.0.0.1", serverport: 9987, nickname: "Test Bot" },
    clientquery: { host: "127.0.0.1", port: 25639, apiKey: "TEST-KEY" },
    groups: { cmtserver: 91, cmtticket: 92 },
    commands: {
      caseSensitive: false,
      cmtserver: ["cmt1", "cmt 1", "cmtserver"],
      cmtticket: ["cmt2", "cmt 2", "cmtticket"],
      list: ["cmts", "cmt list"],
      help: ["cmthelp", "cmt help"]
    },
    autoRemoveOnLeave: { enabled: true, intervalSeconds: 60 },
    cooldown: {
      enabled: true,
      seconds: 5,
      exemptCommands: ["help"],
      exemptGroups: [],
      warnOnce: true
    },
    afk: {
      enabled: true,
      channelId: 44,
      delaySeconds: 5,
      trigger: "deaf",
      returnWhenBack: true,
      pollSeconds: 2,
      ignoreGroups: [],
      ignoreChannels: []
    },
    logging: { level: "error" }
  })
)
process.env.CMT_CONFIG = fixture

const { CmtBot, normalize, matchCommand, hasAnyGroup } = require("./bot")
const { escape, unescape, parseLine, buildCommand } = require("./clientquery")

/* --------------------------------------------------------------- test runner */

const tests = []
const suite = name => tests.push({ heading: name })
const check = (label, fn) => tests.push({ label, fn })

async function run() {
  let passed = 0
  let failed = 0
  for (const t of tests) {
    if (t.heading) {
      console.log(`\n${t.heading}`)
      continue
    }
    try {
      await t.fn()
      passed++
      console.log(`  ok    ${t.label}`)
    } catch (e) {
      failed++
      console.error(`  FAIL  ${t.label}\n          ${e.message}`)
    }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed ? 1 : 0)
}

/* ------------------------------------------------------ clientquery protocol */

suite("escaping (TeamSpeak query wire format)")
check("spaces become \\s", () => assert.strictEqual(escape("Hello World"), "Hello\\sWorld"))
check("pipes become \\p", () => assert.strictEqual(escape("a|b"), "a\\pb"))
check("slashes become \\/", () => assert.strictEqual(escape("c:/x"), "c:\\/x"))
check("round trip survives every special char", () => {
  const nasty = "we|ird\\ /name\twith\nstuff"
  assert.strictEqual(unescape(escape(nasty)), nasty)
})
check("a channel name round trips", () =>
  assert.strictEqual(unescape(escape("CMT Server : Ali, Reza")), "CMT Server : Ali, Reza"))

suite("parseLine")
check("single record", () =>
  assert.deepStrictEqual(parseLine("clid=4 client_nickname=Sun\\sBot"), [
    { clid: "4", client_nickname: "Sun Bot" }
  ]))
check("pipe-separated records", () =>
  assert.deepStrictEqual(parseLine("cldbid=7|cldbid=8"), [{ cldbid: "7" }, { cldbid: "8" }]))
check("valueless key", () => assert.deepStrictEqual(parseLine("-names"), [{ "-names": "" }]))

suite("buildCommand")
check("escapes values, keeps flags", () =>
  assert.strictEqual(
    buildCommand("channeledit", { cid: "86", channel_name: "CMT Server : Ali" }, ["-x"]),
    "channeledit cid=86 channel_name=CMT\\sServer\\s:\\sAli -x"
  ))
check("skips undefined values", () =>
  assert.strictEqual(buildCommand("connect", { address: "1.2.3.4", password: undefined }),
    "connect address=1.2.3.4"))

/* ------------------------------------------------------------- bot behaviour */

suite("normalize")
check("strips the BB-code TeamSpeak adds around pasted nicknames", () =>
  assert.strictEqual(normalize("cmt1 [URL=client://3/abc=]Ali[/URL]"), "cmt1 Ali"))
check("collapses runs of whitespace", () =>
  assert.strictEqual(normalize("  cmt   1    Ali  "), "cmt 1 Ali"))

suite("matchCommand - no prefix, spaces allowed in a command name")
const cmd = t => matchCommand(t)
check("cmt1 is CMT Server", () =>
  assert.deepStrictEqual(cmd("cmt1"), { command: "cmtserver", argument: "" }))
check("cmt 1 is CMT Server", () =>
  assert.deepStrictEqual(cmd("cmt 1"), { command: "cmtserver", argument: "" }))
check("cmt2 is CMT Ticket", () =>
  assert.deepStrictEqual(cmd("cmt2"), { command: "cmtticket", argument: "" }))
check("cmt 2 is CMT Ticket", () =>
  assert.deepStrictEqual(cmd("cmt 2"), { command: "cmtticket", argument: "" }))
check("the long name still works", () =>
  assert.deepStrictEqual(cmd("cmtserver"), { command: "cmtserver", argument: "" }))
check("case is ignored", () => {
  assert.deepStrictEqual(cmd("CMT1"), { command: "cmtserver", argument: "" })
  assert.deepStrictEqual(cmd("Cmt 2"), { command: "cmtticket", argument: "" })
  assert.deepStrictEqual(cmd("CMTSERVER"), { command: "cmtserver", argument: "" })
})
check("a target nickname becomes the argument", () =>
  assert.deepStrictEqual(cmd("cmt 1 Ali Reza"), { command: "cmtserver", argument: "Ali Reza" }))
check("cmt1 with a nickname", () =>
  assert.deepStrictEqual(cmd("cmt1 Arash"), { command: "cmtserver", argument: "Arash" }))
check("cmts is the list, not cmt + s", () =>
  assert.deepStrictEqual(cmd("cmts"), { command: "list", argument: "" }))
check("cmt list is the list too", () =>
  assert.deepStrictEqual(cmd("cmt list"), { command: "list", argument: "" }))
check("the longest matching name wins", () =>
  assert.deepStrictEqual(cmd("cmt help"), { command: "help", argument: "" }))
check("cmt 12 is not cmt 1 with argument 2", () => assert.strictEqual(cmd("cmt 12"), null))
check("cmt1x is not cmt1", () => assert.strictEqual(cmd("cmt1x"), null))
check("a command must start the line", () => assert.strictEqual(cmd("please cmt1"), null))
check("unrelated chat is ignored", () => {
  assert.strictEqual(cmd("hello there"), null)
  assert.strictEqual(cmd(""), null)
  assert.strictEqual(cmd("cmt"), null)
})
check("the old prefixed form no longer matches", () =>
  assert.strictEqual(cmd("!cmtserver"), null))

suite("hasAnyGroup")
check("an empty allow list lets everyone through", () =>
  assert.strictEqual(hasAnyGroup(["11"], []), true))
check("a held group is matched across string/number", () =>
  assert.strictEqual(hasAnyGroup(["62", "15"], [62]), true))
check("no overlap is rejected", () =>
  assert.strictEqual(hasAnyGroup(["11"], [62, 64]), false))

suite("isDuplicate (the plugin repeats every chat message)")
check("the second delivery of one message is dropped", () => {
  const bot = new CmtBot()
  const row = { invokerid: "7", timestamp: "1788203904861", targetmode: "3", msg: "!cmts" }
  assert.strictEqual(bot.isDuplicate(row), false)
  assert.strictEqual(bot.isDuplicate({ ...row }), true)
})
check("the same text sent again later is not a duplicate", () => {
  const bot = new CmtBot()
  const base = { invokerid: "7", targetmode: "3", msg: "!cmts" }
  assert.strictEqual(bot.isDuplicate({ ...base, timestamp: "1" }), false)
  assert.strictEqual(bot.isDuplicate({ ...base, timestamp: "2" }), false)
})
check("different senders are tracked separately", () => {
  const bot = new CmtBot()
  const base = { timestamp: "1", targetmode: "3", msg: "!cmts" }
  assert.strictEqual(bot.isDuplicate({ ...base, invokerid: "7" }), false)
  assert.strictEqual(bot.isDuplicate({ ...base, invokerid: "8" }), false)
})

check("a poke without a timestamp still dedupes within the same second", () => {
  const bot = new CmtBot()
  const poke = { invokerid: "7", targetmode: "1", msg: "!cmtserver" }
  assert.strictEqual(bot.isDuplicate({ ...poke }), false)
  assert.strictEqual(bot.isDuplicate({ ...poke }), true)
})

suite("checkCooldown (one command per person per window)")
const invoker = (uid = "uid-a") => ({ invokeruid: uid, invokerid: "7", invokername: "u" })

check("the first command goes through", () => {
  const bot = new CmtBot()
  assert.strictEqual(bot.checkCooldown(invoker(), "cmtserver").blocked, false)
})
check("a second command inside the window is blocked", () => {
  const bot = new CmtBot()
  bot.checkCooldown(invoker(), "cmtserver")
  const gate = bot.checkCooldown(invoker(), "cmtserver")
  assert.strictEqual(gate.blocked, true)
  assert.ok(gate.remaining > 0 && gate.remaining <= 5, `remaining=${gate.remaining}`)
})
check("only the first blocked message warns, so spam gets no reply storm", () => {
  const bot = new CmtBot()
  bot.checkCooldown(invoker(), "cmtserver")
  assert.strictEqual(bot.checkCooldown(invoker(), "cmtserver").warn, true)
  assert.strictEqual(bot.checkCooldown(invoker(), "cmtserver").warn, false)
  assert.strictEqual(bot.checkCooldown(invoker(), "cmtserver").warn, false)
})
check("the window expires", () => {
  const bot = new CmtBot()
  bot.checkCooldown(invoker(), "cmtserver")
  bot.cooldowns.get("uid-a").until = Date.now() - 1
  assert.strictEqual(bot.checkCooldown(invoker(), "cmtserver").blocked, false)
})
check("one person's cooldown does not block anybody else", () => {
  const bot = new CmtBot()
  bot.checkCooldown(invoker("uid-a"), "cmtserver")
  assert.strictEqual(bot.checkCooldown(invoker("uid-b"), "cmtserver").blocked, false)
})
check("help is exempt and never starts a window", () => {
  const bot = new CmtBot()
  assert.strictEqual(bot.checkCooldown(invoker(), "help").blocked, false)
  assert.strictEqual(bot.checkCooldown(invoker(), "help").blocked, false)
  assert.strictEqual(bot.checkCooldown(invoker(), "cmtserver").blocked, false)
})
check("a different command still hits the same person's window", () => {
  const bot = new CmtBot()
  bot.checkCooldown(invoker(), "cmtserver")
  assert.strictEqual(bot.checkCooldown(invoker(), "list").blocked, true)
})
check("someone with no unique id falls back to their client id", () => {
  const bot = new CmtBot()
  const row = { invokerid: "7", invokername: "u" }
  assert.strictEqual(bot.checkCooldown(row, "cmtserver").blocked, false)
  assert.strictEqual(bot.checkCooldown(row, "cmtserver").blocked, true)
})

suite("displayNames (the database nickname goes stale)")
const named = (members, onlineRows) => {
  const bot = new CmtBot()
  bot.cq = { send: async () => onlineRows }
  return bot.displayNames(members)
}
check("an online member is named as they appear right now", async () =>
  assert.deepStrictEqual(
    await named(
      [{ cldbid: "4", client_nickname: "SunBot" }],
      [{ clid: "1", client_database_id: "4", client_nickname: "Arash" }]
    ),
    ["Arash"]
  ))
check("an offline member falls back to the database nickname", async () =>
  assert.deepStrictEqual(await named([{ cldbid: "9", client_nickname: "Reza" }], []), ["Reza"]))
check("a member with no name anywhere shows its dbid", async () =>
  assert.deepStrictEqual(await named([{ cldbid: "9" }], []), ["dbid:9"]))

suite("membersOf (an empty group replies with only the sgid)")
const stub = rows => {
  const bot = new CmtBot()
  bot.cq = { sendAllowEmpty: async () => rows }
  return bot
}
check("the header-only row is not counted as a member", async () =>
  assert.deepStrictEqual(await stub([{ sgid: "91" }]).membersOf("91"), []))
check("real members are kept", async () =>
  assert.deepStrictEqual(
    await stub([{ sgid: "91", cldbid: "66", client_nickname: "Sun Bot" }]).membersOf("91"),
    [{ sgid: "91", cldbid: "66", client_nickname: "Sun Bot" }]
  ))

suite("reconcile (roles follow people off the server)")

/** A bot wired to canned clientlist/channellist/group data, recording deletions. */
function reconciler({ online, occupancy, members }) {
  const bot = new CmtBot()
  const deleted = []
  bot.renames = []
  bot.cq = {
    send: async (command, params) => {
      if (command === "clientlist") {
        return online.map((dbid, i) => ({ clid: String(i + 1), client_database_id: dbid }))
      }
      if (command === "channellist") return [{ cid: "1", total_clients: String(occupancy) }]
      if (command === "servergroupdelclient") {
        deleted.push(`${params.sgid}:${params.cldbid}`)
        return []
      }
      return []
    },
    sendAllowEmpty: async () => members
  }
  bot.updateChannelName = async kind => bot.renames.push(kind)
  bot.deleted = deleted
  return bot
}

check("a member who left loses the role", async () => {
  const bot = reconciler({
    online: ["4"],
    occupancy: 1,
    members: [{ sgid: "91", cldbid: "9", client_nickname: "Gone" }]
  })
  await bot.reconcile("test")
  assert.deepStrictEqual(bot.deleted, ["91:9", "92:9"])
})

check("a member still online keeps the role", async () => {
  const bot = reconciler({
    online: ["4", "9"],
    occupancy: 2,
    members: [{ sgid: "91", cldbid: "9", client_nickname: "Here" }]
  })
  await bot.reconcile("test")
  assert.deepStrictEqual(bot.deleted, [])
})

check("the channel is renamed only when something was removed", async () => {
  const stay = reconciler({
    online: ["9"],
    occupancy: 1,
    members: [{ sgid: "91", cldbid: "9" }]
  })
  await stay.reconcile("test")
  assert.deepStrictEqual(stay.renames, [])

  const go = reconciler({ online: [], occupancy: 0, members: [{ sgid: "91", cldbid: "9" }] })
  await go.reconcile("test")
  assert.deepStrictEqual(go.renames, ["cmtserver", "cmtticket"])
})

check("nothing is removed when clientlist is missing people", async () => {
  // the server reports 5 online but we can only see 1 - stripping roles here
  // would punish everyone the bot simply cannot see
  const bot = reconciler({
    online: ["4"],
    occupancy: 5,
    members: [{ sgid: "91", cldbid: "9", client_nickname: "Invisible" }]
  })
  await bot.reconcile("test")
  assert.deepStrictEqual(bot.deleted, [])
})

check("a clientlist that fails to load removes nothing", async () => {
  const bot = reconciler({
    online: ["4"],
    occupancy: 1,
    members: [{ sgid: "91", cldbid: "9" }]
  })
  bot.cq.send = async command => {
    if (command === "clientlist") throw new Error("connection lost")
    return []
  }
  await bot.reconcile("test")
  assert.deepStrictEqual(bot.deleted, [])
})

suite("afkTick (deafen parks you, coming back returns you)")

/** A bot with a canned clientlist, recording every clientmove it performs. */
function afkBot(clients) {
  const bot = new CmtBot()
  bot.selfClid = "5"
  bot.moves = []
  bot.cq = {
    send: async (command, params) => {
      if (command === "clientlist") return bot.clients
      if (command === "clientmove") {
        bot.moves.push(`${params.clid}->${params.cid}`)
        const c = bot.clients.find(x => x.clid === params.clid)
        if (c) c.cid = params.cid
        return []
      }
      return []
    }
  }
  bot.clients = clients
  return bot
}

const deafened = (clid, cid, extra = {}) => ({
  clid,
  cid,
  client_nickname: `u${clid}`,
  client_output_muted: "1",
  client_input_muted: "0",
  ...extra
})
const present = (clid, cid, extra = {}) => ({ ...deafened(clid, cid, extra), client_output_muted: "0" })

check("nobody is moved before the delay is up", async () => {
  const bot = afkBot([deafened("7", "10")])
  await bot.afkTick()
  await bot.afkTick()
  assert.deepStrictEqual(bot.moves, [])
})

check("a deafened client is parked once the delay passes", async () => {
  const bot = afkBot([deafened("7", "10")])
  await bot.afkTick()
  bot.afkState.get("7").since -= 6000 // pretend 6s went by
  await bot.afkTick()
  assert.deepStrictEqual(bot.moves, ["7->44"])
})

check("they are only moved once, not on every tick", async () => {
  const bot = afkBot([deafened("7", "10")])
  await bot.afkTick()
  bot.afkState.get("7").since -= 6000
  await bot.afkTick()
  await bot.afkTick()
  assert.deepStrictEqual(bot.moves, ["7->44"])
})

check("coming back carries them to the channel they came from", async () => {
  const bot = afkBot([deafened("7", "10")])
  await bot.afkTick()
  bot.afkState.get("7").since -= 6000
  await bot.afkTick()
  bot.clients[0].client_output_muted = "0"
  await bot.afkTick()
  assert.deepStrictEqual(bot.moves, ["7->44", "7->10"])
})

check("somebody already sitting in the AFK channel is left alone", async () => {
  const bot = afkBot([deafened("7", "44")])
  await bot.afkTick()
  bot.afkState.get("7").since -= 6000
  await bot.afkTick()
  assert.deepStrictEqual(bot.moves, [])
})

check("the bot never parks itself", async () => {
  const bot = afkBot([deafened("5", "10")])
  await bot.afkTick()
  await bot.afkTick()
  assert.deepStrictEqual(bot.moves, [])
})

check("someone who walked off on their own is not dragged back", async () => {
  const bot = afkBot([deafened("7", "10")])
  await bot.afkTick()
  bot.afkState.get("7").since -= 6000
  await bot.afkTick()
  bot.clients[0].cid = "20" // they moved themselves out of the AFK channel
  bot.clients[0].client_output_muted = "0"
  await bot.afkTick()
  assert.deepStrictEqual(bot.moves, ["7->44"])
})

check("a client who left the server is forgotten", async () => {
  const bot = afkBot([deafened("7", "10")])
  await bot.afkTick()
  assert.strictEqual(bot.afkState.size, 1)
  bot.clients = []
  await bot.afkTick()
  assert.strictEqual(bot.afkState.size, 0)
})

check("a client who is present is never tracked", async () => {
  const bot = afkBot([present("7", "10")])
  await bot.afkTick()
  assert.strictEqual(bot.afkState.size, 0)
  assert.deepStrictEqual(bot.moves, [])
})

suite("fitNames (TeamSpeak caps channel names at 40 chars)")
const tpl = "CMT Server : {users}"
const fit = names => {
  const users = new CmtBot().fitNames(names, tpl, ", ", 40)
  const full = tpl.replace("{users}", users)
  assert.ok(full.length <= 40, `"${full}" is ${full.length} chars, over the 40 limit`)
  return full
}
check("single short name", () => assert.strictEqual(fit(["Ali"]), "CMT Server : Ali"))
check("two names fit", () => assert.strictEqual(fit(["Ali", "Reza"]), "CMT Server : Ali, Reza"))
check("overflow collapses into +N", () => {
  const out = fit(["Alireza", "Mohammad", "Hossein", "Sajjad"])
  assert.ok(/\+\d+$/.test(out), `expected a +N suffix, got "${out}"`)
})
check("one very long name is truncated, not dropped", () => {
  const out = fit(["ThisNicknameIsFarTooLongToEverFitInAChannelName"])
  assert.ok(out.startsWith("CMT Server : This"), out)
})
check("ten names stay within the limit", () =>
  fit(["aaaa", "bbbb", "cccc", "dddd", "eeee", "ffff", "gggg", "hhhh", "iiii", "jjjj"]))

run()
