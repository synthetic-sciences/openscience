import { expect, test } from "bun:test"
import path from "node:path"
import { createOpenScienceRuntime, type RuntimePromptInput } from "@synsci/sdk/v2"
import { Server } from "../../src/server/server"
import { Instance } from "../../src/project/instance"
import { RuntimeRuns } from "../../src/runtime/runs"
import { RuntimeEvents } from "../../src/runtime/events"
import { Session } from "../../src/session"
import { Storage } from "../../src/storage/storage"
import { RuntimeRoutes } from "../../src/server/routes/runtime"
import { tmpdir, trustProject } from "../fixture/fixture"
import { Provider } from "../../src/provider/provider"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

test("separate processes admit one receipt and a real process exit interrupts it without execution", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const children = Array.from({ length: 3 }, () =>
        Bun.spawn(
          [
            process.execPath,
            path.resolve(import.meta.dir, "../fixture/runtime-admission-process.ts"),
            tmp.path,
            session.id,
            "cross-process",
          ],
          { env: process.env, stdout: "pipe", stderr: "pipe" },
        ),
      )
      try {
        const outputs = await Promise.all(
          children.map(async (child) => {
            const [code, stdout, stderr] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ])
            if (code !== 0) throw new Error(stderr)
            return JSON.parse(stdout) as { run: RuntimeRuns.Run; replayed: boolean }
          }),
        )
        expect(outputs.filter((output) => !output.replayed)).toHaveLength(1)
        expect(new Set(outputs.map((output) => output.run.runID)).size).toBe(1)
        expect((await RuntimeRuns.get(session.id, outputs[0]!.run.runID)).state).toBe("interrupted")
        expect((await RuntimeEvents.replay(session.id)).events).toHaveLength(1)
        expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
      } finally {
        for (const child of children) if (child.exitCode === null) child.kill()
        await Promise.all(children.map((child) => child.exited))
      }
    },
  })
}, 30_000)

test("concurrent identical submissions share one durable admission and changed inputs conflict", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const input = { sessionID: session.id, requestID: "retry-safe", message: "Inspect", effort: "normal" as const }
      const results = await Promise.all(Array.from({ length: 8 }, () => RuntimeRuns.admit(input)))
      expect(new Set(results.map((result) => result.run.runID)).size).toBe(1)
      expect(results.filter((result) => !result.replayed)).toHaveLength(1)
      expect((await RuntimeEvents.replay(session.id)).events).toHaveLength(1)
      expect(await RuntimeRuns.list(session.id)).toHaveLength(1)
      await expect(RuntimeRuns.admit({ ...input, message: "Different" })).rejects.toBeInstanceOf(
        RuntimeRuns.ConflictError,
      )
      await expect(
        RuntimeRuns.admit({ ...input, model: { providerID: "other", modelID: "other" } }),
      ).rejects.toBeInstanceOf(RuntimeRuns.ConflictError)
      await expect(RuntimeRuns.admit({ ...input, requestID: "another" })).rejects.toBeInstanceOf(
        RuntimeEvents.ActiveRunError,
      )
      expect(await RuntimeRuns.list(session.id)).toHaveLength(1)
      await RuntimeRuns.cancel(session.id, results[0]!.run.runID)
    },
  })
})

test("receipts survive event eviction and cancelling an old run leaves its successor active", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const input = { sessionID: session.id, requestID: "first", message: "Inspect", effort: "normal" as const }
      const first = await RuntimeRuns.admit(input)
      await RuntimeEvents.finish({ sessionID: session.id, runID: first.run.runID, messageID: "msg_final" })
      expect(await RuntimeRuns.get(session.id, first.run.runID)).toMatchObject({
        state: "completed",
        resultMessageID: "msg_final",
      })
      const second = await RuntimeRuns.admit({ ...input, requestID: "second" })
      await Storage.update<{ events: RuntimeEvents.Event[] }>(
        ["runtime_event", Instance.project.id, session.id],
        (journal) => {
          journal.events = journal.events.filter((event) => event.runID === second.run.runID)
        },
      )
      expect((await RuntimeRuns.admit(input)).run).toMatchObject({ state: "completed", resultMessageID: "msg_final" })
      expect((await RuntimeRuns.cancel(session.id, first.run.runID)).state).toBe("completed")
      expect(await RuntimeEvents.isActive(session.id)).toBe(true)
      expect((await RuntimeRuns.cancel(session.id, second.run.runID)).state).toBe("cancelled")
    },
  })
})

