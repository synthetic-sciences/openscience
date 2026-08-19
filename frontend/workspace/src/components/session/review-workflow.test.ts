import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

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

  test("the generated Result trace exposes a direct independent review action", () => {
    const trace = read("atlas/SessionTraceSurface.tsx")

    expect(trace).toContain("Generated research result")
    expect(trace).toContain("Run independent review")
    expect(trace).toContain("sdk.client.session.review")
    expect(trace).toContain("Research readiness gates")
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

  test("stored Result previews defer review and provenance controls", () => {
    const registry = read("components/settings/registry.ts")
    const stored = read("artifacts/StoredArtifactView.tsx")

    expect(registry).not.toContain('title: "Specialists"')
    expect(registry).not.toContain('title: "Reviewer"')
    expect(stored).not.toContain("Run independent review")
    expect(stored).not.toContain("/review/artifact")
    expect(stored).not.toContain("Versions")
    expect(stored).not.toContain("How made")
    expect(stored).not.toContain("Review")
    expect(stored).not.toContain("Automatically review")
    expect(stored).not.toContain("Reviewer model")
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
