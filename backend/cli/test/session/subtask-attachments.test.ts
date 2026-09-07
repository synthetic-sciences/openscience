import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { SubtaskAttachments } from "../../src/session/subtask-attachments"
import { PermissionNext } from "../../src/permission/next"
import { ReadTool } from "../../src/tool/read"
import { SafeFileIO } from "../../src/file/safe-io"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

const model = { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL }
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8S8AAAAASUVORK5CYII="

test("materialization bounds Unicode filenames and refuses a replaced attachment symlink", async () => {
  await using tmp = await tmpdir({ git: true })
  await using external = await tmpdir({
    init: (directory) => Bun.write(path.join(directory, "private.txt"), "unchanged"),
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      const input = [
        {
          type: "file" as const,
          filename: "测".repeat(80) + ".txt",
          mime: "text/plain",
          url: "data:text/plain;base64,YWJj",
        },
      ]
      const result = await SubtaskAttachments.materialize(input, child.id, AbortSignal.any([]))
      const destination = fileURLToPath(result[0]!.url)
      expect(result[0]!.filename).toBe(input[0]!.filename)
      expect(Buffer.byteLength(path.basename(destination))).toBeLessThanOrEqual(255)
      expect(destination.startsWith(await SessionFilesystem.workspace(child.id))).toBe(true)
      expect(await Bun.file(destination).text()).toBe("abc")
      expect(await SubtaskAttachments.materialize(input, child.id, AbortSignal.any([]))).toEqual(result)
      await fs.unlink(destination)
      await fs.symlink(path.join(external.path, "private.txt"), destination)
      await expect(SubtaskAttachments.materialize(input, child.id, AbortSignal.any([]))).rejects.toThrow()
      expect(await Bun.file(path.join(external.path, "private.txt")).text()).toBe("unchanged")
      await Session.remove(parent.id)
    },
  })
})

