import { expect, test } from "bun:test"
import { Log } from "../../src/util/log"

// File-mode lines are batched behind a short timer; flush() must land whatever
// is still buffered before the caller reads the file back.
test("buffered lines land in the log file after flush", async () => {
  const marker = `log-buffer-${crypto.randomUUID()}`
  Log.Default.info(marker)
  await Log.flush()
  expect(Log.file()).not.toBe("")
  expect(await Bun.file(Log.file()).text()).toContain(marker)
})

// The service logger is one cached instance shared by every caller, so a
// per-call tag must land on an uncached copy: two concurrent streams tagged
// differently must never relabel each other's lines or the shared logger.
test("tagged loggers never share tags with each other or with the cached service logger", async () => {
  const base = Log.create({ service: "log-tag-test" })
  const title = base.child({ agent: "title" })
  const research = base.child({ agent: "research" })
  const lsp = base.clone().tag("serverID", "ts")
  expect(Log.create({ service: "log-tag-test" })).toBe(base)
  expect(title).not.toBe(base)
  expect(title).not.toBe(research)
  expect(lsp).not.toBe(base)

  const id = crypto.randomUUID()
  title.info(`title-${id}`)
  research.info(`research-${id}`)
  lsp.info(`lsp-${id}`)
  base.info(`base-${id}`)
  await Log.flush()

  const lines = (await Bun.file(Log.file()).text()).split("\n")
  const line = (marker: string) => lines.find((item) => item.endsWith(marker)) ?? ""
  expect(line(`title-${id}`)).toContain("service=log-tag-test agent=title ")
  expect(line(`title-${id}`)).not.toContain("research")
  expect(line(`research-${id}`)).toContain("service=log-tag-test agent=research ")
  expect(line(`research-${id}`)).not.toContain("title")
  expect(line(`lsp-${id}`)).toContain("serverID=ts")
  expect(line(`lsp-${id}`)).not.toContain("agent=")
  expect(line(`base-${id}`)).toContain("service=log-tag-test base-")
  expect(line(`base-${id}`)).not.toContain("agent=")
  expect(line(`base-${id}`)).not.toContain("serverID=")
})
