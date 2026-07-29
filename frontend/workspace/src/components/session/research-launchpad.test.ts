import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { researchStarters, researchWorkflows, workflowGroups, workflowPrompt } from "./research-launchpad"

const view = () => readFileSync(fileURLToPath(new URL("./session-new-view.tsx", import.meta.url)), "utf8")

describe("research launchpad", () => {
  test("ships launch-ready workflows across the core scientific loop", () => {
    expect(researchWorkflows.map((workflow) => workflow.id)).toEqual([
      "analyze-data",
      "single-cell",
      "differential-expression",
      "inspect-structure",
      "sequence-qc",
      "variant-analysis",
      "assay-analysis",
      "image-analysis",
      "proteomics",
      "run-notebook",
      "protein-design",
      "molecular-docking",
      "molecular-dynamics",
      "train-model",
      "run-pipeline",
      "survey-literature",
      "clinical-trials",
      "target-prioritization",
      "reproduce-result",
      "compare-runs",
      "verify-citations",
      "build-figure",
      "write-report",
    ])
    expect(new Set(researchWorkflows.map((workflow) => workflow.group))).toEqual(
      new Set(["analyze", "compute", "discover", "communicate"]),
    )
  })

  test("groups workflows without losing their authored order", () => {
    expect(workflowGroups().map((group) => group.id)).toEqual(["analyze", "compute", "discover", "communicate"])
    expect(
      workflowGroups()
        .find((group) => group.id === "analyze")
        ?.workflows.map((workflow) => workflow.id),
    ).toEqual([
      "analyze-data",
      "single-cell",
      "differential-expression",
      "inspect-structure",
      "sequence-qc",
      "variant-analysis",
      "assay-analysis",
      "image-analysis",
      "proteomics",
    ])
  })

  test("adds project context to workflow prompts when artifacts are available", () => {
    const workflow = researchWorkflows[0]
    expect(workflowPrompt(workflow, 0)).toBe(workflow.prompt)
    expect(workflowPrompt(workflow, 12)).toContain("12 research artifacts")
    expect(workflowPrompt(workflow, 12)).toContain(workflow.prompt)
  })

  test("ships local-first starter projects with valid backend template ids", () => {
    expect(researchStarters.map((starter) => starter.id)).toEqual(["single-cell", "dose-response", "protein-structure"])
    expect(researchStarters.every((starter) => starter.files.length >= 2)).toBe(true)
  })

  test("keeps the first screen focused and progressively reveals the full catalog", () => {
    const source = view()

    expect(source).toContain('class="research-launchpad__quick"')
    expect(source).toContain("Browse all workflows")
    expect(source).toContain('aria-expanded={catalogOpen() ? "true" : "false"}')
    expect(source).toContain("<Show when={catalogOpen()}>")
    expect(source).not.toContain('class="research-launchpad__status"')
    expect(source).not.toContain('class="research-launchpad__starter-visual"')
  })
})
