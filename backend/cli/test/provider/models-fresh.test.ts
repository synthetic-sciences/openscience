import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { ModelsDev } from "../../src/provider/models"

// The boot refresh is skipped while the cached catalog is younger than a day;
// only the file's age matters, so this test moves the mtime rather than the
// fixture content the rest of the suite depends on.
test("fresh reflects the age of the cached catalog", async () => {
  const file = path.join(Global.Path.cache, "models.json")
  const now = new Date()
  await fs.utimes(file, now, now)
  expect(await ModelsDev.fresh()).toBe(true)
  const stale = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  await fs.utimes(file, stale, stale)
  try {
    expect(await ModelsDev.fresh()).toBe(false)
  } finally {
    await fs.utimes(file, now, now)
  }
})
