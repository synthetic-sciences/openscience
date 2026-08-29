import z from "zod"
import { Tool } from "./tool"
import { Question } from "../question"
import { MessageV2 } from "../session/message-v2"
import DESCRIPTION from "./question.txt"

export const QuestionReason = z.enum(["planning", "consequential", "missing_authority"])

export const QuestionTool = Tool.define("question", {
  description: DESCRIPTION,
  parameters: z.object({
    reason: QuestionReason.default("consequential").describe(
      "Why user input is required: collaborative planning, a consequential decision, or missing authority/input that blocks progress",
    ),
    questions: z.array(Question.Info.omit({ custom: true })).describe("Questions to ask"),
  }),
  async execute(params, ctx) {
    const autonomy = MessageV2.resolveDelegationSettings(ctx.extra?.delegationSettings).autonomy
    if (autonomy === "autonomous" && params.reason !== "missing_authority") {
      throw new Error(
        "Independent mode does not pause for planning or consequential preferences. Choose the recommended safe path, record the assumption, and continue. Use the question tool only when missing authority or required input makes progress impossible.",
      )
    }
    if (autonomy === "balanced" && params.reason === "planning") {
      throw new Error(
        "Balanced mode does not pause for routine planning. Choose the recommended safe, reversible path and continue; ask only for a consequential decision or genuinely missing authority.",
      )
    }
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

    const answers = await Question.ask({
      sessionID: ctx.sessionID,
      questions: params.questions,
      tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
    })

    function format(answer: Question.Answer | undefined) {
      if (!answer?.length) return "Unanswered"
      return answer.join(", ")
    }

    const formatted = params.questions.map((q, i) => `"${q.question}"="${format(answers[i])}"`).join(", ")

    return {
      title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
      output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
      metadata: {
        answers,
        autonomy,
        reason: params.reason,
      },
    }
  },
})
