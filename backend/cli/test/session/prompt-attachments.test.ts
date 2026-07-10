import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir } from "../fixture/fixture"

describe("session prompt text attachments", () => {
  test.each([
    ["text/plain", "notes.txt", "plain text"],
    ["text/markdown", "notes.md", "# Markdown\n\nResearch notes"],
  ])(
    "decodes %s data URLs into model text",
    async (mime, filename, content) => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const result = await SessionPrompt.prompt({
            sessionID: session.id,
            noReply: true,
            agent: "research",
            model: { providerID: "test", modelID: "test" },
            parts: [
              {
                type: "file",
                mime,
                filename,
                url: `data:${mime};base64,${Buffer.from(content).toString("base64")}`,
              },
            ],
          })

          expect(result.parts).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ type: "text", synthetic: true, text: content }),
              expect.objectContaining({ type: "file", mime, filename }),
            ]),
          )
        },
      })
    },
    15_000,
  )
})
