import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createArtifactContext } from "./context"
import {
  filterHistoricalReviews,
  inspectorTabs,
  normalizeInspectorData,
  normalizePublicationReview,
  normalizeHistoricalReviews,
} from "./inspector"

const source = () => readFileSync(fileURLToPath(new URL("./ArtifactInspector.tsx", import.meta.url)), "utf8")

const context = createArtifactContext({
  directory: "/work/project",
  path: "results/protein.pdb",
  format: "pdb",
  scienceKind: "protein-structure",
})

describe("artifact inspector model", () => {
  test("normalizes recorded source, environment, and Git provenance", () => {
    const result = normalizeInspectorData(context, {
      file: { type: "text", content: "ATOM      1", size: 12 },
      provenance: {
        path: "results/protein.pdb",
        tracked: true,
        dirty: false,
        status: "clean",
        branch: "openscience/aayam-new",
        commit: {
          sha: "0123456789abcdef",
          author: "Aayam Bansal",
          email: "aayambansal@gmail.com",
          date: "2026-07-29T00:00:00.000Z",
          message: "record structure",
        },
      },
      audit: {
        environments: ["pyproject.toml", "environment.yml"],
        lockfiles: ["uv.lock"],
      },
    })

    expect(result.source).toBe("ATOM      1")
    expect(result.provenance).toMatchObject({
      status: "clean",
      branch: "openscience/aayam-new",
      commit: { sha: "0123456789abcdef", author: "Aayam Bansal" },
    })
    expect(result.environments).toEqual(["pyproject.toml", "environment.yml"])
    expect(result.lockfiles).toEqual(["uv.lock"])
    expect(result.tabs.code.available).toBe(true)
    expect(result.tabs.environment.available).toBe(true)
    expect(result.tabs.history.available).toBe(true)
    expect(result.tabs.run.available).toBe(false)
    expect(result.tabs.messages.available).toBe(false)
    expect(result.tabs.review.available).toBe(true)
  })

  test("keeps malformed and absent records honest instead of inventing metadata", () => {
    const result = normalizeInspectorData(context, {
      file: { type: "text", content: 12, encoding: "base64" },
      provenance: { tracked: "yes", commit: { sha: 12 } },
      audit: { environments: ["pyproject.toml", 4], lockfiles: "uv.lock" },
    })

    expect(result.source).toBeUndefined()
    expect(result.provenance).toBeUndefined()
    expect(result.environments).toEqual([])
    expect(result.lockfiles).toEqual([])
    expect(result.tabs.code).toEqual({
      available: false,
      title: "Source is not directly displayable",
      detail: "Open the file view or download the original artifact.",
    })
    expect(result.tabs.history).toMatchObject({ available: false, title: "No Git commit is recorded" })
  })

  test("publishes the complete stable inspector tab order", () => {
    expect(inspectorTabs).toEqual(["details", "code", "run", "messages", "environment", "review", "history"])
  })

  test("threads producing runs and messages from recorded lineage", () => {
    const result = normalizeInspectorData(context, {
      lineage: {
        runs: [
          {
            id: "run_1",
            tool: "kernel.execute",
            label: "Fold protein",
            status: "ok",
            recordedAt: "2026-07-29T00:00:05.000Z",
            sessionID: "ses_1",
            messageID: "msg_1",
            callID: "call_1",
            code: "print('fold')",
            cwd: "/work/project",
            kernel: { language: "python", name: "python3" },
            startedAt: "2026-07-29T00:00:00.000Z",
            completedAt: "2026-07-29T00:00:05.000Z",
          },
        ],
        messages: [{ sessionID: "ses_1", messageID: "msg_1" }],
      },
    })

    expect(result.runs).toHaveLength(1)
    expect(result.runs[0]).toMatchObject({
      id: "run_1",
      tool: "kernel.execute",
      status: "ok",
      kernel: { language: "python", name: "python3" },
      code: "print('fold')",
      cwd: "/work/project",
    })
    expect(result.messages).toEqual([{ sessionID: "ses_1", messageID: "msg_1" }])
    expect(result.tabs.run).toMatchObject({ available: true, title: "Producing run recorded" })
    expect(result.tabs.run.detail).toContain("1 recorded run")
    expect(result.tabs.messages).toMatchObject({ available: true, title: "Producing messages recorded" })
  })

  test("keeps malformed lineage honest instead of inventing runs or messages", () => {
    const result = normalizeInspectorData(context, {
      lineage: {
        runs: [{ id: "run_1", tool: 12, label: "no tool", recordedAt: "2026-07-29T00:00:00.000Z" }, "nope"],
        messages: [{ sessionID: "ses_1" }, { messageID: "msg_1" }, 7],
      },
    })

    expect(result.runs).toEqual([])
    expect(result.messages).toEqual([])
    expect(result.tabs.run.available).toBe(false)
    expect(result.tabs.messages.available).toBe(false)
  })

  test("normalizes publication readiness without inventing a review", () => {
    const skipped = normalizePublicationReview("pdb", undefined)
    expect(skipped.kind).toBe("not-applicable")
    expect(skipped.report).toBeUndefined()
    const missing = normalizePublicationReview("md", { status: "ready" })
    expect(missing.kind).toBe("not-run")
    expect(missing.report).toBeUndefined()
    // Display-only rename: the deterministic checks present as a preflight and
    // never claim scientific review. The persisted format string is untouched.
    expect(missing.title).toBe("No publication preflight yet")
  })

  test("distinguishes blocked, stale, and finalized manuscript states", () => {
    const report = {
      format: "openscience.publication-review.v1",
      id: "review_01",
      path: "report.md",
      artifactHash: "a".repeat(64),
      version: 2,
      status: "blocked",
      stale: false,
      summary: {
        total: 2,
        open: 1,
        blocking: 1,
        major: 1,
        minor: 0,
        info: 0,
        resolved: 1,
        overridden: 0,
      },
      findings: [
        {
          id: "finding_01",
          check: "citation",
          severity: "blocking",
          status: "open",
          title: "Citation is unresolved",
          detail: "Add a bibliography entry.",
          evidence: ["report.md:4"],
          location: { path: "report.md", line: 4 },
        },
      ],
      events: [{ version: 1, type: "generated", actor: "Ada", at: 1 }],
      createdAt: 1,
      updatedAt: 2,
    }
    expect(normalizePublicationReview("md", report)).toMatchObject({
      kind: "blocked",
      report: { id: "review_01" },
    })
    expect(normalizePublicationReview("md", { ...report, stale: true })).toMatchObject({
      kind: "stale",
    })
    expect(
      normalizePublicationReview("md", {
        ...report,
        status: "warnings",
        finalized: { actor: "Aayam Bansal", at: 3, artifactHash: "a".repeat(64) },
      }),
    ).toMatchObject({
      kind: "finalized",
      report: { finalized: { actor: "Aayam Bansal" } },
    })
    expect(
      normalizePublicationReview("md", {
        ...report,
        status: "ready",
        finalized: { actor: "Aayam Bansal", at: 3, artifactHash: "a".repeat(64) },
      }).title,
    ).toBe("Publication preflight finalized")
  })
})

