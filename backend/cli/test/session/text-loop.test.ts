import { describe, expect, test } from "bun:test"
import { SessionProcessor } from "../../src/session/processor"
import { MessageV2 } from "../../src/session/message-v2"

// The "continuity summary" a weak/local model repeats verbatim instead of
// finishing (#176). ~460 chars so it clears the minLen gate.
const CONTINUITY = (
  "comprehensive summary for continuity in a new session. objective: find 3-5 recent papers on " +
  "sensorless position control of sma (nitinol) actuators via resistance feedback. what was done: " +
  "queried openalex, arxiv, and crossref; collected five relevant results including a directly " +
  "relevant 2020 paper. next: paste this summary into a new session and continue from the search " +
  "results already gathered above to produce the final literature review deliverable."
).toLowerCase()

describe("SessionProcessor.isTextLoop", () => {
  test("fires on 3 identical substantial continuity-summary turns", () => {
    expect(SessionProcessor.isTextLoop([CONTINUITY, CONTINUITY, CONTINUITY])).toBe(true)
  })

  test("fires when only the trailing detail varies but the long preamble repeats", () => {
    const a = CONTINUITY + " attempt one."
    const b = CONTINUITY + " attempt two."
    const c = CONTINUITY + " attempt three."
    expect(SessionProcessor.isTextLoop([a, b, c])).toBe(true)
  })

  test("only the last 3 turns matter — earlier distinct progress is ignored", () => {
    expect(
      SessionProcessor.isTextLoop(["scoping the question", "reading a paper", CONTINUITY, CONTINUITY, CONTINUITY]),
    ).toBe(true)
  })

  test("does not fire below 3 turns", () => {
    expect(SessionProcessor.isTextLoop([CONTINUITY, CONTINUITY])).toBe(false)
  })

  test("does not fire on short turns (real progress is usually terse)", () => {
    expect(SessionProcessor.isTextLoop(["searching openalex", "searching arxiv", "searching crossref"])).toBe(false)
  })

  test("does not fire when the three turns share no long prefix", () => {
    const a = "a".repeat(500)
    const b = "b".repeat(500)
    const c = "c".repeat(500)
    expect(SessionProcessor.isTextLoop([a, b, c])).toBe(false)
  })

  test("does not fire when lengths diverge sharply despite a shared prefix", () => {
    const short = CONTINUITY // ~460
    const long = CONTINUITY + "x".repeat(2000) // >1.25x longer
    expect(SessionProcessor.isTextLoop([short, short, long])).toBe(false)
  })

  test("does not fire on 3 distinct long paragraphs of genuine work", () => {
    const p1 = "found paper: sensorless sma control via self-sensing resistance, ieee 2021. ".repeat(8)
    const p2 = "found paper: nitinol actuator hysteresis compensation with kalman filtering, 2019. ".repeat(8)
    const p3 = "found paper: resistance-feedback position estimation for shape memory alloys, 2023. ".repeat(8)
    expect(SessionProcessor.isTextLoop([p1, p2, p3])).toBe(false)
  })
})

describe("MessageV2.isContinuingTurn", () => {
  test("'tool-calls' always continues (there is a tool result to feed back)", () => {
    expect(MessageV2.isContinuingTurn("tool-calls", true)).toBe(true)
    expect(MessageV2.isContinuingTurn("tool-calls", false)).toBe(true)
  })

  test("'unknown' continues ONLY when the turn made a tool call", () => {
    expect(MessageV2.isContinuingTurn("unknown", true)).toBe(true)
    // The #176 fix: a text-only 'unknown' turn is a completed turn, not a continue.
    expect(MessageV2.isContinuingTurn("unknown", false)).toBe(false)
  })

  test("stop continues only for a settled local result", () => {
    expect(MessageV2.isContinuingTurn("stop", true)).toBe(true)
    expect(MessageV2.isContinuingTurn("stop", false)).toBe(false)
  })

  test("terminal limits and errors never continue", () => {
    expect(MessageV2.isContinuingTurn("stop", false)).toBe(false)
    expect(MessageV2.isContinuingTurn("length", true)).toBe(false)
    expect(MessageV2.isContinuingTurn("max-steps", true)).toBe(false)
    expect(MessageV2.isContinuingTurn("content-filter", true)).toBe(false)
    expect(MessageV2.isContinuingTurn("error", true)).toBe(false)
    expect(MessageV2.isContinuingTurn(undefined, true)).toBe(false)
  })

  test("stays consistent with isContinuing for the tool-call case", () => {
    // Compaction still uses isContinuing; the loop uses isContinuingTurn. They must
    // preserve the established tool-call continuation case.
    expect(MessageV2.isContinuing("tool-calls")).toBe(true)
    expect(MessageV2.isContinuing("unknown")).toBe(true)
  })
})

