import { describe, expect, test } from "bun:test"

const source = Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()

describe("pending questions", () => {
  test("stay actionable while the execution trace is expanded", async () => {
    const component = await source

    expect(component).not.toContain("if (props.stepsExpanded) return emptyRequestParts")
    expect(component).toContain("requestMessage() && nextQuestion()")
    expect(component).toContain("<QuestionPrompt request={question()} />")
  })

  test("renders a pending request once, outside the trace", async () => {
    const component = await source

    expect(component).toContain("pendingRequestCallID={pendingRequestCallID()}")
    expect(component).toContain("part.callID === props.pendingRequestCallID")
    expect(component).not.toContain('data-slot="session-turn-collapsible-content-inner" aria-hidden={working()}')
  })
})
