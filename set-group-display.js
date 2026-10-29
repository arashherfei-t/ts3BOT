"use strict"

/**
 * One-off admin helper for how the CMT roles are PRESENTED in the client tree:
 *
 *   - the [CMT Server] tag in front of member nicknames
 *   - where members sort among everyone else in a channel
 *
 * Both are permissions on the server group, not group properties: there is no
 * `servergroupedit` command in TeamSpeak 3 at all. They are set with
 * `servergroupaddperm`, which ClientQuery provides - so this runs over the same
 * connection the bot uses and needs no ServerQuery credentials.
 *
 *   i_group_show_name_in_tree   0 hidden | 1 before the nickname | 2 after it
 *   i_client_talk_power         what actually orders clients inside a channel:
 *                               higher first, ties fall back to alphabetical
 *   i_group_sort_id             orders the GROUPS in lists - measured on this
 *                               server, it does not move clients in the tree
 *
 * Usage:
 *   node set-group-display.js --show              print every group's current values
 *   node set-group-display.js                     tag before the nickname
 *   node set-group-display.js --talk 50           ...and lift members above everyone
 *   node set-group-display.js --mode 0 --talk 0   undo both
 */

const fs = require("fs")
const path = require("path")
const { ClientQuery } = require("./clientquery")

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"))

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const raw = process.argv[i]
  if (!raw.startsWith("--")) continue
  const key = raw.replace(/^--/, "")
  const next = process.argv[i + 1]
  if (next === undefined || next.startsWith("--")) args[key] = true
  else {
    args[key] = next
    i++
  }
}

const SHOW_ONLY = args.show === true
const MODE = args.mode === undefined ? "1" : String(args.mode)
const SORT = args.sort === undefined ? null : String(args.sort)
const TALK = args.talk === undefined ? null : args.talk === true ? "50" : String(args.talk)

if (!["0", "1", "2"].includes(MODE)) {
  console.error(`--mode must be 0, 1 or 2 (got "${MODE}")`)
  process.exit(1)
}
for (const [flag, value] of [["--sort", SORT], ["--talk", TALK]]) {
  if (value !== null && !/^\d+$/.test(value)) {
    console.error(`${flag} must be a whole number (got "${value}")`)
    process.exit(1)
  }
}

const NAME_PERM = "i_group_show_name_in_tree"
const SORT_PERM = "i_group_sort_id"
const TALK_PERM = "i_client_talk_power"
const LABEL = { 0: "hidden", 1: "before the nickname", 2: "after the nickname" }

function readApiKey() {
  const cq = cfg.clientquery || {}
  if (cq.apiKey) return cq.apiKey
  const file = cq.apiKeyFile || path.join(process.env.APPDATA || "", "TS3Client", "clientquery.ini")
  const m = fs.readFileSync(file, "utf8").match(/^api_key\s*=\s*(.+)$/m)
  if (!m) throw new Error(`no api_key entry found in ${file}`)
  return m[1].trim()
}

const describe = g =>
  `"${g.name}" tag=${LABEL[g.namemode] || `mode ${g.namemode}`} sort=${
    Number(g.sortid) === 0 ? "unsorted" : g.sortid
  }`

async function main() {
  const cq = new ClientQuery({ port: (cfg.clientquery && cfg.clientquery.port) || 25639 })
  await cq.connect()
  await cq.send("auth", { apikey: readApiKey() })
  await cq.send("clientnotifyregister", { schandlerid: 1, event: "any" })

  const read = async () => cq.send("servergrouplist", {}, [], "notifyservergrouplist")

  let all = await read()
  const targets = [String(cfg.groups.cmtserver), String(cfg.groups.cmtticket)]

  if (SHOW_ONLY) {
    console.log("every group, sorted the way the client tree orders them:\n")
    const sorted = [...all].sort((a, b) => {
      const x = Number(a.sortid) || Infinity // unsorted groups fall to the bottom
      const y = Number(b.sortid) || Infinity
      return x - y
    })
    for (const g of sorted) {
      const mark = targets.includes(String(g.sgid)) ? "  <== CMT" : ""
      console.log(
        `  sort=${String(Number(g.sortid) || "-").padStart(4)}  sgid=${String(g.sgid).padEnd(3)} ` +
          `tag=${String(g.namemode).padEnd(2)} "${g.name}"${mark}`
      )
    }
    cq.close()
    process.exit(0)
  }

  console.log("before:")
  for (const sgid of targets) {
    const g = all.find(x => String(x.sgid) === sgid)
    if (!g) {
      console.error(`  sgid=${sgid} does not exist on this server - check config.json groups`)
      process.exit(1)
    }
    console.log(`  sgid=${sgid} ${describe(g)}`)
  }

  // warn about a tie before making it, since a tie sorts unpredictably
  if (SORT !== null && SORT !== "0") {
    const clash = all.filter(
      g => !targets.includes(String(g.sgid)) && String(g.sortid) === SORT
    )
    if (clash.length) {
      console.log(
        `\n  note: sort id ${SORT} is already used by ${clash
          .map(g => `"${g.name}"`)
          .join(", ")} - groups that share a sort id have no defined order between them.`
      )
    }
  }

  const perms = [[NAME_PERM, MODE, `tag ${LABEL[MODE]}`]]
  if (SORT !== null) perms.push([SORT_PERM, SORT, SORT === "0" ? "unsorted" : `sort id ${SORT}`])
  if (TALK !== null) {
    perms.push([
      TALK_PERM,
      TALK,
      TALK === "0" ? "no talk power" : `talk power ${TALK} - lifts members up the channel`
    ])
  }

  console.log("")
  for (const [permsid, permvalue, what] of perms) {
    console.log(`setting ${permsid}=${permvalue} (${what}) ...`)
    for (const sgid of targets) {
      try {
        await cq.send("servergroupaddperm", {
          sgid,
          permsid,
          permvalue,
          permnegated: 0,
          permskip: 0
        })
        console.log(`  sgid=${sgid} accepted`)
      } catch (e) {
        console.error(`  sgid=${sgid} rejected: ${e.message}`)
      }
    }
  }

  // Talk power is a permission on the group, and `servergrouppermlist` never
  // answers over ClientQuery (it times out). What matters anyway is the value
  // that reaches real people, so read it off whoever is online holding the group.
  const talkOnMembers = async sgid => {
    const clients = await cq.send("clientlist", {}, ["-voice", "-groups"]).catch(() => [])
    return clients
      .filter(c => String(c.client_servergroups || "").split(",").includes(sgid))
      .map(c => `${c.client_nickname}=${c.client_talk_power}`)
  }

  all = await read()
  console.log("\nafter:")
  let ok = true
  for (const sgid of targets) {
    const g = all.find(x => String(x.sgid) === sgid)
    const tagOk = String(g.namemode) === MODE
    const sortOk = SORT === null || String(g.sortid) === SORT
    ok = ok && tagOk && sortOk
    console.log(`  ${tagOk && sortOk ? "ok  " : "FAIL"} sgid=${sgid} ${describe(g)}`)

    if (TALK !== null) {
      const members = await talkOnMembers(sgid)
      console.log(
        members.length
          ? `        talk power on members online: ${members.join(", ")}`
          : "        (nobody holding this group is online, so the talk power cannot be verified here)"
      )
    }
  }

  console.log(
    ok
      ? "\ndone - reconnect a client to see the tree update"
      : "\nthe server did not take part of the change - the bot's group may lack the power " +
          "to modify these groups"
  )

  cq.close()
  process.exit(ok ? 0 : 1)
}

main().catch(e => {
  console.error("failed:", e.message)
  process.exit(1)
})
