import { expect, test } from "bun:test"
import CalibrationPlugin from "../fixture/calibration-plugin"

test("summarizes an offline sample and produces a CSV reference", async () => {
  const plugin = await CalibrationPlugin()
  const records = await plugin.connector[0].search("calibration", { limit: 1 })
  expect(records).toHaveLength(1)
  const record = (await plugin.connector[0].fetch(records[0].id)) as { values: number[] }
  const result = await plugin.tool.local_lab_summary.execute(record, {
    directory: process.cwd(),
    worktree: process.cwd(),
    sessionID: "fixture",
    messageID: "fixture-message",
    agent: "research",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  })
  if (typeof result === "string") throw new Error("The fixture must return structured output")
  expect(result.metadata).toMatchObject({ count: 3, mean: 2 })
  expect(result.attachments?.[0].filename).toBe("summary.csv")
})

test("honors cancellation before analysis", async () => {
  const plugin = await CalibrationPlugin()
  const controller = new AbortController()
  controller.abort()
  await expect(plugin.connector[0].search("calibration", { signal: controller.signal })).rejects.toThrow()
})
