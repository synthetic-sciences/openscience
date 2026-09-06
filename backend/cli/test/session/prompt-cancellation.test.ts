import { describe, expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { FileTime } from "../../src/file/time"
import { Global } from "../../src/global"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { FileLease } from "../../src/util/file-lease"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

const model = { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL }

async function within<T>(promise: Promise<T>, timeout = 5_000) {
  const expired = Promise.withResolvers<never>()
  const timer = setTimeout(() => expired.reject(new Error("Prompt lifecycle did not settle")), timeout)
  return Promise.race([promise, expired.promise]).finally(() => clearTimeout(timer))
}

function input(sessionID: string, text = "Reply with the fixture response.") {
  return { sessionID, model, agent: "research", delegation: false, parts: [{ type: "text" as const, text }] }
}

function provider() {
  const requests: unknown[] = []
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
      requests.push(await request.json())
      entered.resolve()
      await release.promise
      const chunk = (content?: string) => ({
        id: "chatcmpl-prompt-cancellation",
        object: "chat.completion.chunk",
        created: 1,
        model: STRESS_PROVIDER_MODEL,
        choices: [
          { index: 0, delta: content ? { role: "assistant", content } : {}, finish_reason: content ? null : "stop" },
        ],
        ...(!content ? { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } } : {}),
      })
      return new Response(
        `data: ${JSON.stringify(chunk("PROMPT_COMPLETED"))}\n\ndata: ${JSON.stringify(chunk())}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  return {
    config: stressProviderConfig(`http://127.0.0.1:${server.port}/v1`),
    requests,
    entered,
    release,
    [Symbol.dispose]() {
      release.resolve()
      server.stop(true)
    },
  }
}

async function init() {
  await trustProject()
  await Provider.invalidate()
}

