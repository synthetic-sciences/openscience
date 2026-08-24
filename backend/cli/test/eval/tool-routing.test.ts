import { describe, expect, test } from "bun:test"
import path from "node:path"
import { validateLaunchSuite } from "../../../../evals/launch/validate"
import { ToolSelection } from "../../src/session/tool-selection"

const root = path.resolve(import.meta.dir, "../../../../evals/launch")

describe("launch evaluation tool routing", () => {
  test("preserves required capabilities without widening narrow flows", async () => {
    const result = await validateLaunchSuite(root)
    const prompts = Object.fromEntries(result.suite.flows.map((flow) => [flow.id, flow.prompt]))
    const flows = Object.fromEntries(
      result.suite.flows.filter((flow) => flow.split === "development").map((flow) => [flow.id, flow.prompt]),
    )
    const keeps = (flow: string, tool: string) =>
      ToolSelection.relevant(tool, { agent: "research", message: flows[flow] })

    expect(result.errors).toEqual([])
    expect(ToolSelection.direct({ agent: "research", message: prompts["simple-question"], fresh: true })).toBe(true)
    expect(
      result.suite.flows
        .filter((flow) => flow.id !== "simple-question")
        .every((flow) => !ToolSelection.direct({ agent: "research", message: flow.prompt, fresh: true })),
    ).toBe(true)
    expect(
      Object.values(flows).every((message) => !ToolSelection.direct({ agent: "research", message, fresh: true })),
    ).toBe(true)

    expect(keeps("citation-literature", "science_search")).toBe(true)

    expect(keeps("python-csv-report", "python")).toBe(true)
    expect(keeps("python-csv-report", "artifact")).toBe(true)
    expect(keeps("python-csv-report", "compute_job")).toBe(false)
    expect(keeps("python-csv-report", "r")).toBe(false)

    expect(keeps("folder-boundary", "read")).toBe(true)
    expect(keeps("folder-boundary", "apply_patch")).toBe(true)

    expect(keeps("denied-network-retry", "webfetch")).toBe(true)
    expect(keeps("denied-network-retry", "compute_job")).toBe(false)
    expect(keeps("denied-network-retry", "python")).toBe(false)

    expect(keeps("kdense-deliverable", "python")).toBe(true)
    expect(keeps("kdense-deliverable", "science_search")).toBe(true)
  })
})