describe("historical review records", () => {
  const entry = (over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
    finding: {
      id: "node_1",
      kind: "claim",
      label: "review (major): unsupported claim",
      recordedAt: "2026-07-30T10:00:00.000Z",
      meta: {
        review: true,
        claim: "AUC improved to 0.94",
        issue: "The evaluation notebook reports 0.87",
        severity: "major",
        evidence: "results/eval.ipynb cell 12",
        reviewer: "legacy review service",
        sessionID: "ses_1",
        ...meta,
      },
    },
    target: "node_0",
    verdict: "refutes",
    status: "open",
    ...over,
  })

  test("normalizes read-only entries with lifecycle status and resolution", () => {
    const rows = normalizeHistoricalReviews([
      entry(),
      entry({
        status: "addressed",
        resolution: { actor: "Aayam Bansal", reason: "reran the evaluation", recordedAt: "2026-07-30T11:00:00.000Z" },
      }),
      entry({ verdict: "supports", status: undefined }, { issue: "verified" }),
    ])

    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      id: "node_1",
      target: "node_0",
      verdict: "refutes",
      severity: "major",
      claim: "AUC improved to 0.94",
      issue: "The evaluation notebook reports 0.87",
      evidence: "results/eval.ipynb cell 12",
      sessionID: "ses_1",
    })
    expect(rows.map((row) => row.status)).toContain("addressed")
    expect(rows.find((row) => row.status === "addressed")?.resolution).toMatchObject({ actor: "Aayam Bansal" })
    expect(rows.find((row) => row.verdict === "supports")?.status).toBeUndefined()
  })

  test("drops malformed entries instead of inventing findings", () => {
    expect(normalizeHistoricalReviews(undefined)).toEqual([])
    expect(
      normalizeHistoricalReviews([
        "nope",
        { finding: { id: "x" }, target: "t", verdict: "refutes" },
        entry({ verdict: "maybe" }),
        entry({}, { severity: "catastrophic" }),
      ]),
    ).toEqual([])
  })

  test("scopes honestly to the open session when one exists", () => {
    const rows = normalizeHistoricalReviews([entry(), entry({}, { sessionID: "ses_2" })])
    expect(filterHistoricalReviews(rows, "ses_2")).toHaveLength(1)
    expect(filterHistoricalReviews(rows, "ses_2")[0]?.sessionID).toBe("ses_2")
    expect(filterHistoricalReviews(rows)).toHaveLength(2)
  })
})

