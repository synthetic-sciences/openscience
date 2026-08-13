import { expect, test } from "bun:test"
import { ModalTool } from "../../src/tool/modal"

test("requires the agent to choose a Modal timeout", async () => {
  const modal = await ModalTool.init()
  const input = {
    name: "analysis",
    purpose: "Measure the treatment effect and save the result table.",
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

test("dispatches asynchronously unless waiting is explicitly requested", async () => {
  const modal = await ModalTool.init()
  const input = {
    name: "analysis",
    purpose: "Measure the treatment effect and save the result table.",
    command: "python analysis.py",
    uploads: ["analysis.py"],
    outputs: [],
    packages: [],
    gpu: "none",
    timeout_minutes: 15,
  }

  expect(modal.parameters.parse(input).wait).toBe(false)
  expect(modal.parameters.parse({ ...input, wait: true }).wait).toBe(true)
})
