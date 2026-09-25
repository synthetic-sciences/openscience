import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { LockCoordination } from "../../src/util/lock-coordination"
import { tmpdir } from "../fixture/fixture"

test("marker creation survives concurrent empty-sidecar cleanup", async () => {
  await using tmp = await tmpdir()
  const lock = path.join(tmp.path, "shared.json.lock")

  await Promise.all(
    Array.from({ length: 200 }, async () => {
      await Promise.all([
        LockCoordination.cleanup(lock),
        (async () => {
          await using marker = await LockCoordination.intent(lock, 30_000)
          expect(await marker.blocked()).toBe(false)
        })(),
      ])
    }),
  )

  await LockCoordination.cleanup(lock)
  await expect(fs.stat(`${lock}.coord`)).rejects.toMatchObject({ code: "ENOENT" })
})

test("the final marker removes empty coordination scaffolding", async () => {
  await using tmp = await tmpdir()
  const lock = path.join(tmp.path, "shared.json.lock")
  const first = await LockCoordination.intent(lock, 30_000)
  const second = await LockCoordination.intent(lock, 30_000)

  await first[Symbol.asyncDispose]()
  expect(await fs.readdir(LockCoordination.directory(lock, "intent"))).toHaveLength(1)
  await second[Symbol.asyncDispose]()

  await expect(fs.stat(`${lock}.coord`)).rejects.toMatchObject({ code: "ENOENT" })
})

for (const permanent of [false, true]) {
  test.skipIf(process.platform !== "win32")(
    `${permanent ? "rejects persistent" : "recovers from transient"} Windows denial while opening an intent marker`,
    async () => {
      await using tmp = await tmpdir()
      const lock = path.join(tmp.path, "denied.lock")
      const directory = LockCoordination.directory(lock, "intent")
      const denied = Object.assign(new Error("Windows marker open denied"), { code: "EPERM" })
      const original = fs.open
      let attempts = 0
      using failure = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        if (path.dirname(String(file)) === directory) {
          expect(flags).toBe("wx")
          expect(mode).toBe(0o600)
          attempts++
          if (permanent || attempts === 1) throw denied
        }
        return original(file, flags, mode)
      })
      if (permanent) {
        await expect(LockCoordination.intent(lock, 30_000)).rejects.toBe(denied)
        expect(attempts).toBe(101)
        expect(await fs.readdir(directory)).toEqual([])
        return
      }
      const marker = await LockCoordination.intent(lock, 30_000)
      try {
        expect(attempts).toBe(2)
        expect(await marker.blocked()).toBe(false)
        const names = await fs.readdir(directory)
        expect(names).toHaveLength(1)
        expect(await Bun.file(path.join(directory, names[0])).json()).toMatchObject({
          pid: process.pid,
          token: names[0],
        })
      } finally {
        await marker[Symbol.asyncDispose]()
      }
      await expect(fs.stat(`${lock}.coord`)).rejects.toMatchObject({ code: "ENOENT" })
    },
  )

  test.skipIf(process.platform !== "win32")(
    `${permanent ? "rejects persistent" : "recovers from transient"} Windows denial while creating marker scaffolding`,
    async () => {
      await using tmp = await tmpdir()
      const lock = path.join(tmp.path, "denied.lock")
      const directory = LockCoordination.directory(lock, "intent")
      const denied = Object.assign(new Error("Windows marker directory denied"), { code: "EPERM" })
      const original = fs.mkdir
      let attempts = 0
      using failure = spyOn(fs, "mkdir").mockImplementation((async (file, options) => {
        if (String(file) === directory) {
          attempts++
          if (permanent || attempts === 1) throw denied
        }
        return original(file, options)
      }) as typeof fs.mkdir)
      if (permanent) {
        await expect(LockCoordination.intent(lock, 30_000)).rejects.toBe(denied)
        expect(attempts).toBe(101)
        await expect(fs.stat(`${lock}.coord`)).rejects.toMatchObject({ code: "ENOENT" })
        return
      }
      const marker = await LockCoordination.intent(lock, 30_000)
      expect(attempts).toBe(2)
      await marker[Symbol.asyncDispose]()
      await expect(fs.stat(`${lock}.coord`)).rejects.toMatchObject({ code: "ENOENT" })
    },
  )
}

test.skipIf(process.platform === "win32")("permission denial on other platforms is not retried", async () => {
  await using tmp = await tmpdir()
  const lock = path.join(tmp.path, "denied.lock")
  const directory = LockCoordination.directory(lock, "intent")
  const original = fs.open
  let attempts = 0
  using failure = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    if (path.dirname(String(file)) === directory) {
      attempts++
      throw Object.assign(new Error("Permission denied"), { code: "EPERM" })
    }
    return original(file, flags, mode)
  })
  await expect(LockCoordination.intent(lock, 30_000)).rejects.toMatchObject({ code: "EPERM" })
  expect(attempts).toBe(1)
  expect(await fs.readdir(directory)).toEqual([])
})

test("an exclusive marker collision stays fail-closed without replacing the existing bytes", async () => {
  await using tmp = await tmpdir()
  const lock = path.join(tmp.path, "collision.lock")
  const directory = LockCoordination.directory(lock, "intent")
  const original = fs.open
  const owner = JSON.stringify({ pid: process.pid, token: "existing-owner", created: Date.now() })
  let attempts = 0
  using collision = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    if (path.dirname(String(file)) === directory) {
      attempts++
      if (attempts === 1) await fs.writeFile(file, owner)
    }
    return original(file, flags, mode)
  })
  await expect(LockCoordination.intent(lock, 30_000)).rejects.toMatchObject({ code: "EEXIST" })
  expect(attempts).toBe(1)
  const names = await fs.readdir(directory)
  expect(names).toHaveLength(1)
  expect(await fs.readFile(path.join(directory, names[0]), "utf8")).toBe(owner)
})
