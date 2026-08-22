import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { SessionPrompt } from "../../src/session/prompt"
import { PermissionNext } from "../../src/permission/next"
import { tmpdir } from "../fixture/fixture"

const model = { providerID: "openai", modelID: "gpt-4o-mini" }

async function within<T>(label: string, promise: Promise<T>, timeout = 2_000) {
  const expired = Promise.withResolvers<never>()
  const timer = setTimeout(() => expired.reject(new Error(`${label} timed out`)), timeout)
  return Promise.race([promise, expired.promise]).finally(() => clearTimeout(timer))
}

describe("file prompt attachment authority", () => {
  test("denies an external file before attachment metadata or bytes are consumed", async () => {
    await using external = await tmpdir({
      init: (directory) => Bun.write(path.join(directory, "private.bin"), "private"),
    })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({
          permission: [
            { permission: "external_directory", pattern: "*", action: "deny" },
            { permission: "read", pattern: "*", action: "allow" },
          ],
        })
        const file = path.join(external.path, "private.bin")
        await expect(
          SessionPrompt.prompt({
            sessionID: session.id,
            model,
            agent: "research",
            noReply: true,
            parts: [
              {
                type: "file",
                url: pathToFileURL(file).href,
                filename: "private.bin",
                mime: "application/octet-stream",
              },
            ],
          }),
        ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
        await Session.remove(session.id)
      },
    })
  })

  test("retains a one-shot exact-file grant through the bounded attachment read", async () => {
    await using external = await tmpdir({
      init: (directory) => Bun.write(path.join(directory, "result.bin"), Uint8Array.from([1, 2, 3, 4])),
    })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const file = path.join(external.path, "result.bin")
        const pending = SessionPrompt.prompt({
          sessionID: session.id,
          model,
          agent: "research",
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
        const externalApproval = await within(
          "one-shot external approval",
          (async () => {
            for (const _ of Array.from({ length: 200 })) {
              const request = (await PermissionNext.list()).find((item) => item.sessionID === session.id)
              if (request) return request
              await Bun.sleep(5)
            }
            throw new Error("one-shot external approval was not requested")
          })(),
        )
        expect(externalApproval.permission).toBe("external_directory")
        await PermissionNext.reply({ requestID: externalApproval.id, reply: "once" })
        const message = await within("one-shot attachment prompt", pending)
        expect(message.parts.find((part) => part.type === "file")?.url).toBe(
          "data:application/octet-stream;base64,AQIDBA==",
        )
        await expect(
          within(
            "second one-shot authorization",
            SessionFilesystem.authorize({ sessionID: session.id, path: file, access: "read" }),
          ),
        ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
        expect(
          (await SessionFilesystem.list(session.id)).some((item) => item.scope === "once" && item.time.consumed),
        ).toBe(true)
        await within("one-shot session removal", Session.remove(session.id))
      },
    })
  }, 10_000)

  test("lets grant revocation win before attachment stat or read", async () => {
    await using external = await tmpdir({
      init: (directory) => Bun.write(path.join(directory, "result.bin"), Uint8Array.from([5, 6, 7, 8])),
    })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const file = path.join(external.path, "result.bin")
        const grant = await SessionFilesystem.grant({
          sessionID: session.id,
          path: file,
          access: "read",
          scope: "session",
        })
        using _ = SessionPrompt.testing({
          afterAttachmentAuthorization: () => SessionFilesystem.revoke(session.id, grant.id).then(() => undefined),
        })
        await expect(
          SessionPrompt.prompt({
            sessionID: session.id,
            model,
            agent: "research",
            noReply: true,
            parts: [
              { type: "file", url: pathToFileURL(file).href, filename: "result.bin", mime: "application/octet-stream" },
            ],
          }),
        ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
        await Session.remove(session.id)
      },
    })
  })

  test("rejects an oversized attachment before allocating or encoding its body", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (directory) => {
        const file = await fs.open(path.join(directory, "large.bin"), "w")
        await file.truncate(32 * 1024 * 1024 + 1)
        await file.close()
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const file = path.join(tmp.path, "large.bin")
        await expect(
          SessionPrompt.prompt({
            sessionID: session.id,
            model,
            agent: "research",
            noReply: true,
            parts: [
              { type: "file", url: pathToFileURL(file).href, filename: "large.bin", mime: "application/octet-stream" },
            ],
          }),
        ).rejects.toThrow("Attachment too large")
        await Session.remove(session.id)
      },
    })
  })
})
