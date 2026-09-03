import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { Storage } from "../../src/storage/storage"
import { Log } from "../../src/util/log"

Log.init({ print: false })

describe("Storage.list error handling", () => {
  test("a missing prefix lists nothing", async () => {
    expect(await Storage.list([`missing-${crypto.randomUUID()}`])).toEqual([])
  })

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a permission error surfaces instead of masquerading as an empty prefix",
    async () => {
      const prefix = `sealed-${crypto.randomUUID()}`
      const dir = path.join(Global.Path.data, "storage", prefix)
      await fs.mkdir(dir, { recursive: true })
      await fs.chmod(dir, 0o000)
      try {
        await expect(Storage.list([prefix])).rejects.toMatchObject({ code: "EACCES" })
      } finally {
        await fs.chmod(dir, 0o700)
        await fs.rm(dir, { recursive: true, force: true })
      }
    },
  )
})
