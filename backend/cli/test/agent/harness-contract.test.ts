import { expect, test } from "bun:test"
import { SystemPrompt } from "../../src/session/system"
import {
  DELEGATION_PROFILES,
  MAX_CHILD_AGENTS,
  NORMAL_CHILD_AGENTS,
  TASK_WALL_CLOCK_MS,
  isComputeDelegationProfile,
} from "../../src/tool/task"

const root = new URL("../../src/", import.meta.url)
const read = (path: string) => Bun.file(new URL(path, root)).text()
const webFetchFolderDownload = 'output_path:"foo.pdf"'
const webFetchFolderMove = "mkdir -p -- 'papers' && test ! -e 'papers/foo.pdf' && mv -- 'foo.pdf' 'papers/foo.pdf'"

test("every WebFetch instruction teaches one root-download then sandboxed-move sequence", async () => {
  const prompts = await Promise.all([
    read("session/prompt/core.txt"),
    read("agent/prompt/research.txt"),
    read("tool/task.txt"),
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

test("every provider receives one compact product operating contract", () => {
  const instructions = SystemPrompt.instructions()
  expect(SystemPrompt.provider(undefined as never)[0]?.trim()).toBe(instructions)
  expect(instructions.length).toBeLessThan(4_000)
  expect(instructions).toContain("Keep simple work simple")
  expect(instructions).toContain("Atlas is optional")
  expect(instructions).toContain("default to zero children")
  expect(instructions).toContain("Explore, Execute, or Review")
  expect(instructions).toContain("large or binary scientific data")
  expect(instructions).toContain("output_path")
  expect(instructions).not.toContain("data once with Shell")
  expect(instructions).toContain("immutable release")
  expect(instructions).not.toContain("shared keys")
  expect(instructions).not.toContain("project init")
})

test("the primary and domain prompts stay adaptive instead of procedural", async () => {
  const [research, ml, biology, physics] = await Promise.all([
    read("agent/prompt/research.txt"),
    read("agent/prompt/ml.txt"),
    read("agent/prompt/biology.txt"),
    read("agent/prompt/physics.txt"),
  ])
  for (const prompt of [research, ml, biology, physics]) {
    expect(prompt.length).toBeLessThan(4_000)
    expect(prompt).not.toContain("literature-review.md")
    expect(prompt).not.toContain("reasoning.md")
    expect(prompt).not.toContain("methodology.md")
    expect(prompt).not.toContain("Create/link the graph")
  }
  expect(research).toContain("Answer a direct question directly")
  expect(research).toContain("Default to zero children")
  expect(research).toContain("Atlas is optional")
  expect(research).toContain("lazy skills")
  expect(research).toContain("bounded pages")
  expect(research).toContain("claim/evidence matrix")
  expect(research).toContain("output_path")
  expect(research).toContain("optional binaries as capabilities")
  expect(research).toContain("never\n  convert failed candidates to NaN")
  expect(research).toContain("without a filtering pipeline")
  expect(research).not.toContain("data once to the workspace with Shell")
  expect(research).toContain("immutable data release")
  expect(ml).toContain("simplest method")
  expect(biology).toContain("multiple testing")
  expect(physics).toContain("dimensional consistency")
})

test("delegation is rare, bounded, and observable", async () => {
  const [prompt, source] = await Promise.all([read("tool/task.txt"), read("tool/task.ts")])
  expect(DELEGATION_PROFILES).toEqual(["explore", "execute", "review"])
  expect(NORMAL_CHILD_AGENTS).toBe(2)
  expect(MAX_CHILD_AGENTS).toBe(4)
  expect(TASK_WALL_CLOCK_MS).toEqual({ normal: 600_000, ultra: 1_200_000 })
  expect(DELEGATION_PROFILES.filter(isComputeDelegationProfile)).toEqual(["execute"])
  expect(["biology", "ml", "physics"].some(isComputeDelegationProfile)).toBe(false)
  expect(prompt).toContain("default to zero children")
  expect(prompt).toContain("at most two")
  expect(prompt).toContain("at most four")
  expect(prompt).toContain("Task calls total per user turn")
  expect(prompt).toContain("large or binary scientific data")
  expect(prompt).toContain("output_path")
  expect(prompt).not.toContain("data once to the workspace with Shell")
  expect(prompt).toContain("immutable release")
  expect(prompt).toContain("failed child")
  expect(prompt).not.toContain("trusted")
  expect(source).toContain("durationMs")
  expect(source).toContain("failedToolCalls")
  expect(source).toContain("usage")
  expect(source).toContain("taskDispatchBudget")
  expect(source).not.toContain("<task_result>")
})

test("Plan and Review use the observable record without mandatory delegation", async () => {
  const [plan, reviewer] = await Promise.all([read("session/prompt/plan.txt"), read("agent/prompt/reviewer.txt")])
  expect(plan).toContain("Default to no child")
  expect(plan).not.toContain("Launch up to 3")
  expect(plan).not.toContain("mandatory")
  expect(reviewer).toContain("INCOMPLETE RECORD")
  expect(reviewer).toContain("METHOD/CONCLUSION MISMATCH")
  expect(reviewer).toContain("Environment or dependency gaps")
})
