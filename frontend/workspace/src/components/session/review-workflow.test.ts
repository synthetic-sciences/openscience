import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { settingsApi } from "../settings/api"

const root = join(import.meta.dir, "../..")
const read = (relative: string) => readFileSync(join(root, relative), "utf8")

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sources(full)
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) return []
    return [full]
  })
}

describe("reviewer workflow truth pass", () => {
  test("the session header does not expose a manual reviewer control", () => {
    const session = read("pages/session.tsx")

    expect(session).not.toContain("Run review")
    expect(session).not.toContain("openscience:run-review")
    expect(session).not.toContain("reviewDisabled")
    expect(session).not.toContain("workspace-header__review")
  })

  test("no surface prefills chat to spawn the reviewer", () => {
    for (const file of sources(root)) {
      const text = readFileSync(file, "utf8")
      expect(text).not.toContain("Use the reviewer agent")
      expect(text).not.toContain("as a scientific reviewer")
      expect(text).not.toContain("Review analysis")
    }
  })

  test("the inspector's Review tab surfaces provenance findings with lifecycle", () => {
    const inspector = read("artifacts/ArtifactInspector.tsx")

    expect(inspector).toContain('read("/provenance/reviews")')
    expect(inspector).toContain('data-component="reviewer-findings"')
    expect(inspector).toContain('data-chip="finding-status"')
    expect(inspector).toContain("Mark addressed")
    expect(inspector).toContain("`/provenance/reviews/${finding.id}/resolve`")
    // Addressing is honest: only a later reviewer pass confirms a fix.
    expect(inspector).toContain("only a later reviewer pass can confirm it")

    const model = read("artifacts/inspector.ts")
    expect(model).toContain('"open" | "addressed" | "confirmed"')
  })

  test("the auto-review toggle persists through the review settings store", () => {
    const specialists = read("components/settings/Specialists.tsx")

    expect(specialists).toContain('"/settings/review"')
    expect(specialists).toContain("Automatically review significant results")
    expect(specialists).toContain("Checks durable results without interrupting the active research session.")
    expect(specialists).toContain('method: "PUT"')
  })

  test("the review settings round-trip preserves the auto flag", async () => {
    const calls: Array<{ url: string; method?: string }> = []
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method })
      const body = typeof init?.body === "string" ? init.body : JSON.stringify({ auto: false })
      return new Response(body, { headers: { "content-type": "application/json" } })
    }) as typeof fetch

    const state = await settingsApi<{ auto: boolean }>("http://127.0.0.1:4096", fetchFn, "/settings/review", {
      method: "PUT",
      body: JSON.stringify({ auto: true }),
    })

    expect(state).toEqual({ auto: true })
    expect(calls).toEqual([{ url: "http://127.0.0.1:4096/settings/review", method: "PUT" }])
  })

  test("deterministic checks present as a preflight, never as scientific review", () => {
    const workbench = read("manuscript/ManuscriptWorkbench.tsx")
    expect(workbench).toContain("Preflight-checked bytes")
    expect(workbench).not.toContain("Reviewed bytes")
    expect(workbench).not.toContain("reviewed export")

    const inspector = read("artifacts/ArtifactInspector.tsx")
    expect(inspector).toContain("Finalize preflight-checked bytes")
    expect(inspector).not.toContain("Finalize reviewed bytes")

    const model = read("artifacts/inspector.ts")
    expect(model).toContain("No publication preflight yet")
    expect(model).toContain("Publication preflight finalized")
    // The persisted format string is a wire contract and must never be renamed.
    expect(model).toContain('"openscience.publication-review.v1"')
  })
})
