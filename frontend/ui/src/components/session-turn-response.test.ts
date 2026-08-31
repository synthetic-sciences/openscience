import { expect, test } from "bun:test"
import type { Part, TextPart } from "@synsci/sdk/v2/client"
import { lastResponseTextPart, responseText } from "./session-turn-response"

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

test("response copy includes every visible prose part in trace order", () => {
  const parts: Part[] = [
    text("first", "  # Phase one\n\nKeep **Markdown** intact.  "),
    { ...text("reason", "Do not copy reasoning"), type: "reasoning", time: { start: 0 } },
    text("second", "## Phase two\n\n- Run the check"),
    text("notice", "Do not copy the synthetic notice", true),
    text("empty", " \n "),
  ]
  expect(responseText(parts)).toBe("  # Phase one\n\nKeep **Markdown** intact.  \n\n## Phase two\n\n- Run the check")
})

test("streaming duplicate updates retain their first chronological position", () => {
  const parts = [text("first", "Draft"), text("second", "Next section"), text("first", "Final first section")]
  expect(responseText(parts)).toBe("Final first section\n\nNext section")
  expect(responseText([...parts, text("first", "Hidden replacement", true)])).toBe("Next section")
})

test("copy preserves original absolute links and indentation, not display-only path shortening", () => {
  const source = "    indented_code()\n\n[Plan](/research/project/PLAN.md)\n\n```text\n  evidence\n```\n"
  expect(responseText([text("file", source)])).toBe(source)
  expect(responseText([text("empty", " \n"), text("notice", "Only notice", true)])).toBe("")
})
