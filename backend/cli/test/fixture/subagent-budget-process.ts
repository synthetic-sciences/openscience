import { Instance } from "../../src/project/instance"
import { SubagentBudget } from "../../src/session/subagent-budget"

const [directory, mode, sessionID, identity, ready, gate] = process.argv.slice(2)
if (!directory || !sessionID || !identity || !ready || !gate) throw new Error("Missing budget race arguments")
await Instance.provide({
  directory,
  fn: async () => {
    await Bun.write(ready, "ready")
    while (!(await Bun.file(gate).exists())) await Bun.sleep(10)
    const result = await (
      mode === "open" || mode === "recover"
        ? SubagentBudget.open({
            rootSessionID: "root",
            parentSessionID: "root",
            sessionID,
            assignmentID: identity,
            objective: "Race admission",
            expectedOutput: "Report",
            model: { providerID: "test", modelID: "test" },
            route: "subscription",
            unit: "tokens",
            allocation: 150,
            settings: { tokens: 200 },
          })
        : SubagentBudget.reserve(sessionID, identity, 150)
    )
      .then((worker) => ({
        admitted: true,
        ...(worker ? { acceptedAt: worker.acceptedAt, deadline: worker.deadline } : {}),
      }))
      .catch((error: unknown) => {
        if (error instanceof SubagentBudget.LimitError) return { admitted: false, reason: error.reason }
        throw error
      })
    console.log(JSON.stringify(result))
  },
})
