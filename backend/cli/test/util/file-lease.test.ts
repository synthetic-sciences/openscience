import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { FileLease } from "../../src/util/file-lease"
import { tmpdir } from "../fixture/fixture"

test("a waiter follows exact-owner progress instead of timing out a healthy lease queue", async () => {
  await using tmp = await tmpdir()
  const filepath = path.join(tmp.path, "progress.lock")
  const record = (token: string) => JSON.stringify({ pid: process.pid, token, created: Date.now() })

  await fs.writeFile(filepath, record("owner-a"))
  const waiting = FileLease.acquire(filepath, 500)
  await Bun.sleep(300)
  await fs.writeFile(filepath, record("owner-b"))
  await Bun.sleep(300)
  await fs.rm(filepath)

  await using lease = await waiting
  expect(await Bun.file(filepath).exists()).toBe(true)
  void lease
}, 5_000)

test("a waiter still fails closed when one live owner stops making progress", async () => {
  await using tmp = await tmpdir()
  const filepath = path.join(tmp.path, "stuck.lock")
  await fs.writeFile(filepath, JSON.stringify({ pid: process.pid, token: "unchanged-owner", created: Date.now() }))

  await expect(FileLease.acquire(filepath, 75)).rejects.toThrow(
    "Timed out waiting for another OpenScience process to release",
  )
}, 5_000)
