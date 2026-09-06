import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import z from "zod"

export namespace Question {
  const log = Log.create({ service: "question" })

  export const Option = z
    .object({
      label: z.string().describe("Display text (1-5 words, concise)"),
      description: z.string().describe("Explanation of choice"),
    })
    .meta({
      ref: "QuestionOption",
    })
  export type Option = z.infer<typeof Option>

  export const Info = z
    .object({
      question: z.string().describe("Complete question"),
      header: z.string().describe("Very short label (max 30 chars)"),
      options: z.array(Option).describe("Available choices"),
      multiple: z.boolean().optional().describe("Allow selecting multiple choices"),
      custom: z.boolean().optional().describe("Allow typing a custom answer (default: true)"),
    })
    .meta({
      ref: "QuestionInfo",
    })
  export type Info = z.infer<typeof Info>

  export const Request = z
    .object({
      id: Identifier.schema("question"),
      sessionID: Identifier.schema("session"),
      questions: z.array(Info).describe("Questions to ask"),
      tool: z
        .object({
          messageID: z.string(),
          callID: z.string(),
        })
        .optional(),
    })
    .meta({
      ref: "QuestionRequest",
    })
  export type Request = z.infer<typeof Request>

  export const Answer = z.array(z.string()).meta({
    ref: "QuestionAnswer",
  })
  export type Answer = z.infer<typeof Answer>

  export const Reply = z.object({
    answers: z
      .array(Answer)
      .describe("User answers in order of questions (each answer is an array of selected labels)"),
  })
  export type Reply = z.infer<typeof Reply>

  export const Event = {
    Asked: BusEvent.define("question.asked", Request),
    Replied: BusEvent.define(
      "question.replied",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
        answers: z.array(Answer),
      }),
    ),
    Cancelled: BusEvent.define(
      "question.cancelled",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
      }),
    ),
    Rejected: BusEvent.define(
      "question.rejected",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
      }),
    ),
  }

  const state = Instance.state(
    async () => {
      const pending: Record<
        string,
        {
          info: Request
          resolve: (answers: Answer[]) => void
          reject: (error: unknown) => void
          cleanup: () => void
        }
      > = {}
      return { pending }
    },
    async (current) => {
      for (const [id, pending] of Object.entries(current.pending)) {
        delete current.pending[id]
        pending.cleanup()
        pending.reject(new InstanceDisposedError())
      }
    },
  )

  export async function ask(
    input: {
      sessionID: string
      questions: Info[]
      tool?: { messageID: string; callID: string }
    },
    signal?: AbortSignal,
  ): Promise<Answer[]> {
    signal?.throwIfAborted()
    const s = await state()
    signal?.throwIfAborted()
    const id = Identifier.ascending("question")

    log.info("asking", { id, questions: input.questions.length })

    return new Promise<Answer[]>((resolve, reject) => {
      const info: Request = {
        id,
        sessionID: input.sessionID,
        questions: input.questions,
        tool: input.tool,
      }
      const abort = () => {
        const pending = s.pending[id]
        if (!pending) return
        delete s.pending[id]
        pending.cleanup()
        reject(signal?.reason ?? new DOMException("Question cancelled", "AbortError"))
        Bus.publish(Event.Cancelled, { sessionID: info.sessionID, requestID: id }).catch((error) =>
          log.error("failed to publish question cancellation", { id, error }),
        )
      }
      s.pending[id] = {
        info,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      }
      signal?.addEventListener("abort", abort, { once: true })
      Bus.publish(Event.Asked, info).catch((error) => log.error("failed to publish question request", { id, error }))
    })
  }

  export async function reply(input: { requestID: string; sessionID?: string; answers: Answer[] }): Promise<boolean> {
    const s = await state()
    const existing = s.pending[input.requestID]
    if (!existing || (input.sessionID !== undefined && existing.info.sessionID !== input.sessionID)) return false
    delete s.pending[input.requestID]
    existing.cleanup()

    log.info("replied", { requestID: input.requestID, answers: input.answers })

    Bus.publish(Event.Replied, {
      sessionID: existing.info.sessionID,
      requestID: existing.info.id,
      answers: input.answers,
    }).catch((error) => log.error("failed to publish question reply", { requestID: input.requestID, error }))

    existing.resolve(input.answers)
    return true
  }

  export async function reject(requestID: string, sessionID?: string): Promise<boolean> {
    const s = await state()
    const existing = s.pending[requestID]
    if (!existing || (sessionID !== undefined && existing.info.sessionID !== sessionID)) return false
    delete s.pending[requestID]
    existing.cleanup()

    log.info("rejected", { requestID })

    Bus.publish(Event.Rejected, {
      sessionID: existing.info.sessionID,
      requestID: existing.info.id,
    }).catch((error) => log.error("failed to publish question rejection", { requestID, error }))

    existing.reject(new RejectedError())
    return true
  }

  export class InstanceDisposedError extends Error {
    constructor() {
      super("The question ended because the project runtime was closed.")
    }
  }

  export class RejectedError extends Error {
    constructor() {
      super("The user dismissed this question")
    }
  }

  export async function list() {
    return state().then((x) => Object.values(x.pending).map((x) => x.info))
  }
}
