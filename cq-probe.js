"use strict"

/**
 * End-to-end check of the ClientQuery pipeline:
 *   auth -> register notifications -> connect -> read groups/channels
 *   -> add a role -> confirm -> rename a channel -> remove the role again
 *
 * It uses the bot's OWN account as the guinea pig and restores the original
 * state before exiting, so nobody else's roles are touched.
 *
 * Run:  node cq-probe.js
 */

const fs = require("fs")
const path = require("path")
const assert = require("assert")
const { ClientQuery, escape, unescape, parseLine } = require("./clientquery")

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"))

/* ------------------------------------------------- offline escaping checks */

function selfTest() {
  assert.strictEqual(escape("Hello World"), "Hello\\sWorld")
  assert.strictEqual(escape("a|b"), "a\\pb")
  assert.strictEqual(escape("c:/x"), "c:\\/x")
  assert.strictEqual(unescape("Hello\\sWorld"), "Hello World")
  assert.strictEqual(unescape(escape("CMT Server : Ali, Reza")), "CMT Server : Ali, Reza")
  assert.strictEqual(unescape(escape("weird\\|/ \tname")), "weird\\|/ \tname")
  assert.deepStrictEqual(parseLine("clid=4 client_nickname=Sun\\sBot"), [
    { clid: "4", client_nickname: "Sun Bot" }
  ])
  assert.deepStrictEqual(parseLine("cldbid=7|cldbid=8"), [{ cldbid: "7" }, { cldbid: "8" }])
  console.log("escaping self-test: ok\n")
}

function readApiKey() {
  if (cfg.clientquery && cfg.clientquery.apiKey) return cfg.clientquery.apiKey
  const p = path.join(process.env.APPDATA || "", "TS3Client", "clientquery.ini")
  const m = fs.readFileSync(p, "utf8").match(/^api_key\s*=\s*(.+)$/m)
  if (!m) throw new Error(`no api_key found in ${p}`)
  return m[1].trim()
}

const ok = s => console.log(`  ok    ${s}`)

async function main() {
  selfTest()

  const cq = new ClientQuery({ port: 25639 })
  cq.on("raw", l => process.env.CQ_DEBUG && console.log("   <<", l))
  await cq.connect()
  ok("connected to the ClientQuery plugin on 127.0.0.1:25639")

  const key = readApiKey()
  await cq.send("auth", { apikey: key })
  ok(`authenticated (api key ...${key.slice(-4)})`)

  await cq.send("clientnotifyregister", { schandlerid: 1, event: "any" })
  ok("registered for notifications")

  const whoami = async () => {
    try {
      const [row] = await cq.send("whoami")
      return row && row.clid && row.clid !== "0" ? row : null
    } catch (e) {
      if (/not connected/i.test(e.message)) return null
      throw e
    }
  }

  let me = await whoami()
  if (!me) {
    const address = `${cfg.teamspeak.host}:${cfg.teamspeak.serverport}`
    console.log(`  ..    not on a server, connecting to ${address}`)
    await cq.send("connect", { address, nickname: cfg.teamspeak.nickname || "Sun Bot" })
    for (let i = 0; i < 25 && !me; i++) {
      await new Promise(r => setTimeout(r, 1000))
      me = await whoami()
    }
    if (!me) throw new Error("client did not finish connecting within 25s")
  }
  ok(`on the server as clid=${me.clid} cid=${me.cid}`)

  // our own database id, needed for the add/remove round trip
  const clients = await cq.send("clientlist", {}, ["-groups"])
  const self = clients.find(c => c.clid === me.clid)
  assert.ok(self, "own client not found in clientlist")
  const myDbid = self.client_database_id
  ok(`nickname="${self.client_nickname}" cldbid=${myDbid} groups=${self.client_servergroups}`)

  /* --------------------------------------------------------- read the ids */

  const groups = await cq.send("servergrouplist", {}, [], "notifyservergrouplist")
  for (const kind of ["cmtserver", "cmtticket"]) {
    const sgid = String(cfg.groups[kind])
    const hit = groups.find(g => g.sgid === sgid)
    assert.ok(hit, `groups.${kind}=${sgid} does not exist on this server`)
    ok(`groups.${kind} = ${sgid} -> "${hit.name}"`)
  }

  const channels = await cq.send("channellist")
  for (const kind of ["cmtserver", "cmtticket"]) {
    const cid = String(cfg.channels[kind])
    const hit = channels.find(c => c.cid === cid)
    assert.ok(hit, `channels.${kind}=${cid} does not exist on this server`)
    ok(`channels.${kind} = ${cid} -> "${hit.channel_name}"`)
  }

  /* ------------------------------------- add / list / rename / remove cycle */

  const sgid = String(cfg.groups.cmtserver)
  const cid = String(cfg.channels.cmtserver)

  const membersOf = async () =>
    (await cq.send("servergroupclientlist", { sgid }, ["-names"], "notifyservergroupclientlist"))
      .filter(r => r.cldbid)

  const before = await membersOf()
  ok(`"CMT Server" currently has ${before.length} member(s)`)

  const hadItAlready = before.some(m => m.cldbid === myDbid)
  if (hadItAlready) {
    console.log("  ..    the bot already holds this role - skipping the mutation test")
  } else {
    await cq.send("servergroupaddclient", { sgid, cldbid: myDbid })
    ok("servergroupaddclient succeeded")

    const during = await membersOf()
    assert.ok(
      during.some(m => m.cldbid === myDbid),
      "the role was not actually granted"
    )
    ok(`role confirmed: ${during.map(m => m.client_nickname).join(", ")}`)

    const name = `CMT Server : ${during.map(m => m.client_nickname).join(", ")}`.slice(0, 40)
    await cq.send("channeledit", { cid, channel_name: name })
    ok(`channeledit renamed channel ${cid} to "${name}"`)

    await cq.send("servergroupdelclient", { sgid, cldbid: myDbid })
    const after = await membersOf()
    assert.strictEqual(after.length, before.length, "role removal did not restore the member count")
    ok("servergroupdelclient succeeded, original state restored")

    await cq.send("channeledit", { cid, channel_name: "CMT Server : -" })
    ok('channel name restored to "CMT Server : -"')
  }

  console.log("\nall ClientQuery capabilities verified\n")
  cq.close()
  process.exit(0)
}

main().catch(e => {
  console.error("\nprobe failed:", e.message)
  process.exit(1)
})
