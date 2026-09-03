import { describe, expect, test } from "bun:test"
import { createProjectRequest } from "./openscience-fetch"

describe("project request boundary", () => {
  test("binds the opaque selector and checked root override to every fetch", async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), init })
      return Response.json({ ok: true })
    }) as typeof fetch
    const request = createProjectRequest({
      baseUrl: () => "http://127.0.0.1:4096",
      projectID: () => "prj_alpha",
      directory: () => "/work/alpha",
      fetch: () => fetcher,
    })

    await request(
      "/file/content?project=prj_wrong&directory=%2Fwork%2Fwrong",
      {
        headers: {
          "x-openscience-project": "prj_wrong",
          "x-openscience-directory": "/work/wrong",
        },
      },
      {
        projectID: "prj_wrong",
        directory: "/work/wrong",
        path: "results/table.csv",
      },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url.pathname).toBe("/file/content")
    expect(calls[0]!.url.searchParams.get("project")).toBeNull()
    expect(calls[0]!.url.searchParams.get("projectID")).toBeNull()
    expect(calls[0]!.url.searchParams.get("directory")).toBeNull()
    expect(calls[0]!.url.searchParams.get("path")).toBe("results/table.csv")
    const headers = new Headers(calls[0]!.init?.headers)
    expect(headers.get("x-openscience-project")).toBe("prj_alpha")
    expect(headers.get("x-openscience-directory")).toBe("/work/alpha")
  })

  test("drops a caller-supplied directory header when no root override is bound", async () => {
    const calls: Array<{ init?: RequestInit }> = []
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init })
      return Response.json({ ok: true })
    }) as typeof fetch
    const request = createProjectRequest({
      baseUrl: () => "http://127.0.0.1:4096",
      projectID: () => "prj_alpha",
      directory: () => "",
      fetch: () => fetcher,
    })

    await request("/file/content", { headers: { "x-openscience-directory": "/work/wrong" } })

    const headers = new Headers(calls[0]!.init?.headers)
    expect(headers.get("x-openscience-project")).toBe("prj_alpha")
    expect(headers.has("x-openscience-directory")).toBe(false)
  })

  test("uses bound query selectors only for direct transports", () => {
    const request = createProjectRequest({
      baseUrl: () => "http://127.0.0.1:4096",
      projectID: () => "prj_alpha",
      directory: () => "/work/alpha",
      fetch: () => fetch,
    })
    const url = new URL(
      request.url("/pty/pty_1/connect?project=prj_wrong&directory=%2Fwork%2Fwrong", {
        project: "prj_wrong",
      }),
    )

    expect(url.searchParams.get("project")).toBe("prj_alpha")
    expect(url.searchParams.get("directory")).toBe("/work/alpha")
  })

  test("rejects missing selectors and cross-server capability forwarding", () => {
    const missing = createProjectRequest({
      baseUrl: () => "http://127.0.0.1:4096",
      projectID: () => undefined,
      directory: () => "/work/alpha",
      fetch: () => fetch,
    })
    expect(() => missing.url("/file/raw")).toThrow("opaque project selector")

    const scoped = createProjectRequest({
      baseUrl: () => "http://127.0.0.1:4096",
      projectID: () => "prj_alpha",
      directory: () => "/work/alpha",
      fetch: () => fetch,
    })
    expect(() => scoped("https://example.com/file/raw")).toThrow("active OpenScience server")
  })
})
