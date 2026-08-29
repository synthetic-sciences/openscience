import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test"
import { z } from "zod"
import { QuestionTool } from "../../src/tool/question"
import * as QuestionModule from "../../src/question"

const ctx = {
  sessionID: "test-session",
  messageID: "test-message",
  callID: "test-call",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

const decision = {
  question: "Which implementation should we use?",
  header: "Approach",
  options: [
    { label: "Safe path (Recommended)", description: "Use the reversible implementation" },
    { label: "Risky path", description: "Expand scope and accept more risk" },
  ],
}

describe("tool.question", () => {
  let askSpy: any

  beforeEach(() => {
    askSpy = spyOn(QuestionModule.Question, "ask").mockImplementation(async () => {
      return []
    })
  })

  afterEach(() => {
    askSpy.mockRestore()
  })

  test("should successfully execute with valid question parameters", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "What is your favorite color?",
        header: "Color",
        options: [
          { label: "Red (Recommended)", description: "The color of passion" },
          { label: "Blue", description: "The color of sky" },
        ],
        multiple: false,
      },
    ]

    askSpy.mockResolvedValueOnce([["Red"]])

    const result = await tool.execute({ reason: "consequential", questions }, ctx)
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(result.title).toBe("Asked 1 question")
  })

  test("should now pass with a header longer than 12 but less than 30 chars", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "What is your favorite animal?",
        header: "This Header is Over 12",
        options: [
          { label: "Dog (Recommended)", description: "Man's best friend" },
          { label: "Cat", description: "An independent companion" },
        ],
      },
    ]

    askSpy.mockResolvedValueOnce([["Dog"]])

    const result = await tool.execute({ reason: "consequential", questions }, ctx)
    expect(result.output).toContain(`"What is your favorite animal?"="Dog"`)
  })

  test("Interactive permits collaborative planning with a recommended first option", async () => {
    const tool = await QuestionTool.init()
    askSpy.mockResolvedValueOnce([["Safe path (Recommended)"]])

    const result = await tool.execute(
      { reason: "planning", questions: [decision] },
      { ...ctx, extra: { delegationSettings: { level: "standard", autonomy: "interactive" } } },
    )

    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(result.metadata).toMatchObject({ autonomy: "interactive", reason: "planning" })
  })

  test("Balanced decides routine planning but still permits consequential questions", async () => {
    const tool = await QuestionTool.init()
    const balanced = { ...ctx, extra: { delegationSettings: { level: "standard", autonomy: "balanced" } } }

    const routine = await tool.execute({ reason: "planning", questions: [decision] }, balanced)
    expect(askSpy).not.toHaveBeenCalled()
    expect(routine.output).toContain(
      'Assumption recorded: "Which implementation should we use?"="Safe path (Recommended)"',
    )
    expect(routine.metadata).toMatchObject({
      autonomy: "balanced",
      reason: "planning",
      resolution: "recommended",
      assumptions: [{ selection: "Safe path (Recommended)" }],
    })

    askSpy.mockResolvedValueOnce([["Safe path (Recommended)"]])
    const consequential = await tool.execute({ reason: "consequential", questions: [decision] }, balanced)
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(consequential.metadata).toMatchObject({ resolution: "user" })
  })

  test("Independent makes the recommended call unless authority is genuinely missing", async () => {
    const tool = await QuestionTool.init()
    const independent = { ...ctx, extra: { delegationSettings: { level: "standard", autonomy: "autonomous" } } }

    const choice = await tool.execute({ reason: "consequential", questions: [decision] }, independent)
    expect(askSpy).not.toHaveBeenCalled()
    expect(choice.output).toContain(
      'Assumption recorded: "Which implementation should we use?"="Safe path (Recommended)"',
    )
    expect(choice.metadata).toMatchObject({
      autonomy: "autonomous",
      reason: "consequential",
      resolution: "recommended",
      assumptions: [{ selection: "Safe path (Recommended)" }],
    })

    askSpy.mockResolvedValueOnce([["Provide access"]])
    const result = await tool.execute(
      {
        reason: "missing_authority",
        questions: [
          {
            question: "Please provide the authority required to continue.",
            header: "Authority",
            options: [{ label: "Provide access", description: "Grant the required authority" }],
          },
        ],
      },
      independent,
    )
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(result.metadata).toMatchObject({
      autonomy: "autonomous",
      reason: "missing_authority",
      resolution: "user",
    })
  })

  test("planning and consequential choices fail closed without a recommendation", async () => {
    const tool = await QuestionTool.init()
    await expect(
      tool.execute(
        {
          reason: "consequential",
          questions: [{ ...decision, options: decision.options.map((option) => ({ ...option, label: "Option" })) }],
        },
        ctx,
      ),
    ).rejects.toThrow("recommended choice first")
    expect(askSpy).not.toHaveBeenCalled()
  })

  // intentionally removed the zod validation due to tool call errors, hoping prompting is gonna be good enough
  //   test("should throw an Error for header exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "What is your favorite animal?",
  //         header: "This Header is Definitely More Than Thirty Characters Long",
  //         options: [{ label: "Dog", description: "Man's best friend" }],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })

  //   test("should throw an Error for label exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "A question with a very long label",
  //         header: "Long Label",
  //         options: [
  //           { label: "This is a very, very, very long label that will exceed the limit", description: "A description" },
  //         ],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })
})
