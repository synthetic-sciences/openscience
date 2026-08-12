import { afterEach, expect, test } from "bun:test"
import { Network } from "../../src/settings/network"
import { WebFetchTool } from "../../src/tool/webfetch"
import type { Tool } from "../../src/tool/tool"

const realFetch = globalThis.fetch

function context(ask: Tool.Context["ask"]): Tool.Context {
  return {
    sessionID: "session_test",
    messageID: "message_test",
    agent: "research",
    abort: new AbortController().signal,
    extra: {},
    messages: [],
    metadata: () => {},
    ask,
  }
}

afterEach(async () => {
  globalThis.fetch = realFetch
  await Network.set({ allowlistEnabled: false, enabled: ["package-management"], custom: [] })
})

test("webfetch asks before reaching a blocked host and fails closed on deny", async () => {
  await Network.set({ allowlistEnabled: true, enabled: [], custom: ["allowed.test"] })
  const webfetch = await WebFetchTool.init()

  const asked: Parameters<Tool.Context["ask"]>[0][] = []
  const ctx = context(async (input) => {
    asked.push(input)
    throw new Error("denied by user")
  })

  await expect(webfetch.execute({ url: "https://blocked.test", format: "markdown" }, ctx)).rejects.toThrow(
    "denied by user",
  )
  expect(asked).toHaveLength(1)
  expect(asked[0].permission).toBe("network")
  expect(asked[0].patterns).toEqual(["blocked.test"])
  expect(asked[0].always).toEqual(["blocked.test"])
})

test("Network.blocked and Network.allow round-trip the allow-list", async () => {
  await Network.set({ allowlistEnabled: true, enabled: [], custom: [] })
  expect(await Network.blocked("https://example.test/data")).toBe("example.test")

  await Network.allow("example.test")
  expect(await Network.blocked("https://example.test/data")).toBeUndefined()
  expect((await Network.get()).custom).toEqual(["example.test"])

  // Enforcement off: nothing is blocked, but invalid URLs still throw.
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  expect(await Network.blocked("https://other.test")).toBeUndefined()
  await expect(Network.blocked("not a url")).rejects.toThrow("Invalid network URL")
})

test("webfetch asks for every blocked redirect target before following it", async () => {
  await Network.set({ allowlistEnabled: true, enabled: [], custom: ["example.com"] })
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.startsWith("https://example.com")) {
      return new Response(null, { status: 302, headers: { Location: "https://example.org/result" } })
    }
    return new Response("result", { headers: { "content-type": "text/plain" } })
  }) as typeof fetch
  const asked: Parameters<Tool.Context["ask"]>[0][] = []
  const webfetch = await WebFetchTool.init()
  const result = await webfetch.execute(
    { url: "https://example.com/start", format: "markdown" },
    context(async (input) => {
      asked.push(input)
    }),
  )

  expect(result.output).toBe("result")
  expect(calls).toHaveLength(2)
  expect(asked.map((item) => item.permission)).toEqual(["webfetch", "network"])
  expect(asked[1]?.patterns).toEqual(["example.org"])
})
