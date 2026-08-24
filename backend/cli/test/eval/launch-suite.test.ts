import { describe, expect, test } from "bun:test"
import path from "node:path"
import { validateLaunchSuite } from "../../../../evals/launch/validate"

const root = path.resolve(import.meta.dir, "../../../../evals/launch")

describe("launch evaluation suite", () => {
  test("is frozen, complete, and hash locked", async () => {
    const result = await validateLaunchSuite(root)

    expect(result.errors).toEqual([])
    expect(result.suite.flows).toHaveLength(9)
    expect(result.suite.flows.filter((flow) => flow.split === "development")).toHaveLength(5)
    expect(result.suite.flows.filter((flow) => flow.split === "held_out")).toHaveLength(4)
    expect(result.rubric.releaseRule).toEqual({
      cleanLocalRuns: 3,
      requiresExplicitApproval: true,
    })
  })
})
