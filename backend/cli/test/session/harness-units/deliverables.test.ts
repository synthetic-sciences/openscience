import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "path"
import type { PluginInput } from "@synsci/plugin"
import { Deliverables, DeliverablesUnit } from "../../../src/harness/deliverables"
import { HarnessState } from "../../../src/harness/state"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import { SessionFilesystem } from "../../../src/session/filesystem"
import { SessionLoopState } from "../../../src/session/loop-state"
import { Identifier } from "../../../src/id/id"
import { tmpdir } from "../../fixture/fixture"

afterEach(() => HarnessState.reset())

describe("Deliverables.headers", () => {
  test("a header the request states for a CSV, fenced or inline, alone or above example rows", () => {
    const text = [
      "Write all results to `/root/results/`:",
      "",
      "1. `/root/results/well_summary.csv`",
      "",
      "   one row per well, with this exact header:",
      "",
      "   ```",
      "   well,n_cells_nuclei,n_cilia,ciliation_rate_pct",
      "   ```",
      "",
      "2. Save the classifications to `/results/predictions.csv` with columns `lake_id,label`, one row per lake.",
      "",
      "3. Save the results to `/root/results/output.csv` with the following format:",
      "```csv",
      "target_name,classification,Main physical period (day)",
      "target_1,class_str,float",
      "...",
      "```",
      "4. Write the fitted parameters to `/root/results/params.json`.",
    ].join("\n")
    const outputs = [
      "/root/results/well_summary.csv",
      "/results/predictions.csv",
      "/root/results/output.csv",
      "/root/results/params.json",
    ]
    expect(Deliverables.headers(text, outputs)).toEqual({
      "/root/results/well_summary.csv": "well,n_cells_nuclei,n_cilia,ciliation_rate_pct",
      "/results/predictions.csv": "lake_id,label",
      "/root/results/output.csv": "target_name,classification,Main physical period (day)",
    })
    expect(Deliverables.columns("a\tb\tc")).toEqual(["a", "b", "c"])
  })

  test("a file whose header differs from the stated one is not ready; an exact header is", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "summary.csv"), "well,n_cells,n_cilia,ciliation_rate_pct\nw1,10,4,40.0\n")
    const bad = await Deliverables.check(tmp.path, "summary.csv", "well,n_cells_nuclei,n_cilia,ciliation_rate_pct")
    expect(bad.problems).toEqual([
      'header is "well,n_cells,n_cilia,ciliation_rate_pct" but the request states "well,n_cells_nuclei,n_cilia,ciliation_rate_pct"',
    ])
    await fs.writeFile(
      path.join(tmp.path, "good.csv"),
      "well,n_cells_nuclei,n_cilia,ciliation_rate_pct\nw1,10,4,40.0\n",
    )
    expect(
      (await Deliverables.check(tmp.path, "good.csv", "well,n_cells_nuclei,n_cilia,ciliation_rate_pct")).problems,
    ).toEqual([])
    // Without a stated header the first line is not judged.
    expect((await Deliverables.check(tmp.path, "summary.csv")).problems).toEqual([])
  })
})

