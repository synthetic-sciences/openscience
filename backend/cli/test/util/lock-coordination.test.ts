import { expect, test } from "bun:test"
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
