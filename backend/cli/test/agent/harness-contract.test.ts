import { expect, test } from "bun:test"
import path from "node:path"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { SessionPrompt } from "../../src/session/prompt"
import { SystemPrompt } from "../../src/session/system"
import { tmpdir } from "../fixture/fixture"

const root = new URL("../../src/", import.meta.url)
const read = (path: string) => Bun.file(new URL(path, root)).text()

/** Each family file may grow at most 25 lines over its OpenCode counterpart. */
const BUDGET: Record<SystemPrompt.Family, number> = {
  anthropic: 105 + 25,
  "gpt-astra": 46 + 25,
  gpt: 107 + 25,
  codex: 79 + 25,
  gemini: 155 + 25,
  default: 95 + 25,
}

const FAMILIES = Object.keys(BUDGET) as SystemPrompt.Family[]

test("every family file carries the science slot once and stays within its size budget", async () => {
  for (const family of FAMILIES) {
    const text = await read(`agent/prompt/${family}.txt`)
    expect(text.split(SystemPrompt.SCIENCE_SLOT)).toHaveLength(2)
    expect(text.split("\n").length).toBeLessThanOrEqual(BUDGET[family])
    expect(text.startsWith("You are OpenScience")).toBe(true)
    for (const forbidden of [/OpenCode/, /ctrl\+p/i, /GitHub issue/i, /frontend design/i]) {
      expect(text).not.toMatch(forbidden)
    }
  }
})

test.each([
  ["claude-fable-5.1", "anthropic"],
  ["gpt-6-astra", "gpt-astra"],
  ["gpt-5.6-sol", "gpt"],
  ["gpt-5.6-codex", "codex"],
  ["gemini-3.8-flash", "gemini"],
  ["unknown-model-x", "default"],
] as const)("%s selects the %s header with the science block filled and response defaults appended", (id, family) => {
  expect(SystemPrompt.family(id)).toBe(family)
  const header = SystemPrompt.header({ api: { id } })
  expect(header).not.toContain(SystemPrompt.SCIENCE_SLOT)
  expect(header).toContain(SystemPrompt.science())
  expect(header.match(/## Response structure/g)).toHaveLength(1)
})

test("the science sections are byte-identical across families", () => {
  const science = SystemPrompt.science()
  for (const family of FAMILIES) {
    const header = SystemPrompt.header({ api: { id: family === "default" ? "unknown" : `${family}-model` } })
    expect(header.split(science)).toHaveLength(2)
  }
  for (const section of ["# Evidence and files", "# Methods and deliverables", "# Manuscripts and figures"]) {
    expect(science).toContain(section)
  }
})

test("specialist prompts render the science block and their domain skill index", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const biology = await Agent.get("biology")
      expect(biology?.prompt).toContain(SystemPrompt.SCIENCE_SLOT)
      expect(biology?.prompt).toContain(SystemPrompt.DOMAIN_SKILLS_SLOT)
      expect(biology?.skills).toEqual(["biology", "databases"])
      const rendered = await SystemPrompt.render(biology!)
      expect(rendered.prompt).not.toContain(SystemPrompt.SCIENCE_SLOT)
      expect(rendered.prompt).not.toContain(SystemPrompt.DOMAIN_SKILLS_SLOT)
      expect(rendered.prompt).toContain("# Methods and deliverables")
      expect(rendered.prompt).toContain("biology specialist")
      // An agent without a prompt is returned untouched: it takes the family header.
      const research = await Agent.get("research")
      expect(await SystemPrompt.render(research!)).toBe(research)
    },
  })
})

test("durable child prompts resolve referenced context into prompt parts", async () => {
  await using tmp = await tmpdir()
  const evidence = path.join(tmp.path, "evidence.txt")
  await Bun.write(evidence, "verified evidence")

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parts = await SessionPrompt.resolvePromptParts("Inspect @evidence.txt and return the finding.")
      expect(parts[0]).toEqual({ type: "text", text: "Inspect @evidence.txt and return the finding." })
      expect(parts).toContainEqual({
        type: "file",
        url: `file://${evidence}`,
        filename: "evidence.txt",
        mime: "text/plain",
      })
    },
  })
})

test("Plan uses the observable record without mandatory delegation", async () => {
  const plan = await read("session/prompt/plan.txt")
  expect(plan).toContain("Default to no child")
  expect(plan).not.toContain("Launch up to 3")
  expect(plan).not.toContain("mandatory")
})

test("data-analysis skills keep reports and figures opt-in", async () => {
  const skill = await read("../skills/coding/exploratory-data-analysis/SKILL.md")
  expect(skill).toContain("Do not create a report, figure, artifact, directory, or sidecar file by default")
  expect(skill).toContain("Do not write to disk unless the user requested")
  expect(skill).toContain("For a bounded question")
  expect(skill).toContain("Save only when requested")
  expect(skill).not.toContain("### Step 5: Save Report")
})
