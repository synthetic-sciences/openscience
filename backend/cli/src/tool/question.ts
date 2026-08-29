import z from "zod"
import { Tool } from "./tool"
import { Question } from "../question"
import { MessageV2 } from "../session/message-v2"
import DESCRIPTION from "./question.txt"

export const QuestionReason = z.enum(["planning", "consequential", "missing_authority"])

type QuestionDecisionMetadata = {
  answers: string[][]
  assumptions: Array<{ question: string; selection: string; description: string }>
  autonomy: MessageV2.DelegationSettings["autonomy"]
  reason: z.infer<typeof QuestionReason>
  resolution: "recommended" | "user"
}
type QuestionDecisionResult = { title: string; output: string; metadata: QuestionDecisionMetadata }

function recommendedResolution(input: {
  autonomy: MessageV2.DelegationSettings["autonomy"]
  reason: z.infer<typeof QuestionReason>
  questions: Question.Info[]
}): QuestionDecisionResult {
  const assumptions = input.questions.map((question) => ({
    question: question.question,
    selection: question.options[0]!.label,
    description: question.options[0]!.description,
  }))
  const answers = assumptions.map((assumption) => [assumption.selection])
  const formatted = assumptions
    .map((assumption) => `${JSON.stringify(assumption.question)}=${JSON.stringify(assumption.selection)}`)
    .join(", ")

  return {
    title: `Continued with ${assumptions.length} recommended choice${assumptions.length > 1 ? "s" : ""}`,
    output: `OpenScience continued without pausing. Assumption recorded: ${formatted}.`,
    metadata: {
      answers,
      assumptions,
      autonomy: input.autonomy,
      reason: input.reason,
      resolution: "recommended",
    },
  }
}

export const QuestionTool = Tool.define("question", {
  description: DESCRIPTION,
  parameters: z.object({
    reason: QuestionReason.default("consequential").describe(
      "Why user input is required: collaborative planning, a consequential decision, or missing authority/input that blocks progress",
    ),
    questions: z.array(Question.Info.omit({ custom: true })).describe("Questions to ask"),
  }),
  async execute(params, ctx): Promise<QuestionDecisionResult> {
    const autonomy = MessageV2.resolveDelegationSettings(ctx.extra?.delegationSettings).autonomy
    if (params.reason !== "missing_authority") {
      const invalid = params.questions.find(
        (question) => question.options.length < 2 || !question.options[0]?.label.endsWith("(Recommended)"),
      )
      if (invalid) {
        throw new Error(
          "Planning and consequential questions need at least two concrete choices, with the recommended choice first and its label ending in '(Recommended)'.",
        )
      }
    }
    if (
      params.reason !== "missing_authority" &&
      (autonomy === "autonomous" || (autonomy === "balanced" && params.reason === "planning"))
    ) {
      return recommendedResolution({ autonomy, reason: params.reason, questions: params.questions })
    }

    const answers = await Question.ask({
      sessionID: ctx.sessionID,
      questions: params.questions,
      tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
    })

    function format(answer: Question.Answer | undefined) {
      if (!answer?.length) return "Unanswered"
      return answer.join(", ")
    }

    const formatted = params.questions
      .map((q, i) => `${JSON.stringify(q.question)}=${JSON.stringify(format(answers[i]))}`)
      .join(", ")

    return {
      title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
      output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
      metadata: {
        answers,
        assumptions: [],
        autonomy,
        reason: params.reason,
        resolution: "user",
      },
    }
  },
})
