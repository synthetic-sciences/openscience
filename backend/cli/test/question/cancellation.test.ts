import { expect, test } from "bun:test"
import { getEventListeners } from "node:events"
import { Question } from "../../src/question"
import { Instance } from "../../src/project/instance"
import { Bus } from "../../src/bus"
import { QuestionTool } from "../../src/tool/question"
import { tmpdir } from "../fixture/fixture"

const questions = [
  {
    header: "Dataset",
    question: "Which dataset should be analyzed?",
    options: [{ label: "Calibration", description: "The local calibration measurements" }],
  },
]

test("cancelled questions are immediately removed and cannot be answered or rejected later", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const controller = new AbortController()
      const event = Promise.withResolvers<unknown>()
      const unsubscribe = Bus.subscribe(Question.Event.Cancelled, (value) => event.resolve(value.properties))
      const result = Question.ask({ sessionID: "ses_cancelled", questions }, controller.signal).catch((error) => error)
      const [request] = await Question.list()
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1)
      controller.abort()
      expect(await Question.list()).toEqual([])
      expect((await result).name).toBe("AbortError")
      expect(await event.promise).toEqual({ sessionID: request.sessionID, requestID: request.id })
      expect(await Question.reply({ requestID: request.id, answers: [["Calibration"]] })).toBe(false)
      expect(await Question.reject(request.id)).toBe(false)
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
      unsubscribe()
      await Instance.dispose()
    },
  })
})

test("already cancelled questions never enter the pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const controller = new AbortController()
      controller.abort(new Error("Stopped by the caller"))
      await expect(Question.ask({ sessionID: "ses_cancelled", questions }, controller.signal)).rejects.toThrow(
        "Stopped by the caller",
      )
      expect(await Question.list()).toEqual([])
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
      await Instance.dispose()
    },
  })
})

test("questions enforce the expected session and exactly one reply claims the request", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const controller = new AbortController()
      const result = Question.ask({ sessionID: "ses_owner", questions }, controller.signal)
      const [request] = await Question.list()
      expect(await Question.reply({ requestID: request.id, sessionID: "ses_other", answers: [] })).toBe(false)
      expect(await Question.reject(request.id, "ses_other")).toBe(false)
      expect(await Question.list()).toHaveLength(1)
      const claims = await Promise.all([
        Question.reply({ requestID: request.id, sessionID: "ses_owner", answers: [["Calibration"]] }),
        Question.reply({ requestID: request.id, answers: [] }),
      ])
      expect(claims).toEqual([true, false])
      expect(await result).toEqual([["Calibration"]])
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
      controller.abort()
      expect(await Question.list()).toEqual([])
      await Instance.dispose()
    },
  })
})

test("question disposal rejects pending callers and removes cancellation listeners", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const controller = new AbortController()
      const result = Question.ask({ sessionID: "ses_closed", questions }, controller.signal).catch((error) => error)
      expect(await Question.list()).toHaveLength(1)
      await Instance.dispose()
      expect(await result).toBeInstanceOf(Question.InstanceDisposedError)
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
    },
  })
})

test("the actual question tool cancels its pending request with the tool context", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const controller = new AbortController()
      const asked = Promise.withResolvers<string>()
      const unsubscribe = Bus.subscribe(Question.Event.Asked, (event) => asked.resolve(event.properties.id))
      const tool = await QuestionTool.init()
      const result = tool
        .execute(
          { reason: "missing_authority", questions },
          {
            sessionID: "ses_tool",
            messageID: "msg_tool",
            callID: "call_tool",
            agent: "research",
            abort: controller.signal,
            messages: [],
            metadata() {},
            async ask() {},
          },
        )
        .catch((error) => error)
      const id = await asked.promise
      controller.abort()
      expect((await result).name).toBe("AbortError")
      expect(await Question.reply({ requestID: id, answers: [] })).toBe(false)
      expect(await Question.list()).toEqual([])
      unsubscribe()
      await Instance.dispose()
    },
  })
})