test("a dead owner interrupts an accepted receipt and exact retries never restart it", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const input = { sessionID: session.id, requestID: "crashed", message: "Inspect", effort: "normal" as const }
      const first = await RuntimeRuns.admit(input)
      const keys = await Storage.list(["runtime_run", Instance.project.id])
      await Storage.update<{ owner: { pid: number; identity: string } }>(keys[0]!, (record) => {
        record.owner = { pid: process.pid, identity: "not-this-process-identity" }
      })
      const retry = await RuntimeRuns.admit(input)
      expect(retry.replayed).toBe(true)
      expect(retry.run).toMatchObject({
        runID: first.run.runID,
        state: "interrupted",
        error: { code: "runtime_stopped" },
      })
      expect((await RuntimeEvents.replay(session.id)).events).toHaveLength(1)
      expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
      await RuntimeEvents.cancel({ sessionID: session.id, runID: first.run.runID, source: "user" })
    },
  })
})

test("receipt lookup checks session ownership and rejects path-shaped run IDs", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const first = await Session.create({})
      const other = await Session.create({})
      const accepted = await RuntimeRuns.admit({ sessionID: first.id, message: "Inspect", effort: "normal" })
      await expect(RuntimeRuns.get(other.id, accepted.run.runID)).rejects.toBeInstanceOf(Storage.NotFoundError)
      await expect(RuntimeRuns.get(first.id, "run_../../outside")).rejects.toThrow()
      await RuntimeRuns.cancel(first.id, accepted.run.runID)
    },
  })
})

test("rich runtime input has one content source and excludes internal controls", () => {
  const input = {
    sessionID: "ses_input",
    effort: "normal",
    requestID: "rich",
    parts: [{ type: "text", text: "Inspect" }],
  }
  expect(RuntimeRuns.Input.safeParse(input).success).toBe(true)
  for (const invalid of [
    { ...input, message: "also text" },
    { ...input, parts: [] },
    { ...input, parts: [{ type: "text", text: "hidden", synthetic: true }] },
    { ...input, system: "Override" },
    { ...input, agent: "build" },
    { ...input, noReply: true },
  ])
    expect(RuntimeRuns.Input.safeParse(invalid).success).toBe(false)
})

