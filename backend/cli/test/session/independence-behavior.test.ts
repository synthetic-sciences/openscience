import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2StreamPart } from "@ai-sdk/provider"
import { simulateReadableStream, stepCountIs, streamText, tool } from "ai"
import { Instance } from "../../src/project/instance"
import * as QuestionModule from "../../src/question"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { BashTool } from "../../src/tool/bash"
import { QuestionTool } from "../../src/tool/question"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
}

type InitializedQuestionTool = Awaited<ReturnType<typeof QuestionTool.init>>
type QuestionCall = Parameters<InitializedQuestionTool["execute"]>[0]

type DecisionResult = {
  title: string
  output: string
  metadata: Record<string, unknown>
}

class ScriptedDecisionModel implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const
  readonly provider = "openscience-test"
  readonly modelId = "decision-trace"
  readonly supportedUrls = {}
  readonly requests: LanguageModelV2CallOptions[] = []

  constructor(
    private readonly input: QuestionCall,
    private readonly finalText = "Continued after the recorded decision.",
  ) {}

  async doGenerate(_options: LanguageModelV2CallOptions): Promise<never> {
    throw new Error("The decision trace uses streaming only")
  }

  async doStream(options: LanguageModelV2CallOptions) {
    this.requests.push(options)
    const chunks: LanguageModelV2StreamPart[] =
      this.requests.length === 1
        ? [
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: "call_decision",
              toolName: "question",
              input: JSON.stringify(this.input),
            },
            { type: "finish", finishReason: "tool-calls", usage },
          ]
        : [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: this.finalText },
            { type: "text-end", id: "answer" },
            { type: "finish", finishReason: "stop", usage },
          ]

    return {
      stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
    }
  }
}

const decision = {
  question: "Should we keep the reversible implementation or expand the migration?",
  header: "Migration",
  options: [
    { label: "Keep reversible (Recommended)", description: "Preserve rollback while meeting the requirement" },
    { label: "Expand migration", description: "Increase scope and remove the simple rollback path" },
  ],
}

function call(reason: QuestionCall["reason"], questions = [decision]): QuestionCall {
  return { reason, questions }
}

function context(autonomy: MessageV2.DelegationSettings["autonomy"], callID = "call_decision"): Tool.Context {
  return {
    sessionID: "ses_decision_trace",
    messageID: "msg_decision_trace",
    callID,
    agent: "research",
    abort: new AbortController().signal,
    messages: [],
    extra: { delegationSettings: { level: "standard", autonomy } },
    metadata() {},
    async ask() {},
  }
}

async function runProviderTrace(autonomy: MessageV2.DelegationSettings["autonomy"], input: QuestionCall) {
  const definition = await QuestionTool.init()
  const model = new ScriptedDecisionModel(input)
  const executions: Array<{ input: QuestionCall; result: DecisionResult }> = []
  const result = streamText({
    model,
    prompt: "Resolve the implementation decision under the active independence posture.",
    stopWhen: stepCountIs(2),
    tools: {
      question: tool({
        description: definition.description,
        inputSchema: definition.parameters,
        async execute(args, options) {
          const resolved = await definition.execute(args, {
            ...context(autonomy, options.toolCallId),
            abort: options.abortSignal ?? new AbortController().signal,
          })
          executions.push({ input: args, result: resolved })
          return resolved
        },
      }),
    },
  })

  const [text, steps] = await Promise.all([result.text, result.steps])
  return { executions, model, steps, text }
}

