import { describe, expect, test } from "bun:test"
import { exchangeTerminalCode, takeTerminalCode } from "./terminal-key"

describe("takeTerminalCode", () => {
  test("reads the launch code and removes only it from the address", () => {
    const replaced: string[] = []
    const history = {
      state: { from: "launcher" },
      replaceState: (_: unknown, __: string, url: string) => void replaced.push(url),
    }
    const code = takeTerminalCode(
      { pathname: "/L2hvbWU/session", search: "?desktop=1", hash: "#terminal-code=abc123&panel=files" },
      history as unknown as History,
    )
    expect(code).toBe("abc123")
    expect(replaced).toEqual(["/L2hvbWU/session?desktop=1#panel=files"])
  })

  test("leaves the address alone when no code is present", () => {
    const replaced: string[] = []
    const history = { state: null, replaceState: (_: unknown, __: string, url: string) => void replaced.push(url) }
    expect(
      takeTerminalCode({ pathname: "/", search: "", hash: "#panel=files" }, history as unknown as History),
    ).toBeUndefined()
    expect(replaced).toEqual([])
  })
})

describe("exchangeTerminalCode", () => {
  test("posts the code with credentials and reports acceptance", async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response("true", { headers: { "content-type": "application/json" } })
    }) as unknown as typeof globalThis.fetch
    expect(await exchangeTerminalCode({ code: "abc123", url: "http://localhost:4096/pty/key", fetch })).toBe(true)
    expect(calls[0]?.init).toMatchObject({ method: "POST", credentials: "include", body: '{"code":"abc123"}' })
  })

  test("treats a refusal or a failure as no key", async () => {
    const refused = (async () => new Response("false")) as unknown as typeof globalThis.fetch
    const failed = (async () => {
      throw new Error("offline")
    }) as unknown as typeof globalThis.fetch
    expect(await exchangeTerminalCode({ code: "x", url: "http://localhost/pty/key", fetch: refused })).toBe(false)
    expect(await exchangeTerminalCode({ code: "x", url: "http://localhost/pty/key", fetch: failed })).toBe(false)
  })
})
