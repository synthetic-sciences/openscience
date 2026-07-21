import { describe, expect, test } from "bun:test"
import { settingsApi } from "./api"

const base = "http://x"
const path = "/settings/local"

describe("settingsApi", () => {
  test("throws a descriptive error when a 200 response is not JSON", async () => {
    const fetchFn = (async () =>
      new Response("<!doctype html><html></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as unknown as typeof fetch

    const error = await settingsApi<never>(base, fetchFn, path).catch((e: Error) => e)

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain("/settings/local")
    expect(error.message).toContain("Expected JSON")
    expect(error.message).not.toContain("Unexpected token")
  })

  test("resolves with parsed JSON on a normal 200 response", async () => {
    const fetchFn = (async () => Response.json({ ok: true }, { status: 200 })) as unknown as typeof fetch

    expect(await settingsApi<{ ok: boolean }>(base, fetchFn, path)).toEqual({ ok: true })
  })

  test("resolves with undefined on 204", async () => {
    const fetchFn = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch

    expect(await settingsApi(base, fetchFn, path)).toBeUndefined()
  })

  test("preserves the existing non-ok error path", async () => {
    const fetchFn = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch

    await expect(settingsApi(base, fetchFn, path)).rejects.toThrow(/boom|500/)
  })
})
