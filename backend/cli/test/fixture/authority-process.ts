import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { Storage } from "../../src/storage/storage"
import { AuthoritySignal } from "../../src/project/authority-signal"
import { LockCoordination } from "../../src/util/lock-coordination"

const [mode, arg] = process.argv.slice(2)

async function within(promise: Promise<void>, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

if (mode === "init") {
  await Storage.write(["interprocess", "counter"], { count: 0 })
} else if (mode === "update") {
  const iterations = Number(arg)
  for (let index = 0; index < iterations; index++) {
    await Storage.update<{ count: number }>(["interprocess", "counter"], (draft) => {
      draft.count++
    })
  }
} else if (mode === "publish") {
  await AuthoritySignal.publish({ kind: "trust", projectID: arg!, denied: true })
} else if (mode === "watch") {
  const [ready, result] = process.argv.slice(3)
  let resolve!: () => void
  const observed = new Promise<void>((done) => {
    resolve = done
  })
  await using watcher = await AuthoritySignal.watch(async (change) => {
    await Bun.write(result!, JSON.stringify(change))
    resolve()
  }, 20)
  await Bun.write(ready!, "ready")
  await within(observed, "authority signal timeout")
} else if (mode === "watch-project") {
  const [projectID, ready, result] = process.argv.slice(3)
  let resolve!: () => void
  const observed = new Promise<void>((done) => {
    resolve = done
  })
  await using watcher = await AuthoritySignal.watch(async (change) => {
    if (change.type !== "event" || change.event.kind !== "trust" || change.event.projectID !== projectID) {
      return false
    }
    await Bun.write(result!, JSON.stringify(change))
    resolve()
    return true
  }, 20)
  await Bun.write(ready!, "ready")
  await within(observed, "authority signal timeout")
} else if (mode === "hold") {
  const [ready, release] = process.argv.slice(3)
  await AuthoritySignal.exclusive(async () => {
    await Bun.write(ready!, "ready")
    while (!(await Bun.file(release!).exists())) await Bun.sleep(10)
  })
} else if (mode === "acquire") {
  await AuthoritySignal.exclusive(async () => {
    await Bun.write(arg!, "acquired")
  })
} else if (mode === "hold-storage") {
  const [name, ready] = process.argv.slice(3)
  const lockfile = path.join(Global.Path.data, "storage", "interprocess", `${name}.json.lock`)
  await fs.mkdir(path.dirname(lockfile), { recursive: true })
  const handle = await fs.open(lockfile, "wx", 0o600)
  await handle.writeFile(JSON.stringify({ pid: process.pid, created: Date.now() }))
  await Bun.write(ready!, "ready")
  await new Promise(() => {})
  void handle
} else if (mode === "hold-storage-intent") {
  const [name, ready] = process.argv.slice(3)
  const lockfile = path.join(Global.Path.data, "storage", "interprocess", `${name}.json.lock`)
  await using intent = await LockCoordination.intent(lockfile, 30_000)
  await Bun.write(ready!, "ready")
  await new Promise(() => {})
  void intent
} else if (mode === "replace-storage") {
  const [name, ready] = process.argv.slice(3)
  const lockfile = path.join(Global.Path.data, "storage", "interprocess", `${name}.json.lock`)
  const aside = `${lockfile}.${crypto.randomUUID()}.dead`
  await fs.rename(lockfile, aside)
  await fs.rm(aside, { force: true })
  const handle = await fs.open(lockfile, "wx", 0o600)
  await handle.writeFile(JSON.stringify({ pid: process.pid, token: crypto.randomUUID(), created: Date.now() }))
  await handle.sync()
  await Bun.write(ready!, "ready")
  await new Promise(() => {})
  void handle
} else if (mode === "write-storage") {
  const [name, done] = process.argv.slice(3)
  await Storage.write(["interprocess", name!], { recovered: true })
  await Bun.write(done!, "written")
} else {
  throw new Error(`unknown mode: ${mode}`)
}
