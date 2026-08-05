import { expect, test } from "bun:test"
import { SystemPrompt } from "../../src/session/system"
import { ComputePrompt } from "../../src/compute/prompt"

test("system prompt describes enabled Modal as OpenScience-managed compute", async () => {
  const marker = "as-agent-must-never-see-this"
  const section = await SystemPrompt.compute({
    providers: {
      modal: {
        enabled: true,
        source: "stored",
        key: marker,
      },
    },
  })

  expect(section).toHaveLength(1)
  expect(section[0]).toContain("Modal compute is configured and enabled through OpenScience")
  expect(section[0]).toContain("explicitly approved jobs")
  expect(section[0]).toContain("Do not check for or install the Modal Python package")
  expect(section[0]).toContain("Credentials are not available in the agent shell")
  expect(section[0]).toContain("a chat reply such as `yes` is not dispatch authorization")
  expect(section[0]).toContain("Never run or recommend `modal run`")
  expect(section[0]).toContain("ordinary shell command that runs inside the configured sandbox image")
  expect(section[0]).toContain("explicit uploads and outputs")
  expect(section[0]).toContain("`packages` field")
  expect(section[0]).toContain("GPU `none` for CPU-only work")
  expect(section[0]).toContain("Do not ask the user to copy these values into Compute manually")
  expect(section[0]).toContain("Only report dispatch, status, logs, or completion returned by the `modal` tool")
  expect(section[0]).toContain(
    "Questions about whether Modal is available, configured, connected, or enabled are read-only",
  )
  expect(section[0]).toContain("Never call the `modal` tool to test availability")
  expect(section[0]).toContain("Only call it after the user explicitly asks to run a workload on Modal")
  expect(section[0]).toContain("call the `modal` tool immediately")
  expect(section[0]).toContain("Do not first present a prose approval card")
  expect(section[0]).toContain("choose an explicit `timeout_minutes`")
  expect(section[0]).toContain("configured default is 60 minutes")
  expect(section[0]).toContain("Use it as the starting point")
  expect(section[0]).not.toContain(marker)

  const configured = await SystemPrompt.compute({
    providers: { modal: { enabled: true } },
    modal: { timeout_minutes: 25 },
  })
  expect(configured[0]).toContain("configured default is 25 minutes")
})

test("system prompt reflects disabled and unconfigured Modal states", async () => {
  const disabled = await SystemPrompt.compute({ providers: { modal: { enabled: false } } })
  const missing = await SystemPrompt.compute({})

  expect(disabled[0]).toContain("Modal is configured but disabled")
  expect(disabled[0]).toContain("not available for new jobs")
  expect(missing[0]).toContain("Modal is not configured in OpenScience")
  expect(missing[0]).toContain("Settings > Compute")
})

test("Modal skills cannot reintroduce direct credentials or CLI dispatch", async () => {
  const legacy = [
    "Everything is Python code.",
    "Credentials are auto-injected via OpenScience.",
    "If Modal CLI isn't installed: pip install modal.",
    "Run quick jobs with modal run script.py.",
    "legacy-reference-marker",
  ].join("\n")
  const stored = { providers: { modal: { enabled: true } } }

  for (const name of ["modal-serverless-gpu", "modal-ml-training", "modal-research-gpu"]) {
    const content = await ComputePrompt.skill(name, legacy, stored)
    expect(content).toContain("OpenScience-governed Modal compute")
    expect(content).toContain("ordinary shell command")
    expect(content).toContain("call the `modal` tool")
    expect(content).toContain("send the user to manually recreate the job")
    expect(content).not.toContain("Credentials are auto-injected")
    expect(content).not.toContain("legacy-reference-marker")
  }

  expect(await ComputePrompt.skill("pytorch", legacy, stored)).toBe(legacy)
})
