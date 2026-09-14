import { describe, expect, test } from "bun:test"
import type { Message, Part, UserMessage } from "@synsci/sdk/v2"
import { isContinuationCarrier, turnOpener } from "./session-turn-carrier"

const user = (id: string, internal?: UserMessage["internal"]): UserMessage => ({
  id,
  sessionID: "ses_c",
  role: "user",
  time: { created: 1 },
  agent: "research",
  model: { providerID: "test", modelID: "test" },
  internal,
})
const text = (messageID: string, value: string, synthetic?: boolean): Part => ({
  id: `prt_${messageID}`,
  sessionID: "ses_c",
  messageID,
  type: "text",
  text: value,
  synthetic,
})

describe("continuation carriers", () => {
  test("harness continuations and worker wake-ups are carriers; typed requests, shell commands and compactions are not", () => {
    const typed = user("msg_typed", { type: "prompt", epoch: "msg_typed" })
    expect(isContinuationCarrier(typed, [text("msg_typed", "Fit the model.")])).toBe(false)
    const harness = user("msg_h", {
      type: "continuation",
      kind: "harness",
      text: "Diagnose the root cause.",
      epoch: "msg_typed",
      transaction: "msg_h",
    })
    expect(isContinuationCarrier(harness, [text("msg_h", "Diagnose the root cause.", true)])).toBe(true)
    const wake = user("msg_w", { type: "prompt", epoch: "msg_w" })
    expect(
      isContinuationCarrier(wake, [
        text("msg_w", '<task id="ses_child" state="completed">\n<task_result>done</task_result>\n</task>', true),
        text("msg_w", "", true),
      ]),
    ).toBe(true)
    const shell = user("msg_s")
    expect(isContinuationCarrier(shell, [text("msg_s", "The following tool was executed by the user", true)])).toBe(
      false,
    )
    const compaction = user("msg_k", { type: "compaction", auto: true, epoch: "msg_typed", transaction: "msg_k" })
    expect(isContinuationCarrier(compaction, [text("msg_k", "", true)])).toBe(false)
    expect(isContinuationCarrier(wake, [])).toBe(false)
    expect(isContinuationCarrier(wake, undefined)).toBe(false)
  })

  test("a carrier belongs to the nearest earlier turn the user opened", () => {
    const opener = user("msg_1", { type: "prompt", epoch: "msg_1" })
    const wake = user("msg_3", { type: "prompt", epoch: "msg_3" })
    const messages: Message[] = [opener, wake]
    const parts = (id: string) =>
      id === wake.id ? [text(wake.id, '<task id="ses_x" state="completed"></task>', true)] : [text(id, "Go.")]
    expect(turnOpener(messages, 1, parts)?.id).toBe("msg_1")
    expect(turnOpener(messages, 0, parts)?.id).toBe("msg_1")
    expect(turnOpener([wake], 0, parts)).toBeUndefined()
  })
})
