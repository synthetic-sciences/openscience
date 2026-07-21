import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("spa fallback", () => {
  test("unmatched API-shaped request under /settings gets a JSON 404, not SPA HTML", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const fetch = Server.internalFetch()
        const response = await fetch("http://openscience.internal/settings/nonexistent", {
          headers: { "content-type": "application/json" },
        })

        expect(response.status).toBe(404)
        expect(response.headers.get("content-type")).toContain("application/json")

        const text = await response.text()
        expect(text.startsWith("<")).toBe(false)
        expect(JSON.parse(text)).toEqual({ error: "not_found", path: "/settings/nonexistent" })
      },
    })
  })

  test("browser navigation to an unmatched route still gets the SPA index.html", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const fetch = Server.internalFetch()
        const response = await fetch("http://openscience.internal/definitely/not/a/route", {
          headers: { accept: "text/html" },
        })

        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("text/html")
        expect(response.headers.get("content-security-policy")).toContain("default-src 'self'")

        const text = await response.text()
        expect(text.toLowerCase().startsWith("<!doctype")).toBe(true)
      },
    })
  })

  test("unmatched /api/* request still 404s (regression)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const fetch = Server.internalFetch()
        const response = await fetch("http://openscience.internal/api/also-nonexistent")

        expect(response.status).toBe(404)
      },
    })
  })
})
