import { test, expect, describe } from "bun:test"
import path from "path"

const root = path.join(import.meta.dir, "..", "..", "src")

async function sources() {
  const globs = ["session/**/*.{ts,txt}", "agent/prompt/*.txt"]
  const files = (
    await Promise.all(
      globs.map((pattern) =>
        Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root, absolute: true, onlyFiles: true })),
      ),
    )
  ).flat()
  return Promise.all(files.map(async (file) => [file, await Bun.file(file).text()] as const))
}

describe("compute prompt text", () => {
  test("no prompt or session source references atlas compute:up", async () => {
    const hits = (await sources()).filter(([, text]) => text.includes("compute:up"))
    expect(hits.map(([file]) => path.relative(root, file))).toEqual([])
  })

  test("the file set is non-empty and covers both prompt trees", async () => {
    const files = (await sources()).map(([file]) => path.relative(root, file))
    expect(files.length).toBeGreaterThan(20)
    expect(files).toContain("session/prompt.ts")
    expect(files).toContain("agent/prompt/research.txt")
  })

  test("no prompt uses atlas doctor as the compute availability signal", async () => {
    // `atlas doctor` legitimately reports whether the atlas CLI is present and
    // authenticated (research.txt uses it that way before loading graph state).
    // What it does NOT report is anything about compute — so any paragraph that
    // mentions both compute and `atlas doctor` is reading a signal that isn't there.
    const hits = (await sources()).filter(([, text]) =>
      text.split(/\n\s*\n/).some((para) => /atlas doctor/i.test(para) && /\bcompute\b/i.test(para)),
    )
    expect(hits.map(([file]) => path.relative(root, file))).toEqual([])
  })

  test("agent prompts point at compute_status for GPU funding", async () => {
    const text = await Bun.file(path.join(root, "agent", "prompt", "research.txt")).text()
    expect(text).toContain("compute_status")
  })

  test("prompts name skills that exist in the provider map", async () => {
    // `modal` is not a skill name — the real ones are modal-serverless-gpu,
    // modal-ml-training, modal-research-gpu. A prompt naming a skill the catalog
    // does not have sends the agent to load something that cannot resolve.
    const text = await Bun.file(path.join(root, "agent", "prompt", "research.txt")).text()
    expect(text).not.toMatch(/`modal`/)
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
