import { expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"

const lead = { providerID: "anthropic", modelID: "claude-opus-5" }
const worker = { providerID: "openai", modelID: "gpt-5.6-terra" }

test("the lead's effort reminder names the Fusion pair and the brief contract only under the fusion strategy", () => {
  const fusion = SessionPrompt.researchEffortReminder(
    "normal",
    { level: "standard", autonomy: "balanced", strategy: "fusion", workerModel: worker },
    undefined,
    { lead },
  )
  expect(fusion).toContain("Fusion is on. Lead: anthropic/claude-opus-5. Worker: openai/gpt-5.6-terra.")
  expect(fusion).toContain("five-part brief")
  expect(fusion).toContain("resumes the same worker")

  const parallel = SessionPrompt.researchEffortReminder(
    "normal",
    { level: "standard", autonomy: "balanced", strategy: "parallel", workerModel: worker },
    undefined,
    { lead },
  )
  expect(parallel).not.toContain("Fusion")

  // A worker inherits the settings with level off and never hears about a worker of its own.
  const child = SessionPrompt.researchEffortReminder(
    "normal",
    { level: "off", autonomy: "balanced", strategy: "fusion", workerModel: worker },
    undefined,
    { lead },
  )
  expect(child).not.toContain("Fusion")
  expect(SessionPrompt.researchEffortReminder("normal", { level: "standard", strategy: "fusion" })).not.toContain(
    "Fusion is on",
  )
})

test("without a distinct worker model the reminder says so rather than promising savings", () => {
  const same = SessionPrompt.researchEffortReminder(
    "normal",
    { level: "standard", autonomy: "balanced", strategy: "fusion" },
    undefined,
    { lead },
  )
  expect(same).toContain("same model as worker")
  expect(same).toContain("does not lower the price")
})
