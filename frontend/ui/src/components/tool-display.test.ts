import { describe, test, expect } from "bun:test"
import {
  artifactTypeLabel,
  artifactActions,
  errorLine,
  generatedArtifacts,
  humanizeToolName,
  lineCount,
  reasoningDisplayText,
  reasoningTopic,
  runningLabel,
  sentenceCaseLabel,
  savedArtifact,
  scienceTaskLabel,
  sessionErrorDisplay,
  sessionErrorText,
  skillActivity,
  skillName,
  stripBashMetadata,
  stripRedactedReasoning,
  toolErrorDisplay,
  toolOutcome,
  toolSummary,
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

describe("sentenceCaseLabel", () => {
  test("normalizes interface identifiers without relying on CSS casing", () => {
    expect(sentenceCaseLabel("general")).toBe("General")
    expect(sentenceCaseLabel("code_review")).toBe("Code review")
    expect(sentenceCaseLabel("  research-agent  ")).toBe("Research agent")
  })

  test("preserves technical acronyms", () => {
    expect(sentenceCaseLabel("PDF")).toBe("PDF")
  })
})

describe("sessionErrorText", () => {
  test("explains a provider balance failure with exact amounts", () => {
    expect(
      sessionErrorText({
        data: {
          message: "Payment Required: insufficient_balance",
          responseBody: '{"error":"insufficient_balance","required_cents":374,"available_cents":258}',
        },
      }),
    ).toBe("The connected provider account needs $3.74 for this step; $2.58 is available.")
  })

  test("preserves ordinary provider errors", () => {
    expect(sessionErrorText({ data: { message: "Provider is overloaded" } })).toBe("Provider is overloaded")
  })

  test("presents a recoverable provider interruption as paused", () => {
    expect(
      sessionErrorDisplay({
        name: "APIError",
        data: {
          message: "The provider connection was interrupted. Retry when connectivity returns.",
          metadata: {
            openscience_state: "paused",
            action: "retry",
          },
        },
      }),
    ).toEqual({
      state: "paused",
      title: "Paused",
      message: "The provider connection was interrupted. Retry when connectivity returns.",
      action: "retry",
    })
    expect(sessionErrorDisplay({ data: { message: "Provider is overloaded" } })).toEqual({
      state: "error",
      message: "Provider is overloaded",
    })
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
  test("does not invent a literal skill name while streaming", () => {
    expect(skillName({})).toBeUndefined()
    expect(skillActivity({ status: "running" })).toEqual({ title: "Finding relevant skills" })
  })
  test("distinguishes using a skill from merely finding candidates", () => {
    expect(skillActivity({ input: { name: "scientific-schematics" }, status: "running" })).toEqual({
      title: "Using scientific-schematics",
    })
    expect(
      skillActivity({
        input: { query: "scientific figures" },
        metadata: { matches: ["scientific-schematics", "matplotlib"] },
        title: "Skill matches: scientific figures",
        status: "completed",
      }),
    ).toEqual({ title: "Found 2 relevant skills" })
    expect(skillActivity({ metadata: { names: ["scientific-schematics", "ml-paper-writing"] } })).toEqual({
      title: "Using 2 skills",
      subtitle: "scientific-schematics · ml-paper-writing",
    })
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

  test("never guesses paths for the notebook tool when execution metadata has none", () => {
    expect(writtenFiles([completed("notebook", { code: "open('x.csv','w').write('1')" })])).toEqual([])
  })

  test("collects files observed by Python, R, and image execution metadata", () => {
    expect(
      writtenFiles([
        completed("notebook", { code: "..." }, { files: ["results.csv", "figure.png"] }),
        completed("r", { code: "..." }, { files: ["model.rds"] }),
        completed("generate_image", {}, { filepath: "diagram.png" }),
      ]),
    ).toEqual(["results.csv", "figure.png", "model.rds", "diagram.png"])
  })

  test("offers brokered web downloads as session outputs", () => {
    expect(
      writtenFiles([
        completed("webfetch", { url: "https://example.com/paper.pdf" }, { download: { path: "paper.pdf" } }),
      ]),
    ).toEqual(["paper.pdf"])
  })
})

describe("artifactActions", () => {
  test("offers a single bare action for one written file", () => {
    expect(artifactActions(["results/report.md"])).toEqual([{ path: "results/report.md", label: "Save as Result…" }])
  })

  test("labels each action with its filename when several files were written", () => {
    expect(artifactActions(["results/report.md", "analysis.py"])).toEqual([
      { path: "results/report.md", label: "Save as Result… report.md" },
      { path: "analysis.py", label: "Save as Result… analysis.py" },
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
  test("preserves provider-visible reasoning byte-for-byte", () => {
    expect(stripRedactedReasoning("  raw provider reasoning\n")).toBe("  raw provider reasoning\n")
    expect(stripRedactedReasoning("  readable summary[REDACTED]\n")).toBe("  readable summary\n")
  })
})

describe("provider reasoning presentation", () => {
  const titanic =
    "**Evaluating Titanic dataset analysis**\n\nThe user asks for an analysis. Let's get started!**Choosing a reputable Titanic dataset**\n\nI need a reputable source.**Simplifying analysis steps**\n\nI can keep the work focused.[REDACTED]"

  test("keeps the full readable trajectory and separates concatenated provider phase titles", () => {
    expect(reasoningDisplayText(titanic)).toBe(
      "**Evaluating Titanic dataset analysis**\n\nThe user asks for an analysis. Let's get started!\n\n**Choosing a reputable Titanic dataset**\n\nI need a reputable source.\n\n**Simplifying analysis steps**\n\nI can keep the work focused.",
    )
  })

  test("uses the latest phase as the single live status topic", () => {
    expect(reasoningTopic(titanic)).toBe("Simplifying analysis steps")
  })

  test("leaves ordinary readable reasoning unchanged", () => {
    expect(reasoningDisplayText("Checking the source, then comparing the results.")).toBe(
      "Checking the source, then comparing the results.",
    )
    expect(reasoningTopic("Checking the source, then comparing the results.")).toBeUndefined()
  })

  test("preserves plain provider phase labels in the transcript", () => {
    expect(reasoningDisplayText("Planning comprehensive research workflow")).toBe(
      "Planning comprehensive research workflow",
    )
    expect(reasoningTopic("Planning comprehensive research workflow")).toBe("Planning comprehensive research workflow")
    expect(reasoningDisplayText("Analyzing the source revealed three incompatible assay formats.")).toBe(
      "Analyzing the source revealed three incompatible assay formats.",
    )
  })

  test("preserves provider headings when the bridge omits the blank line", () => {
    expect(reasoningDisplayText("**Inspecting assay quality**\nThe substantive analysis remains visible.")).toBe(
      "**Inspecting assay quality**\nThe substantive analysis remains visible.",
    )
  })

  test("preserves ordinary bold reasoning prose", () => {
    const prose =
      "Let me also make sure about **featureCounts GTF requirement**: featureCounts works best with a GFF/GTF."
    expect(reasoningDisplayText(prose)).toBe(prose)
    expect(reasoningTopic(prose)).toBeUndefined()
    expect(reasoningDisplayText("This is (**important context**) for the result.")).toBe(
      "This is (**important context**) for the result.",
    )
  })

  test("does not classify arbitrary bold headings as provider phases", () => {
    const heading = "**Feature counts requirement**\nThe explanation remains below it."
    expect(reasoningDisplayText(heading)).toBe(heading)
    expect(reasoningTopic(heading)).toBeUndefined()
  })
})

describe("toolErrorDisplay", () => {
  test("does not call an interrupted execution a tool failure", () => {
    expect(toolErrorDisplay("bash", "Tool execution aborted")).toEqual({
      title: "Bash cancelled",
      message: "Tool execution aborted",
    })
  })
  test("collapses legacy malformed Bash schema dumps behind technical details", () => {
    const raw =
      'The bash tool was called with invalid arguments: [{"code":"invalid_type","path":["command"]}]. Please rewrite the input.'
    expect(toolErrorDisplay("bash", raw)).toEqual({
      title: "Incomplete Bash call",
      message: "No command was run.",
      details: raw,
    })
  })

  test("preserves ordinary short tool errors", () => {
    expect(toolErrorDisplay("read", "Error: File not found: paper.pdf")).toEqual({
      title: "File not found",
      message: "paper.pdf",
    })
  })

  test("keeps long policy and runtime failures attached to the originating tool", () => {
    expect(toolErrorDisplay("compute_job", "Compute secret reference nvidia_nim is not configured")).toEqual({
      title: "Compute Job failed",
      message: "Compute secret reference nvidia_nim is not configured",
    })
    expect(toolErrorDisplay("glob", "The user has specified a rule which prevents this tool call")).toEqual({
      title: "Glob failed",
      message: "The user has specified a rule which prevents this tool call",
    })
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
      "Python execution",
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

  test("shows only the latest version of one logical artifact", () => {
    const latest = { ...artifact, title: "Final ROC curve", versionID: "ver_2", version: 2, sha256: "def456" }
    expect(
      generatedArtifacts([
        { type: "tool", tool: "artifact", state: { status: "completed", metadata: { savedArtifact: artifact } } },
        { type: "tool", tool: "artifact", state: { status: "completed", metadata: { savedArtifact: latest } } },
      ]),
    ).toEqual([latest])
  })

  test("labels PDFs by format instead of the broad report kind", () => {
    expect(artifactTypeLabel({ kind: "report", path: "paper/final.pdf", mimeType: "application/pdf" })).toBe("PDF")
    expect(artifactTypeLabel({ kind: "figure", path: "figures/roc.png", mimeType: "image/png" })).toBe("Figure")
  })
})

describe("toolOutcome", () => {
  test("reports a completed command with a nonzero exit as unsuccessful", () => {
    expect(toolOutcome("completed", undefined, 2)).toBe("error")
    expect(toolOutcome("completed", undefined, 0)).toBe("done")
    expect(toolOutcome("completed", undefined, undefined)).toBe("done")
  })
  test("maps the part lifecycle onto one glyph state", () => {
    expect(toolOutcome("pending")).toBe("pending")
    expect(toolOutcome("running")).toBe("running")
    expect(toolOutcome("completed")).toBe("done")
    expect(toolOutcome("error", "Error: File not found: paper.pdf")).toBe("error")
    expect(toolOutcome(undefined)).toBe("pending")
  })

  test("reads an abort as a cancellation rather than a tool failure", () => {
    expect(toolOutcome("error", "Tool execution aborted")).toBe("cancelled")
    expect(toolOutcome("error", "The request was cancelled by the user")).toBe("cancelled")
    expect(toolOutcome("error", "Command timed out after 120s")).toBe("error")
  })
})

describe("runningLabel", () => {
  test("gives every core tool a present-tense label and leaves unknown tools alone", () => {
    expect(runningLabel("read")).toBe("ui.tool.running.read")
    expect(runningLabel("bash")).toBe("ui.tool.running.bash")
    expect(runningLabel("multiedit")).toBe("ui.tool.running.edit")
    expect(runningLabel("apply_patch")).toBe("ui.tool.running.patch")
    expect(runningLabel("task")).toBeUndefined()
    expect(runningLabel("playwright_browser_click")).toBeUndefined()
  })
})

describe("errorLine", () => {
  test("keeps only the first non-empty line without the Error prefix", () => {
    expect(errorLine("Error: File not found: paper.pdf\n  at read (read.ts:12)")).toBe("File not found: paper.pdf")
    expect(errorLine("\n\n  ENOENT: no such file  \nmore")).toBe("ENOENT: no such file")
    expect(errorLine(undefined)).toBe("")
  })
})

describe("toolSummary", () => {
  const read = "<file>\n00001| import x\n00002| \n00003| print(x)\n\n(End of file - total 3 lines)\n</file>"

  test("counts only the numbered lines of a read", () => {
    expect(toolSummary({ tool: "read", status: "completed", output: read })).toEqual([
      { key: "ui.tool.summary.lines.other", params: { count: 3 } },
    ])
    expect(toolSummary({ tool: "read", status: "completed", output: "<file>\n00001| one\n</file>" })).toEqual([
      { key: "ui.tool.summary.lines.one", params: { count: 1 } },
    ])
  })

  test("reports the units each tool measures itself", () => {
    expect(toolSummary({ tool: "grep", status: "completed", metadata: { matches: 8 } })).toEqual([
      { key: "ui.tool.summary.matches.other", params: { count: 8 } },
    ])
    expect(toolSummary({ tool: "glob", status: "completed", metadata: { count: 1 } })).toEqual([
      { key: "ui.tool.summary.files.one", params: { count: 1 } },
    ])
    expect(toolSummary({ tool: "list", status: "completed", metadata: { count: 12 } })).toEqual([
      { key: "ui.tool.summary.files.other", params: { count: 12 } },
    ])
    expect(toolSummary({ tool: "webfetch", status: "completed", output: "a\nb\n" })).toEqual([
      { key: "ui.tool.summary.lines.other", params: { count: 2 } },
    ])
  })

  test("mentions a shell exit code only when it is not zero", () => {
    expect(toolSummary({ tool: "bash", status: "completed", output: "ok\n", metadata: { exit: 0 } })).toEqual([
      { key: "ui.tool.summary.lines.one", params: { count: 1 } },
    ])
    expect(toolSummary({ tool: "bash", status: "completed", output: "boom\nbang", metadata: { exit: 2 } })).toEqual([
      { key: "ui.tool.summary.exit", params: { code: 2 } },
      { key: "ui.tool.summary.lines.other", params: { count: 2 } },
    ])
  })

  test("does not count the shell metadata trailer as output", () => {
    const output =
      "one\ntwo\n\n<bash_metadata>\nbash tool terminated command after exceeding timeout 5 ms\n</bash_metadata>"
    expect(stripBashMetadata(output)).toBe("one\ntwo")
    expect(stripBashMetadata("plain\n")).toBe("plain\n")
    expect(toolSummary({ tool: "bash", status: "completed", output, metadata: { exit: 124 } })).toEqual([
      { key: "ui.tool.summary.exit", params: { code: 124 } },
      { key: "ui.tool.summary.lines.other", params: { count: 2 } },
    ])
    const silent = "\n\n<bash_metadata>\nUser aborted the command\n</bash_metadata>"
    expect(toolSummary({ tool: "bash", status: "completed", output: silent, metadata: { exit: 0 } })).toEqual([])
  })

  test("stays silent for live calls and for tools whose body already says it", () => {
    expect(toolSummary({ tool: "grep", status: "running", metadata: { matches: 8 } })).toEqual([])
    expect(toolSummary({ tool: "bash", status: "error", output: "boom", metadata: { exit: 1 } })).toEqual([])
    expect(toolSummary({ tool: "edit", status: "completed", output: "Edit applied" })).toEqual([])
    expect(toolSummary({ tool: "python", status: "completed", output: "1\n2\n3" })).toEqual([])
    expect(toolSummary({ tool: "task", status: "completed", output: "findings" })).toEqual([])
    expect(lineCount("")).toBe(0)
    expect(lineCount("one\ntwo\n")).toBe(2)
  })
})
