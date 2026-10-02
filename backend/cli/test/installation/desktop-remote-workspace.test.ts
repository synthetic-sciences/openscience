import { expect, test } from "bun:test"
import {
  workspaceHealth,
  workspaceNavigation,
  workspaceOrigin,
} from "../../../../frontend/desktop/src/remote-workspace.mjs"

test("accepts only complete secure origins and local SSH tunnel origins", () => {
  expect(workspaceOrigin("http://127.0.0.1:14096/")).toBe("http://127.0.0.1:14096")
  expect(workspaceOrigin("http://[::1]:4096")).toBe("http://[::1]:4096")
  expect(workspaceOrigin("https://research.example.org/")).toBe("https://research.example.org")
  for (const value of [
    "file:///tmp/project",
    "https://trusted.example@evil.example",
    "http://research.example",
    "http://localhost.evil.example",
    "https://example.org/path",
    "https://example.org?token=x",
    "https://example.org#x",
    "not a URL",
    null,
  ]) {
    expect(() => workspaceOrigin(value)).toThrow()
  }
})

test("navigation stays within the selected runtime's exact origin", () => {
  const origin = "http://127.0.0.1:14096"
  expect(workspaceNavigation(`${origin}/prj_test/session`, origin)).toBe(true)
  for (const value of [
    "http://127.0.0.1:4096",
    "http://127.0.0.1:140960",
    "https://127.0.0.1:14096",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://127.0.0.1:14096@evil.example/",
  ]) {
    expect(workspaceNavigation(value, origin)).toBe(false)
  }
})

test("checks the exact health endpoint without forwarding local credentials", async () => {
  const requests: { url: string; headers: Headers }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push({ url: request.url, headers: new Headers(request.headers) })
      return Response.json({ healthy: true, version: "2.0.149" })
    },
  })
  try {
    expect(await workspaceHealth(server.url.origin)).toEqual({ origin: server.url.origin, version: "2.0.149" })
    expect(new URL(requests[0].url).pathname).toBe("/global/health")
    expect(requests[0].headers.has("authorization")).toBe(false)
    expect(requests[0].headers.has("cookie")).toBe(false)
  } finally {
    await server.stop(true)
  }
})

test.each(["redirect", "unauthorized", "html", "unhealthy", "oversized"])(
  "refuses a %s health response before opening a window",
  async (kind) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        if (kind === "redirect") return Response.redirect("https://example.org", 302)
        if (kind === "unauthorized") return new Response("Unauthorized", { status: 401 })
        if (kind === "html")
          return new Response("<html>Not a runtime</html>", { headers: { "content-type": "text/html" } })
        if (kind === "oversized") return Response.json({ healthy: true, version: "x".repeat(70000) })
        return Response.json({ healthy: false, version: "2.0.149" })
      },
    })
    try {
      await expect(workspaceHealth(server.url.origin)).rejects.toThrow()
    } finally {
      await server.stop(true)
    }
  },
)
