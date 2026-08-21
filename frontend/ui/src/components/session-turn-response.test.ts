import { expect, test } from "bun:test"
import type { TextPart } from "@synsci/sdk/v2/client"
import { lastResponseTextPart } from "./session-turn-response"

const text = (id: string, value: string, synthetic = false): TextPart => ({
  id,
  messageID: "msg_test",
  sessionID: "ses_test",
  type: "text",
  text: value,
  synthetic,
})

test("synthetic notices never replace the assistant's final response", () => {
  const response = text("prt_response", "Verified outcome")
  const notice = text("prt_notice", "Incomplete research contract", true)

  expect(lastResponseTextPart([response, notice])).toEqual(response)
  expect(lastResponseTextPart([notice])).toBeUndefined()
})
