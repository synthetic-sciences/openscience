import { Storage } from "../../src/storage/storage"
import { AuthoritySignal } from "../../src/project/authority-signal"

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
} else {
  throw new Error(`unknown mode: ${mode}`)
}
