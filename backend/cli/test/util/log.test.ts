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