function provider() {
  const requests: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json())
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-attachment",
          object: "chat.completion.chunk",
          created: 1,
          model: STRESS_PROVIDER_MODEL,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
      return new Response(
        chunk({ role: "assistant", content: "ATTACHMENT_HANDOFF" }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const config = stressProviderConfig(`${server.url.origin}/v1`)
  return {
    server,
    requests,
    config: {
      ...config,
      agent: { title: { disable: true } },
      command: {
        inspect: { template: "Inspect the uploaded measurements and image", agent: "explore", subtask: true },
      },
      provider: {
        ...config.provider,
        stress: {
          ...config.provider.stress,
          models: {
            ...config.provider.stress.models,
            [STRESS_PROVIDER_MODEL]: {
              ...config.provider.stress.models[STRESS_PROVIDER_MODEL],
              modalities: { input: ["text", "image"] as ["text", "image"], output: ["text"] as ["text"] },
            },
          },
        },
      },
    },
  }
}

test.each(["isolated", "project"] as const)(
  "%s parent subtask commands preserve uploads in the real child prompt and materialize exact readable child files",
  async (mode) => {
    const fixture = provider()
    using server = fixture.server
    await using tmp = await tmpdir({ git: true, config: fixture.config })
    await Instance.provide({
      directory: tmp.path,
      init: trustProject,
      fn: async () => {
        const parent = await Session.create({ title: "Attachment parent", workspace: mode })
        const projectInput = path.join(tmp.path, "project-input.txt")
        await Bun.write(projectInput, "existing project evidence")
        const result = await SessionPrompt.command({
          sessionID: parent.id,
          model: `${model.providerID}/${model.modelID}`,
          command: "inspect",
          arguments: "",
          parts: [
            {
              type: "file",
              filename: "measurements.txt",
              mime: "text/plain",
              url: "data:text/plain;base64,bWVhc3VyZW1lbnQ6IDQy",
            },
            { type: "file", filename: "plot.png", mime: "image/png", url: `data:image/png;base64,${image}` },
          ],
        })
        expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
        const children = (await Array.fromAsync(Session.list())).filter((session) => session.parentID === parent.id)
        expect(children).toHaveLength(1)
        const child = children[0]!
        const workspace = await SessionFilesystem.workspace(child.id)
        expect(workspace).not.toBe(tmp.path)
        expect(workspace).not.toBe(await SessionFilesystem.workspace(parent.id))
        const read = await (
          await ReadTool.init()
        ).execute(
          { filePath: projectInput },
          {
            sessionID: child.id,
            messageID: "msg_child_project_read",
            agent: "explore",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            ask: async () => {},
          },
        )
        expect(read.output).toContain("existing project evidence")
        const files = (await fs.readdir(workspace)).filter((name) => name.startsWith(".task-attachment-"))
        expect(files).toHaveLength(2)
        expect((await fs.readdir(tmp.path)).some((name) => name.startsWith(".task-attachment-"))).toBe(false)
        const textPath = path.join(
          workspace,
          files.find((name) => name.endsWith("measurements.txt"))!,
        )
        expect(await Bun.file(textPath).text()).toBe("measurement: 42")
        expect(
          await Bun.file(
            path.join(
              workspace,
              files.find((name) => name.endsWith("plot.png"))!,
            ),
          ).bytes(),
        ).toEqual(Uint8Array.from(Buffer.from(image, "base64")))
        const childMessages = await Session.messages({ sessionID: child.id })
        const user = childMessages.find((message) => message.info.role === "user")!
        expect(user.parts).toContainEqual(
          expect.objectContaining({ type: "file", mime: "image/png", url: `data:image/png;base64,${image}` }),
        )
        expect(user.parts.some((part) => part.type === "text" && part.text.includes("measurement: 42"))).toBe(true)
        expect(JSON.stringify(fixture.requests[0])).toContain("measurement: 42")
        expect(JSON.stringify(fixture.requests[0])).toContain(image)
        const sibling = await Session.create({})
        await expect(
          SessionFilesystem.authorize({ sessionID: sibling.id, path: textPath, access: "read" }),
        ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)

        // A crash after the child result but before the wrapper write must recover
        // with the same attachment fingerprint and must not execute another child.
        const parentMessages = await Session.messages({ sessionID: parent.id })
        const wrapper = parentMessages
          .flatMap((message) => message.parts)
          .find((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "task")!
        if (wrapper.state.status !== "completed") throw new Error("Expected completed Task wrapper")
        const requests = fixture.requests.length
        await Session.updatePart({
          ...wrapper,
          state: { status: "running", input: wrapper.state.input, time: { start: wrapper.state.time.start } },
        })
        await SessionPrompt.loop(parent.id)
        expect(fixture.requests).toHaveLength(requests)
        expect((await MessageV2.parts(wrapper.messageID)).find((part) => part.id === wrapper.id)).toMatchObject({
          state: { status: "completed" },
        })
        await Session.remove(sibling.id)
        await Session.remove(parent.id)
      },
    })
  },
  20_000,
)

test("a one-shot parent file grant becomes a durable byte snapshot without granting the child the original path", async () => {
  const fixture = provider()
  using server = fixture.server
  await using external = await tmpdir({
    init: (directory) => Bun.write(path.join(directory, "measurements.txt"), "original approved bytes"),
  })
  await using tmp = await tmpdir({ git: true, config: fixture.config })
  await Instance.provide({
    directory: tmp.path,
    init: trustProject,
    fn: async () => {
      const parent = await Session.create({ permission: [{ permission: "read", pattern: "*", action: "allow" }] })
      const source = path.join(external.path, "measurements.txt")
      const preparation = SessionPrompt.controlled({
        sessionID: parent.id,
        model,
        noReply: true,
        parts: [
          {
            type: "subtask",
            agent: "explore",
            prompt: "Inspect the file",
            description: "Inspect measurements",
            attachments: [
              { type: "file", mime: "text/plain", filename: "measurements.txt", url: pathToFileURL(source).href },
            ],
          },
        ],
      })
      void preparation.catch(() => undefined)
      const prepared = await (async () => {
        try {
          for (let attempt = 0; attempt < 200; attempt++) {
            const approval = (await PermissionNext.list()).find((request) => request.sessionID === parent.id)
            if (!approval) {
              await Bun.sleep(5)
              continue
            }
            expect(approval.permission).toBe("external_directory")
            await PermissionNext.reply({ requestID: approval.id, reply: "once" })
            return await preparation
          }
          throw new Error("No attachment permission request arrived")
        } finally {
          SessionPrompt.cancel(parent.id)
          await preparation.catch(() => undefined)
        }
      })()
      const subtask = prepared.parts.find((part) => part.type === "subtask")!
      expect(subtask.attachments?.[0]?.url).toBe(
        `data:text/plain;base64,${Buffer.from("original approved bytes").toString("base64")}`,
      )
      await expect(
        SessionFilesystem.authorize({ sessionID: parent.id, path: source, access: "read" }),
      ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
      await Bun.write(source, "changed after approval")
      await SessionPrompt.loop(parent.id)
      const child = (await Array.fromAsync(Session.list())).find((session) => session.parentID === parent.id)!
      const file = (await Session.messages({ sessionID: child.id }))
        .flatMap((message) => message.parts)
        .find((part) => part.type === "file" && part.mime === "text/plain")!
      expect(file.type).toBe("file")
      if (file.type !== "file") throw new Error("Expected file")
      expect(fileURLToPath(file.url).startsWith(await SessionFilesystem.workspace(child.id))).toBe(true)
      const output = await (
        await ReadTool.init()
      ).execute(
        { filePath: fileURLToPath(file.url) },
        {
          sessionID: child.id,
          messageID: file.messageID,
          agent: "explore",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        },
      )
      expect(output.output).toContain("original approved bytes")
      expect(output.output).not.toContain("changed after approval")
      await expect(
        SessionFilesystem.authorize({ sessionID: child.id, path: source, access: "read" }),
      ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
      await Session.remove(parent.id)
    },
  })
}, 20_000)

test("subtask attachment authorization denies and respects revocation before consuming bytes", async () => {
  await using external = await tmpdir({
    init: (directory) => Bun.write(path.join(directory, "private.txt"), "private"),
  })
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({
        permission: [{ permission: "external_directory", pattern: "*", action: "deny" }],
      })
      const source = path.join(external.path, "private.txt")
      const input = {
        sessionID: parent.id,
        model: { providerID: "openai", modelID: "gpt-4o-mini" },
        noReply: true,
        parts: [
          {
            type: "subtask" as const,
            agent: "explore",
            prompt: "Inspect",
            description: "Inspect",
            attachments: [{ type: "file" as const, mime: "text/plain", url: pathToFileURL(source).href }],
          },
        ],
      }
      await expect(SessionPrompt.prompt(input)).rejects.toBeInstanceOf(PermissionNext.DeniedError)
      expect(await Session.messages({ sessionID: parent.id })).toHaveLength(0)
      const grant = await SessionFilesystem.grant({
        sessionID: parent.id,
        path: source,
        access: "read",
        scope: "session",
      })
      using hook = SessionPrompt.testing({
        afterAttachmentAuthorization: () => SessionFilesystem.revoke(parent.id, grant.id).then(() => undefined),
      })
      await expect(SessionPrompt.prompt(input)).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
      expect(await Session.messages({ sessionID: parent.id })).toHaveLength(0)
      await Session.remove(parent.id)
    },
  })
})

test("cancelling delegated attachment preparation before the read leaves no message or child", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: (directory) => Bun.write(path.join(directory, "pending.txt"), "pending"),
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let reads = 0
      using read = SafeFileIO.testing({
        afterReadStat: () => {
          reads++
        },
      })
      using hook = SessionPrompt.testing({
        afterAttachmentAuthorization: async () => {
          entered.resolve()
          await release.promise
        },
      })
      const preparing = SessionPrompt.controlled({
        sessionID: parent.id,
        noReply: true,
        model: { providerID: "openai", modelID: "gpt-4o-mini" },
        parts: [
          {
            type: "subtask",
            agent: "explore",
            prompt: "Inspect",
            description: "Inspect",
            attachments: [
              { type: "file", mime: "text/plain", url: pathToFileURL(path.join(tmp.path, "pending.txt")).href },
            ],
          },
        ],
      })
      void preparing.catch(() => undefined)
      try {
        await entered.promise
        SessionPrompt.cancel(parent.id)
        await expect(preparing).rejects.toThrow()
        release.resolve()
        await Bun.sleep(10)
        expect(reads).toBe(0)
        expect(await Session.messages({ sessionID: parent.id })).toHaveLength(0)
        expect(await Session.children(parent.id)).toHaveLength(0)
      } finally {
        release.resolve()
        SessionPrompt.cancel(parent.id)
        await preparing.catch(() => undefined)
        await Session.remove(parent.id)
      }
    },
  })
})

