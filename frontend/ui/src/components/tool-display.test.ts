import { describe, test, expect } from "bun:test"
import {
  artifactActions,
  generatedArtifacts,
  humanizeToolName,
  savedArtifact,
  scienceTaskLabel,
  skillName,
  stripRedactedReasoning,
  writtenFiles,
} from "./tool-display"

describe("humanizeToolName", () => {
  test("titlecases a simple id", () => {
    expect(humanizeToolName("websearch")).toBe("Websearch")
    expect(humanizeToolName("multi_edit")).toBe("Multi Edit")
  })
  test("titlecases a multi-word namespace_tool id", () => {
    expect(humanizeToolName("playwright_browser_click")).toBe("Playwright Browser Click")
  })
})

describe("skillName", () => {
  test("prefers metadata.name", () => {
    expect(skillName({ metadata: { name: "deep-research" }, input: { name: "x" } })).toBe("deep-research")
  })
  test("falls back to input.name", () => {
    expect(skillName({ input: { name: "brainstorming" } })).toBe("brainstorming")
  })
  test("strips the title prefix", () => {
    expect(skillName({ title: "Loaded skill: qa" })).toBe("qa")
  })
  test("defaults to 'skill'", () => {
    expect(skillName({})).toBe("skill")
  })
})

describe("writtenFiles", () => {
  const completed = (tool: string, input: Record<string, unknown>, metadata: Record<string, unknown> = {}) => ({
    type: "tool",
    tool,
    state: { status: "completed", input, metadata },
  })

  test("collects completed write/edit/multiedit targets in order, deduped", () => {
    expect(
      writtenFiles([
        completed("write", { filePath: "results/report.md" }),
        completed("edit", { filePath: "analysis.py" }),
        completed("multiedit", { filePath: "results/report.md" }),
      ]),
    ).toEqual(["results/report.md", "analysis.py"])
  })

  test("ignores tools that did not finish and parts that are not tools", () => {
    expect(
      writtenFiles([
        { type: "text" },
        { type: "tool", tool: "write", state: { status: "running", input: { filePath: "wip.md" } } },
        { type: "tool", tool: "write", state: { status: "error", input: { filePath: "failed.md" } } },
        completed("read", { filePath: "read-only.md" }),
        completed("bash", { command: "touch side-effect.txt" }),
      ]),
    ).toEqual([])
  })

  test("reads apply_patch changes from completed metadata, resolving moves and skipping deletes", () => {
    expect(
      writtenFiles([
        completed(
          "apply_patch",
          { patchText: "*** Begin Patch" },
          {
            files: [
              { filePath: "a.py", type: "update" },
              { filePath: "old.py", movePath: "new.py", type: "move" },
              { filePath: "gone.py", type: "delete" },
            ],
          },
        ),
      ]),
    ).toEqual(["a.py", "new.py"])
  })

  test("never guesses paths for the notebook tool, whose input is only code", () => {
    expect(writtenFiles([completed("notebook", { code: "open('x.csv','w').write('1')" })])).toEqual([])
  })
})

describe("artifactActions", () => {
  test("offers a single bare action for one written file", () => {
    expect(artifactActions(["results/report.md"])).toEqual([{ path: "results/report.md", label: "Save as artifact…" }])
  })

  test("labels each action with its filename when several files were written", () => {
    expect(artifactActions(["results/report.md", "analysis.py"])).toEqual([
      { path: "results/report.md", label: "Save as artifact… report.md" },
      { path: "analysis.py", label: "Save as artifact… analysis.py" },
    ])
  })

  test("offers nothing when the turn wrote nothing", () => {
    expect(artifactActions([])).toEqual([])
  })
})

describe("stripRedactedReasoning", () => {
  test("drops a whole-encrypted placeholder to empty", () => {
    expect(stripRedactedReasoning("[REDACTED]")).toBe("")
  })
  test("keeps the readable summary, strips the trailing placeholder", () => {
    expect(stripRedactedReasoning("I'll sort it out![REDACTED]")).toBe("I'll sort it out!")
  })
  test("handles multiple placeholders and whitespace", () => {
    expect(stripRedactedReasoning("[REDACTED]\n\n[REDACTED]")).toBe("")
  })
  test("leaves normal reasoning untouched", () => {
    expect(stripRedactedReasoning("plain reasoning text")).toBe("plain reasoning text")
  })
})

describe("scienceTaskLabel", () => {
  test("prefers an explicit action title", () => {
    expect(scienceTaskLabel({ title: "Benchmarking survival classifiers.", code: "from pathlib import Path" })).toBe(
      "Benchmarking survival classifiers",
    )
  })

  test("never uses an import as the visible label", () => {
    expect(scienceTaskLabel({ code: "from pathlib import Path\nimport pandas as pd", language: "python" })).toBe(
      "Python cell",
    )
  })

  test("derives conservative labels for older scientific calls", () => {
    expect(scienceTaskLabel({ code: "df = pd.read_csv('data/titanic.csv')" })).toBe("Loading titanic.csv")
    expect(scienceTaskLabel({ code: "model = LogisticRegression().fit(X, y)" })).toBe("Fitting statistical models")
    expect(scienceTaskLabel({ code: "plt.plot(x, y)\nplt.savefig('figures/roc.png')" })).toBe("Rendering roc.png")
  })
})

describe("generatedArtifacts", () => {
  const artifact = {
    title: "ROC curve",
    kind: "figure",
    path: "figures/roc.png",
    id: "art_1",
    versionID: "ver_1",
    version: 1,
    size: 42,
    sha256: "abc123",
    preview: { kind: "image" as const, data: "data:image/png;base64,abc" },
  }

  test("normalizes saved artifact metadata", () => {
    expect(savedArtifact(artifact)).toEqual(artifact)
  })

  test("collects only completed artifact versions and deduplicates them", () => {
    expect(
      generatedArtifacts([
        { type: "tool", tool: "artifact", state: { status: "completed", metadata: { savedArtifact: artifact } } },
        { type: "tool", tool: "artifact", state: { status: "completed", metadata: { savedArtifact: artifact } } },
        { type: "tool", tool: "artifact", state: { status: "error", metadata: { savedArtifact: artifact } } },
      ]),
    ).toEqual([artifact])
  })
})