describe("controlled prompt cancellation", () => {
  test("reserves an owner synchronously and immediate cancellation creates no transcript or provider work", async () => {
    using local = provider()
    await using tmp = await tmpdir({ git: true, config: local.config })
    await Instance.provide({
      directory: tmp.path,
      init,
      fn: async () => {
        const session = await Session.create({})
        const before = SessionPrompt.activeCount()
        const result = SessionPrompt.controlled(input(session.id))
        const rejected = result.catch((error: unknown) => error)
        const owner = SessionPrompt.activeController(session.id)
        expect(owner).toBeDefined()
        expect(SessionPrompt.activeCount()).toBe(before + 1)
        expect(() => SessionPrompt.assertNotBusy(session.id)).toThrow(Session.BusyError)
        SessionPrompt.cancel(session.id, owner)
        expect(await within(rejected)).toBeInstanceOf(DOMException)
        expect(owner?.aborted).toBe(true)
        expect(SessionPrompt.activeController(session.id)).toBeUndefined()
        expect(SessionPrompt.activeCount()).toBe(before)
        expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
        expect(local.requests).toHaveLength(0)
        await Session.remove(session.id)
      },
    })
  })

  test("cancels a pending attachment approval and removes its decision", async () => {
    using local = provider()
    await using external = await tmpdir({
      init: (directory) => Bun.write(path.join(directory, "private.bin"), "private"),
    })
    await using tmp = await tmpdir({ git: true, config: local.config })
    await Instance.provide({
      directory: tmp.path,
      init,
      fn: async () => {
        const session = await Session.create({})
        const file = path.join(external.path, "private.bin")
        const result = SessionPrompt.controlled({
          ...input(session.id),
          parts: [
            {
              type: "file",
              url: pathToFileURL(file).href,
              filename: "private.bin",
              mime: "application/octet-stream",
            },
          ],
        })
        const rejected = result.catch((error: unknown) => error)
        await within(
          (async () => {
            while (!(await PermissionNext.list()).some((item) => item.sessionID === session.id)) await Bun.sleep(5)
          })(),
        )
        SessionPrompt.cancel(session.id, SessionPrompt.activeController(session.id))
        expect(await within(rejected)).toBeInstanceOf(DOMException)
        expect((await PermissionNext.list()).filter((item) => item.sessionID === session.id)).toHaveLength(0)
        expect(FileTime.get(session.id, file)).toBeUndefined()
        expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
        expect(local.requests).toHaveLength(0)
        await Session.remove(session.id)
      },
    })
  })

  test("a delayed cancelled attachment cannot read bytes or take a replacement's ownership", async () => {
    using local = provider()
    await using tmp = await tmpdir({
      git: true,
      config: local.config,
      init: (directory) => Bun.write(path.join(directory, "result.bin"), "unread"),
    })
    await Instance.provide({
      directory: tmp.path,
      init,
      fn: async () => {
        const session = await Session.create({ permission: [{ permission: "read", pattern: "*", action: "allow" }] })
        const file = path.join(tmp.path, "result.bin")
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        using hooks = SessionPrompt.testing({
          afterAttachmentAuthorization: async () => {
            entered.resolve()
            await release.promise
          },
        })
        const first = SessionPrompt.controlled({
          ...input(session.id),
          noReply: true,
          parts: [
            {
              type: "file",
              url: pathToFileURL(file).href,
              filename: "result.bin",
              mime: "application/octet-stream",
            },
          ],
        })
        const rejected = first.catch((error: unknown) => error)
        const old = SessionPrompt.activeController(session.id)
        try {
          await within(entered.promise)
          SessionPrompt.cancel(session.id, old)
          expect(await within(rejected)).toBeInstanceOf(DOMException)
          const replacement = SessionPrompt.controlled({ ...input(session.id, "replacement"), noReply: true })
          const next = SessionPrompt.activeController(session.id)
          expect(next).toBeDefined()
          expect(next).not.toBe(old)
          SessionPrompt.cancel(session.id, old)
          expect(next?.aborted).toBe(false)
          release.resolve()
          const result = await within(replacement)
          expect(result.parts.some((part) => part.type === "text" && part.text === "replacement")).toBe(true)
          expect(FileTime.get(session.id, file)).toBeUndefined()
          expect(await Session.messages({ sessionID: session.id })).toHaveLength(1)
          expect(SessionPrompt.activeController(session.id)).toBeUndefined()
          expect(local.requests).toHaveLength(0)
        } finally {
          release.resolve()
          SessionPrompt.cancel(session.id)
        }
        await Session.remove(session.id)
      },
    })
  })

  test("cancellation while waiting for authority admission cannot start the model loop", async () => {
    using local = provider()
    await using tmp = await tmpdir({ git: true, config: local.config })
    await Instance.provide({
      directory: tmp.path,
      init,
      fn: async () => {
        const session = await Session.create({})
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        using hooks = SessionPrompt.testing({
          beforeLoopAdmission: async () => {
            entered.resolve()
            await release.promise
          },
        })
        const result = SessionPrompt.controlled(input(session.id))
        const rejected = result.catch((error: unknown) => error)
        const owner = SessionPrompt.activeController(session.id)
        try {
          await within(entered.promise)
          await using lease = await FileLease.acquire(path.join(Global.Path.data, "authority", "spawn.lock"))
          release.resolve()
          SessionPrompt.cancel(session.id, owner)
          expect(await within(rejected)).toBeInstanceOf(DOMException)
          expect(SessionPrompt.activeController(session.id)).toBeUndefined()
          expect(local.requests).toHaveLength(0)
        } finally {
          release.resolve()
          SessionPrompt.cancel(session.id)
        }
        // Reacquiring the same real lease drains the queued admission callback.
        {
          await using drained = await FileLease.acquire(path.join(Global.Path.data, "authority", "spawn.lock"))
          expect(SessionPrompt.activeController(session.id)).toBeUndefined()
          expect(local.requests).toHaveLength(0)
        }
        await Session.remove(session.id)
      },
    })
  })

  for (const cancel of [false, true])
    test(`keeps one controller through provider startup and ${cancel ? "cancellation" : "normal completion"}`, async () => {
      using local = provider()
      await using tmp = await tmpdir({ git: true, config: local.config })
      await Instance.provide({
        directory: tmp.path,
        init,
        fn: async () => {
          const session = await Session.create({})
          const result = SessionPrompt.controlled(input(session.id))
          const owner = SessionPrompt.activeController(session.id)
          const rejected = result.catch((error: unknown) => error)
          try {
            await within(local.entered.promise, 10_000)
            expect(SessionPrompt.activeController(session.id)).toBe(owner)
            expect(local.requests).toHaveLength(1)
            if (cancel) {
              SessionPrompt.cancel(session.id, owner)
              expect(await within(rejected)).toBeInstanceOf(DOMException)
            }
            local.release.resolve()
            if (!cancel) {
              const message = await within(result)
              expect(message.info.role).toBe("assistant")
              expect(message.parts.some((part) => part.type === "text" && part.text === "PROMPT_COMPLETED")).toBe(true)
            }
            expect(SessionPrompt.activeController(session.id)).toBeUndefined()
          } finally {
            local.release.resolve()
            SessionPrompt.cancel(session.id, owner)
          }
        },
      })
    }, 20_000)
})
