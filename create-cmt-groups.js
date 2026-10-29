"use strict"

/**
 * Creates the two CMT server groups on whatever server the TeamSpeak client is
 * currently connected to, with the presentation settings the bot expects, and
 * prints the ids to put in config.json.
 *
 * Use this when moving the bot to another server: the CMT groups carry only a
 * handful of permissions, so recreating them is quicker and far safer than a
 * server snapshot (which overwrites the whole target server).
 *
 *   node create-cmt-groups.js               create them, then print the ids
 *   node create-cmt-groups.js --talk 0      create without the talk power lift
 *   node create-cmt-groups.js --dry         show what would happen, change nothing
 *
 * NOTE: the group icon is not copied. Icons live in the server's own file
 * repository, so an icon id from another server points at nothing here - set it
 * in the TeamSpeak client afterwards if you want one.
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

const DRY = args.dry === true
const TALK = args.talk === undefined ? "50" : String(args.talk)
const NAMES = { cmtserver: "CMT Server", cmtticket: "CMT Ticket" }

/**
 * What a CMT group needs. Deliberately hardcoded rather than read from the
 * source server: `servergrouppermlist` returns its data but then makes the
 * TeamSpeak client drop its connection, so it must not be used.
 */
const PERMS = talk => [
  ["b_group_is_permanent", "1"],
  ["i_group_show_name_in_tree", "1"],
  ["i_client_talk_power", talk]
]

function readApiKey() {
  const cq = cfg.clientquery || {}
  if (cq.apiKey) return cq.apiKey
  const file = cq.apiKeyFile || path.join(process.env.APPDATA || "", "TS3Client", "clientquery.ini")
  const m = fs.readFileSync(file, "utf8").match(/^api_key\s*=\s*(.+)$/m)
  if (!m) throw new Error(`no api_key entry found in ${file}`)
  return m[1].trim()
}

async function main() {
  const cq = new ClientQuery({ port: (cfg.clientquery && cfg.clientquery.port) || 25639 })
  await cq.connect()
  await cq.send("auth", { apikey: readApiKey() })
  await cq.send("clientnotifyregister", { schandlerid: 1, event: "any" })

  const me = await cq.send("whoami").catch(() => [])
  if (!me.length || !me[0].clid || me[0].clid === "0") {
    console.error("the TeamSpeak client is not connected to a server - connect it first")
    process.exit(1)
  }

  const groups = await cq.send("servergrouplist", {}, [], "notifyservergrouplist")
  console.log(`connected to a server with ${groups.length} server groups\n`)

  const result = {}

  for (const [kind, name] of Object.entries(NAMES)) {
    const existing = groups.find(g => g.name === name)
    if (existing) {
      console.log(`"${name}" already exists as sgid=${existing.sgid} - leaving it alone`)
      result[kind] = existing.sgid
      continue
    }

    if (DRY) {
      console.log(`would create "${name}" and set ${PERMS(TALK).length} permissions`)
      result[kind] = "?"
      continue
    }

    const [created] = await cq.send("servergroupadd", { name })
    const sgid = String(created.sgid)
    console.log(`created "${name}" as sgid=${sgid}`)
    result[kind] = sgid

    for (const [permsid, permvalue] of PERMS(TALK)) {
      if (permvalue === "0" && permsid === "i_client_talk_power") continue
      try {
        await cq.send("servergroupaddperm", {
          sgid,
          permsid,
          permvalue,
          permnegated: 0,
          permskip: 0
        })
        console.log(`   ${permsid} = ${permvalue}`)
      } catch (e) {
        console.error(`   ${permsid} FAILED: ${e.message}`)
      }
    }
  }

  console.log("\nput these in config.json:\n")
  console.log(`  "groups": {`)
  console.log(`    "cmtserver": ${result.cmtserver},`)
  console.log(`    "cmtticket": ${result.cmtticket}`)
  console.log(`  }`)

  console.log(
    "\nstill to do by hand on this server:\n" +
      "  - give the groups an icon in the TeamSpeak client if you want one\n" +
      "  - make sure the bot's own group out-powers these two\n" +
      "    (i_group_member_add_power / i_group_member_remove_power)\n" +
      "  - set channels.cmtserver / channels.cmtticket / afk.channelId to this server's channel ids"
  )

  cq.close()
  process.exit(0)
}

main().catch(e => {
  console.error("failed:", e.message)
  process.exit(1)
})
