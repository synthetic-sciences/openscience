import { test, expect, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Global } from "../src/global"
import { OpenScience } from "../src/openscience"

const queue = path.join(Global.Path.data, "usage-queue.jsonl")
const session = path.join(Global.Path.data, "openscience-session.json")

afterEach(async () => {
  await fs.rm(queue, { force: true }).catch(() => {})
  await fs.rm(session, { force: true }).catch(() => {})
})

test("flushPendingUsage without a session leaves the queue intact", async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await fs.rm(session, { force: true }).catch(() => {})
  const line = JSON.stringify({ service: "test", event_type: "tokens", tokens_used: 1 }) + "\n"
  await fs.writeFile(queue, line)

  await OpenScience.flushPendingUsage()
  expect(await fs.readFile(queue, "utf-8")).toBe(line)
})

test("flushPendingUsage drops malformed lines and removes the empty queue", async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await Bun.write(session, JSON.stringify({ api_key: "thk_test.secret", user_id: "user-1" }))
  await fs.writeFile(queue, "not-json\nalso not json\n")

  await OpenScience.flushPendingUsage()
  expect(await Bun.file(queue).exists()).toBe(false)
})
