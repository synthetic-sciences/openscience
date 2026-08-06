import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import {
  researchStarters,
  researchSuggestions,
  researchWorkflows,
  workflowGroups,
  workflowPrompt,
} from "./research-launchpad"

const view = () => readFileSync(fileURLToPath(new URL("./session-new-view.tsx", import.meta.url)), "utf8")
const server = await createServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: {
    noExternal: true,
    resolve: { conditions: ["browser", "production"] },
  },
})
const [subject, web] = await Promise.all([
  server.ssrLoadModule("/src/components/session/session-new-view.tsx") as Promise<typeof import("./session-new-view")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: Array<() => void> = []

afterAll(() => server.close())

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

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

  test("keeps the default suggestions quiet and decision-relevant", () => {
    expect(researchSuggestions.map((workflow) => workflow.id)).toEqual([
      "analyze-data",
      "run-notebook",
      "survey-literature",
    ])
  })

  test("keeps the default session empty instead of presenting a landing page", () => {
    const source = view()

    expect(source).toContain('aria-label="New research session"')
    expect(source).not.toContain("Starters")
    expect(source).not.toContain("catalogOpen")
    expect(source).not.toContain("/file/starters")
    expect(source).not.toContain("researchWorkflows")
  })

  test("mounts a genuinely blank new-session canvas", () => {
    expect(subject.NewSessionView).toBeFunction()

    const host = mount(() => subject.NewSessionView())
    const canvas = host.querySelector('[data-component="research-launchpad"]')
    expect(canvas?.getAttribute("aria-label")).toBe("New research session")
    expect(host.querySelectorAll("button")).toHaveLength(0)
    expect(host.querySelectorAll("h1, h2, h3")).toHaveLength(0)
    expect(host.textContent).toBe("")
  })
})
