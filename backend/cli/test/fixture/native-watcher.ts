import { expect, test } from "bun:test"
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { Bus } from "../../src/bus"
import { FileWatcher } from "../../src/file/watcher"
import { Instance } from "../../src/project/instance"

// Deep CI's Linux runner is glibc; release builds inject this same constant.
Object.defineProperty(globalThis, "OPENSCIENCE_LIBC", { value: "glibc" })

test("observes native create, change, and delete without ignored events", async () => {
  // A /tmp fixture would itself match the production **/tmp/** ignore pattern.
  const temporary = await mkdtemp(path.join(import.meta.dir, "watcher-"))
  try {
    const directory = await realpath(temporary)
    await Bun.write(path.join(directory, "openscience.json"), JSON.stringify({ watcher: { ignore: ["**/*.skip"] } }))
    await mkdir(path.join(directory, "node_modules"))
    await mkdir(path.join(directory, "nested"))
    await Instance.provide({
      directory,
      fn: async () => {
        const events: Array<{ file: string; event: string }> = []
        const unsubscribe = Bus.subscribe(FileWatcher.Event.Updated, (event) => events.push(event.properties))
        const file = path.join(directory, "notes.txt")
        const ignored = [
          path.join(directory, "node_modules", "dependency.js"),
          path.join(directory, "nested", "debug.log"),
          path.join(directory, "nested", "private.skip"),
        ]
        async function changed(event: string, action: () => Promise<unknown>) {
          const signal = Promise.withResolvers<void>()
          const stop = Bus.subscribe(FileWatcher.Event.Updated, (entry) => {
            if (entry.properties.file === file && entry.properties.event === event) signal.resolve()
          })
          const timeout = setTimeout(() => signal.reject(new Error(`Missing native ${event} event`)), 2500)
          try {
            await action()
            await signal.promise
          } finally {
            clearTimeout(timeout)
            stop()
          }
        }
        try {
          await FileWatcher.watchSession("native-fixture", [directory])
          await changed("add", async () => {
            await Promise.all(ignored.map((name) => Bun.write(name, "ignored")))
            await Bun.write(file, "first")
          })
          await changed("change", () => Bun.write(file, "changed contents"))
          await changed("unlink", () => rm(file))
          expect(events.some((event) => ignored.includes(event.file))).toBe(false)
          expect(events.filter((event) => event.file === file).map((event) => event.event)).toEqual(
            expect.arrayContaining(["add", "change", "unlink"]),
          )
        } finally {
          unsubscribe()
          await Instance.dispose()
        }
      },
    })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