describe("Deliverables.detect", () => {
  test("names the output files of a specification and ignores prose without one", () => {
    const spec =
      "Fit the model and write results/fit_summary.csv (columns: id, slope, intercept, rounded to 4 decimals) " +
      "and results/report.md. Save the figure as figures/fit.png. Use train.py as the entry point."
    expect(Deliverables.detect(spec)).toEqual(["results/fit_summary.csv", "results/report.md", "figures/fit.png"])
    expect(Deliverables.detect("Explain what a p-value is.")).toEqual([])
    expect(Deliverables.detect("Have a look at notes.md and tell me what you think.")).toEqual([])
    expect(Deliverables.detect("See https://example.org/data.csv for context")).toEqual([])
    // A waived output is the user's call, not a missing deliverable.
    expect(
      Deliverables.detect(
        "Create results/table.csv with columns id,value and results/notes.md. Skip results/notes.md for now, I will write it later.",
      ),
    ).toEqual(["results/table.csv"])
    expect(Deliverables.detect("Write results/out.csv (columns a,b); do not touch results/raw.csv.")).toEqual([
      "results/out.csv",
    ])
    // Files the request tells the model to consult are inputs, not debts; the
    // code it owns is a deliverable, because a program is checked like any
    // other output.
    expect(
      Deliverables.detect(
        "Implement the control branch. Read CONTRACTS.md and study.json first. Own ONLY creative_rl/control.py and tests/test_control.py.",
      ),
    ).toEqual(["creative_rl/control.py", "tests/test_control.py"])
    // Absolute paths are how a task states its outputs, and a negation after
    // the path describes the output rather than waiving it.
    expect(
      Deliverables.detect("Write `/app/solution/output.json` keyed by the file stem, without the `.cif` extension."),
    ).toEqual(["/app/solution/output.json"])
    expect(
      Deliverables.detect("Save the fitted model to /root/results/model.pt and the report to /root/results/report.md."),
    ).toEqual(["/root/results/model.pt", "/root/results/report.md"])
    // A path used only as an example in usage text is not a deliverable.
    expect(Deliverables.detect("Run `solve --out /path/to/result.npz`; write /app/result.npz when done.")).toEqual([
      "/app/result.npz",
    ])
    // The entry point a task says to edit is owed even though the verb follows it.
    expect(
      Deliverables.detect(
        "Your workspace contains /app/training_data.npz and /app/regressor.py, which is the file you must edit.",
      ),
    ).toEqual(["/app/regressor.py"])
    expect(Deliverables.detect("Read config.yaml, then write results/summary.json and results/plot.png.")).toEqual([
      "results/summary.json",
      "results/plot.png",
    ])
  })

  test("a sectioned specification owes the files listed under its outputs, not the inputs they mention", () => {
    // Many-artifact tasks list outputs as verbless bullets under a heading;
    // an input named in a bullet's description is a mention, not a debt.
    const headed = [
      "## Inputs",
      "- `data/raw/sample_sheet.csv`: one row per library",
      "",
      "## Required Outputs",
      "- Path: `outputs/gene_counts.csv`",
      "  Format: csv",
      "  Description: normalized counts computed from data/raw/sample_sheet.csv",
      "- Path: `outputs/de_results.csv`",
      "  Required columns: log2FoldChange, pvalue, padj",
      "",
      "## Notes file",
      "Write `./outputs/notes.md` with one section per artifact.",
    ].join("\n")
    expect(Deliverables.detect(headed)).toEqual([
      "outputs/gene_counts.csv",
      "outputs/de_results.csv",
      "./outputs/notes.md",
    ])
    // A lead-in's list survives the explanation and code between its items.
    const led = [
      "Write exactly two files under `/app/results/`:",
      "",
      "- `/app/results/mechanisms.json` is a JSON object mapping each material to its labels:",
      "",
      "```json",
      '{ "material_01": { "mullins": false } }',
      "```",
      "",
      "Include all 18 materials, each with all three keys.",
      "",
      "- `/app/results/predictions.csv`: one row for every row of every material's `holdout_inputs.csv`.",
    ].join("\n")
    expect(Deliverables.detect(led)).toEqual(["/app/results/mechanisms.json", "/app/results/predictions.csv"])
    // "The contracts are:" governs the list below it, and the produce verb
    // earlier in the line owes only what it names.
    expect(
      Deliverables.detect(
        "Produce `/root/results/trajectory.json`. The authoritative public contracts are:\n- `/root/data/trajectory_schema.json`\n- `/root/data/evaluation_spec.json`",
      ),
    ).toEqual(["/root/results/trajectory.json"])
    // A sentence that names the directory a list goes to opens the list and
    // places its bare items there: checked at the workspace root they were
    // "missing", and one lead duplicated its finished files there to satisfy
    // the checklist. With or without the trailing slash, with a colon or a
    // full stop.
    expect(
      Deliverables.detect(
        "Save final results to `/root/results/`.\n\n1. `posterior_samples.csv`: CSV with columns id, value\n2. `summary.json`: JSON with the fit\n\nThe flattening follows `vectors.npz`.",
      ),
    ).toEqual(["/root/results/posterior_samples.csv", "/root/results/summary.json"])
    expect(
      Deliverables.detect(
        "Create `/root/results` with these required artifacts:\n\n- `report.json`: the parameter map;\n- `predictions.h5`: the density arrays.",
      ),
    ).toEqual(["/root/results/report.json", "/root/results/predictions.h5"])
    // A range of numbered names is every name in it, in the template's
    // directory; the template itself (`spins_k.txt`) is not a file.
    expect(
      Deliverables.detect(
        "For instance `k`, write your best configuration to `/root/artifacts/spins_k.txt` — that is, `spins_0.txt` through `spins_3.txt` — as N tokens.",
      ),
    ).toEqual([
      "/root/artifacts/spins_0.txt",
      "/root/artifacts/spins_1.txt",
      "/root/artifacts/spins_2.txt",
      "/root/artifacts/spins_3.txt",
    ])
    // Files a program writes to a placeholder directory when the grader runs
    // it are its contract, not this turn's outputs; the full path the turn
    // does owe stands.
    expect(
      Deliverables.detect(
        "Write your solver to `/root/results/solver.py`.\n\nFor each session it must write `calibration.json`, `outliers.csv`, and\n`trajectory.csv` to `OUTPUT_DIR`, exactly following\n`/root/data/output_schema.json`.",
      ),
    ).toEqual(["/root/results/solver.py"])
    // The directory before a colon hands itself to the names that follow.
    expect(
      Deliverables.detect(
        "Write two artifacts to `/root/results/`: `corrected_matrix.mtx`, a genes by cells matrix, and `barcodes.tsv`.",
      ),
    ).toEqual(["/root/results/corrected_matrix.mtx", "/root/results/barcodes.tsv"])
    // A list of inputs that "provide more information" is not owed.
    expect(
      Deliverables.detect(
        "Write `/app/final_model.js`. The following files provide more information about the enzyme:\n- `/app/data/reference.fasta` — the wild type\n- `/app/data/structure.pdb` — PDB 1UA7",
      ),
    ).toEqual(["/app/final_model.js"])
  })

  test("submitting, repairing and saving owe a file; instruments, references and bare repeats do not", () => {
    expect(
      Deliverables.detect(
        "Repair `/app/remap/remapper.py` to compute the operator. Submit it as `/root/results/submission/remapper.py`.",
      ),
    ).toEqual(["/app/remap/remapper.py", "/root/results/submission/remapper.py"])
    expect(
      Deliverables.detect("Provide the answer as a CSV file saved at `/results/output.csv` with two columns."),
    ).toEqual(["/results/output.csv"])
    expect(
      Deliverables.detect(
        "Write `/app/result.npz`. Your submitted offsets are checked to the tolerance published in `spec.json`. Submit the model with `/app/assay_client.py`.",
      ),
    ).toEqual(["/app/result.npz"])
    expect(
      Deliverables.detect(
        "Write `/app/submission/predict.py` (columns: id, score); `predict.py` must be self-contained.",
      ),
    ).toEqual(["/app/submission/predict.py"])
  })

  test("a bare name takes the directory named beside it, and 'the data are in X' is an input", () => {
    expect(
      Deliverables.detect(
        "The measurements are in `/app/data/props.csv`. Provide your answers as a CSV file named `answers.csv` and save it inside `/results/`. It must contain a single column with the header `Answers`.",
      ),
    ).toEqual(["/results/answers.csv"])
    expect(
      Deliverables.detect("Write the table to `summary.csv` under `out/tables/`; read the counts from `counts.tsv`."),
    ).toEqual(["out/tables/summary.csv"])
  })

  test("a report specification: files named in sub-headings of the outputs section, inputs under a data heading, examples inside nested fences", () => {
    // The shape of a rubric-graded analysis task: a data manifest whose
    // description happens to say "report", outputs declared by sub-headings,
    // and an example excerpt in a ````md fence that nests a ```python block.
    const spec = [
      "## Question",
      "Which proteins change?",
      "",
      "## Data Files",
      "",
      "Plasma proteomics study (Nature Medicine 2025); self-reported covariates. The cohort covers two regimens.",
      "",
      "- `Olink_npx.csv`: NPX table in long format. Columns: `SampleID`, `Assay`, `NPX`.",
      "- `metadata_SDRF.tsv`: Sample metadata (103 rows). Columns: `source name`, `age`.",
      "",
      "## Required Outputs",
      "",
      "You MUST create the following two output files:",
      "",
      "### 1. Analysis Trace (`/app/trace.md`)",
      "",
      "Document your complete analysis process in markdown format, following this structure.",
      "",
      "**Example excerpt** (showing expected level of detail):",
      "",
      "````md",
      "## Data Sources",
      "- `samples.csv`: 1,850 samples x 10 columns. Key columns: SampleID, Site.",
      "",
      "```python",
      "df = pd.read_csv('samples.csv')",
      "```",
      "**Quantitative result**: 1,850 samples across 12 sites.",
      "````",
      "",
      "**Key principles:**",
      "- Show intermediate result counts at every filtering step",
      "",
      "### 2. Final Answer (`/app/answer.txt`)",
      "",
      "Write your final answer to the question above in plain text format.",
    ].join("\n")
    expect(Deliverables.detect(spec)).toEqual(["/app/trace.md", "/app/answer.txt"])
  })

  test("an abbreviated path is a place the writer elided, not a file to check", () => {
    expect(
      Deliverables.detect(
        "Write .../final_inputs/test_labels.csv and …/sealed/test_labels.csv with columns customerID,Churn, plus results/summary.csv.",
      ),
    ).toEqual(["results/summary.csv"])
  })

  test("a spelled-out Windows or UNC output is not reduced to its file name", () => {
    expect(
      Deliverables.detect(
        'Write the table to "C:\\Research\\fit.csv", save the report as \\\\server\\share\\reports\\fit.md, ' +
          "export the plot to /tmp/results/fit.png, and write results/summary.csv with columns id,score.",
      ),
      // The POSIX absolute path is owed as written (checked for presence when
      // it lies outside the roots); the Windows and UNC ones are not cut down.
    ).toEqual(["/tmp/results/fit.png", "results/summary.csv"])
  })
})