describe("MessageV2.outputRecovery", () => {
  test("continues a truncated active task without an artificial attempt ceiling while it makes progress", () => {
    expect(MessageV2.outputRecovery({ finish: "length", unanswered: true, bare: false, stalled: 0 })).toBe("continue")
    expect(MessageV2.outputRecovery({ finish: "length", unanswered: true, bare: false, stalled: 1 })).toBe("continue")
  })

  test("stops after two consecutive continuations that made no progress", () => {
    expect(MessageV2.OUTPUT_STALL_LIMIT).toBe(2)
    expect(MessageV2.outputRecovery({ finish: "length", unanswered: true, bare: false, stalled: 2 })).toBe("fail")
    expect(MessageV2.outputRecovery({ finish: "length", unanswered: true, bare: false, stalled: 5 })).toBe("fail")
  })

  test("does not resume completed, answered, or bare turns", () => {
    expect(MessageV2.outputRecovery({ finish: "stop", unanswered: true, bare: false, stalled: 0 })).toBe("none")
    expect(MessageV2.outputRecovery({ finish: "length", unanswered: false, bare: false, stalled: 0 })).toBe("none")
    expect(MessageV2.outputRecovery({ finish: "length", unanswered: true, bare: true, stalled: 0 })).toBe("none")
    expect(MessageV2.outputRecovery({ finish: "length", unanswered: true, bare: true, stalled: 2 })).toBe("none")
  })
})

type FixturePart =
  | { text: string; synthetic?: boolean; ignored?: boolean }
  | { tool: "completed" | "pending"; providerExecuted?: boolean }

function turn(
  id: string,
  finish: string | undefined,
  parts: FixturePart[],
  extra?: { summary?: boolean; error?: boolean },
): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "ses_fixture",
      role: "assistant",
      parentID: "msg_user",
      finish,
      summary: extra?.summary,
      error: extra?.error ? { name: "UnknownError", data: { message: "stopped" } } : undefined,
    },
    parts: parts.map((part, index) => {
      const base = { id: `${id}_${index}`, sessionID: "ses_fixture", messageID: id }
      if ("text" in part)
        return { ...base, type: "text", text: part.text, synthetic: part.synthetic, ignored: part.ignored }
      return {
        ...base,
        type: "tool",
        tool: "write",
        callID: `call_${id}_${index}`,
        metadata: part.providerExecuted ? { providerExecuted: true } : undefined,
        state:
          part.tool === "completed"
            ? { status: "completed", input: {}, output: "ok", title: "write", metadata: {}, time: { start: 1, end: 2 } }
            : { status: "pending", input: {}, raw: "" },
      }
    }),
  } as unknown as MessageV2.WithParts
}

describe("SessionProcessor.outputStall", () => {
  const chunk = (index: number) => `chapter ${index}: ` + "distinct prose about the build. ".repeat(20)
  const replay = "the same truncated preamble that never changes. ".repeat(12)

  test("the first truncation always earns a continuation", () => {
    expect(SessionProcessor.outputStall([turn("a1", "length", [{ text: chunk(1) }])])).toBe(0)
    expect(SessionProcessor.outputStall([turn("a1", "length", [])])).toBe(0)
  })

  test("continuations that add text or complete a local tool never stall, however many there are", () => {
    const chunks = Array.from({ length: 200 }, (_, index) => turn(`a${index}`, "length", [{ text: chunk(index) }]))
    expect(SessionProcessor.outputStall(chunks)).toBe(0)
    expect(
      SessionProcessor.outputStall([
        turn("a1", "length", [{ text: replay }]),
        turn("a2", "length", [{ tool: "completed" }]),
        turn("a3", "length", [{ text: replay }]),
      ]),
    ).toBe(0)
  })

  test("counts consecutive continuations that only replay the previous truncated output", () => {
    const turns = [
      turn("a1", "length", [{ text: replay }]),
      turn("a2", "length", [{ text: replay }]),
      turn("a3", "length", [{ text: `${replay} with a different tail` }]),
    ]
    expect(SessionProcessor.outputStall(turns.slice(0, 2))).toBe(1)
    expect(SessionProcessor.outputStall(turns)).toBe(2)
  })

  test("a write larger than the output cap leaves neither text nor a completed local tool", () => {
    const turns = [
      turn("a1", "length", [{ tool: "pending" }]),
      turn("a2", "length", [{ tool: "pending" }]),
      turn("a3", "length", [{ tool: "completed", providerExecuted: true }]),
    ]
    expect(SessionProcessor.outputStall(turns)).toBe(2)
  })

  test("any other finish ends the chain and a later truncation starts over", () => {
    const turns = [
      turn("a1", "length", []),
      turn("a2", "length", []),
      turn("a3", "tool-calls", [{ tool: "completed" }]),
      turn("a4", "length", []),
      turn("a5", "length", []),
    ]
    expect(SessionProcessor.outputStall(turns)).toBe(1)
  })

  test("ignores compaction summaries and unfinished error records", () => {
    const turns = [
      turn("a1", "length", []),
      turn("a2", undefined, [], { error: true }),
      turn("a3", "stop", [{ text: "summary" }], { summary: true }),
      turn("a4", "length", []),
    ]
    expect(SessionProcessor.outputStall(turns)).toBe(1)
  })
})

