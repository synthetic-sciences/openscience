import { Instance } from "../../src/project/instance"
import { RuntimeRuns } from "../../src/runtime/runs"

const [directory, sessionID, requestID] = process.argv.slice(2)
if (!directory || !sessionID || !requestID) throw new Error("Expected directory, sessionID, requestID")

await Instance.provide({
  directory,
  fn: async () => {
    const result = await RuntimeRuns.admit({
      sessionID,
      requestID,
      message: "Receipt fixture; do not execute",
      effort: "normal",
    })
    process.stdout.write(JSON.stringify(result))
  },
})
