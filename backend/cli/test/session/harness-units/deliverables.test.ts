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
    // Files the request tells the model to consult are inputs, not debts: a
    // worker brief that opens with its reading list names no deliverable.
    expect(
      Deliverables.detect(
        "Implement the control branch. Read CONTRACTS.md and study.json first. Own ONLY creative_rl/control.py and tests/test_control.py.",
      ),
    ).toEqual([])
    expect(Deliverables.detect("Read config.yaml, then write results/summary.json and results/plot.png.")).toEqual([
      "results/summary.json",
      "results/plot.png",
    ])
  })

  test("an abbreviated path is a place the writer elided, not a file to check", () => {
    expect(
      Deliverables.detect(
        "Write .../final_inputs/test_labels.csv and …/sealed/test_labels.csv with columns customerID,Churn, plus results/summary.csv.",
      ),
    ).toEqual(["results/summary.csv"])
  })

  test("preserves absolute Windows, UNC and POSIX paths without treating URLs as files", () => {
    expect(
      Deliverables.detect(
        'Write the table to "C:\\Research Outputs\\fit.csv", save the report as \\\\server\\shared results\\reports\\fit.md, ' +
          "and export the plot to /tmp/results/fit.png. See https://example.org/reference.csv.",
      ),
    ).toEqual([
      "C:\\Research Outputs\\fit.csv",
      "\\\\server\\shared results\\reports\\fit.md",
      "/tmp/results/fit.png",
    ])
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
    expect(results["dupes.csv"]).toEqual(["duplicate values in the sample_id column"])
    expect(results["good.csv"]).toEqual([])
    expect(results["good.json"]).toEqual([])
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
})
