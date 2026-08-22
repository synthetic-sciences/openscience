import { describe, expect, test } from "bun:test"
import path from "node:path"
import { File } from "../../src/file"
import { Instance } from "../../src/project/instance"
import { FileRoutes } from "../../src/server/routes/file"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

describe("file content routes", () => {
  test("reports missing reads as 404 while explicit writes still create files", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const missing = await FileRoutes().request("/file/content?path=missing.md")
        expect(missing.status).toBe(404)

        const created = await File.write("created.md", "# Created\n")
        expect(created.content).toBe("# Created\n")
        expect(await Bun.file(path.join(tmp.path, "created.md")).text()).toBe("# Created\n")
      },
    })
  })

  test("serves mutable raw files without caching and enforces the requested byte cap", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "paper.pdf"), Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 55]))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const raw = await FileRoutes().request("/file/raw?path=paper.pdf&maxBytes=8")
        expect(raw.status).toBe(200)
        expect(raw.headers.get("cache-control")).toBe("no-store, max-age=0")
        expect(raw.headers.get("accept-ranges")).toBe("bytes")
        expect(raw.headers.get("content-disposition")).toStartWith("attachment;")
        expect(raw.headers.get("x-content-type-options")).toBe("nosniff")
        expect(raw.headers.get("content-length")).toBe("8")
        expect(new Uint8Array(await raw.arrayBuffer())).toEqual(Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 55]))

        const bounded = await FileRoutes().request("/file/raw?path=paper.pdf&maxBytes=7")
        expect(bounded.status).toBe(413)
      },
    })
  })

  test("streams single byte ranges and rejects invalid or multipart ranges", async () => {
    await using tmp = await tmpdir({
      init: (directory) => Bun.write(path.join(directory, "large.pdf"), "0123456789"),
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const middle = await FileRoutes().request("/file/raw?path=large.pdf", {
          headers: { Range: "bytes=2-5" },
        })
        expect(middle.status).toBe(206)
        expect(middle.headers.get("content-range")).toBe("bytes 2-5/10")
        expect(middle.headers.get("content-length")).toBe("4")
        expect(await middle.text()).toBe("2345")

        const suffix = await FileRoutes().request("/file/raw?path=large.pdf", {
          headers: { Range: "bytes=-3" },
        })
        expect(suffix.status).toBe(206)
        expect(suffix.headers.get("content-range")).toBe("bytes 7-9/10")
        expect(await suffix.text()).toBe("789")

        const remainder = await FileRoutes().request("/file/raw?path=large.pdf", {
          headers: { Range: "bytes=6-" },
        })
        expect(remainder.status).toBe(206)
        expect(remainder.headers.get("content-range")).toBe("bytes 6-9/10")
        expect(await remainder.text()).toBe("6789")

        const invalid = await FileRoutes().request("/file/raw?path=large.pdf", {
          headers: { Range: "bytes=20-30" },
        })
        expect(invalid.status).toBe(416)
        expect(invalid.headers.get("content-range")).toBe("bytes */10")

        const multipart = await FileRoutes().request("/file/raw?path=large.pdf", {
          headers: { Range: "bytes=0-1,4-5" },
        })
        expect(multipart.status).toBe(416)
      },
    })
  })

  test("serves explicit inline assets with a restrictive document sandbox", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(
          path.join(directory, "unsafe report.html"),
          "<script>top.location='https://example.com'</script>",
        )
        await Bun.write(path.join(directory, "empty.pdf"), "")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const inline = await FileRoutes().request("/file/raw?path=unsafe%20report.html&inline=true")
        expect(inline.status).toBe(200)
        expect(inline.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''unsafe%20report.html")
        expect(inline.headers.get("content-security-policy")).toContain("sandbox")
        expect(inline.headers.get("content-security-policy")).toContain("default-src 'none'")
        expect(inline.headers.get("x-content-type-options")).toBe("nosniff")

        const empty = await FileRoutes().request("/file/raw?path=empty.pdf")
        expect(empty.status).toBe(200)
        expect(empty.headers.get("content-length")).toBe("0")
        expect((await empty.arrayBuffer()).byteLength).toBe(0)

        const ranged = await FileRoutes().request("/file/raw?path=empty.pdf", {
          headers: { Range: "bytes=0-0" },
        })
        expect(ranged.status).toBe(416)
        expect(ranged.headers.get("content-range")).toBe("bytes */0")
      },
    })
  })

  test("uses an absolute project path when a raw request also carries session authority", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (directory) => {
        await Bun.write(path.join(directory, "figures", "result.png"), Uint8Array.from([137, 80, 78, 71]))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await using cleanup = { [Symbol.asyncDispose]: () => Session.remove(session.id) }
        const query = new URLSearchParams({
          path: path.join(tmp.path, "figures", "result.png"),
          sessionID: session.id,
        })

        const response = await FileRoutes().request(`/file/raw?${query}`)
        expect(response.status).toBe(200)
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([137, 80, 78, 71]))
      },
    })
  })
})
