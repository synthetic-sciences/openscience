import { expect, test } from "bun:test"
import path from "node:path"
import { Hono } from "hono"
import { validator } from "hono-openapi"
import z from "zod"

// hono-openapi's runtime entry statically imports "@hono/standard-validator"
// but declares it only as an optional peer, so bun never installs it
// transitively. backend/cli must keep a direct dependency on it or every
// `import { validator } from "hono-openapi"` under src/server fails to load.
const manifest = path.join(import.meta.dir, "../../package.json")

test("hono-openapi validator resolves its @hono/standard-validator peer at runtime", async () => {
  const app = new Hono().post("/echo", validator("json", z.object({ name: z.string().min(1) })), (c) =>
    c.json(c.req.valid("json")),
  )
  const send = (name: string) =>
    app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    })

  const ok = await send("openscience")
  expect(ok.status).toBe(200)
  expect(await ok.json()).toEqual({ name: "openscience" })

  const bad = await send("")
  expect(bad.status).toBe(400)
})

test("backend/cli declares @hono/standard-validator so lockfile regeneration keeps it", async () => {
  const pkg = (await Bun.file(manifest).json()) as { dependencies: Record<string, string> }
  expect(pkg.dependencies["@hono/standard-validator"]).toMatch(/^\d+\.\d+\.\d+$/)
})
