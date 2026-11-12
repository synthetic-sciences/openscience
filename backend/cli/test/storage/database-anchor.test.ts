import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { ResearchDatabase } from "../../src/storage/database"
import { DataRoot } from "../../src/global/data-root"
import { DataRootBarrier } from "../../src/global/data-root-barrier"
import { tmpdir } from "../fixture/fixture"

test("accesses share one connection with synchronous=NORMAL, then let it go when idle", async () => {
  await using tmp = await tmpdir()
  const store = ResearchDatabase.create(tmp.path)
  const first = await store.query((db) => db)
  const second = await store.query((db) => db)
  expect(second).toBe(first)
  // 1 = NORMAL. Commits on the shared connection skip the fsync that a
  // checkpoint-on-close would cost.
  expect(await store.query((db) => db.query("PRAGMA synchronous").get())).toEqual({ synchronous: 1 })
  await Bun.sleep(ResearchDatabase.IDLE_MS + 250)
  const reopened = await store.query((db) => db)
  expect(reopened).not.toBe(first)
})

test("a database file deleted underneath the shared connection is not written through it", async () => {
  await using tmp = await tmpdir()
  const store = ResearchDatabase.create(tmp.path)
  await store.write(["todo", "before"], { content: "old file" })
  for (const suffix of ["", "-wal", "-shm"]) await fs.rm(store.filepath + suffix, { force: true })
  await store.write(["todo", "after"], { content: "new file" })
  const verify = new Database(store.filepath, { readonly: true })
  try {
    expect(verify.query("SELECT id FROM todo ORDER BY id").all()).toEqual([{ id: "after" }])
  } finally {
    verify.close()
  }
})

test("a relocation drains the shared connection instead of waiting out its deadline", async () => {
  await using tmp = await tmpdir()
  const config = path.join(tmp.path, "config")
  const managed = await DataRoot.ensure(config, path.join(tmp.path, "data"), false)
  using _ = DataRootBarrier.configure({ root: managed.path, config })
  const store = ResearchDatabase.create(managed.path)
  await store.write(["todo", "held"], { content: "anchor open" })
  const started = Date.now()
  // The anchor's marker is live; the switch must still complete within
  // the idle period rather than time out.
  await using lease = await DataRootBarrier.exclusive(5_000)
  expect(Date.now() - started).toBeLessThan(ResearchDatabase.IDLE_MS + 1_000)
  expect(lease).toBeDefined()
})

test("an access during a published relocation waits for it instead of reusing the connection", async () => {
  await using tmp = await tmpdir()
  const config = path.join(tmp.path, "config")
  const managed = await DataRoot.ensure(config, path.join(tmp.path, "data"), false)
  using _ = DataRootBarrier.configure({ root: managed.path, config })
  const store = ResearchDatabase.create(managed.path)
  await store.write(["todo", "first"], { content: "before" })
  const switching = DataRootBarrier.exclusive(5_000)
  await Bun.sleep(50) // intent published, waiting for the anchor
  let wrote = false
  const writing = store.write(["todo", "second"], { content: "after" }).then(() => (wrote = true))
  const lease = await switching
  expect(wrote).toBe(false)
  await lease[Symbol.asyncDispose]()
  await writing
  expect(await store.read(["todo", "second"])).toEqual({ content: "after" })
})