describe("SessionProcessor.turnText", () => {
  test("normalizes visible text and drops synthetic or hidden parts", () => {
    const value = turn("a1", "stop", [
      { text: "  Found   THREE papers\n" },
      { text: "continue", synthetic: true },
      { text: "hidden", ignored: true },
      { text: "on SMA actuators" },
    ])
    expect(SessionProcessor.turnText(value)).toBe("found three papers on sma actuators")
  })
})

describe("SessionProcessor.convergenceWindow", () => {
  test("keeps finished, non-summary turns recorded after the last trip", () => {
    const turns = [
      turn("a1", "stop", [{ text: "one" }]),
      turn("a2", "stop", [{ text: "two" }]),
      turn("a3", undefined, [], { error: true }),
      turn("a4", "stop", [{ text: "summary" }], { summary: true }),
      turn("a5", undefined, [{ text: "still streaming" }]),
      turn("a6", "stop", [{ text: "three" }]),
    ]
    expect(SessionProcessor.convergenceWindow(turns).map((item) => item.info.id)).toEqual(["a6"])
    expect(SessionProcessor.convergenceWindow(turns.slice(0, 2)).map((item) => item.info.id)).toEqual(["a1", "a2"])
  })

  test("a recorded trip cannot re-fire on the same three turns", () => {
    const repeated = [
      turn("a1", "stop", [{ text: CONTINUITY }]),
      turn("a2", "stop", [{ text: CONTINUITY }]),
      turn("a3", "stop", [{ text: CONTINUITY }]),
    ]
    const texts = (turns: MessageV2.WithParts[]) =>
      SessionProcessor.convergenceWindow(turns).map(SessionProcessor.turnText)
    expect(SessionProcessor.isTextLoop(texts(repeated))).toBe(true)
    expect(SessionProcessor.isTextLoop(texts([...repeated, turn("a4", undefined, [], { error: true })]))).toBe(false)
  })
})

describe("MessageV2.hasLocalToolResult", () => {
  const tool = (state: MessageV2.ToolPart["state"], metadata?: MessageV2.ToolPart["metadata"]): MessageV2.ToolPart => ({
    id: "prt_fixture",
    sessionID: "ses_fixture",
    messageID: "msg_fixture",
    type: "tool",
    tool: "fixture",
    callID: "call_fixture",
    state,
    metadata,
  })
  const completed: MessageV2.ToolStateCompleted = {
    status: "completed",
    input: {},
    output: "RESULT",
    title: "fixture",
    metadata: {},
    time: { start: 1, end: 2 },
  }
  const failed: MessageV2.ToolStateError = {
    status: "error",
    input: {},
    error: "File not found",
    time: { start: 1, end: 2 },
  }

  test("normal success and tool failure both need interpretation", () => {
    expect(MessageV2.hasLocalToolResult([tool(completed)])).toBe(true)
    expect(MessageV2.hasLocalToolResult([tool(failed)])).toBe(true)
  })

  test("provider-executed tools never force another turn", () => {
    expect(MessageV2.hasLocalToolResult([tool(completed, { providerExecuted: true })])).toBe(false)
    expect(MessageV2.hasLocalToolResult([tool(failed, { providerExecuted: true })])).toBe(false)
  })

  test("unsettled or cleanup-interrupted wrappers never force another turn", () => {
    for (const state of [
      { status: "pending" as const, input: {}, raw: "" },
      { status: "running" as const, input: {}, time: { start: 1 } },
      { ...failed, metadata: { cancelled: true } },
      { ...failed, metadata: { interrupted: true } },
      {
        ...failed,
        error:
          "Tool execution was interrupted before completion. Its side effects may have completed; inspect the current state before retrying.",
      },
    ])
      expect(MessageV2.hasLocalToolResult([tool(state)])).toBe(false)
  })
})
