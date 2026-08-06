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
const styles = () => readFileSync(fileURLToPath(new URL("../../styles/atlas.css", import.meta.url)), "utf8")
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
const [subject, launchpad, web] = await Promise.all([
  server.ssrLoadModule("/src/components/session/session-new-view.tsx") as Promise<typeof import("./session-new-view")>,
  server.ssrLoadModule("/src/components/session/research-launchpad.ts") as Promise<
    typeof import("./research-launchpad")
  >,
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

    expect(source).toContain('class="research-launchpad__bar"')
    expect(source).toContain('aria-label="Research starters"')
    expect(source).not.toContain(">New research</span>")
    expect(source).toContain("<span>Starters</span>")
    expect(source).not.toContain("What will you investigate?")
    expect(source).not.toContain('aria-label="Starting suggestions"')
    expect(source).not.toContain("props.suggestions.slice")
    expect(source).not.toContain('class="research-launchpad__loop"')
    expect(source).not.toContain('aria-label="Research loop"')
    expect(source).not.toContain('class="research-launchpad__footer"')
    expect(source).not.toContain("Local compute")
    expect(source).not.toContain("Remote compute")
    expect(source).not.toContain("models.list().length.toLocaleString()")
    expect(source).toContain("<Show when={catalogOpen()}>")
    expect(source).toContain("setCatalogOpen(false)")
  })

  test("gives the empty session a compact work-tab scale", () => {
    const css = styles()

    expect(css).toContain("/* Claude Science forensic reset */")
    expect(css).toContain(".research-launchpad__bar")
    expect(css).toContain("padding: 18px 20px")
    expect(css).toContain("font-size: 15px")
    const reset = css.slice(css.indexOf("/* Claude Science forensic reset */"))
    expect(reset).not.toContain("radial-gradient(")
  })

  test("keeps the expanded catalog readable above the floating composer", () => {
    const css = styles()
    const source = view()
    const start = css.indexOf("/* Readable expanded research catalog */")
    const end = css.indexOf("/* Final readable compute control room */", start)
    const catalog = css.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(source).not.toContain("Starter workspace")
    expect(source).not.toContain("working tree")
    expect(catalog).toContain(".research-launchpad__catalog .research-launchpad__starter-copy small")
    expect(catalog).toContain(".research-launchpad__catalog .research-launchpad__workflow-filters button span")
    expect(catalog).toContain(".research-launchpad__catalog .research-launchpad__workflow-copy > span")
    expect(catalog).toContain("min-height: 44px")
    expect(catalog).toContain("border-radius: 16px")
    expect(catalog).toContain("@media (max-width: 720px)")
    expect(catalog).toContain("calc(var(--workspace-composer-reserve) + 20px)")
    expect(catalog).not.toMatch(/font-size:\s*(?:[7-9]|1[01](?:\.\d+)?)px/)
    expect(catalog).not.toContain("text-transform: uppercase")
  })

  test("mounts an empty default canvas and reveals deeper research actions on demand", async () => {
    expect(subject.NewSessionCanvas).toBeFunction()

    const grid = document.createElement("div")
    grid.className = "research-launchpad__grid"
    grid.textContent = "Full workflow library"
    const host = mount(() =>
      subject.NewSessionCanvas({
        children: grid,
      }),
    )

    expect(host.querySelector("h1")).toBeNull()
    expect(host.querySelector(".research-launchpad__bar")?.textContent).toContain("Starters")
    expect(host.querySelectorAll("[data-suggestion]")).toHaveLength(0)
    expect(host.querySelector(".research-launchpad__loop")).toBeNull()
    expect(host.querySelector(".research-launchpad__grid")).toBeNull()
    expect(host.querySelector(".research-launchpad__footer")).toBeNull()
    expect(host.textContent).not.toContain("Local compute")
    expect(host.textContent).not.toContain("models")
    expect(host.querySelector('[data-action="setup-model"]')).toBeNull()

    const browse = host.querySelector<HTMLButtonElement>('[data-action="browse-research"]')
    expect(browse?.getAttribute("aria-expanded")).toBe("false")
    browse?.click()
    await Promise.resolve()
    expect(browse?.getAttribute("aria-expanded")).toBe("true")
    expect(host.querySelector(".research-launchpad__grid")).not.toBeNull()
  })
})
