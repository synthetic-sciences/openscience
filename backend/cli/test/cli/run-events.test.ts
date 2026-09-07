import { describe, expect, test } from "bun:test"
import { claimToolPartEmission } from "../../src/cli/cmd/run"
import type { MessageV2 } from "../../src/session/message-v2"

function part(id: string, status: "completed" | "error", compacted?: number): MessageV2.ToolPart {
  return {
    id,
    type: "tool",
    tool: "bash",
    callID: `call_${id}`,
    messageID: "msg_1",
    sessionID: "ses_run",
    state: {
      status,
      input: {},
      ...(status === "completed" ? { output: "", title: "", metadata: {} } : { error: "boom" }),
      time: { start: 1, end: 2, ...(compacted ? { compacted } : {}) },
    },
  } as unknown as MessageV2.ToolPart
}

describe("run --format json tool_use emission", () => {
  test("emits a terminal tool part once and ignores its compacted republish", () => {
    const emitted = new Set<string>()
    expect(claimToolPartEmission(emitted, part("prt_1", "completed"))).toBe(true)
    // Context pruning republishes the same part with a compacted stamp.
    expect(claimToolPartEmission(emitted, part("prt_1", "completed", 3))).toBe(false)
    // Any later update of an already emitted part is not a new tool call.
    expect(claimToolPartEmission(emitted, part("prt_1", "completed"))).toBe(false)
  })

  test("a compacted part that was never emitted in this run is still not a new tool call", () => {
    const emitted = new Set<string>()
    expect(claimToolPartEmission(emitted, part("prt_old", "completed", 3))).toBe(false)
    expect(emitted.size).toBe(0)
  })

  test("errored parts are emitted once as well", () => {
    const emitted = new Set<string>()
    expect(claimToolPartEmission(emitted, part("prt_2", "error"))).toBe(true)
    expect(claimToolPartEmission(emitted, part("prt_2", "error"))).toBe(false)
  })
})
