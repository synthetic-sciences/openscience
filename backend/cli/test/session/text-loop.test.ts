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

  test("completed finishes never continue", () => {
    expect(MessageV2.isContinuingTurn("stop", false)).toBe(false)
    expect(MessageV2.isContinuingTurn("length", true)).toBe(false)
    expect(MessageV2.isContinuingTurn(undefined, true)).toBe(false)
  })

  test("stays consistent with isContinuing for the tool-call case", () => {
    // Compaction still uses isContinuing; the loop uses isContinuingTurn. They must
    // agree except on the text-only 'unknown' case the loop tightened.
    expect(MessageV2.isContinuing("tool-calls")).toBe(true)
    expect(MessageV2.isContinuing("unknown")).toBe(true)
  })
})