describe("artifact inspector presentation", () => {
  test("uses readable type, control, and grouping geometry", () => {
    const component = source()

    expect(component).toContain('const BODY_FONT_SIZE = "16px"')
    expect(component).toContain('const SECTION_TITLE_SIZE = "20px"')
    expect(component).toContain('const CONTROL_HEIGHT = "44px"')
    expect(component).toContain('const GROUP_RADIUS = "18px"')
    expect(component).toContain('"font-size": BODY_FONT_SIZE')
    expect(component).toContain('"min-height": CONTROL_HEIGHT')
    expect(component).toContain('"border-radius": GROUP_RADIUS')
    expect(component).not.toMatch(/"font-size": "(?:8|9|10|11|12)px"/)
    expect(component).not.toMatch(/"font-weight":\s*(?:[1-9]\d{2}|"[1-9]\d{2}")/)
    for (const strong of component.matchAll(/<strong\b[\s\S]*?<\/strong>/g)) {
      expect(strong[0]).toContain('"font-weight": "var(--font-weight-')
    }
    expect(component).toMatch(/>\s*Close\s*</)
    expect(component).toContain("<IconFlask size={16} /> Ask")
    expect(component).toContain("<IconCopy size={16} /> Path")
    expect(component).toContain("<IconDownload size={16} /> Download")
    expect(component).toContain('title="Refresh file details"')
  })

  test("renders producing runs and messages instead of only empty states", () => {
    const component = source()

    expect(component).toContain("<Runs data={model()} />")
    expect(component).toContain("<Messages data={model()}")
    expect(component).toContain('data-component="artifact-run"')
    expect(component).toContain('data-component="artifact-message"')
    expect(component).toContain("Show in conversation")
    expect(component).toContain('document.querySelector(`[data-message-id="${props.message.messageID}"]`)')
  })

  test("labels review evidence and versions explicitly", () => {
    const component = source()

    expect(component).toContain('data-label="review-version"')
    expect(component).toContain("Preflight version {report().version}")
    expect(component).toContain('data-section="finding-evidence"')
    expect(component).toMatch(/>\s*Evidence\s*<\/span>/)
    expect(component).toContain("Annotation version {props.annotation.version}")
    expect(component).toContain("Latest recorded version")
  })
})
