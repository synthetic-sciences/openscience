import { expect, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { SessionPrompt } from "../../src/session/prompt"
import { SystemPrompt } from "../../src/session/system"
import { DELEGATION_PROFILES, MAX_CHILD_AGENTS, isComputeDelegationProfile } from "../../src/tool/task"
import { tmpdir } from "../fixture/fixture"

const root = new URL("../../src/", import.meta.url)
const read = (path: string) => Bun.file(new URL(path, root)).text()
const webFetchFolderDownload = 'output_path:"foo.pdf"'
const webFetchFolderMove = "mkdir -p -- 'papers' && test ! -e 'papers/foo.pdf' && mv -- 'foo.pdf' 'papers/foo.pdf'"

test("every WebFetch instruction teaches one root-download then sandboxed-move sequence", async () => {
  const prompts = await Promise.all([
    read("session/prompt/core.txt"),
    read("agent/prompt/research.txt"),
    read("tool/webfetch.txt"),
  ])
  for (const prompt of prompts) {
    expect(prompt).toContain(webFetchFolderDownload)
    expect(prompt).toContain(webFetchFolderMove)
    expect(prompt).toContain("only after")
    expect(prompt).toContain("live free disk")
    expect(prompt).not.toContain("max_bytes")
    expect(prompt).not.toContain("declared_size")
  }
})

test("context overflow compacts into an explicit resume turn", async () => {
  const [processor, compaction] = await Promise.all([read("session/processor.ts"), read("session/compaction.ts")])
  expect(processor).toContain("SessionRetry.isContextOverflow(error)")
  expect(processor).toContain('input.assistantMessage.finish = "compact"')
  expect(compaction).toContain("Continue from the 'Next Move' in the handoff above")
  expect(compaction).toContain('return "continue"')
})

test("every provider receives one compact product operating contract", () => {
  const instructions = SystemPrompt.instructions()
  expect(SystemPrompt.provider(undefined as never)[0]?.trim()).toBe(instructions)
  expect(instructions.length).toBeLessThan(4_000)
  expect(instructions).toContain("Keep simple work simple")
  expect(instructions).toContain("Synthetic Sciences graph state is optional")
  expect(instructions).toContain("Default to no children")
  expect(instructions).toContain("Explore or Execute")
  expect(instructions).not.toContain("Explore, Execute, or Review")
  expect(instructions).toContain("large or binary scientific data")
  expect(instructions).toContain("output_path")
  expect(instructions).toContain("Group related file edits in one `apply_patch` call")
  expect(instructions).toContain("preflights every file and rolls back on failure")
  expect(instructions).toContain("qpdf or Tectonic")
  expect(instructions).not.toContain("data once with Shell")
  expect(instructions).toContain("immutable release")
  expect(instructions).not.toContain("shared keys")
  expect(instructions).not.toContain("project init")
})

test("direct answers receive a compact truth-preserving core", () => {
  const instructions = SystemPrompt.instructions(true)
  expect(SystemPrompt.provider(undefined as never, true)[0]?.trim()).toBe(instructions)
  expect(instructions.length).toBeLessThan(350)
  expect(instructions).toContain("You are OpenScience")
  expect(instructions).toContain("requested format")
  expect(instructions).toContain("Do not plan, use tools, delegate, search")
  expect(instructions).toContain("uncertainty")
})

test("read-only inspections receive a compact evidence-preserving core", () => {
  const instructions = SystemPrompt.instructions(false, true)
  expect(SystemPrompt.provider(undefined as never, false, true)[0]?.trim()).toBe(instructions)
  expect(instructions.length).toBeLessThan(350)
  expect(instructions).toContain("You are OpenScience")
  expect(instructions).toContain("requested local files")
  expect(instructions).toContain("observed")
  expect(instructions).toContain("Do not modify files")
})

test("the primary, domain, and specialist prompts stay adaptive instead of procedural", async () => {
  const [research, direct, ml, biology, physics, write, explore] = await Promise.all([
    read("agent/prompt/research.txt"),
    read("session/prompt/direct.txt"),
    read("agent/prompt/ml.txt"),
    read("agent/prompt/biology.txt"),
    read("agent/prompt/physics.txt"),
    read("agent/prompt/write.txt"),
    read("agent/prompt/explore.txt"),
  ])
  for (const prompt of [research, ml, biology, physics, write, explore]) {
    expect(prompt.length).toBeLessThan(4_000)
    expect(prompt).not.toContain("literature-review.md")
    expect(prompt).not.toContain("reasoning.md")
    expect(prompt).not.toContain("methodology.md")
    expect(prompt).not.toContain("Create/link the graph")
  }
  expect(research).toContain("Answer a direct question directly")
  expect(research).toContain("Default to zero children")
  expect(research).toContain("Synthetic Sciences graph state is optional")
  expect(research).toContain("lazy skills")
  expect(research).toContain("bounded pages")
  expect(research).toContain("claim/evidence matrix")
  expect(research).toContain("output_path")
  expect(research).toContain("Group related file edits in one `apply_patch` call")
  expect(research).toContain("preflights every file and rolls back on failure")
  expect(research).toContain("qpdf or Tectonic")
  expect(research).toContain("optional binaries as capabilities")
  expect(research).toContain("never\n  convert failed candidates to NaN")
  expect(research).toContain("without a filtering pipeline")
  expect(direct.length).toBeLessThan(300)
  expect(direct).toContain("Do not plan, use tools, delegate, search")
  expect(direct).toContain("requested format")
  expect(research).not.toContain("data once to the workspace with Shell")
  expect(research).toContain("immutable data release")
  expect(ml).toContain("simplest method")
  expect(biology).toContain("multiple testing")
  expect(physics).toContain("dimensional consistency")
  expect(write).toContain("Do not invent a report")
  expect(write).toContain("format-only task")
  expect(write).not.toContain("Every document MUST")
  expect(write).not.toContain("minimum 5 figures")
  expect(explore).toContain("Stay read-only")
  expect(explore).not.toContain("copying, moving")
})

test("ordinary literature reviews stay conversational instead of becoming report pipelines", async () => {
  const [skill, specialist] = await Promise.all([
    Bun.file(new URL("../../skills/writing/literature-review/SKILL.md", import.meta.url)).text(),
    read("agent/prompt/literature-review.txt"),
  ])
  expect(skill).toContain("Default: narrative review")
  expect(skill).toContain("do not create files")
  expect(skill).toContain("Do not generate images")
  expect(skill).not.toContain("Every literature review MUST")
  expect(specialist).toContain("Default to the narrative path")
  expect(specialist).toContain("do not enter this workflow")
  expect(specialist).not.toContain("Before ANY literature search")
})

test("delegation is lead-owned, capacity-bound, flat, and observable", async () => {
  const [prompt, source, core, research, processor] = await Promise.all([
    read("tool/task.txt"),
    read("tool/task.ts"),
    read("session/prompt/core.txt"),
    read("agent/prompt/research.txt"),
    read("session/processor.ts"),
  ])
  expect(DELEGATION_PROFILES).toEqual(["explore", "execute"])
  expect(MAX_CHILD_AGENTS).toBeGreaterThanOrEqual(2)
  expect(DELEGATION_PROFILES.filter(isComputeDelegationProfile)).toEqual(["execute"])
  expect(["biology", "ml", "physics"].some(isComputeDelegationProfile)).toBe(false)
  expect(prompt).toContain("Use as many independent workers as useful")
  expect(prompt).toContain("Delegation posture is guidance, not a quota")
  expect(prompt).toContain("Issue independent calls together")
  expect(prompt).toContain("Only the lead dispatches workers")
  expect(prompt).toContain("Children cannot")
  expect(prompt).toContain("decision-ready handoff")
  expect(core).not.toMatch(/Normal .*(?:two|2).*Task/i)
  expect(research).not.toMatch(/Ultra .*(?:four|4).*Task/i)
  expect(prompt).not.toContain("trusted")
  expect(source).toContain("durationMs")
  expect(source).toContain("failedToolCalls")
  expect(source).toContain("usage")
  expect(source).not.toContain("taskDispatchBudget")
  expect(source).not.toContain("TASK_WALL_CLOCK_MS")
  expect(source).toContain("system: childGuidance")
  expect(source).toContain("task: false")
  expect(source).toContain("delegation: false")
  expect(source).toContain("assertLeadDelegationSession")
  expect(source).not.toContain("Delegation is unavailable")
  expect(source).not.toContain("under 1,200 words")
  expect(source).toContain("Your final response is a decision-ready handoff")
  expect(source).toContain("handoff: handoff.text")
  expect(processor).not.toContain("stopped after the same")
  expect(source).not.toContain('"<system-reminder>",\n          `Research effort is')
  expect(source).not.toContain("<task_result>")
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
