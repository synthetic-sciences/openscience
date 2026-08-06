import { expect, test } from "bun:test"
import { ModalTool } from "../../src/tool/modal"

test("requires the agent to choose a Modal timeout", async () => {
  const modal = await ModalTool.init()
  const input = {
    name: "analysis",
    command: "python analysis.py",
    uploads: ["analysis.py"],
    outputs: [],
    packages: [],
    gpu: "none",
    wait: true,
  }

  expect(modal.parameters.safeParse(input).success).toBe(false)
  expect(modal.parameters.safeParse({ ...input, timeout_minutes: 15 }).success).toBe(true)
})
