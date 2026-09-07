import { expect, test } from "bun:test"
import { OpenScience } from "../../src/openscience"
import { MANAGED_MODEL_DETAILS } from "../../src/provider/managed-catalog"
import { Provider } from "../../src/provider/provider"
import { ProviderTransform } from "../../src/provider/transform"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

// The pricing catalog is unavailable here, as it is until the first fetch
// lands after sign-in: the input contract must not depend on it.
const originalFetch = globalThis.fetch
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64")

test("Ace models advertise only the inputs the gateway envelope carries, and a PDF becomes a note", async () => {
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch
  await using tmp = await tmpdir({ config: { billing: { llm: "managed" } } })
  try {
    await OpenScience.saveSession({
      api_key: "osk_fixture_managed_inputs",
      user_id: "fixture",
      organization_id: "org_inputs",
      workspace_locked: true,
    })
    Provider.invalidate()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const provider = (await Provider.list()).openrouter
        expect(provider.source).toBe("managed")
        for (const [id, model] of Object.entries(provider.models)) {
          const reviewed = MANAGED_MODEL_DETAILS[id as keyof typeof MANAGED_MODEL_DETAILS]
          expect(model.capabilities.input.pdf).toBe(false)
          expect(model.capabilities.input.audio).toBe(false)
          expect(model.capabilities.input.video).toBe(false)
          expect(model.capabilities.input.image).toBe(reviewed.input.includes("image"))
        }
        // The upstream model reads documents and media natively; the route still cannot carry them.
        const gemini = provider.models["google/gemini-3.1-pro-preview"]
        expect(gemini.capabilities.attachment).toBe(true)
        const messages = ProviderTransform.message(
          [
            {
              role: "user",
              content: [
                { type: "text", text: "Summarize the attached paper." },
                {
                  type: "file",
                  mediaType: "application/pdf",
                  filename: "paper.pdf",
                  data: `data:application/pdf;base64,${Buffer.from("%PDF-1.4 fake").toString("base64")}`,
                },
                { type: "image", image: `data:image/png;base64,${png}` },
              ],
            },
          ] as any,
          gemini,
          {},
        )
        const content = messages[0].content as Array<{ type: string; text?: string }>
        expect(content.map((part) => part.type)).toEqual(["text", "text", "image"])
        expect(content[1].text).toContain('"paper.pdf"')
        expect(content[1].text).toContain("extract the text locally")
        expect(content[1].text).not.toContain("ERROR")
        // A text-only route still refuses an image as before.
        const nemotron = provider.models["nvidia/nemotron-3-ultra-550b-a55b"]
        const refused = ProviderTransform.message(
          [{ role: "user", content: [{ type: "image", image: `data:image/png;base64,${png}` }] }] as any,
          nemotron,
          {},
        )
        expect((refused[0].content as Array<{ type: string }>)[0].type).toBe("text")
      },
    })
  } finally {
    globalThis.fetch = originalFetch
    await OpenScience.clearSession()
    Provider.invalidate()
  }
})
