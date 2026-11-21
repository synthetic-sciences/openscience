import { expect, test } from "bun:test"
import { Auth } from "../../src/auth"
import { CodexAuthPlugin } from "../../src/plugin/codex"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

const SUMMARY = "Context compacted by Codex.\n\nUser messages kept from before the compaction:\n\nfix the parser"
const ITEM = { type: "compaction", encrypted_content: "ENCRYPTED-HISTORY" }
const record = (item: Record<string, unknown>, kept = ["fix the parser", "and keep the API stable"]) => ({
  item,
  summaryText: SUMMARY,
  keptUserMessages: kept,
})

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

async function capture(
  url: string,
  sessionID: string,
  stored: Array<{ key: string; value: ReturnType<typeof record> }>,
  respond: (sent: any, attempt: number) => Response = () => new Response("{}"),
) {
  await using tmp = await tmpdir()
  return await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      for (const item of stored)
        await Storage.write(["foreign_compaction", Instance.project.id, sessionID, item.key], item.value)
      const previous = { auth: await Auth.get("openai-codex"), fetch: globalThis.fetch }
      await Auth.set("openai-codex", { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3600000 })
      const sent: any[] = []
      globalThis.fetch = (async (_input, init) => {
        const parsed = JSON.parse(String(init?.body))
        sent.push(parsed)
        return respond(parsed, sent.length)
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
        const response = await Provider.withRequestContext({ sessionID, messageID: "msg_1", attempt: 1 }, () =>
          send(url, { method: "POST", body: JSON.stringify(body()) }),
        )
        return { sent, status: response.status }
      } finally {
        globalThis.fetch = previous.fetch
        if (previous.auth) await Auth.set("openai-codex", previous.auth)
        else await Auth.remove("openai-codex")
      }
    },
  })
}

test("an imported Codex compaction is replayed as kept user messages plus the encrypted item", async () => {
  const { sent } = await capture("https://api.openai.com/v1/responses", "ses_imported", [
    { key: "prt_1", value: record(ITEM) },
  ])
  expect(sent[0].input).toEqual([
    { role: "user", content: [{ type: "input_text", text: "fix the parser" }] },
    { role: "user", content: [{ type: "input_text", text: "and keep the API stable" }] },
    ITEM,
    { role: "user", content: [{ type: "input_text", text: "now add tests" }] },
  ])
})

test("with two compactions sharing a summary, the newest encrypted item is sent", async () => {
  const { sent } = await capture("https://api.openai.com/v1/responses", "ses_imported", [
    { key: "prt_1", value: record({ type: "compaction", encrypted_content: "OLD" }) },
    { key: "prt_2", value: record({ type: "compaction", encrypted_content: "NEW" }) },
  ])
  const items = sent[0].input.filter((item: any) => item.type === "compaction")
  expect(items).toEqual([{ type: "compaction", encrypted_content: "NEW" }])
})

test("a rejected replay is retried once with the readable summary", async () => {
  const { sent, status } = await capture(
    "https://api.openai.com/v1/responses",
    "ses_imported",
    [{ key: "prt_1", value: record(ITEM) }],
    (parsed) =>
      JSON.stringify(parsed).includes("ENCRYPTED-HISTORY")
        ? Response.json({ error: { message: "invalid encrypted content" } }, { status: 400 })
        : new Response("{}"),
  )
  expect(status).toBe(200)
  expect(sent).toHaveLength(2)
  expect(sent[1].input).toEqual(body().input)
})

test("a session without stored items is unchanged", async () => {
  const { sent } = await capture("https://api.openai.com/v1/responses", "ses_plain", [])
  expect(sent[0].input).toEqual(body().input)
})

test("a non-Codex URL is unchanged", async () => {
  const { sent } = await capture("https://api.openai.com/v1/embeddings", "ses_imported", [
    { key: "prt_1", value: record(ITEM) },
  ])
  expect(sent[0].input).toEqual(body().input)
})
