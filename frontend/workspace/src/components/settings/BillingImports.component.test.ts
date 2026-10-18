import { afterAll, afterEach, expect, test } from "bun:test"
import { createServer } from "node:http"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../../test/vite"

const vite = await createTestServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const subject = (await vite.ssrLoadModule(
  "/src/components/settings/BillingImports.tsx",
)) as typeof import("./BillingImports")
const cleanups: (() => void)[] = []
const ready = async (predicate: () => boolean) => {
  for (let index = 0; index < 100 && !predicate(); index++) await Bun.sleep(10)
  expect(predicate()).toBe(true)
}
afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})
async function mount() {
  const state = { input: undefined as unknown, imported: false, changed: 0, requests: [] as string[] }
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url!, "http://localhost").pathname
    state.requests.push(`${request.method} ${pathname}`)
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Content-Type": "application/json",
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers)
      response.end()
      return
    }
    response.writeHead(200, headers)
    const batch = {
      id: "a".repeat(64),
      provider: "openai",
      accountLabel: "Provider account",
      importedAt: "2026-10-18T00:00:00Z",
      records: 2,
    }
    if (request.method === "POST") {
      const chunks: Uint8Array[] = []
      for await (const chunk of request) chunks.push(chunk)
      state.input = JSON.parse(Buffer.concat(chunks).toString())
      state.imported = true
      response.end(JSON.stringify(batch))
      return
    }
    if (request.method === "DELETE") {
      state.imported = false
      response.end("true")
      return
    }
    response.end(
      JSON.stringify(
        pathname.endsWith("/imports")
          ? state.imported
            ? [batch]
            : []
          : state.imported
            ? [
                { id: "record-one", match: "matched" },
                { id: "record-two", match: "unmatched" },
              ]
            : [],
      ),
    )
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing server address")
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(
    web.render(
      () =>
        subject.BillingImports({
          base: `http://127.0.0.1:${address.port}`,
          fetch,
          start: "2026-10-18",
          end: "2026-10-18",
          changed: () => state.changed++,
        }),
      host,
    ),
    () => {
      server.closeAllConnections()
      server.close()
    },
  )
  const button = (name: string) => [...host.querySelectorAll("button")].find((element) => element.textContent === name)!
  return { state, host, button }
}
async function file(host: HTMLElement, content: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
  const transfer = new DataTransfer()
  transfer.items.add(new File([content], "provider.json", { type: "application/json" }))
  input.files = transfer.files
  input.dispatchEvent(new Event("change", { bubbles: true }))
}

test("imports are explicit, post the selected JSON and expose reconciliation and removal", async () => {
  const { state, host, button } = await mount()
  expect(state.requests).toEqual([])
  button("Manage billing imports").click()
  await ready(() => state.requests.some((value) => value.includes("/billing")))
  const document = { schema_version: 1, provider: "openai", currency: "USD", records: [] }
  await file(host, JSON.stringify(document))
  await ready(() => host.textContent!.includes("1 matched · 1 unmatched"))
  expect(state.input).toEqual(document)
  expect(state.changed).toBe(1)
  expect(host.textContent).toContain("Provider account")
  button("Remove import").click()
  await ready(() => state.changed === 2 && !host.textContent!.includes("Provider account · 2 records"))
  expect(state.imported).toBe(false)
})

test("malformed JSON never posts billing evidence", async () => {
  const { state, host, button } = await mount()
  button("Manage billing imports").click()
  await file(host, "{truncated")
  await ready(() => host.textContent!.includes("valid JSON billing document"))
  expect(state.requests.some((request) => request.startsWith("POST"))).toBe(false)
})
