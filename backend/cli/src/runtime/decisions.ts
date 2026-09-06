import path from "node:path"
import z from "zod"
import { Global } from "../global"
import { Identifier } from "../id/id"
import { PermissionNext } from "../permission/next"
import { Instance } from "../project/instance"
import { Question } from "../question"
import { Session } from "../session"
import { Storage } from "../storage/storage"
import { FileLease } from "../util/file-lease"

export namespace RuntimeDecisions {
  const scope = { sessionID: Identifier.schema("session") }
  export const Input = z
    .discriminatedUnion("kind", [
      z
        .object({
          ...scope,
          kind: z.literal("permission"),
          requestID: Identifier.schema("permission"),
          reply: PermissionNext.Reply,
          message: z.string().max(100_000).optional(),
        })
        .strict(),
      z
        .object({
          ...scope,
          kind: z.literal("question"),
          requestID: Identifier.schema("question"),
          answers: Question.Answer.array(),
        })
        .strict(),
      z
        .object({
          ...scope,
          kind: z.literal("question_reject"),
          requestID: Identifier.schema("question"),
        })
        .strict(),
    ])
    .meta({ ref: "RuntimeDecisionInput" })
  export type Input = z.infer<typeof Input>

  export const Result = z
    .object({
      sessionID: Identifier.schema("session"),
      requestID: z.string(),
      status: z.enum(["resolved", "indeterminate"]),
      decidedAt: z.number().int().nonnegative(),
    })
    .meta({ ref: "RuntimeDecisionResult" })
  const Receipt = z.object({ result: Result, input: Input })

  export class ConflictError extends Error {
    constructor() {
      super("This decision request already has a different response")
    }
  }

  export class ExpiredError extends Error {
    constructor() {
      super("This request is not pending in the connected runtime; refresh the session snapshot")
    }
  }

  export class AnswerError extends Error {}

  function digest(value: string) {
    return new Bun.CryptoHasher("sha256").update(value).digest("hex")
  }

  /** Pending continuations belong to their runtime process. Only the response
   * receipt is durable: a lost process is never reconstructed from old events.
   * Ambiguous crashes during a decision are reported without repeating it. */
  export async function decide(value: Input): Promise<z.infer<typeof Result>> {
    const input = Input.parse(value)
    await Session.get(input.sessionID)
    const identity = digest(input.sessionID + "\0" + input.requestID)
    const key = ["runtime_decision", Instance.project.id, identity]
    await using lease = await FileLease.acquire(
      path.join(Global.Path.data, "runtime-decisions", Instance.project.id, identity),
    )
    const prior = await Storage.read(key)
      .then((value) => Receipt.parse(value))
      .catch((error) => {
        if (Storage.NotFoundError.isInstance(error)) return
        throw error
      })
    if (prior) {
      // Zod gives both values the same property order and strips no unknown
      // fields; equality includes the kind and the actual permission scope.
      if (JSON.stringify(prior.input) !== JSON.stringify(input)) throw new ConflictError()
      return prior.result
    }
    const pending = input.kind === "permission" ? await PermissionNext.list() : await Question.list()
    const request = pending.find((item) => item.id === input.requestID && item.sessionID === input.sessionID)
    if (!request) throw new ExpiredError()
    if (input.kind === "question" && "questions" in request) {
      if (input.answers.length !== request.questions.length) throw new AnswerError("Answer each question in order")
      for (const [index, question] of request.questions.entries()) {
        const answer = input.answers[index]!
        if (!question.multiple && answer.length > 1) throw new AnswerError("This question accepts one selection")
        if (new Set(answer).size !== answer.length) throw new AnswerError("A selection may only appear once")
        if (
          question.custom === false &&
          answer.some((label) => !question.options.some((option) => option.label === label))
        )
          throw new AnswerError("This question only accepts its listed options")
      }
    }
    const receipt = Receipt.parse({
      input,
      result: {
        sessionID: input.sessionID,
        requestID: input.requestID,
        status: "indeterminate",
        decidedAt: Date.now(),
      },
    })
    await Storage.write(key, receipt)
    const applied =
      input.kind === "permission"
        ? await PermissionNext.reply(input)
        : input.kind === "question"
          ? await Question.reply(input)
          : await Question.reject(input.requestID, input.sessionID)
    // Another client using a legacy endpoint may claim the pending request
    // while the receipt is written. A missing claim is never called success.
    if (!applied) return receipt.result
    receipt.result.status = "resolved"
    await Storage.write(key, receipt)
    return receipt.result
  }
}
