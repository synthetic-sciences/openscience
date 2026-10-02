import { describe, expect, test } from "bun:test"
import { SessionLoopState } from "../../src/session/loop-state"
import type { MessageV2 } from "../../src/session/message-v2"

function text(id: string, value: string) {
  return {
    id: `${id}_part`,
    messageID: id,
    sessionID: "ses_test",
    type: "text" as const,
    text: value,
  }
}

function user(id: string, parts: MessageV2.Part[]): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "ses_test",
      role: "user",
      time: { created: 1 },
      agent: "research",
      model: { providerID: "test", modelID: "test" },
      effort: "normal",
    },
    parts,
  }
}

describe("externalPrompts window bounds", () => {
  const history = [
    user("u0", [text("u0", "first request about SMA actuators")]),
    user("u1", [text("u1", "now analyse the resistance data")]),
  ]

  test("a limit of zero returns no prompts", () => {
    expect(SessionLoopState.externalPrompts(history, 0)).toBe("")
  })

  test("a tail of zero returns no prompt text", () => {
    expect(SessionLoopState.externalPrompts(history, 4, 0)).toBe("")
  })

  test("the defaults are unchanged", () => {
    expect(SessionLoopState.externalPrompts(history)).toBe(
      "first request about SMA actuators\nnow analyse the resistance data",
    )
  })
})
