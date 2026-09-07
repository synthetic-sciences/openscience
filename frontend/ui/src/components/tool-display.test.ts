import { describe, test, expect } from "bun:test"
import {
  artifactTypeLabel,
  artifactActions,
  errorLine,
  generatedArtifacts,
  humanizeToolName,
  lineCount,
  loadedSkillName,
  pendingOperations,
  reasoningDisplayText,
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
  taskOutcome,
  taskPhase,
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
  test("distinguishes a requested load, recorded load and discovered candidates", () => {
    expect(skillActivity({ input: { name: "scientific-schematics" }, status: "running" })).toEqual({
      title: "Loading scientific-schematics",
    })
    expect(
      skillActivity({
        input: { query: "scientific figures" },
        metadata: { matches: ["scientific-schematics", "matplotlib"] },
        title: "Skill matches: scientific figures",
        status: "completed",
      }),
    ).toEqual({ title: "Found 2 relevant skills" })
    expect(
      skillActivity({
        input: { name: "exploratory-data-analysis", query: "Titanic plots", category: "visualization", offset: 0 },
        metadata: { name: "exploratory-data-analysis", matches: [] },
        title: "Loaded skill: exploratory-data-analysis",
        status: "completed",
      }),
    ).toEqual({ title: "Loaded skill: exploratory-data-analysis" })
    expect(
      skillActivity({
        input: { name: "data-visualization", query: "Titanic plots" },
        metadata: { name: "Titanic plots", dir: "", matches: ["exploratory-data-analysis", "matplotlib"] },
        title: "Skill matches: Titanic plots",
        status: "completed",
      }),
    ).toEqual({ title: "Found 2 relevant skills" })
    expect(skillActivity({ metadata: { names: ["scientific-schematics", "ml-paper-writing"] } })).toEqual({
      title: "2 skills",
      subtitle: "scientific-schematics · ml-paper-writing",
    })
  })

  test("requires a successful load result and uses its identity, never the requested name", () => {
    expect(loadedSkillName({ title: "Loaded skill: matplotlib", status: "completed" })).toBe("matplotlib")
    expect(
      loadedSkillName({ title: "Loaded skill: matplotlib", status: "completed", metadata: { name: "matplotlib" } }),
    ).toBe("matplotlib")
    for (const title of ["Skill matches: matplotlib", "Skills in category: matplotlib", "Loaded skill: ", undefined]) {
      expect(loadedSkillName({ title, status: "completed", metadata: { name: "matplotlib" } })).toBeUndefined()
    }
    for (const status of ["pending", "running", "error", undefined]) {
      expect(loadedSkillName({ title: "Loaded skill: matplotlib", status })).toBeUndefined()
    }
    expect(
      loadedSkillName({ title: "Loaded skill: matplotlib", status: "completed", metadata: { ok: false } }),
    ).toBeUndefined()
    expect(
      skillActivity({ title: "Loaded skill: matplotlib", status: "completed", input: { name: "unavailable" } }),
    ).toEqual({ title: "Loaded skill: matplotlib" })
    expect(skillActivity({ status: "completed", input: { name: "matplotlib" } })).toEqual({
      title: "Skill result",
      subtitle: "matplotlib",
    })
  })

  test("labels failed loads and empty discovery results without implying use", () => {
    expect(skillActivity({ input: { name: "matplotlib" }, status: "error" })).toEqual({
      title: "Skill load failed",
      subtitle: "matplotlib",
    })
    expect(skillActivity({ input: { query: "plots" }, status: "error" })).toEqual({ title: "Skill lookup failed" })
    expect(skillActivity({ input: { category: "plots" }, metadata: { matches: [] }, status: "completed" })).toEqual({
      title: "No matching skills found",
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

  test("prefers runtime-resolved write and edit targets over the originally requested input", () => {
    const parts = [
      completed("write", { filePath: "notes.md" }, { filepath: "/project/notes.md" }),
      completed("edit", { filePath: "/alias/plan.md" }, { filediff: { file: "/project/plan.md" } }),
    ]
    expect(writtenFiles(parts)).toEqual(["/project/notes.md", "/project/plan.md"])
    expect(writtenFiles(parts, { canonicalOnly: true })).toEqual(["/project/notes.md", "/project/plan.md"])
  })

  test("canonical-only link provenance never infers paths from inputs, reads, or shell text", () => {
    expect(
      writtenFiles(
        [
          completed("write", { filePath: "/project/legacy.md" }),
          completed("edit", { filePath: "legacy.md" }),
          completed("write", {}, { filepath: "relative.md" }),
          completed("read", { filePath: "/project/read.md" }, { filepath: "/project/read.md" }),
          completed("bash", { command: "touch /project/bash.md" }, { filepath: "/project/bash.md" }),
          completed("notebook", {}, { files: ["/project/notebook.md"] }),
          { type: "tool", tool: "write", state: { status: "error", metadata: { filepath: "/project/failed.md" } } },
          completed(
            "apply_patch",
            {},
            {
              files: [
                { filePath: "/project/old.md", movePath: "/project/new.md", type: "move" },
                { filePath: "/project/deleted.md", type: "delete" },
              ],
            },
          ),
        ],
        { canonicalOnly: true },
      ),
    ).toEqual(["/project/new.md"])
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

  test("removes structural phase headings, including concatenated phases, without shortening prose", () => {
    expect(reasoningDisplayText(titanic)).toBe(
      "The user asks for an analysis. Let's get started!\n\nI need a reputable source.\n\nI can keep the work focused.",
    )
    expect(titanic).toContain("**Choosing a reputable Titanic dataset**")
  })

  test("leaves ordinary readable reasoning unchanged", () => {
    expect(reasoningDisplayText("Checking the source, then comparing the results.")).toBe(
      "Checking the source, then comparing the results.",
    )
    expect(reasoningDisplayText("  Received text with original whitespace.\n\n")).toBe(
      "  Received text with original whitespace.\n\n",
    )
  })

  test("removes the reported dataset-location phase while preserving its complete reasoning", () => {
    const prose =
      "I need to find a suitable dataset for the user's request. It looks like there aren't any files available, but I could use an online dataset from Seaborn. Since the user wants to generate plots, I’ll need to retrieve and analyze that data, then save the outputs, maybe from scratch. I might need to enhance my skills for data visualization too. Also, I’ll download the canonical Titanic CSV from a known URL. Let's fetch that!"
    expect(reasoningDisplayText(`**Locating datasets**\n\n${prose}[REDACTED]`)).toBe(prose)
    const statement = "**Locating the sample revealed a mislabeled tube.**\nThe label needs verification."
    expect(reasoningDisplayText(statement)).toBe(statement)
  })

  test("suppresses exact status-only labels without guessing which standalone passages are labels", () => {
    expect(reasoningDisplayText("Planning")).toBe("")
    expect(reasoningDisplayText("  Considering next steps[REDACTED]\n")).toBe("")
    expect(reasoningDisplayText("Planning comprehensive research workflow")).toBe(
      "Planning comprehensive research workflow",
    )
    expect(reasoningDisplayText("Analyzing the source revealed three incompatible assay formats.")).toBe(
      "Analyzing the source revealed three incompatible assay formats.",
    )
    expect(reasoningDisplayText("Checking the source exposed conflicting values")).toBe(
      "Checking the source exposed conflicting values",
    )
  })

  test("removes structural headings when the bridge omits the blank line", () => {
    expect(reasoningDisplayText("**Inspecting assay quality**\nThe substantive analysis remains visible.")).toBe(
      "The substantive analysis remains visible.",
    )
  })

  test("normalizes the reported cost-analysis phases while retaining every cost passage", () => {
    const phases = [
      "Researching cost distribution",
      "Optimizing request handling",
      "Streamlining hardware utilization",
      "Refining task management",
      "Rethinking cost strategy for Sol",
    ]
    const passages = phases.map((_, index) => `Complete analysis passage ${index + 1}.`)
    const text = phases.map((phase, index) => `**${phase}**\n\n${passages[index]}`).join("")
    expect(reasoningDisplayText(text)).toBe(passages.join("\n\n"))
  })

  test("normalizes the comparison phase without deleting an inline scientific comparison", () => {
    expect(reasoningDisplayText("**Comparing the assay controls**\n\nThe **same evaluation conditions** apply.")).toBe(
      "The **same evaluation conditions** apply.",
    )
    const prose = "**Comparing the assays revealed a confound.**\nThe conditions differed."
    expect(reasoningDisplayText(prose)).toBe(prose)
  })

  test("preserves ordinary bold reasoning prose", () => {
    const prose =
      "Let me also make sure about **featureCounts GTF requirement**: featureCounts works best with a GFF/GTF."
    expect(reasoningDisplayText(prose)).toBe(prose)
    expect(reasoningDisplayText("This is (**important context**) for the result.")).toBe(
      "This is (**important context**) for the result.",
    )
  })

  test("removes short structural headings without depending on a vocabulary of phase verbs", () => {
    for (const heading of [
      "Locating datasets",
      "Gathering dataset for analysis",
      "Clarifying project path",
      "Dataset and plotting plan",
      "Data: source & analysis",
      "Feature counts requirement",
    ]) {
      expect(reasoningDisplayText(`**${heading}**\n\nThe complete explanation remains below it.`)).toBe(
        "The complete explanation remains below it.",
      )
    }
  })

  test("does not strip an action phrase used as inline emphasis or a complete bold statement", () => {
    const inline = "We should keep **Checking assay quality**\nvisible as part of this sentence."
    expect(reasoningDisplayText(inline)).toBe(inline)
    const statement =
      "**Checking the source exposed three incompatible values.**\nThe experiment must account for each."
    expect(reasoningDisplayText(statement)).toBe(statement)
  })

  test("preserves heading-looking text in fenced and indented code", () => {
    for (const fence of ["```", "~~~~"]) {
      const code = `${fence}md\n**Checking sources**\n\nPreserve this example.\n${fence}`
      expect(reasoningDisplayText(code)).toBe(code)
      expect(reasoningDisplayText(`${code}\n\n**Evaluating sources**\n\nThe actual analysis.`)).toBe(
        `${code}\n\nThe actual analysis.`,
      )
    }
    const indented = "    **Checking sources**\n    Preserve this example."
    expect(reasoningDisplayText(indented)).toBe(indented)
    for (const indent of ["    ", "\t"]) {
      const bridge = `${indent}done.**Gathering sources**\n${indent}Preserve this literal.`
      expect(reasoningDisplayText(bridge)).toBe(bridge)
    }
  })

  test("preserves inline code and math even across line breaks", () => {
    for (const [open, close] of [
      ["`", "`"],
      ["``", "``"],
      ["$$", "$$"],
      ["\\[", "\\]"],
      ["\\(", "\\)"],
    ]) {
      const literal = `${open}\n**Checking sources**\nPreserve this example.\n${close}`
      expect(reasoningDisplayText(literal)).toBe(literal)
    }
    const equation = "**Evaluating $W_l$**\n\nThe mathematical heading remains meaningful."
    expect(reasoningDisplayText(equation)).toBe(equation)
    const code = "``Example with a ``` run\n**Checking sources**\nPreserve this example.\n``"
    expect(reasoningDisplayText(code)).toBe(code)
    const escaped = "$\\text{cost \\$}\n**Checking sources**\nPreserve this example.\n$"
    expect(reasoningDisplayText(escaped)).toBe(escaped)
    expect(reasoningDisplayText("The cost is \\$5.\n\n**Gathering sources:**\n\nThe complete passage.")).toBe(
      "The cost is \\$5.\n\nThe complete passage.",
    )
  })

  test("preserves raw code elements and comments containing heading-looking examples", () => {
    for (const [open, close] of [
      ["<pre>", "</pre>"],
      ["<code class='md'>", "</code>"],
      ["<!--", "-->"],
    ]) {
      const literal = `${open}\n**Checking sources**\nPreserve this example.\n${close}`
      expect(reasoningDisplayText(literal)).toBe(literal)
    }
  })

  test("keeps partial headings and incomplete literals during streaming", () => {
    for (const partial of [
      "**Evaluating",
      "**Evaluating sources**",
      "**Evaluating sources**\n\n",
      "```md\n**Checking sources**\nExample.",
      "`\n**Checking sources**\nExample.",
    ]) {
      expect(reasoningDisplayText(partial)).toBe(partial)
    }
    expect(reasoningDisplayText("**Evaluating sources**\n\nFirst substantive words")).toBe("First substantive words")
  })

  test("retains prose whitespace and CRLF paragraph boundaries without normalizing code", () => {
    expect(
      reasoningDisplayText("**Checking sources**\r\n\r\n  First passage.**Revising the plan**\r\nSecond passage.\r\n"),
    ).toBe("  First passage.\r\n\r\nSecond passage.\r\n")
    const code = "```md\n\n\n**Checking sources**\n\n\nExample.\n```"
    expect(reasoningDisplayText(code)).toBe(code)
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

describe("sessionErrorDisplay", () => {
  test("presents a Stop press as stopped at the user's request, keeping completed work", () => {
    expect(
      sessionErrorDisplay({ name: "MessageAbortedError", data: { message: "The operation was aborted." } }),
    ).toEqual({
      state: "stopped",
      reason: "user",
      title: "Stopped",
      message: "Stopped at your request. Completed steps and written files are kept; nothing continues automatically.",
    })
    expect(sessionErrorDisplay({ name: "MessageAbortedError", data: { message: "" } })).toMatchObject({
      state: "stopped",
      reason: "user",
    })
  })

  test("keeps the recorded cause of a named interruption", () => {
    const message =
      "Interrupted: credentials changed (workspace-sync.expired) and every runtime that inherited the previous snapshot was stopped"
    expect(sessionErrorDisplay({ name: "MessageAbortedError", data: { message } })).toEqual({
      state: "stopped",
      reason: "interrupted",
      title: "Stopped",
      message,
    })
  })

  test("separates a wait the runtime gave up on from a provider that stopped answering", () => {
    const stopped = (code: string, message: string) => ({
      name: "APIError",
      data: { message, isRetryable: false, metadata: { code, openscience_state: "stopped", action: "resubmit" } },
    })
    expect(
      sessionErrorDisplay(stopped("provider_request_timeout", "The model request timed out waiting for new output.")),
    ).toEqual({
      state: "stopped",
      reason: "timeout",
      title: "Stopped",
      message: "The model request timed out waiting for new output.",
    })
    expect(
      sessionErrorDisplay(stopped("managed_request_timeout", "The managed response stopped making progress.")),
    ).toMatchObject({ state: "stopped", reason: "timeout" })
    expect(
      sessionErrorDisplay(
        stopped("managed_response_incomplete", "The managed response ended before confirming completion."),
      ),
    ).toEqual({
      state: "stopped",
      reason: "provider",
      title: "Stopped",
      message: "The managed response ended before confirming completion.",
    })
  })

  test("leaves ordinary failures as errors", () => {
    expect(
      sessionErrorDisplay({
        name: "APIError",
        data: { message: "Provider is overloaded", metadata: { code: "provider_overloaded" } },
      }),
    ).toEqual({ state: "error", message: "Provider is overloaded" })
  })
})

describe("pendingOperations", () => {
  const part = (id: string, tool: string, state: Record<string, unknown>) => ({ id, type: "tool", tool, state })

  test("lists live and cancelled calls with whether each had started", () => {
    expect(
      pendingOperations([
        part("prt_done", "write", { status: "completed", input: { filePath: "a.md" }, metadata: {} }),
        part("prt_running", "bash", { status: "running", title: "Inspect results", input: { command: "ls" } }),
        part("prt_pending", "read", { status: "pending", input: {} }),
        part("prt_cancelled", "bash", {
          status: "error",
          error: "Tool execution aborted",
          input: { command: "make", description: "Build the report" },
          metadata: { cancelled: true, started: true },
        }),
        part("prt_never", "glob", {
          status: "error",
          error: "Tool execution aborted. The glob call had not started; no action was taken.",
          input: {},
          metadata: { cancelled: true, started: false },
        }),
        part("prt_failed", "bash", { status: "error", error: "Command failed", input: {} }),
        { id: "prt_text", type: "text" },
      ]),
    ).toEqual([
      { id: "prt_running", tool: "bash", title: "Inspect results", started: true },
      { id: "prt_pending", tool: "read", title: "Read", started: false },
      { id: "prt_cancelled", tool: "bash", title: "Build the report", started: true },
      { id: "prt_never", tool: "glob", title: "Glob", started: false },
    ])
  })
})

describe("taskPhase", () => {
  test("derives the delegation phase from the part state and the recorded child binding", () => {
    expect(taskPhase({ status: "pending" })).toBe("preparing")
    expect(taskPhase({ status: "running", metadata: {} })).toBe("preparing")
    expect(taskPhase({ status: "running", metadata: { sessionId: "ses_child", queuedMs: 0 } })).toBe("queued")
    expect(taskPhase({ status: "running", metadata: { sessionId: "ses_child", queuedMs: 12, activeMs: 0 } })).toBe(
      "running",
    )
    expect(
      taskPhase({ status: "error", error: "Task continuation session ses_x is not a direct child", metadata: {} }),
    ).toBe("failed_to_start")
    expect(taskPhase({ status: "error", error: "Worker crashed", metadata: { sessionId: "ses_child" } })).toBe("failed")
    expect(
      taskPhase({
        status: "error",
        error: "Tool execution aborted",
        metadata: { cancelled: true, sessionId: "ses_child" },
      }),
    ).toBe("cancelled")
    expect(taskPhase({ status: "completed", metadata: { sessionId: "ses_child", outcome: "completed" } })).toBe(
      "completed",
    )
    expect(taskPhase({ status: "completed", metadata: { sessionId: "ses_child", outcome: "partial" } })).toBe("partial")
    expect(taskPhase({ status: "completed", metadata: { sessionId: "ses_child", outcome: "timed_out" } })).toBe(
      "timed_out",
    )
    expect(taskPhase({ status: "completed", metadata: { sessionId: "ses_child", outcome: "error" } })).toBe("failed")
  })

  test("maps phases onto the card's outcome vocabulary", () => {
    expect(taskOutcome("preparing")).toBe("pending")
    expect(taskOutcome("queued")).toBe("pending")
    expect(taskOutcome("running")).toBe("running")
    expect(taskOutcome("failed_to_start")).toBe("error")
    expect(taskOutcome("failed")).toBe("error")
    expect(taskOutcome("partial")).toBe("partial")
    expect(taskOutcome("timed_out")).toBe("timed_out")
    expect(taskOutcome("cancelled")).toBe("cancelled")
    expect(taskOutcome("completed")).toBe("completed")
  })
})

describe("writtenFiles from recorded patches", () => {
  const patch = (files: unknown[]) => ({ type: "patch", files })

  test("adds the files a step's filesystem diff recorded, deduplicated against tool receipts", () => {
    expect(
      writtenFiles([
        {
          type: "tool",
          tool: "write",
          state: { status: "completed", input: { filePath: "notes.md" }, metadata: { filepath: "/project/notes.md" } },
        },
        {
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: { command: "python make_report.py" }, metadata: { exit: 0 } },
        },
        patch(["/project/notes.md", "/project/results.csv", "/project/results.csv", "relative.csv", 42]),
      ]),
    ).toEqual(["/project/notes.md", "/project/results.csv"])
  })

  test("runs recorded paths through the caller's resolver and drops what it rejects", () => {
    const resolve = (path: string) => (path.startsWith("/project/") || path.startsWith("/scratch/") ? path : undefined)
    expect(writtenFiles([patch(["/project/out.png", "/scratch/out.png", "/elsewhere/out.png"])], { resolve })).toEqual([
      "/project/out.png",
      "/scratch/out.png",
    ])
    expect(writtenFiles([patch(["/project/out.png"])], { canonicalOnly: true, resolve })).toEqual(["/project/out.png"])
  })

  test("never widens canonical-only link provenance beyond absolute recorded paths", () => {
    expect(writtenFiles([patch(["figure.png"])], { canonicalOnly: true })).toEqual([])
    expect(writtenFiles([patch(["figure.png"])])).toEqual([])
  })
})

describe("loadedSkillName from recorded metadata", () => {
  test("accepts a load by its recorded directory or hash and keeps the title as the fallback", () => {
    expect(
      loadedSkillName({
        status: "completed",
        title: "Skill: matplotlib",
        metadata: { name: "matplotlib", dir: "/skills/matplotlib", contentHash: "a".repeat(64) },
      }),
    ).toBe("matplotlib")
    expect(
      loadedSkillName({
        status: "completed",
        title: "Loaded skill: renamed",
        metadata: { name: "recorded", dir: "/skills/recorded" },
      }),
    ).toBe("recorded")
    expect(
      loadedSkillName({
        status: "completed",
        title: "Skill matches: seaborn",
        metadata: { name: "seaborn", dir: "", matches: ["seaborn"] },
      }),
    ).toBeUndefined()
    expect(
      loadedSkillName({
        status: "completed",
        title: "Skill: denied",
        metadata: { name: "denied", dir: "/skills/denied", ok: false },
      }),
    ).toBeUndefined()
  })
})
