import { expect, test } from "bun:test"
import { Auth } from "../../src/auth"
import { CodexAuthPlugin } from "../../src/plugin/codex"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

const SUMMARY = "Context compacted by Codex.\n\nUser messages kept from before the compaction:\n\nfix the parser"
const ITEM = { type: "compaction", encrypted_content: "ENCRYPTED-HISTORY" }

const body = () => ({
  model: "gpt-6-codex",
  instructions: "x",
  store: false,
  input: [
    { role: "user", content: [{ type: "input_text", text: "What did we do so far?" }] },
    { role: "assistant", content: [{ type: "output_text", text: SUMMARY }] },
    { role: "user", content: [{ type: "input_text", text: "now add tests" }] },
  ],
})

async function capture(url: string, sessionID: string, store: boolean) {
  await using tmp = await tmpdir()
  return await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      if (store) {
        await Storage.write(["foreign_compaction", Instance.project.id, sessionID, "prt_1"], {
          item: ITEM,
          summaryText: SUMMARY,
          keptUserMessages: ["fix the parser", "and keep the API stable"],
        })
      }
      const previous = { auth: await Auth.get("openai-codex"), fetch: globalThis.fetch }
      await Auth.set("openai-codex", { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3600000 })
      let sent: unknown
      globalThis.fetch = (async (_input, init) => {
        sent = JSON.parse(String(init?.body))
        return new Response("{}")
      }) as typeof fetch
      try {
        const plugin = await CodexAuthPlugin()
        const options = await plugin.auth!.loader!(() => Auth.get("openai-codex"), {
          id: "openai-codex",
          name: "ChatGPT",
          source: "custom",
          env: [],
          options: {},
          models: {},
        })
        const send = options.fetch as (input: string, init: RequestInit) => Promise<Response>
        await Provider.withRequestContext({ sessionID, messageID: "msg_1", attempt: 1 }, () =>
          send(url, { method: "POST", body: JSON.stringify(body()) }),
        )
        return sent as { input: unknown[] }
      } finally {
        globalThis.fetch = previous.fetch
        if (previous.auth) await Auth.set("openai-codex", previous.auth)
        else await Auth.remove("openai-codex")
      }
    },
  })
}

test("an imported Codex compaction is replayed as kept user messages plus the encrypted item", async () => {
  const sent = await capture("https://api.openai.com/v1/responses", "ses_imported", true)
  expect(sent.input).toEqual([
    { role: "user", content: [{ type: "input_text", text: "fix the parser" }] },
    { role: "user", content: [{ type: "input_text", text: "and keep the API stable" }] },
    ITEM,
    { role: "user", content: [{ type: "input_text", text: "now add tests" }] },
  ])
})

test("a session without stored items is unchanged", async () => {
  const sent = await capture("https://api.openai.com/v1/responses", "ses_plain", false)
  expect(sent.input).toEqual(body().input)
})

test("a non-Codex URL is unchanged", async () => {
  const sent = await capture("https://api.openai.com/v1/embeddings", "ses_imported", true)
  expect(sent.input).toEqual(body().input)
})
