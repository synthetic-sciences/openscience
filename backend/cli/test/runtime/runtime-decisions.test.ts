import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { RuntimeDecisions } from "../../src/runtime/decisions"
import { Session } from "../../src/session"
import { Question } from "../../src/question"
import { PermissionNext } from "../../src/permission/next"
import { RuntimeRoutes } from "../../src/server/routes/runtime"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

const questions = [
  {
    question: "Which analysis?",
    header: "Analysis",
    custom: false,
    options: [
      { label: "A", description: "First analysis" },
      { label: "B", description: "Second analysis" },
    ],
  },
]

test("concurrent identical question replies resolve once and later changed replies conflict", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const waiting = Question.ask({ sessionID: session.id, questions })
      const [request] = await Question.list()
      const input = { kind: "question" as const, sessionID: session.id, requestID: request!.id, answers: [["A"]] }
      const replies = await Promise.all(Array.from({ length: 5 }, () => RuntimeDecisions.decide(input)))
      expect(await waiting).toEqual([["A"]])
      expect(replies.every((reply) => reply.status === "resolved" && reply.decidedAt === replies[0]!.decidedAt)).toBe(
        true,
      )
      expect(await Question.list()).toHaveLength(0)
      await expect(RuntimeDecisions.decide({ ...input, answers: [["B"]] })).rejects.toBeInstanceOf(
        RuntimeDecisions.ConflictError,
      )
      expect(await RuntimeDecisions.decide(input)).toEqual(replies[0]!)
    },
  })
})

test("a wrong session or invalid answer cannot claim a live question", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const other = await Session.create({})
      const waiting = Question.ask({ sessionID: session.id, questions })
      const [request] = await Question.list()
      const input = { kind: "question" as const, sessionID: session.id, requestID: request!.id, answers: [["A"]] }
      await expect(RuntimeDecisions.decide({ ...input, sessionID: other.id })).rejects.toBeInstanceOf(
        RuntimeDecisions.ExpiredError,
      )
      for (const answers of [[], [["A", "B"]], [["C"]]])
        await expect(RuntimeDecisions.decide({ ...input, answers })).rejects.toBeInstanceOf(
          RuntimeDecisions.AnswerError,
        )
      expect(await Question.list()).toHaveLength(1)
      await RuntimeDecisions.decide(input)
      expect(await waiting).toEqual([["A"]])
    },
  })
})

test("a cancelled question disappears from snapshots and cannot be answered from history", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const controller = new AbortController()
      const waiting = Question.ask({ sessionID: session.id, questions }, controller.signal).catch(
        (error: unknown) => error,
      )
      const [request] = await Question.list()
      controller.abort()
      expect(await waiting).toBeInstanceOf(Error)
      const response = await RuntimeRoutes().request(`/snapshot?sessionID=${session.id}`)
      expect(await response.json()).toMatchObject({ questions: [], permissions: [] })
      const decision = await RuntimeRoutes().request("/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "question", sessionID: session.id, requestID: request!.id, answers: [["A"]] }),
      })
      expect(decision.status).toBe(409)
      expect(await decision.json()).toMatchObject({ error: "decision_expired" })
    },
  })
})

test("permission scope is retained in its receipt and exact retries do not add standing grants", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const waiting = PermissionNext.ask({
        sessionID: session.id,
        permission: "read",
        patterns: ["data.csv"],
        always: ["data.csv"],
        metadata: {},
        ruleset: [{ permission: "read", pattern: "*", action: "ask" }],
      })
      const [request] = await PermissionNext.list()
      const input = {
        kind: "permission" as const,
        sessionID: session.id,
        requestID: request!.id,
        reply: "project" as const,
      }
      expect((await RuntimeDecisions.decide(input)).status).toBe("resolved")
      await waiting
      const grants = await PermissionNext.standing()
      expect(grants).toHaveLength(1)
      expect((await RuntimeDecisions.decide(input)).status).toBe("resolved")
      expect(await PermissionNext.standing()).toEqual(grants)
      await expect(RuntimeDecisions.decide({ ...input, reply: "always" })).rejects.toBeInstanceOf(
        RuntimeDecisions.ConflictError,
      )
    },
  })
})

test("an ambiguous persisted decision is reported without reapplying its continuation", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const input = { kind: "question" as const, sessionID: session.id, requestID: "que_crash_gap", answers: [["A"]] }
      const identity = new Bun.CryptoHasher("sha256").update(session.id + "\0" + input.requestID).digest("hex")
      const result = {
        sessionID: session.id,
        requestID: input.requestID,
        status: "indeterminate" as const,
        decidedAt: 100,
      }
      await Storage.write(["runtime_decision", Instance.project.id, identity], { input, result })
      expect(await RuntimeDecisions.decide(input)).toEqual(result)
      expect(await Question.list()).toHaveLength(0)
    },
  })
})

test("a root snapshot includes pending decisions raised by delegated child sessions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      const grandchild = await Session.create({ parentID: child.id })
      const stranger = await Session.create({})
      const controller = new AbortController()
      const settle = (promise: Promise<unknown>) => promise.catch((error: unknown) => error)
      const waiting = Question.ask({ sessionID: grandchild.id, questions })
      const foreign = settle(Question.ask({ sessionID: stranger.id, questions }, controller.signal))
      const permission = settle(
        PermissionNext.ask(
          {
            sessionID: child.id,
            permission: "bash",
            patterns: ["rm -rf build"],
            metadata: {},
            always: [],
            ruleset: [],
          },
          controller.signal,
        ),
      )
      try {
        await Bun.sleep(10)
        const response = await RuntimeRoutes().request(`/snapshot?sessionID=${parent.id}`)
        const snapshot = (await response.json()) as {
          questions: Array<{ id: string; sessionID: string }>
          permissions: Array<{ sessionID: string }>
        }
        expect(snapshot.questions.map((item) => item.sessionID)).toEqual([grandchild.id])
        expect(snapshot.permissions.map((item) => item.sessionID)).toEqual([child.id])
        const own = await RuntimeRoutes().request(`/snapshot?sessionID=${stranger.id}`)
        expect(((await own.json()) as { questions: unknown[]; permissions: unknown[] }).permissions).toEqual([])

        const decision = await RuntimeRoutes().request("/decision", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "question",
            sessionID: grandchild.id,
            requestID: snapshot.questions[0]!.id,
            answers: [["B"]],
          }),
        })
        expect(decision.status).toBe(200)
        expect(await waiting).toEqual([["B"]])
      } finally {
        controller.abort()
        await Promise.all([foreign, permission])
      }
    },
  })
})
