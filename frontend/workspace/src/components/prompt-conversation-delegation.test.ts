import { expect, test } from "bun:test"

const input = await Bun.file(new URL("./prompt-input.tsx", import.meta.url)).text()
const prompt = await Bun.file(new URL("../context/prompt.tsx", import.meta.url)).text()
const capabilities = await Bun.file(new URL("./prompt-capabilities.ts", import.meta.url)).text()

test("keeps conversation references typed from chip through request", () => {
  expect(prompt).toContain('type: "conversation"')
  expect(prompt).toContain("sourceSessionID: string")
  expect(input).toContain('setStore("popover", "conversation")')
  expect(input).toContain('type: "conversation" as const')
  expect(input).toContain("throughMessageID: attachment.throughMessageID")
})

test("offers model-directed delegation controls and sends the normalized contract", () => {
  expect(capabilities).toContain('export type DelegationLevel = "off" | "standard" | "high"')
  expect(capabilities).toContain('export type DelegationAutonomy = "interactive" | "balanced" | "autonomous"')
  expect(capabilities).toContain('value: "standard", label: "Auto"')
  expect(capabilities).not.toContain('value: "light", label: "Low"')
  expect(input).toContain("delegationSettings: delegationConfig")
  expect(input).toContain("delegation_worker_model")
  expect(input).toContain('label="Delegation"')
  expect(input).toContain('label="Independence"')
  expect(input).not.toContain("Worker model, ${workerSelection()}")
  expect(input).not.toContain("Approaches")
})
