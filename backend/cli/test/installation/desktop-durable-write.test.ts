import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { durableJson } from "../../../../frontend/desktop/src/updater.mjs"

const roots: string[] = []
const root = async () => {
  const created = await mkdtemp(path.join(os.tmpdir(), "openscience-durable-"))
  roots.push(created)
  return created
}

afterEach(async () => {
  for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true })
})

test("a durable record lands whole, private, and without a temp sibling", async () => {
  const directory = await root()
  const file = path.join(directory, "last-result.json")

  await durableJson(file, { status: "succeeded", version: "9.8.7", acknowledged_at: "2026-09-20T09:44:55.838Z" })

  expect(await Bun.file(file).json()).toEqual({
    status: "succeeded",
    version: "9.8.7",
    acknowledged_at: "2026-09-20T09:44:55.838Z",
  })
  expect(await Bun.file(file).text()).toEndWith("\n")
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect(await readdir(directory)).toEqual(["last-result.json"])
})

test("overlapping writes never share a temp sibling", async () => {
  const directory = await root()
  const file = path.join(directory, "last-result.json")

  await Promise.all([
    durableJson(file, { status: "succeeded", version: "9.8.7" }),
    durableJson(file, { status: "succeeded", version: "9.8.7" }),
    durableJson(file, { status: "succeeded", version: "9.8.7" }),
  ])

  // A shared `${file}.${pid}.tmp` would let one write rename the other's
  // half-written bytes into place, or leave the loser's temp file behind.
  expect(await readdir(directory)).toEqual(["last-result.json"])
  expect(await Bun.file(file).json()).toEqual({ status: "succeeded", version: "9.8.7" })
})

test("the launch acknowledgement is written durably rather than by hand", async () => {
  const source = await Bun.file(new URL("../../../../frontend/desktop/src/main.mjs", import.meta.url)).text()

  expect(source).toContain("await durableJson(resultFile, acknowledged)")
  // The temp+rename copy this replaced skipped both fsyncs.
  expect(source).not.toContain("writeResultFile")
})
