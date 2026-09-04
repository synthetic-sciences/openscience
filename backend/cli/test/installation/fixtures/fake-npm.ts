type State = {
  diff?: string
  failTagReadAfterAdd?: string
  failTagReadOnce?: boolean
  identity: string
  optionalDependencies?: Record<string, Record<string, string>>
  owners: string[]
  packages: Record<string, { integrity: string; visibilityReads?: number }>
  publishCalls: number
  publishFailures?: Record<string, number>
  publishMaxInflight?: number
  publishGhosts?: Record<string, number>
  publishIntegrities?: string[]
  publishMode?: "already" | "ghost" | "permission" | "success"
  publishSpecs?: string[]
  publishVisibilityReads?: number
  tagAdds?: string[]
  tags: Record<string, Record<string, string>>
}

import { mkdir, readdir, rm } from "node:fs/promises"
import { rmSync } from "node:fs"

const file = process.env.FAKE_NPM_STATE
if (!file) throw new Error("FAKE_NPM_STATE is required")
const args = process.argv.slice(2)

// Release tooling now overlaps registry writes, so several fake npm processes
// can share one state file. A mkdir lock serializes every read-modify-write;
// per-process markers count how many publishes overlapped for the tests.
const lock = `${file}.lock`
const inflight = `${file}.inflight`
await mkdir(inflight, { recursive: true })
const marker = `${inflight}/${process.pid}`
await Bun.write(marker, "")
process.on("exit", () => rmSync(marker, { force: true }))
if (args[0] === "publish") await Bun.sleep(30)
for (let attempt = 0; ; attempt++) {
  const acquired = await mkdir(lock).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
      return false
    },
  )
  if (acquired) break
  if (attempt > 5_000) throw new Error("fake npm registry lock timed out")
  await Bun.sleep(2)
}
// Only the holder releases the lock: a process that timed out above must not
// free another process's lock and let two read-modify-writes overlap.
process.on("exit", () => rmSync(lock, { force: true, recursive: true }))
const overlapping = (await readdir(inflight)).length
const state = (await Bun.file(file).json()) as State

async function save() {
  await Bun.write(file!, `${JSON.stringify(state, null, 2)}\n`)
}

function fail(message: string, code = 1) {
  console.error(message)
  process.exit(code)
}

if (args[0] === "whoami") {
  console.log(state.identity)
  process.exit(0)
}

if (args[0] === "owner" && args[1] === "ls") {
  for (const owner of state.owners) console.log(`${owner} <${owner}@example.test>`)
  process.exit(0)
}

if (args[0] === "view" && args[2] === "dist.integrity") {
  const entry = state.packages[args[1]]
  if (!entry) fail("npm error code E404\nNo match found for version")
  if ((entry.visibilityReads ?? 0) > 0) {
    entry.visibilityReads = (entry.visibilityReads ?? 0) - 1
    await save()
    fail("npm error code E404\nNo match found for version")
  }
  console.log(JSON.stringify(entry.integrity))
  process.exit(0)
}

if (args[0] === "view" && args[2] === "optionalDependencies") {
  console.log(JSON.stringify(state.optionalDependencies?.[args[1]] ?? {}))
  process.exit(0)
}

if (args[0] === "diff") {
  if (state.diff) console.log(state.diff)
  process.exit(0)
}

if (args[0] === "publish") {
  state.publishCalls++
  state.publishMaxInflight = Math.max(state.publishMaxInflight ?? 0, overlapping)
  const archive = Bun.spawn(["tar", "-xOzf", args[1], "package/package.json"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const manifest = JSON.parse(await new Response(archive.stdout).text()) as { name: string; version: string }
  if ((await archive.exited) !== 0) throw new Error("Could not inspect fake npm package")
  const spec = process.env.FAKE_NPM_SPEC ?? `${manifest.name}@${manifest.version}`
  state.publishSpecs ??= []
  state.publishSpecs.push(spec)
  const bytes = await Bun.file(args[1]).arrayBuffer()
  const digest = new Bun.CryptoHasher("sha512").update(bytes).digest("base64")
  state.publishIntegrities ??= []
  state.publishIntegrities.push(`sha512-${digest}`)
  if ((state.publishFailures?.[spec] ?? 0) > 0) {
    state.publishFailures![spec]--
    await save()
    fail("npm error code E500\ntransient publish failure")
  }
  if ((state.publishGhosts?.[spec] ?? 0) > 0) {
    state.publishGhosts![spec]--
    await save()
    console.log(`+ ${spec}`)
    process.exit(0)
  }
  if (state.publishMode === "ghost") {
    await save()
    console.log(`+ ${spec}`)
    process.exit(0)
  }
  if (state.publishMode === "permission") {
    await save()
    fail("npm error code E403\nYou do not have permission to publish this package")
  }
  state.packages[spec] = {
    integrity: `sha512-${digest}`,
    visibilityReads: state.publishVisibilityReads ?? 0,
  }
  await save()
  if (state.publishMode === "already") {
    fail("npm error code E403\nYou cannot publish over the previously published versions")
  }
  console.log(`+ ${spec}`)
  process.exit(0)
}

if (args[0] === "view" && args[2] === "dist-tags") {
  if (state.failTagReadOnce) {
    state.failTagReadOnce = false
    await save()
    fail("npm error code E500\ntransient dist-tag read failure")
  }
  console.log(JSON.stringify(state.tags[args[1]] ?? {}))
  process.exit(0)
}

if (args[0] === "dist-tag" && args[1] === "add") {
  const split = args[2].lastIndexOf("@")
  const name = args[2].slice(0, split)
  const version = args[2].slice(split + 1)
  state.tags[name] ??= {}
  state.tags[name][args[3]] = version
  state.tagAdds ??= []
  state.tagAdds.push(`${name}@${version}:${args[3]}`)
  if (state.failTagReadAfterAdd === name) {
    state.failTagReadAfterAdd = undefined
    state.failTagReadOnce = true
  }
  await save()
  process.exit(0)
}

if (args[0] === "dist-tag" && args[1] === "rm") {
  delete state.tags[args[2]]?.[args[3]]
  await save()
  process.exit(0)
}

fail(`unsupported fake npm command: ${args.join(" ")}`)
