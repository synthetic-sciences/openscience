import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import type { PluginInput } from "@synsci/plugin"
import { Deliverables, DeliverablesUnit } from "../../../src/harness/deliverables"
import { HarnessState } from "../../../src/harness/state"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import { SessionFilesystem } from "../../../src/session/filesystem"
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
})

describe("DeliverablesUnit", () => {
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
