import { test, expect, describe } from "bun:test"
import path from "path"

const root = path.join(import.meta.dir, "..", "..", "src")

async function sources() {
  const files = await Array.fromAsync(
    new Bun.Glob("session/**/*.{ts,txt}").scan({ cwd: root, absolute: true, onlyFiles: true }),
  )
  return Promise.all(files.map(async (file) => [file, await Bun.file(file).text()] as const))
}

describe("compute prompt text", () => {
  test("no prompt or session source references atlas compute:up", async () => {
    const hits = (await sources()).filter(([, text]) => text.includes("compute:up"))
    expect(hits.map(([file]) => path.relative(root, file))).toEqual([])
  })

  test("no prompt or session source uses atlas doctor as the compute availability signal", async () => {
    const hits = (await sources()).filter(([, text]) => /atlas doctor/i.test(text))
    expect(hits.map(([file]) => path.relative(root, file))).toEqual([])
  })

  test("the compute reminder points at compute_status and carries no mode", async () => {
    const text = await Bun.file(path.join(root, "session", "prompt.ts")).text()
    expect(text).toContain("compute_status")
    // The reminder must be stateless — a mode baked into an injected string is
    // false the moment the user connects a key mid-session.
    expect(text).not.toContain("Compute spend is set to")
  })

  test("computeBillingMode is gone and nothing imports it", async () => {
    const gate = await Bun.file(path.join(root, "session", "billing-gate.ts")).text()
    expect(gate).not.toContain("computeBillingMode")
    const files = await Array.fromAsync(new Bun.Glob("**/*.ts").scan({ cwd: root, absolute: true, onlyFiles: true }))
    const importers = (
      await Promise.all(
        files.map(async (file) => ((await Bun.file(file).text()).includes("computeBillingMode") ? file : undefined)),
      )
    ).filter(Boolean)
    expect(importers).toEqual([])
  })

  test("the billing.compute config description no longer claims 'Unset = byok'", async () => {
    const text = await Bun.file(path.join(root, "config", "config.ts")).text()
    expect(text).not.toContain("Unset = byok")
    expect(text).toContain("auto-detect")
  })
})