describe("Deliverables.check", () => {
  test("flags missing, empty, malformed, placeholder, NaN and duplicate-id outputs", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "empty.csv"), "")
    await Bun.write(path.join(tmp.path, "bad.json"), "{ not json")
    await Bun.write(path.join(tmp.path, "todo.md"), "# Report\n\nTODO: fill in the numbers")
    await Bun.write(path.join(tmp.path, "nan.csv"), "id,score\n1,0.5\n2,nan\n")
    await Bun.write(path.join(tmp.path, "dupes.csv"), "sample_id,value\ns1,1\ns1,2\n")
    await Bun.write(path.join(tmp.path, "good.csv"), "id,score\n1,0.5\n2,0.7\n")
    await Bun.write(path.join(tmp.path, "good.json"), JSON.stringify({ slope: 2.99 }))
    const results = Object.fromEntries(
      await Promise.all(
        ["missing.csv", "empty.csv", "bad.json", "todo.md", "nan.csv", "dupes.csv", "good.csv", "good.json"].map(
          async (name) => [name, (await Deliverables.check(tmp.path, name)).problems] as const,
        ),
      ),
    )
    expect(results["missing.csv"]).toEqual(["does not exist"])
    expect(results["empty.csv"]).toEqual(["is empty"])
    expect(results["bad.json"][0]).toContain("does not parse as JSON")
    expect(results["todo.md"][0]).toContain("placeholder")
    expect(results["nan.csv"]).toEqual(["contains NaN or Inf values"])
    // A repeated id is a long table, not a defect; the verifier owns row keys.
    expect(results["dupes.csv"]).toEqual([])
    expect(results["good.csv"]).toEqual([])
    expect(results["good.json"]).toEqual([])
  })

  test("the env line names what will be checked, and truncates a long list", () => {
    expect(Deliverables.envLine([])).toEqual([])
    const [one] = Deliverables.envLine(["/app/rules.json", "/app/ordering.txt"])
    expect(one).toContain("/app/rules.json, /app/ordering.txt")
    expect(one).toContain("before this turn ends")
    const many = Array.from({ length: 11 }, (_, index) => `/app/out${index}.csv`)
    const [capped] = Deliverables.envLine(many)
    expect(capped).toContain("(+3 more)")
    expect(capped).not.toContain("/app/out8.csv")
  })

  test("a symlink to a valid file is not a deliverable", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "real.csv"), "id,score\n1,0.5\n")
    await fs.symlink(path.join(tmp.path, "real.csv"), path.join(tmp.path, "link.csv"))
    await fs.mkdir(path.join(tmp.path, "dir.csv"))
    expect((await Deliverables.check(tmp.path, "link.csv")).problems).toEqual(["is a symlink, not a regular file"])
    expect((await Deliverables.check(tmp.path, "dir.csv")).problems).toEqual(["is not a regular file"])
    expect((await Deliverables.check(tmp.path, "real.csv")).problems).toEqual([])
  })

  test("rejects traversal and symlink escapes before reading them", async () => {
    await using outside = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "secret.csv"), "id,value\nexternal,1\n")
      },
    })
    await using tmp = await tmpdir()
    await fs.symlink(outside.path, path.join(tmp.path, "escape"), process.platform === "win32" ? "junction" : "dir")

    const traversal = path.relative(tmp.path, path.join(outside.path, "secret.csv"))
    expect((await Deliverables.check(tmp.path, traversal)).problems).toEqual(["is outside allowed output roots"])
    expect((await Deliverables.check(tmp.path, path.join("escape", "secret.csv"))).problems).toEqual([
      "is outside allowed output roots",
    ])
    expect((await Deliverables.check(tmp.path, path.join(outside.path, "secret.csv"))).problems).toEqual([
      "is outside allowed output roots",
    ])

    const valid = path.join(tmp.path, "results", "valid.csv")
    await Bun.write(valid, "id,value\ninside,1\n")
    expect((await Deliverables.check(tmp.path, path.join("results", "valid.csv"))).problems).toEqual([])
    expect((await Deliverables.check(tmp.path, valid)).problems).toEqual([])
  })

  test("an absolute output outside every root is checked for presence and never read", async () => {
    await using outside = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "answers.json"), "{ not json")
        await Bun.write(path.join(directory, "empty.csv"), "")
      },
    })
    await using tmp = await tmpdir()
    const named = (file: string) => Deliverables.checkIn([tmp.path], path.join(outside.path, file))
    expect((await named("answers.json")).problems).toEqual([])
    expect((await named("empty.csv")).problems).toEqual(["is empty"])
    expect((await named("missing.csv")).problems).toEqual(["does not exist"])
    // A relative name that climbs out stays refused.
    const traversal = path.relative(tmp.path, path.join(outside.path, "answers.json"))
    expect((await Deliverables.checkIn([tmp.path], traversal)).problems).toEqual(["is outside allowed output roots"])
  })
})

