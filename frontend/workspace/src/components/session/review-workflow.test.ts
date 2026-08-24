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

describe("reviewer workflow removal", () => {
  test("the session header does not expose a manual reviewer control", () => {
    const session = read("pages/session.tsx")

    expect(session).not.toContain("Run review")
    expect(session).not.toContain("openscience:run-review")
    expect(session).not.toContain("reviewDisabled")
    expect(session).not.toContain("workspace-header__review")
  })

  test("the generated Result trace stays observational", () => {
    const trace = read("atlas/SessionTraceSurface.tsx")
    const model = read("atlas/session-trace-model.ts")

    expect(trace).toContain("Generated research result")
    expect(trace).toContain("Research readiness gates")
    expect(trace).not.toContain("Run independent review")
    expect(trace).not.toContain("sdk.client.session.review")
    expect(trace).not.toContain("Independent reviewer")
    expect(model).not.toContain("trace.reviewerFindings")
    expect(model).not.toContain('kind: "review"')
  })

  test("no surface prefills chat to spawn the reviewer", () => {
    for (const file of sources(root)) {
      const text = readFileSync(file, "utf8")
      expect(text).not.toContain("Use the reviewer agent")
      expect(text).not.toContain("as a scientific reviewer")
      expect(text).not.toContain("Review analysis")
    }
  })

  test("the inspector exposes legacy provenance reviews as read-only history", () => {
    const inspector = read("artifacts/ArtifactInspector.tsx")

    expect(inspector).toContain('read("/provenance/reviews")')
    expect(inspector).toContain('data-component="historical-review-records"')
    expect(inspector).toContain("Read-only review records created by earlier OpenScience versions")
    expect(inspector).not.toContain("Mark addressed")
    expect(inspector).not.toContain("/provenance/reviews/${finding.id}/resolve")

    const model = read("artifacts/inspector.ts")
    expect(model).toContain('"open" | "addressed" | "confirmed"')
    expect(model).toContain("GET /provenance/reviews only")
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
    expect(inspector).toContain('mutateReview("/file/reviews", "POST"')
    expect(inspector).toContain('mutateReview(`/file/reviews/${report}/finalize`, "POST"')

    const model = read("artifacts/inspector.ts")
    expect(model).toContain("No publication preflight yet")
    expect(model).toContain("Publication preflight finalized")
    // The persisted format string is a wire contract and must never be renamed.
    expect(model).toContain('"openscience.publication-review.v1"')
  })

  test("the composer has no reviewer preferences, model, or auto-review state", () => {
    const prompt = read("components/prompt-input.tsx")
    const capabilities = read("components/prompt-capabilities.ts")

    for (const text of [prompt, capabilities]) {
      expect(text).not.toContain("ReviewPreferences")
      expect(text).not.toContain("Reviewer model")
      expect(text).not.toContain("Auto-review")
      expect(text).not.toContain("/settings/review")
    }
  })
})
