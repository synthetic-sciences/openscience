import { describe, expect, test } from "bun:test"
import { fetchSetupSession } from "./setup-session"

describe("fetchSetupSession", () => {
  test("reads local session state from the selected server", async () => {
    let request: { url?: string; init?: RequestInit } = {}
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      request = { url: String(url), init }
      return Response.json({ session: true })
    }) as typeof fetch

    await expect(fetchSetupSession("http://127.0.0.1:4100/", fetchFn)).resolves.toBe(true)
    expect(request.url).toBe("http://127.0.0.1:4100/account/session")
    expect(request.init?.headers).toEqual({ accept: "application/json" })
    expect(request.init?.signal).toBeInstanceOf(AbortSignal)
  })

  test("treats an explicit signed-out response as signed out", async () => {
    const fetchFn = (async () => Response.json({ session: false })) as unknown as typeof fetch

    await expect(fetchSetupSession("http://localhost:4096", fetchFn)).resolves.toBe(false)
  })

  test("rejects failed checks so the gate can fail open", async () => {
    const fetchFn = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch

    await expect(fetchSetupSession("http://localhost:4096", fetchFn)).rejects.toThrow("Session check failed: 503")
  })
})