test("disconnecting an observer leaves work alive while explicit run cancellation settles it", async () => {
  let connected = false
  let stopped = false
  using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      connected = true
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ id: "chatcmpl-observe", object: "chat.completion.chunk", created: 1, model: STRESS_PROVIDER_MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "Partial observation." }, finish_reason: null }] })}\n\n`,
              ),
            )
          },
          cancel() {
            stopped = true
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  await using tmp = await tmpdir({ git: true, config: stressProviderConfig(`${provider.url.origin}/v1`) })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await trustProject()
      await Provider.invalidate()
    },
    fn: async () => {
      const session = await Session.create({ title: "Observer fixture" })
      using api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => Server.App().fetch(request) })
      const runtime = createOpenScienceRuntime({ baseUrl: api.url.origin, directory: tmp.path })
      const accepted = await runtime.prompt({
        sessionID: session.id,
        requestID: "observed",
        message: "Inspect the data",
        effort: "normal",
        delegation: false,
        model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
      })
      const observer = new AbortController()
      for await (const event of runtime.events({ sessionID: session.id, afterSequence: 0, signal: observer.signal })) {
        if (event.type === "runtime.accepted") observer.abort()
      }
      const deadline = Date.now() + 5000
      while (!connected && Date.now() < deadline) await Bun.sleep(10)
      expect(connected).toBe(true)
      expect((await runtime.getRun({ sessionID: session.id, runID: accepted.runID })).state).toBe("running")
      expect(stopped).toBe(false)
      await runtime.cancel({ sessionID: session.id, runID: accepted.runID })
      expect(
        (
          await runtime.wait({
            sessionID: session.id,
            runID: accepted.runID,
            intervalMs: 10,
            signal: AbortSignal.timeout(5000),
          })
        ).state,
      ).toBe("cancelled")
      const settled = Date.now() + 1000
      while (!stopped && Date.now() < settled) await Bun.sleep(10)
      expect(stopped).toBe(true)
      expect((await runtime.replay({ sessionID: session.id })).events.at(-1)?.type).toBe("runtime.cancelled")
    },
  })
}, 15_000)

test("the public API runs rich input through a real local provider and exact retry adds no work", async () => {
  let requests = 0
  using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.json()
      requests++
      const chunk = (content: string, finish: string | null) =>
        `data: ${JSON.stringify({ id: "chatcmpl-runtime", object: "chat.completion.chunk", created: 1, model: STRESS_PROVIDER_MODEL, choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`
      return new Response(chunk("Local fixture result.", null) + chunk("", "stop") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  await using tmp = await tmpdir({ git: true, config: stressProviderConfig(`${provider.url.origin}/v1`) })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await trustProject()
      await Provider.invalidate()
    },
    fn: async () => {
      const session = await Session.create({ title: "Runtime contract fixture" })
      using api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => Server.App().fetch(request) })
      const runtime = createOpenScienceRuntime({ baseUrl: api.url.origin, directory: tmp.path })
      expect((await runtime.capabilities()).protocolVersion).toBe("1.0")

      const input: RuntimePromptInput = {
        sessionID: session.id,
        requestID: "public-external-client",
        effort: "normal" as const,
        model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
        delegation: false,
        parts: [
          { type: "text", text: "Inspect this local fixture." },
          { type: "file", mime: "text/plain", filename: "data.txt", url: "data:text/plain;base64,MSwyLDM=" },
        ],
      }
      const accepted = await runtime.prompt(input)
      const run = await runtime.wait({
        sessionID: session.id,
        runID: accepted.runID,
        intervalMs: 10,
        signal: AbortSignal.timeout(10_000),
      })
      expect(run).toMatchObject({ state: "completed" })
      expect(run.messageID).toStartWith("msg_")
      expect(run.resultMessageID).toStartWith("msg_")
      const messages = await Session.messages({ sessionID: session.id })
      expect(messages.filter((message) => message.info.role === "user")).toHaveLength(1)
      expect(
        messages
          .flatMap((message) => message.parts)
          .some((part) => part.type === "text" && part.text.includes("Local fixture result.")),
      ).toBe(true)
      const before = requests
      expect(await runtime.prompt(input)).toEqual(accepted)
      expect(requests).toBe(before)
      expect(await runtime.snapshot({ sessionID: session.id })).toMatchObject({
        runs: [run],
        permissions: [],
        questions: [],
        decisionScope: "connected_runtime",
      })
      const events = await runtime.replay({ sessionID: session.id })
      expect(events.events.filter((event) => event.type === "runtime.accepted")).toHaveLength(1)
      expect(events.events.at(-1)?.type).toBe("runtime.completed")
      const stop = new AbortController()
      const streamed: number[] = []
      for await (const event of runtime.events({ sessionID: session.id, afterSequence: 0, signal: stop.signal })) {
        streamed.push(event.sequence)
        if (event.type === "runtime.completed") stop.abort()
      }
      expect(streamed).toEqual(events.events.map((event) => event.sequence))
      expect((await runtime.cancel({ sessionID: session.id, runID: accepted.runID })).state).toBe("completed")
      const python = Bun.spawn(
        [
          "python3",
          path.resolve(import.meta.dir, "../../../../tooling/sdk/python/tests/server_conformance.py"),
          api.url.origin,
          "--fixture-model",
          `${STRESS_PROVIDER_ID}/${STRESS_PROVIDER_MODEL}`,
        ],
        {
          env: {
            ...process.env,
            PYTHONPATH: path.resolve(import.meta.dir, "../../../../tooling/sdk/python"),
            OPENSCIENCE_CLIENT_DIRECTORY: tmp.path,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, output, error] = await Promise.all([
        python.exited,
        new Response(python.stdout).text(),
        new Response(python.stderr).text(),
      ])
      if (code !== 0) throw new Error(`Python fixture failed: ${output} ${error}`)
      expect(output).toContain("fixture")

      await expect(
        runtime.prompt({ ...input, requestID: "new-request-same-message", messageID: run.messageID }),
      ).rejects.toMatchObject({ error: "request_conflict" })
    },
  })
}, 30_000)
