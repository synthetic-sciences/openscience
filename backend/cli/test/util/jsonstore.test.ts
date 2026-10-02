import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { JsonStore } from "../../src/util/jsonstore"

test("a store that cannot be parsed is not reported as backed up when the copy fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-jsonstore-"))
  try {
    // A directory is a store the read cannot parse *and* the copy cannot take,
    // so both operations fail on the same path. This is what a store that hit a
    // full disk or a read-only volume looks like from here.
    const store = path.join(root, "auth.json")
    await fs.mkdir(store)

    const error = await JsonStore.update(store, (data) => ({ ...data, added: 1 })).then(
      () => undefined,
      (thrown: Error) => thrown,
    )

    expect(error?.message).toContain("could not be parsed")
    // The old message named a backup that was never written and then told the
    // user to remove the file, which is how every credential in it is lost.
    expect(error?.message).not.toContain("was backed up to")
    expect(error?.message).toContain("only copy")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("a store that cannot be parsed still names the backup it wrote", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-jsonstore-"))
  try {
    const store = path.join(root, "auth.json")
    const corrupt = '{"anthropic": {"type": "api", "key": "sk-real"'
    await fs.writeFile(store, corrupt)

    const error = await JsonStore.update(store, (data) => ({ ...data, added: 1 })).then(
      () => undefined,
      (thrown: Error) => thrown,
    )

    const backup = `${store}.corrupt-${process.pid}`
    expect(error?.message).toContain(`backed up to ${backup}`)
    // The named path has to be the one that was actually written, or the
    // message is worse than no message.
    expect(await Bun.file(backup).text()).toBe(corrupt)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