describe("independence provider behavior", () => {
  let askSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    askSpy = spyOn(QuestionModule.Question, "ask").mockImplementation(async ({ questions }) =>
      questions.map((question) => [question.options[0]?.label ?? "Continue"]),
    )
  })

  afterEach(() => {
    askSpy.mockRestore()
  })

  test("Interactive emits a planning question with the recommended option first", async () => {
    const trace = await runProviderTrace("interactive", call("planning"))

    expect(askSpy).toHaveBeenCalledTimes(1)
    const request = askSpy.mock.calls[0]?.[0]
    expect(request?.questions[0]?.options[0]).toEqual(decision.options[0])
    expect(trace.executions[0]?.result.metadata).toMatchObject({
      autonomy: "interactive",
      reason: "planning",
      resolution: "user",
    })
    expect(trace.steps[0]?.toolCalls).toHaveLength(1)
    expect(trace.steps[0]?.toolResults).toHaveLength(1)
    expect(trace.model.requests).toHaveLength(2)
    expect(trace.text).toBe("Continued after the recorded decision.")
  })

  test("Balanced continues through routine ambiguity but asks on consequential ambiguity", async () => {
    const routine = await runProviderTrace("balanced", call("planning"))

    expect(askSpy).not.toHaveBeenCalled()
    expect(routine.executions[0]?.result).toMatchObject({
      output: expect.stringContaining(
        'Assumption recorded: "Should we keep the reversible implementation or expand the migration?"="Keep reversible (Recommended)"',
      ),
      metadata: {
        autonomy: "balanced",
        reason: "planning",
        resolution: "recommended",
      },
    })
    expect(JSON.stringify(routine.model.requests[1]?.prompt)).toContain('"resolution":"recommended"')

    const consequential = await runProviderTrace("balanced", call("consequential"))
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(consequential.executions[0]?.result.metadata).toMatchObject({
      autonomy: "balanced",
      reason: "consequential",
      resolution: "user",
    })
  })

  test("Independent records the recommended path and asks only for missing authority", async () => {
    const decisionTrace = await runProviderTrace("autonomous", call("consequential"))

    expect(askSpy).not.toHaveBeenCalled()
    expect(decisionTrace.executions[0]?.result).toMatchObject({
      output: expect.stringContaining("Assumption recorded"),
      metadata: {
        autonomy: "autonomous",
        reason: "consequential",
        resolution: "recommended",
        assumptions: [
          {
            selection: "Keep reversible (Recommended)",
            description: "Preserve rollback while meeting the requirement",
          },
        ],
      },
    })
    expect(JSON.stringify(decisionTrace.model.requests[1]?.prompt)).toContain("Keep reversible (Recommended)")

    const missingAuthority = await runProviderTrace(
      "autonomous",
      call("missing_authority", [
        {
          question: "Please provide the deployment authority required to continue.",
          header: "Authority",
          options: [{ label: "Provide access", description: "Grant the required deployment authority" }],
        },
      ]),
    )
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(missingAuthority.executions[0]?.result.metadata).toMatchObject({
      autonomy: "autonomous",
      reason: "missing_authority",
      resolution: "user",
    })
  })

  test("Independent assumption output is durable in the normal processor tool trace", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const definition = await QuestionTool.init()
        const input = call("consequential")
        const coordinator = SessionProcessor.createToolOutcomeCoordinator({
          abort: new AbortController().signal,
          updatePart: Session.updatePart,
        })
        const part: MessageV2.ToolPart = {
          id: "prt_decision_trace",
          sessionID: session.id,
          messageID: "msg_decision_trace",
          type: "tool",
          callID: "call_decision_trace",
          tool: "question",
          state: { status: "running", input, time: { start: Date.now() } },
        }

        const execution = coordinator.execute(part.callID, input, () =>
          definition.execute(input, context("autonomous", part.callID)),
        )
        await coordinator.running(part)
        await execution

        expect((await MessageV2.parts(part.messageID)).find((item) => item.id === part.id)).toMatchObject({
          type: "tool",
          state: {
            status: "completed",
            output: expect.stringContaining("Assumption recorded"),
            metadata: {
              autonomy: "autonomous",
              reason: "consequential",
              resolution: "recommended",
              assumptions: [{ selection: "Keep reversible (Recommended)" }],
            },
          },
        })
        expect(askSpy).not.toHaveBeenCalled()
        await Session.remove(session.id)
      },
    })
  })

  test("independence posture never bypasses a tool permission floor", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const session = await Session.create({})
        for (const autonomy of ["interactive", "balanced", "autonomous"] as const) {
          const boundary = new Error(`permission boundary: ${autonomy}`)
          let requests = 0
          await expect(
            bash.execute(
              { command: "printf permission-floor", description: "Probe the permission floor" },
              {
                ...context(autonomy),
                sessionID: session.id,
                async ask(request) {
                  requests++
                  expect(request.permission).toBe("bash")
                  throw boundary
                },
              },
            ),
          ).rejects.toBe(boundary)
          expect(requests).toBe(1)
        }
        await Session.remove(session.id)
      },
    })
  })
})