describe("DeliverablesUnit", () => {
  test("restart state does not re-anchor deliverables after a prior real prompt", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ workspace: "project" })
        const id = Identifier.ascending("message")
        await Session.updateMessage({
          id,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "research",
          model: { providerID: "test", modelID: "test" },
          effort: "normal",
          context: 128_000,
          internal: SessionLoopState.prompt(id),
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: id,
          sessionID: session.id,
          type: "text",
          text: "Write results/original.csv with columns id,score.",
        })

        HarnessState.clear(session.id)
        const unit = await DeliverablesUnit({} as PluginInput)
        await unit["chat.message"]!(
          { sessionID: session.id, messageID: "msg_external" },
          {
            message: {
              id: "msg_external",
              sessionID: session.id,
              role: "user",
              internal: SessionLoopState.prompt("msg_external"),
            } as never,
            parts: [{ type: "text", text: "Write results/second.csv with columns id,score." } as never],
          },
        )
        expect(HarnessState.get(session.id).deliverables).toEqual([])
      },
    })
  })

  test("a worker's brief never becomes a checklist: the lead checks what it asked for itself", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lead = await Session.create({ workspace: "project" })
        const worker = await Session.create({ parentID: lead.id, workspace: "project" })
        const unit = await DeliverablesUnit({} as PluginInput)
        await unit["chat.message"]!(
          { sessionID: worker.id, messageID: "msg_brief" },
          {
            message: { id: "msg_brief", sessionID: worker.id, role: "user" } as never,
            parts: [
              { type: "text", text: "Write results/alpha.csv with columns id,score and results/beta.md." } as never,
            ],
          },
        )
        expect(HarnessState.get(worker.id).deliverables).toEqual([])
        const output = { message: undefined as string | undefined }
        await unit["loop.before_finish"]!(
          { sessionID: worker.id, messageID: "msg_a", turn: "msg_brief", injections: 0 },
          output,
        )
        expect(output.message).toBeUndefined()
      },
    })
  })

  test("an isolated session's deliverable counts wherever the environment said files may go: scratch or the project", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const unit = await DeliverablesUnit({} as PluginInput)
        await unit["chat.message"]!(
          { sessionID: session.id, messageID: "msg_root" },
          {
            message: { id: "msg_root", sessionID: session.id, role: "user" } as never,
            parts: [{ type: "text", text: "Save the table as results/churn.csv with columns bucket,rate." } as never],
          },
        )
        const finish = async () => {
          const output = { message: undefined as string | undefined }
          await unit["loop.before_finish"]!(
            { sessionID: session.id, messageID: "msg_a", turn: "msg_1", injections: 0 },
            output,
          )
          return output.message
        }
        // The tool directory of an isolated session is its scratch; the agent
        // wrote the durable output into the project's files instead, as the
        // environment invites it to.
        const scratch = await SessionFilesystem.toolDirectory(session.id)
        expect(scratch).not.toBe(tmp.path)
        expect(await finish()).toContain("results/churn.csv: does not exist")
        HarnessState.get(session.id).deliverableRounds = 0
        await Bun.write(path.join(tmp.path, "results/churn.csv"), "bucket,rate\n0-12,0.42\n")
        expect(await finish()).toBeUndefined()
        expect(HarnessState.get(session.id).deliverablesFailing).toBe(false)
        // A file present in one place but empty there reports that, not "does not exist".
        HarnessState.get(session.id).deliverables = ["results/other.csv"]
        await Bun.write(path.join(scratch, "results/other.csv"), "")
        expect(await finish()).toContain("results/other.csv: is empty")
      },
    })
  })

  test("a specification on the first message yields one failure message at finish, at most twice", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ workspace: "project" })
        const unit = await DeliverablesUnit({} as PluginInput)
        const message = { id: "msg_root", sessionID: session.id, role: "user" }
        await unit["chat.message"]!(
          { sessionID: session.id, messageID: "msg_root" },
          {
            message: message as never,
            parts: [
              {
                type: "text",
                text: "Write results/alpha.csv with columns id,score and results/beta.md summarizing the fit.",
              } as never,
            ],
          },
        )
        expect(HarnessState.get(session.id).deliverables).toEqual(["results/alpha.csv", "results/beta.md"])

        const finish = async () => {
          const output = { message: undefined as string | undefined }
          await unit["loop.before_finish"]!(
            { sessionID: session.id, messageID: "msg_a", turn: "msg_1", injections: 0 },
            output,
          )
          return output.message
        }
        const first = await finish()
        expect(first).toContain("results/alpha.csv: does not exist")
        expect(first).toContain("results/beta.md: does not exist")
        // One file lands; the second round names only the other.
        const root = await SessionFilesystem.toolDirectory(session.id)
        await Bun.write(path.join(root, "results/alpha.csv"), "id,score\n1,0.9\n")
        const second = await finish()
        expect(second).not.toContain("alpha.csv")
        expect(second).toContain("results/beta.md")
        // Two rounds is the limit; the model's answer then stands.
        expect(await finish()).toBeUndefined()
        expect(HarnessState.get(session.id).deliverablesFailing).toBe(true)
        // With every file present there is nothing to inject.
        await Bun.write(path.join(root, "results/beta.md"), "# Fit\n\nslope 2.99, intercept 2.01")
        HarnessState.get(session.id).deliverableRounds = 0
        expect(await finish()).toBeUndefined()
        expect(HarnessState.get(session.id).deliverablesFailing).toBe(false)
      },
    })
  })

  test("a worker's report waking the lead never becomes the checklist, even when the first request named no files", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ workspace: "project" })
        const unit = await DeliverablesUnit({} as PluginInput)
        // Real prompts all carry an `internal` marker for restart replay; the
        // anchor must not mistake that for "internal" harness traffic.
        const first = await Session.updateMessage({
          id: "msg_first",
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "research",
          model: { providerID: "test", modelID: "test" },
          internal: { type: "prompt", epoch: "msg_first" },
        } as never)
        await Session.updatePart({
          id: "prt_first",
          sessionID: session.id,
          messageID: first.id,
          type: "text",
          text: "Make the schematics in the report cleaner and balance the pages.",
        } as never)
        await unit["chat.message"]!(
          { sessionID: session.id, messageID: first.id },
          {
            message: first as never,
            parts: [
              { type: "text", text: "Make the schematics in the report cleaner and balance the pages." } as never,
            ],
          },
        )
        expect(HarnessState.get(session.id).deliverables).toEqual([])

        // A background worker finishes: its report reaches the lead as a
        // synthetic user prompt full of the paths it audited.
        const report =
          '<task state="completed">The lead should write P2/base_predictions/catboost.csv and ' +
          "P2/base_predictions/logistic.csv, then save development.csv with columns customerID,Churn " +
          "and outputs/baseline/oof_predictions.csv.</task>"
        await unit["chat.message"]!(
          { sessionID: session.id, messageID: "msg_wake" },
          {
            message: {
              id: "msg_wake",
              sessionID: session.id,
              role: "user",
              internal: { type: "prompt", epoch: "msg_wake" },
            } as never,
            parts: [{ type: "text", synthetic: true, text: report } as never],
          },
        )
        expect(HarnessState.get(session.id).deliverables).toEqual([])

        // A later real request still does not redefine the checklist.
        await unit["chat.message"]!(
          { sessionID: session.id, messageID: "msg_later" },
          {
            message: {
              id: "msg_later",
              sessionID: session.id,
              role: "user",
              internal: { type: "prompt", epoch: "msg_later" },
            } as never,
            parts: [{ type: "text", text: "Now write results/final.csv with columns id,score." } as never],
          },
        )
        expect(HarnessState.get(session.id).deliverables).toEqual([])
        const output = { message: undefined as string | undefined }
        await unit["loop.before_finish"]!(
          { sessionID: session.id, messageID: "msg_a", turn: "msg_wake", injections: 0 },
          output,
        )
        expect(output.message).toBeUndefined()
      },
    })
  })
})
