import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DesktopParent } from "../../src/process/desktop-parent"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("desktop parent binding", () => {
  test("signals exact parent loss and rejects forged launch bindings", async () => {
    let parent = 42
    using watcher = DesktopParent.watch({
      env: {
        OPENSCIENCE_DESKTOP_PARENT_PID: "42",
        OPENSCIENCE_DESKTOP_PARENT_TOKEN: "a".repeat(48),
      },
      parent: () => parent,
      intervalMs: 1,
    })
    expect(watcher?.pid).toBe(42)
    parent = 1
    await watcher?.exited

    expect(() =>
      DesktopParent.watch({
        env: {
          OPENSCIENCE_DESKTOP_PARENT_PID: "42",
          OPENSCIENCE_DESKTOP_PARENT_TOKEN: "b".repeat(48),
        },
        parent: () => 41,
      }),
    ).toThrow("not launched by its bound parent")
  })

  test.skipIf(process.platform !== "darwin")(
    "writes a durable update runtime receipt before the full CLI adopts the parent guard",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "openscience-desktop-parent-"))
      roots.push(root)
      const token = "c".repeat(48)
      const receipt = path.join(root, `runtime-${token}.json`)
      const env = {
        OPENSCIENCE_DESKTOP_PARENT_PID: "42",
        OPENSCIENCE_DESKTOP_PARENT_TOKEN: "d".repeat(48),
        OPENSCIENCE_DESKTOP_PARENT_RUNTIME_RECEIPT: receipt,
        OPENSCIENCE_DESKTOP_PARENT_UPDATE_TOKEN: token,
        OPENSCIENCE_DESKTOP_PARENT_UPDATE_VERSION: "9.8.7",
      }
      DesktopParent.bootstrap({
        env,
        parent: () => 42,
        intervalMs: 1,
        identity: () => ({
          pid: process.pid,
          started: "Fri Aug 29 09:00:00 2026",
          executable: path.resolve(process.execPath),
          command: path.resolve(process.execPath),
        }),
      })
      using watcher = DesktopParent.watch({ env, parent: () => 42, intervalMs: 1 })
      expect(await Bun.file(receipt).json()).toMatchObject({
        schema: 1,
        token,
        version: "9.8.7",
        parent: 42,
        service_identity: { pid: process.pid, executable: path.resolve(process.execPath) },
      })
      expect(watcher?.pid).toBe(42)
    },
  )
})