test("subtask uploads reject unsupported forms and actual oversized bytes before prompt persistence", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (directory) => {
      const file = await fs.open(path.join(directory, "large.bin"), "w")
      await file.truncate(SubtaskAttachments.LIMIT + 1)
      await file.close()
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const base = { sessionID: parent.id, model: { providerID: "openai", modelID: "gpt-4o-mini" }, noReply: true }
      const submit = (attachment: MessageV2.SubtaskAttachment) =>
        SessionPrompt.prompt({
          ...base,
          parts: [
            { type: "subtask", agent: "explore", prompt: "Inspect", description: "Inspect", attachments: [attachment] },
          ],
        })
      for (const attachment of [
        { type: "file" as const, mime: "text/plain", url: "https://example.invalid/private" },
        { type: "file" as const, mime: "application/x-directory", url: pathToFileURL(tmp.path).href },
      ])
        await expect(submit(attachment)).rejects.toThrow("Upload the file contents")
      await expect(
        submit({
          type: "file",
          mime: "application/octet-stream",
          url: pathToFileURL(path.join(tmp.path, "large.bin")).href,
        }),
      ).rejects.toThrow("32 MiB byte limit")
      const upload = {
        type: "file" as const,
        mime: "application/octet-stream",
        url:
          "data:application/octet-stream;base64," + Buffer.alloc(SubtaskAttachments.LIMIT / 2 + 1).toString("base64"),
      }
      await expect(
        SessionPrompt.prompt({
          ...base,
          parts: [
            {
              type: "subtask",
              agent: "explore",
              prompt: "Inspect",
              description: "Inspect",
              attachments: [upload, upload],
            },
          ],
        }),
      ).rejects.toThrow("32 MiB byte limit")
      expect(await Session.messages({ sessionID: parent.id })).toHaveLength(0)
      await Session.remove(parent.id)
    },
  })
  expect(SubtaskAttachments.decode("data:application/octet-stream,%00%ff%C3%A9")).toEqual(
    Buffer.from([0, 255, 195, 169]),
  )
  expect(SubtaskAttachments.decode("data:text/plain,é")).toEqual(Buffer.from("é"))
  expect(() =>
    SubtaskAttachments.decode(
      "data:application/octet-stream;base64," + Buffer.alloc(SubtaskAttachments.LIMIT + 1).toString("base64"),
    ),
  ).toThrow("32 MiB byte limit")
  expect(() => SubtaskAttachments.decode("data:text/plain,%ZZ")).toThrow("percent encoding")
  expect(() => SubtaskAttachments.decode("data:text/plain;base64,not-base64!")).toThrow("base64")
})
